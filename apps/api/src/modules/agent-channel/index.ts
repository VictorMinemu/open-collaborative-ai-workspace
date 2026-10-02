import {
  AGENT_CHANNEL_BASE_PATH,
  AGENT_CHANNEL_PROTOCOL_VERSION,
  Agent,
  AgentCellStatus,
  AgentChannelPostMessage,
  AgentChannelPostMessageResponse,
  AgentChannelStatusReport,
  AgentChannelTyping,
  CellSnapshot,
  cellTopic,
  IdParams,
  Ok,
  RotateCellTokenResponse,
} from "@ocw/contracts";
import { agentCredentials, conversationMembers, conversations, messages, type Tx } from "@ocw/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { type ApiModule, type App, authOf, type Core, tenant } from "../../core";
import { randomToken, sha256Hex } from "../../lib/crypto";
import { badRequest, forbidden, HttpError, notFound } from "../../lib/errors";
import { applyCellStatus, cellAgents, cellProviders, findAgent } from "../agent";
import { cellOf, createCellAuth } from "./auth";
import { registerCellGateway } from "./gateway";
import { registerMentionHandler } from "./mentions";
import { createCellPresence } from "./presence";

export { buildMentionEvents } from "./mentions";

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];

/** Agent row usable by the cell, or the matching HTTP error. */
async function requireActiveAgent(tx: Tx, agentId: string) {
  const agent = await findAgent(tx, agentId);
  if (!agent) throw notFound("Agent not found in this cell", "agent_not_found");
  if (agent.status === "disabled") throw forbidden("This bot is disabled", "agent_disabled");
  return agent;
}

/** The agent must be a member of the conversation or of its parent channel (threads). */
async function requireMembership(tx: Tx, agentId: string, conversationId: string) {
  const [conv] = await tx.select().from(conversations).where(eq(conversations.id, conversationId));
  if (!conv) throw notFound("Conversation not found", "conversation_not_found");
  const scope = [conv.id, ...(conv.parentConversationId ? [conv.parentConversationId] : [])];
  const [m] = await tx
    .select({ id: conversationMembers.memberId })
    .from(conversationMembers)
    .where(
      and(
        inArray(conversationMembers.conversationId, scope),
        eq(conversationMembers.memberKind, "agent"),
        eq(conversationMembers.memberId, agentId),
      ),
    );
  if (!m) throw forbidden("The bot is not a member of this conversation", "not_a_member");
  return conv;
}

/**
 * agent-channel module — the Agent Channel API v1 consumed ONLY by the OpenClaw channel plugin (bearer cell
 * token, `/agent-channel/v1/*`), plus the admin cell controls under `/api/v1/agent-cell*` (cookie session).
 * Contract: `.planning/phases/01-mvp-0-multiplayer-ai-chat-slice/01-AGENT-CHANNEL-API.md`.
 */
export function createAgentChannelModule(core: Core): ApiModule {
  const auth = createCellAuth(core);
  const presence = createCellPresence(core);
  const admin = core.identity.requireRole("owner", "admin");
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
      // ================================================================ admin (cookie session, /api/v1)
      app.get(
        "/api/v1/agent-cell",
        { preHandler: admin, schema: { tags, response: { 200: AgentCellStatus } } },
        async (req) => {
          const created = await core.db.withTenant(tenant(req), uiTokenCreatedAt);
          return presence.status(authOf(req).organizationId, created);
        },
      );

      app.post(
        "/api/v1/agent-cell/token",
        { preHandler: admin, schema: { tags, response: { 200: RotateCellTokenResponse } } },
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
              clientKind: "web",
              metadata: { revoked: revoked.map((r) => r.id) },
            });
            // Shown once; only the SHA-256 is stored.
            return { token, createdAt: new Date(row.createdAt).toISOString() };
          }),
      );

      // ================================================================ Agent Channel API v1 (bearer)
      app.register(
        async (raw) => {
          // Child scopes lose the Zod type provider in their inferred type; restore it.
          const scope = raw as unknown as App;
          scope.addHook("onRequest", auth.requireCell);

          scope.get(
            "/cell",
            { schema: { tags, security: bearer, response: { 200: CellSnapshot } } },
            async (req, reply) => {
              const cell = cellOf(req);
              const snapshot = await core.db.withTenant(
                { organizationId: cell.organizationId, userId: null },
                async (tx) => {
                  const topic = cellTopic(cell.cellId);
                  const providers = await cellProviders(core, tx);
                  await core.audit.record(tx, {
                    action: "agent_cell.config_read",
                    resourceType: "agent_cell",
                    resourceId: cell.cellId,
                    actorKind: "system",
                    clientKind: "agent",
                    sessionId: `cell:${cell.credentialId}`,
                    // Which provider credentials were delivered; never the keys.
                    metadata: { providers: providers.map((p) => p.id), credential: cell.source },
                  });
                  return {
                    protocolVersion: AGENT_CHANNEL_PROTOCOL_VERSION,
                    cellId: cell.cellId,
                    organizationId: cell.organizationId,
                    topic,
                    lastSeq: await core.realtime.lastSeq(tx, topic),
                    agents: await cellAgents(tx),
                    providers,
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
                await requireActiveAgent(tx, body.agentId);
                const conv = await requireMembership(tx, body.agentId, body.conversationId);
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
                // Chat stores the message and audits `agent.message.posted` (actor = agent) in its own tx.
                // The tenant user is the triggering human, so that audit row carries user_id = who asked.
                result = await core.chatAgent.postAgentMessage(
                  { organizationId: cell.organizationId, userId: check.triggeredBy },
                  {
                    agentId: body.agentId,
                    conversationId: body.conversationId,
                    threadRootId: check.root,
                    body: body.text,
                    idempotencyKey: body.idempotencyKey,
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
            { schema: { tags, security: bearer, body: AgentChannelTyping, response: { 200: Ok } } },
            async (req) => {
              const cell = cellOf(req);
              const ctx = { organizationId: cell.organizationId, userId: null };
              const body = req.body;
              await core.db.withTenant(ctx, async (tx) => {
                await requireActiveAgent(tx, body.agentId);
                await requireMembership(tx, body.agentId, body.conversationId);
              });
              const root = body.threadRootMessageId ?? null;
              // Chat publishes the ephemeral `agent.typing`; clients clear it on the agent's message or
              // after a timeout, so `typing: false` needs no signal.
              if (body.typing) await core.chatAgent.agentTyping(ctx, body.agentId, body.conversationId, root);
              return { ok: true as const };
            },
          );

          scope.post(
            "/agents/:id/status",
            {
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

      registerCellGateway(app, core, auth, presence);
    },
  };
}
