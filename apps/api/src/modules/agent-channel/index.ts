import {
  AGENT_CHANNEL_BASE_PATH,
  AGENT_CHANNEL_PROTOCOL_VERSION,
  Agent,
  AgentCellStatus,
  AgentChannelPostMessage,
  AgentChannelPostMessageResponse,
  AgentChannelProviderAuthReport,
  AgentChannelRuntimeReport,
  AgentChannelStatusReport,
  AgentChannelTyping,
  CellSnapshot,
  cellTopic,
  IdParams,
  type ModelRef,
  Ok,
  ProviderAuthStatus,
  RotateCellTokenResponse,
  SubscriptionProviderParams,
} from "@ocw/contracts";
import { agentCredentials, conversationMembers, conversations, orgUnits, type Tx } from "@ocw/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { type ApiModule, type App, authOf, type Core, tenant } from "../../core";
import { randomToken, sha256Hex } from "../../lib/crypto";
import { HttpError, notFound } from "../../lib/errors";
import { applyCellStatus, cellAgents, cellProviders, cellSubscriptions, findAgent } from "../agent";
import { createObjectStorage, linkTurnAttachments } from "../artifact";
import type { AutomationFanOut, AutomationProposals } from "../automation";
import { cellAgentCapabilities, loadPolicy } from "../bot-capabilities";
import { cellMcpServers } from "../mcp";
import type { MemoryService } from "../memory";
import { channelResource, createPermissionService, type ResourceFacts } from "../organization";
import { cellApprovedPlugins } from "../plugins";
import type { SandboxdClient } from "../sandbox";
// Types only: the watched module reaches modules that import this one (a value import would be a cycle).
import type { RecordWrites } from "../watched";
import type { WorkSessionModule, WorkZoneProposalService } from "../work-session";
import { finishActivity } from "./activity";
import { registerAttachmentRoutes } from "./attachments";
import { cellOf, createCellAuth } from "./auth";
import { registerAutomationProposalRoutes } from "./automation-proposals";
import { registerBoardAgentRoutes } from "./board";
import { type BrowserBudgets, registerBrowserRoutes } from "./browser";
import {
  postForTurn,
  registerCardActionHandler,
  registerCardRoutes,
  replyTargetOrThrow,
  resolveReplyTarget,
} from "./cards";
import { registerChainUserRoutes } from "./chain-routes";
import { recordChainReply, registerChainCellRoutes } from "./chains";
import { registerConnectorRoutes } from "./connectors";
import { registerConsultRoutes } from "./consult";
import { registerConsultTick } from "./consult-tick";
import { registerConversationOpenRoute } from "./conversations-open";
import { registerCellGateway } from "./gateway";
import { registerHttpRequestRoutes } from "./http-requests";
import { registerMcpCellRoutes } from "./mcp";
import { registerMemoryRoutes } from "./memories";
import { registerMemoryFileRoutes } from "./memory-files";
import { registerMentionHandler } from "./mentions";
import { registerPluginCellRoutes } from "./plugins";
import { createCellPresence } from "./presence";
import { createProviderAuth } from "./provider-auth";
import { registerRecordRoutes } from "./records";
import { registerSandboxRoutes, type SandboxBudgets } from "./sandbox";
import { registerToolCallRoutes, type ToolApprovalGate } from "./tool-calls";
import { registerBotWorkSessionFileRoutes } from "./work-session-files";
import { registerWorkSessionReadRoute } from "./work-session-read";
import { registerWorkSessionWakes } from "./work-session-wakes";
import { registerBotWorkSessionRoutes } from "./work-sessions";
import { registerWorkZoneRoutes } from "./work-zone";

export { currentPhrase } from "./activity";
export { consultTargets, decideAgentMessage } from "./agent-message";
export {
  type DeliverAutomationItemDeps,
  type DeliverAutomationItemInput,
  type DeliverAutomationItemResult,
  deliverAutomationItem,
  requeueAfterSession,
  requeueAutomationItem,
  skipAutomationItem,
  waitAutomationItem,
  waitItemForTurn,
} from "./automation-items";
export {
  type DeliverAutomationRunInput,
  type DeliverAutomationRunResult,
  deliverAutomationRun,
  inboundRooted,
  lockRunAndAutomation,
  markRunAnswered,
  runAnchorTrigger,
  runSentence,
} from "./automation-runs";
export type { BrowserBudgets } from "./browser";
export { notifyCardFollowers, updatePlatformCardNotified } from "./card-followers";
export { emitCardAction } from "./cards";
export { cancelChain, deliverConsultReply, noAnswerSentence, recordChainReply } from "./chains";
export { CONSULT_SENTENCES, deliverConsultQuestion } from "./consult";
export { conversationAudience } from "./memory-files";
export { buildMentionEvents } from "./mentions";
export type { SandboxBudgets } from "./sandbox";

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
  // Unit-scoped rules apply to a unit's channels for bots too (CHAT-02, principle 6).
  const [unit] = channel.unitId
    ? await tx.select({ path: orgUnits.path }).from(orgUnits).where(eq(orgUnits.id, channel.unitId)).limit(1)
    : [];
  return channelResource({
    visibility: channel.visibility,
    archived: channel.archivedAt !== null,
    viewerRole: m?.role ?? null,
    unitPath: unit?.path ?? [],
  });
}

/**
 * agent-channel module — the Agent Channel API v1 consumed ONLY by the OpenClaw channel plugin (bearer cell
 * token, `/agent-channel/v1/*`), plus the admin cell controls under `/api/v1/agent-cell*` (cookie session).
 * Contract: `.planning/phases/01-mvp-0-multiplayer-ai-chat-slice/01-AGENT-CHANNEL-API.md`.
 */
export function createAgentChannelModule(
  core: Core,
  opts: {
    /** The chat model's display label (06-10: a persona's AI chat history names it "AI assistant (<model>)"). */
    modelLabel?: (ref: ModelRef) => string;
    /** Memory files (07.2-11): the memory routes, the legacy notes and the memory a turn carries. */
    memory: MemoryService;
    /** Work Zone proposals (07.5-08): the work-session module's service; absent = the two routes are not served. */
    workZone?: WorkZoneProposalService | null;
    /**
     * A bot's own Work Zone sessions (07.16-15, PD-03): the work-session module, whose `bots` start sessions in the bot's
     * sponsor's name; absent = the `/work-sessions/*` routes are not served.
     */
    workSession?: Pick<WorkSessionModule, "bots" | "botRead" | "botFiles"> | null;
    /**
     * Natural-language automations (07.6-12): the automation module's proposal entry point; absent = the
     * `/automations/propose` route is not served.
     */
    automations?: AutomationProposals | null;
    /**
     * Automation fan-out (07.17, PD-07): the automation module's open call; absent = the `/conversations/open` route is
     * not served.
     */
    fanOut?: AutomationFanOut | null;
    /**
     * Watched-record writes (07.6-14): the watched module's compare-and-set; absent = the `/records/update` route is not
     * served.
     */
    records?: RecordWrites | null;
    /**
     * Per-tool approvals (07.5-11, D-04): the tool-approval service's one decision, asked by every agent-action route
     * (`/tool-calls`, `/connectors/call`, `/http-requests`) inside its claim transaction.
     */
    toolApproval: ToolApprovalGate;
    /**
     * Bot sandboxes (07.8-05, D-02 (b)): the sandboxd client of the sandbox module, null when `OCW_SANDBOX_URL` is not
     * configured (every sandbox call then answers `service_unavailable` after its decision).
     */
    sandbox?: { client: SandboxdClient | null } | null;
    /** Test hook: shorter browser call deadlines (contracts BROWSER_TIMEOUTS_MS otherwise); never read from the environment. */
    browserBudgets?: BrowserBudgets;
    /** Test hook: shorter sandbox call budgets (contracts SANDBOX_TIMEOUTS_MS otherwise); never from the environment. */
    sandboxBudgets?: SandboxBudgets;
  },
): ApiModule {
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
  registerMentionHandler(core, { modelLabel: opts.modelLabel, memory: opts.memory });
  // Agent Cards (P-11): a reader's decision reaches the card's agent as `agent.card_action.v1`.
  registerCardActionHandler(core, { perms, modelLabel: opts.modelLabel, memory: opts.memory });
  // Consult timeouts (07.7-09, D-11): the one-minute `consult.tick` on 07.6's job runtime (workers start and stop with
  // `core.jobs`; no timer of our own).
  registerConsultTick(core, { perms, modelLabel: opts.modelLabel, memory: opts.memory });
  // Work Zone wakes (07.16-20, PD-16): a bot session's transitions refresh its card and wake the bot in its thread, as
  // the person who asked (`work_session.bot_sync`, ids only).
  registerWorkSessionWakes(core, { perms, modelLabel: opts.modelLabel, memory: opts.memory });

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
                  // MCP servers (D-13): header values are revealed only here, for this authenticated cell.
                  const mcpServers = await cellMcpServers(core, tx);
                  // Marketplace plugins (D-14): the approved tuples the cell's executor may act on.
                  const plugins = await cellApprovedPlugins(tx);
                  await core.audit.record(tx, {
                    action: "agent_cell.config_read",
                    resourceType: "agent_cell",
                    resourceId: cell.cellId,
                    actorKind: "system",
                    clientKind: "agent",
                    sessionId: `cell:${cell.credentialId}`,
                    // Which provider and MCP credentials were delivered; never the keys or header values.
                    metadata: {
                      providers: providers.map((p) => p.id),
                      subscriptions: subscriptions.map((p) => p.id),
                      mcpServers: mcpServers.map((s) => s.id),
                      plugins: plugins.map((p) => p.pluginRowId),
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
                    mcpServers,
                    plugins,
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

              // The post must answer a live turn of this bot here (403 `no_trigger`, audited, otherwise).
              const check = replyTargetOrThrow(
                await core.db.withTenant(ctx, (tx) =>
                  resolveReplyTarget(tx, core, body, {
                    route: "messages",
                    sessionId: `cell:${cell.credentialId}`,
                  }),
                ),
              );
              // The turn the post answers, as resolved above (its agent and conversation were checked).
              const turnEventId = body.eventId ?? null;

              let result: { messageId: string; created: boolean };
              try {
                // Chat decides the bot (agent principal: enabled, a member, agent rules) and the humans it
                // answers (agent ∩ human: the turn's human and a replied-to human must still read the channel),
                // then stores the message and audits `agent.message.posted` (actor = agent) in its own tx. The
                // tenant user is the turn's human, so that audit row carries user_id = who asked.
                // A run anchor's first reply also marks the run answered, in the post's transaction (07.6, P-03).
                result = await postForTurn(
                  core,
                  { organizationId: cell.organizationId, userId: check.onBehalfOf },
                  check,
                  {
                    agentId: body.agentId,
                    conversationId: body.conversationId,
                    threadRootId: check.root,
                    body: body.text,
                    idempotencyKey: body.idempotencyKey,
                    inReplyToMessageId: body.inReplyToMessageId,
                    onBehalfOfUserId: check.onBehalfOf,
                    // 07.8-10 (R2): the reply to a turn carries what the bot did in its sandbox (the activity, attached
                    // to the turn's first reply) and the files it shared in that turn, before `message.created`.
                    ...(turnEventId
                      ? {
                          onInserted: async (tx: Tx, messageId: string) => {
                            await finishActivity(tx, { eventId: turnEventId, replyMessageId: messageId });
                            // 07.7 (D-15, P-09): a chain turn's first post is its hop's answer at turn-done.
                            await recordChainReply(tx, { eventId: turnEventId, messageId });
                            await linkTurnAttachments(tx, {
                              eventId: turnEventId,
                              conversationId: body.conversationId,
                              uploaderAgentId: body.agentId,
                              messageId,
                            });
                          },
                        }
                      : {}),
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

          // Why the cell runs without its channel (e.g. OpenClaw's restart-loop breaker): shown to cell managers
          // instead of a bare "offline" until the cell's next connection.
          scope.post(
            "/runtime",
            {
              ...cellRoute,
              schema: { tags, security: bearer, body: AgentChannelRuntimeReport, response: { 200: Ok } },
            },
            async (req) => {
              await presence.reportRuntime(cellOf(req).organizationId, req.body.paused);
              return { ok: true as const };
            },
          );

          // Agent Cards (AGENT-04, P-11): typed cards posted and updated in place by their agent.
          registerCardRoutes(scope, { core });
          // Boards (07.1-10, D-07): read, create and move cards on the turn's board, for the turn's human.
          registerBoardAgentRoutes(scope, { core, perms });
          // The cell's tool gate (D-08): decision + caps + taint + audit for every gated tool call.
          registerToolCallRoutes(scope, core, perms, opts.toolApproval);
          // The keychain proxy (07.4-11, D-04): a request with a key by handle, injected towards allowed hosts only.
          registerHttpRequestRoutes(scope, core, perms, opts.toolApproval);
          // The connector proxy (07.4-12, D-02): a per-member connector's tool with the account of the person who asked.
          registerConnectorRoutes(scope, core, perms, opts.toolApproval);
          // The cell's memory tool (D-10): owner bound to the delivered turn, DM only, refused once tainted; since
          // 07.2-11 a bullet of the human's private MEMORY.md.
          registerMemoryRoutes(scope, core, perms, opts.memory);
          // Memory files (07.2-11, MEM-04): list, read, write own scopes, propose; agent ∩ human ∩ the audience.
          registerMemoryFileRoutes(scope, { core, perms, memory: opts.memory });
          // Work Zone proposals (07.5-08, D-03): the projects a turn's human may use, and a session proposed as a card.
          if (opts.workZone) registerWorkZoneRoutes(scope, core, opts.workZone);
          // A bot's own Work Zone sessions (07.16-15, D-05, PD-03): started in its sponsor's name, within its profile.
          if (opts.workSession) {
            // 07.16-19 (D-18): a tainted start without the profile's flag becomes a Work Zone proposal.
            registerBotWorkSessionRoutes(scope, core, opts.workSession, opts.workZone ?? null);
            // 07.17.1.1-12 (D-01, PD-06): the bot moves a thread attachment into the session it started there (13: back).
            registerBotWorkSessionFileRoutes(
              scope,
              core,
              opts.workSession,
              createObjectStorage(core.env, core.secretStore),
            );
            // 07.16-17 (PD-14, D-20): what the bot's own session did, bounded and redacted; the read marks the turn.
            registerWorkSessionReadRoute(scope, core, opts.workSession);
          }
          // Natural-language automations (07.6-12, D-02, D-03): a proposal card only the turn's person confirms.
          if (opts.automations) registerAutomationProposalRoutes(scope, core, opts.automations);
          // Automation fan-out (07.17, D-02, PD-07): a fan-out run opens one conversation per new item in its target.
          if (opts.fanOut) registerConversationOpenRoute(scope, core, opts.fanOut);
          // Agent-to-agent consults (07.7-04, D-07, D-08): a visible question in the turn's thread and a turn for the
          // consulted bot on behalf of the same human, under the canonical decision and the chain guards.
          registerConsultRoutes(scope, { core, perms, modelLabel: opts.modelLabel, memory: opts.memory });
          // The turn-done signal (07.7-06, P-09): the hop a turn answers closes, and the answer returns to the asker as
          // a new turn for the same human (`agent.consult_reply.v1`).
          registerChainCellRoutes(scope, { core, perms, modelLabel: opts.modelLabel, memory: opts.memory });
          // Watched-record writes (07.6-14, D-04, D-07): compare-and-set on the watched record of the turn's card thread,
          // governed like any side effect (taint, 07.5 approvals).
          if (opts.records) {
            registerRecordRoutes(scope, core, { toolApproval: opts.toolApproval, records: opts.records });
          }
          // Conversation files a bot reads (07.15-08, D-03, D-16, D-17): `ocw_attachment_read`, decided per call as the
          // turn's human, counted on the turn's attachment budget, tainting, audited without content.
          registerAttachmentRoutes(scope, core);
          // Bot sandboxes (07.8-05, D-02 (b), D-09): every `ocw_sandbox_*` call decided, approved, counted, capped and
          // audited by the API before sandboxd runs it.
          registerSandboxRoutes(scope, core, {
            perms,
            toolApproval: opts.toolApproval,
            client: opts.sandbox?.client ?? null,
            ...(opts.sandboxBudgets ? { budgets: opts.sandboxBudgets } : {}),
          });
          // Bot browsers (07.8-14, D-05, D-11, D-13): every `ocw_browser_*` call decided like a sandbox call (kind
          // `browser`), the signed-in approval floor, the D-13 cross-site approvals and the API's snapshot second pass.
          registerBrowserRoutes(scope, core, {
            perms,
            toolApproval: opts.toolApproval,
            client: opts.sandbox?.client ?? null,
            ...(opts.browserBudgets ? { budgets: opts.browserBudgets } : {}),
          });
          // The cell's MCP tool discovery (D-13): probe reports → the tool catalog.
          registerMcpCellRoutes(scope, core);
          // The cell's marketplace executor and install gate (D-14).
          registerPluginCellRoutes(scope, core);

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

      // Stop (07.7-06, P-14): the chain's human or a channel moderator stops an agent-to-agent chain.
      registerChainUserRoutes(app, core, perms);

      registerCellGateway(app, core, auth, presence, perms);
    },
  };
}
