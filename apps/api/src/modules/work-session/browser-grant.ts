import {
  browserToolFromName,
  canonicalBrowserTool,
  type SessionBrowserGrant,
  WORK_BROWSER_AUDIT,
  WorkBrowserApprovalRequest,
  WorkBrowserTool,
  type WorkSessionBrowserState,
  type WorkZonePolicy,
} from "@ocw/contracts";
import {
  agents,
  auditEvents,
  devices,
  orgUnits,
  type Tx,
  workApprovals,
  workBrowsers,
  workPrompts,
  workSessions,
} from "@ocw/db";
import { and, desc, eq, gte, inArray, max, sql } from "drizzle-orm";
import { loadPrincipalFacts, type PermissionService } from "../organization";
import { sandboxAvailable } from "../sandbox";
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
  /**
   * A bot's turn: the person it works for (`author_user_id` / `created_by`), whose unit rules also apply, who must
   * still be able to prompt the session, and for whom the bots' `browser.use` is decided (HI-05). Absent: no browser.
   */
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
 * owner's local opt-in) before `no_access` (a person who may no longer prompt this session; for a bot's turn, the
 * person it works for may not, or the bots' browser governance refuses the bot: `browser.use`, the confined tools'
 * organization switch, the kill switch or the bot's own browser switch, HI-05).
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
  // The person whose turn it is, or for whom the bot works: they must still be able to prompt this session.
  const human = a.askerIsBot ? (a.onBehalfOf ?? null) : askerId;
  if (human === null) return refused(a, "no_access");
  const facts = await sessionFacts(tx, human, row);
  const prompt = await perms.decide(tx, { kind: "user", userId: human }, "work_session.prompt", facts);
  if (!prompt.allowed) return refused(a, "no_access");
  // HI-05 ("como los bots", principle 6): a bot's turn gets the browser only under the bots' own browser governance,
  // the one decision `sandboxAvailable` makes for their confined browser: the resolver's `browser.use` for the bot
  // acting for that person (module deny rules, deny rules on the bot, a disabled bot), the organization's switch for
  // the bots' confined tools, its kill switch and the bot's own browser switch. Any refusal is `no_access`.
  if (
    a.askerIsBot &&
    !(await sandboxAvailable(tx, perms, { agentId: askerId, userId: human }, "browser")).ok
  ) {
    return refused(a, "no_access");
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

/** An approval of the browser: a browser part, or a browser tool's name. */
function isBrowserRequest(request: { tool: string; browser?: unknown }): boolean {
  return browserRequestOf(request.browser) !== null || isBrowserToolName(request.tool);
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
 *   device named.
 * - HI-04 (D-26, the bots' sticky member-data rule, `agent-channel/browser.ts`): once a member's sign-in loaded in the
 *   session's in-flight turn (the API's own `work_browser.signin_loaded` record of that load, since the turn was
 *   dispatched), every browser approval of the rest of that turn is that member's too, even after the page unloaded
 *   it: what the agent read there stays in the turn, so leaving for another host is the member's call. A sign-in loads
 *   only in its member's own human turn (D-24), so that member is the turn's author.
 * - `signed_in_host` with neither has nobody.
 * - `signin` belongs to the author of the session's in-flight prompt (D-21); a bot's turn, or no turn, has nobody.
 * - `host`, `admin_rule` and every other approval keep the existing `work_session.approve` rule.
 */
export async function browserApproverRule(
  tx: Tx,
  session: { id: string },
  request: { tool: string; browser?: unknown },
): Promise<BrowserApprover> {
  if (!isBrowserRequest(request)) return "approve_permission";
  const prompts = await inFlightPrompts(tx, [session.id]);
  const [page] = await tx
    .select({ signinUserId: workBrowsers.signinUserId })
    .from(workBrowsers)
    .where(eq(workBrowsers.workSessionId, session.id))
    .limit(1);
  const memberData = await memberDataTurns(tx, prompts);
  return approverOn(request, {
    inFlight: prompts.get(session.id) ?? null,
    signinUserId: page?.signinUserId ?? null,
    memberDataUserId: memberData.get(session.id) ?? null,
  });
}

interface InFlightPrompt {
  userId: string;
  agentId: string | null;
  dispatchedAtMs: number | null;
}

/** The in-flight prompt of each session (the most recently dispatched one still running). */
async function inFlightPrompts(tx: Tx, sessionIds: readonly string[]): Promise<Map<string, InFlightPrompt>> {
  const rows = await tx
    .select({
      sessionId: workPrompts.workSessionId,
      userId: workPrompts.authorUserId,
      agentId: workPrompts.authorAgentId,
      dispatchedAt: workPrompts.dispatchedAt,
    })
    .from(workPrompts)
    .where(
      and(
        inArray(workPrompts.workSessionId, [...sessionIds]),
        inArray(workPrompts.status, ["dispatched", "running"]),
      ),
    )
    .orderBy(desc(workPrompts.dispatchedAt));
  const out = new Map<string, InFlightPrompt>();
  // Most recently dispatched first: the first row per session is its in-flight prompt.
  for (const r of rows) {
    if (out.has(r.sessionId)) continue;
    out.set(r.sessionId, {
      userId: r.userId,
      agentId: r.agentId,
      dispatchedAtMs: r.dispatchedAt ? Date.parse(String(r.dispatchedAt)) : null,
    });
  }
  return out;
}

/**
 * HI-04: the sessions whose in-flight human turn loaded its author's sign-in (a `work_browser.signin_loaded` audit row
 * of that session and that member, written in the load's own transaction, since the turn was dispatched), with that
 * member. One read for all the sessions, bounded below by the earliest dispatch.
 */
async function memberDataTurns(
  tx: Tx,
  prompts: ReadonlyMap<string, InFlightPrompt>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const human = [...prompts].filter(([, p]) => p.agentId === null);
  if (human.length === 0) return out;
  const since = Math.min(...human.map(([, p]) => p.dispatchedAtMs ?? 0));
  const rows = await tx
    .select({ sessionId: auditEvents.sessionId, userId: auditEvents.userId, at: max(auditEvents.occurredAt) })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, WORK_BROWSER_AUDIT.signin_loaded),
        inArray(
          auditEvents.sessionId,
          human.map(([id]) => id),
        ),
        gte(auditEvents.occurredAt, new Date(since).toISOString()),
      ),
    )
    .groupBy(auditEvents.sessionId, auditEvents.userId);
  for (const r of rows) {
    const p = r.sessionId ? prompts.get(r.sessionId) : undefined;
    if (!r.sessionId || !p || r.userId !== p.userId || !r.at) continue;
    // No dispatch time recorded: any load of the session by its author counts (stricter, never looser).
    if (p.dispatchedAtMs === null || Date.parse(String(r.at)) >= p.dispatchedAtMs)
      out.set(r.sessionId, p.userId);
  }
  return out;
}

/** The facts `browserApproverRule` decides on, loaded once per session. */
interface ApproverFacts {
  /** The session's in-flight prompt (the most recently dispatched one still running), or null. */
  inFlight: { userId: string; agentId: string | null } | null;
  /** `work_browsers.signin_user_id`: the member whose sign-in is loaded on the session's page. */
  signinUserId: string | null;
  /** HI-04: the in-flight turn's author when their sign-in loaded in that turn (member data for the rest of it). */
  memberDataUserId: string | null;
}

/** `browserApproverRule` on facts already loaded (one rule for the answer route and Needs you). */
function approverOn(request: { tool: string; browser?: unknown }, facts: ApproverFacts): BrowserApprover {
  const browser = browserRequestOf(request.browser);
  if (!browser && !isBrowserToolName(request.tool)) return "approve_permission";
  if (browser?.kind === "signin") {
    const p = facts.inFlight;
    return { only: p && p.agentId === null ? p.userId : null };
  }
  if (facts.signinUserId) return { only: facts.signinUserId };
  if (facts.memberDataUserId) return { only: facts.memberDataUserId };
  if (browser?.kind === "signed_in_host") return { only: null };
  return "approve_permission";
}

/**
 * Who among the people allowed `work_session.approve` may answer some pending approval of each session (07.13-21,
 * the "Needs you" gap): `open` when one pending approval keeps the session's approve rule, `only` the people a
 * member-only one is for (`browserApproverRule`'s rule on the same facts, batched: four queries for all sessions).
 * A session with nothing pending is absent. "Needs you" asks a person only where the answer route would let them.
 */
export async function pendingApprovers(
  tx: Tx,
  sessionIds: readonly string[],
): Promise<Map<string, { open: boolean; only: Set<string> }>> {
  const out = new Map<string, { open: boolean; only: Set<string> }>();
  if (sessionIds.length === 0) return out;
  const ids = [...new Set(sessionIds)];
  const [pending, pages, inFlight] = await Promise.all([
    tx
      .select({ sessionId: workApprovals.workSessionId, request: workApprovals.request })
      .from(workApprovals)
      .where(and(inArray(workApprovals.workSessionId, ids), eq(workApprovals.status, "pending"))),
    tx
      .select({ sessionId: workBrowsers.workSessionId, signinUserId: workBrowsers.signinUserId })
      .from(workBrowsers)
      .where(inArray(workBrowsers.workSessionId, ids)),
    inFlightPrompts(tx, ids),
  ]);
  const signin = new Map(pages.map((p) => [p.sessionId, p.signinUserId]));
  // HI-04: only sessions with a pending browser approval need the member-data read.
  const asked = new Set(pending.filter((a) => isBrowserRequest(a.request)).map((a) => a.sessionId));
  const memberData = await memberDataTurns(tx, new Map([...inFlight].filter(([id]) => asked.has(id))));
  for (const a of pending) {
    const entry = out.get(a.sessionId) ?? { open: false, only: new Set<string>() };
    const rule = approverOn(a.request, {
      inFlight: inFlight.get(a.sessionId) ?? null,
      signinUserId: signin.get(a.sessionId) ?? null,
      memberDataUserId: memberData.get(a.sessionId) ?? null,
    });
    if (rule === "approve_permission") entry.open = true;
    else if (rule.only) entry.only.add(rule.only);
    out.set(a.sessionId, entry);
  }
  return out;
}

/**
 * Whether a person the resolver lets approve may answer one of the session's pending approvals. No pending row loaded
 * (the count was ahead of the row) keeps the session-level decision.
 */
export function answersPending(
  rules: ReadonlyMap<string, { open: boolean; only: ReadonlySet<string> }>,
  sessionId: string,
  userId: string,
): boolean {
  const r = rules.get(sessionId);
  return !r || r.open || r.only.has(userId);
}
