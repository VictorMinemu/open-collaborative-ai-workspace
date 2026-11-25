import type { SessionBrowserGrant } from "@ocw/contracts";
import { devices, type Tx, workSessions } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { PermissionService } from "../organization";
import { sessionFacts } from "./facts";
import { loadWorkZonePolicy } from "./policy";

/**
 * Phase 07.13 (D-10, D-19, PD-09, PD-20): the browser one turn may use, decided by the API alone. Org policy ∩ the
 * device's local opt-in ∩ its capability (`devices.browser_version`, from `hello.browser`), the asker's access, the
 * admins' per-tool rule modes (D-34) and whether a member's sign-in may load at all (D-32).
 *
 * Computed at send time, inside the hub's flush transaction, and added to the sent copy of `session.start` / `prompt`
 * only: never stored in `device_commands.payload`, so a grant always reflects the policy when its turn is sent (a turn
 * already running keeps its grant, as it keeps its permission mode). The device re-checks it on every call.
 */

/** Whose turn it is: the prompt's author (or the session's creator for `session.start`); a bot by its agent id. */
export interface BrowserAsker {
  sessionId: string;
  /** The person, or the bot (agent id), whose turn this is; null when unknown (never allowed). */
  askerId: string | null;
  askerIsBot: boolean;
}

/** A grant that allows nothing (the rules and the sign-in are never offered with it). */
function refused(a: BrowserAsker, reason: Exclude<SessionBrowserGrant["reason"], "ok">): SessionBrowserGrant {
  return {
    allowed: false,
    reason,
    askerId: a.askerId,
    askerIsBot: a.askerIsBot,
    alwaysAsk: [],
    whenTainted: [],
    signinAllowed: false,
  };
}

/**
 * The grant of one turn, or null for a device that never reported a browser version (PD-20: an older daemon gets no
 * `browser` key at all). Reasons in order: `off_policy` (the organization's switch) before `off_device` (the device
 * owner's local opt-in) before `no_access` (a person who may no longer prompt this session).
 */
export async function browserGrantFor(
  tx: Tx,
  perms: PermissionService,
  a: BrowserAsker,
): Promise<SessionBrowserGrant | null> {
  const [row] = await tx
    .select({
      id: workSessions.id,
      createdBy: workSessions.createdBy,
      deviceId: workSessions.deviceId,
      browserVersion: devices.browserVersion,
      browserOptIn: devices.browserOptIn,
    })
    .from(workSessions)
    .innerJoin(devices, eq(devices.id, workSessions.deviceId))
    .where(eq(workSessions.id, a.sessionId))
    .limit(1);
  if (!row || row.browserVersion === null) return null;
  const policy = await loadWorkZonePolicy(tx);
  if (!policy.allowBrowser) return refused(a, "off_policy");
  if (!row.browserOptIn) return refused(a, "off_device");
  if (a.askerId === null) return refused(a, "no_access");
  if (!a.askerIsBot) {
    const facts = await sessionFacts(tx, a.askerId, row);
    const { allowed } = await perms.decide(
      tx,
      { kind: "user", userId: a.askerId },
      "work_session.prompt",
      facts,
    );
    if (!allowed) return refused(a, "no_access");
  }
  return {
    allowed: true,
    reason: "ok",
    askerId: a.askerId,
    askerIsBot: a.askerIsBot,
    alwaysAsk: [],
    whenTainted: [],
    signinAllowed: false,
  };
}
