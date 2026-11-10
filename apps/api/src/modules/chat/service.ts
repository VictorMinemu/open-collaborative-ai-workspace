import {
  type AgentCardInput,
  type ChannelMember,
  type ChannelSummary,
  type ChannelUnit,
  type ConversationNotifyLevel,
  EventTypes,
  MENTION_KINDS,
  type Message,
  type MessageAuthor,
  type MessageMention,
  type ThreadUpdatedEvent,
  UNREAD_CAP,
} from "@ocw/contracts";
import {
  conversationMembers,
  conversations,
  messages,
  orgUnits,
  type Tx,
  tenantOf,
  unitMemberships,
} from "@ocw/db";
import { and, asc, desc, eq, gt, inArray, isNull, lt, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { PlatformCardInput } from "../../lib/chat-agent-bridge";
import { badRequest, notFound } from "../../lib/errors";
import { attachmentsForMessages, linkAttachments } from "../artifact";
import type { AuditService } from "../audit";
import type { ChannelFacts } from "../organization";
import type { RealtimeService } from "../realtime";
import { withActivity } from "./activity";
import { cardOf, insertCard, withCards } from "./card-actions";
import { withConsults } from "./consults";
import { authorOf, type Directory } from "./directory";
import { pinnedFor } from "./pins";
import { reactionsFor } from "./reactions";
import { savedFor } from "./saves";

/**
 * Chat domain logic. Every function runs inside the caller's `withTenant()` transaction, so RLS scopes all
 * reads and writes to the tenant; cross-org ids simply do not exist here.
 */

export const GENERAL_SLUG = "general";
export const GENERAL_TOPIC = "Company-wide announcements and everything that concerns the whole team";
export const convTopic = (id: string) => `conv:${id}`;

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

export interface ChatDeps {
  audit: AuditService;
  realtime: RealtimeService;
}

export function iso(v: unknown): string {
  return new Date(v as string).toISOString();
}
const isoOrNull = (v: unknown) => (v == null ? null : iso(v));

// ---------------------------------------------------------------- access

export async function getChannel(tx: Tx, id: string): Promise<ConversationRow | null> {
  const [row] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.kind, "channel")))
    .limit(1);
  return row ?? null;
}

/**
 * A conversation of one of `kinds` (D-03: message routes, read markers, the `conv:` topic and the agent reply
 * path accept `channel | dm`; `/channels/*` routes stay channel-only through `getChannel`; the `conv:` topic and
 * the ai-chat module also pass `ai_chat`, P-03).
 */
export async function getConversation(
  tx: Tx,
  id: string,
  kinds: ReadonlyArray<"channel" | "dm" | "group" | "ai_chat">,
): Promise<ConversationRow | null> {
  const [row] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), inArray(conversations.kind, [...kinds])))
    .limit(1);
  return row ?? null;
}

export async function getMembership(
  tx: Tx,
  conversationId: string,
  kind: "user" | "agent",
  memberId: string,
) {
  const [row] = await tx
    .select()
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.memberKind, kind),
        eq(conversationMembers.memberId, memberId),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------- channels

/**
 * Lazily seeds the org-wide `#general` (every org member joins it) and makes sure `userId` is in it.
 * Idempotent and race-safe (partial unique index on (organization_id, slug) for channels).
 */
export async function ensureGeneral(tx: Tx, deps: ChatDeps, userId: string): Promise<void> {
  const ctx = tenantOf(tx);
  let general = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.kind, "channel"), eq(conversations.slug, GENERAL_SLUG)))
    .limit(1)
    .then((r) => r[0]);
  if (!general) {
    const res = await tx.execute(sql`
      insert into app.conversations (organization_id, kind, name, slug, topic, visibility, created_by)
      values (${ctx.organizationId}, 'channel', ${GENERAL_SLUG}, ${GENERAL_SLUG}, ${GENERAL_TOPIC}, 'public', ${userId})
      on conflict (organization_id, slug) where kind = 'channel' and slug is not null do nothing
      returning id`);
    const created = res.rows[0] as { id: string } | undefined;
    if (created) {
      general = created;
      await tx.execute(sql`
        insert into app.conversation_members (conversation_id, organization_id, member_kind, member_id, role)
        select ${created.id}, ${ctx.organizationId}, 'user', m.user_id,
               case when m.role = 'admin' then 'owner' else 'member' end
        from app.org_members m
        on conflict do nothing`);
      await deps.audit.record(tx, {
        action: "channel.created",
        resourceType: "conversation",
        resourceId: created.id,
        metadata: { name: GENERAL_SLUG, visibility: "public", seeded: true },
      });
      await deps.realtime.appendEvent(tx, `org:${ctx.organizationId}`, EventTypes.conversationCreated, {
        conversationId: created.id,
      });
    } else {
      general = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.kind, "channel"), eq(conversations.slug, GENERAL_SLUG)))
        .limit(1)
        .then((r) => r[0]);
    }
  }
  if (general) {
    await tx
      .insert(conversationMembers)
      .values({
        conversationId: general.id,
        organizationId: ctx.organizationId,
        memberKind: "user",
        memberId: userId,
      })
      .onConflictDoNothing();
  }
}

/** Channel row plus the caller's facts, so routes ask the permission service whether it is visible. */
export interface ChannelRow {
  summary: ChannelSummary;
  facts: ChannelFacts;
}

/**
 * Every channel of the tenant with `userId`'s membership (no visibility filtering here: callers keep the
 * rows the resolver allows with `perms.filter(…, "channel.read", …)`); archived ones only when `id` is given.
 */
export async function listChannels(tx: Tx, userId: string, id?: string): Promise<ChannelRow[]> {
  const me = conversationMembers;
  const rows = await tx
    .select({
      c: conversations,
      memberId: me.memberId,
      memberRole: me.role,
      lastReadSeq: me.lastReadSeq,
      notifyLevel: me.notifyLevel,
      muted: me.muted,
      memberCount:
        sql<number>`(select count(*) from app.conversation_members cm where cm.conversation_id = ${conversations.id})`.mapWith(
          Number,
        ),
      latestMessageSeq:
        sql<number>`(select coalesce(max(m.seq), 0) from app.messages m where m.conversation_id = ${conversations.id} and m.thread_id is null)`.mapWith(
          Number,
        ),
      lastMessageAt: sql<
        string | null
      >`(select max(m.created_at) from app.messages m where m.conversation_id = ${conversations.id} and m.thread_id is null)`,
      lastSeq:
        sql<number>`(select coalesce(max(s.last_seq), 0) from app.streams s where s.id = 'conv:' || ${conversations.id}::text)`.mapWith(
          Number,
        ),
      // The sidebar's All view (CHAT-02): the latest live top-level message as one line of plain text.
      lastMessagePreview: sql<
        string | null
      >`(select nullif(left(btrim(regexp_replace(m.body, '\\s+', ' ', 'g')), 140), '') from app.messages m where m.conversation_id = ${conversations.id} and m.thread_id is null and m.deleted_at is null order by m.seq desc limit 1)`,
      unitId: orgUnits.id,
      unitName: orgUnits.name,
      unitKind: orgUnits.kind,
      unitPath: orgUnits.path,
      unitPathNames: sql<
        string[] | null
      >`(select array_agg(u2.name order by array_position(${orgUnits.path}, u2.id)) from app.org_units u2 where u2.id = any(${orgUnits.path}))`,
    })
    .from(conversations)
    .leftJoin(
      me,
      and(eq(me.conversationId, conversations.id), eq(me.memberKind, "user"), eq(me.memberId, userId)),
    )
    .leftJoin(orgUnits, eq(orgUnits.id, conversations.unitId))
    .where(
      and(
        eq(conversations.kind, "channel"),
        id ? eq(conversations.id, id) : isNull(conversations.archivedAt),
      ),
    )
    .orderBy(asc(conversations.name));
  return rows.map((r) => {
    const unit: ChannelUnit | null =
      r.unitId && r.unitName && r.unitKind && r.unitPath
        ? {
            id: r.unitId,
            name: r.unitName,
            kind: r.unitKind,
            path: r.unitPath,
            pathNames: r.unitPathNames ?? [r.unitName],
          }
        : null;
    return {
      summary: {
        id: r.c.id,
        organizationId: r.c.organizationId,
        kind: r.c.kind,
        name: r.c.name,
        slug: r.c.slug,
        layout: r.c.layout,
        topic: r.c.topic,
        visibility: r.c.visibility,
        parentConversationId: r.c.parentConversationId,
        rootMessageId: r.c.rootMessageId,
        createdBy: r.c.createdBy,
        archivedAt: isoOrNull(r.c.archivedAt),
        createdAt: iso(r.c.createdAt),
        lastSeq: r.lastSeq,
        isMember: r.memberId !== null,
        memberCount: r.memberCount,
        latestMessageSeq: r.latestMessageSeq,
        lastReadSeq: r.memberId !== null ? Number(r.lastReadSeq ?? 0) : 0,
        lastMessageAt: isoOrNull(r.lastMessageAt),
        lastMessagePreview: r.lastMessagePreview ?? null,
        isDefault: r.c.slug === GENERAL_SLUG,
        unit,
        notifyLevel: (r.notifyLevel ?? "default") as ConversationNotifyLevel,
        muted: r.muted ?? false,
        // Filled for the rows the resolver keeps (`withUnreadCounts`); a non-member has nothing unread.
        unreadCount: 0,
        mentionCount: 0,
      },
      facts: {
        visibility: r.c.visibility,
        archived: r.c.archivedAt !== null,
        viewerRole: r.memberId !== null ? r.memberRole : null,
        unitPath: unit?.path ?? [],
      },
    };
  });
}

export interface UnreadCounts {
  unreadCount: number;
  mentionCount: number;
}

/**
 * CHAT-09 (D-07, P-07): the badges of `userId`'s memberships among `conversationIds`. Unread = top-level, live
 * messages from others (never a server notice line, `author_kind 'system'`, 06-08) after the member's read cursor, counted (never `streams.last_seq - last_read_seq`, Pitfall 1)
 * and capped at `UNREAD_CAP` on `messages_conv_seq_idx`; mentions = the member's unread mention-like notifications
 * (`MENTION_KINDS`) of live top-level messages there, on `notifications_unread_idx` (a mention inside a thread
 * belongs to that thread). Conversations the member has not joined are absent (= nothing unread). Callers pass only
 * ids the resolver already lets the member read (T-04-10-01).
 */
export async function unreadCountsFor(
  tx: Tx,
  userId: string,
  conversationIds: string[],
): Promise<Map<string, UnreadCounts>> {
  const out = new Map<string, UnreadCounts>();
  if (conversationIds.length === 0) return out;
  const ids = sql.join(
    conversationIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const kinds = sql.join(
    MENTION_KINDS.map((k) => sql`${k}`),
    sql`, `,
  );
  const res = await tx.execute(sql`
    select cm.conversation_id as id, u.n as unread, x.n as mentions
    from app.conversation_members cm
    cross join lateral (
      select count(*)::int as n from (
        select 1 from app.messages m
        where m.organization_id = cm.organization_id and m.conversation_id = cm.conversation_id
          and m.thread_id is null and m.deleted_at is null and m.seq > cm.last_read_seq
          and not (m.author_kind = 'user' and m.author_id = ${userId}::uuid)
          and m.author_kind <> 'system'
        limit ${UNREAD_CAP}
      ) capped
    ) u
    cross join lateral (
      select count(*)::int as n from (
        select 1 from app.notifications n
        join app.messages m on m.id = n.message_id and m.deleted_at is null
        where n.organization_id = cm.organization_id and n.user_id = ${userId}::uuid
          and n.conversation_id = cm.conversation_id and n.read_at is null
          and n.thread_root_id is null and n.kind in (${kinds})
        limit ${UNREAD_CAP}
      ) capped
    ) x
    where cm.member_kind = 'user' and cm.member_id = ${userId}::uuid and cm.conversation_id in (${ids})`);
  for (const r of res.rows as Array<{ id: string; unread: number; mentions: number }>) {
    out.set(r.id, { unreadCount: Number(r.unread), mentionCount: Number(r.mentions) });
  }
  return out;
}

/** The channel summaries with the caller's badges (P-07); rows must already be filtered by the resolver. */
export async function withUnreadCounts<T extends { id: string; isMember?: boolean }>(
  tx: Tx,
  userId: string,
  rows: T[],
): Promise<Array<T & UnreadCounts>> {
  const counts = await unreadCountsFor(
    tx,
    userId,
    rows.filter((r) => r.isMember !== false).map((r) => r.id),
  );
  return rows.map((r) => ({ ...r, ...(counts.get(r.id) ?? { unreadCount: 0, mentionCount: 0 }) }));
}

/** The unit path (root → self) of a channel's unit; [] for the organization (and every direct conversation). */
export async function unitPathOf(tx: Tx, unitId: string | null): Promise<string[]> {
  if (!unitId) return [];
  const [u] = await tx.select({ path: orgUnits.path }).from(orgUnits).where(eq(orgUnits.id, unitId)).limit(1);
  return u?.path ?? [];
}

/**
 * Every unit on the paths (root → self) of `userId`'s unit memberships (member or lead): where the user may place
 * a channel, and the departments the sidebar lists first.
 */
export async function memberUnitIdsOf(tx: Tx, userId: string): Promise<string[]> {
  const rows = await tx
    .select({ path: orgUnits.path })
    .from(unitMemberships)
    .innerJoin(orgUnits, eq(orgUnits.id, unitMemberships.unitId))
    .where(eq(unitMemberships.userId, userId));
  return [...new Set(rows.flatMap((r) => r.path))];
}

/** One channel row (archived included); 404 when it does not exist in the tenant. */
export async function channelRow(tx: Tx, id: string, userId: string): Promise<ChannelRow> {
  const [row] = await listChannels(tx, userId, id);
  if (!row) throw notFound("Channel not found");
  return row;
}

/**
 * Whether the grant row aliased `ag` matches `userId` (P-03, D-03): a person grant names the user; a unit grant names
 * any unit on the paths (root → self) of the user's unit memberships, so a department grant covers its teams and
 * projects; an organization grant covers every active member. Shared by `aiAccessSql` and the send context
 * (`matchingGrant`), so the two cannot drift.
 */
export function aiGrantMatchSql(userId: string | SQL | AnyPgColumn): SQL {
  return sql`(
    (ag.subject_kind = 'user' and ag.subject_id = ${userId})
    or (ag.subject_kind = 'unit' and exists (
          select 1 from app.unit_memberships um
          join app.org_units ou on ou.id = um.unit_id and ou.organization_id = um.organization_id
          where um.organization_id = ag.organization_id and um.user_id = ${userId}
            and ag.subject_id = any(ou.path)))
    or (ag.subject_kind = 'org' and exists (
          select 1 from app.org_members om
          where om.organization_id = ag.organization_id and om.user_id = ${userId} and om.deactivated_at is null))
  )`;
}

/**
 * THE access level of a user to an AI chat (P-03), as one SQL expression: `'owner'` for `ai_chats.owner_user_id`,
 * else the best active grant that matches the user (`'chat'` beats `'view'`) through `aiGrantMatchSql` (person, unit
 * subtree or organization subjects), else NULL. `channelFacts` and the readable set both use it, so they cannot
 * drift; `conversation_members` rows never enter it.
 */
export function aiAccessSql(userId: string | SQL | AnyPgColumn, conversationIdCol: SQL | AnyPgColumn): SQL {
  return sql`(case
    when exists (select 1 from app.ai_chats ac
                 where ac.conversation_id = ${conversationIdCol} and ac.owner_user_id = ${userId}) then 'owner'
    when exists (select 1 from app.ai_chat_grants ag
                 where ag.conversation_id = ${conversationIdCol} and ag.revoked_at is null
                   and ag.level = 'chat' and ${aiGrantMatchSql(userId)}) then 'chat'
    when exists (select 1 from app.ai_chat_grants ag
                 where ag.conversation_id = ${conversationIdCol} and ag.revoked_at is null
                   and ag.level = 'view' and ${aiGrantMatchSql(userId)}) then 'view'
  end)`;
}

export type AiAccess = "owner" | "chat" | "view" | null;

/** `aiAccessSql` for one user and one AI chat. */
export async function aiAccessOf(tx: Tx, userId: string, conversationId: string): Promise<AiAccess> {
  const res = await tx.execute(sql`select ${aiAccessSql(userId, sql`${conversationId}::uuid`)} as access`);
  return ((res.rows[0] as { access: AiAccess } | undefined)?.access ?? null) as AiAccess;
}

/**
 * The input of `channelResource` for one member (user or agent) of `conv`: visibility, archived state and
 * the member's role. A thread conversation is judged on its parent channel.
 */
export async function channelFacts(
  tx: Tx,
  conv: ConversationRow,
  member: { kind: "user" | "agent"; id: string },
): Promise<ChannelFacts> {
  let channel = conv;
  if (conv.kind === "thread" && conv.parentConversationId) {
    const [parent] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.parentConversationId))
      .limit(1);
    if (parent) channel = parent;
  }
  const membership = await getMembership(tx, channel.id, member.kind, member.id);
  return {
    visibility: channel.visibility,
    archived: channel.archivedAt !== null,
    viewerRole: membership?.role ?? null,
    // P-03: a human's access to an AI chat comes from its owner and grants only; agents keep their member row.
    ...(channel.kind === "ai_chat" && member.kind === "user"
      ? { aiAccess: await aiAccessOf(tx, member.id, channel.id) }
      : {}),
    // Group DMs are direct conversations too: fixed membership, never moderated (D-01, D-06; state dm). An AI chat
    // is private to its owner (state ai_chat, P-03).
    kind:
      channel.kind === "dm" || channel.kind === "group" || channel.kind === "ai_chat"
        ? channel.kind
        : "channel",
    // Unit-scoped rules apply to the unit's channels (CHAT-02, principle 6).
    unitPath: channel.kind === "channel" ? await unitPathOf(tx, channel.unitId) : [],
  };
}

/** Tells sidebars that the channel list changed: org topic for public channels, member user topics for private. */
export async function notifyListChanged(
  tx: Tx,
  deps: ChatDeps,
  conv: ConversationRow,
  type: string,
  extraUserIds: string[] = [],
): Promise<void> {
  const payload = { conversationId: conv.id };
  if (conv.visibility === "public") {
    await deps.realtime.appendEvent(tx, `org:${conv.organizationId}`, type, payload);
  } else {
    const rows = await tx
      .select({ id: conversationMembers.memberId })
      .from(conversationMembers)
      .where(
        and(eq(conversationMembers.conversationId, conv.id), eq(conversationMembers.memberKind, "user")),
      );
    const ids = new Set([...rows.map((r) => r.id), ...extraUserIds]);
    for (const uid of ids) await deps.realtime.appendEvent(tx, `user:${uid}`, type, payload);
  }
}

// ---------------------------------------------------------------- members

export async function listChannelMembers(
  tx: Tx,
  conversationId: string,
  dir: Directory,
): Promise<ChannelMember[]> {
  const rows = await tx
    .select()
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conversationId))
    .orderBy(asc(conversationMembers.joinedAt));
  const out: ChannelMember[] = [];
  for (const r of rows) {
    const e = r.memberKind === "agent" ? dir.agents.get(r.memberId) : dir.users.get(r.memberId);
    if (!e) continue; // removed from the org / deleted agent
    out.push({
      kind: r.memberKind,
      id: r.memberId,
      displayName: e.displayName,
      handle: e.handle,
      avatarUrl: e.avatarUrl,
      role: r.role,
      joinedAt: iso(r.joinedAt),
    });
  }
  // Humans first (alphabetical), then agents.
  return out.sort((a, b) =>
    a.kind === b.kind ? a.displayName.localeCompare(b.displayName) : a.kind === "user" ? -1 : 1,
  );
}

/**
 * Adds a user or agent to a channel (idempotent). Returns true when a row was inserted. Emits
 * `conversation.member_added` on the channel and refreshes the new member's sidebar; audits.
 */
export async function addMember(
  tx: Tx,
  deps: ChatDeps,
  conv: ConversationRow,
  member: { kind: "user" | "agent"; id: string },
  opts: { role?: "owner" | "member"; reason?: string } = {},
): Promise<boolean> {
  const inserted = await tx
    .insert(conversationMembers)
    .values({
      conversationId: conv.id,
      organizationId: conv.organizationId,
      memberKind: member.kind,
      memberId: member.id,
      role: opts.role ?? "member",
    })
    .onConflictDoNothing()
    .returning({ id: conversationMembers.memberId });
  if (inserted.length === 0) return false;
  await deps.audit.record(tx, {
    action: "channel.member_added",
    resourceType: "conversation",
    resourceId: conv.id,
    agentId: member.kind === "agent" ? member.id : null,
    metadata: {
      memberKind: member.kind,
      memberId: member.id,
      ...(opts.reason ? { reason: opts.reason } : {}),
    },
  });
  await deps.realtime.appendEvent(tx, convTopic(conv.id), EventTypes.conversationMemberAdded, {
    conversationId: conv.id,
    member,
  });
  if (member.kind === "user") {
    await deps.realtime.appendEvent(tx, `user:${member.id}`, EventTypes.conversationMemberAdded, {
      conversationId: conv.id,
    });
  }
  return true;
}

export async function removeMember(
  tx: Tx,
  deps: ChatDeps,
  conv: ConversationRow,
  member: { kind: "user" | "agent"; id: string },
): Promise<boolean> {
  const removed = await tx
    .delete(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conv.id),
        eq(conversationMembers.memberKind, member.kind),
        eq(conversationMembers.memberId, member.id),
      ),
    )
    .returning({ id: conversationMembers.memberId });
  if (removed.length === 0) return false;
  await deps.audit.record(tx, {
    action: "channel.member_removed",
    resourceType: "conversation",
    resourceId: conv.id,
    agentId: member.kind === "agent" ? member.id : null,
    metadata: { memberKind: member.kind, memberId: member.id },
  });
  await deps.realtime.appendEvent(tx, convTopic(conv.id), EventTypes.conversationMemberRemoved, {
    conversationId: conv.id,
    member,
  });
  if (member.kind === "user") {
    await deps.realtime.appendEvent(tx, `user:${member.id}`, EventTypes.conversationMemberRemoved, {
      conversationId: conv.id,
    });
  }
  return true;
}

// ---------------------------------------------------------------- messages

export async function replyParticipantsFor(
  tx: Tx,
  rootIds: string[],
  dir: Directory,
): Promise<Map<string, MessageAuthor[]>> {
  const out = new Map<string, MessageAuthor[]>();
  if (rootIds.length === 0) return out;
  const rows = await tx
    .select({
      threadId: messages.threadId,
      authorKind: messages.authorKind,
      authorId: messages.authorId,
      last: sql<string>`max(${messages.createdAt})`,
    })
    .from(messages)
    // Deleted replies no longer count as participation (P-05).
    .where(and(inArray(messages.threadId, rootIds), isNull(messages.deletedAt)))
    .groupBy(messages.threadId, messages.authorKind, messages.authorId);
  const sorted = rows.sort((a, b) => new Date(b.last).getTime() - new Date(a.last).getTime());
  for (const r of sorted) {
    if (!r.threadId) continue;
    const list = out.get(r.threadId) ?? [];
    if (list.length < 5) list.push(authorOf(dir, r.authorKind, r.authorId));
    out.set(r.threadId, list);
  }
  return out;
}

export function toMessage(row: MessageRow, dir: Directory, replyParticipants?: MessageAuthor[]): Message {
  return {
    id: row.id,
    organizationId: row.organizationId,
    conversationId: row.conversationId,
    seq: row.seq,
    authorKind: row.authorKind,
    authorId: row.authorId,
    author: authorOf(dir, row.authorKind, row.authorId),
    body: row.body,
    mentions: row.mentions,
    status: row.status,
    threadId: row.threadId,
    replyCount: row.replyCount,
    lastReplyAt: isoOrNull(row.lastReplyAt),
    clientKind: (row.clientKind as Message["clientKind"]) ?? null,
    createdAt: iso(row.createdAt),
    editedAt: isoOrNull(row.editedAt),
    deletedAt: isoOrNull(row.deletedAt),
    ...(replyParticipants ? { replyParticipants } : {}),
  };
}

/** Adds `attachments` (ready files, upload order; one batched query) to message DTOs; tombstones get none (P-05). */
export async function withAttachments(tx: Tx, list: Message[]): Promise<Message[]> {
  const files = await attachmentsForMessages(
    tx,
    list.filter((m) => !m.deletedAt).map((m) => m.id),
  );
  return list.map((m) => ({ ...m, attachments: m.deletedAt ? [] : (files.get(m.id) ?? []) }));
}

/**
 * Adds the viewer-specific fields (P-04) to REST snapshots: `reactions` with `mine` for `viewerId`, `pinned` and
 * whether `viewerId` saved it, plus the message's `attachments` (CHAT-12), so every page, thread, pin and saved
 * list shows its files. Tombstones carry no reactions, no pin and no attachments (P-05). Realtime payloads never go
 * through here (they carry `attachments` themselves).
 */
export async function hydrateViewer(tx: Tx, list: Message[], viewerId: string): Promise<Message[]> {
  const live = list.filter((m) => !m.deletedAt).map((m) => m.id);
  const reactions = await reactionsFor(tx, live, viewerId);
  const pinned = await pinnedFor(tx, live);
  const saved = await savedFor(tx, live, viewerId);
  const hydrated = (await withAttachments(tx, list)).map((m) =>
    m.deletedAt
      ? { ...m, reactions: [], pinned: false, saved: false }
      : { ...m, reactions: reactions.get(m.id) ?? [], pinned: pinned.has(m.id), saved: saved.has(m.id) },
  );
  // Agent Cards (P-11) with the viewer's fields (following, viewerCan); a bot reply's turn activity (07.8-10, R2),
  // the same for every viewer.
  // Phase 07.7 (D-15): a consult hop's question or answer carries its hop state, the same for every viewer.
  return withConsults(tx, await withActivity(tx, await withCards(tx, hydrated, viewerId)));
}

/** Top-level messages of a channel, newest page first in the DB, returned oldest → newest. */
export async function listMessages(
  tx: Tx,
  conversationId: string,
  dir: Directory,
  page: { before?: number | undefined; limit: number },
  viewerId: string,
): Promise<{ messages: Message[]; nextBefore: number | null }> {
  const rows = await tx
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        isNull(messages.threadId),
        page.before ? lt(messages.seq, page.before) : undefined,
      ),
    )
    .orderBy(desc(messages.seq))
    .limit(page.limit + 1);
  const hasMore = rows.length > page.limit;
  const pageRows = rows.slice(0, page.limit).reverse();
  return {
    messages: await topLevelDtos(tx, pageRows, dir, viewerId),
    nextBefore: hasMore ? (pageRows[0]?.seq ?? null) : null,
  };
}

/**
 * DTOs for top-level rows (ascending), with reply participants on thread roots and the viewer's fields, exactly
 * like `listMessages`.
 */
async function topLevelDtos(
  tx: Tx,
  rows: MessageRow[],
  dir: Directory,
  viewerId: string,
): Promise<Message[]> {
  const participants = await replyParticipantsFor(
    tx,
    rows.filter((r) => r.replyCount > 0).map((r) => r.id),
    dir,
  );
  return hydrateViewer(
    tx,
    rows.map((r) => toMessage(r, dir, r.replyCount > 0 ? (participants.get(r.id) ?? []) : [])),
    viewerId,
  );
}

/**
 * A page centred on a top-level `anchor` (permalinks, CHAT-14): `floor(limit / 2)` older messages, the anchor,
 * then the rest newer, ascending. Tombstones are included (P-05: the client decides what to show). The caller
 * resolves a thread reply to its root before calling. `nextBefore`/`nextAfter` are null at either end.
 */
export async function listMessagesAround(
  tx: Tx,
  conversationId: string,
  dir: Directory,
  anchor: MessageRow,
  limit: number,
  viewerId: string,
): Promise<{ messages: Message[]; nextBefore: number | null; nextAfter: number | null; anchorId: string }> {
  const olderWanted = Math.floor(limit / 2);
  const newerWanted = Math.max(0, limit - 1 - olderWanted);
  const topLevel = and(eq(messages.conversationId, conversationId), isNull(messages.threadId));
  const older = await tx
    .select()
    .from(messages)
    .where(and(topLevel, lt(messages.seq, anchor.seq)))
    .orderBy(desc(messages.seq))
    .limit(olderWanted + 1);
  const newer = await tx
    .select()
    .from(messages)
    .where(and(topLevel, gt(messages.seq, anchor.seq)))
    .orderBy(asc(messages.seq))
    .limit(newerWanted + 1);
  const olderRows = older.slice(0, olderWanted).reverse();
  const newerRows = newer.slice(0, newerWanted);
  const rows = [...olderRows, anchor, ...newerRows];
  return {
    messages: await topLevelDtos(tx, rows, dir, viewerId),
    nextBefore: older.length > olderWanted ? (rows[0]?.seq ?? null) : null,
    nextAfter: newer.length > newerWanted ? (rows.at(-1)?.seq ?? null) : null,
    anchorId: anchor.id,
  };
}

/** Top-level messages with seq > `after`, ascending (forward paging of a detached window). */
export async function listMessagesAfter(
  tx: Tx,
  conversationId: string,
  dir: Directory,
  after: number,
  limit: number,
  viewerId: string,
): Promise<{ messages: Message[]; nextAfter: number | null }> {
  const rows = await tx
    .select()
    .from(messages)
    .where(
      and(eq(messages.conversationId, conversationId), isNull(messages.threadId), gt(messages.seq, after)),
    )
    .orderBy(asc(messages.seq))
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit);
  return {
    messages: await topLevelDtos(tx, pageRows, dir, viewerId),
    nextAfter: rows.length > limit ? (pageRows.at(-1)?.seq ?? null) : null,
  };
}

export async function getMessage(tx: Tx, id: string): Promise<MessageRow | null> {
  const [row] = await tx.select().from(messages).where(eq(messages.id, id)).limit(1);
  return row ?? null;
}

/** Root + replies (oldest first) for the thread containing `messageId` (a root or one of its replies). */
export async function loadThread(tx: Tx, messageId: string) {
  const msg = await getMessage(tx, messageId);
  if (!msg) return null;
  const root = msg.threadId ? await getMessage(tx, msg.threadId) : msg;
  if (!root) return null;
  const replies = await tx
    .select()
    .from(messages)
    .where(eq(messages.threadId, root.id))
    .orderBy(asc(messages.seq));
  return { root, replies };
}

/**
 * Locks the conversation stream row and returns the seq the next `appendEvent` on it will get, so the
 * message row can carry the seq of its own `message.created` event.
 */
export async function lockNextSeq(tx: Tx, topic: string): Promise<number> {
  const ctx = tenantOf(tx);
  await tx.execute(sql`
    insert into app.streams (id, organization_id, last_seq) values (${topic}, ${ctx.organizationId}, 0)
    on conflict (id) do nothing`);
  const res = await tx.execute(sql`select last_seq from app.streams where id = ${topic} for update`);
  return Number((res.rows[0] as { last_seq: number | string }).last_seq) + 1;
}

export interface PostInput {
  conv: ConversationRow;
  author: { kind: "user" | "agent"; id: string };
  body: string;
  mentions: MessageMention[];
  threadRootId?: string | null | undefined;
  clientMessageId?: string | null | undefined;
  clientKind: "web" | "desktop" | "mobile" | "agent" | "system";
  sessionId?: string | null;
  /** Agents may answer a reply id; it is normalised to its root instead of being refused. */
  lenientThreadRoot?: boolean;
  /**
   * Files the author uploaded to this conversation (CHAT-12), linked in this transaction before `message.created`
   * is appended, so the event carries them. Any id that is not linkable rolls the post back (409).
   */
  attachmentIds?: string[] | undefined;
  /**
   * An Agent Card (P-11, agents only): inserted with the message before `message.created` is appended, so the event
   * carries it; `body` is its plain-text summary.
   */
  card?: AgentCardInput | PlatformCardInput | undefined;
  /** Phase 07.2: the card is server-composed (an approval mirror); agents can never patch it. */
  cardPlatformOwned?: boolean | undefined;
  /**
   * Phase 07.8 (07.8-10, agents only): runs in this transaction right after the new row is inserted and before
   * `message.created` is appended (the Agent Channel attaches the turn's activity and links the files the bot shared in
   * that turn), so the event carries both. Not called on an idempotent retry.
   */
  onInserted?: ((tx: Tx, messageId: string) => Promise<void>) | undefined;
}

export interface PostResult {
  row: MessageRow;
  message: Message;
  created: boolean;
  root: MessageRow | null;
}

/**
 * Inserts a message (top-level or thread reply), emits `message.created` (and `thread.updated` for replies)
 * on `conv:<id>`. Idempotent on (author, clientMessageId): a retry returns the existing row, created=false.
 */
export async function postMessage(
  tx: Tx,
  deps: ChatDeps,
  dir: Directory,
  input: PostInput,
): Promise<PostResult> {
  const { conv, author } = input;
  const topic = convTopic(conv.id);
  // Serialises writers on this conversation; also makes the idempotency check below race-free.
  const nextSeq = await lockNextSeq(tx, topic);

  if (input.clientMessageId) {
    const [existing] = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.authorKind, author.kind),
          eq(messages.authorId, author.id),
          eq(messages.clientMessageId, input.clientMessageId),
        ),
      )
      .limit(1);
    if (existing) {
      const root = existing.threadId ? await getMessage(tx, existing.threadId) : null;
      const [message] = await withAttachments(tx, [toMessage(existing, dir)]);
      const card = await cardOf(tx, existing.id);
      return { row: existing, message: card ? { ...message!, card } : message!, created: false, root };
    }
  }

  let root: MessageRow | null = null;
  if (input.threadRootId) {
    root = await getMessage(tx, input.threadRootId);
    if (!root || root.conversationId !== conv.id) throw notFound("Thread not found");
    if (root.threadId) {
      if (!input.lenientThreadRoot) {
        throw badRequest("Threads are single-level: reply to the thread root", "thread_nesting");
      }
      root = await getMessage(tx, root.threadId);
      if (!root) throw notFound("Thread not found");
    }
  }

  const [row] = await tx
    .insert(messages)
    .values({
      organizationId: conv.organizationId,
      conversationId: conv.id,
      seq: nextSeq,
      authorKind: author.kind,
      authorId: author.id,
      body: input.body,
      mentions: input.mentions,
      threadId: root?.id ?? null,
      clientKind: input.clientKind,
      sessionId: input.sessionId ?? null,
      clientMessageId: input.clientMessageId ?? null,
    })
    .returning();
  if (!row) throw new Error("message insert returned no row");
  let message = toMessage(row, dir, root ? undefined : []);
  if (input.onInserted) {
    if (author.kind !== "agent") throw new Error("only agent posts run onInserted");
    await input.onInserted(tx, row.id);
    const [hydrated] = await withAttachments(tx, [message]);
    if (!hydrated) throw new Error("message DTO missing");
    message = hydrated;
  }
  if (input.attachmentIds?.length) {
    await linkAttachments(tx, {
      conversationId: conv.id,
      messageId: row.id,
      uploaderId: author.id,
      ids: input.attachmentIds,
    });
    const [hydrated] = await withAttachments(tx, [message]);
    if (!hydrated) throw new Error("message DTO missing");
    message = hydrated;
  }
  if (input.card) {
    if (author.kind !== "agent") throw new Error("only agents post cards");
    message = {
      ...message,
      card: await insertCard(tx, {
        message: row,
        agentId: author.id,
        input: input.card,
        platformOwned: input.cardPlatformOwned === true,
      }),
    };
  }
  // A bot reply carries its turn's activity (07.8-10, R2): viewer-agnostic, so it may ride the event.
  // Phase 07.7 (D-15): a consult question carries its hop (inserted by `onInserted` above) in its own `message.created`.
  if (author.kind === "agent")
    [message] = (await withConsults(tx, await withActivity(tx, [message]))) as [Message];
  const seq = await deps.realtime.appendEvent(tx, topic, EventTypes.messageCreated, { message });
  if (seq !== nextSeq) throw new Error(`stream seq drift on ${topic}: expected ${nextSeq}, got ${seq}`);

  if (root) {
    const [updated] = await tx
      .update(messages)
      .set({ replyCount: sql`${messages.replyCount} + 1`, lastReplyAt: row.createdAt })
      .where(eq(messages.id, root.id))
      .returning();
    if (updated) {
      root = updated;
      const participants = (await replyParticipantsFor(tx, [root.id], dir)).get(root.id) ?? [];
      const ev: ThreadUpdatedEvent = {
        rootId: root.id,
        replyCount: root.replyCount,
        lastReplyAt: isoOrNull(root.lastReplyAt),
        replyParticipants: participants,
      };
      await deps.realtime.appendEvent(tx, topic, EventTypes.threadUpdated, ev);
    }
  }
  return { row, message, created: true, root };
}
