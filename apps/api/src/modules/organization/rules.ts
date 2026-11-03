import {
  AGENT_RULE_LIST_MAX,
  CreatePermissionRuleRequest,
  EventTypes,
  IdParams,
  Ok,
  PermissionRule,
  PermissionRuleList,
} from "@ocw/contracts";
import { agents, orgMembers, permissionRules, type Tx, tenantOf } from "@ocw/db";
import { and, asc, eq, isNull, like, sql } from "drizzle-orm";
import { type App, type Core, tenant } from "../../core";
import { badRequest, conflict, notFound } from "../../lib/errors";
import type { PermissionService } from "./permissions/service";
import { orgTopic, requireUnit } from "./units";

/**
 * Explicit allow/deny rules (D-02, ORG-03). The rows written here are exactly the rule facts the resolver
 * loads per request (`permissions/facts.ts` → `loadRules`), so a change applies to the next decision. No
 * update route: delete + create keeps the audit trail explicit.
 */

export type RuleRow = typeof permissionRules.$inferSelect;

export function toRule(r: RuleRow): PermissionRule {
  return PermissionRule.parse({
    id: r.id,
    scopeUnitId: r.scopeUnitId,
    subjectKind: r.subjectKind,
    subjectId: r.subjectId,
    permission: r.permission,
    tool: r.tool,
    pathPrefix: r.pathPrefix,
    effect: r.effect,
    createdBy: r.createdBy,
    createdAt: new Date(r.createdAt).toISOString(),
  });
}

/** 400 `unknown_subject` unless a user subject is an org member and an agent subject a live agent. */
export async function assertSubjectExists(tx: Tx, kind: string, subjectId: string | null): Promise<void> {
  if (kind !== "user" && kind !== "agent") return;
  if (!subjectId) throw badRequest(`Unknown ${kind} for this rule`, "unknown_subject");
  const found =
    kind === "user"
      ? await tx
          .select({ id: orgMembers.userId })
          .from(orgMembers)
          .where(eq(orgMembers.userId, subjectId))
          .limit(1)
      : await tx
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, subjectId), isNull(agents.deletedAt)))
          .limit(1);
  if (found.length === 0) throw badRequest(`Unknown ${kind} for this rule`, "unknown_subject");
}

/**
 * One `permission_rules.updated` on `org:<id>`: the web refetches `/me/permissions` and every live subscription of
 * the organization is re-decided (ADR-0009). Callers append exactly one per request that changed rows.
 */
export async function rulesChanged(core: Core, tx: Tx, ruleId: string, action: string): Promise<void> {
  await core.realtime.appendEvent(
    tx,
    orgTopic(tenantOf(tx).organizationId),
    EventTypes.permissionRulesUpdated,
    { ruleId, action },
  );
}

export interface RuleRowValues {
  scopeUnitId: string | null;
  subjectKind: RuleRow["subjectKind"];
  subjectId: string | null;
  permission: string;
  tool: string | null;
  /** Memory folder (`hr/`), only on `memory.*` rules (validated by the contract and a DB check); omitted = none. */
  pathPrefix?: string | null;
  effect: RuleRow["effect"];
}

/**
 * Inserts one rule row and audits it (`permission_rule.created`, `metadata: { rule, ...metadata }`). Validation of
 * scope and subject is the caller's; the realtime event is too (`rulesChanged`, once per request).
 */
export async function insertRuleRow(
  core: Core,
  tx: Tx,
  values: RuleRowValues,
  opts: { createdBy: string | null; metadata?: Record<string, unknown> },
): Promise<PermissionRule> {
  const [row] = await tx
    .insert(permissionRules)
    .values({ organizationId: tenantOf(tx).organizationId, ...values, createdBy: opts.createdBy })
    .returning();
  if (!row) throw new Error("rule insert returned no row");
  const rule = toRule(row);
  await core.audit.record(tx, {
    action: "permission_rule.created",
    resourceType: "permission_rule",
    resourceId: rule.id,
    metadata: { rule, ...opts.metadata },
  });
  return rule;
}

/** Deletes one loaded rule row and audits it (`permission_rule.deleted`); false when it was already gone. */
export async function deleteRuleRow(
  core: Core,
  tx: Tx,
  row: RuleRow,
  metadata?: Record<string, unknown>,
): Promise<boolean> {
  const [deleted] = await tx.delete(permissionRules).where(eq(permissionRules.id, row.id)).returning();
  if (!deleted) return false;
  await core.audit.record(tx, {
    action: "permission_rule.deleted",
    resourceType: "permission_rule",
    resourceId: deleted.id,
    metadata: { rule: toRule(deleted), ...metadata },
  });
  return true;
}

/**
 * CR-B-05: a bot's consult sheet (`/agents/:id/messaging`) lists its organization-scope per-target `agent.message` rules
 * and saves them back in one request of at most `AGENT_RULE_LIST_MAX` per effect, so this writer refuses one more (409
 * `agent_rule_limit`) instead of leaving a sheet that cannot be saved.
 */
async function assertAgentRuleRoom(tx: Tx, body: CreatePermissionRuleRequest): Promise<void> {
  if (body.permission !== "agent.message" || body.subjectKind !== "agent" || body.scopeUnitId) return;
  if (!body.tool?.startsWith("agent:") || body.pathPrefix) return;
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(permissionRules)
    .where(
      and(
        isNull(permissionRules.scopeUnitId),
        eq(permissionRules.subjectKind, "agent"),
        eq(permissionRules.subjectId, body.subjectId ?? ""),
        eq(permissionRules.permission, "agent.message"),
        eq(permissionRules.effect, body.effect),
        isNull(permissionRules.pathPrefix),
        like(permissionRules.tool, "agent:%"),
      ),
    );
  if ((row?.n ?? 0) >= AGENT_RULE_LIST_MAX) {
    throw conflict(
      `A bot can name at most ${AGENT_RULE_LIST_MAX} bots per list in its consult rules`,
      "agent_rule_limit",
    );
  }
}

export function registerRuleRoutes(app: App, core: Core, perms: PermissionService): void {
  const tags = ["organization"];
  const requireUser = core.identity.requireUser;

  app.get(
    "/permission-rules",
    {
      config: { authz: "user" },
      preHandler: [requireUser, perms.requirePermission("rule.read")],
      schema: { tags, response: { 200: PermissionRuleList } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const rows = await tx
          .select()
          .from(permissionRules)
          .orderBy(asc(permissionRules.createdAt), asc(permissionRules.id));
        return { rules: rows.map(toRule) };
      }),
  );

  app.post(
    "/permission-rules",
    {
      config: { authz: "user" },
      preHandler: [requireUser, perms.requirePermission("rule.manage")],
      // The contract rejects allows of non-delegable permissions and malformed subjects (400 validation_error).
      schema: { tags, body: CreatePermissionRuleRequest, response: { 200: PermissionRule } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const body = req.body;
        if (body.scopeUnitId) await requireUnit(tx, body.scopeUnitId);
        await assertSubjectExists(tx, body.subjectKind, body.subjectId);
        await assertAgentRuleRoom(tx, body);
        const rule = await insertRuleRow(
          core,
          tx,
          {
            scopeUnitId: body.scopeUnitId,
            subjectKind: body.subjectKind,
            subjectId: body.subjectId,
            permission: body.permission,
            tool: body.tool,
            pathPrefix: body.pathPrefix,
            effect: body.effect,
          },
          { createdBy: req.auth?.userId ?? null },
        );
        await rulesChanged(core, tx, rule.id, "created");
        return rule;
      }),
  );

  app.delete(
    "/permission-rules/:id",
    {
      config: { authz: "user" },
      preHandler: [requireUser, perms.requirePermission("rule.manage")],
      schema: { tags, params: IdParams, response: { 200: Ok } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const [row] = await tx
          .select()
          .from(permissionRules)
          .where(eq(permissionRules.id, req.params.id))
          .limit(1);
        if (!row || !(await deleteRuleRow(core, tx, row))) throw notFound("Rule not found", "rule_not_found");
        await rulesChanged(core, tx, row.id, "deleted");
        return { ok: true as const };
      }),
  );
}
