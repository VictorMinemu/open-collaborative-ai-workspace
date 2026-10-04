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
  /** Root message id of the thread the reply must go to (the message itself when posted at channel level). */
  threadRootId: string;
  messageId: string;
  agentIds: string[];
  author: PrincipalRef;
  body: string;
  createdAt: string;
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
