import {
  AddUnitMemberRequest,
  ALLOWED_PARENT_KINDS,
  CreateUnitRequest,
  EventTypes,
  IdParams,
  MEMORY_ROOT_FILE,
  MEMORY_ROOT_TEMPLATE,
  MoveUnitRequest,
  memoryPathKey,
  Ok,
  type OrgRole,
  OrgUnit,
  OrgUnitList,
  type Permission,
  RenameUnitRequest,
  type UnitKind,
  UnitMember,
  UnitMemberList,
  UnitMemberParams,
  UnitRole,
  UpdateUnitMemberRequest,
} from "@ocw/contracts";
import {
  agents,
  agentTemplates,
  approvalRequests,
  memoryFiles,
  memoryProposals,
  memoryScopes,
  orgMembers,
  orgUnits,
  permissionRules,
  type Tx,
  tenantOf,
  toolApprovalPolicies,
  unitMemberships,
  vaultItems,
  workProjectRepos,
  workProjectTeams,
} from "@ocw/db";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { type App, type Core, tenant } from "../../core";
import { badRequest, conflict, notFound } from "../../lib/errors";
import type { OrganizationDeps } from "./index";
import { orgResource, unitResource } from "./permissions/policy";
import type { PermissionService } from "./permissions/service";

/**
 * Organization hierarchy (ORG-01): departments, teams and hierarchy projects in `app.org_units` (adjacency +
 * materialised `uuid[]` ancestor path, D-07). Hierarchy "projects" are `kind = 'project'` rows here, never
 * `app.projects` (device repositories, Pitfall 12). Every structural change runs under the per-organization
 * advisory lock (Pitfall 6), writes its audit row in the same transaction and emits `units.updated`.
 */

// ---------------------------------------------------------------- pure helpers

/** True when a unit of `kind` may sit under a parent of `parentKind` (`null` = top level). */
export function validateParentKind(kind: UnitKind, parentKind: UnitKind | null): boolean {
  return ALLOWED_PARENT_KINDS[kind].includes(parentKind);
}

export interface UnitNode {
  id: string;
  parentId: string | null;
  path: readonly string[];
}

/**
 * The tree after moving `unitId` under `newParentId` (null = top level): the unit and its whole subtree get
 * `newParent.path ++ path[from unitId]`. Throws `"unit_cycle"` when the target is the unit itself or one of
 * its descendants. Pure mirror of the SQL in the move route (property-tested in units.test.ts).
 */
export function applyMove<T extends UnitNode>(
  units: ReadonlyArray<T>,
  unitId: string,
  newParentId: string | null,
): Array<UnitNode> {
  const unit = units.find((u) => u.id === unitId);
  if (!unit) throw new Error("unit_not_found");
  const target = newParentId === null ? null : units.find((u) => u.id === newParentId);
  if (target === undefined) throw new Error("unit_not_found");
  if (target && (target.id === unitId || target.path.includes(unitId))) throw new Error("unit_cycle");
  const prefix = target ? target.path : [];
  return units.map((u) => {
    const at = u.path.indexOf(unitId);
    if (at === -1) return { id: u.id, parentId: u.parentId, path: [...u.path] };
    return {
      id: u.id,
      parentId: u.id === unitId ? newParentId : u.parentId,
      path: [...prefix, ...u.path.slice(at)],
    };
  });
}

/**
 * Longest allocated unit handle: one `@mention` token (`MENTION_TOKEN_RE` reads at most 40 characters), so every handle
 * can be typed. The same cut as `app.org_unit_handle`, the SQL allocator of the backfill and the fill trigger.
 */
const UNIT_HANDLE_TYPED_MAX = 40;

/**
 * Phase 07.17 (D-14, PD-12): the `n`-th handle tried for a unit whose name gives `base` (`unitHandle`): `base` first,
 * then `base-2`, `base-3`, … with the base cut to `40 - len("-n")` and its trailing `._-` trimmed, so the handle stays
 * one typeable token. Mirrors `app.org_unit_handle` exactly (the integration test compares the two).
 */
export function nextHandleCandidate(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = `-${n}`;
  return `${base.slice(0, UNIT_HANDLE_TYPED_MAX - suffix.length).replace(/[._-]+$/, "")}${suffix}`;
}

// ---------------------------------------------------------------- data access

export type UnitRow = typeof orgUnits.$inferSelect;

/** The permissions a unit row reports in `viewerCan` (the web renders these, never re-implements policy). */
const UNIT_VIEWER_PERMISSIONS: readonly Permission[] = [
  // 07.17 code review WR-09: whether the viewer may read (and so @mention) the unit, as `unitMentionGate` decides it,
  // so the composer never offers a team the server would not resolve (a unit-scoped deny).
  "unit.read",
  "unit.manage",
  "unit.members.manage",
  "unit.modules.manage",
];

export const orgTopic = (organizationId: string) => `org:${organizationId}`;

/** A Postgres `uuid[]` literal from validated ids (drizzle would expand a JS array into a value list). */
export const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(",")}}`}::uuid[]`;

/** The name of the constraint a Postgres error (direct or wrapped by Drizzle) reports. */
function constraintOf(err: unknown): string | undefined {
  const e = err as { constraint?: string; cause?: { constraint?: string } };
  return e?.constraint ?? e?.cause?.constraint;
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/** Serialises structural changes of one organization's tree (create, move, delete): Pitfall 6. */
export async function lockUnits(tx: Tx): Promise<void> {
  const { organizationId } = tenantOf(tx);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`org_units:${organizationId}`}, 0))`);
}

export async function loadUnit(tx: Tx, id: string): Promise<UnitRow | null> {
  const [row] = await tx.select().from(orgUnits).where(eq(orgUnits.id, id)).limit(1);
  return row ?? null;
}

/** 404 when the unit is not in the tenant (RLS hides other organizations' rows). */
export async function requireUnit(tx: Tx, id: string): Promise<UnitRow> {
  const unit = await loadUnit(tx, id);
  if (!unit) throw notFound("Unit not found", "unit_not_found");
  return unit;
}

/**
 * Phase 07.17 (D-14, PD-12; code review WR-05): the handle a new unit named `name` gets, from the one allocator that
 * also backfilled every unit and fills any insert that omits it (`app.org_unit_handle`: `app.unaccent`, so "Straße" →
 * "strasse"; the first free of base, base-2, … among the organization's unit handles and live bot usernames). The
 * caller holds `lockUnits`, the lock every unit insert takes, so the handle cannot be taken between this read and the
 * insert. `unitHandle` in the contracts is only the client-side preview (approximate for letters that do not decompose).
 */
export async function allocateUnitHandle(tx: Tx, organizationId: string, name: string): Promise<string> {
  const res = await tx.execute(sql`select app.org_unit_handle(${organizationId}::uuid, ${name}) as handle`);
  const handle = (res.rows[0] as { handle: string | null } | undefined)?.handle;
  if (!handle) throw new Error("unit handle allocation returned nothing");
  return handle;
}

async function unitCounts(tx: Tx, unitId?: string) {
  const rows = await tx
    .select({
      unitId: unitMemberships.unitId,
      members: sql<number>`count(*)::int`,
      leads: sql<number>`(count(*) filter (where ${unitMemberships.role} = 'lead'))::int`,
    })
    .from(unitMemberships)
    .where(unitId ? eq(unitMemberships.unitId, unitId) : undefined)
    .groupBy(unitMemberships.unitId);
  return new Map(rows.map((r) => [r.unitId, { members: Number(r.members), leads: Number(r.leads) }]));
}

export interface UnitReach {
  reach: number;
  viewerInReach: boolean;
}

/**
 * Phase 07.17 (D-13, PD-14): who a mention of each unit reaches, in one grouped query: the distinct active members of
 * the unit's subtree (memberships of the units whose `path` holds it; deactivated members never count) and whether the
 * viewer is one of them. Tenant RLS filters every table read; the explicit organization joins keep a row of another
 * organization out even if one were ever planted on this tree. A unit absent from the map reaches no one.
 */
async function unitReach(
  tx: Tx,
  viewerUserId: string | null,
  unitIds?: readonly string[],
): Promise<Map<string, UnitReach>> {
  const res = await tx.execute(sql`
    select u.id as unit_id,
           count(distinct m.user_id)::int as reach,
           coalesce(bool_or(m.user_id = ${viewerUserId}::uuid), false) as viewer_in_reach
      from app.org_units u
      join app.org_units d on d.organization_id = u.organization_id and d.path @> array[u.id]
      join app.unit_memberships m on m.organization_id = u.organization_id and m.unit_id = d.id
      join app.org_members om
        on om.organization_id = m.organization_id and om.user_id = m.user_id and om.deactivated_at is null
     ${unitIds ? sql`where u.id = any(${uuidArray(unitIds)})` : sql``}
     group by u.id`);
  const rows = res.rows as Array<{ unit_id: string; reach: number; viewer_in_reach: boolean }>;
  return new Map(
    rows.map((r) => [
      String(r.unit_id),
      { reach: Number(r.reach), viewerInReach: r.viewer_in_reach === true },
    ]),
  );
}

function toOrgUnit(
  row: UnitRow,
  counts: { members: number; leads: number } | undefined,
  viewerCan: Permission[],
  reach: UnitReach | undefined,
) {
  return OrgUnit.parse({
    id: row.id,
    parentId: row.parentId,
    kind: row.kind,
    name: row.name,
    path: row.path,
    memberCount: counts?.members ?? 0,
    leadCount: counts?.leads ?? 0,
    viewerCan,
    handle: row.handle,
    reach: reach?.reach ?? 0,
    viewerInReach: reach?.viewerInReach ?? false,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  });
}

/** One unit as the API returns it, decided for the request's principal. */
export async function unitView(req: FastifyRequest, tx: Tx, perms: PermissionService, row: UnitRow) {
  const counts = await unitCounts(tx, row.id);
  const reach = await unitReach(tx, req.auth?.userId ?? null, [row.id]);
  const viewerCan = await perms.viewerCan(req, tx, unitResource(row), UNIT_VIEWER_PERMISSIONS);
  return toOrgUnit(row, counts.get(row.id), viewerCan, reach.get(row.id));
}

/** Durable `units.updated` on `org:<id>` (the web refetches the tree and `/me/permissions`). */
export async function unitsChanged(core: Core, tx: Tx, unitId: string, action: string): Promise<void> {
  await core.realtime.appendEvent(tx, orgTopic(tenantOf(tx).organizationId), EventTypes.unitsUpdated, {
    unitId,
    action,
  });
}

/**
 * The one unit-creation path (POST /units and, Phase 07.9, POST /work-projects): under the per-organization lock, the
 * parent is (re-)read inside the tenant, the kind rule is checked, the row gets a uuidv7 id and its materialised path,
 * and the `unit.created` audit and `units.updated` event go out in the same transaction. A project also gets its
 * creator (D-13, `addProjectCreator`), whichever route created it. The caller decides who may create first
 * (`unit.manage`, or `work_project.manage` on the parent); this helper never decides.
 */
export async function createUnit(
  core: Core,
  tx: Tx,
  input: { kind: UnitKind; name: string; parentId: string | null; createdBy: string | null },
): Promise<UnitRow> {
  const { kind, name, parentId, createdBy } = input;
  await lockUnits(tx);
  const parent = parentId ? await requireUnit(tx, parentId) : null;
  if (!validateParentKind(kind, parent?.kind ?? null)) {
    throw badRequest(
      parent ? `A ${kind} cannot be placed under a ${parent.kind}` : `A ${kind} cannot be top level`,
      "invalid_parent_kind",
    );
  }
  const idRes = await tx.execute(sql`select uuidv7() as id`);
  const id = String((idRes.rows[0] as { id: string }).id);
  const { organizationId } = tenantOf(tx);
  // D-14: generated once, here, under the lock; renames and moves never touch it.
  const handle = await allocateUnitHandle(tx, organizationId, name);
  let row: UnitRow | undefined;
  try {
    [row] = await tx
      .insert(orgUnits)
      .values({
        id,
        organizationId,
        parentId: parent?.id ?? null,
        kind,
        name,
        path: [...(parent?.path ?? []), id],
        createdBy,
        handle,
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err) && constraintOf(err) === "org_units_sibling_name_uq") throw nameTaken(name);
    // WR-05: a handle taken by a writer outside the unit lock (a raw insert, an N-1 writer): try again, never a 500.
    if (isUniqueViolation(err) && constraintOf(err) === "org_units_handle_uq") {
      throw conflict("That team's handle was just taken; try again", "unit_handle_taken");
    }
    throw err;
  }
  if (!row) throw new Error("unit insert returned no row");
  await core.audit.record(tx, {
    action: "unit.created",
    resourceType: "org_unit",
    resourceId: id,
    metadata: { name, kind, parentId: parent?.id ?? null },
  });
  if (kind === "project" && createdBy) await addProjectCreator(core, tx, id, createdBy);
  await unitsChanged(core, tx, id, "created");
  return row;
}

/**
 * D-13 (Phase 07.9): the creator of a project joins it, as its lead when their org role may lead (`LEAD_ORG_ROLES`),
 * otherwise as a member (a delegated allow rule), so "only Lead or Admin roles lead" always holds. The documented
 * auto-lead: no `unit.manage` check, because the caller already holds the right to create under the parent. Audited
 * as `unit_membership.added` with ids only, in the creation's transaction.
 */
async function addProjectCreator(core: Core, tx: Tx, unitId: string, userId: string): Promise<void> {
  const member = await memberRow(tx, userId);
  const role = member && LEAD_ORG_ROLES.includes(member.role) ? UnitRole.enum.lead : UnitRole.enum.member;
  await tx.insert(unitMemberships).values({
    organizationId: tenantOf(tx).organizationId,
    unitId,
    userId,
    role,
    addedBy: userId,
  });
  await core.audit.record(tx, {
    action: "unit_membership.added",
    resourceType: "org_unit",
    resourceId: unitId,
    metadata: { unitId, userId, role },
  });
}

// ---------------------------------------------------------------- routes

export function registerUnitRoutes(
  app: App,
  core: Core,
  perms: PermissionService,
  deps: OrganizationDeps,
): void {
  const tags = ["organization"];
  const requireUser = core.identity.requireUser;

  app.get(
    "/units",
    {
      config: { authz: "user" },
      preHandler: [requireUser, perms.requirePermission("unit.read")],
      schema: { tags, response: { 200: OrgUnitList } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        // Seq first: a change committed after this read is replayed, never missed.
        const lastSeq = await core.realtime.lastSeq(tx, orgTopic(tenantOf(tx).organizationId));
        const rows = await tx.select().from(orgUnits).orderBy(asc(orgUnits.createdAt), asc(orgUnits.id));
        const counts = await unitCounts(tx);
        const reach = await unitReach(tx, req.auth?.userId ?? null);
        const units = [];
        for (const row of rows) {
          const viewerCan = await perms.viewerCan(req, tx, unitResource(row), UNIT_VIEWER_PERMISSIONS);
          units.push(toOrgUnit(row, counts.get(row.id), viewerCan, reach.get(row.id)));
        }
        return { units, lastSeq };
      }),
  );

  app.post(
    "/units",
    {
      config: { authz: "user" },
      preHandler: requireUser,
      schema: { tags, body: CreateUnitRequest, response: { 200: OrgUnit } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const { kind, name, parentId } = req.body;
        await lockUnits(tx);
        const parent = parentId ? await requireUnit(tx, parentId) : null;
        await perms.assertCan(req, tx, "unit.manage", parent ? unitResource(parent) : orgResource());
        const row = await createUnit(core, tx, { kind, name, parentId, createdBy: req.auth?.userId ?? null });
        return unitView(req, tx, perms, row);
      }),
  );

  app.post(
    "/units/:id/move",
    {
      config: { authz: "user" },
      preHandler: requireUser,
      schema: { tags, params: IdParams, body: MoveUnitRequest, response: { 200: OrgUnit } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        await lockUnits(tx);
        // Re-read inside the lock: a concurrent move committed before we got it is visible now.
        const unit = await requireUnit(tx, req.params.id);
        const target = req.body.parentId ? await requireUnit(tx, req.body.parentId) : null;
        await perms.assertCan(req, tx, "unit.manage", unitResource(unit));
        await perms.assertCan(req, tx, "unit.manage", target ? unitResource(target) : orgResource());
        if (target && (target.id === unit.id || target.path.includes(unit.id))) {
          throw conflict("A unit cannot be moved inside itself", "unit_cycle");
        }
        if (!validateParentKind(unit.kind, target?.kind ?? null)) {
          throw badRequest(
            target
              ? `A ${unit.kind} cannot be placed under a ${target.kind}`
              : `A ${unit.kind} cannot be top level`,
            "invalid_parent_kind",
          );
        }
        const fromParentId = unit.parentId;
        const toParentId = target?.id ?? null;
        if (fromParentId === toParentId) return unitView(req, tx, perms, unit);

        try {
          await tx.execute(sql`
            update app.org_units
               set parent_id = case when id = ${unit.id}::uuid then ${toParentId}::uuid else parent_id end,
                   path = ${uuidArray(target?.path ?? [])} || path[array_position(path, ${unit.id}::uuid):],
                   updated_at = now()
             where path @> ${uuidArray([unit.id])}`);
        } catch (err) {
          if (isUniqueViolation(err)) throw nameTaken(unit.name);
          throw err;
        }
        await core.audit.record(tx, {
          action: "unit.moved",
          resourceType: "org_unit",
          resourceId: unit.id,
          metadata: { name: unit.name, kind: unit.kind, fromParentId, toParentId },
        });
        await unitsChanged(core, tx, unit.id, "moved");
        return unitView(req, tx, perms, await requireUnit(tx, unit.id));
      }),
  );

  app.patch(
    "/units/:id",
    {
      config: { authz: "user" },
      preHandler: requireUser,
      schema: { tags, params: IdParams, body: RenameUnitRequest, response: { 200: OrgUnit } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const unit = await requireUnit(tx, req.params.id);
        await perms.assertCan(req, tx, "unit.manage", unitResource(unit));
        const { name } = req.body;
        if (name === unit.name) return unitView(req, tx, perms, unit);
        let row: UnitRow | undefined;
        try {
          [row] = await tx
            .update(orgUnits)
            .set({ name, updatedAt: sql`now()` })
            .where(eq(orgUnits.id, unit.id))
            .returning();
        } catch (err) {
          if (isUniqueViolation(err)) throw nameTaken(name);
          throw err;
        }
        if (!row) throw new Error("unit update returned no row");
        await core.audit.record(tx, {
          action: "unit.renamed",
          resourceType: "org_unit",
          resourceId: unit.id,
          metadata: { kind: unit.kind, from: unit.name, to: name },
        });
        await unitsChanged(core, tx, unit.id, "renamed");
        return unitView(req, tx, perms, row);
      }),
  );

  app.delete(
    "/units/:id",
    {
      config: { authz: "user" },
      preHandler: requireUser,
      schema: { tags, params: IdParams, response: { 200: Ok } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        await lockUnits(tx);
        const unit = await requireUnit(tx, req.params.id);
        await perms.assertCan(req, tx, "unit.manage", unitResource(unit));
        // The unit row is locked before the checks below: a row that references it (a rule, a key, a template) and is
        // being inserted holds a KEY SHARE lock on it until its transaction ends, so the checks then see it committed
        // and answer 409 instead of a cascade without its audit or a foreign-key 500 (07.5, WINDOWS #207).
        await tx.execute(sql`select 1 from ${orgUnits} where ${orgUnits.id} = ${unit.id} for update`);
        const [child] = await tx
          .select({ id: orgUnits.id })
          .from(orgUnits)
          .where(eq(orgUnits.parentId, unit.id))
          .limit(1);
        if (child) throw conflict("Move or delete the units inside it first", "unit_has_children");
        // Phase 07.9 (D-01, UI-SPEC U-7): a team project's repository links hold it (RESTRICT): unlinking turns their
        // sessions personal and is decided and audited by its own route, never as a silent side effect of this one.
        const [repo] = await tx
          .select({ id: workProjectRepos.projectId })
          .from(workProjectRepos)
          .where(eq(workProjectRepos.unitId, unit.id))
          .limit(1);
        if (repo) throw conflict("Unlink this project's repositories first", "unit_has_repositories");
        // AGENT-01 (T-06-07-03): a unit persona never silently widens to the organization; it is moved or deleted
        // first. Checked before the RESTRICT foreign key would fire, so the caller gets a reason.
        const [bot] = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.unitId, unit.id), isNull(agents.deletedAt)))
          .limit(1);
        if (bot) throw conflict("Move or delete the bots of this unit first", "unit_has_bots");
        // MEM-01: the unit's memory scope cascades with the unit, so team memory is never dropped silently: any live
        // file blocks the delete, except a root file holding only the template (or nothing). The root can be edited
        // but never deleted, so its content decides, not its version (07.2-08). Soft-deleted files and pending
        // proposals do not block: they cascade with the scope; the ids-only audit rows stay. Read directly: the
        // memory module sits above this one.
        const [memory] = await tx
          .select({ id: memoryFiles.id })
          .from(memoryFiles)
          .innerJoin(memoryScopes, eq(memoryScopes.id, memoryFiles.scopeId))
          .where(
            and(
              eq(memoryScopes.kind, "unit"),
              eq(memoryScopes.unitId, unit.id),
              isNull(memoryFiles.deletedAt),
              sql`not (lower(${memoryFiles.path}) = ${memoryPathKey(MEMORY_ROOT_FILE)} and ${memoryFiles.content} in (${MEMORY_ROOT_TEMPLATE}, ''))`,
            ),
          )
          .limit(1);
        if (memory) throw conflict("Move or delete this unit's memory files first", "unit_has_memory");
        // Phase 07.4: a unit key and a live agent template hold the unit (RESTRICT foreign keys), so the caller gets a
        // reason instead of the database's refusal. Keys are deleted in Settings › Keychain, templates archived on the
        // Bots page; archived templates go with the unit below (an agent started from one keeps its own copy).
        const [key] = await tx
          .select({ id: vaultItems.id })
          .from(vaultItems)
          .where(eq(vaultItems.unitId, unit.id))
          .limit(1);
        if (key) throw conflict("Delete this unit's keys first", "unit_has_keys");
        const [liveTemplate] = await tx
          .select({ id: agentTemplates.id })
          .from(agentTemplates)
          .where(and(eq(agentTemplates.unitId, unit.id), isNull(agentTemplates.archivedAt)))
          .limit(1);
        if (liveTemplate) throw conflict("Archive this unit's agent templates first", "unit_has_templates");
        // Phase 07.5: a unit's approval rules would cascade with it, with no `tool_approval_policy.deleted` audit
        // (principle 12) and their history unreachable. They are removed in Settings › Approval policies first.
        const [policy] = await tx
          .select({ id: toolApprovalPolicies.id })
          .from(toolApprovalPolicies)
          .where(eq(toolApprovalPolicies.scopeUnitId, unit.id))
          .limit(1);
        if (policy) throw conflict("Remove this unit's approval rules first", "unit_has_policies");
        // Pending proposals into the unit's memory cascade with its scope: their approvals close as failed
        // `scope_gone` right after the delete (cards updated live, closure audited; WINDOWS 144). Read directly, like
        // the memory check above.
        const goneApprovals = (
          await tx
            .select({ id: approvalRequests.id })
            .from(approvalRequests)
            .innerJoin(memoryProposals, eq(memoryProposals.id, approvalRequests.resourceId))
            .innerJoin(memoryScopes, eq(memoryScopes.id, memoryProposals.scopeId))
            .where(
              and(
                eq(approvalRequests.resourceType, "memory_proposal"),
                eq(approvalRequests.status, "pending"),
                eq(memoryScopes.kind, "unit"),
                eq(memoryScopes.unitId, unit.id),
              ),
            )
        ).map((r) => r.id);
        // Deleted personas keep their history, not their unit: release the reference.
        await tx
          .update(agents)
          .set({ unitId: null })
          .where(and(eq(agents.unitId, unit.id), isNotNull(agents.deletedAt)));
        // Memberships and scoped rules cascade with the unit: record exactly what goes with it.
        const removedMemberIds = (
          await tx
            .select({ userId: unitMemberships.userId })
            .from(unitMemberships)
            .where(eq(unitMemberships.unitId, unit.id))
        ).map((r) => r.userId);
        const removedRuleIds = (
          await tx
            .select({ id: permissionRules.id })
            .from(permissionRules)
            .where(eq(permissionRules.scopeUnitId, unit.id))
        ).map((r) => r.id);
        // Phase 07.9: the team projects this team or department was assigned to lose it with the unit (cascade).
        const unassignedFromProjectIds = (
          await tx
            .select({ id: workProjectTeams.projectUnitId })
            .from(workProjectTeams)
            .where(eq(workProjectTeams.teamUnitId, unit.id))
        ).map((r) => r.id);
        // Archived templates of the unit: removed with it (versions cascade; agents.template_id is set null).
        const removedTemplateIds = (
          await tx
            .delete(agentTemplates)
            .where(eq(agentTemplates.unitId, unit.id))
            .returning({ id: agentTemplates.id })
        ).map((r) => r.id);
        try {
          await tx.delete(orgUnits).where(eq(orgUnits.id, unit.id));
        } catch (err) {
          // Defence in depth: the row lock above makes the check see every committed link.
          if (constraintOf(err) === "work_project_repos_unit_fk") {
            throw conflict("Unlink this project's repositories first", "unit_has_repositories");
          }
          throw err;
        }
        await deps.approvals.closeGone(tx, { ids: goneApprovals });
        await core.audit.record(tx, {
          action: "unit.deleted",
          resourceType: "org_unit",
          resourceId: unit.id,
          metadata: {
            name: unit.name,
            kind: unit.kind,
            parentId: unit.parentId,
            removedMemberIds,
            removedRuleIds,
            ...(removedTemplateIds.length > 0 ? { removedTemplateIds } : {}),
            ...(unassignedFromProjectIds.length > 0 ? { unassignedFromProjectIds } : {}),
          },
        });
        await unitsChanged(core, tx, unit.id, "deleted");
        for (const projectUnitId of unassignedFromProjectIds) {
          await core.realtime.appendEvent(
            tx,
            orgTopic(tenantOf(tx).organizationId),
            EventTypes.workProjectUpdated,
            { unitId: projectUnitId },
          );
        }
        for (const ruleId of removedRuleIds) {
          await core.realtime.appendEvent(
            tx,
            orgTopic(tenantOf(tx).organizationId),
            EventTypes.permissionRulesUpdated,
            { ruleId, action: "deleted" },
          );
        }
        return { ok: true as const };
      }),
  );

  // ---------------------------------------------------------------- unit memberships (ORG-02)

  app.get(
    "/units/:id/members",
    {
      config: { authz: "user" },
      preHandler: requireUser,
      schema: { tags, params: IdParams, response: { 200: UnitMemberList } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const unit = await requireUnit(tx, req.params.id);
        await perms.assertCan(req, tx, "unit.read", unitResource(unit));
        const rows = await tx
          .select({
            userId: unitMemberships.userId,
            role: unitMemberships.role,
            addedAt: unitMemberships.createdAt,
            displayName: orgMembers.displayName,
            avatarUrl: orgMembers.avatarUrl,
            orgRole: orgMembers.role,
            deactivatedAt: orgMembers.deactivatedAt,
          })
          .from(unitMemberships)
          .innerJoin(orgMembers, eq(orgMembers.userId, unitMemberships.userId))
          .where(eq(unitMemberships.unitId, unit.id))
          .orderBy(asc(orgMembers.displayName));
        return { members: rows.map(toUnitMember) };
      }),
  );

  app.post(
    "/units/:id/members",
    {
      config: { authz: "user" },
      preHandler: requireUser,
      schema: { tags, params: IdParams, body: AddUnitMemberRequest, response: { 200: UnitMember } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const unit = await requireUnit(tx, req.params.id);
        await perms.assertCan(req, tx, "unit.members.manage", unitResource(unit));
        const { userId, role } = req.body;
        const target = await activeMember(tx, userId);
        if (isLeadMembership(role)) await assertCanAppointLead(req, tx, perms, unit, target.role);
        const [row] = await tx
          .insert(unitMemberships)
          .values({
            organizationId: tenantOf(tx).organizationId,
            unitId: unit.id,
            userId,
            role,
            addedBy: req.auth?.userId ?? null,
          })
          .onConflictDoNothing()
          .returning();
        if (!row) throw conflict("Already a member of this unit", "already_member");
        await core.audit.record(tx, {
          action: "unit_membership.added",
          resourceType: "org_unit",
          resourceId: unit.id,
          metadata: { unitId: unit.id, userId, role },
        });
        await unitsChanged(core, tx, unit.id, "members");
        return toUnitMember({
          userId,
          role: row.role,
          addedAt: row.createdAt,
          displayName: target.displayName,
          avatarUrl: target.avatarUrl,
          orgRole: target.role,
          deactivatedAt: target.deactivatedAt,
        });
      }),
  );

  app.patch(
    "/units/:id/members/:userId",
    {
      config: { authz: "user" },
      preHandler: requireUser,
      schema: {
        tags,
        params: UnitMemberParams,
        body: UpdateUnitMemberRequest,
        response: { 200: UnitMember },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const unit = await requireUnit(tx, req.params.id);
        await perms.assertCan(req, tx, "unit.manage", unitResource(unit));
        const { userId } = req.params;
        const membership = await loadUnitMembership(tx, unit.id, userId);
        const { role } = req.body;
        const target = await memberRow(tx, userId);
        if (!target) throw badRequest("Not a member of this organization", "unknown_member");
        if (isLeadMembership(role)) await assertCanAppointLead(req, tx, perms, unit, target.role);
        if (role !== membership.role) {
          await tx
            .update(unitMemberships)
            .set({ role })
            .where(and(eq(unitMemberships.unitId, unit.id), eq(unitMemberships.userId, userId)));
          await core.audit.record(tx, {
            action: "unit_membership.role_changed",
            resourceType: "org_unit",
            resourceId: unit.id,
            metadata: { unitId: unit.id, userId, from: membership.role, to: role },
          });
          await unitsChanged(core, tx, unit.id, "members");
        }
        return toUnitMember({
          userId,
          role,
          addedAt: membership.createdAt,
          displayName: target.displayName,
          avatarUrl: target.avatarUrl,
          orgRole: target.role,
          deactivatedAt: target.deactivatedAt,
        });
      }),
  );

  app.delete(
    "/units/:id/members/:userId",
    {
      config: { authz: "user" },
      preHandler: requireUser,
      schema: { tags, params: UnitMemberParams, response: { 200: Ok } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const unit = await requireUnit(tx, req.params.id);
        await perms.assertCan(req, tx, "unit.members.manage", unitResource(unit));
        const { userId } = req.params;
        const membership = await loadUnitMembership(tx, unit.id, userId);
        // Removing a lead takes away lead authority: the same decision as appointing one (T-02-06-03).
        if (isLeadMembership(membership.role)) {
          await perms.assertCan(req, tx, "unit.manage", unitResource(unit));
        }
        await tx
          .delete(unitMemberships)
          .where(and(eq(unitMemberships.unitId, unit.id), eq(unitMemberships.userId, userId)));
        await core.audit.record(tx, {
          action: "unit_membership.removed",
          resourceType: "org_unit",
          resourceId: unit.id,
          metadata: { unitId: unit.id, userId, role: membership.role },
        });
        await unitsChanged(core, tx, unit.id, "members");
        return { ok: true as const };
      }),
  );
}

// ---------------------------------------------------------------- membership helpers

/**
 * A unit-membership role value (data), not an authorization check: the decision itself is always the
 * resolver's (`assertCanAppointLead`, `unit.manage`).
 */
const isLeadMembership = (unitRole: UnitRole) => unitRole === UnitRole.enum.lead;

/** Org roles that may lead a unit (D-06): an eligibility rule on the target, not on the caller. */
export const LEAD_ORG_ROLES: readonly OrgRole[] = ["lead", "admin"];

async function memberRow(tx: Tx, userId: string) {
  const [row] = await tx.select().from(orgMembers).where(eq(orgMembers.userId, userId)).limit(1);
  return row ?? null;
}

/** 400 `unknown_member` unless `userId` is an active member of this organization (RLS scopes the read). */
async function activeMember(tx: Tx, userId: string) {
  const row = await memberRow(tx, userId);
  if (!row || row.deactivatedAt !== null) {
    throw badRequest("Not an active member of this organization", "unknown_member");
  }
  return row;
}

async function loadUnitMembership(tx: Tx, unitId: string, userId: string) {
  const [row] = await tx
    .select()
    .from(unitMemberships)
    .where(and(eq(unitMemberships.unitId, unitId), eq(unitMemberships.userId, userId)))
    .limit(1);
  if (!row) throw notFound("Not a member of this unit", "not_a_unit_member");
  return row;
}

/** Appointing a lead is a structural decision (unit.manage) and only lead/admin org roles can lead. */
async function assertCanAppointLead(
  req: FastifyRequest,
  tx: Tx,
  perms: PermissionService,
  unit: UnitRow,
  targetOrgRole: OrgRole,
): Promise<void> {
  await perms.assertCan(req, tx, "unit.manage", unitResource(unit));
  if (!LEAD_ORG_ROLES.includes(targetOrgRole)) {
    throw badRequest("Only members whose role is Lead or Admin can lead a unit", "lead_requires_role");
  }
}

function toUnitMember(r: {
  userId: string;
  role: UnitRole;
  addedAt: Date | string;
  displayName: string;
  avatarUrl: string | null;
  orgRole: OrgRole;
  deactivatedAt: Date | string | null;
}) {
  return {
    userId: r.userId,
    displayName: r.displayName,
    avatarUrl: r.avatarUrl,
    orgRole: r.orgRole,
    role: r.role,
    status: r.deactivatedAt ? ("deactivated" as const) : ("active" as const),
    addedAt: new Date(r.addedAt).toISOString(),
  };
}

const nameTaken = (name: string) => conflict(`A sibling unit is already named "${name}"`, "unit_name_taken");
