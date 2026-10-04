import {
  CreatePermissionRuleRequest,
  EventTypes,
  IdParams,
  Ok,
  PermissionRule,
  PermissionRuleList,
} from "@ocw/contracts";
import { agents, orgMembers, permissionRules, type Tx, tenantOf } from "@ocw/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { type App, type Core, tenant } from "../../core";
import { badRequest, notFound } from "../../lib/errors";
import type { PermissionService } from "./permissions/service";
import { orgTopic, requireUnit } from "./units";

/**
 * Explicit allow/deny rules (D-02, ORG-03). The rows written here are exactly the rule facts the resolver
 * loads per request (`permissions/facts.ts` → `loadRules`), so a change applies to the next decision. No
 * update route: delete + create keeps the audit trail explicit.
 */

type RuleRow = typeof permissionRules.$inferSelect;

function toRule(r: RuleRow): PermissionRule {
  return PermissionRule.parse({
    id: r.id,
    scopeUnitId: r.scopeUnitId,
    subjectKind: r.subjectKind,
    subjectId: r.subjectId,
    permission: r.permission,
    tool: r.tool,
    effect: r.effect,
    createdBy: r.createdBy,
    createdAt: new Date(r.createdAt).toISOString(),
  });
}

/** 400 `unknown_subject` unless a user subject is an org member and an agent subject a live agent. */
async function assertSubjectExists(tx: Tx, kind: string, subjectId: string | null): Promise<void> {
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

async function rulesChanged(core: Core, tx: Tx, ruleId: string, action: string): Promise<void> {
  await core.realtime.appendEvent(
    tx,
    orgTopic(tenantOf(tx).organizationId),
    EventTypes.permissionRulesUpdated,
    { ruleId, action },
  );
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
        const [row] = await tx
          .insert(permissionRules)
          .values({
            organizationId: tenantOf(tx).organizationId,
            scopeUnitId: body.scopeUnitId,
            subjectKind: body.subjectKind,
            subjectId: body.subjectId,
            permission: body.permission,
            tool: body.tool,
            effect: body.effect,
            createdBy: req.auth?.userId ?? null,
          })
          .returning();
        if (!row) throw new Error("rule insert returned no row");
        const rule = toRule(row);
        await core.audit.record(tx, {
          action: "permission_rule.created",
          resourceType: "permission_rule",
          resourceId: rule.id,
          metadata: { rule },
        });
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
          .delete(permissionRules)
          .where(eq(permissionRules.id, req.params.id))
          .returning();
        if (!row) throw notFound("Rule not found", "rule_not_found");
        await core.audit.record(tx, {
          action: "permission_rule.deleted",
          resourceType: "permission_rule",
          resourceId: row.id,
          metadata: { rule: toRule(row) },
        });
        await rulesChanged(core, tx, row.id, "deleted");
        return { ok: true as const };
      }),
  );
}
