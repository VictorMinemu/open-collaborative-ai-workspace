import { randomUUID } from "node:crypto";
import {
  A2A_MAX_DEPTH,
  type AgentChannelAuthor,
  AgentChannelEventTypes,
  type AgentChannelHistoryEntry,
  type AgentChannelRosterEntry,
  type AgentMentionEvent,
  cellTopic,
  type Mention,
  type ModelRef,
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
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Core } from "../../core";
import type { AgentMention } from "../../lib/chat-agent-bridge";
import { agentDirectory } from "../agent";
import { answerModelsOf, audienceOf, participantsOf } from "../ai-chat";
import { type AttachmentRow, attachmentRowsForMessages } from "../artifact";
import {
  claimChannelNotice,
  effectiveCapabilities,
  loadPolicy,
  readCapabilities,
  recordLimitReached,
  turnPolicy,
} from "../bot-capabilities";
import { REPLY_MODE_PER_MINUTE } from "../chat";
import type { MemoryService } from "../memory";
import { createPermissionService, memberDirectory, type PermissionService } from "../organization";
import { workZoneOfferFor } from "../work-session";
import { consultTargets } from "./agent-message";
import { messageScopeFilter } from "./attachment-access";
import { inboundRooted } from "./inbound-origin";
import { conversationAudience } from "./memory-files";

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
export function registerMentionHandler(
  core: Core,
  opts: { modelLabel?: (ref: ModelRef) => string; memory?: MemoryService } = {},
) {
  const perms = createPermissionService(core);
  core.chatAgent.onAgentMention(async (tx, mention, after) => {
    const events = await buildMentionEvents(tx, mention, {
      core,
      perms,
      after,
      modelLabel: opts.modelLabel,
      memory: opts.memory,
    });
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
  deps: {
    core: Core;
    perms: PermissionService;
    after?: AfterCommit;
    /** The chat model's label in an AI chat's history (06-10); absent = "AI assistant". */
    modelLabel?: ((ref: ModelRef) => string) | undefined;
    /** Memory files (07.2-11): absent = turns carry no memory. */
    memory?: MemoryService | undefined;
  },
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

  // ---- history (current message excluded), oldest first: the thread, or the whole DM / group DM / AI chat (D-04,
  // D-06, P-10: flat)
  const root = mention.threadRootId;
  const aiChat = conv.kind === "ai_chat";
  // 07.15 D-16: the same filter decides which files the turn may read or import (attachment-access.ts).
  const threadFilter = messageScopeFilter(conv, root);
  const historyRows = (
    await tx
      .select()
      .from(messages)
      // Deleted text never reaches a model (Pitfall 8): tombstones are not history.
      .where(and(threadFilter, ne(messages.id, mention.messageId), isNull(messages.deletedAt)))
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

  // P-10: in an AI chat the chat model's answers (agent rows without an author) are a principal of their own, named
  // after the model that wrote them; never a person, never a bot of the directory.
  const answerModels = aiChat
    ? await answerModelsOf(
        tx,
        historyRows.filter((m) => m.authorKind === "agent" && !m.authorId).map((m) => m.id),
      )
    : new Map<string, ModelRef>();
  const modelAuthor = (messageId: string): AgentChannelAuthor => {
    const ref = answerModels.get(messageId);
    const label = ref && deps.modelLabel ? deps.modelLabel(ref) : null;
    return { kind: "system", id: conv.id, displayName: label ? `AI assistant (${label})` : "AI assistant" };
  };

  const threadHistory: AgentChannelHistoryEntry[] = [];
  for (const m of historyRows) {
    const modelAnswer = aiChat && m.authorKind === "agent" && !m.authorId;
    // An answer still streaming (or that never produced text) has nothing to show yet.
    if (modelAnswer && m.body.trim() === "") continue;
    const author = modelAnswer ? modelAuthor(m.id) : authorOf(m.authorKind, m.authorId);
    if (!author) continue;
    threadHistory.push({ id: m.id, author, text: m.body, createdAt: toIso(m.createdAt) });
  }

  // ---- roster: conversation members (users with org role, agents with handle) + the author. An AI chat's roster is
  // its participants (P-09: owner and the humans who can still read it, then member agents).
  const roster: AgentChannelRosterEntry[] = [];
  const seen = new Set<string>();
  if (aiChat) {
    for (const p of await participantsOf(tx, conv.id)) {
      seen.add(`${p.kind}:${p.id}`);
      roster.push(
        p.kind === "user"
          ? { kind: "user", id: p.id, displayName: p.displayName, ...(p.orgRole ? { role: p.orgRole } : {}) }
          : {
              kind: "agent",
              id: p.id,
              displayName: p.displayName,
              ...(p.handle ? { handle: p.handle } : {}),
            },
      );
    }
  }
  for (const m of aiChat ? [] : memberRows) {
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

  // D-06, P-10: in an AI chat, scoped tools must be fine for everyone who reads the persona's answer.
  const audience = aiChat ? await audienceOf(tx, conv.id) : null;

  // Phase 07.6 (D-02, D-07, P-11): a run started by outside content starts tainted, and so does every turn that reads
  // outside content: a thread rooted in an inbound item (or a tainted run's anchor), or a flat conversation or thread
  // whose history window holds one. One lookup per mention, for every bot it reaches; a person's @mention included.
  const taintedAtStart =
    mention.taintedAtStart === true ||
    (await inboundRooted(
      tx,
      root,
      historyRows.map((m) => m.id),
    ));
  // D-12: an automation run's turn has nobody present (no browser tools); a person's message never is one. Phase 07.7
  // (D-13): neither has a consult hop turn (the question to a consulted bot, the answer back to the asker). Phase 07.16
  // (D-09): nor a Work Zone wake (the bot hears about its session; nobody is there to watch a browser).
  const workSessionWake = mention.trigger === "work_session";
  const unattended = mention.trigger === "automation" || mention.trigger === "consult" || workSessionWake;

  // Phase 07.15 (D-02, PD-04): the files of the messages this turn reads (the current message and the history window
  // above: the same thread filter, live messages only), ready and linked, in listing order: the current message's in
  // upload order, then the history newest first. Automation runs and consult hops list none (PD-04). `turnPolicy` decides
  // per bot how each can be read.
  const attachments: AttachmentRow[] = [];
  if (!unattended) {
    const byMessage = await attachmentRowsForMessages(tx, [
      mention.messageId,
      ...historyRows.map((m) => m.id),
    ]);
    for (const id of [mention.messageId, ...historyRows.map((m) => m.id).reverse()]) {
      // 07.15 IN-02: only the conversation's own files, as `attachmentForTurn` decides (a thread conversation's root
      // message, and so its files, belongs to the parent channel).
      attachments.push(...(byMessage.get(id) ?? []).filter((r) => r.conversationId === conv.id));
    }
  }
  // Phase 07.7 (D-04, D-08, D-09): consults are offered only where one can succeed: never on a reply-mode turn, only in
  // a channel (or its thread), below the depth limit and on a turn that does not start tainted. The targets are decided
  // per delivered bot with the canonical `agent.message` decision (`consultTargets`).
  const chain = mention.chain ?? null;
  const mayConsult =
    !replyMode &&
    !taintedAtStart &&
    (chain?.depth ?? 0) < A2A_MAX_DEPTH &&
    (conv.kind === "channel" || (conv.kind === "thread" && parent?.kind === "channel"));

  const events: StoredMention[] = [];
  for (const a of delivered) {
    // The event id first: the turn ledger row (`agent_turns`) is keyed by it.
    const eventId = randomUUID();
    const targets = mayConsult
      ? await consultTargets(tx, deps.perms, {
          sourceAgentId: a.id,
          humanUserId: mention.author.id,
          conversationId: conv.id,
          chain: chain ? { rootAgentId: chain.rootAgentId, usedTargetIds: chain.usedTargetIds } : null,
        })
      : [];
    // Phase 07.16 (D-05, D-21, PD-17): a person's delivery (a mention or reply mode, never an automation run or a
    // consult hop) or a wake about the bot's own session (`work_session`, 07.16-20), of a bot whose Work Zone profile is
    // active, for an asker who passes the Work Zone module gate.
    const workZone =
      unattended && !workSessionWake
        ? null
        : await workZoneOfferFor(tx, deps.perms, {
            agentId: a.id,
            askerUserId: mention.author.id,
            conversationId: conv.id,
            tainted: taintedAtStart,
          });
    const decision = await turnPolicy(
      tx,
      deps.core,
      deps.perms,
      {
        agentId: a.id,
        humanUserId: mention.author.id,
        conversationId: conv.id,
        conversationKind: conv.kind,
        messageId: mention.messageId,
        eventId,
        // The asking human's zone (D-12); turnPolicy re-validates it and falls back to UTC.
        clientTimeZone: mention.clientTimeZone ?? null,
        taintedAtStart,
        unattended,
        chain: chain
          ? {
              chainId: chain.chainId,
              depth: chain.depth,
              answeringHopId: chain.answeringHopId,
              returningHopId: chain.returningHopId,
            }
          : null,
        consultTargets: targets,
        attachments,
        workZone,
      },
      {
        audience,
        memory: deps.memory
          ? { service: deps.memory, audience: () => conversationAudience(tx, { conversationId: conv.id }) }
          : null,
      },
    );
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
 * D-11: a bot at its limit answers with a notice instead of a model reply. In a 1:1 DM every over-limit message
 * gets it; elsewhere (channels, group DMs) it goes out once per (bot, conversation, UTC day). The notice is posted AFTER commit by
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
  // Direct conversations are flat; a 1:1 DM gets every notice, a group (mentions only) once a day like a channel.
  const isDm = mention.delivery === "dm" || conv.kind === "dm" || conv.kind === "group";
  const notified = conv.kind === "dm" || (await claimChannelNotice(tx, agentId, conv.id));
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
