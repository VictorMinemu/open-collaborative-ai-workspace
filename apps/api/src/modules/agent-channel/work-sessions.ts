import {
  AgentChannelWorkSessionPrompt,
  AgentChannelWorkSessionPromptResponse,
  AgentChannelWorkSessionStart,
  AgentChannelWorkSessionStartResponse,
  AgentChannelWorkSessionStop,
  AgentChannelWorkSessionStopResponse,
  type BotProfileInactiveReason,
  type BotWorkSessionRefusal,
  type BotWorkSessionRefused,
  BUILTIN_TOOLS,
  WORK_SESSION_TOOL_FLAGS,
} from "@ocw/contracts";
import { agentTurns, conversations, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { App, Core } from "../../core";
import { notFound } from "../../lib/errors";
import { createConversationAccess } from "../chat";
import { createPermissionService } from "../organization";
import {
  auditBotWorkSession,
  type BotProfileRow,
  loadBotProfile,
  ownBotSession,
  profileStatus,
  refusedAnswer,
  type WorkSessionModule,
} from "../work-session";
import { type CellPrincipal, cellOf } from "./auth";
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
 * 07.16-16 (D-05 … D-08, PD-13, PD-15): `POST /work-sessions/prompt` (`ocw_work_session_prompt`) and
 * `POST /work-sessions/stop` (`ocw_work_session_stop`) keep the bot orchestrating a session it started, and only such a
 * session (`ownBotSession`, the one rule: `not_your_session` for a person's, another bot's or another organization's).
 * tx0 finds the turn, the profile and the bot's own session; tx1 runs as the sponsor: the profile's for a prompt (the
 * prompt is theirs, `profile_inactive` otherwise), the session's for a stop (its creator always sees it; a stop is
 * allowed with an inactive profile). A prompt from a turn that read outside content answers `outside_content` (07.16-19
 * adds the profile flag path); a stop is never blocked by taint (claimed with `outsideContent`). Both are exempt from
 * the session-output rule (D-20). `interrupt` is not exposed and nothing here resolves a runtime approval (P3).
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
): void {
  const perms = createPermissionService(core);
  const access = createConversationAccess(core);

  /** `bot.work_session_refused` for `call` (after the claim, or with the denied row of `refuseBeforeClaim`). */
  async function auditRefusal(
    tx: Tx,
    p: { cell: CellPrincipal; turn: AgentTurnRow; call: CallRecord; answer: BotWorkSessionRefused },
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
        async (tx) => {
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
          // D-08: a turn that read outside content does not start a session on its own. The profile's flag path and
          // the proposal fallback (`proposed`) are 07.16-19's; until then a person must ask again.
          if (turn.tainted) return refuse("outside_content");

          const refused = await claim(tx, { cell, turn, call });
          if (refused) return refused;

          const readers = await conversationAudience(tx, turn);
          const judged = await judgedConversationId(tx, turn.conversationId);
          return workSession.bots.start(tx, {
            turn,
            profile,
            status,
            input: body,
            readers,
            isReadable: (userId) => access.isReadable(tx, userId, judged, { kinds: READABLE_KINDS }),
            auditBase: cellAuditBase(cell),
          });
        },
      );
      if (out === UNKNOWN) throw notFound(UNKNOWN_TURN, "unknown_turn");
      return out;
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
          // D-08: a turn that read outside content does not prompt on its own (07.16-19 adds the profile's flag
          // path). No fallback: a person can prompt the session.
          if (turn.tainted) return refuse("outside_content");

          // D-20: prompting its own session stays allowed after the turn read that session's output.
          const refused = await claim(tx, { cell, turn, call, sessionOutputExempt: true });
          if (refused) return refused;

          const answer = await workSession.bots.prompt(tx, {
            turn,
            profile,
            workSessionId: body.workSessionId,
            prompt: body.prompt,
            tainted: false,
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
