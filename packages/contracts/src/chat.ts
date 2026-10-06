import { z } from "zod";
import { AgentScope, AgentStatus } from "./agent";
import { AiGeneration } from "./ai-generation";
import { Attachment, MAX_ATTACHMENTS_PER_MESSAGE } from "./attachments";
import { ClientKind, Id, IsoDateTime, isReservedHandle, MemberKind, PrincipalKind } from "./common";
import { Permission, UnitKind } from "./permissions";

export { isReservedHandle, RESERVED_HANDLES } from "./common";

/** Unified conversation model. Every conversational surface is a conversation of one of these kinds. */
export const ConversationKind = z.enum(["channel", "dm", "group", "ai_chat", "thread", "work_session"]);
export type ConversationKind = z.infer<typeof ConversationKind>;

export const Visibility = z.enum(["public", "private"]);
export type Visibility = z.infer<typeof Visibility>;

export const Conversation = z.object({
  id: Id,
  organizationId: Id,
  kind: ConversationKind,
  name: z.string().nullable(),
  slug: z.string().nullable(),
  topic: z.string().nullable(),
  visibility: Visibility,
  /** For kind `thread`: the channel. */
  parentConversationId: Id.nullable(),
  /** For kind `thread`: the channel message that started the thread. */
  rootMessageId: Id.nullable(),
  createdBy: Id.nullable(),
  archivedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  /** Last durable seq of the `conv:<id>` stream; subscribe with afterSeq = lastSeq. */
  lastSeq: z.number().int().nonnegative().optional(),
});
export type Conversation = z.infer<typeof Conversation>;

export const ConversationRole = z.enum(["owner", "member"]);

export const ConversationMember = z.object({
  conversationId: Id,
  memberKind: MemberKind,
  memberId: Id,
  role: ConversationRole,
  joinedAt: IsoDateTime,
});
export type ConversationMember = z.infer<typeof ConversationMember>;

export const Mention = z.object({ kind: MemberKind, id: Id });
export type Mention = z.infer<typeof Mention>;

export const MessageStatus = z.enum(["sent", "streaming", "completed", "failed"]);
export type MessageStatus = z.infer<typeof MessageStatus>;

export const MessageAuthor = z.object({
  kind: PrincipalKind,
  id: Id.nullable(),
  displayName: z.string(),
  avatarUrl: z.string().nullable().optional(),
});
export type MessageAuthor = z.infer<typeof MessageAuthor>;

// ---- reactions (CHAT-07) ----

/**
 * One emoji: Extended_Pictographic, regional-indicator pairs (flags), keycaps, joined by ZWJ with VS16, skin
 * tones and tag sequences. At least one pictograph, flag letter or keycap; no text, no markup.
 */
const EMOJI_RE =
  /^(?=[\s\S]*(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\u20E3))(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|[\u{1F1E6}-\u{1F1FF}]|[0-9#*]\uFE0F?\u20E3|[\u{E0020}-\u{E007F}]|\u200D|\uFE0F)+$/u;
// zod's max counts code points; the 32 limit is in UTF-16 code units (a ZWJ family fits, a paragraph never).
export const Emoji = z
  .string()
  .min(1)
  .max(32)
  .refine((e) => e.length <= 32, { message: "Too long for one emoji" })
  .regex(EMOJI_RE, "a single emoji");
export type Emoji = z.infer<typeof Emoji>;

/** Distinct emoji per message. */
export const MAX_REACTIONS_PER_MESSAGE = 50;

const MemberRef = z.object({ kind: MemberKind, id: Id });

export const ReactionSummary = z.object({
  emoji: Emoji,
  count: z.number().int().positive(),
  mine: z.boolean(),
  /** The first reactors (ids only; names resolve from the directory). */
  members: z.array(MemberRef).max(20),
});
export type ReactionSummary = z.infer<typeof ReactionSummary>;

export const Message = z.object({
  id: Id,
  organizationId: Id,
  conversationId: Id,
  seq: z.number().int().nonnegative(),
  authorKind: PrincipalKind,
  authorId: Id.nullable(),
  /** Resolved for display by the API (users from org_members, agents from agents). */
  author: MessageAuthor.optional(),
  body: z.string(),
  mentions: z.array(Mention),
  status: MessageStatus,
  /** Root message id when this message is a reply in a thread. */
  threadId: Id.nullable(),
  replyCount: z.number().int().nonnegative(),
  lastReplyAt: IsoDateTime.nullable(),
  clientKind: ClientKind.nullable(),
  createdAt: IsoDateTime,
  editedAt: IsoDateTime.nullable(),
  /** Thread roots only: distinct reply authors, most recent first (max 5). */
  replyParticipants: z.array(MessageAuthor).optional(),
  /** Set on a tombstone (P-05): the body is empty and reactions/attachments are gone. */
  deletedAt: IsoDateTime.nullable().optional(),
  /** Viewer-specific fields (P-04): present on REST snapshots, never on realtime events. */
  reactions: z.array(ReactionSummary).optional(),
  attachments: z.array(Attachment).optional(),
  pinned: z.boolean().optional(),
  saved: z.boolean().optional(),
  /** Assistant turns of AI chats only (Phase 5, P-13): the generation that produced this answer. */
  generation: AiGeneration.optional(),
});
export type Message = z.infer<typeof Message>;

export const MessageBody = z.string().trim().min(1).max(20_000);

// ---- edit / delete (CHAT-06, D-01) ----

export const EditMessageRequest = z.object({ body: MessageBody });
export type EditMessageRequest = z.infer<typeof EditMessageRequest>;

/** Durable `message.updated` on `conv:<id>`: the edited message without viewer fields (P-04). */
export const MessageUpdatedEvent = z.object({ message: Message });
export type MessageUpdatedEvent = z.infer<typeof MessageUpdatedEvent>;

/** Durable `message.deleted` on `conv:<id>`: clients hide it, or show a tombstone when it has replies. */
export const MessageDeletedEvent = z.object({
  messageId: Id,
  conversationId: Id,
  threadId: Id.nullable(),
  deletedAt: IsoDateTime,
  replyCount: z.number().int().nonnegative(),
});
export type MessageDeletedEvent = z.infer<typeof MessageDeletedEvent>;

export const ReactionParams = z.object({ id: Id, emoji: Emoji });

/** Durable `reaction.updated` on `conv:<id>`: absolute count for one emoji; clients derive `mine` themselves. */
export const ReactionUpdatedEvent = z.object({
  messageId: Id,
  conversationId: Id,
  threadId: Id.nullable(),
  emoji: Emoji,
  count: z.number().int().nonnegative(),
  members: z.array(MemberRef).max(20),
  actor: MemberRef,
  added: z.boolean(),
});
export type ReactionUpdatedEvent = z.infer<typeof ReactionUpdatedEvent>;

// ---- pins, saves, references (CHAT-13) ----

export const MAX_PINS_PER_CONVERSATION = 100;
export const PinParams = z.object({ id: Id, messageId: Id });

export const PinnedMessage = z.object({ message: Message, pinnedBy: MessageAuthor, pinnedAt: IsoDateTime });
export type PinnedMessage = z.infer<typeof PinnedMessage>;
export const PinnedMessageList = z.object({ pins: z.array(PinnedMessage) });
export type PinnedMessageList = z.infer<typeof PinnedMessageList>;

/** Durable `pin.updated` on `conv:<id>`. */
export const PinUpdatedEvent = z.object({
  conversationId: Id,
  messageId: Id,
  pinned: z.boolean(),
  by: MemberRef,
});
export type PinUpdatedEvent = z.infer<typeof PinUpdatedEvent>;

// ---- REST DTOs ----

export const ChannelSlug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "lowercase letters, digits, - and _");

export const CreateChannelRequest = z.object({
  name: ChannelSlug,
  topic: z.string().trim().max(250).optional(),
  visibility: Visibility.default("public"),
  /** The department, team or project the channel is grouped under in the sidebar (CHAT-02). */
  unitId: Id.nullable().optional(),
});
export type CreateChannelRequest = z.infer<typeof CreateChannelRequest>;

/** A conversation as referenced from another list (saves, notifications, search, threads). */
export const ConversationRef = z.object({
  id: Id,
  kind: ConversationKind,
  name: z.string().nullable(),
  /** "#general", "Sam Lee", "Ada, Sam and Claude". */
  label: z.string(),
  visibility: Visibility,
  archived: z.boolean(),
});
export type ConversationRef = z.infer<typeof ConversationRef>;

/** Keyset pagination for the Phase 4 lists (opaque cursor). */
export const CursorQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});
export type CursorQuery = z.infer<typeof CursorQuery>;

export const SavedItem = z.object({ message: Message, conversation: ConversationRef, savedAt: IsoDateTime });
export type SavedItem = z.infer<typeof SavedItem>;
export const SavedList = z.object({ items: z.array(SavedItem), nextCursor: z.string().nullable() });
export type SavedList = z.infer<typeof SavedList>;

/** Durable `save.updated` on `user:<id>` (saves are personal). */
export const SaveUpdatedEvent = z.object({ messageId: Id, saved: z.boolean() });
export type SaveUpdatedEvent = z.infer<typeof SaveUpdatedEvent>;

// ---- sidebar units, unread and notification levels (CHAT-02, CHAT-09, CHAT-10) ----

export const ConversationNotifyLevel = z.enum(["default", "all", "mentions", "nothing"]);
export type ConversationNotifyLevel = z.infer<typeof ConversationNotifyLevel>;

/** The unit a channel is grouped under; `path` is root → self (ids only). */
export const ChannelUnit = z.object({
  id: Id,
  name: z.string(),
  kind: UnitKind,
  path: z.array(Id),
  /** Names aligned with `path` (root → self): the sidebar section title and the team sub-label (CHAT-02). */
  pathNames: z.array(z.string()).optional(),
});
export type ChannelUnit = z.infer<typeof ChannelUnit>;

export const UpdateChannelRequest = z
  .object({ unitId: Id.nullable().optional(), topic: z.string().trim().max(250).optional() })
  .refine((v) => v.unitId !== undefined || v.topic !== undefined, { message: "Change at least one field" });
export type UpdateChannelRequest = z.infer<typeof UpdateChannelRequest>;

/** `POST /conversations/:id/unread`: the read cursor moves to just before this message (Pitfall 2). */
export const MarkUnreadRequest = z.object({ messageId: Id });
export type MarkUnreadRequest = z.infer<typeof MarkUnreadRequest>;

/** Badge and preview fields shared by channel and DM summaries (P-07: counted messages, capped). */
const UnreadFields = {
  unreadCount: z.number().int().min(0).max(100).optional(),
  mentionCount: z.number().int().min(0).max(100).optional(),
  notifyLevel: ConversationNotifyLevel.optional(),
  muted: z.boolean().optional(),
  lastMessagePreview: z.string().max(140).nullable().optional(),
};

export const ChannelSummary = Conversation.extend({
  isMember: z.boolean(),
  memberCount: z.number().int().nonnegative(),
  /** Seq of the newest top-level message (0 when empty); unread when > lastReadSeq. */
  latestMessageSeq: z.number().int().nonnegative(),
  /** The caller's read cursor (0 when not a member). */
  lastReadSeq: z.number().int().nonnegative(),
  lastMessageAt: IsoDateTime.nullable(),
  /** The org-wide default channel (`#general`): everyone is a member and nobody can leave it. */
  isDefault: z.boolean(),
  /** Permissions the caller holds on this resource, decided by the API resolver (UI gating only). */
  viewerCan: z.array(Permission).optional(),
  unit: ChannelUnit.nullable().optional(),
  ...UnreadFields,
});
export type ChannelSummary = z.infer<typeof ChannelSummary>;

export const ChannelList = z.object({
  channels: z.array(ChannelSummary),
  /** Cursors for the sidebar's list-change subscriptions (`org:<id>` and `user:<id>`). */
  orgSeq: z.number().int().nonnegative().optional(),
  userSeq: z.number().int().nonnegative().optional(),
  /**
   * Every unit on the paths (root → self) of the caller's own unit memberships: the sidebar puts those departments
   * first and the create dialog offers them as "Belongs to" (the API re-decides every placement).
   */
  memberUnitIds: z.array(Id).optional(),
});
export type ChannelList = z.infer<typeof ChannelList>;

// ---- direct conversations (D-03 bot DMs; D-06 human DMs and group DMs) ----

/** A bot as the other party of a DM (the Phase 3.1 shape, unchanged). */
export const DmAgentCounterpart = z.object({
  kind: z.literal("agent"),
  id: Id,
  name: z.string(),
  username: z.string(),
  avatarUrl: z.string().nullable(),
  status: AgentStatus,
  scope: AgentScope,
});
export type DmAgentCounterpart = z.infer<typeof DmAgentCounterpart>;

/** A person as the other party of a DM. */
export const DmUserCounterpart = z.object({
  kind: z.literal("user"),
  id: Id,
  name: z.string(),
  handle: z.string(),
  avatarUrl: z.string().nullable(),
  deactivated: z.boolean(),
});
export type DmUserCounterpart = z.infer<typeof DmUserCounterpart>;

export const DmGroupMember = z.object({
  kind: MemberKind,
  id: Id,
  name: z.string(),
  avatarUrl: z.string().nullable(),
});
export type DmGroupMember = z.infer<typeof DmGroupMember>;

/** A group DM: `members` are the others (the caller excluded). */
export const DmGroupCounterpart = z.object({
  kind: z.literal("group"),
  name: z.string(),
  members: z.array(DmGroupMember).min(2).max(8),
});
export type DmGroupCounterpart = z.infer<typeof DmGroupCounterpart>;

/** The other party (or parties) of a direct conversation. Narrow on `kind` before reading bot fields. */
export const DmCounterpart = z.discriminatedUnion("kind", [
  DmAgentCounterpart,
  DmUserCounterpart,
  DmGroupCounterpart,
]);
export type DmCounterpart = z.infer<typeof DmCounterpart>;

/** Maximum members of a group DM, the creator included (D-06). */
export const MAX_GROUP_PARTICIPANTS = 9;

export const DmParticipant = z.object({ kind: MemberKind, id: Id });
export type DmParticipant = z.infer<typeof DmParticipant>;

/** `POST /dms`: the others (the caller is implied). One → a DM; two or more → a group DM. */
export const CreateDmRequest = z.object({
  participants: z
    .array(DmParticipant)
    .min(1)
    .max(MAX_GROUP_PARTICIPANTS - 1),
});
export type CreateDmRequest = z.infer<typeof CreateDmRequest>;

/**
 * The route's body schema for `POST /dms`: the same shape with a looser bound, so a list over the group cap is
 * answered with 400 `too_many_participants` (after self-removal and de-duplication) instead of a generic
 * validation error. Clients build `CreateDmRequest`.
 */
export const CreateDmRequestFields = z.object({
  participants: z.array(DmParticipant).min(1).max(32),
});
export type CreateDmRequestFields = z.infer<typeof CreateDmRequestFields>;

/**
 * The stable key of a direct conversation (P-06, AGENTS principle 11): every member's `<kind>:<id>`, sorted and
 * de-duplicated, joined by `|`. A bot DM keeps the Phase 3.1 form `agent:<a>|user:<u>`.
 */
export function dmKeyOf(members: ReadonlyArray<{ kind: "user" | "agent"; id: string }>): string {
  return [...new Set(members.map((m) => `${m.kind}:${m.id.toLowerCase()}`))].sort().join("|");
}

export const DmSummary = Conversation.extend({
  counterpart: DmCounterpart,
  /** Seq of the newest message (0 when empty); unread when > lastReadSeq. */
  latestMessageSeq: z.number().int().nonnegative(),
  lastReadSeq: z.number().int().nonnegative(),
  lastMessageAt: IsoDateTime.nullable(),
  ...UnreadFields,
});
export type DmSummary = z.infer<typeof DmSummary>;

export const DmList = z.object({
  dms: z.array(DmSummary),
  /** Cursor for the sidebar's `user:<id>` list-change subscription. */
  userSeq: z.number().int().nonnegative().optional(),
});
export type DmList = z.infer<typeof DmList>;

export const AddConversationMemberRequest = z.object({ kind: MemberKind, id: Id });
export type AddConversationMemberRequest = z.infer<typeof AddConversationMemberRequest>;

/**
 * An IANA time zone name as reported by the client (`Intl.DateTimeFormat().resolvedOptions().timeZone`), e.g.
 * `Europe/Madrid`. Strict (D-12, T-03.1-08-02): at most 64 characters of the zone alphabet, and accepted by
 * `Intl.DateTimeFormat`, so nothing but a real zone name ever reaches a bot's turn.
 */
export const IanaTimeZone = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_+\-/]+$/)
  .refine(
    (zone) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    },
    { message: "Unknown time zone" },
  );

export const PostMessageRequest = z
  .object({
    /** Empty only when the message carries attachments. */
    body: z.string().trim().max(20_000).default(""),
    /** Ready attachments uploaded to this conversation by the caller (Plan 04-04). */
    attachmentIds: z.array(Id).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
    mentions: z.array(Mention).max(50).default([]),
    /** Reply in the thread rooted at this message (must belong to the conversation). */
    threadRootId: Id.optional(),
    /** Client-generated idempotency key. */
    clientMessageId: z.string().max(64).optional(),
    /**
     * The poster's time zone, for the local date and time a bot sees on this turn (D-12). Never stored on the
     * message.
     */
    clientTimeZone: IanaTimeZone.optional(),
  })
  .refine((v) => v.body.length > 0 || (v.attachmentIds?.length ?? 0) > 0, {
    message: "Write a message or attach a file",
    path: ["body"],
  });
export type PostMessageRequest = z.infer<typeof PostMessageRequest>;

export const MessagePage = z.object({
  messages: z.array(Message),
  /** Pass as `before` to load older messages; null when there are none. */
  nextBefore: z.number().int().nullable(),
  lastSeq: z.number().int().nonnegative(),
  /** Pass as `after` to load newer messages (detached `around`/`after` pages); null at the live end. */
  nextAfter: z.number().int().nullable().optional(),
  /** The message an `around` page is centred on (a permalink target). */
  anchorId: Id.nullable().optional(),
  /** Set when the anchor is a thread reply: the page is centred on its root. */
  threadRootId: Id.nullable().optional(),
});
export type MessagePage = z.infer<typeof MessagePage>;

export const ThreadResponse = z.object({
  root: Message,
  replies: z.array(Message),
  participants: z.array(MessageAuthor),
});
export type ThreadResponse = z.infer<typeof ThreadResponse>;

/**
 * The page parameters without the one-cursor rule. The API route validates these and refuses more than one
 * cursor itself, after the readable check, with 400 `invalid_page_query` (hidden conversations stay 404).
 */
export const PageQueryFields = z.object({
  before: z.coerce.number().int().positive().optional(),
  /** Messages with seq > after, oldest first (forward paging of a detached page). */
  after: z.coerce.number().int().nonnegative().optional(),
  /** A page centred on this message (permalinks, CHAT-14). */
  around: Id.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PageQueryFields = z.infer<typeof PageQueryFields>;

/** Number of cursors (`before`, `after`, `around`) set on a page query; at most one is allowed. */
export const pageCursorCount = (q: { before?: unknown; after?: unknown; around?: unknown }) =>
  [q.before, q.after, q.around].filter((v) => v !== undefined).length;

export const PageQuery = PageQueryFields.refine((q) => pageCursorCount(q) <= 1, {
  message: "Use at most one of before, after and around",
});

// ---- threads view (CHAT-02) ----

export const ThreadSummary = z.object({
  root: Message,
  conversation: ConversationRef,
  replyCount: z.number().int().nonnegative(),
  lastReplyAt: IsoDateTime.nullable(),
  unreadReplies: z.number().int().min(0).max(100),
  participants: z.array(MessageAuthor),
  /** The newest live replies, oldest → newest (at most 3), for the Threads view card. */
  lastReplies: z.array(Message).max(3).optional(),
});
export type ThreadSummary = z.infer<typeof ThreadSummary>;
export const ThreadList = z.object({
  threads: z.array(ThreadSummary),
  nextCursor: z.string().nullable(),
  /** First page only: how many of the member's threads have unread replies (all pages, capped at 100; CHAT-09). */
  unreadThreads: z.number().int().min(0).max(100).optional(),
});
export type ThreadList = z.infer<typeof ThreadList>;

export const ThreadReadRequest = z.object({ seq: z.number().int().nonnegative() });
export type ThreadReadRequest = z.infer<typeof ThreadReadRequest>;

/** Durable `thread.read` on `user:<id>`: other tabs and devices update the Threads view. */
export const ThreadReadEvent = z.object({ rootId: Id, lastReadSeq: z.number().int().nonnegative() });
export type ThreadReadEvent = z.infer<typeof ThreadReadEvent>;

// ---- members ----

export const ChannelMember = z.object({
  kind: MemberKind,
  id: Id,
  displayName: z.string(),
  /** Mention handle without the `@` (agents: username; users: derived with `userHandle`). */
  handle: z.string(),
  /** URL or emoji (agents). */
  avatarUrl: z.string().nullable(),
  role: ConversationRole,
  joinedAt: IsoDateTime,
});
export type ChannelMember = z.infer<typeof ChannelMember>;

export const ChannelMemberList = z.object({ members: z.array(ChannelMember) });
export type ChannelMemberList = z.infer<typeof ChannelMemberList>;

export const MarkReadRequest = z.object({ seq: z.number().int().nonnegative() });
export type MarkReadRequest = z.infer<typeof MarkReadRequest>;

export const MemberParams = z.object({ id: Id, kind: MemberKind, memberId: Id });

// ---- realtime payloads (topic `conv:<id>`) ----

/** Durable `message.created`: top-level messages and thread replies (`message.threadId` set). */
export const MessageCreatedEvent = z.object({ message: Message });
export type MessageCreatedEvent = z.infer<typeof MessageCreatedEvent>;

/** Durable `thread.updated`: the root's reply summary changed. */
export const ThreadUpdatedEvent = z.object({
  rootId: Id,
  replyCount: z.number().int().nonnegative(),
  lastReplyAt: IsoDateTime.nullable(),
  replyParticipants: z.array(MessageAuthor),
});
export type ThreadUpdatedEvent = z.infer<typeof ThreadUpdatedEvent>;

/** Ephemeral `agent.typing`: an agent is generating a reply (clients expire it after a few seconds). */
export const AgentTypingEvent = z.object({
  agentId: Id,
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  threadRootId: Id.nullable(),
});
export type AgentTypingEvent = z.infer<typeof AgentTypingEvent>;

/** Ephemeral `user.typing` (client-originated; the server injects `userId`). */
export const UserTypingEvent = z.object({ userId: Id, threadRootId: Id.nullable().optional() });
export type UserTypingEvent = z.infer<typeof UserTypingEvent>;

// ---- mentions ----

/** `@handle` tokens: start of text or after whitespace/punctuation; handles are [a-z0-9._-]. */
export const MENTION_TOKEN_RE = /(^|[\s([{,;:!?"'])@([a-zA-Z0-9][a-zA-Z0-9._-]{0,39})/g;

/** Lowercased, de-duplicated handles mentioned in a message body (trailing dots are trimmed). */
export function extractMentionHandles(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(MENTION_TOKEN_RE)) {
    const handle = (m[2] ?? "").replace(/[._-]+$/, "").toLowerCase();
    if (handle) out.add(handle);
  }
  return [...out];
}

/** `@channel` / `@here` (and `@everyone`, an alias of `@channel`). */
export const MentionAll = z.enum(["channel", "here"]);
export type MentionAll = z.infer<typeof MentionAll>;

/**
 * The broadcast mention of a body, ignoring fenced and inline code: `channel` (also for `@everyone`) beats
 * `here`; null when there is none.
 */
export function mentionAllOf(body: string): MentionAll | null {
  const prose = body
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ");
  const handles = extractMentionHandles(prose);
  if (handles.includes("channel") || handles.includes("everyone")) return "channel";
  return handles.includes("here") ? "here" : null;
}

/**
 * Mention handle for a human member: the email local part (unique per org in practice), falling back to
 * the display name. "victor.ruiz@x.com" → "victor.ruiz", "Ada Lovelace" → "adalovelace". A handle equal to a
 * reserved one gets the suffix "-1" ("here@x.com" → "here-1"; Pitfall 6).
 */
export function userHandle(member: { displayName: string; email?: string | null }): string {
  const fromEmail = (member.email ?? "").split("@")[0] ?? "";
  const clean = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "")
      .replace(/^[._-]+|[._-]+$/g, "")
      .slice(0, 40);
  const handle = clean(fromEmail) || clean(member.displayName) || "user";
  return isReservedHandle(handle) ? `${handle}-1` : handle;
}
