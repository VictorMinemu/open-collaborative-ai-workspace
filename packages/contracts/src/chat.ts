import { z } from "zod";
import { ClientKind, Id, IsoDateTime, MemberKind, PrincipalKind } from "./common";

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
});
export type Message = z.infer<typeof Message>;

export const MessageBody = z.string().trim().min(1).max(20_000);

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
});
export type CreateChannelRequest = z.infer<typeof CreateChannelRequest>;

export const ChannelSummary = Conversation.extend({
  isMember: z.boolean(),
  memberCount: z.number().int().nonnegative(),
});
export type ChannelSummary = z.infer<typeof ChannelSummary>;

export const ChannelList = z.object({ channels: z.array(ChannelSummary) });
export type ChannelList = z.infer<typeof ChannelList>;

export const AddConversationMemberRequest = z.object({ kind: MemberKind, id: Id });
export type AddConversationMemberRequest = z.infer<typeof AddConversationMemberRequest>;

export const PostMessageRequest = z.object({
  body: MessageBody,
  mentions: z.array(Mention).max(50).default([]),
  /** Reply in the thread rooted at this message (must belong to the conversation). */
  threadRootId: Id.optional(),
  /** Client-generated idempotency key. */
  clientMessageId: z.string().max(64).optional(),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequest>;

export const MessagePage = z.object({
  messages: z.array(Message),
  /** Pass as `before` to load older messages; null when there are none. */
  nextBefore: z.number().int().nullable(),
  lastSeq: z.number().int().nonnegative(),
});
export type MessagePage = z.infer<typeof MessagePage>;

export const ThreadResponse = z.object({
  root: Message,
  replies: z.array(Message),
  participants: z.array(MessageAuthor),
});
export type ThreadResponse = z.infer<typeof ThreadResponse>;

export const PageQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
