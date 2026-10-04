import {
  AddConversationMemberRequest,
  type AgentTypingEvent,
  ChannelList,
  ChannelMemberList,
  ChannelSummary,
  type ChannelSummary as ChannelSummaryDto,
  CreateChannelRequest,
  EphemeralTypes,
  EventTypes,
  IdParams,
  MarkReadRequest,
  MemberParams,
  Message,
  MessagePage,
  Ok,
  PageQuery,
  PostMessageRequest,
  ThreadResponse,
} from "@ocw/contracts";
import { conversationMembers, conversations, type TenantCtx, type Tx, tenantOf } from "@ocw/db";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type ApiModule, authOf, type Core, tenant } from "../../core";
import type { AgentMention, ThreadContext } from "../../lib/chat-agent-bridge";
import { badRequest, conflict, gone, notFound } from "../../lib/errors";
import {
  AuthzDeniedError,
  type ChannelFacts,
  channelMemberResource,
  channelResource,
  createPermissionService,
} from "../organization";
import { authorOf, type Directory, loadDirectory } from "./directory";
import { resolveMentions } from "./mentions";
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
  getMembership,
  getMessage,
  listChannelMembers,
  listChannels,
  listMessages,
  loadThread,
  notifyListChanged,
  type PostResult,
  postMessage,
  removeMember,
  replyParticipantsFor,
  toMessage,
} from "./service";
import { registerChatTestRoutes } from "./test-routes";

export { resolveMentions } from "./mentions";

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

  /** The channel permissions the web needs per channel (header menu, composer, members panel). */
  const VIEWER_CAN = [
    "channel.post",
    "channel.members.add",
    "channel.members.remove",
    "channel.archive",
  ] as const;

  async function withViewerCan(req: FastifyRequest, tx: Tx, row: ChannelRow): Promise<ChannelSummaryDto> {
    return {
      ...row.summary,
      viewerCan: await perms.viewerCan(req, tx, channelResource(row.facts), VIEWER_CAN),
    };
  }

  /** One channel as the caller sees it, with `viewerCan`. */
  async function summaryOf(req: FastifyRequest, tx: Tx, id: string): Promise<ChannelSummaryDto> {
    return withViewerCan(req, tx, await channelRow(tx, id, authOf(req).userId));
  }

  /**
   * The channel and the caller's facts when the resolver lets the caller read it. Missing and hidden
   * channels are the same 404, so a private channel never reveals that it exists.
   */
  async function readableChannel(
    req: FastifyRequest,
    tx: Tx,
    conv: ConversationRow | null,
    notFoundMessage = "Channel not found",
  ): Promise<{ conv: ConversationRow; facts: ChannelFacts }> {
    if (!conv) throw notFound(notFoundMessage);
    const facts = await channelFacts(tx, conv, { kind: "user", id: authOf(req).userId });
    await perms.assertCan(req, tx, "channel.read", channelResource(facts), { hideAs404: true });
    return { conv, facts };
  }

  // ---------------------------------------------------------------- realtime: conv:<id>
  // Subscribing to a channel's stream is reading it: the resolver decides channel.read for the user.
  core.realtime.registerTopicAuthorizer("conv", (auth, conversationId) =>
    core.db.withTenant({ organizationId: auth.organizationId, userId: auth.userId }, async (tx) => {
      const conv = await getChannel(tx, conversationId);
      if (!conv) return false;
      const facts = await channelFacts(tx, conv, { kind: "user", id: auth.userId });
      const d = await perms.decide(
        tx,
        { kind: "user", userId: auth.userId },
        "channel.read",
        channelResource(facts),
      );
      return d.allowed;
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
    author: { id: string },
  ): Promise<string[]> {
    const conv = await getChannel(tx, result.row.conversationId);
    if (!conv) return [];
    const agentIds: string[] = [];
    let authorRes: ReturnType<typeof channelResource> | undefined;
    for (const m of result.row.mentions) {
      if (m.kind !== "agent") continue;
      const agent = dir.agents.get(m.id);
      if (!agent || agent.status === "disabled") continue;
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
    };
    await core.chatAgent.emitAgentMention(tx, mention, tenantOf(tx).afterCommit);
    return agentIds;
  }

  core.chatAgent.providePostAgentMessage((ctx, input) =>
    core.db.withTenant(ctx, async (tx) => {
      const dir = await loadDirectory(tx);
      const agent = dir.agents.get(input.agentId);
      if (!agent) throw notFound("Agent not found", "agent_not_found");
      const conv = await getChannel(tx, input.conversationId);
      if (!conv) throw notFound("Conversation not found");
      if (conv.archivedAt) throw gone("This channel is archived", "channel_archived");
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
        threadRootId: input.threadRootId,
        clientMessageId: input.idempotencyKey,
        clientKind: "agent",
        lenientThreadRoot: true,
      });
      if (result.created) {
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
      const conv = await getChannel(tx, conversationId);
      if (!conv) throw notFound("Conversation not found");
      const thread = await loadThread(tx, threadRootId);
      if (!thread || thread.root.conversationId !== conv.id) throw notFound("Thread not found");
      const members = await listChannelMembers(tx, conv.id, dir);
      const replies = thread.replies.slice(-Math.max(0, limit - 1));
      return {
        conversationId: conv.id,
        threadRootId: thread.root.id,
        roster: members.map((m) => ({ kind: m.kind, id: m.id, displayName: m.displayName })),
        history: [thread.root, ...replies].map((r) => {
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
            const channels: ChannelSummaryDto[] = [];
            // Sequential: every decision shares the transaction's single connection (facts are memoised).
            for (const row of visible) channels.push(await withViewerCan(req, tx, row));
            return {
              channels,
              orgSeq: await core.realtime.lastSeq(tx, `org:${auth.organizationId}`),
              userSeq: await core.realtime.lastSeq(tx, `user:${auth.userId}`),
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
              metadata: { name, visibility },
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
            return withViewerCan(req, tx, row);
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
            await readableChannel(req, tx, await getChannel(tx, req.params.id));
            await tx
              .update(conversationMembers)
              .set({ lastReadSeq: sql`greatest(${conversationMembers.lastReadSeq}, ${req.body.seq})` })
              .where(
                and(
                  eq(conversationMembers.conversationId, req.params.id),
                  eq(conversationMembers.memberKind, "user"),
                  eq(conversationMembers.memberId, authOf(req).userId),
                ),
              );
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
          schema: { tags, params: IdParams, querystring: PageQuery, response: { 200: MessagePage } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const { conv } = await readableChannel(req, tx, await getChannel(tx, req.params.id));
            // lastSeq first: anything committed after this read is replayed by the subscription.
            const lastSeq = await core.realtime.lastSeq(tx, convTopic(conv.id));
            const page = await listMessages(tx, conv.id, await loadDirectory(tx), req.query);
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
            const { conv, facts } = await readableChannel(req, tx, await getChannel(tx, req.params.id));
            if (conv.archivedAt) throw gone("This channel is archived", "channel_archived");
            await perms.assertCan(req, tx, "channel.post", channelResource(facts));
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
            if (result.created) await dispatchAgentMentions(tx, dir, result, { id: auth.userId });
            return result.message;
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
            await readableChannel(
              req,
              tx,
              await getChannel(tx, thread.root.conversationId),
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
            return {
              root: toMessage(thread.root, dir, participants),
              replies: thread.replies.map((r) => toMessage(r, dir)),
              participants: [...everyone.values()],
            };
          }),
      );

      if (core.env.NODE_ENV === "test") registerChatTestRoutes(app, core);
    },
  };
}
