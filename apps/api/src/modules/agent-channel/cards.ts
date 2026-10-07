import {
  AgentCardParams,
  AgentChannelPatchCard,
  AgentChannelPatchCardResponse,
  AgentChannelPostCard,
  AgentChannelPostCardResponse,
} from "@ocw/contracts";
import { conversations, messages, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { App, Core } from "../../core";
import { badRequest, HttpError, notFound } from "../../lib/errors";
import { patchCard } from "../chat";
import { cellOf } from "./auth";

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

/**
 * Where an agent's post lands (shared by `POST /messages` and `POST /cards`): the thread root normalised to its root
 * (single-level threads; it must belong to the conversation, 400 otherwise) and the human the agent answers, when the
 * message it replies to was written by one (the confused-deputy check in chat uses it).
 */
export async function resolveReplyTarget(
  tx: Tx,
  body: {
    conversationId: string;
    threadRootMessageId: string | null;
    inReplyToMessageId?: string | undefined;
  },
): Promise<{ root: string | null; triggeredBy: string | null }> {
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
  let triggeredBy: string | null = null;
  if (body.inReplyToMessageId) {
    const [m] = await tx
      .select({ authorKind: messages.authorKind, authorId: messages.authorId })
      .from(messages)
      .where(eq(messages.id, body.inReplyToMessageId));
    if (m?.authorKind === "user") triggeredBy = m.authorId;
  }
  return { root, triggeredBy };
}

/** `chat_unavailable` when the chat module is not part of this server (the bridge has no poster). */
function chatUnavailable(err: unknown): never {
  if (err instanceof Error && err.message.includes("has not provided")) {
    throw new HttpError(503, "chat_unavailable", "Chat is not available on this server");
  }
  throw err;
}

/** Registers `POST /cards` and `PATCH /cards/:messageId` on the bearer-authenticated Agent Channel scope. */
export function registerCardRoutes(app: App, ctx: { core: Core }): void {
  const { core } = ctx;

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
      const target = await core.db.withTenant({ organizationId: cell.organizationId, userId: null }, (tx) =>
        resolveReplyTarget(tx, {
          conversationId: body.conversationId,
          threadRootMessageId: body.threadRootId,
          inReplyToMessageId: body.inReplyToMessageId,
        }),
      );
      // Chat decides exactly as for a message (agent principal, membership, confused deputy, flat conversations),
      // stores the message and its card in one transaction and audits `agent_card.posted`.
      const result = await core.chatAgent
        .postAgentMessage(
          { organizationId: cell.organizationId, userId: target.triggeredBy },
          {
            agentId: body.agentId,
            conversationId: body.conversationId,
            threadRootId: target.root,
            body: body.card.summary,
            idempotencyKey: body.idempotencyKey,
            inReplyToMessageId: body.inReplyToMessageId,
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
        // RLS scopes the card to the cell's organization: another tenant's card is simply missing (404).
        const { after } = await patchCard(
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
        return { messageId: after.messageId, version: after.version };
      });
    },
  );
}
