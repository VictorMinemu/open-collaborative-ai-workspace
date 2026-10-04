import {
  ALLOWED_PARENT_KINDS,
  CreateUnitRequest,
  EventTypes,
  IdParams,
  MoveUnitRequest,
  OrgUnit,
  OrgUnitList,
  type Permission,
  type UnitKind,
} from "@ocw/contracts";
import { orgUnits, type Tx, tenantOf, unitMemberships } from "@ocw/db";
import { asc, eq, sql } from "drizzle-orm";
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
}

const nameTaken = (name: string) => conflict(`A sibling unit is already named "${name}"`, "unit_name_taken");
