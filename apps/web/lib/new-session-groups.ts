import type { Project, RepoTeamProject } from "@ocw/contracts";

/**
 * The new-session dialog's repositories, arranged (Phase 07.9-14, UI-SPEC Surface 3, D-01, D-03, D-14, R5). Pure: no
 * React, no fetching and no access decision. `GET /projects` already lists only what the caller may see; this module
 * groups it and words nothing.
 */

export type TeamRepoGroup = { project: RepoTeamProject; repos: Project[] };
export type PersonalRepoGroup = {
  deviceId: string;
  deviceName: string;
  deviceOnline: boolean;
  repos: Project[];
};

export type RepoGroups = {
  /** Team projects first, by name (case ignored, then id), each with every repository linked to it. */
  teams: TeamRepoGroup[];
  /** Unlinked repositories by device, in the order the API sent them (today's device groups). */
  personal: PersonalRepoGroup[];
  /**
   * D-14: repositories of the caller's own device linked to a team project they can't open. The API names no project
   * for them and refuses a start; the dialog shows them apart and disabled, never as personal.
   */
  hidden: Project[];
};

export function groupRepos(projects: readonly Project[]): RepoGroups {
  const teams = new Map<string, TeamRepoGroup>();
  const personal = new Map<string, PersonalRepoGroup>();
  const hidden: Project[] = [];
  for (const p of projects) {
    if (p.teamProjectHidden) {
      hidden.push(p);
    } else if (p.teamProject) {
      const g = teams.get(p.teamProject.id) ?? { project: p.teamProject, repos: [] };
      g.repos.push(p);
      teams.set(p.teamProject.id, g);
    } else {
      const g = personal.get(p.deviceId) ?? {
        deviceId: p.deviceId,
        deviceName: p.deviceName,
        deviceOnline: p.deviceOnline,
        repos: [],
      };
      g.repos.push(p);
      personal.set(p.deviceId, g);
    }
  }
  const byName = (a: TeamRepoGroup, b: TeamRepoGroup) =>
    a.project.name.localeCompare(b.project.name, undefined, { sensitivity: "base" }) ||
    a.project.id.localeCompare(b.project.id);
  return { teams: [...teams.values()].sort(byName), personal: [...personal.values()], hidden };
}

/** A session can start here from the dialog: the device is online and the caller can open its project. */
export function isStartable(p: Project): boolean {
  return p.deviceOnline && !p.teamProjectHidden;
}

/**
 * Who a new session on `p` starts visible to (D-03): a team project's default (Project when its switch is on, Only me
 * when off), Project on a personal repository (everyone who can use the device); none without a repository, or on one
 * the caller can't start a session on (D-14).
 */
export function defaultAudience(p: Project | null): { kind: "project" } | { kind: "owner" } | null {
  if (!p || p.teamProjectHidden) return null;
  if (p.teamProject?.defaultVisibility === "owner") return { kind: "owner" };
  return { kind: "project" };
}
