import {
  MODULE_CATALOG,
  ModuleAccessQuery,
  ModuleAccessView,
  ModuleId,
  type ModuleState,
  type OrgRole,
  SetModuleAccessRequest,
} from "@ocw/contracts";
import { orgMembers, permissionRules, type Tx } from "@ocw/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { type App, authOf, type Core, tenant } from "../../core";
import { loadRules } from "./permissions/facts";
import { moduleTargetResource } from "./permissions/policy";
import type { RuleFact } from "./permissions/resolve";
import type { PermissionService } from "./permissions/service";
import { assertSubjectExists, deleteRuleRow, insertRuleRow, type RuleRow, rulesChanged } from "./rules";
import { requireUnit } from "./units";

/**
 * Module access (ADR-0024, ACCESS-02): turning a module off for the organization, a unit or a person writes one
 * ordinary `effect: "deny"`, `tool: null` row per catalog pattern at exactly that scope and subject; turning it on
 * deletes exactly those rows (duplicates and hand-written catalog rows included). Nothing else is ever written or
 * deleted: no allow row, no tool row, no non-catalog permission, no row of another scope or subject (P-05). Rows go
 * through the same helpers as `/permission-rules` (per-row audit), and one `permission_rules.updated` per request that
 * changed rows re-decides live subscriptions (ADR-0009). Who may do it is the resolver's `unit.modules.manage`
 * (admins everywhere, leads on the subtree they lead, never above an equal role: `role_ceiling`).
 */

type Subject = { kind: "everyone" } | { kind: "user"; userId: string };

/** The state of one module's exact rows (deny, no tool, same scope, same subject, catalog patterns only). */
export function moduleStateOf(
  rules: readonly RuleFact[],
  module: ModuleId,
  scopeUnitId: string | null,
  subject: Subject,
): ModuleState {
  const patterns = MODULE_CATALOG[module].patterns;
  const present = new Set<string>();
  for (const r of rules) {
    if (r.effect !== "deny" || r.tool !== null || r.scopeUnitId !== scopeUnitId) continue;
    if (r.subjectKind !== subject.kind) continue;
    if (subject.kind === "user" ? r.subjectId !== subject.userId : r.subjectId !== null) continue;
    if (patterns.includes(r.permission)) present.add(r.permission);
  }
  if (present.size === 0) return "on";
  return present.size === patterns.length ? "off" : "custom";
}

interface Scope {
  unit: { id: string; name: string; path: readonly string[] } | null;
}

async function loadScope(tx: Tx, unitId: string | null | undefined): Promise<Scope> {
  if (!unitId) return { unit: null };
  const u = await requireUnit(tx, unitId);
  return { unit: { id: u.id, name: u.name, path: u.path } };
}

async function buildView(tx: Tx, scope: Scope): Promise<ModuleAccessView> {
  const rules = await loadRules(tx);
  const scopeUnitId = scope.unit?.id ?? null;
  return ModuleAccessView.parse({
    scope: { scopeUnitId, name: scope.unit?.name ?? "Organization" },
    modules: ModuleId.options.map((module) => ({
      module,
      state: moduleStateOf(rules, module, scopeUnitId, { kind: "everyone" }),
      inherited: null,
    })),
    people: [],
    overrides: [],
    unitBotCount: 0,
  });
}

/** The exact rows of (scope, subject, module): deny, no tool, catalog patterns only. */
async function exactRows(
  tx: Tx,
  module: ModuleId,
  scopeUnitId: string | null,
  subject: Subject,
): Promise<RuleRow[]> {
  return tx
    .select()
    .from(permissionRules)
    .where(
      and(
        scopeUnitId === null
          ? isNull(permissionRules.scopeUnitId)
          : eq(permissionRules.scopeUnitId, scopeUnitId),
        eq(permissionRules.subjectKind, subject.kind),
        subject.kind === "user"
          ? eq(permissionRules.subjectId, subject.userId)
          : isNull(permissionRules.subjectId),
        eq(permissionRules.effect, "deny"),
        isNull(permissionRules.tool),
        inArray(permissionRules.permission, [...MODULE_CATALOG[module].patterns]),
      ),
    );
}

async function targetRoleOf(tx: Tx, userId: string): Promise<OrgRole | undefined> {
  const [row] = await tx
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(eq(orgMembers.userId, userId))
    .limit(1);
  return row?.role;
}

export function registerModuleAccessRoutes(app: App, core: Core, perms: PermissionService): void {
  const tags = ["organization"];
  const requireUser = core.identity.requireUser;

  const assertManages = (req: FastifyRequest, tx: Tx, scope: Scope, targetRole?: OrgRole) =>
    perms.assertCan(req, tx, "unit.modules.manage", moduleTargetResource(scope.unit, targetRole));

  app.put(
    "/module-access",
    {
      config: { authz: "user" },
      preHandler: requireUser,
      schema: { tags, body: SetModuleAccessRequest, response: { 200: ModuleAccessView } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const { module, subject, enabled } = req.body;
        const scope = await loadScope(tx, req.body.scopeUnitId);
        // The scope first, so a caller without the right learns nothing about the subject.
        await assertManages(req, tx, scope);
        if (subject.kind === "user") {
          await assertSubjectExists(tx, "user", subject.userId);
          await assertManages(req, tx, scope, await targetRoleOf(tx, subject.userId));
        }
        const scopeUnitId = scope.unit?.id ?? null;
        const existing = await exactRows(tx, module, scopeUnitId, subject);
        const metadata = { module, via: "module_access" };
        const changed: string[] = [];
        if (enabled) {
          for (const row of existing) {
            if (await deleteRuleRow(core, tx, row, metadata)) changed.push(row.id);
          }
        } else {
          const present = new Set(existing.map((r) => r.permission));
          for (const permission of MODULE_CATALOG[module].patterns) {
            if (present.has(permission)) continue;
            const rule = await insertRuleRow(
              core,
              tx,
              {
                scopeUnitId,
                subjectKind: subject.kind,
                subjectId: subject.kind === "user" ? subject.userId : null,
                permission,
                tool: null,
                effect: "deny",
              },
              { createdBy: authOf(req).userId, metadata },
            );
            changed.push(rule.id);
          }
        }
        const [first] = changed;
        if (first) await rulesChanged(core, tx, first, enabled ? "module_enabled" : "module_disabled");
        return buildView(tx, scope);
      }),
  );

  app.get(
    "/module-access",
    {
      config: { authz: "user" },
      preHandler: requireUser,
      schema: { tags, querystring: ModuleAccessQuery, response: { 200: ModuleAccessView } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const scope = await loadScope(tx, req.query.unitId);
        await assertManages(req, tx, scope);
        return buildView(tx, scope);
      }),
  );
}
