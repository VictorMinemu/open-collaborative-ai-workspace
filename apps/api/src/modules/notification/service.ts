import {
  type ConversationNotifyLevel,
  type ConversationRef,
  DEFAULT_NOTIFICATION_PREFS,
  decideNotify,
  EventTypes,
  type MessageAuthor,
  NOTIFICATION_KIND_RANK,
  type Notification,
  type NotificationCreatedEvent,
  type NotificationKind,
  type NotificationReadEvent,
} from "@ocw/contracts";
import {
  conversationMembers,
  messages,
  notificationPrefs,
  notifications,
  orgMembers,
  type Tx,
} from "@ocw/db";
import { and, count, eq, inArray, isNull, ne, type SQL, sql } from "drizzle-orm";
import type { Core } from "../../core";
import type { ConversationReadInput, MessageEditedInput, MessagePostedInput } from "../../lib/chat-events";
import { authorOf, type ConversationAccess, conversationRefs, loadDirectory } from "../chat";
import type { OnlineSet } from "../realtime";
import { computeRecipients } from "./recipients";
import { snippetOf } from "./snippet";

/**
 * Notification writes (CHAT-08). Runs inside the message transaction through the chat-events seam: recipients are
 * computed (recipients.ts), kept only when they are active members the resolver lets read the conversation (P-03,
 * T-04-09-01), stored as ids plus the actor (Pitfall 9) with one row per (user, message) where the strongest kind
 * wins, and each new or upgraded row is announced as `notification.created` on the recipient's durable `user:`
 * stream (P-04) with `popup` decided once by the server from the recipient's preferences.
 */

/** The inbox's Mentions filter (the Mentions view, CHAT-08). */
export const MENTIONS_FILTER_KINDS = [
  "mention",
  "channel",
  "here",
] as const satisfies readonly NotificationKind[];

/** Kinds ordered weakest → strongest; SQL compares positions to keep the strongest kind on a conflict. */
const RANKED = (Object.keys(NOTIFICATION_KIND_RANK) as NotificationKind[]).sort(
  (a, b) => NOTIFICATION_KIND_RANK[a] - NOTIFICATION_KIND_RANK[b],
);
const RANK_ARRAY = sql.raw(`array[${RANKED.map((k) => `'${k}'`).join(",")}]::text[]`);

export const iso = (v: unknown) => new Date(v as string).toISOString();

/** The caller's visible notifications: own rows, readable conversations, live messages, optional kinds. */
export function visible(me: string, readableIds: string[], filter: "all" | "mentions"): SQL | undefined {
  return and(
    eq(notifications.userId, me),
    inArray(notifications.conversationId, readableIds),
    isNull(messages.deletedAt),
    filter === "mentions" ? inArray(notifications.kind, [...MENTIONS_FILTER_KINDS]) : undefined,
  );
}

/** Unread notifications the caller can see now, for one filter. */
export async function unreadCountFor(
  tx: Tx,
  me: string,
  readableIds: string[],
  filter: "all" | "mentions",
): Promise<number> {
  if (readableIds.length === 0) return 0;
  const [row] = await tx
    .select({ n: count() })
    .from(notifications)
    .innerJoin(messages, eq(messages.id, notifications.messageId))
    .where(and(visible(me, readableIds, filter), isNull(notifications.readAt)));
  return Number(row?.n ?? 0);
}

interface Target {
  conv: MessagePostedInput["conv"];
  messageId: string;
  body: string;
  threadRootId: string | null;
  actor: MessageAuthor;
  recipients: Map<string, NotificationKind>;
}

export interface NotificationService {
  onPosted(tx: Tx, input: MessagePostedInput): Promise<void>;
  onEdited(tx: Tx, input: MessageEditedInput): Promise<void>;
  /** CHAT-09: reading a conversation (or a thread) reads the member's notifications of what was read. */
  onRead(tx: Tx, input: ConversationReadInput): Promise<void>;
}

/** `NotificationReadEvent.ids` holds at most this many ids; larger reads go out in several events. */
const READ_EVENT_IDS = 200;

export function createNotificationService(
  core: Core,
  deps: { online: OnlineSet; access: ConversationAccess },
): NotificationService {
  async function humanMemberIds(tx: Tx, conversationId: string): Promise<string[]> {
    const rows = await tx
      .select({ id: conversationMembers.memberId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.memberKind, "user"),
        ),
      );
    return rows.map((r) => r.id);
  }

  /** Root author and the earlier repliers of a thread (people only, live replies only). */
  async function threadParticipantIds(tx: Tx, rootId: string, exceptMessageId: string): Promise<string[]> {
    const [root] = await tx
      .select({ kind: messages.authorKind, id: messages.authorId })
      .from(messages)
      .where(eq(messages.id, rootId))
      .limit(1);
    const replies = await tx
      .selectDistinct({ id: messages.authorId })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, rootId),
          ne(messages.id, exceptMessageId),
          eq(messages.authorKind, "user"),
          isNull(messages.deletedAt),
        ),
      );
    const out = replies.flatMap((r) => (r.id ? [r.id] : []));
    if (root?.kind === "user" && root.id) out.unshift(root.id);
    return out;
  }

  /** Recipients that are active members who may read the conversation now (the resolver decides, P-03). */
  async function eligible(tx: Tx, conversationId: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const active = new Set(
      (
        await tx
          .select({ id: orgMembers.userId })
          .from(orgMembers)
          .where(and(inArray(orgMembers.userId, ids), isNull(orgMembers.deactivatedAt)))
      ).map((r) => r.id),
    );
    const out: string[] = [];
    for (const id of ids) {
      if (active.has(id) && (await deps.access.isReadable(tx, id, conversationId))) out.push(id);
    }
    return out;
  }

  async function deliver(tx: Tx, t: Target): Promise<void> {
    const ids = await eligible(tx, t.conv.id, [...t.recipients.keys()]);
    if (ids.length === 0) return;
    const values = ids.map(
      (id) =>
        sql`(${t.conv.organizationId}::uuid, ${id}::uuid, ${t.recipients.get(id)}, ${t.conv.id}::uuid, ${t.messageId}::uuid, ${t.threadRootId}::uuid, ${t.actor.kind}, ${t.actor.id}::uuid)`,
    );
    // One row per (user, message): a stronger reason upgrades the row and makes it unread again; a weaker or equal
    // one changes nothing (and announces nothing).
    const res = await tx.execute(sql`
      insert into app.notifications
        (organization_id, user_id, kind, conversation_id, message_id, thread_root_id, actor_kind, actor_id)
      values ${sql.join(values, sql`, `)}
      on conflict (user_id, message_id) do update set kind = excluded.kind, read_at = null
        where array_position(${RANK_ARRAY}, excluded.kind) > array_position(${RANK_ARRAY}, app.notifications.kind)
      returning id, user_id, kind, created_at`);
    const rows = res.rows as Array<{
      id: string;
      user_id: string;
      kind: NotificationKind;
      created_at: unknown;
    }>;
    if (rows.length === 0) return;

    const userIds = rows.map((r) => r.user_id);
    const prefs = new Map(
      (await tx.select().from(notificationPrefs).where(inArray(notificationPrefs.userId, userIds))).map(
        (p) => [p.userId, p],
      ),
    );
    const memberships = new Map(
      (
        await tx
          .select({
            id: conversationMembers.memberId,
            level: conversationMembers.notifyLevel,
            muted: conversationMembers.muted,
          })
          .from(conversationMembers)
          .where(
            and(
              eq(conversationMembers.conversationId, t.conv.id),
              eq(conversationMembers.memberKind, "user"),
              inArray(conversationMembers.memberId, userIds),
            ),
          )
      ).map((m) => [m.id, m]),
    );
    const dir = await loadDirectory(tx);
    // A channel's label is the same for everyone; a DM's or group's names the others, so it is per recipient.
    let channelRef: ConversationRef | undefined;
    const refFor = async (userId: string): Promise<ConversationRef | undefined> => {
      if (t.conv.kind === "channel") {
        channelRef ??= (await conversationRefs(tx, [t.conv.id], userId, dir)).get(t.conv.id);
        return channelRef;
      }
      return (await conversationRefs(tx, [t.conv.id], userId, dir)).get(t.conv.id);
    };
    const snippet = snippetOf(t.body);
    const now = Date.now();

    for (const r of rows) {
      const conversation = await refFor(r.user_id);
      if (!conversation) continue;
      const p = prefs.get(r.user_id);
      const m = memberships.get(r.user_id);
      const { popup } = decideNotify({
        event: r.kind,
        conversationKind: t.conv.kind,
        level: (m?.level ?? "default") as ConversationNotifyLevel,
        defaultLevel: p?.defaultLevel ?? DEFAULT_NOTIFICATION_PREFS.defaultLevel,
        muted: m?.muted ?? false,
        dndActive: p?.dndUntil ? new Date(p.dndUntil).getTime() > now : false,
      });
      const notification: Notification = {
        id: r.id,
        kind: r.kind,
        conversation,
        messageId: t.messageId,
        threadRootId: t.threadRootId,
        actor: t.actor,
        snippet,
        createdAt: iso(r.created_at),
        readAt: null,
      };
      const ev: NotificationCreatedEvent = { notification, popup };
      await core.realtime.appendEvent(tx, `user:${r.user_id}`, EventTypes.notificationCreated, ev);
    }
  }

  return {
    async onPosted(tx, input) {
      const { conv, message } = input;
      const threadRootId = input.threadRootId;
      const dir = await loadDirectory(tx);
      const recipients = computeRecipients({
        authorUserId: input.author.kind === "user" ? input.author.id : null,
        convKind: conv.kind,
        humanMemberIds: await humanMemberIds(tx, conv.id),
        mentionedUserIds: input.mentions.filter((m) => m.kind === "user").map((m) => m.id),
        mentionAll: conv.kind === "channel" ? input.mentionAll : null,
        onlineUserIds:
          conv.kind === "channel" && input.mentionAll === "here"
            ? await deps.online.onlineUserIds(conv.organizationId)
            : new Set(),
        threadParticipantIds: threadRootId ? await threadParticipantIds(tx, threadRootId, message.id) : [],
        isThreadReply: threadRootId !== null,
      });
      if (recipients.size === 0) return;
      await deliver(tx, {
        conv,
        messageId: message.id,
        body: message.body,
        threadRootId,
        actor: message.author ?? authorOf(dir, input.author.kind, input.author.id),
        recipients,
      });
    },

    async onRead(tx, input) {
      // Own rows only (the read route is the member's own); top-level messages of the conversation, or the replies
      // of one thread for a thread read, up to the seq read. Ids and the read time only change.
      const scope = input.threadRootId
        ? sql`n.thread_root_id = ${input.threadRootId}::uuid`
        : sql`n.thread_root_id is null`;
      const res = await tx.execute(sql`
        update app.notifications n set read_at = now()
        from app.messages m
        where m.id = n.message_id and n.user_id = ${input.userId}::uuid
          and n.conversation_id = ${input.conversationId}::uuid and n.read_at is null
          and m.seq <= ${input.lastReadSeq} and ${scope}
        returning n.id`);
      const ids = (res.rows as Array<{ id: string }>).map((r) => r.id);
      if (ids.length === 0) return;
      const unreadCount = await unreadCountFor(
        tx,
        input.userId,
        await deps.access.readableIds(tx, input.userId),
        "all",
      );
      for (let i = 0; i < ids.length; i += READ_EVENT_IDS) {
        const ev: NotificationReadEvent = { ids: ids.slice(i, i + READ_EVENT_IDS), unreadCount };
        await core.realtime.appendEvent(tx, `user:${input.userId}`, EventTypes.notificationRead, ev);
      }
    },

    async onEdited(tx, input) {
      // Only people mentioned now and not before (Pitfall 8); an edit never notifies @channel/@here.
      const before = new Set(input.previousMentions.filter((m) => m.kind === "user").map((m) => m.id));
      const recipients = new Map<string, NotificationKind>();
      for (const m of input.message.mentions) {
        if (m.kind === "user" && !before.has(m.id) && m.id !== input.editorId)
          recipients.set(m.id, "mention");
      }
      if (recipients.size === 0) return;
      const dir = await loadDirectory(tx);
      await deliver(tx, {
        conv: input.conv,
        messageId: input.message.id,
        body: input.message.body,
        threadRootId: input.message.threadId,
        actor: input.message.author ?? authorOf(dir, "user", input.editorId),
        recipients,
      });
    },
  };
}
