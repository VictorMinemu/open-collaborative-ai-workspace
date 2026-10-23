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
