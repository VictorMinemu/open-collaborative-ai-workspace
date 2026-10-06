import type { Mention, Message } from "@ocw/contracts";
import type { Tx } from "@ocw/db";

/**
 * Seam between the chat module and the observers of its messages (the notification module, CHAT-08), so chat never
 * imports them (no module cycle). Chat calls `messagePosted` / `messageEdited` inside the message transaction and
 * `conversationRead` inside a read; observers register with `onMessagePosted` / `onMessageEdited` /
 * `onConversationRead` and write in that same transaction, so a rolled-back message never notifies anyone, and an
 * observer error rolls the message back (like the agent bridge).
 */

export interface MessagePostedInput {
  conv: { id: string; kind: "channel" | "dm" | "group"; organizationId: string };
  message: Message;
  author: { kind: "user" | "agent"; id: string };
  /** Server-resolved mentions of the message (users and agents). */
  mentions: Mention[];
  /** `@channel` / `@here` of a channel message, decided and rate-limited by chat (null otherwise). */
  mentionAll: "channel" | "here" | null;
  /** The thread root when the message is a reply. */
  threadRootId: string | null;
}

export interface MessageEditedInput {
  conv: MessagePostedInput["conv"];
  message: Message;
  editorId: string;
  /** The mentions before the edit; only people mentioned now and not before are notified (Pitfall 8). */
  previousMentions: Mention[];
}

/**
 * A member's read cursor moved forward (CHAT-09): messages up to `lastReadSeq` were read. Without `threadRootId` it
 * covers the conversation's top-level messages; with it, the replies of that one thread (its read mark).
 */
export interface ConversationReadInput {
  userId: string;
  conversationId: string;
  lastReadSeq: number;
  threadRootId?: string | null;
}

export type MessagePostedHandler = (tx: Tx, input: MessagePostedInput) => Promise<void>;
export type MessageEditedHandler = (tx: Tx, input: MessageEditedInput) => Promise<void>;
export type ConversationReadHandler = (tx: Tx, input: ConversationReadInput) => Promise<void>;

export interface ChatEvents {
  /** Called by chat inside the message transaction, for every created message (people and bots). */
  messagePosted(tx: Tx, input: MessagePostedInput): Promise<void>;
  /** Called by chat inside the edit transaction. */
  messageEdited(tx: Tx, input: MessageEditedInput): Promise<void>;
  /** Called by chat inside the read transaction (read routes and thread reads; never on mark-unread). */
  conversationRead(tx: Tx, input: ConversationReadInput): Promise<void>;
  onMessagePosted(h: MessagePostedHandler): void;
  onMessageEdited(h: MessageEditedHandler): void;
  onConversationRead(h: ConversationReadHandler): void;
}

export function createChatEvents(): ChatEvents {
  const posted: MessagePostedHandler[] = [];
  const edited: MessageEditedHandler[] = [];
  const read: ConversationReadHandler[] = [];
  return {
    async messagePosted(tx, input) {
      for (const h of posted) await h(tx, input);
    },
    async messageEdited(tx, input) {
      for (const h of edited) await h(tx, input);
    },
    async conversationRead(tx, input) {
      for (const h of read) await h(tx, input);
    },
    onMessagePosted(h) {
      posted.push(h);
    },
    onMessageEdited(h) {
      edited.push(h);
    },
    onConversationRead(h) {
      read.push(h);
    },
  };
}
