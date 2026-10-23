import { z } from "zod";
import {
  AgentStatus,
  CellRuntimePause,
  ModelProviderKind,
  ProviderAuthErrorCode,
  SubscriptionProviderKind,
} from "./agent";
import { AgentCardInput, AgentCardKind, AgentCardPatch, BrowserHost } from "./agent-cards";
import { APPROVAL_NOTE_MAX, ApprovalNote } from "./approvals";
import {
  BOARD_CARD_DESCRIPTION_MAX,
  BOARD_MAX_COLUMNS,
  Board,
  BoardCard,
  BoardCardMove,
  BoardCardTitle,
  BoardColumn,
  WaitingOn,
} from "./board";
import { SearchProvider, TurnContext } from "./bot-capabilities";
import { ConversationKind, Mention, MessageBody } from "./chat";
import { Id, IsoDateTime, MemberKind, PrincipalKind } from "./common";
import { ConnectionStatus, jsonBytes } from "./connectors";
import { AgentVaultKey, VaultHandle } from "./keychain";
import { DeclaredSurface } from "./marketplace";
import { McpHeaderName } from "./mcp";
import {
  MEMORY_LIMITS,
  MemoryContent,
  MemoryFileMeta,
  MemoryFolder,
  MemoryPath,
  MemoryProposalOp,
  MemoryScope,
  SensitiveFinding,
} from "./memory";
import { ServerFrame } from "./realtime";
import { TOOL_APPROVAL_LIMITS } from "./tool-approvals";

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

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

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
  /** Phase 6 (AGENT-04, P-11): a reader decided one of this agent's Agent Cards. */
  cardAction: "agent.card_action.v1",
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

/**
 * Phase 6 (AGENT-04, P-11): a reader approved or denied one of the agent's cards. Built like a mention of the agent on
 * the card's message: `message.text` is the server sentence "<actor> approved|denied “<title>”" and `message.author` the
 * deciding human (server-resolved), `turn` is computed for that human. Older plugins skip the unknown type.
 */
export const AgentCardActionEvent = AgentMentionEvent.omit({ type: true }).extend({
  type: z.literal(AgentChannelEventTypes.cardAction),
  cardAction: z.object({
    messageId: Id,
    kind: AgentCardKind,
    title: z.string(),
    outcome: z.enum(["approved", "denied"]),
    /**
     * Phase 07.5 (P-06): who decided. For `grant` kinds the turn is delivered for the requester (`message.author`), so
     * the decider is named here and in the sentence.
     */
    decidedBy: z.object({ id: Id, displayName: z.string().max(200) }).optional(),
    /**
     * Phase 07.5 (D-02): an approved `tool.call` grant. Call `tool` once with exactly these canonical `arguments`
     * (RFC 8785, the cell's own call) before `useBy`; any other arguments are a new request.
     */
    grant: z
      .object({
        tool: z.string().min(1).max(128),
        arguments: z.string().refine((a) => utf8Bytes(a) <= TOOL_APPROVAL_LIMITS.argumentsBytes, {
          message: "arguments over 32 KB",
        }),
        useBy: IsoDateTime,
      })
      .optional(),
    /**
     * Phase 07.5 (07.5-11): the decider's own note (UI-SPEC R4) as a field, so the bot never parses it out of the
     * sentence (which still quotes it). Absent without a note.
     */
    note: ApprovalNote.optional(),
    /**
     * Phase 07.5 (07.5-11): an approved `server_apply` request that failed to apply carries the kind's result code (a
     * Work Zone Start: `device_offline`, `runtime_unavailable`, …), so the bot can tell its person what went wrong.
     */
    resultCode: z.string().max(64).optional(),
    /**
     * Phase 07.8 (07.8-21, D-07, UI-SPEC model-facing sentences): the outcome of a platform-owned sign-in card. The turn
     * is the requester's: `signed_in` (they signed in to `host` by hand and handed back; the page is ready) or `skipped`
     * (they chose "Not now"). The host only, never a cookie, a username or anything typed.
     */
    signIn: z
      .object({
        status: z.enum(["signed_in", "skipped"]),
        host: BrowserHost,
      })
      .optional(),
  }),
});
export type AgentCardActionEvent = z.infer<typeof AgentCardActionEvent>;

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
  /**
   * Additive (Phase 07.8, D-14): the ids of `models` that accept image input. The cell declares them
   * `input: ["text", "image"]`, so `ocw_browser_screenshot` is useful only to bots on these models (07.8-14 offers it
   * only there). Absent = every model is text only.
   */
  imageModels: z.array(z.string()).optional(),
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
  /**
   * The delivery being answered (`agent.mention.v1` / `agent.card_action.v1` `eventId`). Every post needs a live turn of
   * this agent in this conversation: this id, or (older cells) `inReplyToMessageId` naming the message the turn was
   * delivered for. Neither → 403 `no_trigger`. The turn's human must still read the conversation.
   */
  eventId: Id.optional(),
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

// ---------------------------------------------------------------- Agent Cards (Phase 6, AGENT-04, P-11, additive)

/**
 * `POST /agent-channel/v1/cards`: the agent posts a typed card where it may post a message (same rules as
 * `POST /messages`); `card.summary` becomes the plain-text message body. 201 when created, 200 on an idempotent retry.
 */
export const AgentChannelPostCard = z.object({
  agentId: Id,
  conversationId: Id,
  threadRootId: Id.nullable(),
  inReplyToMessageId: Id.optional(),
  /** The delivery whose turn posts the card (same trigger rule as `AgentChannelPostMessage.eventId`). */
  eventId: Id.optional(),
  idempotencyKey: z.string().min(8).max(128),
  card: AgentCardInput,
});
export type AgentChannelPostCard = z.infer<typeof AgentChannelPostCard>;

export const AgentChannelPostCardResponse = z.object({
  messageId: Id,
  created: z.boolean(),
  version: z.number().int(),
});
export type AgentChannelPostCardResponse = z.infer<typeof AgentChannelPostCardResponse>;

/** `PATCH /agent-channel/v1/cards/:messageId`: only the posting agent, naming the version it saw. */
export const AgentChannelPatchCard = z.object({ agentId: Id, patch: AgentCardPatch });
export type AgentChannelPatchCard = z.infer<typeof AgentChannelPatchCard>;

export const AgentChannelPatchCardResponse = z.object({ messageId: Id, version: z.number().int() });
export type AgentChannelPatchCardResponse = z.infer<typeof AgentChannelPatchCardResponse>;

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
  /**
   * Phase 07.5 (D-01): the model's full arguments, sent ONLY for a tool whose delivered `turn.toolFlags[tool].approval`
   * is set (the API decides an approval on exactly these); serialized ≤ 32 KB. Discarded unread when no policy applies.
   */
  arguments: z
    .record(z.string(), z.unknown())
    .refine((v) => jsonBytes(v) <= TOOL_APPROVAL_LIMITS.argumentsBytes, { message: "arguments over 32 KB" })
    .optional(),
});
export type AgentChannelToolCallRequest = z.infer<typeof AgentChannelToolCallRequest>;

/** The approval a refused call waits on (Phase 07.5): the plugin tells the model who decides, never the arguments. */
export const AgentChannelToolCallApproval = z.object({
  id: Id,
  /** false when an identical pending request was reused (no new card). */
  created: z.boolean(),
  /** The approver label ("a lead of Sales"). */
  waitingFor: z.string().max(200),
  requesterName: z.string().max(120),
});
export type AgentChannelToolCallApproval = z.infer<typeof AgentChannelToolCallApproval>;

/**
 * Who said no to exactly this action in the last 24 h (Phase 07.5, `approval_denied`): the decider's display name
 * ("An approver" once they left) and their own note, so the bot can tell its person. Never an id, an email or arguments.
 */
export const AgentChannelApprovalDenial = z.object({
  deciderName: z.string().max(200),
  note: z.string().max(APPROVAL_NOTE_MAX).nullable(),
});
export type AgentChannelApprovalDenial = z.infer<typeof AgentChannelApprovalDenial>;

export const AgentChannelToolCallDecision = z.object({
  callId: Id,
  allowed: z.boolean(),
  /** Why a call was refused (shown in the cell log and audit); null when allowed. */
  reason: z.string().max(200).nullable(),
  /** Phase 07.5: set with `approval_required` / `approval_pending`; absent from older APIs. */
  approval: AgentChannelToolCallApproval.nullable().optional(),
  /** Phase 07.5: set with `approval_denied` (who decided and their note); absent otherwise and from older APIs. */
  denial: AgentChannelApprovalDenial.nullable().optional(),
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

// ---------------------------------------------------------------- memory files (Phase 07.2, D-02, additive)

/*
 * The `ocw_memory_list|read|write|propose` tools, bound to a delivered turn like `ocw_memory_save`. The human the agent
 * acts for is ALWAYS the stored turn's user (`agent_turns.user_id`), never a field: these bodies are strict objects, so
 * a model-supplied `userId` or `ownerUserId` is refused, not ignored. Every route re-decides the turn, the tool, the
 * resolver (agent ∩ human), the audience of the conversation and the path rules.
 */

/** A scope id from `ocw_memory_list`, or the aliases of the turn's personal scope and the agent's own scope. */
export const MemoryToolScope = z.union([Id, z.literal("personal"), z.literal("agent")]);
export type MemoryToolScope = z.infer<typeof MemoryToolScope>;

/** Why a memory tool call was refused (the model reads it; never the decision details). */
export const MemoryToolRefusal = z.enum([
  "unknown_turn",
  "not_in_turn",
  "memory_off",
  "tainted",
  "cap_reached",
  "dm_only",
  "not_found",
  "denied",
  "audience_too_wide",
  "own_scope_only",
  "shared_scope_only",
  "version_conflict",
  "secret_detected",
  "path_invalid",
  "scope_full",
  "too_large",
  "too_many_pending",
]);
export type MemoryToolRefusal = z.infer<typeof MemoryToolRefusal>;

const MemoryToolRefused = z.strictObject({ refused: MemoryToolRefusal });

/** `POST /agent-channel/v1/memory/list`: no scope = the scopes the turn may read; a scope = its files' metadata. */
export const AgentChannelMemoryList = z.strictObject({
  eventId: Id,
  agentId: Id,
  scope: MemoryToolScope.optional(),
  folder: MemoryFolder.optional(),
});
export type AgentChannelMemoryList = z.infer<typeof AgentChannelMemoryList>;

export const AgentChannelMemoryListResponse = z.union([
  MemoryToolRefused,
  // Strict: every key is optional, so an unknown `refused` value must not parse as an empty result.
  z.strictObject({ scopes: z.array(MemoryScope).optional(), files: z.array(MemoryFileMeta).optional() }),
]);
export type AgentChannelMemoryListResponse = z.infer<typeof AgentChannelMemoryListResponse>;

/** `POST /agent-channel/v1/memory/read`. */
export const AgentChannelMemoryRead = z.strictObject({
  eventId: Id,
  agentId: Id,
  scope: MemoryToolScope,
  path: MemoryPath,
});
export type AgentChannelMemoryRead = z.infer<typeof AgentChannelMemoryRead>;

export const AgentChannelMemoryReadResponse = z.union([
  MemoryToolRefused,
  z.object({
    file: z.object({ path: MemoryPath, version: z.number().int().positive(), content: z.string() }),
  }),
]);
export type AgentChannelMemoryReadResponse = z.infer<typeof AgentChannelMemoryReadResponse>;

/**
 * `POST /agent-channel/v1/memory/write`: only the agent's own scopes (the turn's personal scope in a 1-human DM, the
 * agent scope of a personal bot). `replace` of an existing file names the version it read (`version_conflict`
 * otherwise); `append` adds to the end under a lock.
 */
export const AgentChannelMemoryWrite = z.strictObject({
  eventId: Id,
  agentId: Id,
  scope: z.enum(["personal", "agent"]),
  path: MemoryPath,
  mode: z.enum(["replace", "append"]),
  content: MemoryContent,
  expectedVersion: z.number().int().positive().optional(),
});
export type AgentChannelMemoryWrite = z.infer<typeof AgentChannelMemoryWrite>;

export const AgentChannelMemoryWriteResponse = z.union([
  MemoryToolRefused,
  z.object({ fileId: Id, version: z.number().int().positive() }),
]);
export type AgentChannelMemoryWriteResponse = z.infer<typeof AgentChannelMemoryWriteResponse>;

/** `POST /agent-channel/v1/memory/propose`: a change to a shared scope that a person approves and the server applies. */
export const AgentChannelMemoryPropose = z.strictObject({
  eventId: Id,
  agentId: Id,
  scope: MemoryToolScope,
  path: MemoryPath,
  op: MemoryProposalOp,
  content: MemoryContent,
  baseVersion: z.number().int().positive().optional(),
  /** The bot's note to the approver. */
  reason: z.string().trim().min(1).max(MEMORY_LIMITS.reasonChars).optional(),
});
export type AgentChannelMemoryPropose = z.infer<typeof AgentChannelMemoryPropose>;

export const AgentChannelMemoryProposeResponse = z.union([
  MemoryToolRefused,
  z.object({
    approvalId: Id,
    findings: z.array(SensitiveFinding),
    readerCount: z.number().int().nonnegative(),
  }),
]);
export type AgentChannelMemoryProposeResponse = z.infer<typeof AgentChannelMemoryProposeResponse>;

// ---------------------------------------------------------------- boards (Phase 07.1, D-07, P-03, additive)

/*
 * The `ocw_board_card` tool. Bound to a delivered turn like `ocw_memory_save`: the body names only the delivery
 * (`eventId`) and the agent. The board is always the turn's conversation and the acting human the turn's human, both
 * read from the stored turn, never from these bodies (unknown keys such as `conversationId` are stripped). Agents create
 * cards and change their column or waiting state; they never edit card text (P-03).
 */

/** `POST /agent-channel/v1/board/read`: the turn's board, its columns and the card whose thread the turn runs in. */
export const AgentChannelBoardRead = z.object({ eventId: Id, agentId: Id });
export type AgentChannelBoardRead = z.infer<typeof AgentChannelBoardRead>;

export const AgentChannelBoardReadResponse = z.object({
  board: Board,
  columns: z.array(BoardColumn).max(BOARD_MAX_COLUMNS),
  /** null when the turn is not in a card's thread. */
  card: BoardCard.nullable(),
});
export type AgentChannelBoardReadResponse = z.infer<typeof AgentChannelBoardReadResponse>;

/** `POST /agent-channel/v1/board/cards`: a new card in the turn's board. 201 created, 200 on an idempotent retry. */
export const AgentChannelBoardCreateCard = z
  .object({
    eventId: Id,
    agentId: Id,
    /** At-least-once delivery: the same key for the same agent never creates two cards. */
    idempotencyKey: z.string().min(1).max(120),
    title: BoardCardTitle.optional(),
    description: z.string().trim().max(BOARD_CARD_DESCRIPTION_MAX).default(""),
    columnId: Id.optional(),
    waitingOn: WaitingOn.optional(),
  })
  .refine((v) => (v.title?.length ?? 0) > 0 || v.description.length > 0, {
    message: "Give the card a title or a description",
    path: ["description"],
  });
export type AgentChannelBoardCreateCard = z.infer<typeof AgentChannelBoardCreateCard>;

/** `PATCH /agent-channel/v1/board/cards/:messageId`: move a card or set its waiting state, naming the version seen. */
export const AgentChannelBoardPatchCard = z
  .object({
    eventId: Id,
    agentId: Id,
    expectedVersion: z.number().int().min(1),
    move: BoardCardMove.optional(),
    waitingOn: WaitingOn.optional(),
  })
  .refine((v) => v.move !== undefined || v.waitingOn !== undefined, {
    message: "Move the card or set its waiting state",
  });
export type AgentChannelBoardPatchCard = z.infer<typeof AgentChannelBoardPatchCard>;

export const AgentChannelBoardCardResponse = z.object({ card: BoardCard });
export type AgentChannelBoardCardResponse = z.infer<typeof AgentChannelBoardCardResponse>;

// ---------------------------------------------------------------- per-member connectors and keychain (Phase 07.4)

/*
 * The `ocw_connector_list|call` and `ocw_http_request` tools (07.4 D-02, D-04, D-07), bound to a delivered turn like
 * `ocw_memory_save`. The member whose credential is used is ALWAYS the stored turn's human (`agent_turns.user_id`),
 * never a field: unknown keys such as `userId` are stripped. Every route re-decides the turn, the logical tool, the
 * resolver (agent ∩ human), the audience rule (D-03) and the caps and taint, then calls out with the API's egress guard.
 */

/** Why a connector or keychain tool call was refused (the model reads it; never the decision details). */
export const AgentChannelToolRefusal = z.enum([
  "unknown_turn",
  "not_in_turn",
  "policy_changed",
  "cap_reached",
  "tainted",
  "member_account",
  /** A unit's key where someone outside that unit reads the conversation (07.4-12, WINDOWS #191). */
  "unit_audience",
  "not_connected",
  "needs_reconnect",
  "handle_not_allowed",
  "host_not_allowed",
  "egress_refused",
  "upstream_error",
  "timeout",
  // Phase 07.5: every `ToolApprovalRefusal` (`policy_changed` is above).
  "approval_required",
  "approval_pending",
  "approval_denied",
  "approval_used",
  "arguments_too_large",
  "arguments_invalid",
  "too_many_pending",
]);
export type AgentChannelToolRefusal = z.infer<typeof AgentChannelToolRefusal>;

/**
 * Phase 07.5: the `details` of a 409 approval refusal from `/connectors/call` and `/http-requests`: the approval waited
 * on (`approval_required` / `approval_pending`) or who denied exactly this action (`approval_denied`, 07.5-11).
 */
export const AgentChannelApprovalRefusalDetails = z.object({
  approval: AgentChannelToolCallApproval.optional(),
  denial: AgentChannelApprovalDenial.optional(),
});
export type AgentChannelApprovalRefusalDetails = z.infer<typeof AgentChannelApprovalRefusalDetails>;

/** An MCP server's immutable OpenClaw name: `m` + 8 hex characters (`apps/api/src/modules/mcp/names.ts`). */
export const ConnectorSafeName = z.string().regex(/^m[0-9a-f]{8}$/, "invalid connector name");
export type ConnectorSafeName = z.infer<typeof ConnectorSafeName>;

/** Byte bounds of the connector tools (T-07.4-01-04). */
export const CONNECTOR_TOOL_LIMITS = {
  argumentsBytes: 32 * 1024,
  contentBytes: 32 * 1024,
  descriptionChars: 1024,
  connectors: 32,
  toolsPerConnector: 64,
  keys: 32,
} as const;

/** `POST /agent-channel/v1/connectors/list`: the turn's per-member connectors, their tools and the turn's keys. */
export const AgentChannelConnectorList = z.object({ eventId: Id, agentId: Id });
export type AgentChannelConnectorList = z.infer<typeof AgentChannelConnectorList>;

export const AgentChannelConnectorTool = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(CONNECTOR_TOOL_LIMITS.descriptionChars),
  inputSchema: z.record(z.string(), z.unknown()).nullable(),
});
export type AgentChannelConnectorTool = z.infer<typeof AgentChannelConnectorTool>;

export const AgentChannelConnectorEntry = z.object({
  /** The safe name `ocw_connector_call` takes. */
  connector: ConnectorSafeName,
  name: z.string(),
  /** The asker's connection: `not_connected` / `needs_reconnect` tools answer with that refusal. */
  status: ConnectionStatus,
  tools: z.array(AgentChannelConnectorTool).max(CONNECTOR_TOOL_LIMITS.toolsPerConnector),
});
export type AgentChannelConnectorEntry = z.infer<typeof AgentChannelConnectorEntry>;

export const AgentChannelConnectorListResponse = z.object({
  connectors: z.array(AgentChannelConnectorEntry).max(CONNECTOR_TOOL_LIMITS.connectors),
  /** Keychain handles the turn's bot may use with `ocw_http_request`: never a value. */
  keys: z.array(AgentVaultKey).max(CONNECTOR_TOOL_LIMITS.keys).default([]),
});
export type AgentChannelConnectorListResponse = z.infer<typeof AgentChannelConnectorListResponse>;

/** `POST /agent-channel/v1/connectors/call`: one logical tool `<connector>__<tool>` of the turn, with the asker's account. */
export const AgentChannelConnectorCall = z.object({
  eventId: Id,
  agentId: Id,
  connector: ConnectorSafeName,
  tool: z.string().min(1).max(128),
  arguments: z
    .record(z.string(), z.unknown())
    .refine((v) => jsonBytes(v) <= CONNECTOR_TOOL_LIMITS.argumentsBytes, { message: "arguments over 32 KB" })
    .default({}),
});
export type AgentChannelConnectorCall = z.infer<typeof AgentChannelConnectorCall>;

/** Text content for the model (untrusted output: it taints the turn), capped, with the credential redacted. */
export const AgentChannelConnectorCallResponse = z.object({
  content: z
    .string()
    .refine((c) => new TextEncoder().encode(c).length <= CONNECTOR_TOOL_LIMITS.contentBytes, {
      message: "content over 32 KB",
    }),
  truncated: z.boolean(),
  isError: z.boolean(),
});
export type AgentChannelConnectorCallResponse = z.infer<typeof AgentChannelConnectorCallResponse>;

export const AgentChannelHttpMethod = z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
export type AgentChannelHttpMethod = z.infer<typeof AgentChannelHttpMethod>;

/** Byte bounds of `ocw_http_request` (T-07.4-01-04). */
export const HTTP_TOOL_LIMITS = {
  urlChars: 2048,
  headers: 20,
  headerValueChars: 1024,
  requestBodyBytes: 64 * 1024,
  responseBodyBytes: 256 * 1024,
} as const;

/**
 * `POST /agent-channel/v1/http-requests`: one request with a keychain handle. The API injects the secret only when the
 * handle is usable on this turn and the URL's host is allowed; it drops model headers that could carry or replace
 * credentials, never follows redirects and redacts the secret from the response.
 */
export const AgentChannelHttpRequest = z.object({
  eventId: Id,
  agentId: Id,
  handle: VaultHandle,
  method: AgentChannelHttpMethod,
  url: z
    .string()
    .max(HTTP_TOOL_LIMITS.urlChars)
    .refine(
      (u) => {
        try {
          const p = new URL(u).protocol;
          return p === "https:" || p === "http:";
        } catch {
          return false;
        }
      },
      { message: "an http(s) URL" },
    ),
  headers: z
    .record(McpHeaderName, z.string().max(HTTP_TOOL_LIMITS.headerValueChars))
    .refine((h) => Object.keys(h).length <= HTTP_TOOL_LIMITS.headers, { message: "at most 20 headers" })
    .optional(),
  body: z
    .string()
    .refine((b) => utf8Bytes(b) <= HTTP_TOOL_LIMITS.requestBodyBytes, { message: "body over 64 KB" })
    .optional(),
});
export type AgentChannelHttpRequest = z.infer<typeof AgentChannelHttpRequest>;

/** Textual responses only, capped; a 3xx names its `Location` host only (no path or query that could echo a secret). */
export const AgentChannelHttpResponse = z.object({
  status: z.number().int().min(100).max(599),
  contentType: z.string().max(200).nullable(),
  body: z
    .string()
    .refine((b) => utf8Bytes(b) <= HTTP_TOOL_LIMITS.responseBodyBytes, { message: "body over 256 KB" }),
  truncated: z.boolean(),
  redirectHost: z.string().max(253).nullable(),
});
export type AgentChannelHttpResponse = z.infer<typeof AgentChannelHttpResponse>;
