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
