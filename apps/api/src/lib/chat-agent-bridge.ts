import type { AfterCommit, TenantCtx, Tx } from "@ocw/db";

/**
 * Seam between the chat module (B1) and the agent-channel module (B2) so both can be built in
 * parallel without importing each other. Chat owns messages; agent-channel owns delivery to OpenClaw.
 *
 * - chat calls `emitAgentMention` inside the message transaction whenever a new message mentions one or
 *   more agents (or is posted in a DM/thread where an agent is a member and the message addresses it).
 * - agent-channel registers the handler with `onAgentMention` and appends the delivery event in the
 *   same transaction (so a mention is never lost or delivered for a rolled-back message).
 * - chat provides `postAgentMessage` / `getThreadContext`; agent-channel calls them when OpenClaw replies.
 */

export interface PrincipalRef {
  kind: "user" | "agent" | "system";
  id: string;
  displayName: string;
}

export interface AgentMention {
  organizationId: string;
  conversationId: string;
  /**
   * Root message id of the thread the reply must go to (the message itself when posted at channel level).
   * For `delivery: "dm"` it is the message id (event schema unchanged); the reply is flat.
   */
  threadRootId: string;
  messageId: string;
  agentIds: string[];
  author: PrincipalRef;
  body: string;
  createdAt: string;
  /**
   * `thread`: an @mention in a channel (reply in the thread). `dm`: a message in a direct conversation with
   * the bot (D-04: no mention needed, flat reply, history = the DM itself).
   */
  delivery: "thread" | "dm";
  /**
   * `mention` (default): the bot was addressed (an @mention, or the DM itself). `reply_mode`: nobody was
   * addressed and the candidates are team bots with reply mode `all` (D-12); delivery re-decides the org
   * policy and applies the per-minute cap before metering.
   */
  trigger?: "mention" | "reply_mode";
  /**
   * The asking human's IANA time zone as sent by their client (validated by the contract); used only for the
   * turn's local date and time (D-12). Never stored on the message.
   */
  clientTimeZone?: string | null;
}

export interface ThreadContext {
  conversationId: string;
  threadRootId: string;
  roster: PrincipalRef[];
  /** Oldest first; includes the thread root. */
  history: Array<{ messageId: string; author: PrincipalRef; body: string; createdAt: string }>;
}

export interface PostAgentMessageInput {
  agentId: string;
  conversationId: string;
  threadRootId: string | null;
  body: string;
  /** Idempotency key from the plugin; the same key must not create two messages. */
  idempotencyKey: string;
  /**
   * The message the bot is answering (AgentChannelPostMessage.inReplyToMessageId). When its author is a
   * human, the reply is allowed only while that human may still read the channel (agent ∩ human, the
   * confused-deputy rule). Optional: 02-10 passes it through from the Agent Channel API.
   */
  inReplyToMessageId?: string;
}

export type MentionHandler = (tx: Tx, mention: AgentMention, after: AfterCommit) => Promise<void>;
export type AgentPoster = (
  ctx: TenantCtx,
  input: PostAgentMessageInput,
) => Promise<{ messageId: string; created: boolean }>;
export type ThreadContextProvider = (
  ctx: TenantCtx,
  conversationId: string,
  threadRootId: string,
  limit: number,
) => Promise<ThreadContext>;
export type AgentTyping = (
  ctx: TenantCtx,
  agentId: string,
  conversationId: string,
  threadRootId: string | null,
) => Promise<void>;

export interface ChatAgentBridge {
  onAgentMention(handler: MentionHandler): void;
  emitAgentMention(tx: Tx, mention: AgentMention, after: AfterCommit): Promise<void>;
  providePostAgentMessage(fn: AgentPoster): void;
  postAgentMessage: AgentPoster;
  provideThreadContext(fn: ThreadContextProvider): void;
  getThreadContext: ThreadContextProvider;
  provideAgentTyping(fn: AgentTyping): void;
  agentTyping: AgentTyping;
}

export function createChatAgentBridge(): ChatAgentBridge {
  const handlers: MentionHandler[] = [];
  let poster: AgentPoster | undefined;
  let context: ThreadContextProvider | undefined;
  let typing: AgentTyping | undefined;
  return {
    onAgentMention(h) {
      handlers.push(h);
    },
    async emitAgentMention(tx, mention, after) {
      for (const h of handlers) await h(tx, mention, after);
    },
    providePostAgentMessage(fn) {
      poster = fn;
    },
    postAgentMessage(ctx, input) {
      if (!poster) throw new Error("chat module has not provided postAgentMessage");
      return poster(ctx, input);
    },
    provideThreadContext(fn) {
      context = fn;
    },
    getThreadContext(ctx, conversationId, threadRootId, limit) {
      if (!context) throw new Error("chat module has not provided getThreadContext");
      return context(ctx, conversationId, threadRootId, limit);
    },
    provideAgentTyping(fn) {
      typing = fn;
    },
    async agentTyping(ctx, agentId, conversationId, threadRootId) {
      if (typing) await typing(ctx, agentId, conversationId, threadRootId);
    },
  };
}
