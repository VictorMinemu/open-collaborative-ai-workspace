import {
  AgentChannelWorkSessionPrompt,
  AgentChannelWorkSessionPromptResponse,
  AgentChannelWorkSessionStart,
  AgentChannelWorkSessionStartResponse,
  AgentChannelWorkSessionStop,
  AgentChannelWorkSessionStopResponse,
  BOT_WORK_SESSION_PROPOSED_SENTENCE,
  type BotProfileInactiveReason,
  type BotWorkSessionRefusal,
  type BotWorkSessionRefused,
  BUILTIN_TOOLS,
  WORK_SESSION_TOOL_FLAGS,
} from "@ocw/contracts";
import { agentToolCalls, agentTurns, conversations, type Tx } from "@ocw/db";
import { and, eq } from "drizzle-orm";
import type { App, Core } from "../../core";
import { notFound } from "../../lib/errors";
import { createConversationAccess } from "../chat";
import { createPermissionService } from "../organization";
import {
  auditBotWorkSession,
  type BotProfileRow,
  loadBotProfile,
  ownBotSession,
  profileScopeRefusal,
  profileStatus,
  refusedAnswer,
  type WorkSessionModule,
  type WorkZoneProposalService,
} from "../work-session";
import { type CellPrincipal, cellOf } from "./auth";
import { waitItemForTurn } from "./automation-items";
import { type AgentTurnRow, auditUnknownTurn, cellAuditBase, claimToolCall, liveTurn } from "./claim";
import { conversationAudience } from "./memory-files";

/**
 * Phase 07.16-15 (D-01 … D-08, D-12, D-14, D-15, D-20; PD-03, PD-09 … PD-12, PD-15, PD-21): a bot's own Work Zone
 * sessions through the Agent Channel API. `POST /agent-channel/v1/work-sessions/start` (`ocw_work_session_start`): the
 * bot starts a session itself, in its sponsor's name, within its profile, with the audience the server decides and a
 * live card in the asker's thread. The body names the turn, the bot, a project, the prompt and optional settings only
 * (strict: no user, device, audience or worktree key can be expressed; 400 otherwise).
 *
 * Order (PD-03):
 * - tx0, user-less: the delivered turn of THIS bot in the cell's organization (RLS hides another organization's) →
 *   404 `unknown_turn`; the bot's profile (none: the live turn is checked, then `profile_inactive`).
 * - tx1, AS THE SPONSOR (the session is created by them; the `audience_backstop` admits a new session only for its
 *   creator): the live turn (the asker still reads the conversation, else 404 `unknown_turn`) → the tool on the turn
 *   (`not_in_turn`) → the profile's status (`profile_inactive` + `reason`) → the turn's outside content and session
 *   output (`outside_content`, `session_output`; D-08, D-20) → the claim (caps, taint; the call counts) →
 *   `bots.start` (caps under locks, settings, audience, `createWorkSession`, the card).
 *
 * 07.16-19 (D-08, D-18, PD-15): a start from a turn that read outside content, when the profile's admin flag
 * (`actOnOutsideContent`) is off, creates no session: tx1 writes nothing and hands over to tx2, AS THE ASKER, which
 * claims the call with `outsideContent` (metadata `fallback: "proposal"`) and creates today's Work Zone proposal for
 * the profile's device and runtime, stored `tainted` with a warning notice on its card; the answer is `proposed` and the
 * person's Start marks the first prompt tainted. A proposal the asker cannot make answers `outside_content` (the
 * proposal's code in the audit). The `ocw_start_work_zone` route is untouched: it still refuses tainted turns.
 *
 * 07.16-16 (D-05 … D-08, PD-13, PD-15): `POST /work-sessions/prompt` (`ocw_work_session_prompt`) and
 * `POST /work-sessions/stop` (`ocw_work_session_stop`) keep the bot orchestrating a session it started, and only such a
 * session (`ownBotSession`, the one rule: `not_your_session` for a person's, another bot's or another organization's).
 * tx0 finds the turn, the profile and the bot's own session; tx1 runs as the sponsor: the profile's for a prompt (the
 * prompt is theirs, `profile_inactive` otherwise), the session's for a stop (its creator always sees it; a stop is
 * allowed with an inactive profile). A prompt from a turn that read outside content answers `outside_content` unless
 * the profile's flag allows it (07.16-19: claimed `outsideContent`, queued `tainted`, the session's `tainted_at` set);
 * a start with the flag is claimed the same way, and an explicit Full access off an isolated server answers
 * `outside_content_bypass`. A stop is never blocked by taint (claimed with `outsideContent`) nor by a session read;
 * a prompt is exempt from the session-output rule (D-20) only for the one session the turn itself read (WR-02). `interrupt` is not exposed and nothing here resolves a runtime approval (P3).
 *
 * Every outcome is a 200 `{ kind }` (the plugin reads a refusal's fixed sentence) except an unknown or ended turn (404
 * with `error.code` `unknown_turn`, recorded by `auditUnknownTurn`). Each is recorded exactly once: a refusal before the
 * claim as a denied `agent_tool_calls` row (the turn is not counted) plus `bot.work_session_refused`; after it,
 * `bot.work_session_refused` or the tool's success (`bot.work_session_started|prompted|stopped`), all through the one
 * builder `auditBotWorkSession`. Ids, the mode, the model and the prompt's length only: never the prompt.
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];
const START = BUILTIN_TOOLS.workSessionStart;
const PROMPT = BUILTIN_TOOLS.workSessionPrompt;
const STOP = BUILTIN_TOOLS.workSessionStop;
const READ = BUILTIN_TOOLS.workSessionRead;
const UNKNOWN_TURN = "No delivered turn of this bot has that id";
const UNKNOWN: unique symbol = Symbol("unknown_turn");
const READABLE_KINDS = ["channel", "dm", "group", "ai_chat"] as const;

/** The success audit of the prompt and stop tools (a refusal is always `bot.work_session_refused`). */
const DONE = {
  [PROMPT]: { action: "bot.work_session_prompted", outcome: "prompted" },
  [STOP]: { action: "bot.work_session_stopped", outcome: "stopped" },
} as const;

type WorkSessionTool = typeof START | typeof PROMPT | typeof STOP;

/** What a call's records name: the claim's target and metadata, and the ids of its audit row. */
interface CallRecord {
  tool: WorkSessionTool;
  /** The project (start) or the session (prompt, stop) the call names. */
  target: string;
  /** The claim's audit metadata (ids and the prompt's length only). */
  metadata: Record<string, unknown>;
  sponsorUserId: string | null;
  projectId: string | null;
  deviceId: string | null;
  workSessionId?: string;
  promptChars?: number;
}

/** tx1's hand-over to the proposal fallback (D-18): nothing was written as the sponsor. */
type Propose = { propose: { askerUserId: string; profile: BotProfileRow } };

/** The bot's own session as tx0 found it (user-less: the whole tenant), with the ids its records name. */
type OwnSession = NonNullable<Awaited<ReturnType<typeof ownBotSession>>>;

/** The records of a prompt or stop call on `workSessionId` (the bot's own session when `own` is set). */
function controlRecord(
  tool: typeof PROMPT | typeof STOP,
  body: { eventId: string; workSessionId: string; prompt?: string },
  own: OwnSession | null,
  sponsorUserId: string | null,
): CallRecord {
  const promptChars = body.prompt?.length;
  return {
    tool,
    target: body.workSessionId,
    metadata: {
      eventId: body.eventId,
      workSessionId: body.workSessionId,
      ...(promptChars !== undefined ? { promptChars } : {}),
    },
    sponsorUserId,
    projectId: own?.session.projectId ?? null,
    deviceId: own?.session.deviceId ?? null,
    workSessionId: body.workSessionId,
    ...(promptChars !== undefined ? { promptChars } : {}),
  };
}

/**
 * WR-02 (D-20): whether the turn's successful `ocw_work_session_read` calls (its allowed `agent_tool_calls` rows) read
 * `workSessionId` and nothing else. False when it read none (the mark came from another turn).
 */
async function readOnly(tx: Tx, eventId: string, workSessionId: string): Promise<boolean> {
  const rows = await tx
    .selectDistinct({ target: agentToolCalls.target })
    .from(agentToolCalls)
    .where(
      and(
        eq(agentToolCalls.eventId, eventId),
        eq(agentToolCalls.tool, READ),
        eq(agentToolCalls.decision, "allowed"),
      ),
    );
  return rows.length > 0 && rows.every((r) => r.target === workSessionId);
}

/** The conversation whose readers decide a turn's audience: a thread is read through its channel or DM. */
async function judgedConversationId(tx: Tx, conversationId: string): Promise<string> {
  const [conv] = await tx
    .select({ kind: conversations.kind, parent: conversations.parentConversationId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return conv?.kind === "thread" && conv.parent ? conv.parent : conversationId;
}

export function registerBotWorkSessionRoutes(
  scope: App,
  core: Core,
  workSession: Pick<WorkSessionModule, "bots">,
  /** 07.16-19 (D-18): the Work Zone proposals a tainted start falls back to; null = refused `outside_content`. */
  proposals: WorkZoneProposalService | null = null,
): void {
  const perms = createPermissionService(core);
  const access = createConversationAccess(core);

  /** `bot.work_session_refused` for `call` (after the claim, or with the denied row of `refuseBeforeClaim`). */
  async function auditRefusal(
    tx: Tx,
    p: {
      cell: CellPrincipal;
      turn: AgentTurnRow;
      call: CallRecord;
      answer: BotWorkSessionRefused;
      proposalRefusal?: string;
    },
  ): Promise<BotWorkSessionRefused> {
    const { call, answer } = p;
    await auditBotWorkSession(tx, core, {
      action: "bot.work_session_refused",
      tool: call.tool,
      turn: p.turn,
      auditBase: cellAuditBase(p.cell),
      outcome: answer.code,
      sponsorUserId: call.sponsorUserId,
      projectId: call.projectId,
      deviceId: call.deviceId,
      ...(call.workSessionId ? { workSessionId: call.workSessionId } : {}),
      ...(call.promptChars !== undefined ? { promptChars: call.promptChars } : {}),
      ...(answer.reason ? { reason: answer.reason } : {}),
      ...(answer.field ? { field: answer.field } : {}),
      ...(p.proposalRefusal ? { proposalRefusal: p.proposalRefusal } : {}),
    });
    return answer;
  }

  /**
   * A refusal decided before the claim: a denied `agent_tool_calls` row (the turn is not counted) and
   * `bot.work_session_refused`, then the fixed answer.
   */
  async function refuseBeforeClaim(
    tx: Tx,
    p: {
      cell: CellPrincipal;
      turn: AgentTurnRow;
      call: CallRecord;
      code: BotWorkSessionRefusal;
      reason?: BotProfileInactiveReason;
    },
  ): Promise<BotWorkSessionRefused> {
    const { cell, turn, call } = p;
    await claimToolCall(tx, core, {
      cell,
      turn,
      tool: call.tool,
      flags: WORK_SESSION_TOOL_FLAGS[call.tool],
      web: false,
      sourceKind: "builtin",
      sourceId: null,
      target: call.target,
      reason: p.code,
      metadata: call.metadata,
    });
    return auditRefusal(tx, {
      cell,
      turn,
      call,
      answer: refusedAnswer(p.code, p.reason ? { reason: p.reason } : {}),
    });
  }

  /** The claim of a call on the turn (the call counts), with the tool's options; refused → its audited answer. */
  async function claim(
    tx: Tx,
    p: {
      cell: CellPrincipal;
      turn: AgentTurnRow;
      call: CallRecord;
      outsideContent?: boolean;
      sessionOutputExempt?: boolean;
    },
  ): Promise<BotWorkSessionRefused | null> {
    const { cell, turn, call } = p;
    const claimed = await claimToolCall(tx, core, {
      cell,
      turn,
      tool: call.tool,
      flags: WORK_SESSION_TOOL_FLAGS[call.tool],
      web: false,
      sourceKind: "builtin",
      sourceId: null,
      target: call.target,
      reason: null,
      metadata: call.metadata,
      ...(p.outsideContent ? { outsideContent: true } : {}),
      ...(p.sessionOutputExempt ? { sessionOutputExempt: true } : {}),
    });
    if (claimed.allowed) return null;
    const code: BotWorkSessionRefusal = claimed.reason === "tainted" ? "outside_content" : "cap_reached";
    return auditRefusal(tx, { cell, turn, call, answer: refusedAnswer(code) });
  }

  /** The audit of a prompt or stop answer from `bots`: its success action, or the refusal. */
  async function recordControl<A extends { kind: string }>(
    tx: Tx,
    p: { cell: CellPrincipal; turn: AgentTurnRow; call: CallRecord & { tool: typeof PROMPT | typeof STOP } },
    answer: A | BotWorkSessionRefused,
  ): Promise<A | BotWorkSessionRefused> {
    if (answer.kind === "refused") {
      return auditRefusal(tx, { ...p, answer: answer as BotWorkSessionRefused });
    }
    const { call } = p;
    await auditBotWorkSession(tx, core, {
      action: DONE[call.tool].action,
      turn: p.turn,
      auditBase: cellAuditBase(p.cell),
      outcome: DONE[call.tool].outcome,
      sponsorUserId: call.sponsorUserId,
      projectId: call.projectId,
      deviceId: call.deviceId,
      ...(call.workSessionId ? { workSessionId: call.workSessionId } : {}),
      ...(call.promptChars !== undefined ? { promptChars: call.promptChars } : {}),
    });
    return answer;
  }

  scope.post(
    "/work-sessions/start",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        body: AgentChannelWorkSessionStart,
        response: { 200: AgentChannelWorkSessionStartResponse },
      },
    },
    async (req) => {
      const body = req.body;
      const cell = cellOf(req);
      // Ids and the prompt's length only: the prompt itself is never logged or audited.
      const metadata = { eventId: body.eventId, projectId: body.projectId, promptChars: body.prompt.length };
      const startRecord = (profile: BotProfileRow | null): CallRecord => ({
        tool: START,
        target: body.projectId,
        metadata,
        sponsorUserId: profile?.sponsorUserId ?? null,
        projectId: body.projectId,
        deviceId: profile?.deviceId ?? null,
        promptChars: body.prompt.length,
      });
      const unknownTurn = async (tx: Tx): Promise<typeof UNKNOWN> => {
        await auditUnknownTurn(tx, core, { cell, tool: START, reason: "unknown_turn", metadata });
        return UNKNOWN;
      };

      // tx0 (no user): the turn of this bot and its profile.
      const found = await core.db.withTenant(
        { organizationId: cell.organizationId, userId: null },
        async (
          tx,
        ): Promise<typeof UNKNOWN | { profile: BotProfileRow } | { answer: BotWorkSessionRefused }> => {
          const [turn] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, body.eventId));
          if (!turn || turn.agentId !== body.agentId) return unknownTurn(tx);
          const profile = await loadBotProfile(tx, turn.agentId);
          if (profile) return { profile };
          // No profile (deleted after delivery, or never saved): still only for a live turn.
          const live = await liveTurn(tx, core, body);
          if (!live) return unknownTurn(tx);
          return {
            answer: await refuseBeforeClaim(tx, {
              cell,
              turn: live,
              call: startRecord(null),
              code: "profile_inactive",
            }),
          };
        },
      );
      if (found === UNKNOWN) throw notFound(UNKNOWN_TURN, "unknown_turn");
      if ("answer" in found) return found.answer;
      const sponsorUserId = found.profile.sponsorUserId;

      // tx1, as the sponsor.
      const out = await core.db.withTenant(
        { organizationId: cell.organizationId, userId: sponsorUserId },
        async (tx): Promise<AgentChannelWorkSessionStartResponse | typeof UNKNOWN | Propose> => {
          const turn = await liveTurn(tx, core, body);
          if (!turn) return unknownTurn(tx);
          // The profile as it is now; a profile re-saved by someone else since tx0 has another sponsor: ask again.
          const profile = await loadBotProfile(tx, turn.agentId);
          const call = startRecord(profile);
          const refuse = (code: BotWorkSessionRefusal, reason?: BotProfileInactiveReason) =>
            refuseBeforeClaim(tx, { cell, turn, call, code, ...(reason ? { reason } : {}) });
          if (!turn.tools.includes(START)) return refuse("not_in_turn");
          if (!profile || profile.sponsorUserId !== sponsorUserId) return refuse("profile_inactive");
          const status = await profileStatus(tx, perms, profile);
          if (!status.active) return refuse("profile_inactive", status.reason);
          // D-20: a turn that read a session's output never starts another one (prompt, read and stop only).
          if (turn.sessionOutputRead) return refuse("session_output");
          // D-08, D-18 (PD-15): a turn that read outside content starts nothing on its own unless the profile's admin
          // flag allows it. Without it, the start becomes a proposal a person reviews (in the asker's transaction,
          // below), for one of the profile's projects only; nothing is written here.
          if (turn.tainted && !profile.actOnOutsideContent) {
            if (!status.projectIds.includes(body.projectId)) return refuse("project_not_allowed");
            if (!proposals) return refuse("outside_content");
            return { propose: { askerUserId: turn.userId, profile } };
          }
          // D-04, PD-08: with the flag, Full access after outside content runs only on an isolated server. An explicit
          // request elsewhere is told why (the context would refuse it as `bot_profile`); an implicit default is lowered
          // by the context (`bots.start` passes the turn's taint into the layer).
          if (turn.tainted && body.permissionMode === "fullAccess" && !status.layer.isolated) {
            return refuse("outside_content_bypass");
          }

          // D-08: the flag claims the side-effecting start on a tainted turn (audited `outsideContent: true`).
          const refused = await claim(tx, {
            cell,
            turn,
            call,
            ...(turn.tainted ? { outsideContent: true } : {}),
          });
          if (refused) return refused;

          const readers = await conversationAudience(tx, turn);
          const judged = await judgedConversationId(tx, turn.conversationId);
          const answer = await workSession.bots.start(tx, {
            turn,
            profile,
            status,
            input: body,
            readers,
            isReadable: (userId) => access.isReadable(tx, userId, judged, { kinds: READABLE_KINDS }),
            auditBase: cellAuditBase(cell),
          });
          // 07.17 code review WR-02: an opened item's own turn found every session of the bot busy, so the item waits
          // and is queued again when one of them ends (`requeueAfterSession`, from `work_session.bot_sync`).
          if (answer.kind === "refused" && answer.code === "too_many_sessions") {
            await waitItemForTurn(tx, core, turn.eventId);
          }
          return answer;
        },
      );
      if (out === UNKNOWN) throw notFound(UNKNOWN_TURN, "unknown_turn");
      if (!("propose" in out)) return out;

      // tx2, AS THE ASKER (the person the proposal is for, the `onTurn` pattern of `ocw_start_work_zone`): the live turn,
      // the claim on the tainted turn (`outsideContent`, the call counts; metadata `fallback: "proposal"`), then today's
      // proposal for the profile's device and runtime, stored `tainted` with the card's warning notice (D-18).
      const { askerUserId, profile } = out.propose;
      const fallback = await core.db.withTenant(
        { organizationId: cell.organizationId, userId: askerUserId },
        async (tx): Promise<AgentChannelWorkSessionStartResponse | typeof UNKNOWN> => {
          const turn = await liveTurn(tx, core, body);
          if (!turn || turn.userId !== askerUserId || !proposals) return unknownTurn(tx);
          const call: CallRecord = {
            ...startRecord(profile),
            metadata: { ...metadata, fallback: "proposal" },
          };
          const refused = await claim(tx, { cell, turn, call, outsideContent: true });
          if (refused) return refused;
          const res = await proposals.propose(tx, {
            turn,
            input: {
              eventId: body.eventId,
              agentId: body.agentId,
              projectId: body.projectId,
              deviceId: profile.deviceId,
              prompt: body.prompt,
              runtime: profile.runtime,
            },
            tainted: true,
          });
          if ("refused" in res) {
            return auditRefusal(tx, {
              cell,
              turn,
              call,
              answer: refusedAnswer("outside_content"),
              proposalRefusal: res.refused,
            });
          }
          await auditBotWorkSession(tx, core, {
            action: "bot.work_session_proposed",
            turn,
            auditBase: cellAuditBase(cell),
            outcome: "proposed",
            sponsorUserId: profile.sponsorUserId,
            projectId: body.projectId,
            deviceId: profile.deviceId,
            promptChars: body.prompt.length,
            approvalId: res.approvalId,
          });
          return {
            kind: "proposed",
            approvalId: res.approvalId,
            reason: "outside_content",
            sentence: BOT_WORK_SESSION_PROPOSED_SENTENCE,
          };
        },
      );
      if (fallback === UNKNOWN) throw notFound(UNKNOWN_TURN, "unknown_turn");
      return fallback;
    },
  );

  /**
   * tx0 of a prompt or stop (no user): the turn of THIS bot (else 404 `unknown_turn`), its profile and its own session
   * (`ownBotSession` over the whole tenant: a person's, another bot's or another organization's session is null).
   */
  async function findControl(
    tx: Tx,
    body: { eventId: string; agentId: string; workSessionId: string },
  ): Promise<{ turn: AgentTurnRow; profile: BotProfileRow | null; own: OwnSession | null } | null> {
    const [turn] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, body.eventId));
    if (!turn || turn.agentId !== body.agentId) return null;
    const profile = await loadBotProfile(tx, turn.agentId);
    const own = await ownBotSession(tx, { agentId: turn.agentId, workSessionId: body.workSessionId });
    return { turn, profile, own };
  }

  scope.post(
    "/work-sessions/prompt",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        body: AgentChannelWorkSessionPrompt,
        response: { 200: AgentChannelWorkSessionPromptResponse },
      },
    },
    async (req) => {
      const body = req.body;
      const cell = cellOf(req);
      // Ids and the prompt's length only: the prompt itself is never logged or audited.
      const metadata = {
        eventId: body.eventId,
        workSessionId: body.workSessionId,
        promptChars: body.prompt.length,
      };
      const unknownTurn = async (tx: Tx): Promise<typeof UNKNOWN> => {
        await auditUnknownTurn(tx, core, { cell, tool: PROMPT, reason: "unknown_turn", metadata });
        return UNKNOWN;
      };

      // tx0 (no user): the turn, the profile (a prompt is the sponsor's: none → `profile_inactive`), the session.
      const found = await core.db.withTenant(
        { organizationId: cell.organizationId, userId: null },
        async (
          tx,
        ): Promise<
          | typeof UNKNOWN
          | { profile: BotProfileRow; own: OwnSession | null }
          | { answer: BotWorkSessionRefused }
        > => {
          const control = await findControl(tx, body);
          if (!control) return unknownTurn(tx);
          if (control.profile) return { profile: control.profile, own: control.own };
          const live = await liveTurn(tx, core, body);
          if (!live) return unknownTurn(tx);
          return {
            answer: await refuseBeforeClaim(tx, {
              cell,
              turn: live,
              call: controlRecord(PROMPT, body, control.own, null),
              code: control.own ? "profile_inactive" : "not_your_session",
            }),
          };
        },
      );
      if (found === UNKNOWN) throw notFound(UNKNOWN_TURN, "unknown_turn");
      if ("answer" in found) return found.answer;
      const sponsorUserId = found.profile.sponsorUserId;

      // tx1, as the profile's sponsor (the prompt's author).
      const out = await core.db.withTenant(
        { organizationId: cell.organizationId, userId: sponsorUserId },
        async (tx) => {
          const turn = await liveTurn(tx, core, body);
          if (!turn) return unknownTurn(tx);
          const profile = await loadBotProfile(tx, turn.agentId);
          const call = controlRecord(PROMPT, body, found.own, sponsorUserId);
          const refuse = (code: BotWorkSessionRefusal, reason?: BotProfileInactiveReason) =>
            refuseBeforeClaim(tx, { cell, turn, call, code, ...(reason ? { reason } : {}) });
          if (!turn.tools.includes(PROMPT)) return refuse("not_in_turn");
          if (!found.own) return refuse("not_your_session");
          if (!profile || profile.sponsorUserId !== sponsorUserId) return refuse("profile_inactive");
          const status = await profileStatus(tx, perms, profile);
          if (!status.active) return refuse("profile_inactive", status.reason);
          // WR-04: the active profile must still cover this session (its device, runtime and project), as the arbiter
          // decides at dispatch (`botLayerForSession`): never answered `queued` for a prompt that would then fail.
          const outOfScope = profileScopeRefusal(profile, status, found.own.session);
          if (outOfScope) return refuse(outOfScope);
          // WR-05 (D-02): a session keeps the sponsor it was started under (its identity, subscription and audit). A
          // profile re-saved by someone else since never prompts it in the new sponsor's name: the bot starts a new
          // session under them (stop and read keep using the session's own sponsor).
          if (found.own.bot.sponsorUserId !== profile.sponsorUserId) return refuse("profile_inactive");
          // D-08 (PD-15): a turn that read outside content prompts only with the profile's admin flag. No fallback
          // without it: a person can prompt the session.
          if (turn.tainted && !profile.actOnOutsideContent) return refuse("outside_content");
          // D-20 (code review WR-02): after a read, the turn prompts only the session whose output it read, and only
          // when that is the only session it read here. Another session's output could steer it (one in Full access
          // on another device), and a mark carried from another turn (a re-run, a return, a wake) names no session:
          // the bot reads the session first.
          const exempt = turn.sessionOutputRead && (await readOnly(tx, turn.eventId, body.workSessionId));
          if (turn.sessionOutputRead && !exempt) return refuse("session_output");

          // With the flag, a tainted turn's prompt is claimed (`outsideContent`), queued `tainted` and marks the
          // session (sticky, E12).
          const refused = await claim(tx, {
            cell,
            turn,
            call,
            ...(exempt ? { sessionOutputExempt: true } : {}),
            ...(turn.tainted ? { outsideContent: true } : {}),
          });
          if (refused) return refused;

          const answer = await workSession.bots.prompt(tx, {
            turn,
            profile,
            workSessionId: body.workSessionId,
            prompt: body.prompt,
            tainted: turn.tainted,
          });
          return recordControl(tx, { cell, turn, call: { ...call, tool: PROMPT } }, answer);
        },
      );
      if (out === UNKNOWN) throw notFound(UNKNOWN_TURN, "unknown_turn");
      return out;
    },
  );

  scope.post(
    "/work-sessions/stop",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        body: AgentChannelWorkSessionStop,
        response: { 200: AgentChannelWorkSessionStopResponse },
      },
    },
    async (req) => {
      const body = req.body;
      const cell = cellOf(req);
      const metadata = { eventId: body.eventId, workSessionId: body.workSessionId };
      const unknownTurn = async (tx: Tx): Promise<typeof UNKNOWN> => {
        await auditUnknownTurn(tx, core, { cell, tool: STOP, reason: "unknown_turn", metadata });
        return UNKNOWN;
      };

      // tx0 (no user): the turn and the bot's own session (a stop needs no active profile, PD-13).
      const found = await core.db.withTenant(
        { organizationId: cell.organizationId, userId: null },
        async (tx): Promise<typeof UNKNOWN | { own: OwnSession } | { answer: BotWorkSessionRefused }> => {
          const control = await findControl(tx, body);
          if (!control) return unknownTurn(tx);
          if (control.own) return { own: control.own };
          const live = await liveTurn(tx, core, body);
          if (!live) return unknownTurn(tx);
          return {
            answer: await refuseBeforeClaim(tx, {
              cell,
              turn: live,
              call: controlRecord(STOP, body, null, control.profile?.sponsorUserId ?? null),
              code: "not_your_session",
            }),
          };
        },
      );
      if (found === UNKNOWN) throw notFound(UNKNOWN_TURN, "unknown_turn");
      if ("answer" in found) return found.answer;
      const own = found.own;
      // The session's sponsor: its creator, who always sees it, whatever the profile says now.
      const sponsorUserId = own.bot.sponsorUserId;

      const out = await core.db.withTenant(
        { organizationId: cell.organizationId, userId: sponsorUserId },
        async (tx) => {
          const turn = await liveTurn(tx, core, body);
          if (!turn) return unknownTurn(tx);
          const call = controlRecord(STOP, body, own, sponsorUserId);
          if (!turn.tools.includes(STOP)) {
            return refuseBeforeClaim(tx, { cell, turn, call, code: "not_in_turn" });
          }
          // Stopping is never blocked by outside content or a session read (D-08 lists start and prompt only).
          const refused = await claim(tx, {
            cell,
            turn,
            call,
            outsideContent: true,
            sessionOutputExempt: true,
          });
          if (refused) return refused;
          const answer = await workSession.bots.stop(tx, { turn, workSessionId: body.workSessionId });
          return recordControl(tx, { cell, turn, call: { ...call, tool: STOP } }, answer);
        },
      );
      if (out === UNKNOWN) throw notFound(UNKNOWN_TURN, "unknown_turn");
      return out;
    },
  );
}
