import { z } from "zod";
import {
  AgentStatus,
  CellRuntimePause,
  ModelProviderKind,
  ProviderAuthErrorCode,
  SubscriptionProviderKind,
} from "./agent";
import { SearchProvider, TurnContext } from "./bot-capabilities";
import { ConversationKind, Mention, MessageBody } from "./chat";
import { Id, IsoDateTime, MemberKind, PrincipalKind } from "./common";
import { DeclaredSurface } from "./marketplace";
import { ServerFrame } from "./realtime";

/**
 * Agent Channel API v1 — the ONLY surface the OpenClaw channel plugin talks to (AGENTS principle 9).
 * Mounted at `/agent-channel/v1` (never under /api/v1, never cookies). Every request carries
 * `Authorization: Bearer <cell token>`. Full contract with examples:
 * `.planning/phases/01-mvp-0-multiplayer-ai-chat-slice/01-AGENT-CHANNEL-API.md`.
 *
 * Shapes follow 01-RESEARCH.md Addendum A §A2 exactly; fields beyond the addendum are additive.
 *
 * Routes: `GET /cell`, `GET /ws`, `POST /messages`, `POST /typing`, `POST /agents/:id/status`,
 * `POST /provider-auth`; Phase 3.1 adds `POST /tool-calls` and `POST /tool-calls/:callId/result` (the tool
 * gate, 03.1-04), `POST /memories` (memory saves, 03.1-07), the MCP probe result (`AgentChannelMcpProbeResult`,
 * route wired by 03.1-10) and the marketplace plugin report (`AgentChannelPluginReport`, route wired by 03.1-12).
 * `POST /runtime` (`AgentChannelRuntimeReport`) tells admins why a running cell has no channel connected.
 */

export const AGENT_CHANNEL_PROTOCOL_VERSION = 1;
export const AGENT_CHANNEL_BASE_PATH = "/agent-channel/v1";

/** Durable event types on the cell stream `cell:<cellId>`. */
export const AgentChannelEventTypes = {
  mention: "agent.mention.v1",
  configChanged: "cell.config.changed",
  /** Admin clicked "Connect": run the provider's device-code sign-in inside the cell. */
  providerAuthStart: "provider.auth.start",
  /** Admin cancelled a pending sign-in. */
  providerAuthCancel: "provider.auth.cancel",
  /** Admin disconnected the subscription: delete the cell's stored credentials for it. */
  providerAuthRevoke: "provider.auth.revoke",
  /** Phase 3.1 (D-13): discover an MCP server's tools from inside the cell and report them. */
  mcpProbe: "mcp.probe",
  /** Phase 3.1 (D-14): install (or update to) an admin-approved, pinned marketplace plugin version. */
  pluginInstall: "plugin.install.v1",
  /** Phase 3.1 (D-14): remove an installed marketplace plugin from the cell. */
  pluginUninstall: "plugin.uninstall.v1",
} as const;

const UUID_RE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
export const CellTopic = z.string().regex(new RegExp(`^cell:${UUID_RE}$`), "invalid cell topic");
export const cellTopic = (cellId: string) => `cell:${cellId}`;

// ---------------------------------------------------------------- inbound: agent.mention.v1 (A2.2)

/** Server-resolved identity. Never derived from message text. */
export const AgentChannelAuthor = z.object({
  kind: PrincipalKind,
  id: Id,
  displayName: z.string(),
});
export type AgentChannelAuthor = z.infer<typeof AgentChannelAuthor>;

export const AgentChannelRosterEntry = z.object({
  kind: MemberKind,
  id: Id,
  displayName: z.string(),
  /** Org role for users (`standard` | `developer` | `lead` | `admin`). */
  role: z.string().optional(),
  /** @handle for agents. */
  handle: z.string().optional(),
});
export type AgentChannelRosterEntry = z.infer<typeof AgentChannelRosterEntry>;

export const AgentChannelHistoryEntry = z.object({
  id: Id,
  author: AgentChannelAuthor,
  text: z.string(),
  createdAt: IsoDateTime,
});
export type AgentChannelHistoryEntry = z.infer<typeof AgentChannelHistoryEntry>;

export const AgentMentionEvent = z.object({
  eventId: Id,
  /** Seq of this event on `cell:<cellId>` (the plugin's resume cursor). */
  seq: z.number().int().positive(),
  type: z.literal(AgentChannelEventTypes.mention),
  organizationId: Id,
  cellId: Id,
  agent: z.object({ id: Id, handle: z.string(), displayName: z.string() }),
  conversation: z.object({ id: Id, kind: ConversationKind, name: z.string().nullable() }),
  /** Root = the mention itself when it was posted at channel level. Reply goes into this thread. */
  thread: z.object({ rootMessageId: Id }),
  message: z.object({
    id: Id,
    text: z.string(),
    createdAt: IsoDateTime,
    author: AgentChannelAuthor,
    mentions: z.array(Mention),
  }),
  /** Oldest first, newest last, max 50, EXCLUDES the current message. */
  threadHistory: z.array(AgentChannelHistoryEntry),
  roster: z.array(AgentChannelRosterEntry),
  /**
   * Additive (Phase 3.1, D-07): the effective tools, memory and time for THIS bot and THIS human, computed by
   * the API at delivery. Absent (older API) = no tools: the plugin fails closed.
   */
  turn: TurnContext.optional(),
});
export type AgentMentionEvent = z.infer<typeof AgentMentionEvent>;

export const CellConfigChangedEvent = z.object({
  type: z.literal(AgentChannelEventTypes.configChanged),
  organizationId: Id,
  cellId: Id,
  reason: z.enum([
    "agent.created",
    "agent.updated",
    "agent.disabled",
    "agent.enabled",
    "agent.deleted",
    "providers.updated",
    // Phase 3.1: org bot policy, one bot's capabilities, or the tool catalog (MCP servers, plugins) changed.
    "policy.updated",
    "agent.capabilities_updated",
    "tools.updated",
  ]),
  agentId: Id.nullable(),
  /** Seq of this event on `cell:<cellId>`. */
  seq: z.number().int().positive(),
});
export type CellConfigChangedEvent = z.infer<typeof CellConfigChangedEvent>;

// ---------------------------------------------------------------- subscription sign-in (additive, v1)
//
// Older plugins ignore these event types (unknown types are skipped), so the additions are backward
// compatible. The device code itself never travels on the stream: the cell reports it over
// `POST /provider-auth` and only admins can read it back from `/api/v1`.

export const ProviderAuthStartEvent = z.object({
  type: z.literal(AgentChannelEventTypes.providerAuthStart),
  organizationId: Id,
  cellId: Id,
  seq: z.number().int().positive(),
  flowId: Id,
  provider: SubscriptionProviderKind,
  method: z.literal("device-code"),
  /** A cell that sees this event after this instant (e.g. replay after downtime) must ignore it. */
  startBefore: IsoDateTime,
});
export type ProviderAuthStartEvent = z.infer<typeof ProviderAuthStartEvent>;

export const ProviderAuthCancelEvent = z.object({
  type: z.literal(AgentChannelEventTypes.providerAuthCancel),
  organizationId: Id,
  cellId: Id,
  seq: z.number().int().positive(),
  flowId: Id,
  provider: SubscriptionProviderKind,
});
export type ProviderAuthCancelEvent = z.infer<typeof ProviderAuthCancelEvent>;

export const ProviderAuthRevokeEvent = z.object({
  type: z.literal(AgentChannelEventTypes.providerAuthRevoke),
  organizationId: Id,
  cellId: Id,
  seq: z.number().int().positive(),
  provider: SubscriptionProviderKind,
});
export type ProviderAuthRevokeEvent = z.infer<typeof ProviderAuthRevokeEvent>;

/**
 * `POST /agent-channel/v1/provider-auth` — the cell reports progress of a sign-in flow, or (flowId null)
 * the state of the credentials it holds. Never tokens: only the code the admin must type, and identity.
 */
export const AgentChannelProviderAuthReport = z.object({
  provider: SubscriptionProviderKind,
  /** The flow being reported; null for an out-of-band credential state report. */
  flowId: Id.nullable(),
  /**
   * Random id of the reporting plugin instance. The first instance that reports on a flow owns it;
   * other instances (HA, plugin swap) get 409 `flow_claimed` and must abort their attempt.
   */
  reporterId: z.string().min(8).max(64),
  state: z.enum(["pending", "connected", "error", "disconnected"]),
  /** `pending` only. */
  verificationUrl: z.url().max(500).optional(),
  /** `pending` only. */
  userCode: z.string().min(4).max(32).optional(),
  /** `pending` only: when the code stops working. */
  expiresAt: IsoDateTime.optional(),
  /** `connected` only. */
  account: z
    .object({ email: z.string().max(320).nullable(), planType: z.string().max(64).nullable() })
    .optional(),
  /** `error` only. */
  error: z.object({ code: ProviderAuthErrorCode, message: z.string().max(300) }).optional(),
});
export type AgentChannelProviderAuthReport = z.infer<typeof AgentChannelProviderAuthReport>;

// ---------------------------------------------------------------- MCP probe (Phase 3.1, D-13, additive)

/**
 * Admin registered (or changed) an MCP server: the cell connects to it with the `/cell` snapshot's details,
 * lists its tools and reports them with `AgentChannelMcpProbeResult`. Only the latest probe of a server counts.
 */
export const McpProbeEvent = z.object({
  type: z.literal(AgentChannelEventTypes.mcpProbe),
  organizationId: Id,
  cellId: Id,
  seq: z.number().int().positive(),
  probeId: Id,
  serverId: Id,
});
export type McpProbeEvent = z.infer<typeof McpProbeEvent>;

/**
 * The cell's probe report. Tool metadata comes from a third-party server and is untrusted: names are
 * sanitised and re-checked against the dangerous list by the API; annotations can only make a tool safer to
 * chain when they say so explicitly (unknown = side-effecting). `error` must never contain header values (the
 * API redacts them again).
 */
export const AgentChannelMcpProbeResult = z.object({
  probeId: Id,
  serverId: Id,
  ok: z.boolean(),
  error: z.string().max(300).optional(),
  tools: z
    .array(
      z.object({
        name: z.string().min(1).max(128),
        title: z.string().max(200).optional(),
        description: z.string().max(1000).optional(),
        annotations: z
          .object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional() })
          .optional(),
      }),
    )
    .max(200)
    .optional(),
});
export type AgentChannelMcpProbeResult = z.infer<typeof AgentChannelMcpProbeResult>;

// ---------------------------------------------------------------- marketplace plugins (Phase 3.1, D-14, additive)

/**
 * An Organization Admin approved a pinned marketplace plugin version. The cell downloads `artifactUrl` (always on
 * the configured ClawHub origin), verifies `sha256` (and `npmIntegrity` when given) BEFORE installing, installs
 * through OpenClaw's install gate and reports with `AgentChannelPluginReport`. Older plugins skip the type.
 */
export const PluginInstallEvent = z.object({
  type: z.literal(AgentChannelEventTypes.pluginInstall),
  organizationId: Id,
  cellId: Id,
  seq: z.number().int().positive(),
  flowId: Id,
  pluginRowId: Id,
  packageName: z.string(),
  version: z.string(),
  artifactUrl: z.string(),
  sha256: z.string(),
  npmIntegrity: z.string().nullable(),
  /** ClawHub's `runtimeId`: the plugin id the install must produce. */
  expectedPluginId: z.string().nullable(),
  mode: z.enum(["install", "update"]),
});
export type PluginInstallEvent = z.infer<typeof PluginInstallEvent>;

/** Remove an installed plugin (its tools were already taken off every bot by the API). */
export const PluginUninstallEvent = z.object({
  type: z.literal(AgentChannelEventTypes.pluginUninstall),
  organizationId: Id,
  cellId: Id,
  seq: z.number().int().positive(),
  flowId: Id,
  pluginRowId: Id,
  pluginId: z.string(),
});
export type PluginUninstallEvent = z.infer<typeof PluginUninstallEvent>;

/** One approved plugin in `GET /cell` (the cell's install gate allows only these tuples). */
export const CellApprovedPlugin = z.object({
  pluginRowId: Id,
  packageName: z.string(),
  version: z.string(),
  sha256: z.string(),
  pluginId: z.string().nullable(),
  status: z.string(),
});
export type CellApprovedPlugin = z.infer<typeof CellApprovedPlugin>;

/**
 * `POST /agent-channel/v1/plugins/report` (03.1-12): progress of one install/uninstall flow. What the cell
 * inspected is untrusted: tool names are re-checked against the dangerous list by the API.
 */
export const AgentChannelPluginReport = z.object({
  flowId: Id,
  pluginRowId: Id,
  state: z.enum(["installing", "installed", "failed", "uninstalled"]),
  pluginId: z.string().max(128).optional(),
  version: z.string().max(64).optional(),
  declared: DeclaredSurface.optional(),
  declaredTools: z
    .array(z.object({ name: z.string().max(128), description: z.string().max(1000).optional() }))
    .max(100)
    .optional(),
  error: z.object({ code: z.string().max(64), message: z.string().max(300) }).optional(),
});
export type AgentChannelPluginReport = z.infer<typeof AgentChannelPluginReport>;

/**
 * `POST /agent-channel/v1/plugins/verify-install` (03.1-12): the cell's install gate (OpenClaw
 * `security.installPolicy` exec) asks the API whether exactly this staged artifact belongs to an admin-approved
 * install in flight. `sha256` is the hex digest the gate computed itself over the staged npm-pack archive; the API
 * approves only a row of this organization in status `installing` with the same package, version and digest.
 * Every other answer (and any error) blocks the install.
 */
export const AgentChannelPluginVerifyInstall = z.object({
  packageName: z.string().min(1).max(214),
  version: z.string().min(1).max(64),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type AgentChannelPluginVerifyInstall = z.infer<typeof AgentChannelPluginVerifyInstall>;

export const AgentChannelPluginVerifyInstallResponse = z.object({
  approved: z.boolean(),
  /** Why it was refused (`not_approved`, `version_mismatch`, `digest_mismatch`, `not_in_flight`); null when approved. */
  reason: z.string().nullable(),
});
export type AgentChannelPluginVerifyInstallResponse = z.infer<typeof AgentChannelPluginVerifyInstallResponse>;

/**
 * `GET /agent-channel/v1/plugins` (03.1-12): the organization's marketplace plugins as the cell boot needs them
 * (the entrypoint re-adds `installed` ids to the restrictive `plugins.allow`). No digests, no secrets.
 */
export const AgentChannelPluginList = z.object({
  plugins: z.array(
    z.object({
      pluginId: z.string(),
      packageName: z.string(),
      version: z.string(),
      status: z.enum(["installing", "installed", "uninstalling"]),
    }),
  ),
});
export type AgentChannelPluginList = z.infer<typeof AgentChannelPluginList>;

// ---------------------------------------------------------------- WebSocket frames (GET /ws)

/**
 * Plugin → server. `sub` without `afterSeq` starts LIVE (no replay) so a fresh plugin never re-answers old
 * mentions; pass the last processed seq to resume exactly once.
 */
export const AgentChannelClientFrame = z.discriminatedUnion("op", [
  z.object({ op: z.literal("sub"), topic: CellTopic, afterSeq: z.number().int().nonnegative().optional() }),
  z.object({ op: z.literal("ping") }),
]);
export type AgentChannelClientFrame = z.infer<typeof AgentChannelClientFrame>;

/** Server → plugin: the browser envelope (research Pattern 5). `ev.data` is an event object above. */
export const AgentChannelServerFrame = ServerFrame;
export type AgentChannelServerFrame = z.infer<typeof AgentChannelServerFrame>;

// ---------------------------------------------------------------- GET /cell

export const CellModelApi = z.enum(["anthropic-messages", "openai-completions"]);

/**
 * Model provider credentials for the cell. `apiKey` is decrypted on demand and sent ONLY over this
 * authenticated channel (documented trade-off in 01-AGENT-CHANNEL-API.md); it is never logged.
 */
export const CellProvider = z.object({
  /** OpenClaw provider id used in `modelRef` (`anthropic`, `openai`, `openrouter`, `openai-compatible`, `fake`). */
  id: z.string(),
  kind: ModelProviderKind,
  api: CellModelApi,
  baseUrl: z.string(),
  apiKey: z.string().nullable(),
  models: z.array(z.string()),
});
export type CellProvider = z.infer<typeof CellProvider>;

export const CellAgent = z.object({
  id: Id,
  handle: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  description: z.string().nullable(),
  instructions: z.string(),
  /** Reconcile only agents whose status is not `disabled`. */
  status: AgentStatus,
  /** `<provider id>/<model id>`, e.g. `anthropic/claude-sonnet-5-5`, `fake/mock-1`. */
  modelRef: z.string(),
  model: z.object({ provider: ModelProviderKind, providerId: z.string(), id: z.string() }),
  updatedAt: IsoDateTime,
  /**
   * Additive (Phase 3.1, D-08 layer 2): every tool this bot could use for some human (toggles ∩ policy ∩
   * configured ∩ grants ∩ not dangerous); the reconciler renders it as the agent's `alsoAllow`.
   */
  capabilities: z.object({ tools: z.array(z.string()) }).default({ tools: [] }),
});
export type CellAgent = z.infer<typeof CellAgent>;

/**
 * A connected subscription provider (credentials live in the cell's own auth store, never here). The
 * plugin maps `<id>/<model>` model refs to the runtime provider (`openai/<model>` for `openai-codex`)
 * and pins them to OpenClaw's embedded runtime.
 */
export const CellSubscription = z.object({
  /** Prefix of `modelRef` (`openai-codex`). */
  id: SubscriptionProviderKind,
  kind: SubscriptionProviderKind,
  /** OpenClaw provider id that owns the credential and the model catalog (`openai`). */
  runtimeProvider: z.string(),
  models: z.array(z.string()),
  /** Who the API believes is signed in (from the cell's own earlier report). */
  account: z.object({ email: z.string().nullable() }),
});
export type CellSubscription = z.infer<typeof CellSubscription>;

/**
 * An org-enabled MCP server as the cell must render it (`mcp.servers.<safeName>`, D-13). Header values are
 * revealed ONLY here, over the authenticated channel: the cell exports each as the env var `envName` and writes
 * `${envName}` into its config, never the literal value. A sandboxed stdio server arrives as `streamable-http`
 * on the sandbox sidecar's URL.
 */
export const CellMcpServer = z.object({
  id: Id,
  safeName: z.string(),
  transport: z.enum(["streamable-http", "sse"]),
  url: z.string(),
  headers: z.array(z.object({ name: z.string(), envName: z.string(), value: z.string() })),
  /** MCP tool names (not OpenClaw names) enabled on any bot: the server's `toolFilter.include`. */
  tools: z.array(z.string()),
});
export type CellMcpServer = z.infer<typeof CellMcpServer>;

export const CellSnapshot = z.object({
  protocolVersion: z.literal(AGENT_CHANNEL_PROTOCOL_VERSION),
  cellId: Id,
  organizationId: Id,
  topic: CellTopic,
  /** Current last seq of the cell stream; `sub` with this to go live without replay. */
  lastSeq: z.number().int().nonnegative(),
  agents: z.array(CellAgent),
  providers: z.array(CellProvider),
  /** Additive (older plugins ignore it): connected subscription providers. */
  subscriptions: z.array(CellSubscription).default([]),
  /** Additive (Phase 3.1, D-09): the org's web search provider (`tools.web.search.provider`). */
  webSearch: z.object({ provider: SearchProvider }).default({ provider: "duckduckgo" }),
  /** Additive (Phase 3.1, D-13): the org's enabled MCP servers. */
  mcpServers: z.array(CellMcpServer).default([]),
  /** Additive (Phase 3.1, D-14): approved marketplace plugins (wired into `GET /cell` by 03.1-12). */
  plugins: z.array(CellApprovedPlugin).default([]),
});
export type CellSnapshot = z.infer<typeof CellSnapshot>;

// ---------------------------------------------------------------- POST /messages, /typing, /agents/:id/status

export const AgentChannelPostMessage = z.object({
  agentId: Id,
  conversationId: Id,
  /** From `event.thread.rootMessageId`. */
  threadRootMessageId: Id.nullable(),
  /** From `event.message.id` (used for attribution: the triggering human). */
  inReplyToMessageId: Id.optional(),
  text: MessageBody,
  /** At-least-once delivery: the same key for the same agent never creates two messages. */
  idempotencyKey: z.string().min(1).max(200),
});
export type AgentChannelPostMessage = z.infer<typeof AgentChannelPostMessage>;

export const AgentChannelPostMessageResponse = z.object({
  messageId: Id,
  /** false when the idempotency key was already used (the original message id is returned). */
  created: z.boolean(),
  conversationId: Id,
  threadRootMessageId: Id.nullable(),
});
export type AgentChannelPostMessageResponse = z.infer<typeof AgentChannelPostMessageResponse>;

export const AgentChannelTyping = z.object({
  agentId: Id,
  conversationId: Id,
  threadRootMessageId: Id.nullable().optional(),
  typing: z.boolean().default(true),
});
export type AgentChannelTyping = z.infer<typeof AgentChannelTyping>;

export const AgentChannelStatusReport = z.object({
  status: z.enum(["ready", "error"]),
  /** Human-readable detail, shown to admins on error (max 500 chars, never secrets). */
  detail: z.string().max(500).optional(),
});
export type AgentChannelStatusReport = z.infer<typeof AgentChannelStatusReport>;

/**
 * `POST /agent-channel/v1/runtime`: the cell is up but its `ocw` channel is not running (`paused`), or no longer
 * paused (`null`). The cell's next event-stream connection clears a pause too, and a pause expires on its own.
 */
export const AgentChannelRuntimeReport = z.object({ paused: CellRuntimePause.nullable() });
export type AgentChannelRuntimeReport = z.infer<typeof AgentChannelRuntimeReport>;

// ---------------------------------------------------------------- tool gate and memory (Phase 3.1, additive)

/**
 * `POST /agent-channel/v1/tool-calls`: the cell's `before_tool_call` hook asks before every gated call. Only
 * the search query / fetched URL travel (for the domain audit), never other arguments; `argsBytes` = size.
 */
export const AgentChannelToolCallRequest = z.object({
  /** The delivery (`agent.mention.v1.eventId`) whose turn is running. */
  eventId: Id,
  agentId: Id,
  tool: z.string().min(1).max(64),
  toolCallId: z.string().max(200).optional(),
  params: z
    .object({ query: z.string().max(500).optional(), url: z.string().max(2000).optional() })
    .default({}),
  argsBytes: z.number().int().nonnegative().max(1_000_000).optional(),
});
export type AgentChannelToolCallRequest = z.infer<typeof AgentChannelToolCallRequest>;

export const AgentChannelToolCallDecision = z.object({
  callId: Id,
  allowed: z.boolean(),
  /** Why a call was refused (shown in the cell log and audit); null when allowed. */
  reason: z.string().max(200).nullable(),
});
export type AgentChannelToolCallDecision = z.infer<typeof AgentChannelToolCallDecision>;

/** `POST /agent-channel/v1/tool-calls/:callId/result`: outcome only, never the result content. */
export const AgentChannelToolCallResult = z.object({
  status: z.enum(["ok", "error", "blocked"]),
  resultCount: z.number().int().nonnegative().optional(),
  finalUrl: z.string().max(2000).optional(),
  provider: z.string().max(64).optional(),
  durationMs: z.number().int().nonnegative(),
});
export type AgentChannelToolCallResult = z.infer<typeof AgentChannelToolCallResult>;

/**
 * `POST /agent-channel/v1/memories` (the `ocw_memory_save` tool). The owner of the memory is the human of the
 * stored delivery `eventId`, never a tool parameter (D-10).
 */
export const AgentChannelMemorySave = z.object({
  eventId: Id,
  agentId: Id,
  text: z.string().trim().min(1).max(500),
});
export type AgentChannelMemorySave = z.infer<typeof AgentChannelMemorySave>;

export const AgentChannelMemorySaveResponse = z.object({ memoryId: Id, created: z.boolean() });
export type AgentChannelMemorySaveResponse = z.infer<typeof AgentChannelMemorySaveResponse>;
