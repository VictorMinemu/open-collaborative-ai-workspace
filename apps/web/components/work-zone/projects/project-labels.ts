import type { WorkProjectSummary } from "@ocw/contracts";
import { plural } from "@/lib/session-visibility";

/**
 * Words of the Work Zone project pages (UI-SPEC § Copywriting "Projects index and project page"). Pure, so the
 * zero-one-many and trail rules are unit-tested.
 */

/** "Engineering › Web" (ancestors root first). */
export const trailText = (trail: readonly string[]) => trail.join(" › ");

/** "No repositories" · "1 repository" · "{n} repositories". */
export function repoCount(n: number): string {
  return n === 0 ? "No repositories" : plural(n, "repository", "repositories");
}

/** The counts of a team row: "{n} people · {n} repositories" (singulars for 1). */
export function teamCounts(p: Pick<WorkProjectSummary, "peopleCount" | "repoCount">): string {
  return `${plural(p.peopleCount, "person", "people")} · ${repoCount(p.repoCount)}`;
}

/** A team row's caption: "{trail} · {n} people · {n} repositories" (singulars for 1). */
export function teamCaption(p: Pick<WorkProjectSummary, "trail" | "peopleCount" | "repoCount">): string {
  return [trailText(p.trail), teamCounts(p)].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------- Settings tab (07.9-13, UI-SPEC § Copy)

/** "8 people" · "1 person". */
export const peopleCount = (n: number) => plural(n, "person", "people");

/** The Access line's title: "{n} people can open this project" (singular for 1; admins only when nobody is in it). */
export function accessTitle(n: number): string {
  if (n === 0) return "Only admins can open this project";
  return `${peopleCount(n)} can open this project`;
}

/** A team row's caption: "Team · 8 people" · "Department · 1 person". */
export function teamRowCaption(team: { kind: "team" | "department"; memberCount: number }): string {
  return `${team.kind === "team" ? "Team" : "Department"} · ${peopleCount(team.memberCount)}`;
}
