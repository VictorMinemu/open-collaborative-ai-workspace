import {
  AgentChannelWorkSessionStart,
  AgentChannelWorkSessionStartResponse,
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
  auditBotStart,
  type BotProfileRow,
  loadBotProfile,
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
 * Every outcome is a 200 `{ kind }` (the plugin reads a refusal's fixed sentence) except an unknown or ended turn (404
 * with `error.code` `unknown_turn`). Each is recorded: a refusal before the claim as a denied `agent_tool_calls` row
 * (the turn is not counted) plus `bot.work_session_refused`; after it, `bot.work_session_refused` or
 * `bot.work_session_started`. Ids, the mode, the model and the prompt's length only: never the prompt.
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];
const START = BUILTIN_TOOLS.workSessionStart;
const UNKNOWN_TURN = "No delivered turn of this bot has that id";
const UNKNOWN: unique symbol = Symbol("unknown_turn");
const READABLE_KINDS = ["channel", "dm", "group", "ai_chat"] as const;

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

  /**
   * A refusal decided before the claim: a denied `agent_tool_calls` row (the turn is not counted) and
   * `bot.work_session_refused`, then the fixed answer.
   */
  async function refuseBeforeClaim(
    tx: Tx,
    p: {
      cell: CellPrincipal;
      turn: AgentTurnRow;
      body: AgentChannelWorkSessionStart;
      profile: BotProfileRow | null;
      code: BotWorkSessionRefusal;
      reason?: BotProfileInactiveReason;
    },
  ): Promise<BotWorkSessionRefused> {
    const { cell, turn, body } = p;
    await claimToolCall(tx, core, {
      cell,
      turn,
      tool: START,
      flags: WORK_SESSION_TOOL_FLAGS[START],
      web: false,
      sourceKind: "builtin",
      sourceId: null,
      target: body.projectId,
      reason: p.code,
      metadata: { eventId: body.eventId, projectId: body.projectId, promptChars: body.prompt.length },
    });
    await auditBotStart(tx, core, {
      turn,
      auditBase: cellAuditBase(cell),
      outcome: p.code,
      sponsorUserId: p.profile?.sponsorUserId ?? null,
      projectId: body.projectId,
      deviceId: p.profile?.deviceId ?? null,
      promptChars: body.prompt.length,
      ...(p.reason ? { reason: p.reason } : {}),
    });
    return refusedAnswer(p.code, p.reason ? { reason: p.reason } : {});
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
              body,
              profile: null,
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
          const refuse = (code: BotWorkSessionRefusal, reason?: BotProfileInactiveReason) =>
            refuseBeforeClaim(tx, { cell, turn, body, profile, code, ...(reason ? { reason } : {}) });
          if (!turn.tools.includes(START)) return refuse("not_in_turn");
          if (!profile || profile.sponsorUserId !== sponsorUserId) return refuse("profile_inactive");
          const status = await profileStatus(tx, perms, profile);
          if (!status.active) return refuse("profile_inactive", status.reason);

          const claim = await claimToolCall(tx, core, {
            cell,
            turn,
            tool: START,
            flags: WORK_SESSION_TOOL_FLAGS[START],
            web: false,
            sourceKind: "builtin",
            sourceId: null,
            target: body.projectId,
            reason: null,
            metadata,
          });
          if (!claim.allowed) {
            const code: BotWorkSessionRefusal =
              claim.reason === "tainted" ? "outside_content" : "cap_reached";
            await auditBotStart(tx, core, {
              turn,
              auditBase: cellAuditBase(cell),
              outcome: code,
              sponsorUserId,
              projectId: body.projectId,
              deviceId: profile.deviceId,
              promptChars: body.prompt.length,
            });
            return refusedAnswer(code);
          }

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
}
