import {
  AGENT_CHANNEL_BASE_PATH,
  AGENT_CHANNEL_PROTOCOL_VERSION,
  Agent,
  AgentCellStatus,
  AgentChannelPostMessage,
  AgentChannelPostMessageResponse,
  AgentChannelProviderAuthReport,
  AgentChannelStatusReport,
  AgentChannelTyping,
  CellSnapshot,
  cellTopic,
  IdParams,
  Ok,
  ProviderAuthStatus,
  RotateCellTokenResponse,
  SubscriptionProviderParams,
} from "@ocw/contracts";
import { agentCredentials, conversationMembers, conversations, messages, type Tx } from "@ocw/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { type ApiModule, type App, authOf, type Core, tenant } from "../../core";
import { randomToken, sha256Hex } from "../../lib/crypto";
import { badRequest, HttpError, notFound } from "../../lib/errors";
import { applyCellStatus, cellAgents, cellProviders, cellSubscriptions, findAgent } from "../agent";
import { cellAgentCapabilities, loadPolicy } from "../bot-capabilities";
import { channelResource, createPermissionService, type ResourceFacts } from "../organization";
import { cellOf, createCellAuth } from "./auth";
import { registerCellGateway } from "./gateway";
import { registerMemoryRoutes } from "./memories";
import { registerMentionHandler } from "./mentions";
import { createCellPresence } from "./presence";
import { createProviderAuth } from "./provider-auth";
import { registerToolCallRoutes } from "./tool-calls";

export { buildMentionEvents } from "./mentions";

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];

async function getConversation(tx: Tx, conversationId: string) {
  const [conv] = await tx.select().from(conversations).where(eq(conversations.id, conversationId));
  if (!conv) throw notFound("Conversation not found", "conversation_not_found");
  return conv;
}

/**
 * The bot's view of a conversation as resolver facts: a thread is judged by its parent channel (visibility,
 * archived, the bot's membership in it or in the thread). Data only; the decision is the resolver's.
 */
async function botChannelResource(
  tx: Tx,
  conv: typeof conversations.$inferSelect,
  agentId: string,
): Promise<ResourceFacts> {
  let channel = conv;
  if (conv.kind === "thread" && conv.parentConversationId) {
    const [parent] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.parentConversationId));
    if (parent) channel = parent;
  }
  const [m] = await tx
    .select({ role: conversationMembers.role })
    .from(conversationMembers)
    .where(
      and(
        inArray(conversationMembers.conversationId, [...new Set([conv.id, channel.id])]),
        eq(conversationMembers.memberKind, "agent"),
        eq(conversationMembers.memberId, agentId),
      ),
    )
    .limit(1);
  return channelResource({
    visibility: channel.visibility,
    archived: channel.archivedAt !== null,
    viewerRole: m?.role ?? null,
  });
}

/**
 * agent-channel module — the Agent Channel API v1 consumed ONLY by the OpenClaw channel plugin (bearer cell
 * token, `/agent-channel/v1/*`), plus the admin cell controls under `/api/v1/agent-cell*` (cookie session).
 * Contract: `.planning/phases/01-mvp-0-multiplayer-ai-chat-slice/01-AGENT-CHANNEL-API.md`.
 */
export function createAgentChannelModule(core: Core): ApiModule {
  const auth = createCellAuth(core);
  const presence = createCellPresence(core);
  const perms = createPermissionService(core);
  const requireUser = core.identity.requireUser;
  const user = { authz: "user" as const };
  const cellManage = { config: user, preHandler: [requireUser, perms.requirePermission("cell.manage")] };
  const providerManage = {
    config: user,
    preHandler: [requireUser, perms.requirePermission("provider.manage")],
  };
  /** Every Agent Channel route: the authenticated cell principal must hold `cell.sync`. */
  const cellRoute = { config: { authz: "cell" as const } };
  const providerAuth = createProviderAuth(core, presence);
  registerMentionHandler(core);

  async function uiTokenCreatedAt(tx: Tx): Promise<string | null> {
    const [row] = await tx
      .select({ createdAt: agentCredentials.createdAt })
      .from(agentCredentials)
      .where(
        and(
          eq(agentCredentials.kind, "channel_plugin"),
          isNull(agentCredentials.agentId),
          isNull(agentCredentials.revokedAt),
        ),
      )
      .orderBy(desc(agentCredentials.createdAt))
      .limit(1);
    return row ? new Date(row.createdAt).toISOString() : null;
  }

  return {
    name: "agent-channel",
    prefix: "",
    register(app) {
      // ================================================================ admin (signed-in user, /api/v1)
      app.get(
        "/api/v1/agent-cell",
        { ...cellManage, schema: { tags, response: { 200: AgentCellStatus } } },
        async (req) => {
          const created = await core.db.withTenant(tenant(req), uiTokenCreatedAt);
          return presence.status(authOf(req).organizationId, created);
        },
      );

      app.post(
        "/api/v1/agent-cell/token",
        { ...cellManage, schema: { tags, response: { 200: RotateCellTokenResponse } } },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const a = authOf(req);
            const now = new Date().toISOString();
            const revoked = await tx
              .update(agentCredentials)
              .set({ revokedAt: now })
              .where(
                and(
                  eq(agentCredentials.kind, "channel_plugin"),
                  isNull(agentCredentials.agentId),
                  isNull(agentCredentials.revokedAt),
                ),
              )
              .returning({ id: agentCredentials.id });
            const token = `ocw_cell_${randomToken(32)}`;
            const [row] = await tx
              .insert(agentCredentials)
              .values({
                organizationId: a.organizationId,
                kind: "channel_plugin",
                tokenHash: sha256Hex(token),
              })
              .returning();
            if (!row) throw new Error("credential insert failed");
            await core.audit.record(tx, {
              action: "agent_cell.token_rotated",
              resourceType: "agent_credential",
              resourceId: row.id,
              sessionId: a.sessionId,
              metadata: { revoked: revoked.map((r) => r.id) },
            });
            // Shown once; only the SHA-256 is stored.
            return { token, createdAt: new Date(row.createdAt).toISOString() };
          }),
      );

      // ---------------------------------------------------------------- subscription sign-in (provider.manage)
      // The device-code flow runs inside the cell (ADR-0006); these routes start/cancel it and expose its
      // state, including the one-time code, to provider managers only.
      app.get(
        "/api/v1/model-providers/:provider/auth",
        {
          ...providerManage,
          schema: { tags, params: SubscriptionProviderParams, response: { 200: ProviderAuthStatus } },
        },
        async (req, reply) => {
          reply.header("cache-control", "no-store");
          return providerAuth.status(authOf(req).organizationId, req.params.provider);
        },
      );

      app.post(
        "/api/v1/model-providers/:provider/auth",
        {
          ...providerManage,
          schema: {
            tags,
            params: SubscriptionProviderParams,
            body: z.object({ restart: z.boolean().optional() }).optional(),
            response: { 200: ProviderAuthStatus },
          },
        },
        async (req, reply) => {
          const a = authOf(req);
          reply.header("cache-control", "no-store");
          return providerAuth.start(
            {
              organizationId: a.organizationId,
              userId: a.userId,
              sessionId: a.sessionId,
              clientKind: a.clientKind,
            },
            req.params.provider,
            { restart: req.body?.restart },
          );
        },
      );

      app.delete(
        "/api/v1/model-providers/:provider/auth",
        {
          ...providerManage,
          schema: { tags, params: SubscriptionProviderParams, response: { 200: ProviderAuthStatus } },
        },
        async (req, reply) => {
          const a = authOf(req);
          reply.header("cache-control", "no-store");
          return providerAuth.cancel(
            {
              organizationId: a.organizationId,
              userId: a.userId,
              sessionId: a.sessionId,
              clientKind: a.clientKind,
            },
            req.params.provider,
          );
        },
      );

      // ================================================================ Agent Channel API v1 (bearer)
      app.register(
        async (raw) => {
          // Child scopes lose the Zod type provider in their inferred type; restore it.
          const scope = raw as unknown as App;
          scope.addHook("onRequest", auth.requireCell);
          // The cell acts as its own principal: every route is decided as `cell.sync` (bots, when they act,
          // are decided again as agent principals below and in chat).
          scope.addHook("preHandler", perms.requirePermission("cell.sync"));

          scope.get(
            "/cell",
            { ...cellRoute, schema: { tags, security: bearer, response: { 200: CellSnapshot } } },
            async (req, reply) => {
              const cell = cellOf(req);
              const snapshot = await core.db.withTenant(
                { organizationId: cell.organizationId, userId: null },
                async (tx) => {
                  const topic = cellTopic(cell.cellId);
                  const providers = await cellProviders(core, tx);
                  const subscriptions = await cellSubscriptions(tx);
                  // Per-agent tool sets (D-08 layer 2) and the org's search provider (D-09).
                  const capabilities = await cellAgentCapabilities(tx, core.env);
                  const policy = await loadPolicy(tx);
                  const agents = (await cellAgents(tx)).map((a) => ({
                    ...a,
                    capabilities: capabilities.get(a.id) ?? { tools: [] },
                  }));
                  await core.audit.record(tx, {
                    action: "agent_cell.config_read",
                    resourceType: "agent_cell",
                    resourceId: cell.cellId,
                    actorKind: "system",
                    clientKind: "agent",
                    sessionId: `cell:${cell.credentialId}`,
                    // Which provider credentials were delivered; never the keys.
                    metadata: {
                      providers: providers.map((p) => p.id),
                      subscriptions: subscriptions.map((p) => p.id),
                      credential: cell.source,
                    },
                  });
                  return {
                    protocolVersion: AGENT_CHANNEL_PROTOCOL_VERSION,
                    cellId: cell.cellId,
                    organizationId: cell.organizationId,
                    topic,
                    lastSeq: await core.realtime.lastSeq(tx, topic),
                    agents,
                    providers,
                    subscriptions,
                    webSearch: { provider: policy.searchProvider },
                    // MCP servers (D-13): `cellMcpServers` (modules/mcp) is wired here by 03.1-10.
                    mcpServers: [] as CellSnapshot["mcpServers"],
                  } as const;
                },
              );
              reply.header("cache-control", "no-store");
              return snapshot;
            },
          );

          scope.post(
            "/messages",
            {
              ...cellRoute,
              schema: {
                tags,
                security: bearer,
                body: AgentChannelPostMessage,
                response: { 200: AgentChannelPostMessageResponse },
              },
            },
            async (req) => {
              const cell = cellOf(req);
              const ctx = { organizationId: cell.organizationId, userId: null };
              const body = req.body;

              const check = await core.db.withTenant(ctx, async (tx) => {
                const conv = await getConversation(tx, body.conversationId);
                let root: string | null = null;
                if (body.threadRootMessageId) {
                  const [m] = await tx
                    .select({
                      id: messages.id,
                      threadId: messages.threadId,
                      conversationId: messages.conversationId,
                    })
                    .from(messages)
                    .where(eq(messages.id, body.threadRootMessageId));
                  const inScope =
                    m &&
                    (m.conversationId === conv.id || (conv.kind === "thread" && conv.rootMessageId === m.id));
                  if (!m || !inScope) {
                    throw badRequest(
                      "The thread root does not belong to this conversation",
                      "invalid_thread_root",
                    );
                  }
                  // Single-level threads: a reply's root is its thread root.
                  root = m.threadId ?? m.id;
                }
                let triggeredBy: string | null = null;
                if (body.inReplyToMessageId) {
                  const [m] = await tx
                    .select({ authorKind: messages.authorKind, authorId: messages.authorId })
                    .from(messages)
                    .where(eq(messages.id, body.inReplyToMessageId));
                  if (m?.authorKind === "user") triggeredBy = m.authorId;
                }
                return { root, triggeredBy };
              });

              let result: { messageId: string; created: boolean };
              try {
                // Chat decides the bot (agent principal: enabled, a member, agent rules) and the human it
                // answers (agent ∩ human: that person must still read the channel), then stores the message and
                // audits `agent.message.posted` (actor = agent) in its own tx. The tenant user is the
                // triggering human, so that audit row carries user_id = who asked.
                result = await core.chatAgent.postAgentMessage(
                  { organizationId: cell.organizationId, userId: check.triggeredBy },
                  {
                    agentId: body.agentId,
                    conversationId: body.conversationId,
                    threadRootId: check.root,
                    body: body.text,
                    idempotencyKey: body.idempotencyKey,
                    inReplyToMessageId: body.inReplyToMessageId,
                  },
                );
              } catch (err) {
                if (err instanceof Error && err.message.includes("has not provided")) {
                  throw new HttpError(503, "chat_unavailable", "Chat is not available on this server");
                }
                throw err;
              }
              return {
                messageId: result.messageId,
                created: result.created,
                conversationId: body.conversationId,
                threadRootMessageId: check.root,
              };
            },
          );

          scope.post(
            "/typing",
            {
              ...cellRoute,
              schema: { tags, security: bearer, body: AgentChannelTyping, response: { 200: Ok } },
            },
            async (req) => {
              const cell = cellOf(req);
              const ctx = { organizationId: cell.organizationId, userId: null };
              const body = req.body;
              await core.db.withTenant(ctx, async (tx) => {
                if (!(await findAgent(tx, body.agentId))) {
                  throw notFound("Agent not found in this cell", "agent_not_found");
                }
                const conv = await getConversation(tx, body.conversationId);
                // The bot itself must read the conversation: enabled (agent gate), a member, not denied.
                await perms.assertCan(
                  req,
                  tx,
                  "channel.read",
                  await botChannelResource(tx, conv, body.agentId),
                  {
                    as: { kind: "agent", agentId: body.agentId },
                  },
                );
              });
              const root = body.threadRootMessageId ?? null;
              // Chat publishes the ephemeral `agent.typing`; clients clear it on the agent's message or
              // after a timeout, so `typing: false` needs no signal.
              if (body.typing) await core.chatAgent.agentTyping(ctx, body.agentId, body.conversationId, root);
              return { ok: true as const };
            },
          );

          // Progress / outcome of a subscription sign-in running in the cell (never tokens).
          scope.post(
            "/provider-auth",
            {
              ...cellRoute,
              schema: {
                tags,
                security: bearer,
                body: AgentChannelProviderAuthReport,
                response: { 200: Ok },
              },
            },
            async (req) => {
              await providerAuth.report(cellOf(req).organizationId, req.body);
              return { ok: true as const };
            },
          );

          // The cell's tool gate (D-08): decision + caps + taint + audit for every gated tool call.
          registerToolCallRoutes(scope, core, perms);
          // The cell's memory tool (D-10): owner bound to the delivered turn, DM only, refused once tainted.
          registerMemoryRoutes(scope, core, perms);

          scope.post(
            "/agents/:id/status",
            {
              ...cellRoute,
              schema: {
                tags,
                security: bearer,
                params: IdParams,
                body: AgentChannelStatusReport,
                response: { 200: Agent },
              },
            },
            async (req) => {
              const cell = cellOf(req);
              const agent = await core.db.withTenant(
                { organizationId: cell.organizationId, userId: null },
                (tx) => applyCellStatus(core, tx, req.params.id, req.body.status, req.body.detail ?? null),
              );
              if (!agent) throw notFound("Agent not found in this cell", "agent_not_found");
              return agent;
            },
          );
        },
        { prefix: AGENT_CHANNEL_BASE_PATH },
      );

      registerCellGateway(app, core, auth, presence, perms);
    },
  };
}
