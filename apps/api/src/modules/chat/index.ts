import {
  AddConversationMemberRequest,
  type AgentTypingEvent,
  ChannelList,
  ChannelMemberList,
  ChannelSummary,
  type ChannelSummary as ChannelSummaryDto,
  type ConversationReadEvent,
  CreateChannelRequest,
  CreateDmRequestFields,
  DmList,
  DmSummary,
  EphemeralTypes,
  EventTypes,
  IdParams,
  MAX_GROUP_PARTICIPANTS,
  MarkReadRequest,
  MarkUnreadRequest,
  MemberParams,
  Message,
  MessagePage,
  mentionAllOf,
  Ok,
  PageQueryFields,
  PostMessageRequest,
  pageCursorCount,
  ThreadResponse,
  UpdateChannelRequest,
} from "@ocw/contracts";
import {
  conversationMembers,
  conversations,
  messages,
  orgMembers,
  orgUnits,
  type TenantCtx,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type ApiModule, authOf, type Core, tenant } from "../../core";
import type { AgentMention, ThreadContext } from "../../lib/chat-agent-bridge";
import { badRequest, conflict, forbidden, gone, HttpError, notFound } from "../../lib/errors";
import {
  AuthzDeniedError,
  agentResource,
  type ChannelFacts,
  channelMemberResource,
  channelResource,
  createPermissionService,
} from "../organization";
import { createConversationAccess } from "./access";
import { authorOf, type Directory, loadDirectory } from "./directory";
import { dmAgentOf, ensureDm, ensureGroup, ensureHumanDm, listDms } from "./dm";
import { resolveMentions } from "./mentions";
import { type MessageActionsContext, registerMessageActionRoutes } from "./message-actions";
import { registerPinRoutes } from "./pins";
import { registerReactionRoutes } from "./reactions";
import { replyModeCandidates } from "./reply-mode";
import { registerSaveRoutes } from "./saves";
import {
  addMember,
  type ChannelRow,
  type ChatDeps,
  type ConversationRow,
  channelFacts,
  channelRow,
  convTopic,
  ensureGeneral,
  GENERAL_SLUG,
  getChannel,
  getConversation,
  getMembership,
  getMessage,
  hydrateViewer,
  listChannelMembers,
  listChannels,
  listMessages,
  listMessagesAfter,
  listMessagesAround,
  loadThread,
  lockNextSeq,
  memberUnitIdsOf,
  notifyListChanged,
  type PostResult,
  postMessage,
  removeMember,
  replyParticipantsFor,
  toMessage,
  unreadCountsFor,
  withUnreadCounts,
} from "./service";
import { registerChatTestRoutes } from "./test-routes";
import { registerThreadRoutes } from "./threads";

export { type ConversationAccess, createConversationAccess } from "./access";
export { authorOf, type Directory, loadDirectory } from "./directory";
export {
  dmAgentOf,
  dmKey,
  ensureDm,
  ensureGroup,
  ensureHumanDm,
  groupLabel,
  listDms,
  setAgentDmsArchived,
} from "./dm";
export { resolveMentions } from "./mentions";
export { REPLY_MODE_PER_MINUTE, replyModeCandidates } from "./reply-mode";
export { conversationRefs } from "./saves";
export { listThreadsFor } from "./threads";

/** What the chat module hands to its route files (message actions, reactions, pins, saves). */
export type ChatRouteCtx = MessageActionsContext;

/** The poster's zone on a delivery, only when the client sent one (absent = UTC in the turn). */
const zoneOf = (author: { clientTimeZone?: string }) =>
  author.clientTimeZone ? { clientTimeZone: author.clientTimeZone } : {};

/**
 * Conversation kinds served by the message routes, read markers, the `conv:` topic and bot replies (D-03,
 * D-06: group DMs).
 */
const MESSAGE_KINDS = ["channel", "dm", "group"] as const;

/** One `@channel` / `@here` per channel per minute (P-11). */
const MENTION_ALL_WINDOW_MS = 60_000;

/**
 * The unit a channel is placed in (create or move, CHAT-02, T-04-08-01): it must exist in the tenant (another
 * organization's unit is simply missing: 404 `unit_not_found`), and unless `mayManageUnits` (the resolver's
 * `unit.manage` at organization scope) it must lie on the path of one of the caller's own units (403
 * `unit_not_allowed`): a member of Product → Mobile may use Mobile or Product, never Finance.
 */
async function placeableUnit(
  tx: Tx,
  unitId: string,
  userId: string,
  mayManageUnits: boolean,
): Promise<typeof orgUnits.$inferSelect> {
  const [u] = await tx.select().from(orgUnits).where(eq(orgUnits.id, unitId)).limit(1);
  if (!u) throw notFound("Unit not found", "unit_not_found");
  if (mayManageUnits) return u;
  if (!(await memberUnitIdsOf(tx, userId)).includes(u.id)) {
    throw forbidden(
      "You can only place a channel in your own department, team or project",
      "unit_not_allowed",
    );
  }
  return u;
}

/** The kind of a conversation served by the message routes (they only load MESSAGE_KINDS). */
const messageKindOf = (conv: ConversationRow): (typeof MESSAGE_KINDS)[number] =>
  conv.kind === "dm" || conv.kind === "group" ? conv.kind : "channel";

/** Direct conversations (1:1 and group) are flat: no threads, bot replies at the top level (D-04, D-06). */
const isDirect = (kind: string) => kind === "dm" || kind === "group";

/** The `conv:` copy of `conversation.updated` when a channel moved to another unit (PATCH /channels/:id). */
const ChannelMovedPayload = z.object({ conversationId: z.string(), unitId: z.string().nullable() });

/** The `conv:` copy of `conversation.member_removed` (see removeMember). */
const MemberRemovedPayload = z.object({
  conversationId: z.string(),
  member: z.object({ kind: z.enum(["user", "agent"]), id: z.string() }),
});

/**
 * chat module (B1): channels, membership, messages, single-level threads, server-side @mentions, the `conv`
 * topic authorizer and the chat side of the chat ↔ agent-channel bridge (lib/chat-agent-bridge.ts).
 */
export function createChatModule(core: Core): ApiModule {
  const deps: ChatDeps = { audit: core.audit, realtime: core.realtime };
  const perms = createPermissionService(core);
  const access = createConversationAccess(core);

  /** The channel permissions the web needs per channel (header menu, composer, members panel, message actions). */
  const VIEWER_CAN = [
    "channel.post",
    "channel.members.add",
    "channel.members.remove",
    "channel.archive",
    "message.delete_any",
    "channel.update",
    "channel.mention_all",
  ] as const;

  async function withViewerCan(req: FastifyRequest, tx: Tx, row: ChannelRow): Promise<ChannelSummaryDto> {
    return {
      ...row.summary,
      viewerCan: await perms.viewerCan(req, tx, channelResource(row.facts), VIEWER_CAN),
    };
  }

  /** One channel as the caller sees it, with `viewerCan` and the caller's badges. */
  async function summaryOf(req: FastifyRequest, tx: Tx, id: string): Promise<ChannelSummaryDto> {
    const [one] = await withUnreadCounts(tx, authOf(req).userId, [
      await withViewerCan(req, tx, await channelRow(tx, id, authOf(req).userId)),
    ]);
    if (!one) throw notFound("Channel not found");
    return one;
  }

  /**
   * Moves the caller's read cursor of a readable conversation (CHAT-09, Pitfall 2) and tells the caller's other tabs
   * and devices with `conversation.read` on `user:<me>` (P-04). `forward` keeps the highest cursor (read) and clears
   * the notifications it covers through the chat-events seam; `exact` sets it (mark unread) and never un-reads a
   * notification. A non-member has no cursor (nothing moves: false); a call that changes nothing announces nothing.
   */
  async function moveReadCursor(
    tx: Tx,
    userId: string,
    conversationId: string,
    to: { forward: number } | { exact: number },
  ): Promise<boolean> {
    const mine = and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.memberKind, "user"),
      eq(conversationMembers.memberId, userId),
    );
    // Lock order (cursor row → notifications → user stream) matches the notification writer (rows → stream).
    const [row] = await tx
      .select({ lastReadSeq: conversationMembers.lastReadSeq })
      .from(conversationMembers)
      .where(mine)
      .for("update");
    if (!row) return false;
    const before = (await unreadCountsFor(tx, userId, [conversationId])).get(conversationId);
    const prev = Number(row.lastReadSeq);
    const next = "forward" in to ? Math.max(prev, to.forward) : to.exact;
    if (next !== prev) await tx.update(conversationMembers).set({ lastReadSeq: next }).where(mine);
    if ("forward" in to) {
      await core.chatEvents.conversationRead(tx, { userId, conversationId, lastReadSeq: next });
    }
    // Serialise with notification writes on the same stream, so a mention committed before this event is counted
    // here and one committed after reaches the client after it (as a `notification.created` delta).
    await lockNextSeq(tx, `user:${userId}`);
    const after = (await unreadCountsFor(tx, userId, [conversationId])).get(conversationId) ?? {
      unreadCount: 0,
      mentionCount: 0,
    };
    if (
      next === prev &&
      before?.unreadCount === after.unreadCount &&
      before?.mentionCount === after.mentionCount
    ) {
      return true;
    }
    const [latest] = await tx
      .select({ seq: sql<number>`coalesce(max(${messages.seq}), 0)`.mapWith(Number) })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), isNull(messages.threadId)));
    const ev: ConversationReadEvent = {
      conversationId,
      lastReadSeq: next,
      ...after,
      latestMessageSeq: latest?.seq ?? 0,
    };
    await core.realtime.appendEvent(tx, `user:${userId}`, EventTypes.conversationRead, ev);
    return true;
  }

  /**
   * The channel and the caller's facts when the resolver lets the caller read it. Missing and hidden
   * channels are the same 404, so a private channel never reveals that it exists. Delegates to the one
   * readable-set authority (P-03).
   */
  function readableChannel(
    req: FastifyRequest,
    tx: Tx,
    conv: ConversationRow | null,
    notFoundMessage = "Channel not found",
  ): Promise<{ conv: ConversationRow; facts: ChannelFacts }> {
    return access.readableRow(req, tx, conv, notFoundMessage);
  }

  /**
   * The 1-per-minute gate of `@channel` / `@here` in one channel (P-11, T-04-09-02), claimed before the insert:
   * `SET NX PX` in Redis, so every API instance shares it. A refused claim is 429 `mention_all_rate_limited`.
   */
  async function claimMentionAll(conversationId: string): Promise<void> {
    const claimed = await core.bus.pub.set(`ocw:mention_all:${conversationId}`, "1", {
      condition: "NX",
      expiration: { type: "PX", value: MENTION_ALL_WINDOW_MS },
    });
    if (claimed !== "OK") {
      throw new HttpError(
        429,
        "mention_all_rate_limited",
        "You can send at most one @channel or @here per minute in this channel",
      );
    }
  }

  /** A client retry of a message already posted (same author and clientMessageId) answers it, not the limit. */
  async function isOwnRetry(tx: Tx, userId: string, clientMessageId: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.authorKind, "user"),
          eq(messages.authorId, userId),
          eq(messages.clientMessageId, clientMessageId),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  // ---------------------------------------------------------------- realtime: conv:<id>
  // Subscribing to a channel's stream is reading it: the resolver decides channel.read for the user.
  core.realtime.registerTopicAuthorizer("conv", (auth, conversationId) =>
    core.db.withTenant({ organizationId: auth.organizationId, userId: auth.userId }, async (tx) => {
      const conv = await getConversation(tx, conversationId, MESSAGE_KINDS);
      if (!conv) return false;
      return access.isReadable(tx, auth.userId, conv.id);
    }),
  );

  // Live re-authorisation (RT-01, 03-04 D-05): a user removed from a channel (or who left it) has that channel's
  // live subscription re-decided by the authorizer above. The `user:` copy of the event and agent members need
  // nothing: agents do not hold browser subscriptions.
  core.realtime.registerSubscriptionInvalidator(EventTypes.conversationMemberRemoved, (topic, payload) => {
    if (!topic.startsWith("conv:")) return null;
    const parsed = MemberRemovedPayload.safeParse(payload);
    if (!parsed.success || parsed.data.member.kind !== "user") return null;
    return { userIds: [parsed.data.member.id], topics: [topic] };
  });

  // A channel moved to another unit: unit-scoped rules may now hide it (or show it) to anyone subscribed, so every
  // live subscription to its stream is re-decided by the authorizer above (CHAT-02, T-04-08-02).
  core.realtime.registerSubscriptionInvalidator(EventTypes.conversationUpdated, (topic, payload) =>
    topic.startsWith("conv:") && ChannelMovedPayload.safeParse(payload).success ? { topics: [topic] } : null,
  );

  // ---------------------------------------------------------------- bridge: chat → agent-channel
  /**
   * Agent mentions in a fresh human message: an agent that is not a member yet is auto-added when the
   * resolver lets the poster add members (otherwise it is skipped and not delivered), disabled agents are
   * ignored, then ONE `emitAgentMention` carries every addressed agent. Runs inside the message
   * transaction, so a rolled-back message is never delivered.
   */
  async function dispatchAgentMentions(
    tx: Tx,
    dir: Directory,
    result: PostResult,
    author: { id: string; clientTimeZone?: string },
  ): Promise<string[]> {
    const conv = await getChannel(tx, result.row.conversationId);
    if (!conv) return [];
    const agentIds: string[] = [];
    let authorRes: ReturnType<typeof channelResource> | undefined;
    for (const m of result.row.mentions) {
      if (m.kind !== "agent") continue;
      const agent = dir.agents.get(m.id);
      if (!agent || agent.status === "disabled") continue;
      // A personal bot lives only in its owner's DM (D-01): never auto-added to, or asked in, a channel.
      if (agent.scope === "personal") continue;
      if (!(await getMembership(tx, conv.id, "agent", agent.id))) {
        authorRes ??= channelResource(await channelFacts(tx, conv, { kind: "user", id: author.id }));
        const d = await perms.decide(
          tx,
          { kind: "user", userId: author.id },
          "channel.members.add",
          authorRes,
        );
        if (!d.allowed) continue;
        await addMember(tx, deps, conv, { kind: "agent", id: agent.id }, { reason: "mentioned" });
      }
      agentIds.push(agent.id);
    }
    if (agentIds.length === 0) return [];
    const mention: AgentMention = {
      organizationId: conv.organizationId,
      conversationId: conv.id,
      threadRootId: result.root?.id ?? result.row.id,
      messageId: result.row.id,
      agentIds,
      author: { kind: "user", id: author.id, displayName: authorOf(dir, "user", author.id).displayName },
      body: result.row.body,
      createdAt: result.message.createdAt,
      delivery: "thread",
      ...zoneOf(author),
    };
    await core.chatAgent.emitAgentMention(tx, mention, tenantOf(tx).afterCommit);
    return agentIds;
  }

  /**
   * D-12: a human message that addressed no bot goes to the team bots of this conversation whose reply mode
   * is `all`, in the message's thread (the message itself, or its root for a thread reply). One
   * `emitAgentMention` with `trigger: "reply_mode"`; delivery decides the org policy, the per-minute cap and
   * the daily limit. Runs inside the message transaction.
   */
  async function dispatchReplyMode(
    tx: Tx,
    dir: Directory,
    conv: ConversationRow,
    result: PostResult,
    author: { id: string; clientTimeZone?: string },
  ): Promise<string[]> {
    const agentIds = await replyModeCandidates(tx, dir, {
      conversationId: conv.id,
      parentConversationId: conv.parentConversationId,
      authorKind: "user",
      mentions: result.row.mentions,
    });
    if (agentIds.length === 0) return [];
    const mention: AgentMention = {
      organizationId: conv.organizationId,
      conversationId: conv.id,
      threadRootId: result.root?.id ?? result.row.id,
      messageId: result.row.id,
      agentIds,
      author: { kind: "user", id: author.id, displayName: authorOf(dir, "user", author.id).displayName },
      body: result.row.body,
      createdAt: result.message.createdAt,
      delivery: "thread",
      trigger: "reply_mode",
      ...zoneOf(author),
    };
    await core.chatAgent.emitAgentMention(tx, mention, tenantOf(tx).afterCommit);
    return agentIds;
  }

  /**
   * D-04: every human message in a DM goes to the DM's bot, no mention needed: exactly one delivery, inside
   * the message transaction, only while the bot is live and the author may still use it (`bot.read` on the
   * agent resource: a personal bot answers its owner only). @mentions inside a DM never add anyone.
   */
  async function dispatchDmMessage(
    tx: Tx,
    dir: Directory,
    conv: ConversationRow,
    result: PostResult,
    author: { id: string; clientTimeZone?: string },
  ): Promise<string | null> {
    const botId = await dmAgentOf(tx, conv.id);
    const bot = botId ? dir.agents.get(botId) : undefined;
    if (!bot || bot.deleted || bot.status === "disabled") return null;
    const d = await perms.decide(
      tx,
      { kind: "user", userId: author.id },
      "bot.read",
      agentResource(
        { scope: bot.scope ?? "team", ownerUserId: bot.ownerUserId ?? null, disabled: false },
        author.id,
      ),
    );
    if (!d.allowed) return null;
    const mention: AgentMention = {
      organizationId: conv.organizationId,
      conversationId: conv.id,
      threadRootId: result.row.id,
      messageId: result.row.id,
      agentIds: [bot.id],
      author: { kind: "user", id: author.id, displayName: authorOf(dir, "user", author.id).displayName },
      body: result.row.body,
      createdAt: result.message.createdAt,
      delivery: "dm",
      ...zoneOf(author),
    };
    await core.chatAgent.emitAgentMention(tx, mention, tenantOf(tx).afterCommit);
    return bot.id;
  }

  /**
   * D-06: in a group DM a team bot answers only when @mentioned, never through reply mode `all`, and only if it
   * is already a member (a mention never adds anyone: membership is fixed). Each addressed bot must be live
   * and usable by the author (`bot.read`). One flat delivery (like a DM: whole-conversation history, top-level
   * reply), inside the message transaction.
   */
  async function dispatchGroupMentions(
    tx: Tx,
    dir: Directory,
    conv: ConversationRow,
    result: PostResult,
    author: { id: string; clientTimeZone?: string },
  ): Promise<string[]> {
    const agentIds: string[] = [];
    for (const m of result.row.mentions) {
      if (m.kind !== "agent" || agentIds.includes(m.id)) continue;
      const bot = dir.agents.get(m.id);
      if (!bot || bot.deleted || bot.status === "disabled" || bot.scope === "personal") continue;
      if (!(await getMembership(tx, conv.id, "agent", bot.id))) continue;
      const d = await perms.decide(
        tx,
        { kind: "user", userId: author.id },
        "bot.read",
        agentResource(
          { scope: bot.scope ?? "team", ownerUserId: bot.ownerUserId ?? null, disabled: false },
          author.id,
        ),
      );
      if (d.allowed) agentIds.push(bot.id);
    }
    if (agentIds.length === 0) return [];
    const mention: AgentMention = {
      organizationId: conv.organizationId,
      conversationId: conv.id,
      threadRootId: result.row.id,
      messageId: result.row.id,
      agentIds,
      author: { kind: "user", id: author.id, displayName: authorOf(dir, "user", author.id).displayName },
      body: result.row.body,
      createdAt: result.message.createdAt,
      delivery: "dm",
      ...zoneOf(author),
    };
    await core.chatAgent.emitAgentMention(tx, mention, tenantOf(tx).afterCommit);
    return agentIds;
  }

  core.chatAgent.providePostAgentMessage((ctx, input) =>
    core.db.withTenant(ctx, async (tx) => {
      const dir = await loadDirectory(tx);
      const agent = dir.agents.get(input.agentId);
      if (!agent) throw notFound("Agent not found", "agent_not_found");
      const conv = await getConversation(tx, input.conversationId, MESSAGE_KINDS);
      if (!conv) throw notFound("Conversation not found");
      if (conv.archivedAt) throw gone("This conversation is archived", "channel_archived");
      // DMs and group DMs are flat (D-04, D-06): a bot reply always lands at the top level.
      const threadRootId = isDirect(conv.kind) ? null : input.threadRootId;
      // The bot itself: enabled, a member, and not denied by a rule (agent principal gate + preconditions).
      const agentRes = channelResource(await channelFacts(tx, conv, { kind: "agent", id: agent.id }));
      const posting = await perms.decide(tx, { kind: "agent", agentId: agent.id }, "channel.post", agentRes);
      if (!posting.allowed) {
        throw new AuthzDeniedError(
          posting.denial ?? { permission: "channel.post", layer: "agent", reason: "missing_permission" },
        );
      }
      // Confused deputy: a reply to a human is allowed only while that human may still read the channel.
      const answered = input.inReplyToMessageId ? await getMessage(tx, input.inReplyToMessageId) : null;
      const humanId = answered?.authorKind === "user" ? answered.authorId : null;
      if (humanId) {
        const humanRes = channelResource(await channelFacts(tx, conv, { kind: "user", id: humanId }));
        const reading = await perms.decide(
          tx,
          { kind: "agent", agentId: agent.id, onBehalfOfUserId: humanId },
          "channel.read",
          agentRes,
          humanRes,
        );
        if (!reading.allowed) {
          throw new AuthzDeniedError(
            reading.denial ?? { permission: "channel.read", layer: "user", reason: "missing_permission" },
          );
        }
      }
      const result = await postMessage(tx, deps, dir, {
        conv,
        author: { kind: "agent", id: agent.id },
        body: input.body,
        mentions: resolveMentions(input.body, dir),
        threadRootId,
        clientMessageId: input.idempotencyKey,
        clientKind: "agent",
        lenientThreadRoot: true,
      });
      if (result.created) {
        // Observers (notifications) in the same transaction; a bot is never a recipient, only an actor.
        await core.chatEvents.messagePosted(tx, {
          conv: { id: conv.id, kind: messageKindOf(conv), organizationId: conv.organizationId },
          message: result.message,
          author: { kind: "agent", id: agent.id },
          mentions: result.row.mentions,
          mentionAll: null,
          threadRootId: result.root?.id ?? null,
        });
        await core.audit.record(tx, {
          action: "agent.message.posted",
          resourceType: "message",
          resourceId: result.row.id,
          actorKind: "agent",
          actorId: agent.id,
          agentId: agent.id,
          clientKind: "agent",
          metadata: { conversationId: conv.id, threadRootId: result.root?.id ?? null },
        });
      }
      return { messageId: result.row.id, created: result.created };
    }),
  );

  core.chatAgent.provideThreadContext((ctx, conversationId, threadRootId, limit) =>
    core.db.withTenant(ctx, async (tx): Promise<ThreadContext> => {
      const dir = await loadDirectory(tx);
      const conv = await getConversation(tx, conversationId, MESSAGE_KINDS);
      if (!conv) throw notFound("Conversation not found");
      const thread = await loadThread(tx, threadRootId);
      if (!thread || thread.root.conversationId !== conv.id) throw notFound("Thread not found");
      const members = await listChannelMembers(tx, conv.id, dir);
      // Deleted text never reaches a model (Pitfall 8): tombstones are left out of the bot's context.
      const head = thread.root.deletedAt === null ? [thread.root] : [];
      const replies = thread.replies
        .filter((r) => r.deletedAt === null)
        .slice(-Math.max(0, limit - head.length));
      const history = [...head, ...replies];
      return {
        conversationId: conv.id,
        threadRootId: thread.root.id,
        roster: members.map((m) => ({ kind: m.kind, id: m.id, displayName: m.displayName })),
        history: history.map((r) => {
          const a = authorOf(dir, r.authorKind, r.authorId);
          return {
            messageId: r.id,
            author: { kind: a.kind, id: a.id ?? "", displayName: a.displayName },
            body: r.body,
            createdAt: new Date(r.createdAt).toISOString(),
          };
        }),
      };
    }),
  );

  /**
   * One participant of `POST /dms` (D-06): an active member of this organization (RLS: another org's id is
   * simply missing → 404), or a live bot the caller may use (`bot.read`, hidden as 404). Personal bots only
   * ever live in their owner's 1:1 DM, never in a group (409 `personal_bot_dm_only`).
   */
  async function checkParticipant(
    req: FastifyRequest,
    tx: Tx,
    dir: Directory,
    p: { kind: "user" | "agent"; id: string },
    group: boolean,
  ): Promise<void> {
    if (p.kind === "user") {
      // Seeing who is in the organization is what lets a member pick someone to message.
      await perms.assertCan(req, tx, "member.read");
      const [m] = await tx
        .select({ deactivatedAt: orgMembers.deactivatedAt })
        .from(orgMembers)
        .where(eq(orgMembers.userId, p.id))
        .limit(1);
      if (!m) throw notFound("Member not found");
      if (m.deactivatedAt) throw badRequest("This member is deactivated", "member_deactivated");
      return;
    }
    const bot = dir.agents.get(p.id);
    if (!bot || bot.deleted) throw notFound("Bot not found");
    await perms.assertCan(
      req,
      tx,
      "bot.read",
      agentResource(
        {
          scope: bot.scope ?? "team",
          ownerUserId: bot.ownerUserId ?? null,
          disabled: bot.status === "disabled",
        },
        authOf(req).userId,
      ),
      { hideAs404: true },
    );
    if (group && bot.scope === "personal") {
      throw conflict("Personal bots only chat in their owner's private chat", "personal_bot_dm_only");
    }
    if (bot.status === "disabled") throw badRequest("This bot is disabled", "agent_disabled");
  }

  core.chatAgent.provideAgentTyping(async (ctx: TenantCtx, agentId, conversationId, threadRootId) => {
    const data = await core.db.withTenant(ctx, async (tx): Promise<AgentTypingEvent | null> => {
      const dir = await loadDirectory(tx);
      const agent = dir.agents.get(agentId);
      if (!agent) return null;
      return { agentId, displayName: agent.displayName, avatarUrl: agent.avatarUrl, threadRootId };
    });
    if (data)
      await core.realtime.publishEphemeral(convTopic(conversationId), EphemeralTypes.agentTyping, data);
  });

  return {
    name: "chat",
    register(app) {
      const requireUser = core.identity.requireUser;
      const tags = ["chat"];

      // ---------------------------------------------------------------- channels
      app.get(
        "/channels",
        {
          config: { authz: "user" },
          preHandler: requireUser,
          schema: { tags, response: { 200: ChannelList } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const auth = authOf(req);
            await ensureGeneral(tx, deps, auth.userId);
            const rows = await listChannels(tx, auth.userId);
            const visible = await perms.filter(req, tx, rows, "channel.read", (r) =>
              channelResource(r.facts),
            );
            const withCan: ChannelSummaryDto[] = [];
            // Sequential: every decision shares the transaction's single connection (facts are memoised).
            for (const row of visible) withCan.push(await withViewerCan(req, tx, row));
            // CHAT-09: badges only on the rows the resolver kept (T-04-10-01).
            const channels = await withUnreadCounts(tx, auth.userId, withCan);
            return {
              channels,
              orgSeq: await core.realtime.lastSeq(tx, `org:${auth.organizationId}`),
              userSeq: await core.realtime.lastSeq(tx, `user:${auth.userId}`),
              memberUnitIds: await memberUnitIdsOf(tx, auth.userId),
            };
          }),
      );

      app.post(
        "/channels",
        {
          config: { authz: "user" },
          preHandler: [requireUser, perms.requirePermission("channel.create")],
          schema: { tags, body: CreateChannelRequest, response: { 200: ChannelSummary } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const auth = authOf(req);
            const { name, topic, visibility } = req.body;
            // CHAT-02: the organization (null) or a unit on one of the caller's own paths (admins: any unit).
            const unit = req.body.unitId
              ? await placeableUnit(tx, req.body.unitId, auth.userId, await perms.can(req, tx, "unit.manage"))
              : null;
            const [row] = await tx
              .insert(conversations)
              .values({
                organizationId: auth.organizationId,
                kind: "channel",
                name,
                slug: name,
                topic: topic || null,
                visibility,
                createdBy: auth.userId,
                unitId: unit?.id ?? null,
              })
              .onConflictDoNothing()
              .returning();
            if (!row) throw conflict(`#${name} already exists`, "channel_exists");
            await tx.insert(conversationMembers).values({
              conversationId: row.id,
              organizationId: auth.organizationId,
              memberKind: "user",
              memberId: auth.userId,
              role: "owner",
            });
            await core.audit.record(tx, {
              action: "channel.created",
              resourceType: "conversation",
              resourceId: row.id,
              sessionId: auth.sessionId,
              metadata: { name, visibility, unitId: unit?.id ?? null },
            });
            await notifyListChanged(tx, deps, row, EventTypes.conversationCreated);
            return summaryOf(req, tx, row.id);
          }),
      );

      app.get(
        "/channels/:id",
        {
          config: { authz: "user" },
          preHandler: requireUser,
          schema: { tags, params: IdParams, response: { 200: ChannelSummary } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const row = await channelRow(tx, req.params.id, authOf(req).userId);
            await perms.assertCan(req, tx, "channel.read", channelResource(row.facts), { hideAs404: true });
            const [one] = await withUnreadCounts(tx, authOf(req).userId, [await withViewerCan(req, tx, row)]);
            if (!one) throw notFound("Channel not found");
            return one;
          }),
      );

      /**
       * CHAT-02: move a channel to another unit (or back to the organization) and/or change its topic. The owner
       * (relation) or an admin (`channel.update`); the target unit follows the placement rule of creation. Audited
       * `channel.updated {from, to}`; `conversation.updated` on the channel and the sidebars' list topics.
       */
      app.patch(
        "/channels/:id",
        {
          config: { authz: "user" },
          preHandler: requireUser,
          schema: { tags, params: IdParams, body: UpdateChannelRequest, response: { 200: ChannelSummary } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const auth = authOf(req);
            const { conv, facts } = await readableChannel(req, tx, await getChannel(tx, req.params.id));
            await perms.assertCan(req, tx, "channel.update", channelResource(facts));
            if (conv.archivedAt) throw gone("This channel is archived", "channel_archived");
            const { unitId, topic } = req.body;
            if (unitId !== undefined && unitId !== null && conv.slug === GENERAL_SLUG) {
              throw badRequest("#general belongs to the whole organization", "default_channel");
            }
            const target =
              unitId === undefined || unitId === null
                ? null
                : await placeableUnit(tx, unitId, auth.userId, await perms.can(req, tx, "unit.manage"));
            const from: Record<string, string | null> = {};
            const to: Record<string, string | null> = {};
            if (unitId !== undefined && (target?.id ?? null) !== conv.unitId) {
              from.unitId = conv.unitId;
              to.unitId = target?.id ?? null;
            }
            const nextTopic = topic === undefined ? undefined : topic || null;
            if (nextTopic !== undefined && nextTopic !== conv.topic) {
              from.topic = conv.topic;
              to.topic = nextTopic;
            }
            if (Object.keys(to).length > 0) {
              await tx
                .update(conversations)
                .set({
                  ...("unitId" in to ? { unitId: to.unitId } : {}),
                  ...("topic" in to ? { topic: to.topic } : {}),
                })
                .where(eq(conversations.id, conv.id));
              await core.audit.record(tx, {
                action: "channel.updated",
                resourceType: "conversation",
                resourceId: conv.id,
                sessionId: auth.sessionId,
                metadata: { from, to },
              });
              await core.realtime.appendEvent(tx, convTopic(conv.id), EventTypes.conversationUpdated, {
                conversationId: conv.id,
                ...to,
              });
              await notifyListChanged(tx, deps, conv, EventTypes.conversationUpdated);
            }
            return summaryOf(req, tx, conv.id);
          }),
      );

      app.post(
        "/channels/:id/join",
        {
          config: { authz: "user" },
          preHandler: requireUser,
          schema: { tags, params: IdParams, response: { 200: ChannelSummary } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const userId = authOf(req).userId;
            const { conv } = await readableChannel(req, tx, await getChannel(tx, req.params.id));
            if (conv.archivedAt) throw gone("This channel is archived", "channel_archived");
            await addMember(tx, deps, conv, { kind: "user", id: userId }, { reason: "joined" });
            return summaryOf(req, tx, conv.id);
          }),
      );

      app.post(
        "/channels/:id/leave",
        {
          config: { authz: "user" },
          preHandler: requireUser,
          schema: { tags, params: IdParams, response: { 200: Ok } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const userId = authOf(req).userId;
            const { conv, facts } = await readableChannel(req, tx, await getChannel(tx, req.params.id));
            if (conv.slug === GENERAL_SLUG) throw badRequest("Everyone stays in #general", "default_channel");
            await perms.assertCan(req, tx, "channel.members.remove", channelMemberResource(facts, true));
            await removeMember(tx, deps, conv, { kind: "user", id: userId });
            return { ok: true as const };
          }),
      );

      app.post(
        "/channels/:id/archive",
        {
          config: { authz: "user" },
          preHandler: requireUser,
          schema: { tags, params: IdParams, response: { 200: ChannelSummary } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const auth = authOf(req);
            // 404 when the channel is hidden from the caller; 403 with {permission, layer, reason} otherwise.
            const { conv, facts } = await readableChannel(req, tx, await getChannel(tx, req.params.id));
            const res = channelResource(facts);
            if (conv.slug === GENERAL_SLUG)
              throw badRequest("#general cannot be archived", "default_channel");
            await perms.assertCan(req, tx, "channel.archive", res);
            if (!conv.archivedAt) {
              const [row] = await tx
                .update(conversations)
                .set({ archivedAt: sql`now()` })
                .where(eq(conversations.id, conv.id))
                .returning();
              await core.audit.record(tx, {
                action: "channel.archived",
                resourceType: "conversation",
                resourceId: conv.id,
                sessionId: auth.sessionId,
                metadata: { name: conv.name },
              });
              await core.realtime.appendEvent(tx, convTopic(conv.id), EventTypes.conversationUpdated, {
                conversationId: conv.id,
                archivedAt: row?.archivedAt ? new Date(row.archivedAt).toISOString() : null,
              });
              await notifyListChanged(tx, deps, conv, EventTypes.conversationUpdated);
            }
            return summaryOf(req, tx, conv.id);
          }),
      );

      app.post(
        "/channels/:id/read",
        {
          config: { authz: "user" },
          preHandler: requireUser,
          schema: { tags, params: IdParams, body: MarkReadRequest, response: { 200: Ok } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const { conv } = await readableChannel(req, tx, await getChannel(tx, req.params.id));
            // greatest(...): a read never moves the cursor backwards (mark unread has its own route).
            await moveReadCursor(tx, authOf(req).userId, conv.id, { forward: req.body.seq });
            return { ok: true as const };
          }),
      );

      // ---------------------------------------------------------------- members
      app.get(
        "/channels/:id/members",
        {
          config: { authz: "user" },
          preHandler: requireUser,
          schema: { tags, params: IdParams, response: { 200: ChannelMemberList } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const { conv } = await readableChannel(req, tx, await getChannel(tx, req.params.id));
            return { members: await listChannelMembers(tx, conv.id, await loadDirectory(tx)) };
          }),
      );

      app.post(
        "/channels/:id/members",
        {
          config: { authz: "user" },
          preHandler: requireUser,
          schema: {
            tags,
            params: IdParams,
            body: AddConversationMemberRequest,
            response: { 200: ChannelMemberList },
          },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const { conv, facts } = await readableChannel(req, tx, await getChannel(tx, req.params.id));
            if (conv.archivedAt) throw gone("This channel is archived", "channel_archived");
            await perms.assertCan(req, tx, "channel.members.add", channelResource(facts));
            const dir = await loadDirectory(tx);
            const target =
              req.body.kind === "agent" ? dir.agents.get(req.body.id) : dir.users.get(req.body.id);
            if (!target) throw notFound(req.body.kind === "agent" ? "Bot not found" : "Member not found");
            if (target.scope === "personal") {
              throw conflict("Personal bots only chat in their owner's private chat", "personal_bot_dm_only");
            }
            if (target.status === "disabled") throw badRequest("This bot is disabled", "agent_disabled");
            await addMember(tx, deps, conv, { kind: req.body.kind, id: req.body.id });
            return { members: await listChannelMembers(tx, conv.id, dir) };
          }),
      );

      app.delete(
        "/channels/:id/members/:kind/:memberId",
        {
          config: { authz: "user" },
          preHandler: requireUser,
          schema: { tags, params: MemberParams, response: { 200: ChannelMemberList } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const auth = authOf(req);
            const { conv, facts } = await readableChannel(req, tx, await getChannel(tx, req.params.id));
            // Self (leave), channel owner or admin: relations and role decided by the resolver.
            const self = req.params.kind === "user" && req.params.memberId === auth.userId;
            await perms.assertCan(req, tx, "channel.members.remove", channelMemberResource(facts, self));
            if (conv.slug === GENERAL_SLUG && req.params.kind === "user") {
              throw badRequest("Everyone stays in #general", "default_channel");
            }
            await removeMember(tx, deps, conv, { kind: req.params.kind, id: req.params.memberId });
            return { members: await listChannelMembers(tx, conv.id, await loadDirectory(tx)) };
          }),
      );

      // ---------------------------------------------------------------- messages
      app.get(
        "/conversations/:id/messages",
        {
          config: { authz: "user" },
          preHandler: requireUser,
          // PageQueryFields: the one-cursor rule is checked below, after the readable check (hidden stays 404).
          schema: { tags, params: IdParams, querystring: PageQueryFields, response: { 200: MessagePage } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const { conv } = await readableChannel(
              req,
              tx,
              await getConversation(tx, req.params.id, MESSAGE_KINDS),
              "Conversation not found",
            );
            const q = req.query;
            if (pageCursorCount(q) > 1) {
              throw badRequest("Use at most one of before, after and around", "invalid_page_query");
            }
            // lastSeq first: anything committed after this read is replayed by the subscription.
            const lastSeq = await core.realtime.lastSeq(tx, convTopic(conv.id));
            const dir = await loadDirectory(tx);
            const me = authOf(req).userId;
            if (q.around) {
              // Permalinks (CHAT-14): the anchor must belong to this conversation; a reply anchors on its root.
              const target = await getMessage(tx, q.around);
              if (!target || target.conversationId !== conv.id) throw notFound("Message not found");
              const anchor = target.threadId ? await getMessage(tx, target.threadId) : target;
              if (!anchor || anchor.conversationId !== conv.id) throw notFound("Message not found");
              const page = await listMessagesAround(tx, conv.id, dir, anchor, q.limit, me);
              return { ...page, threadRootId: target.threadId ? anchor.id : null, lastSeq };
            }
            if (q.after !== undefined) {
              const page = await listMessagesAfter(tx, conv.id, dir, q.after, q.limit, me);
              return { ...page, nextBefore: null, lastSeq };
            }
            const page = await listMessages(tx, conv.id, dir, q, me);
            return { ...page, lastSeq };
          }),
      );

      app.post(
        "/conversations/:id/messages",
        {
          config: { authz: "user" },
          preHandler: requireUser,
          schema: { tags, params: IdParams, body: PostMessageRequest, response: { 200: Message } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const auth = authOf(req);
            const { conv, facts } = await readableChannel(
              req,
              tx,
              await getConversation(tx, req.params.id, MESSAGE_KINDS),
              "Conversation not found",
            );
            if (conv.archivedAt) throw gone("This conversation is archived", "channel_archived");
            await perms.assertCan(req, tx, "channel.post", channelResource(facts));
            if (isDirect(conv.kind) && req.body.threadRootId) {
              throw badRequest("Direct conversations have no threads", "dm_is_flat");
            }
            // The contract accepts attachment-only posts; the upload pipeline (Plan 04-04) has not landed yet,
            // so nothing may create an empty message in the meantime.
            if (req.body.attachmentIds?.length || !req.body.body) {
              throw badRequest("Attachments are not available yet", "attachments_unavailable");
            }
            // @channel / @here (CHAT-08, Pitfall 6, P-11): channels only, deny-able, one per channel per minute.
            const mentionAll = conv.kind === "channel" ? mentionAllOf(req.body.body) : null;
            if (mentionAll) {
              await perms.assertCan(req, tx, "channel.mention_all", channelResource(facts));
              const retry =
                req.body.clientMessageId !== undefined &&
                (await isOwnRetry(tx, auth.userId, req.body.clientMessageId));
              if (!retry) await claimMentionAll(conv.id);
            }
            const dir = await loadDirectory(tx);
            const result = await postMessage(tx, deps, dir, {
              conv,
              author: { kind: "user", id: auth.userId },
              body: req.body.body,
              mentions: resolveMentions(req.body.body, dir),
              threadRootId: req.body.threadRootId,
              clientMessageId: req.body.clientMessageId,
              clientKind: auth.clientKind,
              sessionId: auth.sessionId,
            });
            if (result.created) {
              // Observers (notifications, CHAT-08) in the message transaction, through the seam (no import).
              await core.chatEvents.messagePosted(tx, {
                conv: { id: conv.id, kind: messageKindOf(conv), organizationId: conv.organizationId },
                message: result.message,
                author: { kind: "user", id: auth.userId },
                mentions: result.row.mentions,
                // Reserved handles never resolve as people or bots, so a broadcast never wakes a bot.
                mentionAll,
                threadRootId: result.root?.id ?? null,
              });
              // The zone only travels with this message's deliveries (turn context); it is never stored.
              const author = { id: auth.userId, clientTimeZone: req.body.clientTimeZone };
              if (conv.kind === "dm") await dispatchDmMessage(tx, dir, conv, result, author);
              else if (conv.kind === "group") await dispatchGroupMentions(tx, dir, conv, result, author);
              else if ((await dispatchAgentMentions(tx, dir, result, author)).length === 0) {
                await dispatchReplyMode(tx, dir, conv, result, author);
              }
            }
            return result.message;
          }),
      );

      // ---------------------------------------------------------------- direct conversations (D-03)
      app.get(
        "/dms",
        {
          config: { authz: "user" },
          preHandler: requireUser,
          schema: { tags, response: { 200: DmList } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const auth = authOf(req);
            const rows = await listDms(tx, auth.userId);
            // Membership is in the query; the resolver still decides each read (no second authority).
            const dms = await perms.filter(req, tx, rows, "channel.read", (r) =>
              channelResource({
                visibility: r.visibility,
                archived: r.archivedAt !== null,
                viewerRole: "member",
                kind: r.kind === "group" ? "group" : "dm",
              }),
            );
            return { dms, userSeq: await core.realtime.lastSeq(tx, `user:${auth.userId}`) };
          }),
      );

      /**
       * CHAT-04 (D-06): open a direct conversation with the given participants (the caller is implied and
       * removed from the list). One person → their DM; one bot → the bot DM (`bot.read` decided, personal bots
       * for their owner only); two or more → the group DM of exactly that set (≤ 9 with the caller, no personal
       * bots). Insert-or-get, so it answers the existing conversation when there is one.
       */
      app.post(
        "/dms",
        {
          config: { authz: "user" },
          preHandler: requireUser,
          schema: { tags, body: CreateDmRequestFields, response: { 200: DmSummary } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const auth = authOf(req);
            const seen = new Set<string>();
            const others = req.body.participants.filter((p) => {
              const key = `${p.kind}:${p.id.toLowerCase()}`;
              if (seen.has(key) || (p.kind === "user" && p.id.toLowerCase() === auth.userId)) return false;
              seen.add(key);
              return true;
            });
            if (others.length === 0) throw badRequest("You cannot message yourself", "cannot_dm_self");
            if (others.length > MAX_GROUP_PARTICIPANTS - 1) {
              throw badRequest(
                `A group can have at most ${MAX_GROUP_PARTICIPANTS} participants`,
                "too_many_participants",
              );
            }
            const dir = await loadDirectory(tx);
            for (const p of others) await checkParticipant(req, tx, dir, p, others.length > 1);
            let conv: ConversationRow;
            const only = others[0];
            if (others.length === 1 && only?.kind === "user") {
              ({ conv } = await ensureHumanDm(tx, deps, { userId: auth.userId, otherUserId: only.id }));
            } else if (others.length === 1 && only) {
              ({ conv } = await ensureDm(tx, deps, { agentId: only.id, userId: auth.userId }));
            } else {
              ({ conv } = await ensureGroup(tx, deps, {
                creatorId: auth.userId,
                members: others.map((p) => ({ kind: p.kind, id: p.id })),
              }));
            }
            // The caller reads what was opened (the resolver decides it, like every read).
            await readableChannel(req, tx, conv, "Conversation not found");
            const [summary] = await listDms(tx, auth.userId, { ids: [conv.id] });
            if (!summary) throw notFound("Conversation not found");
            return summary;
          }),
      );

      app.post(
        "/conversations/:id/read",
        {
          config: { authz: "user" },
          preHandler: requireUser,
          schema: { tags, params: IdParams, body: MarkReadRequest, response: { 200: Ok } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const { conv } = await readableChannel(
              req,
              tx,
              await getConversation(tx, req.params.id, MESSAGE_KINDS),
              "Conversation not found",
            );
            // greatest(...): a read never moves the cursor backwards (mark unread has its own route).
            await moveReadCursor(tx, authOf(req).userId, conv.id, { forward: req.body.seq });
            return { ok: true as const };
          }),
      );

      /**
       * CHAT-09 (D-07, Pitfall 2): mark a conversation unread from one of its top-level messages. The caller's cursor
       * becomes exactly that message's seq - 1 (backwards included). Readable first (hidden = missing = 404); the
       * message must belong to it (otherwise 404, T-04-10-03); a thread reply is 400 `not_top_level`; only the
       * caller's own membership moves (T-04-10-02) and a non-member has none (400 `not_a_member`). Never un-reads a
       * notification; `conversation.read` tells the caller's other tabs and devices.
       */
      app.post(
        "/conversations/:id/unread",
        {
          config: { authz: "user" },
          preHandler: requireUser,
          schema: { tags, params: IdParams, body: MarkUnreadRequest, response: { 200: Ok } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const { conv } = await readableChannel(
              req,
              tx,
              await getConversation(tx, req.params.id, MESSAGE_KINDS),
              "Conversation not found",
            );
            const message = await getMessage(tx, req.body.messageId);
            if (!message || message.conversationId !== conv.id) throw notFound("Message not found");
            if (message.threadId) {
              throw badRequest(
                "Mark a message of the conversation unread, not a thread reply",
                "not_top_level",
              );
            }
            const moved = await moveReadCursor(tx, authOf(req).userId, conv.id, {
              exact: Math.max(0, Number(message.seq) - 1),
            });
            if (!moved)
              throw badRequest("Join the conversation to keep track of what you read", "not_a_member");
            return { ok: true as const };
          }),
      );

      app.get(
        "/messages/:id/thread",
        {
          config: { authz: "user" },
          preHandler: requireUser,
          schema: { tags, params: IdParams, response: { 200: ThreadResponse } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const thread = await loadThread(tx, req.params.id);
            if (!thread) throw notFound("Thread not found");
            // Any conversation with messages, DMs and groups included (flat: a root with no replies); hidden =
            // missing = 404 (D-01).
            await readableChannel(
              req,
              tx,
              await getConversation(tx, thread.root.conversationId, MESSAGE_KINDS),
              "Thread not found",
            );
            const dir = await loadDirectory(tx);
            const participants =
              (await replyParticipantsFor(tx, [thread.root.id], dir)).get(thread.root.id) ?? [];
            const everyone = new Map<string, ReturnType<typeof authorOf>>();
            for (const r of [thread.root, ...thread.replies]) {
              const a = authorOf(dir, r.authorKind, r.authorId);
              everyone.set(`${a.kind}:${a.id}`, a);
            }
            const [root, ...replies] = await hydrateViewer(
              tx,
              [toMessage(thread.root, dir, participants), ...thread.replies.map((r) => toMessage(r, dir))],
              authOf(req).userId,
            );
            return {
              root: root ?? toMessage(thread.root, dir, participants),
              replies,
              participants: [...everyone.values()],
            };
          }),
      );

      // ---------------------------------------------------------------- message actions (CHAT-06)
      const routeCtx: ChatRouteCtx = { core, deps, access, perms };
      registerMessageActionRoutes(app, routeCtx);
      // ---------------------------------------------------------------- reactions (CHAT-07)
      registerReactionRoutes(app, routeCtx);
      // ---------------------------------------------------------------- pins (CHAT-13)
      registerPinRoutes(app, routeCtx);
      // ---------------------------------------------------------------- personal saves (CHAT-13)
      registerSaveRoutes(app, routeCtx);
      // ---------------------------------------------------------------- the Threads view (CHAT-02)
      registerThreadRoutes(app, routeCtx);

      if (core.env.NODE_ENV === "test") registerChatTestRoutes(app, core);
    },
  };
}
