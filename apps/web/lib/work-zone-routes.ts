/**
 * Work Zone routes (Phase 07.9, UI-SPEC R8). `/work-zone/<id>` is a session; `/work-zone/projects` and
 * `/work-zone/projects/<unitId>` are the project pages and `/work-zone/people` the sessions-by-person view (static
 * segments Next.js matches before `[id]`), so the layout must never keep them open as a session when the Work Zone
 * module turns off (07.13.1.1 Pitfall 9).
 */

const SESSION = /^\/work-zone\/[^/]+$/u;
const PROJECTS = /^\/work-zone\/projects(?:\/|$)/u;
const PEOPLE = /^\/work-zone\/people(?:\/|$)/u;

/** The sessions-by-person view (07.13.1.1, D-01). */
export const PEOPLE_PATH = "/work-zone/people";

/** A session page (`/work-zone/<id>`), never the home, the projects index, a project page or the people view. */
export function isSessionPath(pathname: string): boolean {
  return SESSION.test(pathname) && !PROJECTS.test(pathname) && !PEOPLE.test(pathname);
}

export type ProjectTab = "sessions" | "settings";

/** The project page tab from `?tab=` (UI-SPEC "Project pages"): `settings`, else Sessions (unknown tabs fall back). */
export function projectTabOf(value: string | string[] | null | undefined): ProjectTab {
  const first = Array.isArray(value) ? value[0] : value;
  return first === "settings" ? "settings" : "sessions";
}

/** The project page's URL, with `?tab=settings` only for the Settings tab. */
export function projectHref(unitId: string, tab: ProjectTab = "sessions"): string {
  return tab === "settings" ? `/work-zone/projects/${unitId}?tab=settings` : `/work-zone/projects/${unitId}`;
}
