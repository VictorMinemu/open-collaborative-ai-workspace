import {
  browserToolFromName,
  canonicalBrowserTool,
  type SessionBrowserGrant,
  WorkBrowserApprovalRequest,
  WorkBrowserTool,
  type WorkSessionBrowserState,
  type WorkZonePolicy,
} from "@ocw/contracts";
import { agents, devices, orgUnits, type Tx, workBrowsers, workPrompts, workSessions } from "@ocw/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { loadPrincipalFacts, type PermissionService } from "../organization";
import { type ApprovalFacts, loadToolApprovalPolicies, resolveToolApproval } from "../tool-approval";
import { sessionFacts } from "./facts";
import { loadWorkZonePolicy } from "./policy";

/**
 * Phase 07.13 (D-10, D-19, PD-09, PD-20): the browser one turn may use, decided by the API alone. Org policy ∩ the
 * device's local opt-in ∩ its capability (`devices.browser_version`, from `hello.browser`), the asker's access, the
 * admins' per-tool rule modes (D-34, PD-26) and whether a member's sign-in may load at all (D-24, D-32).
 *
 * Computed at send time, inside the hub's flush transaction, and added to the sent copy of `session.start` / `prompt`
 * only: never stored in `device_commands.payload`, so a grant always reflects the policy when its turn is sent (a turn
 * already running keeps its grant, as it keeps its permission mode). The device re-checks it on every call.
 */

/** Whose turn it is: the prompt's author (or the session's creator for `session.start`); a bot by its agent id. */
export interface BrowserAsker {
  sessionId: string;
  /**
   * The person, or the bot (agent id), whose turn this is; null when unknown (never allowed). A bot's turn names the
   * bot, never its sponsor, so the device unloads a member's sign-in before any bot call (D-25).
   */
  askerId: string | null;
  askerIsBot: boolean;
  /** A bot's turn: the person it works for (`author_user_id` / `created_by`), whose unit rules also apply. */
  onBehalfOf?: string | null;
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
 * The unit paths an admin's unit rule reaches for this asker: a person's units; for a bot, its own unit and its
 * sponsor's units (restrictions accumulate, principle 6).
 */
async function factsOf(tx: Tx, a: BrowserAsker & { askerId: string }): Promise<ApprovalFacts> {
  const human = a.askerIsBot ? (a.onBehalfOf ?? null) : a.askerId;
  const humanUnitPaths = human
    ? (await loadPrincipalFacts(tx, { kind: "user", userId: human })).memberUnitPaths
    : [];
  if (!a.askerIsBot) return { agentUnitPath: null, humanUnitPaths };
  const [agent] = await tx
    .select({ path: orgUnits.path })
    .from(agents)
    .leftJoin(orgUnits, eq(orgUnits.id, agents.unitId))
    .where(eq(agents.id, a.askerId))
    .limit(1);
  return { agentUnitPath: agent?.path ?? null, humanUnitPaths };
}

/**
 * D-34, PD-26: the admins' per-tool rules on `ocw_browser_*`, mode only (`always` → `alwaysAsk`, `when_tainted` →
 * `whenTainted`, `never` → none). Their approver kinds are not honoured in v1: the device asks through the Work Zone
 * approval flow, answered by whoever `browserApproverRule` lets answer.
 */
async function ruleModes(
  tx: Tx,
  a: BrowserAsker & { askerId: string },
): Promise<Pick<SessionBrowserGrant, "alwaysAsk" | "whenTainted">> {
  const out: Pick<SessionBrowserGrant, "alwaysAsk" | "whenTainted"> = { alwaysAsk: [], whenTainted: [] };
  const rows = await loadToolApprovalPolicies(tx);
  if (rows.length === 0) return out;
  const facts = await factsOf(tx, a);
  for (const tool of WorkBrowserTool.options) {
    const r = resolveToolApproval(rows, facts, canonicalBrowserTool(tool));
    if (r?.mode === "always") out.alwaysAsk.push(tool);
    else if (r?.mode === "when_tainted") out.whenTainted.push(tool);
  }
  return out;
}

/**
 * D-24, D-32: a member's sign-in may load only in a human session (not started by a bot) on a human turn, and only
 * while everyone who sees the session (`app.work_session_viewers`, the SQL audience rule) is the asker or the device
 * owner. Admins are never enumerated there for being admins.
 */
async function signinAllowedFor(
  tx: Tx,
  a: BrowserAsker & { askerId: string },
  s: { startedByAgentId: string | null; deviceOwner: string },
): Promise<boolean> {
  if (a.askerIsBot || s.startedByAgentId !== null) return false;
  const res = await tx.execute(sql`select user_id from app.work_session_viewers(${a.sessionId}::uuid)`);
  const viewers = (res.rows as Array<{ user_id: string }>).map((r) => r.user_id);
  return viewers.every((v) => v === a.askerId || v === s.deviceOwner);
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
      startedByAgentId: workSessions.startedByAgentId,
      deviceOwner: devices.ownerUserId,
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
  const askerId = a.askerId;
  if (askerId === null) return refused(a, "no_access");
  if (!a.askerIsBot) {
    const facts = await sessionFacts(tx, askerId, row);
    const { allowed } = await perms.decide(
      tx,
      { kind: "user", userId: askerId },
      "work_session.prompt",
      facts,
    );
    if (!allowed) return refused(a, "no_access");
  }
  const asker = { ...a, askerId };
  return {
    allowed: true,
    reason: "ok",
    askerId,
    askerIsBot: a.askerIsBot,
    ...(await ruleModes(tx, asker)),
    signinAllowed: await signinAllowedFor(tx, asker, row),
  };
}

/**
 * D-19: the session's browser as every viewer sees it (viewer-neutral, it rides the shared `ws:` stream, so it never
 * names a host or a member). `update_device` first ("Update this device to use the browser"), then the organization's
 * switch, then the device owner's opt-in; `live` = a page of the session is open now.
 */
export function browserStateOf(input: {
  policy: Pick<WorkZonePolicy, "allowBrowser">;
  device: { browserVersion: number | null; browserOptIn: boolean };
  open: boolean;
}): WorkSessionBrowserState {
  const status: WorkSessionBrowserState["status"] =
    input.device.browserVersion === null
      ? "update_device"
      : !input.policy.allowBrowser
        ? "off_policy"
        : !input.device.browserOptIn
          ? "off_device"
          : "available";
  return { status, live: input.open };
}

// ---------------------------------------------------------------- who answers a browser approval (PD-10)

/**
 * The browser part of an approval request as the device sent it, or null when there is none or it does not parse
 * (T-07.13-07-05: a malformed origin is dropped, never stored as text). A hint for the timeline only: who may answer
 * is `browserApproverRule`'s decision.
 */
export function browserRequestOf(value: unknown): WorkBrowserApprovalRequest | null {
  if (value === undefined || value === null) return null;
  const parsed = WorkBrowserApprovalRequest.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A Work Zone browser tool by its Claude (`mcp__ocw_browser__open`) or canonical (`ocw_browser_open`) name. */
function isBrowserToolName(tool: string): boolean {
  const short = browserToolFromName(tool);
  return short !== null && short !== tool;
}

/**
 * Who may answer an approval: `approve_permission` = whoever has `work_session.approve` (today's rule); `{ only }` =
 * that person alone, after the same check (`only: null` = nobody: the device's own timeout decides).
 */
export type BrowserApprover = "approve_permission" | { only: string | null };

/**
 * D-11, D-21, D-26, PD-10: decided from the API's own state, never from the device's `kind` alone.
 *
 * - A browser approval while a member's sign-in is loaded on the session's page (`work_browsers.signin_user_id`) is
 *   that member's: the page is locked to their site and another host needs their approval (D-26), whatever kind the
 *   device named. `signed_in_host` with no loaded sign-in has nobody.
 * - `signin` belongs to the author of the session's in-flight prompt (D-21); a bot's turn, or no turn, has nobody.
 * - `host`, `admin_rule` and every other approval keep the existing `work_session.approve` rule.
 */
export async function browserApproverRule(
  tx: Tx,
  session: { id: string },
  request: { tool: string; browser?: unknown },
): Promise<BrowserApprover> {
  const browser = browserRequestOf(request.browser);
  if (!browser && !isBrowserToolName(request.tool)) return "approve_permission";
  if (browser?.kind === "signin") {
    const [p] = await tx
      .select({ userId: workPrompts.authorUserId, agentId: workPrompts.authorAgentId })
      .from(workPrompts)
      .where(
        and(
          eq(workPrompts.workSessionId, session.id),
          inArray(workPrompts.status, ["dispatched", "running"]),
        ),
      )
      .orderBy(desc(workPrompts.dispatchedAt))
      .limit(1);
    return { only: p && p.agentId === null ? p.userId : null };
  }
  const [page] = await tx
    .select({ signinUserId: workBrowsers.signinUserId })
    .from(workBrowsers)
    .where(eq(workBrowsers.workSessionId, session.id))
    .limit(1);
  if (page?.signinUserId) return { only: page.signinUserId };
  if (browser?.kind === "signed_in_host") return { only: null };
  return "approve_permission";
}
