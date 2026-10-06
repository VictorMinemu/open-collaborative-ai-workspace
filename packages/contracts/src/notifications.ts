import { z } from "zod";
import { ConversationNotifyLevel, ConversationRef, CursorQuery, MessageAuthor } from "./chat";
import { Id, IsoDateTime } from "./common";

/**
 * Notifications (CHAT-08, CHAT-09, CHAT-10, D-02). Rows store ids and the actor only (Pitfall 9): the inbox
 * re-checks access and computes the snippet at read time. The server decides `popup` once for every client.
 */

export const NotificationKind = z.enum(["mention", "channel", "here", "dm", "group_dm", "thread_reply"]);
export type NotificationKind = z.infer<typeof NotificationKind>;

/** Strongest kind wins when one message notifies a user for several reasons. */
export const NOTIFICATION_KIND_RANK: Record<NotificationKind, number> = {
  mention: 6,
  dm: 5,
  group_dm: 4,
  channel: 3,
  here: 2,
  thread_reply: 1,
};

/** Kinds that count toward a conversation's `mentionCount`. */
export const MENTION_KINDS = ["mention", "channel", "here", "dm", "group_dm"] as const;

/** Unread and mention counts are capped here (UI shows "99+"). */
export const UNREAD_CAP = 100;
export const SNIPPET_MAX = 140;
/** The composer warns before `@channel`/`@here` in a channel with at least this many members. */
export const MENTION_ALL_WARN_AT = 20;

export const Notification = z.object({
  id: Id,
  kind: NotificationKind,
  conversation: ConversationRef,
  messageId: Id,
  threadRootId: Id.nullable(),
  actor: MessageAuthor,
  snippet: z.string().max(SNIPPET_MAX),
  createdAt: IsoDateTime,
  readAt: IsoDateTime.nullable(),
});
export type Notification = z.infer<typeof Notification>;

export const NotificationListQuery = CursorQuery.extend({
  filter: z.enum(["all", "mentions"]).default("all"),
});
export type NotificationListQuery = z.infer<typeof NotificationListQuery>;

export const NotificationList = z.object({
  items: z.array(Notification),
  nextCursor: z.string().nullable(),
  unreadCount: z.number().int().min(0),
});
export type NotificationList = z.infer<typeof NotificationList>;

export const MarkNotificationsReadRequest = z
  .object({ ids: z.array(Id).min(1).max(200).optional(), all: z.literal(true).optional() })
  .refine((v) => (v.ids !== undefined) !== (v.all !== undefined), {
    message: "Pass either ids or all",
  });
export type MarkNotificationsReadRequest = z.infer<typeof MarkNotificationsReadRequest>;

/** Durable `notification.created` on `user:<id>`. */
export const NotificationCreatedEvent = z.object({ notification: Notification, popup: z.boolean() });
export type NotificationCreatedEvent = z.infer<typeof NotificationCreatedEvent>;

/** Durable `notification.read` on `user:<id>`. */
export const NotificationReadEvent = z.object({
  ids: z.array(Id).max(200).optional(),
  all: z.boolean().optional(),
  unreadCount: z.number().int().min(0),
});
export type NotificationReadEvent = z.infer<typeof NotificationReadEvent>;

/** Durable `conversation.read` on `user:<id>`: read or mark-unread from any tab or device. */
export const ConversationReadEvent = z.object({
  conversationId: Id,
  lastReadSeq: z.number().int().nonnegative(),
  unreadCount: z.number().int().min(0).max(UNREAD_CAP),
  mentionCount: z.number().int().min(0).max(UNREAD_CAP),
  /**
   * The newest top-level message seq the counts saw. A client that already holds a newer message (its `conv:`
   * frame overtook this `user:` event) refetches the snapshot instead of trusting the counts.
   */
  latestMessageSeq: z.number().int().nonnegative().optional(),
});
export type ConversationReadEvent = z.infer<typeof ConversationReadEvent>;

export const DefaultNotifyLevel = z.enum(["all", "mentions", "nothing"]);
export type DefaultNotifyLevel = z.infer<typeof DefaultNotifyLevel>;

export const NotificationPrefs = z.object({
  /** Do not disturb until this instant (null = off). */
  dndUntil: IsoDateTime.nullable(),
  desktopEnabled: z.boolean(),
  webEnabled: z.boolean(),
  /** What channels notify by default; DMs and group DMs default to `all`. */
  defaultLevel: DefaultNotifyLevel,
});
export type NotificationPrefs = z.infer<typeof NotificationPrefs>;

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  dndUntil: null,
  desktopEnabled: true,
  webEnabled: true,
  defaultLevel: "mentions",
};

export const UpdateNotificationPrefsRequest = NotificationPrefs.partial().refine(
  (v) => Object.values(v).some((x) => x !== undefined),
  { message: "Change at least one setting" },
);
export type UpdateNotificationPrefsRequest = z.infer<typeof UpdateNotificationPrefsRequest>;

export const ConversationNotificationSettings = z.object({
  level: ConversationNotifyLevel,
  muted: z.boolean(),
});
export type ConversationNotificationSettings = z.infer<typeof ConversationNotificationSettings>;

export const UpdateConversationNotificationSettingsRequest =
  ConversationNotificationSettings.partial().refine((v) => v.level !== undefined || v.muted !== undefined, {
    message: "Change at least one setting",
  });
export type UpdateConversationNotificationSettingsRequest = z.infer<
  typeof UpdateConversationNotificationSettingsRequest
>;

/** Durable `notification_prefs.updated` on `user:<id>`: global prefs, or one conversation's settings. */
export const NotificationPrefsUpdatedEvent = z.object({
  prefs: NotificationPrefs.optional(),
  conversationId: Id.optional(),
  settings: ConversationNotificationSettings.optional(),
});
export type NotificationPrefsUpdatedEvent = z.infer<typeof NotificationPrefsUpdatedEvent>;

/**
 * Ephemeral `message.notify` on `user:<id>` (P-04: never stored): a plain top-level channel message for a member
 * whose effective level there is "all" (not muted, not in DND, not the author, and not already notified by a row).
 * The client applies its desktop/web toggle and focus like for `notification.created`; the tag is the message id.
 */
export const MessageNotifyEvent = z.object({
  conversation: ConversationRef,
  messageId: Id,
  actor: MessageAuthor,
  snippet: z.string().max(SNIPPET_MAX),
});
export type MessageNotifyEvent = z.infer<typeof MessageNotifyEvent>;

/** What happened: a notification kind, or a plain message (no mention). */
export type NotifyEvent = NotificationKind | "message";

/**
 * Whether an event pops an OS / in-app notification for one user. DND or mute → never. The effective level is
 * the conversation's level, or for `default` "all" in DMs and groups and the user's default level in channels.
 * A plain message pops only at "all"; every mention-like event pops at "all" or "mentions".
 *
 * A bot's reply in a bot DM (`actorKind: "agent"` in a DM) is an answer the member asked for, not someone reaching
 * out: it counts as a plain message and the DM's `default` means "mentions", so it pops only when the reply
 * @mentions the member or the member set that DM to "all" (04-09 open item). The row still reaches the inbox.
 */
export function decideNotify(i: {
  event: NotifyEvent;
  conversationKind: "channel" | "dm" | "group";
  level: ConversationNotifyLevel;
  defaultLevel: DefaultNotifyLevel;
  muted: boolean;
  dndActive: boolean;
  actorKind?: "user" | "agent" | "system";
}): { popup: boolean } {
  if (i.dndActive || i.muted) return { popup: false };
  const botDm = i.conversationKind === "dm" && i.actorKind === "agent";
  const event = botDm && i.event === "dm" ? "message" : i.event;
  const fallback = i.conversationKind === "channel" ? i.defaultLevel : botDm ? "mentions" : "all";
  const effective = i.level === "default" ? fallback : i.level;
  if (event === "message") return { popup: effective === "all" };
  return { popup: effective === "all" || effective === "mentions" };
}

/**
 * The sidebar badge of one conversation: a mention badge whenever something addresses the user (even muted),
 * nothing when muted or read, a dot for mention-only / nothing levels, otherwise the unread count.
 */
export function badgeStyle(i: {
  level: ConversationNotifyLevel;
  muted: boolean;
  unreadCount: number;
  mentionCount: number;
}): "mention" | "count" | "dot" | "none" {
  if (i.mentionCount > 0) return "mention";
  if (i.muted || i.unreadCount <= 0) return "none";
  if (i.level === "mentions" || i.level === "nothing") return "dot";
  return "count";
}
