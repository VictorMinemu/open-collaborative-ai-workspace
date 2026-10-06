import {
  type DmCounterpart,
  type DmGroupMember,
  type DmSummary,
  dmKeyOf,
  EventTypes,
  MAX_GROUP_PARTICIPANTS,
  userHandle,
} from "@ocw/contracts";
import { agents, conversationMembers, conversations, orgMembers, type Tx, tenantOf } from "@ocw/db";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { type ChatDeps, type ConversationRow, iso, notifyListChanged } from "./service";

/**
 * Direct conversations (D-03, D-06), all `visibility = 'private'` with fixed membership:
 *   - a bot DM (`kind = 'dm'`): one human (role `owner`) and one bot (Phase 3.1);
 *   - a human DM (`kind = 'dm'`): two humans, both `member`;
 *   - a group DM (`kind = 'group'`): 3–9 participants, humans and team bots, all `member`.
 * Each is unique per participant set through `dm_key` = `dmKeyOf` (sorted `<kind>:<id>` parts, ids only, P-06)
 * and a partial unique index per kind; creation is insert-or-get, so concurrent opens converge on one row.
 */

/** Stable pair key of a bot DM: ids only, never names (AGENTS principle 11). Equals `dmKeyOf` of the pair. */
export function dmKey(agentId: string, userId: string): string {
  return dmKeyOf([
    { kind: "agent", id: agentId },
    { kind: "user", id: userId },
  ]);
}

type Participant = { kind: "user" | "agent"; id: string; role: "owner" | "member" };

/**
 * Insert-or-get on `(organization_id, dm_key)` for `kind` (race-safe: a concurrent insert waits on the unique
 * index, then the read finds the winner). On creation the members are inserted, `dm.created` is audited with
 * ids only, and every human member's sidebar is told through `user:<id>` (never the org topic).
 */
async function insertOrGet(
  tx: Tx,
  deps: ChatDeps,
  p: {
    kind: "dm" | "group";
    createdBy: string;
    members: Participant[];
    audit: { agentId?: string | null; metadata: Record<string, unknown> };
  },
): Promise<{ conv: ConversationRow; created: boolean }> {
  const ctx = tenantOf(tx);
  const key = dmKeyOf(p.members);
  const [inserted] = await tx
    .insert(conversations)
    .values({
      organizationId: ctx.organizationId,
      kind: p.kind,
      name: null,
      visibility: "private",
      createdBy: p.createdBy,
      dmKey: key,
    })
    .onConflictDoNothing({
      target: [conversations.organizationId, conversations.dmKey],
      where: p.kind === "dm" ? sql`kind = 'dm'` : sql`kind = 'group'`,
    })
    .returning();
  if (!inserted) {
    const [existing] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.kind, p.kind), eq(conversations.dmKey, key)))
      .limit(1);
    if (!existing) throw new Error("dm insert-or-get found no row");
    return { conv: existing, created: false };
  }
  // `joined_at` keeps the creator's pick order (a group's label lists the others in that order).
  await tx.insert(conversationMembers).values(
    p.members.map((m, i) => ({
      conversationId: inserted.id,
      organizationId: ctx.organizationId,
      memberKind: m.kind,
      memberId: m.id,
      role: m.role,
      joinedAt: sql`now() + ${i} * interval '1 microsecond'`,
    })),
  );
  await deps.audit.record(tx, {
    action: "dm.created",
    resourceType: "conversation",
    resourceId: inserted.id,
    agentId: p.audit.agentId ?? null,
    metadata: p.audit.metadata,
  });
  await notifyListChanged(tx, deps, inserted, EventTypes.conversationCreated);
  return { conv: inserted, created: true };
}

/**
 * The DM between `userId` and the bot `agentId`, created on first use. The human is the `owner` (Phase 3.1
 * shape). Callers decide `bot.read` first.
 */
export function ensureDm(
  tx: Tx,
  deps: ChatDeps,
  p: { agentId: string; userId: string },
): Promise<{ conv: ConversationRow; created: boolean }> {
  return insertOrGet(tx, deps, {
    kind: "dm",
    createdBy: p.userId,
    members: [
      { kind: "user", id: p.userId, role: "owner" },
      { kind: "agent", id: p.agentId, role: "member" },
    ],
    audit: { agentId: p.agentId, metadata: { kind: "dm", counterpart: { kind: "agent", id: p.agentId } } },
  });
}

/**
 * The DM between two people (D-06), created on first use: both humans are plain members. Callers check that
 * `otherUserId` is an active member of the organization and not the caller.
 */
export function ensureHumanDm(
  tx: Tx,
  deps: ChatDeps,
  p: { userId: string; otherUserId: string },
): Promise<{ conv: ConversationRow; created: boolean }> {
  return insertOrGet(tx, deps, {
    kind: "dm",
    createdBy: p.userId,
    members: [
      { kind: "user", id: p.userId, role: "member" },
      { kind: "user", id: p.otherUserId, role: "member" },
    ],
    audit: { metadata: { kind: "dm", counterpart: { kind: "user", id: p.otherUserId } } },
  });
}

/**
 * The group DM of exactly these participants (D-06), created on first use. `members` includes the creator;
 * duplicates are dropped, humans keep the pick order ahead of bots, and every participant is a plain member.
 * Callers validate each participant first (active humans; live team bots the creator may use; never a personal
 * bot). The same set in any order is the same group; one more member is a different group (new key).
 */
export function ensureGroup(
  tx: Tx,
  deps: ChatDeps,
  p: { creatorId: string; members: Array<{ kind: "user" | "agent"; id: string }> },
): Promise<{ conv: ConversationRow; created: boolean }> {
  const seen = new Set<string>();
  const unique: Array<{ kind: "user" | "agent"; id: string }> = [];
  for (const m of [{ kind: "user" as const, id: p.creatorId }, ...p.members]) {
    const key = `${m.kind}:${m.id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ kind: m.kind, id: m.id.toLowerCase() });
  }
  if (unique.length < 3) throw new Error("a group needs at least three participants");
  if (unique.length > MAX_GROUP_PARTICIPANTS) throw new Error("too many group participants");
  const ordered = [...unique.filter((m) => m.kind === "user"), ...unique.filter((m) => m.kind === "agent")];
  return insertOrGet(tx, deps, {
    kind: "group",
    createdBy: p.creatorId,
    members: ordered.map((m) => ({ ...m, role: "member" as const })),
    audit: { metadata: { kind: "group", members: ordered.map((m) => ({ kind: m.kind, id: m.id })) } },
  });
}

/** "A", "A and B", "A, B and C", "A, B, C and N more" (up to three names, D-06). */
export function groupLabel(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "Group";
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
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
 * The caller's open (non-archived) direct conversations with their counterpart: a bot (its DM disappears
 * with the bot), a person (deactivated flagged), or the other members of a group. Personal bots first, then
 * the most recent activity. `ids` narrows the list (one conversation after `POST /dms`). Callers still decide
 * `channel.read` per row through the resolver (`perms.filter`).
 */
export async function listDms(tx: Tx, userId: string, opts: { ids?: string[] } = {}): Promise<DmSummary[]> {
  const me = conversationMembers;
  const rows = await tx
    .select({
      c: conversations,
      lastReadSeq: me.lastReadSeq,
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
    })
    .from(conversations)
    .innerJoin(
      me,
      and(eq(me.conversationId, conversations.id), eq(me.memberKind, "user"), eq(me.memberId, userId)),
    )
    .where(
      and(
        inArray(conversations.kind, ["dm", "group"]),
        isNull(conversations.archivedAt),
        opts.ids ? inArray(conversations.id, opts.ids) : undefined,
      ),
    );
  if (rows.length === 0) return [];

  const memberRows = await tx
    .select({
      conversationId: conversationMembers.conversationId,
      kind: conversationMembers.memberKind,
      id: conversationMembers.memberId,
    })
    .from(conversationMembers)
    .where(
      inArray(
        conversationMembers.conversationId,
        rows.map((r) => r.c.id),
      ),
    )
    .orderBy(conversationMembers.joinedAt, conversationMembers.memberId);
  const othersOf = new Map<string, Array<{ kind: "user" | "agent"; id: string }>>();
  for (const m of memberRows) {
    if (m.kind === "user" && m.id === userId) continue;
    const list = othersOf.get(m.conversationId) ?? [];
    list.push({ kind: m.kind, id: m.id });
    othersOf.set(m.conversationId, list);
  }
  const agentIds = [...new Set(memberRows.filter((m) => m.kind === "agent").map((m) => m.id))];
  const userIds = [...new Set(memberRows.filter((m) => m.kind === "user").map((m) => m.id))];
  const agentById = new Map(
    (agentIds.length === 0
      ? []
      : await tx
          .select({
            id: agents.id,
            name: agents.name,
            username: agents.username,
            avatarUrl: agents.avatarUrl,
            status: agents.status,
            scope: agents.scope,
            deletedAt: agents.deletedAt,
          })
          .from(agents)
          .where(inArray(agents.id, agentIds))
    ).map((a) => [a.id, a]),
  );
  const userById = new Map(
    (userIds.length === 0
      ? []
      : await tx
          .select({
            userId: orgMembers.userId,
            displayName: orgMembers.displayName,
            email: orgMembers.email,
            avatarUrl: orgMembers.avatarUrl,
            deactivatedAt: orgMembers.deactivatedAt,
          })
          .from(orgMembers)
          .where(inArray(orgMembers.userId, userIds))
    ).map((u) => [u.userId, u]),
  );

  const counterpartOf = (convId: string, kind: string): DmCounterpart | null => {
    const others = othersOf.get(convId) ?? [];
    if (kind === "group") {
      const members: DmGroupMember[] = others.slice(0, 8).map((o) => {
        if (o.kind === "agent") {
          const a = agentById.get(o.id);
          const gone = !a || a.deletedAt !== null;
          return {
            kind: "agent",
            id: o.id,
            name: gone ? "Deleted bot" : a.name,
            avatarUrl: a?.avatarUrl ?? null,
          };
        }
        const u = userById.get(o.id);
        return {
          kind: "user",
          id: o.id,
          name: u?.displayName ?? "Former member",
          avatarUrl: u?.avatarUrl ?? null,
        };
      });
      if (members.length < 2) return null;
      return { kind: "group", name: groupLabel(members.map((m) => m.name)), members };
    }
    const bot = others.find((o) => o.kind === "agent");
    if (bot) {
      const a = agentById.get(bot.id);
      // A deleted bot's DM leaves the list (its history stays in the database).
      if (!a || a.deletedAt !== null) return null;
      return {
        kind: "agent",
        id: a.id,
        name: a.name,
        username: a.username,
        avatarUrl: a.avatarUrl,
        status: a.status,
        scope: a.scope,
      };
    }
    const other = others[0];
    if (!other) return null;
    const u = userById.get(other.id);
    return {
      kind: "user",
      id: other.id,
      name: u?.displayName ?? "Former member",
      handle: u ? userHandle({ displayName: u.displayName, email: u.email }) : "former-member",
      avatarUrl: u?.avatarUrl ?? null,
      // A member who left the organization reads like a deactivated one: no new messages reach them.
      deactivated: !u || u.deactivatedAt !== null,
    };
  };

  const out: DmSummary[] = [];
  for (const r of rows) {
    const counterpart = counterpartOf(r.c.id, r.c.kind);
    if (!counterpart) continue;
    out.push({
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
      counterpart,
      latestMessageSeq: r.latestMessageSeq,
      lastReadSeq: Number(r.lastReadSeq ?? 0),
      lastMessageAt: r.lastMessageAt === null ? null : iso(r.lastMessageAt),
      lastMessagePreview: r.lastMessagePreview ?? null,
    });
  }
  // Personal bots first, then by most recent activity (new DMs without messages by creation time).
  const personal = (d: DmSummary) => d.counterpart.kind === "agent" && d.counterpart.scope === "personal";
  return out.sort((a, b) => {
    if (personal(a) !== personal(b)) return personal(a) ? -1 : 1;
    const at = Date.parse(a.lastMessageAt ?? a.createdAt);
    const bt = Date.parse(b.lastMessageAt ?? b.createdAt);
    return bt - at;
  });
}
