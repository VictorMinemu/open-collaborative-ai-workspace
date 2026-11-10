import {
  type ConversationNotifyLevel,
  type ConversationRef,
  DEFAULT_NOTIFICATION_PREFS,
  decideNotify,
  EphemeralTypes,
  EventTypes,
  type MessageAuthor,
  type MessageNotifyEvent,
  NOTIFICATION_KIND_RANK,
  type Notification,
  type NotificationCreatedEvent,
  type NotificationKind,
  type NotificationReadEvent,
} from "@ocw/contracts";
import {
  conversationMembers,
  conversations,
  messages,
  notificationPrefs,
  notifications,
  orgMembers,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, count, eq, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import type { Core } from "../../core";
import type { ConversationReadInput, MessageEditedInput, MessagePostedInput } from "../../lib/chat-events";
import { authorOf, type ConversationAccess, conversationRefs, loadDirectory } from "../chat";
import type { OnlineSet } from "../realtime";
import { computeRecipients } from "./recipients";
import { snippetOf } from "./snippet";
import { teamMentionAudience, teamMentionUnits } from "./team-mentions";

/**
 * Notification writes (CHAT-08). Runs inside the message transaction through the chat-events seam: recipients are
 * computed (recipients.ts), kept only when they are active members the resolver lets read the conversation (P-03,
 * T-04-09-01), stored as ids plus the actor (Pitfall 9) with one row per (user, message) where the strongest kind
 * wins, and each new or upgraded row is announced as `notification.created` on the recipient's durable `user:`
 * stream (P-04) with `popup` decided once by the server from the recipient's preferences.
 */

/**
 * The inbox's Mentions filter (the Mentions view, CHAT-08). 06-08: a chat shared with you by name is addressed to you
 * like a mention, so it is listed there too.
 */
export const MENTIONS_FILTER_KINDS = [
  "mention",
  "channel",
  "here",
  "ai_chat_shared",
  // 07.17 (PD-14): a team or department you are in was @mentioned.
  "team_mention",
] as const satisfies readonly NotificationKind[];

/**
 * Conversation kinds whose notifications exist (06-08: AI chats too). The inbox, its unread count and every
 * recipient check use the readable set with these kinds, so an AI chat's notifications show only while it is readable.
 */
export const NOTIFIABLE_KINDS = ["channel", "dm", "group", "ai_chat"] as const;

/** What the notification writers need outside the module's own service (`notifyUsers`, 06-08). */
export interface NotificationDeps {
  core: Core;
  access: ConversationAccess;
}

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
  /** 07.17 (PD-14): the unit that reached each `team_mention` recipient (stored as `unit_id`, an id only). */
  unitOf?: ReadonlyMap<string, string>;
}

/** Recipients that are active members who may read the conversation now (the resolver decides, P-03). */
async function eligible(
  tx: Tx,
  deps: NotificationDeps,
  conversationId: string,
  ids: string[],
): Promise<string[]> {
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
    if (active.has(id) && (await deps.access.isReadable(tx, id, conversationId, { kinds: NOTIFIABLE_KINDS })))
      out.push(id);
  }
  return out;
}

async function deliver(tx: Tx, deps: NotificationDeps, t: Target): Promise<void> {
  const { core } = deps;
  const ids = await eligible(tx, deps, t.conv.id, [...t.recipients.keys()]);
  if (ids.length === 0) return;
  const unitIdOf = (id: string) =>
    t.recipients.get(id) === "team_mention" ? (t.unitOf?.get(id) ?? null) : null;
  const values = ids.map(
    (id) =>
      sql`(${t.conv.organizationId}::uuid, ${id}::uuid, ${t.recipients.get(id)}, ${t.conv.id}::uuid, ${t.messageId}::uuid, ${t.threadRootId}::uuid, ${t.actor.kind}, ${t.actor.id}::uuid, ${unitIdOf(id)}::uuid)`,
  );
  // One row per (user, message): a stronger reason upgrades the row and makes it unread again; a weaker or equal
  // one changes nothing (and announces nothing). The unit follows the kind (only a `team_mention` names one).
  const res = await tx.execute(sql`
    insert into app.notifications
      (organization_id, user_id, kind, conversation_id, message_id, thread_root_id, actor_kind, actor_id, unit_id)
    values ${sql.join(values, sql`, `)}
    on conflict (user_id, message_id) do update set kind = excluded.kind, unit_id = excluded.unit_id, read_at = null
      where array_position(${RANK_ARRAY}, excluded.kind) > array_position(${RANK_ARRAY}, app.notifications.kind)
    returning id, user_id, kind, unit_id, created_at`);
  const rows = res.rows as Array<{
    id: string;
    user_id: string;
    kind: NotificationKind;
    unit_id: string | null;
    created_at: unknown;
  }>;
  if (rows.length === 0) return;
  const units = await teamMentionUnits(
    tx,
    rows.filter((r) => r.kind === "team_mention").map((r) => r.unit_id),
  );

  const userIds = rows.map((r) => r.user_id);
  const prefs = new Map(
    (await tx.select().from(notificationPrefs).where(inArray(notificationPrefs.userId, userIds))).map((p) => [
      p.userId,
      p,
    ]),
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
  // A channel's label (and an AI chat's title) is the same for everyone; a DM's or group's names the others, so it
  // is per recipient.
  let channelRef: ConversationRef | undefined;
  const refFor = async (userId: string): Promise<ConversationRef | undefined> => {
    if (t.conv.kind === "channel" || t.conv.kind === "ai_chat") {
      channelRef ??= (await conversationRefs(tx, [t.conv.id], userId, dir)).get(t.conv.id);
      return channelRef;
    }
    return (await conversationRefs(tx, [t.conv.id], userId, dir)).get(t.conv.id);
  };
  const snippet = snippetOf(t.body);
  const now = Date.now();

  // Stream lock order (07.5-16, WINDOWS #224): `user:` streams in ascending id order, as every other fan-out takes
  // them, so two transactions notifying the same people never wait on each other crosswise.
  rows.sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0));
  for (const r of rows) {
    const conversation = await refFor(r.user_id);
    if (!conversation) continue;
    const p = prefs.get(r.user_id);
    const m = memberships.get(r.user_id);
    const { popup } = decideNotify({
      // 07.17 (PD-14): a team mention pops exactly like a direct mention.
      event: r.kind === "team_mention" ? "mention" : r.kind,
      // An AI chat follows the direct-conversation default ("all"): only addressed kinds ever reach it.
      conversationKind: t.conv.kind === "ai_chat" ? "group" : t.conv.kind,
      level: (m?.level ?? "default") as ConversationNotifyLevel,
      defaultLevel: p?.defaultLevel ?? DEFAULT_NOTIFICATION_PREFS.defaultLevel,
      muted: m?.muted ?? false,
      dndActive: p?.dndUntil ? new Date(p.dndUntil).getTime() > now : false,
      actorKind: t.actor.kind,
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
      ...(r.kind === "team_mention" ? { unit: (r.unit_id && units.get(r.unit_id)) || null } : {}),
    };
    const ev: NotificationCreatedEvent = { notification, popup };
    await core.realtime.appendEvent(tx, `user:${r.user_id}`, EventTypes.notificationCreated, ev);
  }
}

/**
 * Notifies named users about one message of a conversation (06-08): an AI chat shared with them by name
 * (`ai_chat_shared`, the grant's notice row), a mention inside a shared AI chat (`mention`), a card they follow (later
 * plans). Recipients are decided here, never by the caller's list alone: each must be an active member who can read
 * the conversation now (the readable set with AI chats, P-03), and never the actor. One row per (user, message), the
 * strongest kind wins (`deliver`), ids and the actor only (Pitfall 9), announced as `notification.created` on
 * `user:<id>`.
 */
export async function notifyUsers(
  tx: Tx,
  deps: NotificationDeps,
  n: {
    kind: NotificationKind;
    conversationId: string;
    messageId: string;
    actor: { kind: "user" | "agent" | "system"; id: string | null };
    userIds: string[];
  },
): Promise<void> {
  const recipients = new Map<string, NotificationKind>();
  for (const id of n.userIds) {
    if (n.actor.kind !== "system" && id === n.actor.id) continue;
    recipients.set(id, n.kind);
  }
  if (recipients.size === 0) return;
  const [row] = await tx
    .select({
      body: messages.body,
      threadId: messages.threadId,
      kind: conversations.kind,
      organizationId: conversations.organizationId,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(messages.id, n.messageId), eq(messages.conversationId, n.conversationId)))
    .limit(1);
  if (!row) return;
  const dir = await loadDirectory(tx);
  await deliver(tx, deps, {
    conv: {
      id: n.conversationId,
      kind: row.kind === "ai_chat" || row.kind === "channel" || row.kind === "group" ? row.kind : "dm",
      organizationId: row.organizationId,
    },
    messageId: n.messageId,
    body: row.body,
    threadRootId: row.threadId,
    actor: authorOf(dir, n.actor.kind, n.actor.id),
    recipients,
  });
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
  const nd: NotificationDeps = { core, access: deps.access };
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

  /**
   * CHAT-10, P-04: a plain top-level channel message for each member who chose "all new messages" there (explicitly,
   * or `default` with a default level of "all"), is not muted, not in DND, is not the author and got no notification
   * row for it. Ephemeral `message.notify` after commit: ordinary messages are never stored on personal streams.
   */
  async function notifyAllLevel(
    tx: Tx,
    input: MessagePostedInput,
    actor: MessageAuthor,
    skip: ReadonlySet<string>,
  ): Promise<void> {
    const { conv, message } = input;
    // Narrowing only (the default level of a missing prefs row is "mentions", which never wants plain messages);
    // decideNotify below is the decision, the resolver decides readability (P-03).
    const candidates = await tx
      .select({
        id: conversationMembers.memberId,
        level: conversationMembers.notifyLevel,
        muted: conversationMembers.muted,
        defaultLevel: notificationPrefs.defaultLevel,
        dndUntil: notificationPrefs.dndUntil,
      })
      .from(conversationMembers)
      .leftJoin(notificationPrefs, eq(notificationPrefs.userId, conversationMembers.memberId))
      .where(
        and(
          eq(conversationMembers.conversationId, conv.id),
          eq(conversationMembers.memberKind, "user"),
          eq(conversationMembers.muted, false),
          or(
            eq(conversationMembers.notifyLevel, "all"),
            and(eq(conversationMembers.notifyLevel, "default"), eq(notificationPrefs.defaultLevel, "all")),
          ),
        ),
      );
    const now = Date.now();
    const wanted = candidates
      .filter((c) => !skip.has(c.id))
      .filter(
        (c) =>
          decideNotify({
            event: "message",
            conversationKind: "channel",
            level: c.level as ConversationNotifyLevel,
            defaultLevel: c.defaultLevel ?? DEFAULT_NOTIFICATION_PREFS.defaultLevel,
            muted: c.muted,
            dndActive: c.dndUntil ? new Date(c.dndUntil).getTime() > now : false,
            actorKind: actor.kind,
          }).popup,
      )
      .map((c) => c.id);
    const ids = await eligible(tx, nd, conv.id, wanted);
    if (ids.length === 0) return;
    // A channel's label is the same for every member.
    const conversation = (
      await conversationRefs(tx, [conv.id], ids[0] as string, await loadDirectory(tx))
    ).get(conv.id);
    if (!conversation) return;
    const ev: MessageNotifyEvent = {
      conversation,
      messageId: message.id,
      actor,
      snippet: snippetOf(message.body),
    };
    tenantOf(tx).afterCommit(async () => {
      for (const id of ids)
        await core.realtime.publishEphemeral(`user:${id}`, EphemeralTypes.messageNotify, ev);
    });
  }

  return {
    async onPosted(tx, input) {
      const { conv, message } = input;
      // A shared AI chat (06-08): its mentioned humans who can read it, nothing else (no @channel, DM or thread rules).
      if (conv.kind === "ai_chat") {
        await notifyUsers(tx, nd, {
          kind: "mention",
          conversationId: conv.id,
          messageId: message.id,
          actor: input.author,
          userIds: input.mentions.filter((m) => m.kind === "user").map((m) => m.id),
        });
        return;
      }
      const threadRootId = input.threadRootId;
      const dir = await loadDirectory(tx);
      const authorUserId = input.author.kind === "user" ? input.author.id : null;
      // 07.17 (PD-14): units resolve on channel posts only (chat's gate, PD-13); their members are offered
      // `team_mention`, and `deliver`'s `eligible` keeps only those who can read this channel.
      const unitIds =
        conv.kind === "channel" ? input.mentions.filter((m) => m.kind === "unit").map((m) => m.id) : [];
      const teamMentions = unitIds.length > 0 ? await teamMentionAudience(tx, { unitIds, authorUserId }) : [];
      const unitOf = new Map<string, string>();
      for (const t of teamMentions) for (const u of t.userIds) if (!unitOf.has(u)) unitOf.set(u, t.unitId);
      const recipients = computeRecipients({
        authorUserId,
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
        teamMentions,
      });
      const actor = message.author ?? authorOf(dir, input.author.kind, input.author.id);
      if (recipients.size > 0) {
        await deliver(tx, nd, {
          conv,
          messageId: message.id,
          body: message.body,
          threadRootId,
          actor,
          recipients,
          unitOf,
        });
      }
      if (conv.kind === "channel" && threadRootId === null) {
        const skip = new Set(recipients.keys());
        if (input.author.kind === "user") skip.add(input.author.id);
        await notifyAllLevel(tx, input, actor, skip);
      }
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
        await deps.access.readableIds(tx, input.userId, { kinds: NOTIFIABLE_KINDS }),
        "all",
      );
      for (let i = 0; i < ids.length; i += READ_EVENT_IDS) {
        const ev: NotificationReadEvent = { ids: ids.slice(i, i + READ_EVENT_IDS), unreadCount };
        await core.realtime.appendEvent(tx, `user:${input.userId}`, EventTypes.notificationRead, ev);
      }
    },

    async onEdited(tx, input) {
      // Only people mentioned now and not before (Pitfall 8); an edit never notifies @channel/@here, nor a team
      // (07.17 PD-14: a unit mention added by an edit is stored and reaches nobody).
      const before = new Set(input.previousMentions.filter((m) => m.kind === "user").map((m) => m.id));
      const recipients = new Map<string, NotificationKind>();
      for (const m of input.message.mentions) {
        if (m.kind === "user" && !before.has(m.id) && m.id !== input.editorId)
          recipients.set(m.id, "mention");
      }
      if (recipients.size === 0) return;
      const dir = await loadDirectory(tx);
      await deliver(tx, nd, {
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
