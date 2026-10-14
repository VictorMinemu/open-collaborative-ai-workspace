import {
  CreateToolApprovalPolicyRequest,
  ToolApprovalAccess,
  ToolApprovalPolicy,
  ToolApprovalPolicyPage,
  ToolApprovalScopeQuery,
} from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import type { FastifyRequest } from "fastify";
import { type App, authOf, type Core, tenant } from "../../core";
import { notFound } from "../../lib/errors";
import { orgResource, type PermissionService, unitResource } from "../organization";
import {
  allUnits,
  approvableCatalog,
  approverLabels,
  findUnit,
  insertPolicy,
  type LoadCatalog,
  loadToolApprovalPolicies,
  ORGANIZATION_LABEL,
  toPolicyDtos,
} from "./policies";

const tags = ["tool-approval"];
const MANAGE = "tool_approval.manage" as const;
const ACCESS_UNITS_MAX = 500;

type Unit = { id: string; name: string; path: string[] };

/**
 * Settings › Approval policies (Phase 07.5, D-01, P-03, UI-SPEC Surface 4, R4). Every route is `authz: user`; who may
 * manage a scope is the resolver's `tool_approval.manage` decided on that scope (the organization, or the unit as a
 * resource, so leads get it on the subtree they lead through LEAD_PERMISSIONS). Ids resolve inside the caller's
 * tenant transaction: another organization's unit or rule is simply not found.
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
        const upper = new Set(unit ? unit.path.slice(0, -1) : []);
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
    {
      ...user,
      schema: { tags, body: CreateToolApprovalPolicyRequest, response: { 201: ToolApprovalPolicy } },
    },
    async (req, reply) => {
      const body = req.body;
      const created = await core.db.withTenant(tenant(req), async (tx) => {
        await manageScope(req, tx, body.scopeUnitId);
        const row = await insertPolicy(tx, core.audit, authOf(req).userId, {
          scopeUnitId: body.scopeUnitId,
          toolPattern: body.toolPattern,
          mode: body.mode,
          approverKind: body.approverKind,
          approverUserIds: body.approverUserIds ?? [],
        });
        const [dto] = await toPolicyDtos(tx, [row]);
        return dto;
      });
      reply.code(201);
      return created;
    },
  );
}
