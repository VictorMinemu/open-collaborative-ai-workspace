import { AgentCardInput, isAgentCardRoute } from "@ocw/contracts";
import { agents, conversations, messages } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { Core } from "../../core";
import type { AgentTurnRow } from "./claim";

/**
 * The "Connect your account" card (07.4-12; CONN-04, SC2; 07.4-UI-SPEC § 5, R8): when a member asks a bot to use a
 * per-member connector they have not connected (or must reconnect), the platform posts one card as the bot in the same
 * conversation and thread, with an Open action to Settings › Connections and a `return` route back to the chat. The card
 * is composed by the server and platform-owned (07.2 D-08): no bot can rewrite it into a phishing link. One per (turn,
 * connector): the idempotency key is `connect:<eventId>:<serverId>`. Posting never changes the proxy's answer.
 */

export type ConnectCardReason = "not_connected" | "needs_reconnect";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * The chat route of a turn's conversation, the way the web app builds permalinks (`apps/web/lib/permalink.ts`): a
 * channel message in its thread, a DM or group DM message, an AI chat. Ids only; null when anything is not an id.
 */
export function chatRouteOf(p: {
  kind: string;
  conversationId: string;
  parentConversationId: string | null;
  rootMessageId: string | null;
  messageId: string;
  messageThreadId: string | null;
}): string | null {
  const ids = [p.conversationId, p.messageId, p.parentConversationId, p.rootMessageId, p.messageThreadId];
  if (ids.some((id) => id !== null && !UUID.test(id))) return null;
  switch (p.kind) {
    case "channel":
      return `/chat/${p.conversationId}?thread=${p.messageThreadId ?? p.messageId}&m=${p.messageId}`;
    case "thread":
      return p.parentConversationId && p.rootMessageId
        ? `/chat/${p.parentConversationId}?thread=${p.rootMessageId}&m=${p.messageId}`
        : null;
    case "dm":
    case "group":
      return `/chat/dm/${p.conversationId}?m=${p.messageId}`;
    case "ai_chat":
      return `/chat/ai/${p.conversationId}`;
    default:
      return null;
  }
}

/** Settings › Connections for this connector, with the encoded way back when the whole route stays a card route. */
export function connectTarget(serverId: string, chatRoute: string | null): string {
  const base = `/settings/connections?connector=${encodeURIComponent(serverId)}`;
  if (!chatRoute) return base;
  const withReturn = `${base}&return=${encodeURIComponent(chatRoute)}`;
  return isAgentCardRoute(withReturn) ? withReturn : base;
}

/** The card itself (UI-SPEC § 5, Copywriting › Chat): server-composed copy, status `info`, one field, one Open action. */
export function connectCard(p: {
  reason: ConnectCardReason;
  botName: string;
  connectorName: string;
  target: string;
}): AgentCardInput {
  const reconnect = p.reason === "needs_reconnect";
  return AgentCardInput.parse({
    kind: "generic",
    status: "info",
    title: `${reconnect ? "Reconnect" : "Connect"} your ${p.connectorName} account`,
    fields: [
      reconnect
        ? {
            label: "What happened",
            value: `Your ${p.connectorName} sign-in stopped working. Reconnect, then ask again.`,
          }
        : {
            label: "How it works",
            value: `${p.botName} uses your account only when you ask. Results stay in your private chats unless you allow a conversation.`,
          },
    ],
    actions: [{ kind: "open", label: reconnect ? "Reconnect" : "Connect", target: p.target }],
    summary: `${p.botName} needs your ${p.connectorName} account to do this. Connect it once in Settings, then ask again.`,
  });
}

/**
 * Posts the connect (or reconnect) card for the turn's human in the turn's conversation and thread, as the turn's bot,
 * through chat's agent path (the same membership and confused-deputy checks as any bot post). Idempotent per (turn,
 * connector). Never throws: a card that cannot be posted (the bot left, the conversation was archived) changes nothing
 * about the refusal the cell receives.
 */
export async function postConnectCard(
  core: Core,
  p: {
    organizationId: string;
    turn: AgentTurnRow;
    server: { id: string; name: string };
    reason: ConnectCardReason;
  },
): Promise<void> {
  const { turn } = p;
  try {
    const ctx = { organizationId: p.organizationId, userId: turn.userId };
    const facts = await core.db.withTenant(ctx, async (tx) => {
      const [bot] = await tx.select({ name: agents.name }).from(agents).where(eq(agents.id, turn.agentId));
      const [conv] = await tx
        .select({
          kind: conversations.kind,
          parentConversationId: conversations.parentConversationId,
          rootMessageId: conversations.rootMessageId,
        })
        .from(conversations)
        .where(eq(conversations.id, turn.conversationId));
      const [message] = await tx
        .select({ threadId: messages.threadId })
        .from(messages)
        .where(eq(messages.id, turn.messageId));
      return bot && conv ? { bot, conv, message: message ?? null } : null;
    });
    if (!facts) return;
    const route = chatRouteOf({
      kind: facts.conv.kind,
      conversationId: turn.conversationId,
      parentConversationId: facts.conv.parentConversationId,
      rootMessageId: facts.conv.rootMessageId,
      messageId: turn.messageId,
      messageThreadId: facts.message?.threadId ?? null,
    });
    const card = connectCard({
      reason: p.reason,
      botName: facts.bot.name,
      connectorName: p.server.name,
      target: connectTarget(p.server.id, route),
    });
    await core.chatAgent.postAgentMessage(ctx, {
      agentId: turn.agentId,
      conversationId: turn.conversationId,
      // Flat conversations (DMs, group DMs, AI chats) ignore it; a channel turn answers in the asker's thread.
      threadRootId: turn.messageId,
      body: card.summary,
      idempotencyKey: `connect:${turn.eventId}:${p.server.id}`,
      inReplyToMessageId: turn.messageId,
      onBehalfOfUserId: turn.userId,
      card,
      cardPlatformOwned: true,
    });
  } catch (err) {
    // A code only: the card is a courtesy, the 409 already tells the cell what happened.
    core.log.warn(
      { serverId: p.server.id, eventId: turn.eventId, code: (err as { code?: string })?.code ?? "error" },
      "connect card not posted",
    );
  }
}
