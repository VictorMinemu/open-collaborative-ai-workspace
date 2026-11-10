import {
  AgentChannelBoardCardResponse,
  AgentChannelBoardCreateCard,
  AgentChannelBoardPatchCard,
  AgentChannelBoardRead,
  AgentChannelBoardReadResponse,
  BUILTIN_TOOLS,
  Id,
  MAX_TOOL_CALLS_PER_TURN,
} from "@ocw/contracts";
import {
  agentTurns,
  automationConversations,
  automations,
  boards,
  conversations,
  messages,
  type Tx,
} from "@ocw/db";
import { and, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { App, Core } from "../../core";
import { badRequest, forbidden, HttpError } from "../../lib/errors";
import {
  type AgentBoardActor,
  type ConversationRow,
  createBoardCard,
  readAgentBoard,
  updateBoardCard,
} from "../chat";
import { AuthzDeniedError, type PermissionService } from "../organization";
import { loadBotProfile } from "../work-session";
import { type CellPrincipal, cellOf } from "./auth";
import { noTrigger } from "./cards";

/**
 * The Agent Channel board API (07.1-10, BOARD-02, BOARD-04, D-07, D-08, C-01, P-03). On a board channel's turn the cell
 * reads the board, creates a card in it, moves a card and sets its waiting state; it never edits card text. The request
 * names only the delivered turn (`eventId`) and the agent: the conversation and the human always come from
 * `agent_turns` (RLS keeps it to the cell's organization), so a model can never pick another board or another person.
 *
 * Every call runs in two transactions:
 *   1. the turn gate, committed whatever follows: the turn must be this agent's (403 `no_trigger`, the rule of every
 *      agent post), offer `ocw_board_card` (403 `not_in_turn`) and be a board's (400 `not_a_board`); ONE conditional
 *      UPDATE then counts the call unless the turn is tainted (403 `tainted`) or at its tool cap (403 `cap_reached`).
 *      Phase 07.17 D-06 / D-12: a move or waiting change (PATCH) of the card this bot's automation opened, from a turn
 *      in its thread, is counted despite the taint or the session-output mark when the bot's profile allows acting on
 *      outside content (`openedCardExemption`); create and read never are;
 *   2. the act, in chat: the agent and the agent acting for the turn's human must both hold the grain on this channel
 *      now (the confused-deputy rule), then the board write, its event and its audit (`actorKind: agent`, the human).
 * Every refusal is audited (`agent.board.refused`, ids and reasons only; the resolver's own denials as `authz.denied`).
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];
const cellRoute = { config: { authz: "cell" as const } };

const BoardCardParams = z.object({ messageId: Id });

type BoardRoute = "read" | "create" | "update";
export type BoardTurnRefusal = "no_trigger" | "not_in_turn" | "not_a_board" | "tainted" | "cap_reached";

const REFUSED: Record<BoardTurnRefusal, () => HttpError> = {
  no_trigger: noTrigger,
  not_in_turn: () => new HttpError(403, "not_in_turn", "The board tool was not offered on this turn"),
  not_a_board: () => badRequest("This turn's conversation is not a board", "not_a_board"),
  tainted: () =>
    new HttpError(403, "tainted", "This turn read untrusted content and can no longer change the board"),
  cap_reached: () => new HttpError(403, "cap_reached", "This turn reached its tool call limit"),
};

/** What the D-06 / D-12 exemption lifted for this call, recorded on the move's own audit (booleans only). */
type BoardAuditFlags = { outsideContent?: true; sessionOutputExempt?: true };

/** The parts of a delivered turn the board routes act on. */
interface BoardTurn {
  eventId: string;
  agentId: string;
  userId: string;
  conversationId: string;
  messageId: string;
}

/** Card text an agent may not send on a move (P-03): recorded before the schema strips unknown keys. */
const TEXT_KEYS = ["title", "description", "fields"] as const;

async function auditRefusal(
  tx: Tx,
  core: Core,
  cell: CellPrincipal,
  p: {
    route: BoardRoute;
    reason: string;
    eventId: string;
    turn: BoardTurn | null;
    messageId?: string | undefined;
  },
): Promise<void> {
  const { turn } = p;
  // Ids and reasons only: never a title, a description or a field value.
  await core.audit.record(tx, {
    action: "agent.board.refused",
    resourceType: "conversation",
    resourceId: turn?.conversationId ?? null,
    result: "denied",
    actorKind: turn ? "agent" : "system",
    actorId: turn?.agentId ?? null,
    agentId: turn?.agentId ?? null,
    userId: turn?.userId ?? null,
    clientKind: "agent",
    sessionId: `cell:${cell.credentialId}`,
    metadata: {
      route: p.route,
      reason: p.reason,
      eventId: p.eventId,
      conversationId: turn?.conversationId ?? null,
      messageId: p.messageId ?? null,
    },
  });
}

/**
 * Phase 07.17 D-06 / D-12 (PD-11, ADR-0039, superseding ADR-0022 decision 6 for this case): may a tainted or
 * session-read turn still move `cardMessageId` and set its waiting state? Only when ALL hold: (1) the card is the turn
 * thread's card (the root of the turn's message, `readAgentBoard`'s rule) in the turn's conversation; (2) an
 * `automation_conversations` row of THIS bot's automation opened it (RLS keeps both rows to the cell's organization);
 * (3) the bot's Work Zone profile has `actOnOutsideContent`, set by an admin (BWZ-05). The server is the authority; the
 * plugin's local guard only mirrors it. Never consulted for create, read or card text (P-03).
 */
export async function openedCardExemption(
  tx: Tx,
  p: { agentId: string; conversationId: string; turnMessageId: string; cardMessageId: string },
): Promise<boolean> {
  const [message] = await tx
    .select({ id: messages.id, threadId: messages.threadId, conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.id, p.turnMessageId))
    .limit(1);
  if (!message || message.conversationId !== p.conversationId) return false;
  if ((message.threadId ?? message.id) !== p.cardMessageId) return false;
  const [openedByBot] = await tx
    .select({ id: automationConversations.id })
    .from(automationConversations)
    .innerJoin(
      automations,
      and(
        eq(automations.organizationId, automationConversations.organizationId),
        eq(automations.id, automationConversations.automationId),
      ),
    )
    .where(
      and(
        eq(automationConversations.rootMessageId, p.cardMessageId),
        eq(automationConversations.conversationId, p.conversationId),
        eq(automations.agentId, p.agentId),
      ),
    )
    .limit(1);
  if (!openedByBot) return false;
  return (await loadBotProfile(tx, p.agentId))?.actOnOutsideContent === true;
}

/**
 * Transaction 1, the turn gate (the `saveMemory` order): the delivered turn of this agent, the tool on it, a board, and
 * the call counted against the turn in ONE statement that also checks the taint (a web call authorised concurrently on
 * the same turn lands either before, and this call is refused, or after this call was decided).
 */
async function gateTurn(
  tx: Tx,
  core: Core,
  cell: CellPrincipal,
  p: { route: BoardRoute; eventId: string; agentId: string; messageId?: string | undefined },
): Promise<{ turn: BoardTurn; auditFlags: BoardAuditFlags } | { refused: BoardTurnRefusal }> {
  const [row] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, p.eventId));
  const known = row && row.agentId === p.agentId ? row : null;
  const turn: BoardTurn | null = known
    ? {
        eventId: known.eventId,
        agentId: known.agentId,
        userId: known.userId,
        conversationId: known.conversationId,
        messageId: known.messageId,
      }
    : null;
  const refuse = async (reason: BoardTurnRefusal) => {
    await auditRefusal(tx, core, cell, { ...p, reason, turn });
    return { refused: reason };
  };

  // Unknown, another organization's (RLS hides it) or another agent's delivery: this call answers no turn of it.
  if (!known || !turn) return refuse("no_trigger");
  if (!known.tools.includes(BUILTIN_TOOLS.boardCard)) return refuse("not_in_turn");
  const [conv] = await tx
    .select({ kind: conversations.kind, layout: conversations.layout })
    .from(conversations)
    .where(eq(conversations.id, known.conversationId))
    .limit(1);
  const [board] = await tx
    .select({ id: boards.conversationId })
    .from(boards)
    .where(eq(boards.conversationId, known.conversationId))
    .limit(1);
  if (conv?.kind !== "channel" || conv.layout !== "board" || !board) return refuse("not_a_board");

  // 07.17 D-06 / D-12: only a PATCH (move or waiting; the body cannot carry text) of the exempt card skips the taint
  // and session-output conditions; the tool cap stays in the same statement.
  const exempt =
    p.route === "update" &&
    p.messageId !== undefined &&
    (known.tainted || known.sessionOutputRead) &&
    (await openedCardExemption(tx, {
      agentId: known.agentId,
      conversationId: known.conversationId,
      turnMessageId: known.messageId,
      cardMessageId: p.messageId,
    }));
  const counted = await tx
    .update(agentTurns)
    .set({ toolCalls: sql`${agentTurns.toolCalls} + 1` })
    .where(
      exempt
        ? and(eq(agentTurns.eventId, known.eventId), lt(agentTurns.toolCalls, MAX_TOOL_CALLS_PER_TURN))
        : and(
            eq(agentTurns.eventId, known.eventId),
            eq(agentTurns.tainted, false),
            // 07.16 D-20 (PD-15): after a Work Zone session read the turn changes nothing else (the claim's rule).
            eq(agentTurns.sessionOutputRead, false),
            lt(agentTurns.toolCalls, MAX_TOOL_CALLS_PER_TURN),
          ),
    )
    .returning({ tainted: agentTurns.tainted, sessionOutputRead: agentTurns.sessionOutputRead });
  const [count] = counted;
  if (!count) {
    if (exempt) return refuse("cap_reached");
    const [after] = await tx
      .select({ tainted: agentTurns.tainted, sessionOutputRead: agentTurns.sessionOutputRead })
      .from(agentTurns)
      .where(eq(agentTurns.eventId, known.eventId));
    return refuse(after?.tainted || after?.sessionOutputRead ? "tainted" : "cap_reached");
  }
  // The marks as the counting statement saw them (one set concurrently is still recorded).
  const auditFlags: BoardAuditFlags = exempt
    ? {
        ...(count.tainted ? { outsideContent: true as const } : {}),
        ...(count.sessionOutputRead ? { sessionOutputExempt: true as const } : {}),
      }
    : {};
  return { turn, auditFlags };
}

/** Registers `POST /board/read`, `POST /board/cards` and `PATCH /board/cards/:messageId` on the cell scope. */
export function registerBoardAgentRoutes(app: App, ctx: { core: Core; perms: PermissionService }): void {
  const { core, perms } = ctx;
  const deps = { audit: core.audit, realtime: core.realtime };
  const namesText = new WeakMap<object, boolean>();

  /** Gate (committed), then act as the turn's agent for the turn's human; a refusal from chat is audited too. */
  async function onTurn<T>(
    cell: CellPrincipal,
    p: { route: BoardRoute; eventId: string; agentId: string; messageId?: string | undefined },
    act: (
      tx: Tx,
      turn: BoardTurn,
      conv: ConversationRow,
      actor: AgentBoardActor,
      auditFlags: BoardAuditFlags,
    ) => Promise<T>,
  ): Promise<T> {
    const tenant = { organizationId: cell.organizationId };
    const gate = await core.db.withTenant({ ...tenant, userId: null }, (tx) => gateTurn(tx, core, cell, p));
    if ("refused" in gate) throw REFUSED[gate.refused]();
    const { turn, auditFlags } = gate;
    try {
      // The tenant user is the turn's human, so every audit row of the act carries who the agent answered.
      return await core.db.withTenant({ ...tenant, userId: turn.userId }, async (tx) => {
        const [conv] = await tx
          .select()
          .from(conversations)
          .where(eq(conversations.id, turn.conversationId))
          .limit(1);
        if (!conv) throw REFUSED.not_a_board();
        return act(
          tx,
          turn,
          conv,
          { kind: "agent", id: turn.agentId, onBehalfOfUserId: turn.userId },
          auditFlags,
        );
      });
    } catch (err) {
      // The resolver's denials are audited by the error handler (`authz.denied`); every other refusal here.
      if (err instanceof HttpError && !(err instanceof AuthzDeniedError)) {
        await core.db.withTenant({ ...tenant, userId: turn.userId }, (tx) =>
          auditRefusal(tx, core, cell, { ...p, reason: err.code, turn }),
        );
      }
      throw err;
    }
  }

  app.post(
    "/board/read",
    {
      ...cellRoute,
      schema: {
        tags,
        security: bearer,
        body: AgentChannelBoardRead,
        response: { 200: AgentChannelBoardReadResponse },
      },
    },
    async (req) => {
      const { eventId, agentId } = req.body;
      return onTurn(cellOf(req), { route: "read", eventId, agentId }, (tx, turn, conv, actor) =>
        readAgentBoard(tx, perms, { conv, actor, turnMessageId: turn.messageId }),
      );
    },
  );

  app.post(
    "/board/cards",
    {
      ...cellRoute,
      schema: {
        tags,
        security: bearer,
        body: AgentChannelBoardCreateCard,
        response: { 200: AgentChannelBoardCardResponse, 201: AgentChannelBoardCardResponse },
      },
    },
    async (req, reply) => {
      const body = req.body;
      const { card, created } = await onTurn(
        cellOf(req),
        { route: "create", eventId: body.eventId, agentId: body.agentId },
        async (tx, _turn, conv, actor) => {
          const out = await createBoardCard(tx, deps, {
            conv,
            author: actor,
            input: {
              ...(body.title !== undefined ? { title: body.title } : {}),
              description: body.description,
              ...(body.columnId !== undefined ? { columnId: body.columnId } : {}),
              ...(body.waitingOn !== undefined ? { waitingOn: body.waitingOn } : {}),
              // At-least-once delivery: the agent's key, in its own namespace (a reply or an Agent Card never collides).
              clientMessageId: `board:${body.idempotencyKey}`,
            },
            clientKind: "agent",
            perms,
          });
          if (out.created) {
            // Observers (notifications of mentioned people) as for any agent post; an agent never wakes other agents.
            await core.chatEvents.messagePosted(tx, {
              conv: { id: conv.id, kind: "channel", organizationId: conv.organizationId },
              message: out.result.message,
              author: { kind: "agent", id: actor.id },
              mentions: out.result.row.mentions,
              mentionAll: null,
              threadRootId: null,
            });
          }
          return out;
        },
      );
      reply.code(created ? 201 : 200);
      return { card };
    },
  );

  app.patch(
    "/board/cards/:messageId",
    {
      ...cellRoute,
      // Card text is the human author's (P-02, P-03): remember whether the raw body named any before the schema strips it.
      preValidation: async (req) => {
        const raw = req.body;
        namesText.set(
          req,
          typeof raw === "object" && raw !== null && TEXT_KEYS.some((k) => Object.hasOwn(raw, k)),
        );
      },
      schema: {
        tags,
        security: bearer,
        params: BoardCardParams,
        body: AgentChannelBoardPatchCard,
        response: { 200: AgentChannelBoardCardResponse },
      },
    },
    async (req) => {
      const body = req.body;
      const messageId = req.params.messageId;
      const card = await onTurn(
        cellOf(req),
        { route: "update", eventId: body.eventId, agentId: body.agentId, messageId },
        (tx, _turn, conv, actor, auditFlags) => {
          if (namesText.get(req)) throw forbidden("Agents do not edit card text", "not_author");
          return updateBoardCard(tx, deps, {
            conv,
            messageId,
            actor,
            input: {
              expectedVersion: body.expectedVersion,
              ...(body.move !== undefined ? { move: body.move } : {}),
              ...(body.waitingOn !== undefined ? { waitingOn: body.waitingOn } : {}),
            },
            perms,
            ...(Object.keys(auditFlags).length > 0 ? { auditFlags } : {}),
          });
        },
      );
      return { card };
    },
  );
}
