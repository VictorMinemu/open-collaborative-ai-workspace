// TEMP: replace with @ocw/contracts once merged
/**
 * Agent Channel API v1 — mirror of the canonical `packages/contracts/src/agent-channel.ts` and
 * `.planning/phases/01-mvp-0-multiplayer-ai-chat-slice/01-AGENT-CHANNEL-API.md`. The ONLY surface
 * the OpenClaw cell talks to (AGENTS principle 9).
 *
 * Base `${OCW_API_URL}/agent-channel/v1`, every request `Authorization: Bearer <cell token>`.
 *   GET  /cell                 → CellSnapshot (bots + provider credentials; keys are secrets)
 *   GET  /ws                   → WebSocket; client sends {op:"sub", topic:"cell:<cellId>", afterSeq?}
 *   POST /messages             ← AgentChannelPostMessage → AgentChannelPostMessageResponse
 *   POST /typing               ← AgentChannelTyping → {ok:true}
 *   POST /agents/:id/status    ← AgentChannelStatusReport (ready | error) after provisioning
 *   POST /runtime              ← AgentChannelRuntimeReport (why the cell runs without its channel; autostart-guard.ts)
 *   POST /provider-auth        ← AgentChannelProviderAuthReport (subscription sign-in progress)
 *   POST /tool-calls           ← AgentChannelToolCallRequest → AgentChannelToolCallDecision (tool gate)
 *   POST /tool-calls/:id/result ← AgentChannelToolCallResult (outcome only, never content)
 *   POST /memories             ← AgentChannelMemorySave → AgentChannelMemorySaveResponse (ocw_memory_save;
 *                                owner = the human of the delivered turn; 404/409 with the refusal code)
 *   POST /cards                ← AgentChannelPostCard → AgentChannelPostCardResponse (ocw_agent_card, 06-14)
 *   PATCH /cards/:messageId    ← AgentChannelPatchCard → AgentChannelPatchCardResponse (posting agent only,
 *                                optimistic version: 409 card_version_conflict)
 *   POST /board/read           ← AgentChannelBoardRead → AgentChannelBoardReadResponse (ocw_board_card, 07.1-13;
 *                                the turn's board, its columns and the card whose thread the turn runs in)
 *   POST /board/cards          ← AgentChannelBoardCreateCard → AgentChannelBoardCardResponse (201, 200 on a retry)
 *   PATCH /board/cards/:messageId ← AgentChannelBoardPatchCard → AgentChannelBoardCardResponse (move / waiting state
 *                                only, optimistic version: 409 board_card_version_conflict; never card text)
 *   POST /mcp/probe-results    ← AgentChannelMcpProbeResult (the tools an `mcp.probe` discovered; D-13)
 *   POST /plugins/report       ← AgentChannelPluginReport (a marketplace install / uninstall outcome; D-14)
 *   POST /plugins/verify-install, GET /plugins: used by infra/openclaw (install gate, boot render), not here
 *
 * Parsing is deliberately lenient on ids (any non-empty string) and ignores unknown fields, so the
 * API can add fields without breaking deployed cells; required fields are enforced.
 */
import { z } from "zod";

export const AGENT_CHANNEL_PROTOCOL_VERSION = 1;
export const AGENT_CHANNEL_BASE_PATH = "/agent-channel/v1";
export const AgentChannelEventTypes = {
  mention: "agent.mention.v1",
  configChanged: "cell.config.changed",
  providerAuthStart: "provider.auth.start",
  providerAuthCancel: "provider.auth.cancel",
  providerAuthRevoke: "provider.auth.revoke",
  /** Phase 3.1 (D-13): connect to one MCP server of the snapshot, list its tools, report them. */
  mcpProbe: "mcp.probe",
  /** Phase 3.1 (D-14): install an admin-approved, pinned marketplace plugin version. */
  pluginInstall: "plugin.install.v1",
  /** Phase 3.1 (D-14): remove a marketplace plugin from the cell. */
  pluginUninstall: "plugin.uninstall.v1",
  /** Phase 6 (AGENT-04, P-11): a reader approved or denied one of the agent's Agent Cards. */
  cardAction: "agent.card_action.v1",
} as const;
export const cellTopic = (cellId: string) => `cell:${cellId}`;

const Id = z.string().min(1);

export const AgentChannelAuthor = z.object({
  kind: z.enum(["user", "agent", "system"]),
  id: Id,
  displayName: z.string(),
});
export type AgentChannelAuthor = z.infer<typeof AgentChannelAuthor>;

export const AgentChannelRosterEntry = z.object({
  kind: z.enum(["user", "agent"]),
  id: Id,
  displayName: z.string(),
  role: z.string().optional(),
  handle: z.string().optional(),
});
export type AgentChannelRosterEntry = z.infer<typeof AgentChannelRosterEntry>;

export const AgentChannelHistoryEntry = z.object({
  id: Id,
  author: AgentChannelAuthor,
  text: z.string(),
  createdAt: z.string(),
});
export type AgentChannelHistoryEntry = z.infer<typeof AgentChannelHistoryEntry>;

/** Taint flags of one tool on this turn (D-08). */
export const TurnToolFlags = z.object({
  untrustedOutput: z.boolean(),
  sideEffecting: z.boolean(),
});
export type TurnToolFlags = z.infer<typeof TurnToolFlags>;

/** The asking human's local time (D-12). */
export const TurnNow = z.object({ iso: z.string(), timeZone: z.string(), local: z.string() });
export type TurnNow = z.infer<typeof TurnNow>;

export const TurnMemoryItem = z.object({ id: Id, text: z.string(), createdAt: z.string() });

/**
 * `agent.mention.v1.turn`: exactly what this bot may do for this human on this turn (decided by the API).
 * A mention without it runs with no tools (fail closed, `EMPTY_TURN`).
 */
/**
 * One tool the API did not offer on this turn of a shared AI chat, and why (06-10). Informational: the reason stays a
 * string so a newer API reason never invalidates the turn.
 */
export const TurnWithheld = z.object({ tool: z.string().max(200), reason: z.string().max(64) });
export type TurnWithheld = z.infer<typeof TurnWithheld>;

export const TurnContext = z.object({
  tools: z.array(z.string()),
  toolFlags: z.record(z.string(), TurnToolFlags).default({}),
  memory: z.array(TurnMemoryItem).default([]),
  now: TurnNow.nullable().default(null),
  maxToolCalls: z.number().int().nonnegative(),
  maxWebCalls: z.number().int().nonnegative(),
  /** AI chats only (06-10). Never enables a tool; an invalid list is dropped, the turn is kept. */
  withheld: z.array(TurnWithheld).max(64).optional().catch(undefined),
});
export type TurnContext = z.infer<typeof TurnContext>;

export const EMPTY_TURN: TurnContext = {
  tools: [],
  toolFlags: {},
  memory: [],
  now: null,
  maxToolCalls: 0,
  maxWebCalls: 0,
};

export const AgentMentionEvent = z.object({
  eventId: Id,
  seq: z.number().int().positive(),
  type: z.literal(AgentChannelEventTypes.mention),
  organizationId: Id,
  cellId: Id,
  agent: z.object({ id: Id, handle: z.string(), displayName: z.string() }),
  /**
   * `kind`: `channel`, `thread`, `dm`, `group` or `ai_chat` (06-10: a persona in a shared AI chat, answered flat like a
   * DM). Kept a string so a newer API never makes an older plugin drop the event.
   */
  conversation: z.object({ id: Id, kind: z.string(), name: z.string().nullable() }),
  /** Root = the mention itself when posted at channel level. Reply goes into this thread. */
  thread: z.object({ rootMessageId: Id }),
  message: z.object({
    id: Id,
    text: z.string(),
    createdAt: z.string(),
    author: AgentChannelAuthor,
    mentions: z.array(z.object({ kind: z.enum(["user", "agent"]), id: Id })),
  }),
  /** Oldest first, max 50, EXCLUDES the current message. */
  threadHistory: z.array(AgentChannelHistoryEntry),
  roster: z.array(AgentChannelRosterEntry),
  /** Additive (Phase 3.1). Absent → no tools on this turn. An invalid block also means no tools. */
  turn: TurnContext.optional().catch(undefined),
});
export type AgentMentionEvent = z.infer<typeof AgentMentionEvent>;

/**
 * `agent.card_action.v1` (06-13/06-14, P-11): built by the API like a mention of the agent on the card's message;
 * `message.text` is the server sentence "<actor> approved|denied “<title>”", `message.author` the deciding human and
 * `turn` is computed for that human. `cardAction.kind` stays a string so a newer card kind never drops the event.
 */
export const AgentCardActionEvent = AgentMentionEvent.omit({ type: true }).extend({
  type: z.literal(AgentChannelEventTypes.cardAction),
  cardAction: z.object({
    messageId: Id,
    kind: z.string().max(64),
    title: z.string().max(400),
    outcome: z.enum(["approved", "denied"]),
  }),
});
export type AgentCardActionEvent = z.infer<typeof AgentCardActionEvent>;

export const CellConfigChangedEvent = z.object({
  type: z.literal(AgentChannelEventTypes.configChanged),
  organizationId: Id,
  cellId: Id,
  reason: z.string(),
  agentId: Id.nullable(),
  seq: z.number().int().positive(),
});
export type CellConfigChangedEvent = z.infer<typeof CellConfigChangedEvent>;

/** Subscription providers whose sign-in runs in this cell (ChatGPT via Codex device code). */
export const SubscriptionProviderId = z.enum(["openai-codex"]);
export type SubscriptionProviderId = z.infer<typeof SubscriptionProviderId>;

/** Admin clicked Connect: run the provider's device-code sign-in here. */
export const ProviderAuthStartEvent = z.object({
  type: z.literal(AgentChannelEventTypes.providerAuthStart),
  seq: z.number().int().positive(),
  flowId: Id,
  provider: SubscriptionProviderId,
  method: z.literal("device-code"),
  /** Ignore the event when seen after this instant (replay after downtime). */
  startBefore: z.string(),
});
export type ProviderAuthStartEvent = z.infer<typeof ProviderAuthStartEvent>;

export const ProviderAuthCancelEvent = z.object({
  type: z.literal(AgentChannelEventTypes.providerAuthCancel),
  seq: z.number().int().positive(),
  flowId: Id,
  provider: SubscriptionProviderId,
});
export type ProviderAuthCancelEvent = z.infer<typeof ProviderAuthCancelEvent>;

export const ProviderAuthRevokeEvent = z.object({
  type: z.literal(AgentChannelEventTypes.providerAuthRevoke),
  seq: z.number().int().positive(),
  provider: SubscriptionProviderId,
});
export type ProviderAuthRevokeEvent = z.infer<typeof ProviderAuthRevokeEvent>;

export type ProviderAuthErrorCode =
  | "expired"
  | "denied"
  | "cancelled"
  | "cell_offline"
  | "unsupported"
  | "failed";

/** POST /provider-auth. Never tokens: only the one-time code the admin types, and identity. */
export type AgentChannelProviderAuthReport = {
  provider: SubscriptionProviderId;
  flowId: string | null;
  /** This plugin instance; the first reporter of a flow owns it (others get 409 flow_claimed). */
  reporterId: string;
  state: "pending" | "connected" | "error" | "disconnected";
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: string;
  account?: { email: string | null; planType: string | null };
  error?: { code: ProviderAuthErrorCode; message: string };
};

/** Plugin → server. `sub` without afterSeq starts LIVE (no replay). */
export type AgentChannelClientFrame = { op: "sub"; topic: string; afterSeq?: number } | { op: "ping" };

/** Server → plugin (browser envelope). */
export const AgentChannelServerFrame = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("ev"),
    topic: z.string(),
    seq: z.number().int().positive(),
    type: z.string(),
    data: z.unknown(),
  }),
  z.object({
    op: z.literal("subscribed"),
    topic: z.string(),
    lastSeq: z.number().int().nonnegative().optional(),
  }),
  z.object({ op: z.literal("resync"), topic: z.string() }),
  z.object({
    op: z.literal("err"),
    code: z.string(),
    topic: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({ op: z.literal("pong") }),
  z.object({ op: z.literal("eph") }).passthrough(),
]);
export type AgentChannelServerFrame = z.infer<typeof AgentChannelServerFrame>;

export const CellProvider = z.object({
  /** OpenClaw provider id used in `modelRef` (`anthropic`, `openai`, `openrouter`, `openai-compatible`, `fake`). */
  id: z.string().min(1),
  kind: z.string(),
  api: z.enum(["anthropic-messages", "openai-completions"]),
  baseUrl: z.string().min(1),
  /** SECRET. Never log; written to OpenClaw only as an env reference. */
  apiKey: z.string().nullable(),
  models: z.array(z.string()),
});
export type CellProvider = z.infer<typeof CellProvider>;

export const CellAgent = z.object({
  id: Id,
  handle: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  instructions: z.string().nullable().default(""),
  status: z.enum(["provisioning", "ready", "error", "disabled"]),
  /** `<provider id>/<model id>`, e.g. `anthropic/claude-sonnet-5-5`, `fake/mock-1`. */
  modelRef: z.string().min(3),
  model: z.object({ provider: z.string(), providerId: z.string(), id: z.string() }),
  updatedAt: z.string().optional(),
  /** Every tool this bot may use for some human (the agent's `alsoAllow`, D-08 layer 2). Absent → none. */
  capabilities: z.object({ tools: z.array(z.string()) }).optional(),
});
export type CellAgent = z.infer<typeof CellAgent>;

/** A connected subscription: credentials live in OpenClaw's auth store (signed in here), not in the snapshot. */
export const CellSubscription = z.object({
  /** Prefix of `modelRef`, e.g. `openai-codex/gpt-6-astra`. */
  id: z.string().min(1),
  kind: z.string(),
  /** OpenClaw provider that owns the sign-in and the catalog (`openai`). */
  runtimeProvider: z.string().min(1),
  models: z.array(z.string()),
  account: z.object({ email: z.string().nullable() }).optional(),
});
export type CellSubscription = z.infer<typeof CellSubscription>;

/**
 * An org-enabled MCP server as the cell renders it (`mcp.servers.<safeName>`, D-13). Header values are SECRETS:
 * never log them; they reach OpenClaw only as the env var `envName`, referenced as `${envName}` in the config.
 */
export const CellMcpServer = z.object({
  id: Id,
  safeName: z.string().min(1),
  transport: z.enum(["streamable-http", "sse"]),
  url: z.string().min(1),
  headers: z.array(z.object({ name: z.string().min(1), envName: z.string().min(1), value: z.string() })),
  /** Raw MCP tool names enabled on some bot: the server's `toolFilter.include`. */
  tools: z.array(z.string()),
});
export type CellMcpServer = z.infer<typeof CellMcpServer>;

/**
 * One marketplace plugin the API approved for this cell (D-14). The executor installs only an event that matches
 * one of these (row, package, version, sha256); the install gate asks the API again for every staged artifact.
 */
export const CellApprovedPlugin = z.object({
  pluginRowId: Id,
  packageName: z.string().min(1),
  version: z.string().min(1),
  sha256: z.string(),
  pluginId: z.string().nullable(),
  status: z.string(),
});
export type CellApprovedPlugin = z.infer<typeof CellApprovedPlugin>;

export const CellSnapshot = z.object({
  protocolVersion: z.number().int(),
  cellId: Id,
  organizationId: Id,
  topic: z.string().min(1),
  lastSeq: z.number().int().nonnegative(),
  agents: z.array(CellAgent),
  providers: z.array(CellProvider),
  /** Additive: absent on older APIs (then the plugin leaves stored sign-ins alone). */
  subscriptions: z.array(CellSubscription).optional(),
  /** The org's web search provider (D-09); absent on older APIs. */
  webSearch: z.object({ provider: z.string() }).optional(),
  /** The org's enabled MCP servers (D-13); absent on older APIs = none. */
  mcpServers: z.array(CellMcpServer).optional(),
  /** Approved marketplace plugins (D-14); absent on older APIs = none (every install event is refused). */
  plugins: z.array(CellApprovedPlugin).optional(),
});
export type CellSnapshot = z.infer<typeof CellSnapshot>;

export type AgentChannelPostMessage = {
  agentId: string;
  conversationId: string;
  threadRootMessageId: string | null;
  inReplyToMessageId?: string;
  /** The delivered turn this post answers (the event's `eventId`); the API refuses a post without one (403 `no_trigger`). */
  eventId?: string;
  /** Markdown, 1..20000 chars. */
  text: string;
  /** 1..200 chars; the server dedupes on (agentId, idempotencyKey). */
  idempotencyKey: string;
};

export const AgentChannelPostMessageResponse = z
  .object({
    messageId: Id,
    created: z.boolean().optional(),
    conversationId: Id.optional(),
    threadRootMessageId: Id.nullable().optional(),
  })
  .passthrough();
export type AgentChannelPostMessageResponse = z.infer<typeof AgentChannelPostMessageResponse>;

export type AgentChannelTyping = {
  agentId: string;
  conversationId: string;
  threadRootMessageId?: string | null;
  typing?: boolean;
};

export type AgentChannelStatusReport = { status: "ready" | "error"; detail?: string };

/** POST /runtime: the cell is up but its channel is paused (`null`: no longer paused). */
export type AgentChannelRuntimeReport = {
  paused: { reason: "restart_loop_breaker"; detail: string | null; resumeAt: string | null } | null;
};

/** POST /tool-calls: only the search query / fetched URL travel (for the domain audit), never other params. */
export type AgentChannelToolCallRequest = {
  eventId: string;
  agentId: string;
  tool: string;
  toolCallId?: string;
  params: { query?: string; url?: string };
  argsBytes?: number;
};

export const AgentChannelToolCallDecision = z.object({
  callId: Id,
  allowed: z.boolean(),
  reason: z.string().nullable().optional(),
});
export type AgentChannelToolCallDecision = z.infer<typeof AgentChannelToolCallDecision>;

/** POST /tool-calls/:callId/result: outcome only, never the result content. */
export type AgentChannelToolCallResult = {
  status: "ok" | "error" | "blocked";
  resultCount?: number;
  finalUrl?: string;
  provider?: string;
  durationMs: number;
};

/** POST /memories: the delivered turn, the bot and the note. The API binds the owner from the turn. */
export type AgentChannelMemorySave = { eventId: string; agentId: string; text: string };

export const AgentChannelMemorySaveResponse = z.object({ memoryId: z.string().min(1), created: z.boolean() });
export type AgentChannelMemorySaveResponse = z.infer<typeof AgentChannelMemorySaveResponse>;

// ---------------------------------------------------------------- Agent Cards (06-14, mirror of contracts/agent-cards.ts)

export const AGENT_CARD_TITLE_MAX = 200;
export const AGENT_CARD_FIELDS_MAX = 12;
export const AGENT_CARD_ACTIONS_MAX = 4;
export const AGENT_CARD_SUMMARY_MAX = 2_000;
const AGENT_CARD_ROUTE_MAX = 512;
export const AGENT_CARD_KINDS = [
  "work_zone",
  "approval",
  "report",
  "artifact",
  "automation",
  "deployment",
  "pr",
  "generic",
] as const;
export const AGENT_CARD_STATUSES = [
  "info",
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
/** The app areas an Open action may lead to (never an external URL). */
export const AGENT_CARD_ROUTE_PREFIXES = [
  "/chat",
  "/work-zone",
  "/bots",
  "/settings",
  "/search",
  "/share",
] as const;

function hasControlCharacter(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/** Same rule as `isAgentCardRoute` in packages/contracts/src/agent-cards.ts (parity test in card-tool.test.ts). */
export function isAgentCardRoute(v: string): boolean {
  if (v.length > AGENT_CARD_ROUTE_MAX || hasControlCharacter(v)) return false;
  if (v.includes("\\") || v.includes("//")) return false;
  const prefixed = AGENT_CARD_ROUTE_PREFIXES.some(
    (p) => v.startsWith(p) && (v.length === p.length || ["/", "?", "#"].includes(v.charAt(p.length))),
  );
  if (!prefixed) return false;
  const path = v.split(/[?#]/, 1)[0] ?? "";
  return path.split("/").every((segment) => {
    const s = segment.replace(/%2e/gi, ".");
    return s !== "." && s !== "..";
  });
}

export const AgentCardKind = z.enum(AGENT_CARD_KINDS);
export const AgentCardStatus = z.enum(AGENT_CARD_STATUSES);
export const AgentCardField = z.object({
  label: z.string().trim().min(1).max(60),
  value: z.string().trim().min(1).max(500),
});
const ActionLabel = z.string().trim().min(1).max(40);
export const AgentCardRoute = z
  .string()
  .max(AGENT_CARD_ROUTE_MAX)
  .refine(isAgentCardRoute, { message: "must be an internal app route" });
export const AgentCardAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open"), label: ActionLabel, target: AgentCardRoute }),
  z.object({ kind: z.literal("follow"), label: ActionLabel }),
  z.object({
    kind: z.literal("approve"),
    label: ActionLabel,
    denyLabel: ActionLabel.optional(),
    approverIds: z.array(Id).max(20).optional(),
  }),
]);
export const AgentCardTitle = z.string().trim().min(1).max(AGENT_CARD_TITLE_MAX);
export const AgentCardFields = z.array(AgentCardField).max(AGENT_CARD_FIELDS_MAX);
export const AgentCardSummary = z.string().trim().min(1).max(AGENT_CARD_SUMMARY_MAX);

/** What an agent posts; `summary` becomes the plain-text message body. */
export const AgentCardInput = z.object({
  kind: AgentCardKind,
  title: AgentCardTitle,
  fields: AgentCardFields,
  status: AgentCardStatus,
  actions: z
    .array(AgentCardAction)
    .max(AGENT_CARD_ACTIONS_MAX)
    .refine((actions) => new Set(actions.map((a) => a.kind)).size === actions.length, {
      message: "at most one action of each kind",
    }),
  summary: AgentCardSummary,
});
export type AgentCardInput = z.infer<typeof AgentCardInput>;

export type AgentCardPatch = {
  expectedVersion: number;
  status?: (typeof AGENT_CARD_STATUSES)[number];
  title?: string;
  fields?: Array<{ label: string; value: string }>;
  summary?: string;
};

/** POST /cards: where the card lands comes from the delivered turn, never from model output. */
export type AgentChannelPostCard = {
  agentId: string;
  conversationId: string;
  threadRootId: string | null;
  inReplyToMessageId?: string;
  /** The delivered turn posting the card (same trigger rule as `AgentChannelPostMessage.eventId`). */
  eventId?: string;
  /** 8..128 chars; the server dedupes on (agentId, `card:<key>`). */
  idempotencyKey: string;
  card: AgentCardInput;
};

export const AgentChannelPostCardResponse = z
  .object({ messageId: Id, created: z.boolean(), version: z.number().int() })
  .passthrough();
export type AgentChannelPostCardResponse = z.infer<typeof AgentChannelPostCardResponse>;

export type AgentChannelPatchCard = { agentId: string; patch: AgentCardPatch };

export const AgentChannelPatchCardResponse = z
  .object({ messageId: Id, version: z.number().int() })
  .passthrough();
export type AgentChannelPatchCardResponse = z.infer<typeof AgentChannelPatchCardResponse>;

// ---------------------------------------------------------------- Boards (07.1-13, mirror of the board schemas of
// contracts/agent-channel.ts and contracts/board.ts). The bodies name only the delivered turn and the agent: the board
// is always the turn's conversation and the acting human the turn's human (the API reads both from the stored turn).

export const BOARD_CARD_TITLE_MAX = 200;
export const BOARD_CARD_DESCRIPTION_MAX = 8_000;
export const BOARD_WAITING_ON = ["none", "us", "customer", "both"] as const;
export const BoardWaitingOn = z.enum(BOARD_WAITING_ON);
export type BoardWaitingOn = z.infer<typeof BoardWaitingOn>;

/** A board column. `category` stays a string so a newer API category never invalidates a read. */
export const AgentChannelBoardColumn = z
  .object({ id: Id, name: z.string(), category: z.string(), rank: z.string().optional() })
  .passthrough();
export type AgentChannelBoardColumn = z.infer<typeof AgentChannelBoardColumn>;

/** A card (the root message of its thread). `waitingOn` stays a string for the same reason. */
export const AgentChannelBoardCard = z
  .object({
    messageId: Id,
    columnId: Id,
    title: z.string(),
    waitingOn: z.string(),
    version: z.number().int(),
  })
  .passthrough();
export type AgentChannelBoardCard = z.infer<typeof AgentChannelBoardCard>;

export type AgentChannelBoardRead = { eventId: string; agentId: string };

export const AgentChannelBoardReadResponse = z
  .object({
    board: z.object({ conversationId: Id }).passthrough(),
    columns: z.array(AgentChannelBoardColumn),
    /** null when the turn is not in a card's thread. */
    card: AgentChannelBoardCard.nullable(),
  })
  .passthrough();
export type AgentChannelBoardReadResponse = z.infer<typeof AgentChannelBoardReadResponse>;

export type AgentChannelBoardCreateCard = {
  eventId: string;
  agentId: string;
  /** `<eventId>:board:<n>`, one `n` per tool call of the turn; the API stores it as `board:<key>`. */
  idempotencyKey: string;
  title?: string;
  description: string;
  columnId?: string;
  waitingOn?: BoardWaitingOn;
};

export type AgentChannelBoardPatchCard = {
  eventId: string;
  agentId: string;
  expectedVersion: number;
  move?: { columnId: string; afterCardId: string | null };
  waitingOn?: BoardWaitingOn;
};

export const AgentChannelBoardCardResponse = z.object({ card: AgentChannelBoardCard }).passthrough();
export type AgentChannelBoardCardResponse = z.infer<typeof AgentChannelBoardCardResponse>;

/** `mcp.probe`: an admin registered or changed an MCP server; the cell lists its tools (D-13). */
export const McpProbeEvent = z.object({
  type: z.literal(AgentChannelEventTypes.mcpProbe),
  seq: z.number().int().positive(),
  probeId: Id,
  serverId: Id,
});
export type McpProbeEvent = z.infer<typeof McpProbeEvent>;

/** One discovered MCP tool as reported (raw MCP name; the API derives the OpenClaw name itself). */
export type McpProbeTool = {
  name: string;
  title?: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};

/** POST /mcp/probe-results. `error` never carries a header value (≤ 300 chars); at most 200 tools. */
export type AgentChannelMcpProbeResult = {
  probeId: string;
  serverId: string;
  ok: boolean;
  error?: string;
  tools?: McpProbeTool[];
};

/** `plugin.install.v1` (D-14): download `artifactUrl` (configured ClawHub origin only), verify, install, report. */
export const PluginInstallEvent = z.object({
  type: z.literal(AgentChannelEventTypes.pluginInstall),
  seq: z.number().int().positive(),
  flowId: Id,
  pluginRowId: Id,
  packageName: z.string().min(1).max(214),
  version: z.string().min(1).max(64),
  artifactUrl: z.string().min(1).max(2000),
  sha256: z.string(),
  npmIntegrity: z.string().nullable().optional(),
  expectedPluginId: z.string().nullable(),
  mode: z.enum(["install", "update"]).default("install"),
});
export type PluginInstallEvent = z.infer<typeof PluginInstallEvent>;

/** `plugin.uninstall.v1` (D-14): remove the plugin; its tools were already taken off every bot by the API. */
export const PluginUninstallEvent = z.object({
  type: z.literal(AgentChannelEventTypes.pluginUninstall),
  seq: z.number().int().positive(),
  flowId: Id,
  pluginRowId: Id,
  pluginId: z.string().min(1).max(128),
});
export type PluginUninstallEvent = z.infer<typeof PluginUninstallEvent>;

/** What an installed plugin declares (its manifest and runtime registrations; untrusted, re-scored by the API). */
export type DeclaredSurface = {
  tools: string[];
  hooks: string[];
  channels: string[];
  providers: string[];
  webSearchProviders: string[];
  webFetchProviders: string[];
  mcpServers: string[];
  other: string[];
};

/** POST /plugins/report: one flow's outcome. `error.message` is a fixed classified text, never CLI output. */
export type AgentChannelPluginReport = {
  flowId: string;
  pluginRowId: string;
  state: "installing" | "installed" | "failed" | "uninstalled";
  pluginId?: string;
  version?: string;
  declared?: DeclaredSurface;
  declaredTools?: Array<{ name: string; description?: string }>;
  error?: { code: string; message: string };
};
