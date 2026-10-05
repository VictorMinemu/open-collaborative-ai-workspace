import { type DmSummary, EventTypes } from "@ocw/contracts";
import { agents, conversationMembers, conversations, type Tx, tenantOf } from "@ocw/db";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type ChatDeps, type ConversationRow, iso, notifyListChanged } from "./service";

/**
 * Direct conversations (D-03). Phase 3.1 has only human ↔ bot DMs: `kind = 'dm'`, `visibility = 'private'`,
 * exactly two members (the human with role `owner`, the bot), unique per pair through `dm_key`. Human ↔ human
 * and group DMs arrive in Phase 4 (CHAT-02) and extend the key format.
 */

/** Stable pair key: ids only, never names (AGENTS principle 11). */
export function dmKey(agentId: string, userId: string): string {
  return `agent:${agentId}|user:${userId}`;
}

/**
 * The DM between `userId` and the bot `agentId`, created on first use (insert-or-get on the unique `dm_key`,
 * race-safe). On creation the user's sidebar is told through `user:<id>` (private conversations never reach
 * the org topic).
 */
export async function ensureDm(
  tx: Tx,
  deps: ChatDeps,
  p: { agentId: string; userId: string },
): Promise<{ conv: ConversationRow; created: boolean }> {
  const ctx = tenantOf(tx);
  const key = dmKey(p.agentId, p.userId);
  const [inserted] = await tx
    .insert(conversations)
    .values({
      organizationId: ctx.organizationId,
      kind: "dm",
      name: null,
      visibility: "private",
      createdBy: p.userId,
      dmKey: key,
    })
    .onConflictDoNothing({
      target: [conversations.organizationId, conversations.dmKey],
      where: sql`kind = 'dm'`,
    })
    .returning();
  if (!inserted) {
    const [existing] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.kind, "dm"), eq(conversations.dmKey, key)))
      .limit(1);
    if (!existing) throw new Error("dm insert-or-get found no row");
    return { conv: existing, created: false };
  }
  await tx.insert(conversationMembers).values([
    {
      conversationId: inserted.id,
      organizationId: ctx.organizationId,
      memberKind: "user",
      memberId: p.userId,
      role: "owner",
    },
    {
      conversationId: inserted.id,
      organizationId: ctx.organizationId,
      memberKind: "agent",
      memberId: p.agentId,
      role: "member",
    },
  ]);
  await deps.audit.record(tx, {
    action: "dm.created",
    resourceType: "conversation",
    resourceId: inserted.id,
    agentId: p.agentId,
    metadata: { kind: "dm", counterpart: { kind: "agent", id: p.agentId } },
  });
  await notifyListChanged(tx, deps, inserted, EventTypes.conversationCreated);
  return { conv: inserted, created: true };
}

/** The bot of a DM (its only agent member), or null when `convId` is not a DM with a bot. */
export async function dmAgentOf(tx: Tx, convId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: conversationMembers.memberId })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(
      and(
        eq(conversationMembers.conversationId, convId),
        eq(conversationMembers.memberKind, "agent"),
        eq(conversations.kind, "dm"),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * D-04: disabling or deleting a bot archives every DM with it (posting then answers 410 `channel_archived`
 * and the chat leaves each member's sidebar); re-enabling restores them. Runs in the caller's transaction and
 * tells each human member through `user:<id>` (DMs never reach the org topic). Returns how many changed.
 */
export async function setAgentDmsArchived(
  tx: Tx,
  deps: ChatDeps,
  agentId: string,
  archived: boolean,
): Promise<number> {
  const withBot = tx
    .select({ id: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(and(eq(conversationMembers.memberKind, "agent"), eq(conversationMembers.memberId, agentId)));
  const rows = await tx
    .update(conversations)
    .set({ archivedAt: archived ? sql`now()` : null })
    .where(
      and(
        eq(conversations.kind, "dm"),
        inArray(conversations.id, withBot),
        archived ? isNull(conversations.archivedAt) : isNotNull(conversations.archivedAt),
      ),
    )
    .returning();
  for (const conv of rows) await notifyListChanged(tx, deps, conv, EventTypes.conversationUpdated);
  return rows.length;
}

/**
 * The caller's open (non-archived) DMs with their bot counterpart, newest activity first. Callers still
 * decide `channel.read` per row through the resolver (`perms.filter`).
 */
export async function listDms(tx: Tx, userId: string): Promise<DmSummary[]> {
  const me = conversationMembers;
  const bot = alias(conversationMembers, "bot");
  const rows = await tx
    .select({
      c: conversations,
      lastReadSeq: me.lastReadSeq,
      agent: {
        id: agents.id,
        name: agents.name,
        username: agents.username,
        avatarUrl: agents.avatarUrl,
        status: agents.status,
        scope: agents.scope,
      },
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
    })
    .from(conversations)
    .innerJoin(
      me,
      and(eq(me.conversationId, conversations.id), eq(me.memberKind, "user"), eq(me.memberId, userId)),
    )
    .innerJoin(bot, and(eq(bot.conversationId, conversations.id), eq(bot.memberKind, "agent")))
    .innerJoin(agents, eq(agents.id, bot.memberId))
    .where(and(eq(conversations.kind, "dm"), isNull(conversations.archivedAt), isNull(agents.deletedAt)));

  const out: DmSummary[] = rows.map((r) => ({
    id: r.c.id,
    organizationId: r.c.organizationId,
    kind: r.c.kind,
    name: r.c.name,
    slug: r.c.slug,
    topic: r.c.topic,
    visibility: r.c.visibility,
    parentConversationId: r.c.parentConversationId,
    rootMessageId: r.c.rootMessageId,
    createdBy: r.c.createdBy,
    archivedAt: r.c.archivedAt === null ? null : iso(r.c.archivedAt),
    createdAt: iso(r.c.createdAt),
    lastSeq: r.lastSeq,
    counterpart: {
      kind: "agent",
      id: r.agent.id,
      name: r.agent.name,
      username: r.agent.username,
      avatarUrl: r.agent.avatarUrl,
      status: r.agent.status,
      scope: r.agent.scope,
    },
    latestMessageSeq: r.latestMessageSeq,
    lastReadSeq: Number(r.lastReadSeq ?? 0),
    lastMessageAt: r.lastMessageAt === null ? null : iso(r.lastMessageAt),
  }));
  // Personal bots first, then by most recent activity (new DMs without messages by creation time).
  return out.sort((a, b) => {
    if (a.counterpart.scope !== b.counterpart.scope) return a.counterpart.scope === "personal" ? -1 : 1;
    const at = Date.parse(a.lastMessageAt ?? a.createdAt);
    const bt = Date.parse(b.lastMessageAt ?? b.createdAt);
    return bt - at;
  });
}
