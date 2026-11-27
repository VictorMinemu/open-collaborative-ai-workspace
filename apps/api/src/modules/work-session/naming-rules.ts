import { joinNamingRules } from "@ocw/contracts";
import { type Tx, workProjectRepos, workProjectSettings } from "@ocw/db";
import { eq } from "drizzle-orm";
import { loadWorkZonePolicy, storedRule } from "./policy";

/**
 * Phase 07.13.1.1 (D-08, PD-06, PD-13, PD-16; ADR-0047): the naming rules a session follows, the organization's then
 * its team project's (the unit the session's repository is linked to through `work_project_repos`; a personal
 * repository has none), joined by `joinNamingRules` (tags stripped, blank parts dropped). null when both are empty.
 *
 * Read in the caller's transaction, at send time, for the `session.title` command and the `sessionTools` grant of a
 * `session.start` or `prompt`. The text is organization data: it may sit in a stored title command, and is never
 * logged or audited.
 */
export async function namingRulesFor(tx: Tx, s: { projectId: string }): Promise<string | null> {
  const org = (await loadWorkZonePolicy(tx)).sessionNamingRule ?? null;
  const [row] = await tx
    .select({ rule: workProjectSettings.namingRule })
    .from(workProjectRepos)
    .innerJoin(workProjectSettings, eq(workProjectSettings.unitId, workProjectRepos.unitId))
    .where(eq(workProjectRepos.projectId, s.projectId))
    .limit(1);
  return joinNamingRules(storedRule(org), storedRule(row?.rule));
}
