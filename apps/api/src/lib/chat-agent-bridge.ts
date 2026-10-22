import type {
  AgentCardApprovalLink,
  AgentCardInput,
  ApprovalRequestStatus,
  ApprovalSummary,
} from "@ocw/contracts";
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
 * - Agent Cards (06-13, P-11): `postAgentMessage({card})` stores a card with the message; when a reader decides a card,
 *   chat calls `emitCardAction` inside the decision transaction and agent-channel (its `onCardAction` handler) appends
 *   the `agent.card_action.v1` delivery in the same transaction.
 * - Platform-owned cards (07.2-06, ADR-0023): the approval module posts its mirror cards through `postAgentMessageIn`
 *   (inside its own transaction) and registers `registerLinkedCards`, so chat shows and decides a card linked to an
 *   approval through the primitive without importing the approval module. No registration = no linked cards.
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
  /**
   * The human of the delivered turn the post answers (`agent_turns.user_id`, resolved by the Agent Channel API). Checked
   * like the replied-to human, whatever kind of message the post answers (a card decision answers the agent's own card):
   * the post is allowed only while that human may still read the conversation.
   */
  onBehalfOfUserId?: string;
  /**
   * An Agent Card (06-13, P-11): `body` is its plain-text summary; the card row is inserted in the message transaction
   * (version 1, this agent) and `message.created` carries it.
   */
  card?: AgentCardInput;
  /**
   * Phase 07.2 (D-08): the card is composed by the server (an approval mirror), not by the agent; the agent can never
   * PATCH it (403 `card_platform_owned`).
   */
  cardPlatformOwned?: boolean;
  /**
   * Phase 07.8 (07.8-10): runs in the post's transaction right after the message row is inserted and before its
   * `message.created` is appended (the Agent Channel attaches the turn's activity and links the files the bot shared in
   * that turn to this reply). Not called on an idempotent retry.
   */
  onInserted?: (tx: Tx, messageId: string) => Promise<void>;
}

/** A reader's single decision on an Agent Card (06-13): delivered to the card's agent as `agent.card_action.v1`. */
export interface CardAction {
  messageId: string;
  outcome: "approved" | "denied";
  actorUserId: string;
  /** The decider's note (UI-SPEC R4), quoted in the agent's turn. */
  note?: string | undefined;
  /**
   * Phase 07.5 (P-06, ADR-0020 extension for `grant` approval kinds only): the human the turn is delivered for (the
   * request's `requested_for_user_id`), so tools, credentials and the daily limit are the asker's. Absent = the decider
   * (`actorUserId`), as for every plain Agent Card. When set, that human must still read the conversation, otherwise
   * no turn is delivered (never a fallback to the decider).
   */
  turnUserId?: string | undefined;
  /** Who decided, named in the payload (`cardAction.decidedBy`) because the turn's human may be someone else. */
  decidedBy?: { id: string; displayName: string } | undefined;
  /** An approved grant: the one call the bot may now make (`cardAction.grant`). */
  grant?: { tool: string; arguments: string; useBy: string } | undefined;
  /** The request came from a tainted turn: the re-run turn starts tainted (set in the same transaction). */
  tainted?: boolean | undefined;
  /**
   * 07.5-11: an approved `server_apply` request whose apply failed: the kind's result code (`cardAction.resultCode`), so
   * the bot hears what went wrong, not only "approved".
   */
  resultCode?: string | undefined;
}

/** The approval a platform-owned card mirrors, as chat shows it (no viewer fields): the 07.2 link. */
interface LinkedCardBase {
  id: string;
  actionHash: string;
  status: ApprovalRequestStatus;
  requestedForUserId: string | null;
  warnings: string[];
  /** Why an approved request failed to apply (the kind's code), null otherwise. */
  resultCode: string | null;
}

/**
 * Phase 07.5 (UI-SPEC R6, R7, R9): what a kind with a `link` hook adds (the request's kind, expiry and use time, plus
 * the kind's own fields). Every reader gets the same values, so they may ride realtime events; never an argument value.
 */
export type LinkedCardInfo = LinkedCardBase &
  Partial<
    Pick<
      AgentCardApprovalLink,
      | "kind"
      | "expiresAt"
      | "usedAt"
      | "display"
      | "useBy"
      | "waitingFor"
      | "actionFields"
      | "deviceId"
      | "resultRoute"
      | "blocked"
      | "browser"
    >
  >;

/** Registered by the approval module: chat asks it about cards that mirror an approval. */
export interface LinkedCards {
  /** The approval of each linked card among `messageIds` (cards that mirror none are absent). */
  linkOf(tx: Tx, messageIds: readonly string[]): Promise<Map<string, LinkedCardInfo>>;
  /** The linked cards among `messageIds` whose approval `userId` may decide now (the kind's live rule). */
  canDecide(tx: Tx, messageIds: readonly string[], userId: string): Promise<Set<string>>;
  /** Decides the approval a card mirrors, in the caller's transaction (the primitive's decision, then the mirror). */
  decide(
    tx: Tx,
    input: {
      messageId: string;
      deciderUserId: string;
      outcome: "approved" | "denied";
      actionHash: string;
      note?: string | undefined;
    },
  ): Promise<ApprovalSummary>;
}

export type CardActionHandler = (tx: Tx, action: CardAction, after: AfterCommit) => Promise<void>;

export type MentionHandler = (tx: Tx, mention: AgentMention, after: AfterCommit) => Promise<void>;
export type AgentPoster = (
  ctx: TenantCtx,
  input: PostAgentMessageInput,
) => Promise<{
  messageId: string;
  created: boolean /** The card's current version, for card posts. */;
  cardVersion?: number;
}>;
/** `postAgentMessage` inside the caller's transaction (same checks, same events, same audit). */
export type AgentPosterIn = (
  tx: Tx,
  input: PostAgentMessageInput,
) => Promise<{ messageId: string; created: boolean; cardVersion?: number }>;
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
  providePostAgentMessageIn(fn: AgentPosterIn): void;
  postAgentMessageIn: AgentPosterIn;
  provideThreadContext(fn: ThreadContextProvider): void;
  getThreadContext: ThreadContextProvider;
  provideAgentTyping(fn: AgentTyping): void;
  agentTyping: AgentTyping;
  onCardAction(handler: CardActionHandler): void;
  emitCardAction(tx: Tx, action: CardAction, after: AfterCommit): Promise<void>;
  registerLinkedCards(provider: LinkedCards): void;
  /** The registered provider, or null (then no card is linked and nothing is decided through it). */
  linkedCards(): LinkedCards | null;
}

export function createChatAgentBridge(): ChatAgentBridge {
  const handlers: MentionHandler[] = [];
  const cardHandlers: CardActionHandler[] = [];
  let poster: AgentPoster | undefined;
  let posterIn: AgentPosterIn | undefined;
  let linked: LinkedCards | null = null;
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
    providePostAgentMessageIn(fn) {
      posterIn = fn;
    },
    postAgentMessageIn(tx, input) {
      if (!posterIn) throw new Error("chat module has not provided postAgentMessageIn");
      return posterIn(tx, input);
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
    onCardAction(h) {
      cardHandlers.push(h);
    },
    async emitCardAction(tx, action, after) {
      for (const h of cardHandlers) await h(tx, action, after);
    },
    registerLinkedCards(provider) {
      linked = provider;
    },
    linkedCards: () => linked,
  };
}
