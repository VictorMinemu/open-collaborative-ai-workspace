import { NOTIFICATION_KIND_RANK, type NotificationKind } from "@ocw/contracts";

/** Everything `computeRecipients` needs about one new message (all ids are users; bots are never recipients). */
export interface RecipientsInput {
  /** The human author, or null when a bot wrote the message. */
  authorUserId: string | null;
  convKind: "channel" | "dm" | "group";
  /** Human members of the conversation (agents are not listed). */
  humanMemberIds: string[];
  /** Users the message @mentions (resolved server-side; reserved handles never resolve). */
  mentionedUserIds: string[];
  /** `@channel` / `@here` in a channel message (null elsewhere). */
  mentionAll: "channel" | "here" | null;
  /** Users online in the organization right now (only read for `@here`). */
  onlineUserIds: Set<string>;
  /** Root author and earlier repliers of the thread (users only; duplicates allowed). */
  threadParticipantIds: string[];
  isThreadReply: boolean;
}

/**
 * Who a new message notifies and why (CHAT-08), pure. One kind per user: the strongest by NOTIFICATION_KIND_RANK.
 * The author never notifies himself. Readability is NOT decided here: the service keeps only recipients the
 * resolver lets read the conversation (P-03), so a mentioned outsider of a private channel is computed and then
 * dropped there.
 */
export function computeRecipients(i: RecipientsInput): Map<string, NotificationKind> {
  const out = new Map<string, NotificationKind>();
  const offer = (userId: string, kind: NotificationKind) => {
    if (userId === i.authorUserId) return;
    const prev = out.get(userId);
    if (!prev || NOTIFICATION_KIND_RANK[kind] > NOTIFICATION_KIND_RANK[prev]) out.set(userId, kind);
  };

  if (i.convKind === "dm") for (const u of i.humanMemberIds) offer(u, "dm");
  if (i.convKind === "group") for (const u of i.humanMemberIds) offer(u, "group_dm");
  if (i.convKind === "channel" && i.mentionAll === "channel") {
    for (const u of i.humanMemberIds) offer(u, "channel");
  }
  if (i.convKind === "channel" && i.mentionAll === "here") {
    for (const u of i.humanMemberIds) if (i.onlineUserIds.has(u)) offer(u, "here");
  }
  if (i.isThreadReply) for (const u of i.threadParticipantIds) offer(u, "thread_reply");
  for (const u of i.mentionedUserIds) offer(u, "mention");
  return out;
}
