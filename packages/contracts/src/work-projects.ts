import { z } from "zod";
import { Id } from "./common";

/**
 * Work Zone team projects and session audiences (Phase 07.9, ADR-0030). A team project is an org unit of kind
 * `project`: its people (members ∪ members of its assigned teams), its default audience for new sessions and the
 * repositories linked to it. Who may see a session is decided only by the API resolver; these schemas carry ids,
 * display names and avatars, never a host path (AGENTS principle 7) and never anything else about a person.
 *
 * Imports only `common.ts`: `work-session.ts` and `device.ts` import from here, never the other way round.
 */

/**
 * Who can see a session (D-04): its owner only, everyone with access to its project, the project's chosen teams, or
 * chosen people with project access. On a personal repo "project" means everyone who can use the device.
 */
export const SessionVisibilityKind = z.enum(["owner", "project", "teams", "people"]);
export type SessionVisibilityKind = z.infer<typeof SessionVisibilityKind>;

/** The audience a team project gives new sessions (D-03): `project` (the switch on) or `owner` (off). */
export const ProjectDefaultVisibility = z.enum(["project", "owner"]);
export type ProjectDefaultVisibility = z.infer<typeof ProjectDefaultVisibility>;

/** Bounds every phase 07.9 schema takes its limits from. */
export const WORK_PROJECT_LIMITS = {
  /** A team project's name (an org unit name). */
  nameMax: 80,
  /** Teams in one session audience. */
  teamIdsMax: 50,
  /** People in one session audience (the owner is implied, never listed). */
  userIdsMax: 100,
  /** Rows a people search returns. */
  peopleSearchMax: 10,
  /** Avatars a draft audience preview returns. */
  previewPeople: 5,
  /** Avatars a project's access summary returns. */
  accessPeople: 5,
  /** Rows the "See all" viewer list returns (the rest is `more`). */
  viewersMax: 50,
  /** Names an audience change reports as removed (the rest is counted). */
  removedNamesMax: 3,
  /** A search query's length. */
  searchQueryMax: 100,
} as const;

/** A person's display name as the UI shows it (never an e-mail). */
const PersonName = z.string().max(200);
/** An org unit's name (`UnitName` bounds; repeated here so this file imports only `common.ts`). */
const UnitName = z.string().min(1).max(WORK_PROJECT_LIMITS.nameMax);

/** A reference to a team project: what a session row or a repository needs to name it. */
export const TeamProjectRef = z.object({ id: Id, name: UnitName });
export type TeamProjectRef = z.infer<typeof TeamProjectRef>;

/** The team project a repository is linked to, with the default its new sessions take (R5). */
export const RepoTeamProject = TeamProjectRef.extend({ defaultVisibility: ProjectDefaultVisibility });
export type RepoTeamProject = z.infer<typeof RepoTeamProject>;

/** A person as the project and audience surfaces show them: id, display name and avatar, nothing else. */
export const WorkProjectPerson = z.object({
  userId: Id,
  name: PersonName,
  avatarUrl: z.string().max(2048).nullable(),
});
export type WorkProjectPerson = z.infer<typeof WorkProjectPerson>;

/** A repository's display name as its device announced it (never a path). */
const RepoName = z.string().max(200);
/** A device's display name. */
const DeviceName = z.string().max(200);
/** Ancestor unit names, root first ("Engineering › Web"). */
const Trail = z.array(UnitName);

// ---------------------------------------------------------------- team project API (Phase 07.9, D-01, D-10, D-13)

/** `?q=` of the people and team searches (`…/assignable-teams`, `…/visibility/people`, `…/audience/people`). */
export const WorkProjectSearchQuery = z.object({
  q: z.string().trim().max(WORK_PROJECT_LIMITS.searchQueryMax).optional(),
});
export type WorkProjectSearchQuery = z.infer<typeof WorkProjectSearchQuery>;

/** A unit assigned (or assignable) to a team project: teams and departments only, never a project (D-13). */
export const WorkProjectTeam = z.object({
  id: Id,
  name: UnitName,
  kind: z.enum(["team", "department"]),
  memberCount: z.number().int().nonnegative(),
});
export type WorkProjectTeam = z.infer<typeof WorkProjectTeam>;

/** A repository linked to a team project, on the device that registered it. */
export const WorkProjectRepo = z.object({
  /** The repository (`app.projects` row), never its host path. */
  projectId: Id,
  name: RepoName,
  deviceId: Id,
  deviceName: DeviceName,
  deviceOnline: z.boolean(),
  branch: z.string().max(255).nullable(),
  /** False once the device stopped announcing it. */
  available: z.boolean(),
});
export type WorkProjectRepo = z.infer<typeof WorkProjectRepo>;

/**
 * How the viewer belongs to a project in the index (Phase 07.10, D-02): `member` = a direct member of the project,
 * `team` = a member of a team or department assigned to it, `lead` = a lead of the project, `manager` = opens it as an
 * admin or manages it without belonging to it (a lead of its parent unit, D-14). A label for grouping only: the API
 * still decides every session per audience, so it never grants anything (C-01).
 */
export const WorkProjectMembership = z.enum(["member", "team", "lead", "manager"]);
export type WorkProjectMembership = z.infer<typeof WorkProjectMembership>;

/** A team or department a project sits under (a project's parent is never a project, D-13). */
export const WorkProjectUnitRef = z.object({ id: Id, name: UnitName, kind: z.enum(["team", "department"]) });
export type WorkProjectUnitRef = z.infer<typeof WorkProjectUnitRef>;

/**
 * A row of the Projects index: a team project the caller can open or manage (`work_project.manage`, e.g. a lead of its
 * parent unit, D-14), or every one, for an admin. Its sessions are still listed per session audience.
 *
 * Phase 07.10 (D-01, D-10, UI-SPEC R1): `parent` is the unit the project sits under, `top` the top-level unit of its
 * path (the sidebar's section), with `viewerIsMember` when one of the viewer's unit memberships lies under it, and
 * `membership` how the viewer belongs to the project. Only on rows the index already returns (C-01).
 */
export const WorkProjectSummary = z.object({
  id: Id,
  name: UnitName,
  trail: Trail,
  peopleCount: z.number().int().nonnegative(),
  repoCount: z.number().int().nonnegative(),
  parent: WorkProjectUnitRef,
  top: WorkProjectUnitRef.extend({ viewerIsMember: z.boolean() }),
  membership: WorkProjectMembership,
});
export type WorkProjectSummary = z.infer<typeof WorkProjectSummary>;

/** A repository the caller can use that is linked to no team project. */
export const PersonalRepo = z.object({
  projectId: Id,
  name: RepoName,
  deviceId: Id,
  deviceName: DeviceName,
  deviceOnline: z.boolean(),
});
export type PersonalRepo = z.infer<typeof PersonalRepo>;

/** `GET /api/v1/work-projects`. `viewerCan.create`: `work_project.manage` on some team or department (resolver). */
export const WorkProjectIndex = z.object({
  teamProjects: z.array(WorkProjectSummary),
  personalRepos: z.array(PersonalRepo),
  viewerCan: z.object({ create: z.boolean() }),
});
export type WorkProjectIndex = z.infer<typeof WorkProjectIndex>;

/**
 * A unit a new team project may sit under: a team or department the caller manages (no top level, D-13). `topId` is
 * the top-level unit of its path (a department's is its own id), so the sidebar knows in which section the caller may
 * create (07.10, D-07, UI-SPEC R3).
 */
export const WorkProjectParent = z.object({
  id: Id,
  name: UnitName,
  kind: z.enum(["team", "department"]),
  trail: Trail,
  topId: Id,
});
export type WorkProjectParent = z.infer<typeof WorkProjectParent>;

/** `GET /api/v1/work-projects/parents`. */
export const WorkProjectParents = z.object({ parents: z.array(WorkProjectParent) });
export type WorkProjectParents = z.infer<typeof WorkProjectParents>;

/** `POST /api/v1/work-projects`: a unit of kind `project`; the creator becomes its lead (D-13). */
export const CreateWorkProjectRequest = z.strictObject({
  name: z.string().trim().min(1).max(WORK_PROJECT_LIMITS.nameMax),
  parentId: Id,
});
export type CreateWorkProjectRequest = z.infer<typeof CreateWorkProjectRequest>;

/** `GET /api/v1/work-projects/:unitId` (404 without project access, never an existence leak). */
export const WorkProjectDetail = z.object({
  id: Id,
  name: UnitName,
  parentId: Id,
  trail: Trail,
  defaultVisibility: ProjectDefaultVisibility,
  /** Who can open the project: members ∪ members of its teams (admins are a role, never counted). */
  access: z.object({
    count: z.number().int().nonnegative(),
    people: z.array(WorkProjectPerson).max(WORK_PROJECT_LIMITS.accessPeople),
  }),
  teams: z.array(WorkProjectTeam),
  repos: z.array(WorkProjectRepo),
  /**
   * Decided by the API resolver (UI gating only): `manage` = `work_project.manage` on the project (default switch,
   * repositories); `assignTeams` = `work_project.manage` on its parent; `members` = `unit.members.manage` on it;
   * `open` = `work_session.read` on it (project access or the admin rule). `open: false` is a manager outside the
   * project (D-14): they shape it but see none of its sessions (07.9-13, additive; absent on older payloads).
   */
  viewerCan: z.object({
    manage: z.boolean(),
    assignTeams: z.boolean(),
    members: z.boolean(),
    open: z.boolean().optional(),
  }),
});
export type WorkProjectDetail = z.infer<typeof WorkProjectDetail>;

/** `PATCH /api/v1/work-projects/:unitId`: the default audience of new sessions (existing sessions never change). */
export const UpdateWorkProjectRequest = z.strictObject({ defaultVisibility: ProjectDefaultVisibility });
export type UpdateWorkProjectRequest = z.infer<typeof UpdateWorkProjectRequest>;

/** `POST /api/v1/work-projects/:unitId/teams`. */
export const AssignWorkProjectTeamRequest = z.strictObject({ unitId: Id });
export type AssignWorkProjectTeamRequest = z.infer<typeof AssignWorkProjectTeamRequest>;

/** `GET /api/v1/work-projects/:unitId/assignable-teams?q=`: teams and departments not assigned yet. */
export const AssignableTeams = z.object({ teams: z.array(WorkProjectTeam) });
export type AssignableTeams = z.infer<typeof AssignableTeams>;

/** `POST /api/v1/work-projects/:unitId/repos`: link a repository (one team project per repository). */
export const LinkWorkProjectRepoRequest = z.strictObject({ projectId: Id });
export type LinkWorkProjectRepoRequest = z.infer<typeof LinkWorkProjectRepoRequest>;

/**
 * `GET /api/v1/work-projects/:unitId/linkable-repos`: repositories on devices the caller can use, grouped by device;
 * `linkedTo` names the team project a repository already belongs to (shown, not linkable), only when the caller can
 * open it; `linkedToHidden` marks a repository linked to a project the caller cannot open (D-14; absent = false).
 */
export const LinkableRepos = z.object({
  devices: z.array(
    z.object({
      deviceId: Id,
      deviceName: DeviceName,
      deviceOnline: z.boolean(),
      repos: z.array(
        z.object({
          projectId: Id,
          name: RepoName,
          linkedTo: TeamProjectRef.nullable(),
          linkedToHidden: z.boolean().optional(),
        }),
      ),
    }),
  ),
});
export type LinkableRepos = z.infer<typeof LinkableRepos>;

/** `GET /api/v1/work-projects/:unitId/repos/:projectId/impact`: sessions that become personal if it is unlinked. */
export const RepoUnlinkImpact = z.object({ sessions: z.number().int().nonnegative() });
export type RepoUnlinkImpact = z.infer<typeof RepoUnlinkImpact>;

/** Durable `work_project.updated` on `org:<id>`: a team project's teams, repositories or default changed (ids only). */
export const WorkProjectUpdatedEvent = z.object({ unitId: Id });
export type WorkProjectUpdatedEvent = z.infer<typeof WorkProjectUpdatedEvent>;
