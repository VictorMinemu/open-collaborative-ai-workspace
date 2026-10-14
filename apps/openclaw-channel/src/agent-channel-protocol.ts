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
 *   POST /memory/list|read|write|propose ← AgentChannelMemory{List,Read,Write,Propose} → 200 with the result or
 *                                `{refused: MemoryToolRefusal}` (ocw_memory_list|read|write|propose, 07.2; owner = the
 *                                human of the delivered turn, never a field)
 *   POST /cards                ← AgentChannelPostCard → AgentChannelPostCardResponse (ocw_agent_card, 06-14)
 *   PATCH /cards/:messageId    ← AgentChannelPatchCard → AgentChannelPatchCardResponse (posting agent only,
 *                                optimistic version: 409 card_version_conflict)
 *   POST /board/read           ← AgentChannelBoardRead → AgentChannelBoardReadResponse (ocw_board_card, 07.1-13;
 *                                the turn's board, its columns and the card whose thread the turn runs in)
 *   POST /board/cards          ← AgentChannelBoardCreateCard → AgentChannelBoardCardResponse (201, 200 on a retry)
 *   PATCH /board/cards/:messageId ← AgentChannelBoardPatchCard → AgentChannelBoardCardResponse (move / waiting state
 *                                only, optimistic version: 409 board_card_version_conflict; never card text)
 *   POST /connectors/list      ← AgentChannelConnectorList → AgentChannelConnectorListResponse (ocw_connector_list,
 *                                07.4: the turn's per-member connectors, their tools and the keychain handles)
 *   POST /connectors/call      ← AgentChannelConnectorCall → AgentChannelConnectorCallResponse (ocw_connector_call:
 *                                one logical `<connector>__<tool>` with the turn's human's own account; 404/409/502 with
 *                                an AgentChannelToolRefusal code)
 *   POST /http-requests        ← AgentChannelHttpRequest → AgentChannelHttpResponse (ocw_http_request: a keychain
 *                                handle, never a value; same refusals)
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
  /**
   * 07.5 (D-01): the tool has an approval policy for this bot and this human. The gate then sends the call's full
   * arguments and leaves the taint decision to the API. An unknown value reads as absent (no arguments travel; the API
   * refuses `policy_changed`), so a newer API never voids the whole turn.
   */
  approval: z.enum(["always", "when_tainted"]).optional().catch(undefined),
});
export type TurnToolFlags = z.infer<typeof TurnToolFlags>;

/** The asking human's local time (D-12). */
export const TurnNow = z.object({ iso: z.string(), timeZone: z.string(), local: z.string() });
export type TurnNow = z.infer<typeof TurnNow>;

export const TurnMemoryItem = z.object({ id: Id, text: z.string(), createdAt: z.string() });

// ---------------------------------------------------------------- memory files (07.2-07, mirror of contracts/memory.ts
// and the memory-file schemas of contracts/agent-channel.ts; parity tests in plugin-contract.test.ts). The plugin only
// pre-validates: the API decides every call (turn, tool, resolver agent ∩ human, audience, path rules) and binds the
// human to the stored turn, so no body carries an owner or user id (strict objects refuse one).

export const MEMORY_LIMITS = {
  fileBytes: 262_144,
  pathChars: 255,
  segmentChars: 64,
  depth: 8,
  turnFileBytes: 8_192,
  reasonChars: 280,
} as const;

export const MEMORY_SCOPE_KINDS = ["personal", "agent", "unit", "org"] as const;
export const MemoryScopeKind = z.enum(MEMORY_SCOPE_KINDS);

export const MEMORY_PATH_ERRORS = [
  "empty",
  "absolute",
  "backslash",
  "percent",
  "control",
  "dot_segment",
  "empty_segment",
  "trailing_slash",
  "segment_space",
  "segment_charset",
  "segment_length",
  "depth",
  "length",
  "extension",
] as const;
export type MemoryPathError = (typeof MEMORY_PATH_ERRORS)[number];
export type MemoryPathResult = { ok: true; path: string } | { ok: false; reason: MemoryPathError };
export type MemoryFolderResult =
  | { ok: true; folder: string }
  | { ok: false; reason: MemoryPathError | "missing_slash" };

const MEMORY_CONTROL = /[\p{Cc}\p{Cf}]/u;
const MEMORY_SEGMENT_CHARSET = /^[\p{L}\p{N} ._-]+$/u;
const MEMORY_DOTS_ONLY = /^\.+$/;
const codePoints = (s: string) => [...s].length;

function checkMemoryWhole(s: string): MemoryPathError | null {
  if (s.length === 0) return "empty";
  if (MEMORY_CONTROL.test(s)) return "control";
  if (s.startsWith("/")) return "absolute";
  if (s.includes("\\")) return "backslash";
  if (s.includes("%")) return "percent";
  return null;
}

function checkMemorySegments(segments: readonly string[]): MemoryPathError | null {
  for (const seg of segments) {
    if (seg.length === 0) return "empty_segment";
    if (MEMORY_DOTS_ONLY.test(seg)) return "dot_segment";
    if (seg.startsWith(" ") || seg.endsWith(" ")) return "segment_space";
    if (!MEMORY_SEGMENT_CHARSET.test(seg)) return "segment_charset";
    if (codePoints(seg) > MEMORY_LIMITS.segmentChars) return "segment_length";
  }
  return null;
}

/** Same rule as `parseMemoryPath` in packages/contracts/src/memory.ts: NFC, reject (never repair), first reason. */
export function parseMemoryPath(input: string): MemoryPathResult {
  const s = input.normalize("NFC");
  const whole = checkMemoryWhole(s);
  if (whole) return { ok: false, reason: whole };
  if (s.endsWith("/")) return { ok: false, reason: "trailing_slash" };
  const segments = s.split("/");
  const seg = checkMemorySegments(segments);
  if (seg) return { ok: false, reason: seg };
  if (segments.length > MEMORY_LIMITS.depth) return { ok: false, reason: "depth" };
  if (codePoints(s) > MEMORY_LIMITS.pathChars) return { ok: false, reason: "length" };
  const name = segments[segments.length - 1] ?? "";
  if (!name.endsWith(".md") || name.length <= ".md".length) return { ok: false, reason: "extension" };
  return { ok: true, path: s };
}

/** Same rule as `parseMemoryFolder` in packages/contracts/src/memory.ts: ends in `/`, at most 7 segments. */
export function parseMemoryFolder(input: string): MemoryFolderResult {
  const s = input.normalize("NFC");
  const whole = checkMemoryWhole(s);
  if (whole) return { ok: false, reason: whole };
  if (!s.endsWith("/")) return { ok: false, reason: "missing_slash" };
  const segments = s.slice(0, -1).split("/");
  const seg = checkMemorySegments(segments);
  if (seg) return { ok: false, reason: seg };
  if (segments.length > MEMORY_LIMITS.depth - 1) return { ok: false, reason: "depth" };
  if (codePoints(s) > MEMORY_LIMITS.pathChars) return { ok: false, reason: "length" };
  return { ok: true, folder: s };
}

function memoryPathSchema<R extends { ok: true } | { ok: false; reason: string }>(parse: (s: string) => R) {
  return z
    .string()
    .max(1024)
    .overwrite((s) => s.normalize("NFC"))
    .superRefine((s, ctx) => {
      const r = parse(s);
      if (!r.ok) ctx.addIssue({ code: "custom", message: (r as { reason: string }).reason });
    });
}

export const MemoryPath = memoryPathSchema(parseMemoryPath);
export const MemoryFolder = memoryPathSchema(parseMemoryFolder);

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;
export const MemoryContent = z.string().refine((s) => utf8Bytes(s) <= MEMORY_LIMITS.fileBytes, {
  message: "memory_file_too_large",
});

/** A scope id from `ocw_memory_list` (a UUID, as in contracts), or the turn's personal / the agent's own scope. */
export const MemoryToolScope = z.union([z.uuid(), z.literal("personal"), z.literal("agent")]);
export type MemoryToolScope = z.infer<typeof MemoryToolScope>;

export const MEMORY_TOOL_REFUSALS = [
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
] as const;
export const MemoryToolRefusal = z.enum(MEMORY_TOOL_REFUSALS);
export type MemoryToolRefusal = z.infer<typeof MemoryToolRefusal>;

export const MEMORY_PROPOSAL_OPS = ["create", "replace", "append"] as const;

/** POST /memory/list: no scope = the scopes the turn may read; a scope = its files (optionally under a folder). */
export const AgentChannelMemoryList = z.strictObject({
  eventId: Id,
  agentId: Id,
  scope: MemoryToolScope.optional(),
  folder: MemoryFolder.optional(),
});
export type AgentChannelMemoryList = z.infer<typeof AgentChannelMemoryList>;

/** POST /memory/read. */
export const AgentChannelMemoryRead = z.strictObject({
  eventId: Id,
  agentId: Id,
  scope: MemoryToolScope,
  path: MemoryPath,
});
export type AgentChannelMemoryRead = z.infer<typeof AgentChannelMemoryRead>;

/** POST /memory/write: the agent's own scopes only; `replace` names the version it read. */
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

/** POST /memory/propose: a change to a shared scope a person approves and the server applies. */
export const AgentChannelMemoryPropose = z.strictObject({
  eventId: Id,
  agentId: Id,
  scope: MemoryToolScope,
  path: MemoryPath,
  op: z.enum(MEMORY_PROPOSAL_OPS),
  content: MemoryContent,
  baseVersion: z.number().int().positive().optional(),
  reason: z.string().trim().min(1).max(MEMORY_LIMITS.reasonChars).optional(),
});
export type AgentChannelMemoryPropose = z.infer<typeof AgentChannelMemoryPropose>;

/**
 * Responses: a refusal (200 `{refused}`) or the result. The refusal stays a short string here so a newer API reason is
 * still read as a refusal (the tool answers a neutral sentence for it), never as an empty result.
 */
const MemoryToolRefused = z.strictObject({ refused: z.string().min(1).max(64) });

export const MemoryScopeView = z
  .object({ id: Id, kind: z.string(), label: z.string(), viewerCan: z.array(z.string()).default([]) })
  .passthrough();
export type MemoryScopeView = z.infer<typeof MemoryScopeView>;

export const MemoryFileMetaView = z
  .object({ path: z.string(), version: z.number().int(), bytes: z.number().int().nonnegative().optional() })
  .passthrough();
export type MemoryFileMetaView = z.infer<typeof MemoryFileMetaView>;

export const AgentChannelMemoryListResponse = z.union([
  MemoryToolRefused,
  z.object({ scopes: z.array(MemoryScopeView).optional(), files: z.array(MemoryFileMetaView).optional() }),
]);
export type AgentChannelMemoryListResponse = z.infer<typeof AgentChannelMemoryListResponse>;

export const AgentChannelMemoryReadResponse = z.union([
  MemoryToolRefused,
  z.object({ file: z.object({ path: z.string(), version: z.number().int(), content: z.string() }) }),
]);
export type AgentChannelMemoryReadResponse = z.infer<typeof AgentChannelMemoryReadResponse>;

export const AgentChannelMemoryWriteResponse = z.union([
  MemoryToolRefused,
  z.object({ fileId: Id, version: z.number().int() }),
]);
export type AgentChannelMemoryWriteResponse = z.infer<typeof AgentChannelMemoryWriteResponse>;

export const MemoryFindingView = z
  .object({ kind: z.string(), count: z.number().int().nonnegative() })
  .passthrough();

export const AgentChannelMemoryProposeResponse = z.union([
  MemoryToolRefused,
  z.object({
    approvalId: Id,
    findings: z.array(MemoryFindingView),
    readerCount: z.number().int().nonnegative(),
  }),
]);
export type AgentChannelMemoryProposeResponse = z.infer<typeof AgentChannelMemoryProposeResponse>;

/**
 * A `MEMORY.md` the API put into the turn (the personal one only in a one-human DM, the bot's own one), cut to 8 KiB
 * with `truncated` set. Same shape as `TurnMemoryFile` in packages/contracts/src/bot-capabilities.ts.
 */
export const TurnMemoryFile = z.object({
  scopeKind: MemoryScopeKind,
  scopeId: Id,
  path: MemoryPath,
  version: z.number().int().positive(),
  content: z.string().refine((s) => utf8Bytes(s) <= MEMORY_LIMITS.turnFileBytes, { message: "too large" }),
  truncated: z.boolean(),
});
export type TurnMemoryFile = z.infer<typeof TurnMemoryFile>;

/**
 * `agent.mention.v1.turn`: exactly what this bot may do for this human on this turn (decided by the API).
 * A mention without it runs with no tools (fail closed, `EMPTY_TURN`).
 */
/**
 * One tool the API did not offer on this turn of a shared AI chat, and why (06-10). Informational: the reason stays a
 * string so a newer API reason never invalidates the turn.
 */
export const TurnWithheld = z.object({
  tool: z.string().max(200),
  reason: z.string().max(64),
  /**
   * 07.4 (R7): the member account behind a `member_account` entry (`kind` "connector" | "vault_item"), so the persona can
   * link the share page. Informational: an invalid resource is dropped, the entry is kept.
   */
  resource: z
    .object({ kind: z.string().max(32), id: z.string().max(64), name: z.string().max(200) })
    .optional()
    .catch(undefined),
});
export type TurnWithheld = z.infer<typeof TurnWithheld>;

export const TurnContext = z.object({
  tools: z.array(z.string()),
  toolFlags: z.record(z.string(), TurnToolFlags).default({}),
  memory: z.array(TurnMemoryItem).default([]),
  now: TurnNow.nullable().default(null),
  maxToolCalls: z.number().int().nonnegative(),
  maxWebCalls: z.number().int().nonnegative(),
  /**
   * AI chats (06-10) and, for `member_account`, any delivery (07.4). Never enables a tool; an invalid list is dropped,
   * the turn is kept.
   */
  withheld: z.array(TurnWithheld).max(64).optional().catch(undefined),
  /**
   * 07.2: the turn's memory files (the personal `MEMORY.md` only in a one-human DM, the bot's notebook). Additive: an
   * older API sends none (the legacy `memory` notes apply); an invalid list is dropped, the turn is kept.
   */
  memoryFiles: z.array(TurnMemoryFile).max(2).optional().catch(undefined),
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

/**
 * POST /tool-calls: only the search query / fetched URL travel (for the domain audit), never other params; the full
 * `arguments` travel ONLY for a tool whose turn flags carry `approval` (07.5 D-01, serialized ≤ 32 KB).
 */
export type AgentChannelToolCallRequest = {
  eventId: string;
  agentId: string;
  tool: string;
  toolCallId?: string;
  params: { query?: string; url?: string };
  argsBytes?: number;
  arguments?: Record<string, unknown>;
};

/** 07.5: the approval a refused call waits on. The plugin tells the model who decides, never the arguments. */
export const AgentChannelToolCallApproval = z.object({
  id: Id,
  /** false when an identical pending request was reused (no new card). */
  created: z.boolean(),
  /** The approver label ("a lead of Sales"). */
  waitingFor: z.string().max(200),
  requesterName: z.string().max(120),
});
export type AgentChannelToolCallApproval = z.infer<typeof AgentChannelToolCallApproval>;

export const AgentChannelToolCallDecision = z.object({
  callId: Id,
  allowed: z.boolean(),
  reason: z.string().nullable().optional(),
  /** 07.5: with `approval_required` / `approval_pending`. A malformed one reads as absent (the sentence falls back). */
  approval: AgentChannelToolCallApproval.nullable().optional().catch(null),
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
  "/memory",
  // Phase 07.5: the approvals inbox and review (`/approvals/<id>`).
  "/approvals",
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

// ---------------------------------------------------------------- per-member connectors and keychain (Phase 07.4)

/*
 * `ocw_connector_list|call` and `ocw_http_request` (07.4 D-02, D-07): bound to a delivered turn like `ocw_memory_save`.
 * The member whose account is used is always the stored turn's human, never a field: the bodies carry the event and
 * the agent only. Mirror of `packages/contracts/src/agent-channel.ts` (07.4-01).
 */

/** Why a connector or keychain call was refused (the API's `error.code`; the model reads a fixed sentence per code). */
export const AGENT_CHANNEL_TOOL_REFUSALS = [
  "unknown_turn",
  "not_in_turn",
  "policy_changed",
  "cap_reached",
  "tainted",
  "member_account",
  "unit_audience",
  "not_connected",
  "needs_reconnect",
  "handle_not_allowed",
  "host_not_allowed",
  "egress_refused",
  "upstream_error",
  "timeout",
  // 07.5: every `ToolApprovalRefusal` (`policy_changed` is above).
  "approval_required",
  "approval_pending",
  "approval_denied",
  "approval_used",
  "arguments_too_large",
  "arguments_invalid",
  "too_many_pending",
] as const;
export const AgentChannelToolRefusal = z.enum(AGENT_CHANNEL_TOOL_REFUSALS);
export type AgentChannelToolRefusal = z.infer<typeof AgentChannelToolRefusal>;

/**
 * 07.5 (contracts `ToolApprovalRefusal`): why the API refused a call that needs, or had, a person's approval. Each is a
 * fixed sentence for the model (tool-guard.ts `APPROVAL_SENTENCES`), never the API's text.
 */
export const TOOL_APPROVAL_REFUSALS = [
  "approval_required",
  "approval_pending",
  "approval_denied",
  "approval_used",
  "arguments_too_large",
  "arguments_invalid",
  "too_many_pending",
  "policy_changed",
] as const;
export type ToolApprovalRefusal = (typeof TOOL_APPROVAL_REFUSALS)[number];

/** 07.5: the `details` of a 409 `approval_required` / `approval_pending` from `/connectors/call` and `/http-requests`. */
export const AgentChannelApprovalRefusalDetails = z.object({ approval: AgentChannelToolCallApproval });
export type AgentChannelApprovalRefusalDetails = z.infer<typeof AgentChannelApprovalRefusalDetails>;

/** The bounds of contracts `TOOL_APPROVAL_LIMITS` the cell uses. */
export const TOOL_APPROVAL_LIMITS = {
  /** Serialized arguments of one approvable call. */
  argumentsBytes: 32_768,
  /** Pending requests per (agent, requester). */
  pendingPerRequester: 5,
} as const;

/** An MCP server's immutable OpenClaw name: `m` + 8 hex characters. */
export const CONNECTOR_SAFE_NAME = /^m[0-9a-f]{8}$/u;
/** A logical connector tool `<connector>__<tool>` as a turn lists it. */
export const CONNECTOR_LOGICAL_TOOL = /^m[0-9a-f]{8}__\S/u;
/** A keychain handle: `k_` + 10 base32 characters (never the value). */
export const VAULT_HANDLE = /^k_[a-z2-7]{10}$/u;

/** Byte bounds of the connector tools (contracts `CONNECTOR_TOOL_LIMITS`). */
export const CONNECTOR_TOOL_LIMITS = {
  argumentsBytes: 32 * 1024,
  contentBytes: 32 * 1024,
  toolChars: 128,
} as const;

/** Bounds of `ocw_http_request` (contracts `HTTP_TOOL_LIMITS`). */
export const HTTP_TOOL_LIMITS = {
  urlChars: 2048,
  headers: 20,
  headerValueChars: 1024,
  requestBodyBytes: 64 * 1024,
  responseBodyBytes: 256 * 1024,
} as const;

export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
export type AgentChannelHttpMethod = (typeof HTTP_METHODS)[number];

/** `POST /connectors/list` */
export type AgentChannelConnectorList = { eventId: string; agentId: string };

export const AgentChannelConnectorTool = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  inputSchema: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type AgentChannelConnectorTool = z.infer<typeof AgentChannelConnectorTool>;

export const AgentChannelConnectorEntry = z.object({
  connector: z.string().regex(CONNECTOR_SAFE_NAME),
  name: z.string(),
  /** The asker's connection: `connected`, `not_connected` or `needs_reconnect` (a newer status stays a string). */
  status: z.string().max(64),
  tools: z.array(AgentChannelConnectorTool).default([]),
});
export type AgentChannelConnectorEntry = z.infer<typeof AgentChannelConnectorEntry>;

export const AgentVaultKey = z.object({
  handle: z.string().regex(VAULT_HANDLE),
  name: z.string(),
  allowedHosts: z.array(z.string()).default([]),
});
export type AgentVaultKey = z.infer<typeof AgentVaultKey>;

export const AgentChannelConnectorListResponse = z.object({
  connectors: z.array(AgentChannelConnectorEntry).default([]),
  keys: z.array(AgentVaultKey).default([]),
});
export type AgentChannelConnectorListResponse = z.infer<typeof AgentChannelConnectorListResponse>;

/** `POST /connectors/call`: one logical tool `<connector>__<tool>` of the turn. */
export type AgentChannelConnectorCall = {
  eventId: string;
  agentId: string;
  connector: string;
  tool: string;
  arguments: Record<string, unknown>;
};

/** Text for the model: untrusted output (it taints the turn), capped and redacted by the API. */
export const AgentChannelConnectorCallResponse = z.object({
  content: z.string(),
  truncated: z.boolean().default(false),
  isError: z.boolean().default(false),
});
export type AgentChannelConnectorCallResponse = z.infer<typeof AgentChannelConnectorCallResponse>;

/** `POST /http-requests`: one request with a keychain handle; the API injects the secret, never the cell. */
export type AgentChannelHttpRequest = {
  eventId: string;
  agentId: string;
  handle: string;
  method: AgentChannelHttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string;
};

/** Textual responses only, capped; a 3xx names its `Location` host only. */
export const AgentChannelHttpResponse = z.object({
  status: z.number().int().min(100).max(599),
  contentType: z.string().nullable().default(null),
  body: z.string(),
  truncated: z.boolean().default(false),
  redirectHost: z.string().nullable().default(null),
});
export type AgentChannelHttpResponse = z.infer<typeof AgentChannelHttpResponse>;
