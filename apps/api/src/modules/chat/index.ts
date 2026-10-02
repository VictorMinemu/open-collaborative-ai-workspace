import {
  AddConversationMemberRequest,
  type AgentTypingEvent,
  ChannelList,
  ChannelMemberList,
  ChannelSummary,
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
import { type ApiModule, authOf, type Core, tenant } from "../../core";
import type { AgentMention, ThreadContext } from "../../lib/chat-agent-bridge";
import { badRequest, conflict, forbidden, gone, notFound } from "../../lib/errors";
import { authorOf, type Directory, loadDirectory } from "./directory";
import { resolveMentions } from "./mentions";
import {
  addMember,
  type ChatDeps,
  canRead,
  channelSummary,
  convTopic,
  ensureGeneral,
  GENERAL_SLUG,
  getChannel,
  getMembership,
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

/**
 * chat module (B1): channels, membership, messages, single-level threads, server-side @mentions, the `conv`
 * topic authorizer and the chat side of the chat ↔ agent-channel bridge (lib/chat-agent-bridge.ts).
 */
export function createChatModule(core: Core): ApiModule {
  const deps: ChatDeps = { audit: core.audit, realtime: core.realtime };

  // ---------------------------------------------------------------- realtime: conv:<id>
  core.realtime.registerTopicAuthorizer("conv", (auth, conversationId) =>
    core.db.withTenant({ organizationId: auth.organizationId, userId: auth.userId }, async (tx) => {
      const conv = await getChannel(tx, conversationId);
      return conv ? canRead(tx, conv, auth.userId) : false;
    }),
  );

  // ---------------------------------------------------------------- bridge: chat → agent-channel
  /**
   * Agent mentions in a fresh human message: agents that are not members yet are auto-added (the poster is a
   * member, and members may add members), disabled agents are ignored, then ONE `emitAgentMention` carries
   * every addressed agent. Runs inside the message transaction, so a rolled-back message is never delivered.
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
    for (const m of result.row.mentions) {
      if (m.kind !== "agent") continue;
      const agent = dir.agents.get(m.id);
      if (!agent || agent.status === "disabled") continue;
      await addMember(tx, deps, conv, { kind: "agent", id: agent.id }, { reason: "mentioned" });
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
      if (agent.status === "disabled") throw forbidden("Agent is disabled", "agent_disabled");
      const conv = await getChannel(tx, input.conversationId);
      if (!conv) throw notFound("Conversation not found");
      if (conv.archivedAt) throw gone("This channel is archived", "channel_archived");
      if (!(await getMembership(tx, conv.id, "agent", agent.id))) {
        throw forbidden("The agent is not a member of this conversation", "agent_not_member");
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
        { preHandler: requireUser, schema: { tags, response: { 200: ChannelList } } },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const auth = authOf(req);
            await ensureGeneral(tx, deps, auth.userId);
            return {
              channels: await listChannels(tx, auth.userId),
              orgSeq: await core.realtime.lastSeq(tx, `org:${auth.organizationId}`),
              userSeq: await core.realtime.lastSeq(tx, `user:${auth.userId}`),
            };
          }),
      );

      app.post(
        "/channels",
        {
          preHandler: requireUser,
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
            return channelSummary(tx, row.id, auth.userId);
          }),
      );

      app.get(
        "/channels/:id",
        { preHandler: requireUser, schema: { tags, params: IdParams, response: { 200: ChannelSummary } } },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const conv = await getChannel(tx, req.params.id);
            if (!conv || !(await canRead(tx, conv, authOf(req).userId))) throw notFound("Channel not found");
            return channelSummary(tx, conv.id, authOf(req).userId);
          }),
      );

      app.post(
        "/channels/:id/join",
        { preHandler: requireUser, schema: { tags, params: IdParams, response: { 200: ChannelSummary } } },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const userId = authOf(req).userId;
            const conv = await getChannel(tx, req.params.id);
            if (!conv || !(await canRead(tx, conv, userId))) throw notFound("Channel not found");
            if (conv.archivedAt) throw gone("This channel is archived", "channel_archived");
            await addMember(tx, deps, conv, { kind: "user", id: userId }, { reason: "joined" });
            return channelSummary(tx, conv.id, userId);
          }),
      );

      app.post(
        "/channels/:id/leave",
        { preHandler: requireUser, schema: { tags, params: IdParams, response: { 200: Ok } } },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const userId = authOf(req).userId;
            const conv = await getChannel(tx, req.params.id);
            if (!conv || !(await canRead(tx, conv, userId))) throw notFound("Channel not found");
            if (conv.slug === GENERAL_SLUG) throw badRequest("Everyone stays in #general", "default_channel");
            await removeMember(tx, deps, conv, { kind: "user", id: userId });
            return { ok: true as const };
          }),
      );

      app.post(
        "/channels/:id/archive",
        { preHandler: requireUser, schema: { tags, params: IdParams, response: { 200: ChannelSummary } } },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const auth = authOf(req);
            const conv = await getChannel(tx, req.params.id);
            if (!conv || !(await canRead(tx, conv, auth.userId))) throw notFound("Channel not found");
            if (conv.slug === GENERAL_SLUG)
              throw badRequest("#general cannot be archived", "default_channel");
            const membership = await getMembership(tx, conv.id, "user", auth.userId);
            const isAdmin = auth.role === "owner" || auth.role === "admin";
            if (!isAdmin && membership?.role !== "owner") {
              throw forbidden("Only the channel owner or an admin can archive it");
            }
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
            return channelSummary(tx, conv.id, auth.userId);
          }),
      );

      app.post(
        "/channels/:id/read",
        {
          preHandler: requireUser,
          schema: { tags, params: IdParams, body: MarkReadRequest, response: { 200: Ok } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
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
        { preHandler: requireUser, schema: { tags, params: IdParams, response: { 200: ChannelMemberList } } },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const conv = await getChannel(tx, req.params.id);
            if (!conv || !(await canRead(tx, conv, authOf(req).userId))) throw notFound("Channel not found");
            return { members: await listChannelMembers(tx, conv.id, await loadDirectory(tx)) };
          }),
      );

      app.post(
        "/channels/:id/members",
        {
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
            const userId = authOf(req).userId;
            const conv = await getChannel(tx, req.params.id);
            if (!conv || !(await canRead(tx, conv, userId))) throw notFound("Channel not found");
            if (conv.archivedAt) throw gone("This channel is archived", "channel_archived");
            if (!(await getMembership(tx, conv.id, "user", userId))) {
              throw forbidden("Join the channel to add people or bots", "not_a_member");
            }
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
          preHandler: requireUser,
          schema: { tags, params: MemberParams, response: { 200: ChannelMemberList } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const auth = authOf(req);
            const conv = await getChannel(tx, req.params.id);
            if (!conv || !(await canRead(tx, conv, auth.userId))) throw notFound("Channel not found");
            const self = req.params.kind === "user" && req.params.memberId === auth.userId;
            const membership = await getMembership(tx, conv.id, "user", auth.userId);
            const isAdmin = auth.role === "owner" || auth.role === "admin";
            if (!self && !isAdmin && membership?.role !== "owner") {
              throw forbidden("Only the channel owner or an admin can remove members");
            }
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
          preHandler: requireUser,
          schema: { tags, params: IdParams, querystring: PageQuery, response: { 200: MessagePage } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const conv = await getChannel(tx, req.params.id);
            if (!conv || !(await canRead(tx, conv, authOf(req).userId))) throw notFound("Channel not found");
            // lastSeq first: anything committed after this read is replayed by the subscription.
            const lastSeq = await core.realtime.lastSeq(tx, convTopic(conv.id));
            const page = await listMessages(tx, conv.id, await loadDirectory(tx), req.query);
            return { ...page, lastSeq };
          }),
      );

      app.post(
        "/conversations/:id/messages",
        {
          preHandler: requireUser,
          schema: { tags, params: IdParams, body: PostMessageRequest, response: { 200: Message } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const auth = authOf(req);
            const conv = await getChannel(tx, req.params.id);
            if (!conv || !(await canRead(tx, conv, auth.userId))) throw notFound("Channel not found");
            if (conv.archivedAt) throw gone("This channel is archived", "channel_archived");
            if (!(await getMembership(tx, conv.id, "user", auth.userId))) {
              throw forbidden("Join the channel to post in it", "not_a_member");
            }
            const dir = await loadDirectory(tx);
            const result = await postMessage(tx, deps, dir, {
              conv,
              author: { kind: "user", id: auth.userId },
              body: req.body.body,
              mentions: resolveMentions(req.body.body, dir),
              threadRootId: req.body.threadRootId,
              clientMessageId: req.body.clientMessageId,
              clientKind: "web",
              sessionId: auth.sessionId,
            });
            if (result.created) await dispatchAgentMentions(tx, dir, result, { id: auth.userId });
            return result.message;
          }),
      );

      app.get(
        "/messages/:id/thread",
        { preHandler: requireUser, schema: { tags, params: IdParams, response: { 200: ThreadResponse } } },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const thread = await loadThread(tx, req.params.id);
            const conv = thread ? await getChannel(tx, thread.root.conversationId) : null;
            if (!thread || !conv || !(await canRead(tx, conv, authOf(req).userId))) {
              throw notFound("Thread not found");
            }
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
