import {
  CreateToolApprovalPolicyRequest,
  DeleteToolApprovalPolicyQuery,
  Id,
  IdParams,
  TOOL_APPROVAL_LIMITS,
  ToolApprovalAccess,
  ToolApprovalHistory,
  ToolApprovalHistoryQuery,
  ToolApprovalMode,
  ToolApprovalPolicy,
  ToolApprovalPolicyPage,
  ToolApprovalScopeQuery,
  ToolApproverKind,
  UpdateToolApprovalPolicyRequest,
} from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type App, authOf, type Core, tenant } from "../../core";
import { badRequest, conflict, HttpError, notFound } from "../../lib/errors";
import { orgResource, type PermissionService, unitResource } from "../organization";
import {
  allUnits,
  approvableCatalog,
  approverLabels,
  deletePolicy,
  findPolicy,
  findUnit,
  guarded,
  insertPolicy,
  type LoadCatalog,
  loadToolApprovalPolicies,
  ORGANIZATION_LABEL,
  type PolicyInput,
  patternError,
  policyHistory,
  type StoredPolicy,
  toPolicyDtos,
  updatePolicy,
  weakerThanInherited,
} from "./policies";

const tags = ["tool-approval"];
const MANAGE = "tool_approval.manage" as const;
const ACCESS_UNITS_MAX = 500;

type Unit = { id: string; name: string; path: string[] };

/**
 * The create body as the route accepts it: the contract's fields with any pattern string, so a pattern no rule may
 * name is answered after the scope is authorized, with its own code (`tool_not_approvable` / `invalid_tool_pattern`).
 * The full contract (`CreateToolApprovalPolicyRequest`) is applied in the handler.
 */
const CreateBody = z.strictObject({
  scopeUnitId: Id.nullable(),
  toolPattern: z.string().min(1).max(200),
  mode: ToolApprovalMode,
  approverKind: ToolApproverKind,
  approverUserIds: z.array(Id).max(TOOL_APPROVAL_LIMITS.approverUsersMax).optional(),
});

/** 400 `validation_error` with the contract's issues, as the error handler answers a schema failure. */
function validationError(issues: readonly unknown[]): HttpError {
  return new HttpError(400, "validation_error", "Request validation failed", issues);
}

/**
 * Settings › Approval policies (Phase 07.5, D-01, P-03, P-04, UI-SPEC Surface 4, R4, R5). Every route is
 * `authz: user`; who may manage a scope is the resolver's `tool_approval.manage` decided on that scope (the
 * organization, or the unit as a resource, so leads get it on the subtree they lead through LEAD_PERMISSIONS). Ids
 * resolve inside the caller's tenant transaction: another organization's unit or rule is simply not found. Every write
 * and its audit row share one short transaction.
 */
export function registerToolApprovalRoutes(
  app: App,
  core: Core,
  perms: PermissionService,
  deps: { loadCatalog: LoadCatalog },
) {
  const user = { config: { authz: "user" as const }, preHandler: [core.identity.requireUser] };

  /** The scope's unit (null = organization) after `tool_approval.manage` is decided on it. */
  async function manageScope(req: FastifyRequest, tx: Tx, unitId: string | null): Promise<Unit | null> {
    if (unitId === null) {
      await perms.assertCan(req, tx, MANAGE, orgResource());
      return null;
    }
    const unit = await findUnit(tx, unitId);
    if (!unit) {
      // Decided (so the answer is never an undecided route), then not found: the id is not this organization's.
      await perms.can(req, tx, MANAGE, orgResource());
      throw notFound("Unit not found", "unit_not_found");
    }
    await perms.assertCan(req, tx, MANAGE, unitResource(unit));
    return unit;
  }

  /** A rule of this organization, with `tool_approval.manage` decided on its scope. */
  async function manageRule(
    req: FastifyRequest,
    tx: Tx,
    id: string,
  ): Promise<{ rule: StoredPolicy; unit: Unit | null }> {
    const rule = await findPolicy(tx, id);
    if (!rule) {
      await perms.can(req, tx, MANAGE, orgResource());
      throw notFound("Rule not found", "policy_not_found");
    }
    return { rule, unit: await manageScope(req, tx, rule.scopeUnitId) };
  }

  /** `users` approvers are active members of this organization (the resolver's `org.read`): never a bot or outsider. */
  async function assertApprovers(tx: Tx, rule: Pick<PolicyInput, "approverKind" | "approverUserIds">) {
    if (rule.approverKind !== "users") return;
    const members = new Set(
      await perms.usersAllowed(tx, {
        candidates: rule.approverUserIds,
        permission: "org.read",
        resourceFor: () => orgResource(),
      }),
    );
    if (!rule.approverUserIds.every((id) => members.has(id))) {
      throw badRequest("Approvers must be people of this organization", "approver_not_member");
    }
  }

  /** A unit rule never asks less often than the rules above it (P-04, T-07.5-03-01). */
  async function assertNotWeaker(
    tx: Tx,
    unit: Unit | null,
    rule: { id?: string; toolPattern: string; mode: PolicyInput["mode"] },
  ) {
    if (!unit) return;
    const imposed = weakerThanInherited(await loadToolApprovalPolicies(tx), unit, rule);
    if (imposed) {
      throw new HttpError(
        409,
        "policy_weaker_than_inherited",
        "A unit can only add approvals: a rule above already asks more often",
        { inherited: { policyId: imposed.policyId, scopeUnitId: imposed.scopeUnitId, mode: imposed.mode } },
      );
    }
  }

  async function versionConflict(tx: Tx, id: string): Promise<HttpError> {
    const current = await findPolicy(tx, id);
    if (!current) return notFound("Rule not found", "policy_not_found");
    const [policy] = await toPolicyDtos(tx, [current]);
    return new HttpError(409, "policy_version_conflict", "Someone changed this rule meanwhile", { policy });
  }

  app.get(
    "/tool-approval-policies/access",
    { ...user, schema: { tags, response: { 200: ToolApprovalAccess } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), async (tx) => {
        const organization = await perms.can(req, tx, MANAGE, orgResource());
        const units = await perms.filter(req, tx, await allUnits(tx), MANAGE, (u) => unitResource(u));
        return {
          manageable: { organization, unitIds: units.slice(0, ACCESS_UNITS_MAX).map((u) => u.id) },
        };
      });
    },
  );

  app.get(
    "/tool-approval-policies",
    {
      ...user,
      schema: { tags, querystring: ToolApprovalScopeQuery, response: { 200: ToolApprovalPolicyPage } },
    },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const scopeId = req.query.scope === "org" ? null : req.query.scope;
      return core.db.withTenant(tenant(req), async (tx) => {
        const unit = await manageScope(req, tx, scopeId);
        const all = await loadToolApprovalPolicies(tx);
        const own = all.filter((p) => p.scopeUnitId === scopeId);
        const upper = new Set(unit ? unit.path.filter((id) => id !== unit.id) : []);
        const inherited = unit ? all.filter((p) => p.scopeUnitId === null || upper.has(p.scopeUnitId)) : [];
        const labels = await approverLabels(tx, [...own, ...inherited]);
        const scopeNames = new Map<string | null, string>([[null, ORGANIZATION_LABEL]]);
        for (const id of upper) {
          const u = await findUnit(tx, id);
          if (u) scopeNames.set(u.id, u.name);
        }
        const inheritedDtos = await toPolicyDtos(tx, inherited);
        return {
          scope: { unitId: scopeId, label: unit ? unit.name : ORGANIZATION_LABEL },
          policies: await toPolicyDtos(tx, own),
          inherited: inheritedDtos.map((p) => ({
            ...p,
            scopeLabel: scopeNames.get(p.scopeUnitId) ?? ORGANIZATION_LABEL,
          })),
          catalog: await approvableCatalog(tx, await deps.loadCatalog(tx)),
          approverLabels: Object.fromEntries(labels),
        };
      });
    },
  );

  app.post(
    "/tool-approval-policies",
    { ...user, schema: { tags, body: CreateBody, response: { 201: ToolApprovalPolicy } } },
    async (req, reply) => {
      const body = req.body;
      // The contract's approver rules now; the pattern's own codes after the scope is authorized.
      const checked = CreateToolApprovalPolicyRequest.safeParse(body);
      const issues = checked.success ? [] : checked.error.issues.filter((i) => i.path[0] !== "toolPattern");
      if (issues.length > 0) throw validationError(issues);
      const created = await core.db.withTenant(tenant(req), async (tx) => {
        const unit = await manageScope(req, tx, body.scopeUnitId);
        const bad = patternError(body.toolPattern);
        if (bad === "tool_not_approvable") {
          throw badRequest("Web tools and the platform's own tools can't carry an approval rule", bad);
        }
        if (bad) throw badRequest("Name one tool, or every tool of one server (<server>__*)", bad);
        const input: PolicyInput = {
          scopeUnitId: body.scopeUnitId,
          toolPattern: body.toolPattern,
          mode: body.mode,
          approverKind: body.approverKind,
          approverUserIds: body.approverUserIds ?? [],
        };
        await assertApprovers(tx, input);
        await assertNotWeaker(tx, unit, input);
        if (
          (await loadToolApprovalPolicies(tx)).some(
            (p) => p.scopeUnitId === input.scopeUnitId && p.toolPattern === input.toolPattern,
          )
        ) {
          throw conflict("A rule for this tool already exists in this scope", "policy_exists");
        }
        const row = await guarded(() => insertPolicy(tx, core.audit, authOf(req).userId, input));
        const [dto] = await toPolicyDtos(tx, [row]);
        return dto;
      });
      reply.code(201);
      return created;
    },
  );

  app.patch(
    "/tool-approval-policies/:id",
    {
      ...user,
      schema: {
        tags,
        params: IdParams,
        body: UpdateToolApprovalPolicyRequest,
        response: { 200: ToolApprovalPolicy },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const { rule, unit } = await manageRule(req, tx, req.params.id);
        const patch = req.body;
        // A never rule asks nobody, and only `users` names people: fill what the change implies, then re-check all.
        const mode = patch.mode ?? rule.mode;
        const approverKind = patch.approverKind ?? (mode === "never" ? "requester" : rule.approverKind);
        const approverUserIds =
          patch.approverUserIds ??
          (approverKind === "users" && rule.approverKind === "users" ? rule.approverUserIds : []);
        const next = { mode, approverKind, approverUserIds };
        const merged = CreateToolApprovalPolicyRequest.safeParse({
          scopeUnitId: rule.scopeUnitId,
          toolPattern: rule.toolPattern,
          ...next,
          approverUserIds: [...approverUserIds],
        });
        if (!merged.success) throw validationError(merged.error.issues);
        await assertApprovers(tx, next);
        await assertNotWeaker(tx, unit, { id: rule.id, toolPattern: rule.toolPattern, mode });
        if (rule.version !== patch.expectedVersion) throw await versionConflict(tx, rule.id);
        const updated = await guarded(() =>
          updatePolicy(tx, core.audit, authOf(req).userId, rule, patch.expectedVersion, next),
        );
        if (!updated) throw await versionConflict(tx, rule.id);
        const [dto] = await toPolicyDtos(tx, [updated]);
        return dto;
      }),
  );

  app.delete(
    "/tool-approval-policies/:id",
    { ...user, schema: { tags, params: IdParams, querystring: DeleteToolApprovalPolicyQuery } },
    async (req, reply) => {
      await core.db.withTenant(tenant(req), async (tx) => {
        const { rule } = await manageRule(req, tx, req.params.id);
        if (rule.version !== req.query.expectedVersion) throw await versionConflict(tx, rule.id);
        const done = await guarded(() => deletePolicy(tx, core.audit, rule, req.query.expectedVersion));
        if (!done) throw await versionConflict(tx, rule.id);
      });
      return reply.code(204).send();
    },
  );

  app.get(
    "/tool-approval-policies/history",
    {
      ...user,
      schema: { tags, querystring: ToolApprovalHistoryQuery, response: { 200: ToolApprovalHistory } },
    },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const scopeId = req.query.scope === "org" ? null : req.query.scope;
      return core.db.withTenant(tenant(req), async (tx) => {
        await manageScope(req, tx, scopeId);
        return policyHistory(tx, scopeId, req.query.cursor);
      });
    },
  );
}
