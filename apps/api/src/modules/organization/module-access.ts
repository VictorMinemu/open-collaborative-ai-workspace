import {
  MODULE_CATALOG,
  type ModuleAccessModuleState,
  ModuleAccessQuery,
  ModuleAccessView,
  ModuleId,
  type ModuleState,
  type OrgRole,
  SetModuleAccessRequest,
} from "@ocw/contracts";
import { agents, orgMembers, orgUnits, permissionRules, type Tx, unitMemberships } from "@ocw/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { type App, authOf, type Core, tenant } from "../../core";
import { badRequest } from "../../lib/errors";
import { loadRules } from "./permissions/facts";
import { moduleTargetResource } from "./permissions/policy";
import type { RuleFact } from "./permissions/resolve";
import type { PermissionService } from "./permissions/service";
import { assertSubjectExists, deleteRuleRow, insertRuleRow, type RuleRow, rulesChanged } from "./rules";
import { requireUnit, uuidArray } from "./units";

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

const ORGANIZATION = "Organization";
const EVERYONE: Subject = { kind: "everyone" };

/** The stronger of two states: off beats custom beats on. */
function strongest(a: ModuleState, b: ModuleState): ModuleState {
  if (a === "off" || b === "off") return "off";
  return a === "custom" || b === "custom" ? "custom" : "on";
}

export interface ModuleAccessInput {
  rules: readonly RuleFact[];
  /** `unitId` null = the organization; `path` is the unit's root → self path ([] for the organization). */
  scope: { unitId: string | null; path: readonly string[]; name: string };
  /** Names of every unit the view mentions (ancestors and units inside the scope). */
  unitNames: ReadonlyMap<string, string>;
  /** Units strictly inside the scope (every unit for the organization). */
  unitsInside: ReadonlyArray<{ id: string; name: string; path: readonly string[] }>;
  people: ReadonlyArray<{ userId: string; displayName: string; avatarUrl: string | null; canEdit: boolean }>;
  unitBotCount: number;
}

/**
 * The nearest strict ancestor of the scope (deepest first), then the organization, where the module is not on for
 * everyone (or, for a person, for them either).
 */
function inheritedOf(
  input: ModuleAccessInput,
  module: ModuleId,
  userId: string | null,
): ModuleAccessModuleState["inherited"] {
  const { scope } = input;
  if (scope.unitId === null) return null;
  const ancestors: Array<string | null> = [...scope.path.filter((id) => id !== scope.unitId)].reverse();
  ancestors.push(null);
  for (const scopeUnitId of ancestors) {
    let state = moduleStateOf(input.rules, module, scopeUnitId, EVERYONE);
    if (userId)
      state = strongest(state, moduleStateOf(input.rules, module, scopeUnitId, { kind: "user", userId }));
    if (state === "on") continue;
    const name = scopeUnitId === null ? ORGANIZATION : (input.unitNames.get(scopeUnitId) ?? "Unit");
    return { scopeUnitId, name, state };
  }
  return null;
}

/** Units in tree order: by the names along their path (siblings by name), ties by id. */
function treeOrder(
  units: ModuleAccessInput["unitsInside"],
  names: ReadonlyMap<string, string>,
): ModuleAccessInput["unitsInside"] {
  const key = (path: readonly string[]) => path.map((id) => names.get(id) ?? "");
  return [...units].sort((a, b) => {
    const ka = key(a.path);
    const kb = key(b.path);
    for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
      const c = (ka[i] ?? "").localeCompare(kb[i] ?? "");
      if (c !== 0) return c;
    }
    return ka.length - kb.length || a.id.localeCompare(b.id);
  });
}

/**
 * The panel's view of one scope (pure): the `everyone` state of each module at the scope with what an ancestor
 * already turned off, each person's own rows at the scope (and what reaches them from above), and the units inside
 * the scope that differ.
 */
export function deriveModuleAccess(input: ModuleAccessInput): ModuleAccessView {
  const { rules, scope } = input;
  const statesFor = (scopeUnitId: string | null, subject: Subject, userId: string | null, inherit: boolean) =>
    ModuleId.options.map((module) => ({
      module,
      state: moduleStateOf(rules, module, scopeUnitId, subject),
      inherited: inherit ? inheritedOf(input, module, userId) : null,
    }));
  return {
    scope: { scopeUnitId: scope.unitId, name: scope.name },
    modules: statesFor(scope.unitId, EVERYONE, null, true),
    people: input.people.map((p) => ({
      ...p,
      modules: statesFor(scope.unitId, { kind: "user", userId: p.userId }, p.userId, true),
    })),
    overrides: treeOrder(input.unitsInside, input.unitNames)
      .map((u) => ({ unitId: u.id, name: u.name, modules: statesFor(u.id, EVERYONE, null, false) }))
      .filter((o) => o.modules.some((m) => m.state !== "on")),
    unitBotCount: input.unitBotCount,
  };
}

interface Scope {
  unit: { id: string; name: string; path: readonly string[] } | null;
}

async function loadScope(tx: Tx, unitId: string | null | undefined): Promise<Scope> {
  if (!unitId) return { unit: null };
  const u = await requireUnit(tx, unitId);
  return { unit: { id: u.id, name: u.name, path: u.path } };
}

/** Active members with a membership in the scope unit's subtree (`subtreeIds`), or every active member. */
async function scopePeople(tx: Tx, subtreeIds: readonly string[] | null) {
  const cols = {
    userId: orgMembers.userId,
    displayName: orgMembers.displayName,
    avatarUrl: orgMembers.avatarUrl,
    role: orgMembers.role,
  };
  if (subtreeIds === null) {
    return tx
      .select(cols)
      .from(orgMembers)
      .where(isNull(orgMembers.deactivatedAt))
      .orderBy(asc(orgMembers.displayName), asc(orgMembers.userId));
  }
  return tx
    .selectDistinct(cols)
    .from(orgMembers)
    .innerJoin(unitMemberships, eq(unitMemberships.userId, orgMembers.userId))
    .where(and(isNull(orgMembers.deactivatedAt), inArray(unitMemberships.unitId, [...subtreeIds])))
    .orderBy(asc(orgMembers.displayName), asc(orgMembers.userId));
}

/**
 * The view of `scope` for the request's principal. `canEdit` per person is the resolver's `unit.modules.manage` on
 * the scope with that person's role as the target (`role_ceiling`): the role is data for the resolver, never compared
 * here.
 */
async function buildView(
  req: FastifyRequest,
  tx: Tx,
  perms: PermissionService,
  scope: Scope,
): Promise<ModuleAccessView> {
  const rules = await loadRules(tx);
  const units = await tx.select({ id: orgUnits.id, name: orgUnits.name, path: orgUnits.path }).from(orgUnits);
  const unitNames = new Map(units.map((u) => [u.id, u.name]));
  const scopeUnit = scope.unit;
  const unitsInside = scopeUnit
    ? units.filter((u) => u.id !== scopeUnit.id && u.path.includes(scopeUnit.id))
    : units;
  const subtreeIds = scopeUnit ? [scopeUnit.id, ...unitsInside.map((u) => u.id)] : null;
  const people = await scopePeople(tx, subtreeIds);
  const editable = new Set(
    (
      await perms.filter(req, tx, people, "unit.modules.manage", (p) =>
        moduleTargetResource(scopeUnit, p.role),
      )
    ).map((p) => p.userId),
  );
  let unitBotCount = 0;
  if (subtreeIds) {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(agents)
      .where(and(isNull(agents.deletedAt), inArray(agents.unitId, subtreeIds)));
    unitBotCount = Number(row?.n ?? 0);
  }
  return ModuleAccessView.parse(
    deriveModuleAccess({
      rules,
      scope: {
        unitId: scopeUnit?.id ?? null,
        path: scopeUnit?.path ?? [],
        name: scopeUnit?.name ?? ORGANIZATION,
      },
      unitNames,
      unitsInside,
      people: people.map((p) => ({
        userId: p.userId,
        displayName: p.displayName,
        avatarUrl: p.avatarUrl,
        canEdit: editable.has(p.userId),
      })),
      unitBotCount,
    }),
  );
}

/** 400 `not_in_unit` unless `userId` is an active member of a unit in `unit`'s subtree. */
async function assertInSubtree(tx: Tx, unit: { id: string; name: string }, userId: string): Promise<void> {
  const [row] = await tx
    .select({ userId: unitMemberships.userId })
    .from(unitMemberships)
    .innerJoin(orgUnits, eq(orgUnits.id, unitMemberships.unitId))
    .innerJoin(orgMembers, eq(orgMembers.userId, unitMemberships.userId))
    .where(
      and(
        eq(unitMemberships.userId, userId),
        isNull(orgMembers.deactivatedAt),
        sql`${orgUnits.path} @> ${uuidArray([unit.id])}`,
      ),
    )
    .limit(1);
  if (!row) throw badRequest(`This person is not in ${unit.name}`, "not_in_unit");
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
          // A unit-scoped person rule applies only while the person is in that subtree (and leads reach no further).
          if (scope.unit) await assertInSubtree(tx, scope.unit, subject.userId);
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
        return buildView(req, tx, perms, scope);
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
        return buildView(req, tx, perms, scope);
      }),
  );
}
