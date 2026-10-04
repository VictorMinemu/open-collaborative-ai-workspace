import {
  AddUnitMemberRequest,
  ALLOWED_PARENT_KINDS,
  CreateUnitRequest,
  EventTypes,
  IdParams,
  MoveUnitRequest,
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
import { orgMembers, orgUnits, permissionRules, type Tx, tenantOf, unitMemberships } from "@ocw/db";
import { and, asc, eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { type App, type Core, tenant } from "../../core";
import { badRequest, conflict, notFound } from "../../lib/errors";
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

// ---------------------------------------------------------------- data access

type UnitRow = typeof orgUnits.$inferSelect;

/** The permissions a unit row reports in `viewerCan` (the web renders these, never re-implements policy). */
const UNIT_VIEWER_PERMISSIONS: readonly Permission[] = ["unit.manage", "unit.members.manage"];

export const orgTopic = (organizationId: string) => `org:${organizationId}`;

/** A Postgres `uuid[]` literal from validated ids (drizzle would expand a JS array into a value list). */
export const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(",")}}`}::uuid[]`;

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

function toOrgUnit(
  row: UnitRow,
  counts: { members: number; leads: number } | undefined,
  viewerCan: Permission[],
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
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  });
}

/** One unit as the API returns it, decided for the request's principal. */
export async function unitView(req: FastifyRequest, tx: Tx, perms: PermissionService, row: UnitRow) {
  const counts = await unitCounts(tx, row.id);
  const viewerCan = await perms.viewerCan(req, tx, unitResource(row), UNIT_VIEWER_PERMISSIONS);
  return toOrgUnit(row, counts.get(row.id), viewerCan);
}

/** Durable `units.updated` on `org:<id>` (the web refetches the tree and `/me/permissions`). */
export async function unitsChanged(core: Core, tx: Tx, unitId: string, action: string): Promise<void> {
  await core.realtime.appendEvent(tx, orgTopic(tenantOf(tx).organizationId), EventTypes.unitsUpdated, {
    unitId,
    action,
  });
}

// ---------------------------------------------------------------- routes

export function registerUnitRoutes(app: App, core: Core, perms: PermissionService): void {
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
        const units = [];
        for (const row of rows) {
          const viewerCan = await perms.viewerCan(req, tx, unitResource(row), UNIT_VIEWER_PERMISSIONS);
          units.push(toOrgUnit(row, counts.get(row.id), viewerCan));
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
        if (!validateParentKind(kind, parent?.kind ?? null)) {
          throw badRequest(
            parent ? `A ${kind} cannot be placed under a ${parent.kind}` : `A ${kind} cannot be top level`,
            "invalid_parent_kind",
          );
        }
        const idRes = await tx.execute(sql`select uuidv7() as id`);
        const id = String((idRes.rows[0] as { id: string }).id);
        let row: UnitRow | undefined;
        try {
          [row] = await tx
            .insert(orgUnits)
            .values({
              id,
              organizationId: tenantOf(tx).organizationId,
              parentId: parent?.id ?? null,
              kind,
              name,
              path: [...(parent?.path ?? []), id],
              createdBy: req.auth?.userId ?? null,
            })
            .returning();
        } catch (err) {
          if (isUniqueViolation(err)) throw nameTaken(name);
          throw err;
        }
        if (!row) throw new Error("unit insert returned no row");
        await core.audit.record(tx, {
          action: "unit.created",
          resourceType: "org_unit",
          resourceId: id,
          metadata: { name, kind, parentId: parent?.id ?? null },
        });
        await unitsChanged(core, tx, id, "created");
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
        const [child] = await tx
          .select({ id: orgUnits.id })
          .from(orgUnits)
          .where(eq(orgUnits.parentId, unit.id))
          .limit(1);
        if (child) throw conflict("Move or delete the units inside it first", "unit_has_children");
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
        await tx.delete(orgUnits).where(eq(orgUnits.id, unit.id));
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
          },
        });
        await unitsChanged(core, tx, unit.id, "deleted");
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
const LEAD_ORG_ROLES: readonly OrgRole[] = ["lead", "admin"];

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
