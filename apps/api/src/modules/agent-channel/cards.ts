import {
  type AgentCardActionEvent,
  AgentCardParams,
  AgentChannelEventTypes,
  AgentChannelPatchCard,
  AgentChannelPatchCardResponse,
  AgentChannelPostCard,
  AgentChannelPostCardResponse,
  cellTopic,
  type ModelRef,
} from "@ocw/contracts";
import {
  type AfterCommit,
  agentTurns,
  conversations,
  messageCardFollows,
  messageCards,
  messages,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, desc, eq } from "drizzle-orm";
import type { App, Core } from "../../core";
import type { AgentMention, CardAction } from "../../lib/chat-agent-bridge";
import { badRequest, HttpError, notFound } from "../../lib/errors";
import { findAgent } from "../agent";
import { createConversationAccess, patchCard } from "../chat";
import { notifyUsers } from "../notification";
import { createPermissionService, memberDirectory, type PermissionService } from "../organization";
import { cellOf } from "./auth";
import { buildMentionEvents } from "./mentions";

/**
 * Agent Cards on the Agent Channel API (AGENT-04, D-07, P-11). The cell posts a typed card where its agent may post a
 * message (`POST /cards`, the same chat path, rules and idempotency as `POST /messages`, with the card's summary as the
 * body) and updates it in place (`PATCH /cards/:messageId`: only the posting agent, optimistic version). Card content
 * is untrusted model output: the contract bounds every field and refuses any Open target that is not an internal app
 * route. Audits carry ids, kind and status only.
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];
const cellRoute = { config: { authz: "cell" as const } };

async function getConversation(tx: Tx, conversationId: string) {
  const [conv] = await tx.select().from(conversations).where(eq(conversations.id, conversationId));
  if (!conv) throw notFound("Conversation not found", "conversation_not_found");
  return conv;
}

/** 403 `no_trigger`: the post answers no live turn of this agent in this conversation. */
export const noTrigger = () =>
  new HttpError(403, "no_trigger", "This post does not answer a delivered turn of this agent here");

export interface ReplyTarget {
  /** The thread root, normalised to its root (single-level threads). */
  root: string | null;
  /** The human of the delivered turn the post answers (`agent_turns.user_id`); chat re-checks they still read. */
  onBehalfOf: string;
}

/**
 * The delivered turn a post answers (`agent_turns`, written at delivery; RLS keeps it to the cell's organization): the
 * turn named by `eventId`, which must be this agent's, in this conversation, and (when the post names one) for the
 * message it replies to; or, for older cells that send no `eventId`, the latest turn of this agent delivered for
 * `inReplyToMessageId` in this conversation. Null when there is none.
 */
async function findTurn(
  tx: Tx,
  body: {
    agentId: string;
    conversationId: string;
    inReplyToMessageId?: string | undefined;
    eventId?: string | undefined;
  },
): Promise<{ eventId: string; userId: string } | null> {
  const cols = {
    eventId: agentTurns.eventId,
    userId: agentTurns.userId,
    agentId: agentTurns.agentId,
    conversationId: agentTurns.conversationId,
    messageId: agentTurns.messageId,
  };
  if (body.eventId) {
    const [t] = await tx.select(cols).from(agentTurns).where(eq(agentTurns.eventId, body.eventId));
    if (!t || t.agentId !== body.agentId || t.conversationId !== body.conversationId) return null;
    if (body.inReplyToMessageId && body.inReplyToMessageId !== t.messageId) return null;
    return t;
  }
  if (!body.inReplyToMessageId) return null;
  const [t] = await tx
    .select(cols)
    .from(agentTurns)
    .where(
      and(
        eq(agentTurns.agentId, body.agentId),
        eq(agentTurns.conversationId, body.conversationId),
        eq(agentTurns.messageId, body.inReplyToMessageId),
      ),
    )
    .orderBy(desc(agentTurns.createdAt))
    .limit(1);
  return t ?? null;
}

/**
 * Where an agent's post lands and for whom (shared by `POST /messages` and `POST /cards`): the thread root normalised to
 * its root (single-level threads; it must belong to the conversation, 400 otherwise) and the human of the live turn the
 * post answers (`findTurn`). Every post needs that trigger: none → audited `agent.message.refused` and null (the route
 * answers 403 `no_trigger` after this transaction commits, so the audit row stays). Chat then checks the agent and that
 * the turn's human (and a replied-to human) may still read the conversation.
 */
export async function resolveReplyTarget(
  tx: Tx,
  core: Core,
  body: {
    agentId: string;
    conversationId: string;
    threadRootMessageId: string | null;
    inReplyToMessageId?: string | undefined;
    eventId?: string | undefined;
  },
  refusal: { route: "messages" | "cards"; sessionId: string },
): Promise<ReplyTarget | null> {
  const conv = await getConversation(tx, body.conversationId);
  let root: string | null = null;
  if (body.threadRootMessageId) {
    const [m] = await tx
      .select({ id: messages.id, threadId: messages.threadId, conversationId: messages.conversationId })
      .from(messages)
      .where(eq(messages.id, body.threadRootMessageId));
    const inScope =
      m && (m.conversationId === conv.id || (conv.kind === "thread" && conv.rootMessageId === m.id));
    if (!m || !inScope) {
      throw badRequest("The thread root does not belong to this conversation", "invalid_thread_root");
    }
    // Single-level threads: a reply's root is its thread root.
    root = m.threadId ?? m.id;
  }
  const turn = await findTurn(tx, body);
  if (!turn) {
    // Ids only: never the text or the card.
    await core.audit.record(tx, {
      action: "agent.message.refused",
      resourceType: "conversation",
      resourceId: conv.id,
      result: "denied",
      actorKind: "agent",
      actorId: body.agentId,
      agentId: body.agentId,
      clientKind: "agent",
      sessionId: refusal.sessionId,
      metadata: {
        reason: "no_trigger",
        route: refusal.route,
        conversationId: conv.id,
        eventId: body.eventId ?? null,
        inReplyToMessageId: body.inReplyToMessageId ?? null,
      },
    });
    return null;
  }
  return { root, onBehalfOf: turn.userId };
}

/**
 * The agent the cell acts as must be one of its own (the same check as `POST /typing`): the cell's organization is
 * its tenant (one cell per organization), so RLS hides every other organization's bot; a deleted or unknown id is
 * missing too. Runs first in both card routes, before anything about the conversation or the card is revealed.
 */
async function assertCellAgent(tx: Tx, agentId: string): Promise<void> {
  if (!(await findAgent(tx, agentId))) throw notFound("Agent not found in this cell", "agent_not_found");
}

/** `chat_unavailable` when the chat module is not part of this server (the bridge has no poster). */
function chatUnavailable(err: unknown): never {
  if (err instanceof Error && err.message.includes("has not provided")) {
    throw new HttpError(503, "chat_unavailable", "Chat is not available on this server");
  }
  throw err;
}

/** Stored payload; `seq` is injected by the gateway when the frame is sent. */
type StoredCardAction = Omit<AgentCardActionEvent, "seq">;

/**
 * Delivers a reader's decision to the card's agent (P-11), inside the decision transaction: the event is built like a
 * mention of the agent on the card's message (`buildMentionEvents`: live member agent, attributed history, roster,
 * `turnPolicy` for the deciding human, so daily limits apply) with the deciding human as author and the server sentence
 * "<actor> approved|denied “<title>”" as text, in the card's thread (flat where the conversation is flat), then appended
 * to `cell:<org>` as `agent.card_action.v1`. No event when none is produced (disabled agent, daily limit): the decision
 * stands either way.
 */
export async function emitCardAction(
  core: Core,
  tx: Tx,
  a: CardAction,
  opts: {
    after?: AfterCommit;
    perms?: PermissionService;
    modelLabel?: ((ref: ModelRef) => string) | undefined;
  } = {},
): Promise<void> {
  const [card] = await tx.select().from(messageCards).where(eq(messageCards.messageId, a.messageId)).limit(1);
  if (!card) return;
  const [message] = await tx.select().from(messages).where(eq(messages.id, a.messageId)).limit(1);
  if (!message) return;
  const [conv] = await tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, message.conversationId))
    .limit(1);
  if (!conv) return;
  const { organizationId } = tenantOf(tx);
  const name = (await memberDirectory(tx)).get(a.actorUserId)?.displayName ?? "Former member";
  const flat = conv.kind === "dm" || conv.kind === "group" || conv.kind === "ai_chat";
  const mention: AgentMention = {
    organizationId,
    conversationId: conv.id,
    threadRootId: flat ? message.id : (message.threadId ?? message.id),
    messageId: message.id,
    agentIds: [card.agentId],
    author: { kind: "user", id: a.actorUserId, displayName: name },
    body: `${name} ${a.outcome} “${card.title}”`,
    createdAt: new Date().toISOString(),
    delivery: flat ? "dm" : "thread",
  };
  const events = await buildMentionEvents(tx, mention, {
    core,
    perms: opts.perms ?? createPermissionService(core),
    ...(opts.after ? { after: opts.after } : {}),
    modelLabel: opts.modelLabel,
  });
  for (const ev of events) {
    const payload: StoredCardAction = {
      ...ev,
      type: AgentChannelEventTypes.cardAction,
      cardAction: { messageId: card.messageId, kind: card.kind, title: card.title, outcome: a.outcome },
    };
    await core.realtime.appendEvent(
      tx,
      cellTopic(organizationId),
      AgentChannelEventTypes.cardAction,
      payload,
      {
        actorUserId: a.actorUserId,
      },
    );
  }
}

/** Registers the chat → agent-channel card decision handler (the bridge keeps chat from importing this module). */
export function registerCardActionHandler(
  core: Core,
  opts: { perms: PermissionService; modelLabel?: ((ref: ModelRef) => string) | undefined },
): void {
  core.chatAgent.onCardAction((tx, action, after) => emitCardAction(core, tx, action, { ...opts, after }));
}

/** Registers `POST /cards` and `PATCH /cards/:messageId` on the bearer-authenticated Agent Channel scope. */
export function registerCardRoutes(app: App, ctx: { core: Core }): void {
  const { core } = ctx;
  const access = createConversationAccess(core);

  app.post(
    "/cards",
    {
      ...cellRoute,
      schema: {
        tags,
        security: bearer,
        body: AgentChannelPostCard,
        response: { 200: AgentChannelPostCardResponse, 201: AgentChannelPostCardResponse },
      },
    },
    async (req, reply) => {
      const cell = cellOf(req);
      const body = req.body;
      const target = await core.db.withTenant(
        { organizationId: cell.organizationId, userId: null },
        async (tx) => {
          await assertCellAgent(tx, body.agentId);
          return resolveReplyTarget(
            tx,
            core,
            {
              agentId: body.agentId,
              conversationId: body.conversationId,
              threadRootMessageId: body.threadRootId,
              inReplyToMessageId: body.inReplyToMessageId,
              eventId: body.eventId,
            },
            { route: "cards", sessionId: `cell:${cell.credentialId}` },
          );
        },
      );
      if (!target) throw noTrigger();
      // Chat decides exactly as for a message (agent principal, membership, confused deputy for the turn's human, flat
      // conversations), stores the message and its card in one transaction and audits `agent_card.posted`.
      const result = await core.chatAgent
        .postAgentMessage(
          { organizationId: cell.organizationId, userId: target.onBehalfOf },
          {
            agentId: body.agentId,
            conversationId: body.conversationId,
            threadRootId: target.root,
            body: body.card.summary,
            idempotencyKey: body.idempotencyKey,
            inReplyToMessageId: body.inReplyToMessageId,
            onBehalfOfUserId: target.onBehalfOf,
            card: body.card,
          },
        )
        .catch(chatUnavailable);
      reply.code(result.created ? 201 : 200);
      return { messageId: result.messageId, created: result.created, version: result.cardVersion ?? 1 };
    },
  );

  app.patch(
    "/cards/:messageId",
    {
      ...cellRoute,
      schema: {
        tags,
        security: bearer,
        params: AgentCardParams,
        body: AgentChannelPatchCard,
        response: { 200: AgentChannelPatchCardResponse },
      },
    },
    async (req) => {
      const cell = cellOf(req);
      const { agentId, patch } = req.body;
      return core.db.withTenant({ organizationId: cell.organizationId, userId: null }, async (tx) => {
        await assertCellAgent(tx, agentId);
        // RLS scopes the card to the cell's organization: another tenant's card is simply missing (404); a card of
        // another agent of this cell is 403 `not_card_author` (patchCard).
        const { before, after } = await patchCard(
          tx,
          { audit: core.audit, realtime: core.realtime },
          { messageId: req.params.messageId, agentId, patch },
        );
        await core.audit.record(tx, {
          action: "agent_card.updated",
          resourceType: "message",
          resourceId: after.messageId,
          actorKind: "agent",
          actorId: agentId,
          agentId,
          clientKind: "agent",
          metadata: {
            messageId: after.messageId,
            conversationId: after.conversationId,
            agentId,
            kind: after.kind,
            status: after.status,
            version: after.version,
          },
        });
        // Followers hear about status changes only (a fields, title or summary change notifies nobody).
        if (before.status !== after.status) {
          const followers = await tx
            .select({ userId: messageCardFollows.userId })
            .from(messageCardFollows)
            .where(eq(messageCardFollows.messageId, after.messageId));
          await notifyUsers(
            tx,
            { core, access },
            {
              kind: "card_updated",
              conversationId: after.conversationId,
              messageId: after.messageId,
              actor: { kind: "agent", id: agentId },
              userIds: followers.map((f) => f.userId),
            },
          );
        }
        return { messageId: after.messageId, version: after.version };
      });
    },
  );
}
