import {
  CreateWorkProjectRequest,
  WorkProjectDetail,
  type WorkProjectPerson,
  type WorkProjectRepo,
  type WorkProjectTeam,
} from "@ocw/contracts";
import {
  devices,
  orgMembers,
  orgUnits,
  projects,
  type Tx,
  tenantOf,
  unitMemberships,
  workProjectRepos,
  workProjectSettings,
  workProjectTeams,
} from "@ocw/db";
import { asc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type App, authOf, type Core, tenant } from "../../core";
import { notFound } from "../../lib/errors";
import {
  createUnit,
  type PermissionService,
  type ResourceFacts,
  requireUnit,
  type UnitRow,
  unitResource,
  uuidArray,
  workProjectResource,
} from "../organization";

/**
 * Team projects (Phase 07.9, D-01, D-02, D-03, D-10, D-13; ADR-0024): an org unit of kind `project` with direct
 * members (unit memberships), assigned teams, linked device repositories and one default audience for new sessions.
 * Who opens one is the resolver's `work_project` precondition over `app.work_project_access` (the one SQL rule, P-03);
 * who shapes one is `work_project.manage` on its parent (create, teams) or on the project (default, repositories).
 * Every change is audited with ids only and announced as `work_project.updated { unitId }` on `org:<id>`.
 */

const ProjectParams = z.object({ unitId: z.uuid() });

/** The project's people the detail shows as avatars (WORK_PROJECT_LIMITS.accessPeople). */
const ACCESS_PEOPLE = 5;

/** Unit roles allowed to lead (the eligibility rule of `POST /units/:id/members`, D-06). */
const LEAD_ORG_ROLES = new Set(["lead", "admin"]);

type ProjectUnit = Pick<UnitRow, "id" | "name" | "path" | "parentId">;

/** A team project and the caller's access to it (one query); null when the id is not a project of the tenant. */
async function loadProject(
  tx: Tx,
  userId: string,
  unitId: string,
): Promise<{ unit: ProjectUnit; facts: ResourceFacts } | null> {
  const [row] = await tx
    .select({
      id: orgUnits.id,
      name: orgUnits.name,
      path: orgUnits.path,
      parentId: orgUnits.parentId,
      kind: orgUnits.kind,
      access: sql<string | null>`app.work_project_access(${orgUnits.id}, ${userId}::uuid)`,
    })
    .from(orgUnits)
    .where(eq(orgUnits.id, unitId))
    .limit(1);
  if (row?.kind !== "project") return null;
  const unit = { id: row.id, name: row.name, path: row.path, parentId: row.parentId };
  return { unit, facts: workProjectResource({ id: row.id, path: row.path, access: row.access }, userId) };
}

/**
 * The resolver facts of a team project for one person: its unit path and `project_member` from
 * `app.work_project_access(unit, user)` (definer, scoped to the tenant). The only way to build a `work_project`
 * resource from the database.
 */
export async function projectFacts(
  tx: Tx,
  userId: string,
  unit: { id: string; path: readonly string[] },
): Promise<ResourceFacts> {
  const res = await tx.execute(
    sql`select app.work_project_access(${unit.id}::uuid, ${userId}::uuid) as access`,
  );
  const access = (res.rows[0] as { access: string | null } | undefined)?.access ?? null;
  return workProjectResource({ id: unit.id, path: unit.path, access }, userId);
}

/** The parent unit of a project as a resource (create and team assignment are decided there). */
const parentResource = (unit: ProjectUnit) =>
  unitResource({ id: unit.parentId ?? unit.id, path: unit.path.slice(0, -1) });

// ---------------------------------------------------------------- read models

/** Names of the units on `path` minus its last entry, root first ("Engineering › Web"). */
async function trailOf(tx: Tx, path: readonly string[]): Promise<string[]> {
  const ancestors = path.slice(0, -1);
  if (ancestors.length === 0) return [];
  const rows = await tx
    .select({ id: orgUnits.id, name: orgUnits.name })
    .from(orgUnits)
    .where(inArray(orgUnits.id, ancestors));
  const names = new Map(rows.map((r) => [r.id, r.name]));
  return ancestors.flatMap((id) => {
    const name = names.get(id);
    return name === undefined ? [] : [name];
  });
}

/** Active people with access to the project (`app.work_project_people`: members ∪ team members, never admins). */
async function projectPeople(tx: Tx, unitId: string): Promise<WorkProjectPerson[]> {
  const res = await tx.execute(sql`
    select p.user_id, m.display_name, m.avatar_url
      from app.work_project_people(${unitId}::uuid) p
      join app.org_members m on m.user_id = p.user_id
     order by lower(m.display_name), p.user_id`);
  return (res.rows as Array<{ user_id: string; display_name: string; avatar_url: string | null }>).map(
    (r) => ({
      userId: r.user_id,
      name: r.display_name,
      avatarUrl: r.avatar_url,
    }),
  );
}

/** Active members of each unit's subtree (a department counts its teams' people too). */
async function subtreeMemberCounts(tx: Tx, unitIds: readonly string[]): Promise<Map<string, number>> {
  if (unitIds.length === 0) return new Map();
  const res = await tx.execute(sql`
    select t.id, (
      select count(distinct um.user_id)::int
        from app.unit_memberships um
        join app.org_units ou on ou.id = um.unit_id
        join app.org_members m on m.user_id = um.user_id and m.deactivated_at is null
       where t.id = any (ou.path)
    ) as n
      from unnest(${uuidArray(unitIds)}) as t(id)`);
  return new Map((res.rows as Array<{ id: string; n: number }>).map((r) => [r.id, Number(r.n)]));
}

async function assignedTeams(tx: Tx, unitId: string): Promise<WorkProjectTeam[]> {
  const rows = await tx
    .select({ id: orgUnits.id, name: orgUnits.name, kind: orgUnits.kind })
    .from(workProjectTeams)
    .innerJoin(orgUnits, eq(orgUnits.id, workProjectTeams.teamUnitId))
    .where(eq(workProjectTeams.projectUnitId, unitId))
    .orderBy(asc(sql`lower(${orgUnits.name})`), asc(orgUnits.id));
  const counts = await subtreeMemberCounts(
    tx,
    rows.map((r) => r.id),
  );
  return rows.flatMap((r) =>
    r.kind === "project"
      ? []
      : [{ id: r.id, name: r.name, kind: r.kind, memberCount: counts.get(r.id) ?? 0 }],
  );
}

async function linkedRepos(tx: Tx, unitId: string): Promise<WorkProjectRepo[]> {
  const rows = await tx
    .select({ p: projects, d: devices })
    .from(workProjectRepos)
    .innerJoin(projects, eq(projects.id, workProjectRepos.projectId))
    .innerJoin(devices, eq(devices.id, workProjectRepos.deviceId))
    .where(eq(workProjectRepos.unitId, unitId))
    .orderBy(asc(sql`lower(${projects.name})`), asc(projects.id));
  return rows.map(({ p, d }) => ({
    projectId: p.id,
    name: p.name,
    deviceId: d.id,
    deviceName: d.name,
    deviceOnline: d.status === "online" && d.revokedAt === null,
    branch: p.defaultBranch,
    available: p.removedAt === null && d.revokedAt === null,
  }));
}

/** `default_visibility`, or `project` when the project has no settings row (D-03: on by default). */
async function defaultVisibilityOf(tx: Tx, unitId: string): Promise<"project" | "owner"> {
  const [row] = await tx
    .select({ v: workProjectSettings.defaultVisibility })
    .from(workProjectSettings)
    .where(eq(workProjectSettings.unitId, unitId))
    .limit(1);
  return row?.v ?? "project";
}

/** The project page's model, decided for the request's principal (`viewerCan` gates the UI only). */
async function projectDetail(
  req: FastifyRequest,
  tx: Tx,
  perms: PermissionService,
  project: { unit: ProjectUnit; facts: ResourceFacts },
): Promise<WorkProjectDetail> {
  const { unit, facts } = project;
  if (unit.parentId === null) throw new Error("a team project always has a parent unit (D-13)");
  const people = await projectPeople(tx, unit.id);
  const manage = await perms.can(req, tx, "work_project.manage", facts);
  const assignTeams = await perms.can(req, tx, "work_project.manage", parentResource(unit));
  const members = await perms.can(req, tx, "unit.members.manage", unitResource(unit));
  return WorkProjectDetail.parse({
    id: unit.id,
    name: unit.name,
    parentId: unit.parentId,
    trail: await trailOf(tx, unit.path),
    defaultVisibility: await defaultVisibilityOf(tx, unit.id),
    access: { count: people.length, people: people.slice(0, ACCESS_PEOPLE) },
    teams: await assignedTeams(tx, unit.id),
    repos: await linkedRepos(tx, unit.id),
    viewerCan: { manage, assignTeams, members },
  });
}

// ---------------------------------------------------------------- routes

export function registerProjectRoutes(app: App, core: Core, perms: PermissionService): void {
  const tags = ["work-session"];
  const requireUser = core.identity.requireUser;
  const user = { config: { authz: "user" as const }, preHandler: requireUser };

  app.post(
    "/work-projects",
    { ...user, schema: { tags, body: CreateWorkProjectRequest, response: { 200: WorkProjectDetail } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const { userId } = authOf(req);
        const { name, parentId } = req.body;
        // D-10, P-11: admins and the leads of the parent's subtree; the kind rule (team or department, D-13) is
        // checked by `createUnit` once the caller may act there.
        const parent = await requireUnit(tx, parentId);
        await perms.assertCan(req, tx, "work_project.manage", unitResource(parent));
        const unit = await createUnit(core, tx, { kind: "project", name, parentId, createdBy: userId });
        // D-13: the creator becomes the project's lead. The documented auto-lead (no `unit.manage` check): the creator
        // holds `work_project.manage` on the parent. A creator whose role cannot lead (a delegated allow rule) joins as
        // a member, so the "only Lead or Admin roles lead" rule always holds.
        const [me] = await tx
          .select({ role: orgMembers.role })
          .from(orgMembers)
          .where(eq(orgMembers.userId, userId))
          .limit(1);
        const role = me && LEAD_ORG_ROLES.has(me.role) ? ("lead" as const) : ("member" as const);
        await tx.insert(unitMemberships).values({
          organizationId: tenantOf(tx).organizationId,
          unitId: unit.id,
          userId,
          role,
          addedBy: userId,
        });
        await core.audit.record(tx, {
          action: "unit_membership.added",
          resourceType: "org_unit",
          resourceId: unit.id,
          metadata: { unitId: unit.id, userId, role },
        });
        const project = await loadProject(tx, userId, unit.id);
        if (!project) throw new Error("created project not found");
        return projectDetail(req, tx, perms, project);
      }),
  );

  app.get(
    "/work-projects/:unitId",
    { ...user, schema: { tags, params: ProjectParams, response: { 200: WorkProjectDetail } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const project = await loadProject(tx, authOf(req).userId, req.params.unitId);
        // Unknown ids, other kinds and projects the caller cannot open answer the same 404 (T-07.9-04-03).
        if (!project) throw notFound();
        await perms.assertCan(req, tx, "work_session.read", project.facts, { hideAs404: true });
        return projectDetail(req, tx, perms, project);
      }),
  );
}
