import { randomUUID } from "node:crypto";
import {
  type AgentChannelAuthor,
  AgentChannelEventTypes,
  type AgentChannelHistoryEntry,
  type AgentChannelRosterEntry,
  type AgentMentionEvent,
  cellTopic,
  type Mention,
} from "@ocw/contracts";
import {
  type AfterCommit,
  agents,
  conversationMembers,
  conversations,
  messages,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Core } from "../../core";
import type { AgentMention } from "../../lib/chat-agent-bridge";
import { agentDirectory } from "../agent";
import {
  claimChannelNotice,
  effectiveCapabilities,
  loadPolicy,
  readCapabilities,
  recordLimitReached,
  turnPolicy,
} from "../bot-capabilities";
import { REPLY_MODE_PER_MINUTE } from "../chat";
import { createPermissionService, memberDirectory, type PermissionService } from "../organization";

/** Bounded thread context per mention (A2.2). */
export const HISTORY_LIMIT = 50;

/** Stored payload; `seq` is injected by the gateway when the frame is sent. */
export type StoredMention = Omit<AgentMentionEvent, "seq">;

const toIso = (v: string) => new Date(v).toISOString();

/**
 * Registers the chat → agent-channel mention handler. It runs INSIDE the chat message transaction, so a
 * mention is delivered iff the message commits. For every mentioned agent that is live, not disabled and a
 * member of the conversation (or of its parent channel), it appends one `agent.mention.v1` event to the
 * cell stream `cell:<orgId>` with server-resolved identity: author id + display name, roster, and the
 * thread history (current message excluded). Nothing is taken from message text. Every event carries the
 * effective `turn` for this bot and this human (D-07), recorded in `agent_turns` in the same transaction.
 * A bot at its daily limit gets no event; it answers with a notice posted after commit (D-11).
 */
export function registerMentionHandler(core: Core) {
  const perms = createPermissionService(core);
  core.chatAgent.onAgentMention(async (tx, mention, after) => {
    const events = await buildMentionEvents(tx, mention, { core, perms, after });
    const { organizationId } = tenantOf(tx);
    for (const ev of events) {
      await core.realtime.appendEvent(tx, cellTopic(organizationId), AgentChannelEventTypes.mention, ev, {
        actorUserId: mention.author.kind === "user" ? mention.author.id : null,
      });
    }
  });
}

export async function buildMentionEvents(
  tx: Tx,
  mention: AgentMention,
  deps: { core: Core; perms: PermissionService; after?: AfterCommit },
): Promise<StoredMention[]> {
  // MVP 0: only human-authored mentions reach the cell (no agent ↔ agent loops).
  if (mention.author.kind !== "user") return [];
  const agentIds = [...new Set(mention.agentIds)];
  if (agentIds.length === 0) return [];
  const { organizationId } = tenantOf(tx);

  const [conv] = await tx.select().from(conversations).where(eq(conversations.id, mention.conversationId));
  if (!conv) return [];
  const [parent] = conv.parentConversationId
    ? await tx.select().from(conversations).where(eq(conversations.id, conv.parentConversationId))
    : [];
  const scope = [conv.id, ...(parent ? [parent.id] : [])];

  const memberRows = await tx
    .select()
    .from(conversationMembers)
    .where(inArray(conversationMembers.conversationId, scope));
  const agentMembers = new Set(memberRows.filter((m) => m.memberKind === "agent").map((m) => m.memberId));

  const targets = (
    await tx
      .select()
      .from(agents)
      .where(and(inArray(agents.id, agentIds), isNull(agents.deletedAt)))
  )
    .filter((a) => a.status !== "disabled" && agentMembers.has(a.id))
    // A stable order keeps row locks (the daily usage counters) in the same order across transactions.
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  if (targets.length === 0) return [];
  const replyMode = mention.trigger === "reply_mode";
  const delivered = replyMode ? await replyModeGate(tx, deps.core, mention, conv, targets) : targets;
  if (delivered.length === 0) return [];

  // ---- history (current message excluded), oldest first: the thread, or the whole DM (D-04, flat)
  const root = mention.threadRootId;
  const threadFilter =
    conv.kind === "dm"
      ? eq(messages.conversationId, conv.id)
      : or(
          eq(messages.id, root),
          eq(messages.threadId, root),
          ...(conv.kind === "thread" ? [eq(messages.conversationId, conv.id)] : []),
        );
  const historyRows = (
    await tx
      .select()
      .from(messages)
      .where(and(threadFilter, ne(messages.id, mention.messageId)))
      .orderBy(desc(messages.createdAt), desc(messages.seq))
      .limit(HISTORY_LIMIT)
  ).reverse();

  const users = await memberDirectory(tx);
  const agentIdsNeeded = [
    ...new Set([
      ...memberRows.filter((m) => m.memberKind === "agent").map((m) => m.memberId),
      ...historyRows.filter((m) => m.authorKind === "agent" && m.authorId).map((m) => m.authorId as string),
    ]),
  ];
  const agentsById = await agentDirectory(tx, agentIdsNeeded);

  const authorOf = (kind: "user" | "agent" | "system", id: string | null): AgentChannelAuthor | null => {
    if (!id) return null;
    if (kind === "user") return { kind, id, displayName: users.get(id)?.displayName ?? "Former member" };
    if (kind === "agent") return { kind, id, displayName: agentsById.get(id)?.name ?? "Deleted bot" };
    return { kind, id, displayName: "System" };
  };

  const threadHistory: AgentChannelHistoryEntry[] = [];
  for (const m of historyRows) {
    const author = authorOf(m.authorKind, m.authorId);
    if (!author) continue;
    threadHistory.push({ id: m.id, author, text: m.body, createdAt: toIso(m.createdAt) });
  }

  // ---- roster: conversation members (users with org role, agents with handle) + the author
  const roster: AgentChannelRosterEntry[] = [];
  const seen = new Set<string>();
  for (const m of memberRows) {
    const key = `${m.memberKind}:${m.memberId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (m.memberKind === "user") {
      const u = users.get(m.memberId);
      if (u) roster.push({ kind: "user", id: u.userId, displayName: u.displayName, role: u.role });
    } else {
      const a = agentsById.get(m.memberId);
      if (a) roster.push({ kind: "agent", id: a.id, displayName: a.name, handle: a.username });
    }
  }
  if (!seen.has(`user:${mention.author.id}`)) {
    const u = users.get(mention.author.id);
    roster.push({
      kind: "user",
      id: mention.author.id,
      displayName: u?.displayName ?? mention.author.displayName,
      ...(u ? { role: u.role } : {}),
    });
  }

  // ---- structural mentions as stored on the message (same tx, so the row is visible)
  const [stored] = await tx
    .select({ mentions: messages.mentions })
    .from(messages)
    .where(eq(messages.id, mention.messageId));
  // A reply-mode turn carries the message's own mentions only: it never claims the bot was mentioned.
  const mentions: Mention[] =
    stored && (stored.mentions.length > 0 || replyMode)
      ? stored.mentions
      : agentIds.map((id) => ({ kind: "agent" as const, id }));

  const author: AgentChannelAuthor = {
    kind: "user",
    id: mention.author.id,
    displayName: users.get(mention.author.id)?.displayName ?? mention.author.displayName,
  };
  const conversationName = conv.kind === "thread" && parent ? parent.name : conv.name;

  const events: StoredMention[] = [];
  for (const a of delivered) {
    // The event id first: the turn ledger row (`agent_turns`) is keyed by it.
    const eventId = randomUUID();
    const decision = await turnPolicy(tx, deps.core, deps.perms, {
      agentId: a.id,
      humanUserId: mention.author.id,
      conversationId: conv.id,
      conversationKind: conv.kind,
      messageId: mention.messageId,
      eventId,
      // The asking human's zone (D-12); turnPolicy re-validates it and falls back to UTC.
      clientTimeZone: mention.clientTimeZone ?? null,
    });
    // Not delivered (daily limit reached, or the bot is gone): no cell event, so no model call.
    if (!decision.deliver) {
      if (decision.reason === "limit_reached") {
        await limitReached(tx, deps, mention, conv, a.id, decision.notice, decision.limit);
      }
      continue;
    }
    events.push({
      eventId,
      type: AgentChannelEventTypes.mention,
      organizationId,
      cellId: organizationId,
      agent: { id: a.id, handle: a.username, displayName: a.name },
      conversation: { id: conv.id, kind: conv.kind, name: conversationName },
      thread: { rootMessageId: root },
      message: {
        id: mention.messageId,
        text: mention.body,
        createdAt: toIso(mention.createdAt),
        author,
        mentions,
      },
      threadHistory,
      roster,
      turn: decision.turn,
    });
  }
  return events;
}

/**
 * Reply mode `all` (D-12) at delivery: keeps only the bots for which reply mode `all` is effective under the
 * CURRENT org policy (T-03.1-08-03), then applies the per-minute cap per (bot, conversation) with a Redis
 * counter per epoch minute (T-03.1-08-01). The first message over the cap is audited once per window
 * (`agent.reply_rate_limited`, ids and numbers only); capped messages get no event and no notice, and are
 * not metered against the daily limit. A Redis failure fails closed: no automatic reply, the post succeeds.
 */
async function replyModeGate<T extends typeof agents.$inferSelect>(
  tx: Tx,
  core: Core,
  mention: AgentMention,
  conv: { id: string; kind: string },
  targets: T[],
): Promise<T[]> {
  const policy = await loadPolicy(tx);
  const allowed = targets.filter(
    (a) =>
      effectiveCapabilities({
        scope: a.scope,
        caps: readCapabilities(a),
        policy,
        configured: { internet: true },
        human: null,
      }).replyModeAll.effective,
  );
  const { organizationId } = tenantOf(tx);
  const minute = Math.floor(Date.now() / 60_000);
  const out: T[] = [];
  for (const a of allowed) {
    let count: number;
    try {
      const key = `ocw:replycap:${organizationId}:${a.id}:${conv.id}:${minute}`;
      count = await core.bus.pub.incr(key);
      if (count === 1) await core.bus.pub.expire(key, 120);
    } catch (err) {
      core.log.warn(
        {
          agentId: a.id,
          conversationId: conv.id,
          messageId: mention.messageId,
          code: err instanceof Error ? err.name : "unknown",
        },
        "reply-mode rate cap unavailable; automatic reply skipped",
      );
      continue;
    }
    if (count <= REPLY_MODE_PER_MINUTE) {
      out.push(a);
      continue;
    }
    if (count === REPLY_MODE_PER_MINUTE + 1) {
      await core.audit.record(tx, {
        action: "agent.reply_rate_limited",
        resourceType: "agent",
        resourceId: a.id,
        result: "denied",
        actorKind: "agent",
        actorId: a.id,
        agentId: a.id,
        userId: mention.author.id,
        metadata: {
          limit: REPLY_MODE_PER_MINUTE,
          conversationId: conv.id,
          conversationKind: conv.kind,
          messageId: mention.messageId,
          windowStart: new Date(minute * 60_000).toISOString(),
        },
      });
    }
  }
  return out;
}

/**
 * D-11: a bot at its limit answers with a notice instead of a model reply. In a DM every over-limit message
 * gets it; elsewhere it goes out once per (bot, conversation, UTC day). The notice is posted AFTER commit by
 * the chat module (its own transaction: inside this one it would wait on the conversation's stream lock),
 * idempotent on `limit:<messageId>`. A failed notice is logged without payload and never fails the post.
 */
async function limitReached(
  tx: Tx,
  deps: { core: Core; after?: AfterCommit },
  mention: AgentMention,
  conv: { id: string; kind: string },
  agentId: string,
  notice: string,
  limit: number,
): Promise<void> {
  const isDm = mention.delivery === "dm" || conv.kind === "dm";
  const notified = isDm || (await claimChannelNotice(tx, agentId, conv.id));
  await recordLimitReached(tx, deps.core, {
    agentId,
    humanUserId: mention.author.id,
    conversationId: conv.id,
    conversationKind: conv.kind,
    messageId: mention.messageId,
    limit,
    notified,
  });
  if (!notified) return;
  const { organizationId } = tenantOf(tx);
  const after = deps.after ?? tenantOf(tx).afterCommit;
  after(async () => {
    try {
      await deps.core.chatAgent.postAgentMessage(
        { organizationId, userId: null },
        {
          agentId,
          conversationId: conv.id,
          // DMs are flat (D-04); in a channel the notice goes to the message's thread.
          threadRootId: isDm ? null : mention.threadRootId,
          body: notice,
          idempotencyKey: `limit:${mention.messageId}`,
          inReplyToMessageId: mention.messageId,
        },
      );
    } catch (err) {
      deps.core.log.warn(
        {
          agentId,
          conversationId: conv.id,
          messageId: mention.messageId,
          code: (err as { code?: unknown } | null)?.code ?? (err instanceof Error ? err.name : "unknown"),
        },
        "daily limit notice could not be posted",
      );
    }
  });
}
