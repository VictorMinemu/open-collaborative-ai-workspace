import {
  AssignableTeams,
  AssignWorkProjectTeamRequest,
  CreateWorkProjectRequest,
  EventTypes,
  LinkableRepos,
  LinkWorkProjectRepoRequest,
  type Permission,
  RepoUnlinkImpact,
  UpdateWorkProjectRequest,
  WORK_PROJECT_LIMITS,
  WorkProjectDetail,
  WorkProjectIndex,
  WorkProjectParents,
  type WorkProjectPerson,
  type WorkProjectRepo,
  WorkProjectSearchQuery,
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
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type App, authOf, type Core, tenant } from "../../core";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { deviceFacts, loadDeviceAccess } from "../device";
import {
  createUnit,
  LEAD_ORG_ROLES,
  orgTopic,
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
const TeamParams = z.object({ unitId: z.uuid(), teamId: z.uuid() });
const RepoParams = z.object({ unitId: z.uuid(), projectId: z.uuid() });

/** Rows the assignable-teams search returns. */
const ASSIGNABLE_MAX = 50;

/** The Postgres error behind a driver or Drizzle error (`code`, constraint name). */
function pgError(err: unknown): { code?: string; constraint?: string } {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  return e?.cause?.code ? e.cause : { code: e?.code, constraint: e?.constraint };
}

const invalidTeamKind = () =>
  badRequest(
    "Only teams and departments, never a project, can be assigned to a project",
    "invalid_team_kind",
  );

/** The repository's link to this project (404 when it is linked elsewhere or not at all). */
async function requireLink(tx: Tx, unitId: string, projectId: string) {
  const [link] = await tx
    .select({ projectId: workProjectRepos.projectId, deviceId: workProjectRepos.deviceId })
    .from(workProjectRepos)
    .where(and(eq(workProjectRepos.projectId, projectId), eq(workProjectRepos.unitId, unitId)))
    .limit(1);
  if (!link) throw notFound("This repository is not linked to the project", "repo_not_linked");
  return link;
}

/**
 * Non-archived sessions on a repository, whatever the caller can see (UI-SPEC U-7): a definer count, a number only
 * (P-10).
 */
async function repoSessionCount(tx: Tx, projectId: string): Promise<number> {
  const res = await tx.execute(sql`select app.work_project_repo_session_count(${projectId}::uuid) as n`);
  return Number((res.rows[0] as { n: number | string }).n);
}

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

/**
 * The project for a write: 404 when it is not a team project of the tenant; a denied `permission` answers 404 too when
 * the caller cannot open the project (its existence never leaks), else 403 with the denial.
 */
async function projectFor(
  req: FastifyRequest,
  tx: Tx,
  perms: PermissionService,
  unitId: string,
  permission: Permission,
  on: "project" | "parent",
) {
  const project = await loadProject(tx, authOf(req).userId, unitId);
  if (!project) throw notFound();
  const resource = on === "project" ? project.facts : parentResource(project.unit);
  if (!(await perms.can(req, tx, permission, resource))) {
    const opens = await perms.can(req, tx, "work_session.read", project.facts);
    await perms.assertCan(req, tx, permission, resource, opens ? {} : { hideAs404: true });
  }
  return project;
}

/** Durable `work_project.updated` on `org:<id>`, ids only (D-08, T-07.9-04-06). */
async function projectChanged(core: Core, tx: Tx, unitId: string): Promise<void> {
  await core.realtime.appendEvent(tx, orgTopic(tenantOf(tx).organizationId), EventTypes.workProjectUpdated, {
    unitId,
  });
}

// ---------------------------------------------------------------- read models

/** Ancestor names (root first, without the unit itself) from one read of the organization's units. */
function trailFrom(units: ReadonlyArray<{ id: string; name: string }>) {
  const names = new Map(units.map((u) => [u.id, u.name]));
  return (path: readonly string[]) =>
    path.slice(0, -1).flatMap((id) => {
      const name = names.get(id);
      return name === undefined ? [] : [name];
    });
}

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

/**
 * Active members of each unit's subtree, the people an assigned team brings (a department counts its teams' people
 * too). D-14: never through a membership of a project nested under it, as `app.work_project_access`'s team branch.
 */
export async function subtreeMemberCounts(tx: Tx, unitIds: readonly string[]): Promise<Map<string, number>> {
  if (unitIds.length === 0) return new Map();
  const res = await tx.execute(sql`
    select t.id, (
      select count(distinct um.user_id)::int
        from app.unit_memberships um
        join app.org_units ou on ou.id = um.unit_id and ou.kind <> 'project'
        join app.org_members m on m.user_id = um.user_id and m.deactivated_at is null
       where t.id = any (ou.path)
    ) as n
      from unnest(${uuidArray(unitIds)}) as t(id)`);
  return new Map((res.rows as Array<{ id: string; n: number }>).map((r) => [r.id, Number(r.n)]));
}

/** The teams and departments assigned to a team project, with their subtree member counts (never a project). */
export async function assignedTeams(tx: Tx, unitId: string): Promise<WorkProjectTeam[]> {
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
export async function defaultVisibilityOf(tx: Tx, unitId: string): Promise<"project" | "owner"> {
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
    access: { count: people.length, people: people.slice(0, WORK_PROJECT_LIMITS.accessPeople) },
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

  app.get(
    "/work-projects",
    {
      config: { authz: "user" },
      // The page gate: the Work Zone (a standard role, or the module off, gets 403 as on `GET /projects`).
      preHandler: [requireUser, perms.requirePermission("work_session.read")],
      schema: { tags, response: { 200: WorkProjectIndex } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const { userId } = authOf(req);
        const units = await tx
          .select({ id: orgUnits.id, name: orgUnits.name, kind: orgUnits.kind, path: orgUnits.path })
          .from(orgUnits);
        const trail = trailFrom(units);
        const rows = await tx
          .select({
            id: orgUnits.id,
            name: orgUnits.name,
            path: orgUnits.path,
            access: sql<string | null>`app.work_project_access(${orgUnits.id}, ${userId}::uuid)`,
          })
          .from(orgUnits)
          .where(eq(orgUnits.kind, "project"))
          .orderBy(asc(sql`lower(${orgUnits.name})`), asc(orgUnits.id));
        // Only the projects the caller can open (D-02): the others are absent, never named (T-07.9-04-03).
        const open = await perms.filter(req, tx, rows, "work_session.read", (r) =>
          workProjectResource(r, userId),
        );
        const ids = open.map((r) => r.id);
        const people = new Map<string, number>();
        const repoCounts = new Map<string, number>();
        if (ids.length > 0) {
          const res = await tx.execute(sql`
            select t.id, (select count(*)::int from app.work_project_people(t.id)) as n
              from unnest(${uuidArray(ids)}) as t(id)`);
          for (const r of res.rows as Array<{ id: string; n: number }>) people.set(r.id, Number(r.n));
          const repos = await tx
            .select({ unitId: workProjectRepos.unitId, n: sql<number>`count(*)::int` })
            .from(workProjectRepos)
            .where(inArray(workProjectRepos.unitId, ids))
            .groupBy(workProjectRepos.unitId);
          for (const r of repos) repoCounts.set(r.unitId, Number(r.n));
        }
        // Usable repositories linked to no team project (`GET /projects`'s `device.use` filter).
        const unlinked = await tx
          .select({ p: projects, d: devices })
          .from(projects)
          .innerJoin(devices, eq(devices.id, projects.deviceId))
          .leftJoin(workProjectRepos, eq(workProjectRepos.projectId, projects.id))
          .where(
            and(isNull(devices.revokedAt), isNull(projects.removedAt), isNull(workProjectRepos.projectId)),
          )
          .orderBy(asc(sql`lower(${projects.name})`), asc(projects.id));
        const access = await loadDeviceAccess(tx, userId);
        const personal = await perms.filter(req, tx, unlinked, "device.use", ({ d }) =>
          deviceFacts(d, userId, access),
        );
        const parents = await perms.filter(
          req,
          tx,
          units.filter((u) => u.kind !== "project"),
          "work_project.manage",
          (u) => unitResource(u),
        );
        return {
          teamProjects: open.map((r) => ({
            id: r.id,
            name: r.name,
            trail: trail(r.path),
            peopleCount: people.get(r.id) ?? 0,
            repoCount: repoCounts.get(r.id) ?? 0,
          })),
          personalRepos: personal.map(({ p, d }) => ({
            projectId: p.id,
            name: p.name,
            deviceId: d.id,
            deviceName: d.name,
            deviceOnline: d.status === "online",
          })),
          viewerCan: { create: parents.length > 0 },
        };
      }),
  );

  app.get(
    "/work-projects/parents",
    { ...user, schema: { tags, response: { 200: WorkProjectParents } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const units = await tx
          .select({ id: orgUnits.id, name: orgUnits.name, kind: orgUnits.kind, path: orgUnits.path })
          .from(orgUnits);
        const trail = trailFrom(units);
        // D-10, D-13: the teams and departments where the caller may create (admins: all); never a project.
        const parents = await perms.filter(
          req,
          tx,
          units.filter((u) => u.kind !== "project"),
          "work_project.manage",
          (u) => unitResource(u),
        );
        // Sorted as the tree reads: by trail, then name (case-insensitive), then id.
        const label = (u: { name: string; trail: readonly string[] }) =>
          [...u.trail, u.name].join("\u0000").toLowerCase();
        const order = (a: { id: string; name: string; trail: string[] }, b: typeof a) => {
          const [la, lb] = [label(a), label(b)];
          if (la !== lb) return la < lb ? -1 : 1;
          return a.id < b.id ? -1 : 1;
        };
        return {
          parents: parents
            .flatMap((u) =>
              u.kind === "project" ? [] : [{ id: u.id, name: u.name, kind: u.kind, trail: trail(u.path) }],
            )
            .sort(order),
        };
      }),
  );

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
        const role = me && LEAD_ORG_ROLES.includes(me.role) ? ("lead" as const) : ("member" as const);
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

  app.patch(
    "/work-projects/:unitId",
    {
      ...user,
      schema: {
        tags,
        params: ProjectParams,
        body: UpdateWorkProjectRequest,
        response: { 200: WorkProjectDetail },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const { userId } = authOf(req);
        // D-03: the project's leads, leads above it and admins.
        const project = await projectFor(req, tx, perms, req.params.unitId, "work_project.manage", "project");
        const to = req.body.defaultVisibility;
        const from = await defaultVisibilityOf(tx, project.unit.id);
        if (from !== to) {
          await tx
            .insert(workProjectSettings)
            .values({
              organizationId: tenantOf(tx).organizationId,
              unitId: project.unit.id,
              defaultVisibility: to,
              updatedBy: userId,
            })
            .onConflictDoUpdate({
              target: workProjectSettings.unitId,
              set: { defaultVisibility: to, updatedBy: userId, updatedAt: sql`now()` },
            });
          await core.audit.record(tx, {
            action: "work_project.default_changed",
            resourceType: "org_unit",
            resourceId: project.unit.id,
            metadata: { from, to },
          });
          await projectChanged(core, tx, project.unit.id);
        }
        return projectDetail(req, tx, perms, project);
      }),
  );

  // ---------------------------------------------------------------- assigned teams (D-01, D-10)

  app.get(
    "/work-projects/:unitId/assignable-teams",
    {
      ...user,
      schema: {
        tags,
        params: ProjectParams,
        querystring: WorkProjectSearchQuery,
        response: { 200: AssignableTeams },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const project = await projectFor(req, tx, perms, req.params.unitId, "work_project.manage", "parent");
        const q = req.query.q?.toLowerCase() ?? "";
        const rows = await tx
          .select({ id: orgUnits.id, name: orgUnits.name, kind: orgUnits.kind })
          .from(orgUnits)
          .where(
            and(
              inArray(orgUnits.kind, ["team", "department"]),
              q === "" ? undefined : sql`position(${q} in lower(${orgUnits.name})) > 0`,
              sql`not exists (select 1 from app.work_project_teams t where t.project_unit_id = ${project.unit.id}::uuid and t.team_unit_id = ${orgUnits.id})`,
            ),
          )
          .orderBy(asc(sql`lower(${orgUnits.name})`), asc(orgUnits.id))
          .limit(ASSIGNABLE_MAX);
        const counts = await subtreeMemberCounts(
          tx,
          rows.map((r) => r.id),
        );
        return {
          teams: rows.flatMap((r) =>
            r.kind === "project"
              ? []
              : [{ id: r.id, name: r.name, kind: r.kind, memberCount: counts.get(r.id) ?? 0 }],
          ),
        };
      }),
  );

  app.post(
    "/work-projects/:unitId/teams",
    {
      ...user,
      schema: {
        tags,
        params: ProjectParams,
        body: AssignWorkProjectTeamRequest,
        response: { 200: WorkProjectDetail },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const { userId } = authOf(req);
        // D-10, P-11: admins and the leads of the parent's subtree, never a project lead alone.
        const project = await projectFor(req, tx, perms, req.params.unitId, "work_project.manage", "parent");
        // Loaded inside the tenant: a unit of another organization is simply not found (T-07.9-04-04).
        const team = await requireUnit(tx, req.body.unitId);
        if (team.kind === "project" || team.id === project.unit.id) throw invalidTeamKind();
        try {
          await tx.insert(workProjectTeams).values({
            organizationId: tenantOf(tx).organizationId,
            projectUnitId: project.unit.id,
            teamUnitId: team.id,
            assignedBy: userId,
          });
        } catch (err) {
          const { code, constraint } = pgError(err);
          if (code === "23505") throw conflict("This team is already assigned", "team_already_assigned");
          if (constraint === "work_project_teams_not_self_ck") throw invalidTeamKind();
          if (code === "23503") throw notFound("Unit not found", "unit_not_found");
          throw err;
        }
        await core.audit.record(tx, {
          action: "work_project.team_assigned",
          resourceType: "org_unit",
          resourceId: project.unit.id,
          metadata: { teamId: team.id },
        });
        await projectChanged(core, tx, project.unit.id);
        return projectDetail(req, tx, perms, project);
      }),
  );

  app.delete(
    "/work-projects/:unitId/teams/:teamId",
    { ...user, schema: { tags, params: TeamParams, response: { 200: WorkProjectDetail } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const project = await projectFor(req, tx, perms, req.params.unitId, "work_project.manage", "parent");
        const [removed] = await tx
          .delete(workProjectTeams)
          .where(
            and(
              eq(workProjectTeams.projectUnitId, project.unit.id),
              eq(workProjectTeams.teamUnitId, req.params.teamId),
            ),
          )
          .returning({ teamId: workProjectTeams.teamUnitId });
        if (!removed) throw notFound("This team is not assigned to the project", "team_not_assigned");
        await core.audit.record(tx, {
          action: "work_project.team_removed",
          resourceType: "org_unit",
          resourceId: project.unit.id,
          metadata: { teamId: removed.teamId },
        });
        await projectChanged(core, tx, project.unit.id);
        return projectDetail(req, tx, perms, project);
      }),
  );

  // ---------------------------------------------------------------- linked repositories (D-01, D-10)

  app.get(
    "/work-projects/:unitId/linkable-repos",
    { ...user, schema: { tags, params: ProjectParams, response: { 200: LinkableRepos } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const { userId } = authOf(req);
        await projectFor(req, tx, perms, req.params.unitId, "work_project.manage", "project");
        const rows = await tx
          .select({
            p: projects,
            d: devices,
            linkedId: workProjectRepos.unitId,
            linkedName: orgUnits.name,
            linkedPath: orgUnits.path,
            linkedAccess: sql<string | null>`case when ${workProjectRepos.unitId} is null then null
              else app.work_project_access(${workProjectRepos.unitId}, ${userId}::uuid) end`,
          })
          .from(projects)
          .innerJoin(devices, eq(devices.id, projects.deviceId))
          .leftJoin(workProjectRepos, eq(workProjectRepos.projectId, projects.id))
          .leftJoin(orgUnits, eq(orgUnits.id, workProjectRepos.unitId))
          .where(and(isNull(devices.revokedAt), isNull(projects.removedAt)))
          .orderBy(
            asc(sql`lower(${devices.name})`),
            asc(devices.id),
            asc(sql`lower(${projects.name})`),
            asc(projects.id),
          );
        // Repositories on devices the caller may use, as `GET /projects` decides them (D-10).
        const access = await loadDeviceAccess(tx, userId);
        const usable = await perms.filter(req, tx, rows, "device.use", ({ d }) =>
          deviceFacts(d, userId, access),
        );
        // D-14: the team project a repository is in is named only to someone who can open it.
        const openable = new Set(
          (
            await perms.filter(
              req,
              tx,
              usable.filter((r) => r.linkedId !== null && r.linkedPath !== null),
              "work_session.read",
              (r) =>
                workProjectResource(
                  { id: r.linkedId ?? "", path: r.linkedPath ?? [], access: r.linkedAccess },
                  userId,
                ),
            )
          ).map((r) => r.p.id),
        );
        const byDevice = new Map<string, LinkableRepos["devices"][number]>();
        for (const { p, d, linkedId, linkedName } of usable) {
          let entry = byDevice.get(d.id);
          if (!entry) {
            entry = { deviceId: d.id, deviceName: d.name, deviceOnline: d.status === "online", repos: [] };
            byDevice.set(d.id, entry);
          }
          const hidden = linkedId !== null && !openable.has(p.id);
          entry.repos.push({
            projectId: p.id,
            name: p.name,
            linkedTo: linkedId && linkedName && !hidden ? { id: linkedId, name: linkedName } : null,
            ...(hidden ? { linkedToHidden: true } : {}),
          });
        }
        return { devices: [...byDevice.values()] };
      }),
  );

  app.post(
    "/work-projects/:unitId/repos",
    {
      ...user,
      schema: {
        tags,
        params: ProjectParams,
        body: LinkWorkProjectRepoRequest,
        response: { 200: WorkProjectDetail },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const { userId } = authOf(req);
        const project = await projectFor(req, tx, perms, req.params.unitId, "work_project.manage", "project");
        const [repo] = await tx
          .select({ p: projects, d: devices })
          .from(projects)
          .innerJoin(devices, eq(devices.id, projects.deviceId))
          .where(eq(projects.id, req.body.projectId))
          .limit(1);
        if (!repo) throw notFound("Repository not found", "project_not_found");
        // D-10, T-07.9-04-02: linking someone's repository opens its sessions to the project; it needs using the device.
        await perms.assertCan(
          req,
          tx,
          "device.use",
          deviceFacts(repo.d, userId, await loadDeviceAccess(tx, userId)),
        );
        try {
          await tx.insert(workProjectRepos).values({
            organizationId: tenantOf(tx).organizationId,
            projectId: repo.p.id,
            deviceId: repo.d.id,
            unitId: project.unit.id,
            linkedBy: userId,
          });
        } catch (err) {
          const { code } = pgError(err);
          if (code === "23505") {
            throw conflict("This repository is already linked to a team project", "repo_already_linked");
          }
          if (code === "23503") throw notFound("Repository not found", "project_not_found");
          throw err;
        }
        await core.audit.record(tx, {
          action: "work_project.repo_linked",
          resourceType: "org_unit",
          resourceId: project.unit.id,
          deviceId: repo.d.id,
          metadata: { projectId: repo.p.id, deviceId: repo.d.id },
        });
        await projectChanged(core, tx, project.unit.id);
        return projectDetail(req, tx, perms, project);
      }),
  );

  app.get(
    "/work-projects/:unitId/repos/:projectId/impact",
    { ...user, schema: { tags, params: RepoParams, response: { 200: RepoUnlinkImpact } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const project = await projectFor(req, tx, perms, req.params.unitId, "work_project.manage", "project");
        const link = await requireLink(tx, project.unit.id, req.params.projectId);
        return { sessions: await repoSessionCount(tx, link.projectId) };
      }),
  );

  app.delete(
    "/work-projects/:unitId/repos/:projectId",
    { ...user, schema: { tags, params: RepoParams, response: { 200: WorkProjectDetail } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        // The project's managers (must_haves: linking, not unlinking, needs the device): unlinking only narrows who
        // sees the repository's sessions, and a repository on a device nobody may use any more must stay unlinkable.
        const project = await projectFor(req, tx, perms, req.params.unitId, "work_project.manage", "project");
        const link = await requireLink(tx, project.unit.id, req.params.projectId);
        const sessions = await repoSessionCount(tx, link.projectId);
        await tx.delete(workProjectRepos).where(eq(workProjectRepos.projectId, link.projectId));
        await core.audit.record(tx, {
          action: "work_project.repo_unlinked",
          resourceType: "org_unit",
          resourceId: project.unit.id,
          deviceId: link.deviceId,
          metadata: { projectId: link.projectId, deviceId: link.deviceId, sessions },
        });
        await projectChanged(core, tx, project.unit.id);
        return projectDetail(req, tx, perms, project);
      }),
  );
}
