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
 *   POST /work-zone/projects   ← AgentChannelWorkZoneProjects → AgentChannelWorkZoneProjectsResponse
 *                                (ocw_work_zone_projects, 07.5: the projects the turn's human may start a session on)
 *   POST /work-zone/proposals  ← AgentChannelWorkZonePropose → `{approvalId, created}` or 200 `{refused}`
 *                                (ocw_start_work_zone, 07.5: a proposal the turn's human starts; never a mode)
 *   POST /automations/propose  ← AgentChannelAutomationPropose → `{ok, approvalId?|code?, sentence}` (ocw_automation_propose,
 *                                07.6: a scheduled automation as a card its person confirms; a refusal may come with a
 *                                4xx status and the same body)
 *   POST /records/update       ← AgentChannelRecordUpdate → `{ok, code, sentence}` (ocw_record_update, 07.6: compare-and-set
 *                                on the watched record of the turn's card; 409 `record_changed` with the same body)
 *   POST /consultations        ← AgentChannelConsultRequest → `{ok, chainId?, hopId?, questionMessageId?, code?, sentence}`
 *                                (ocw_consult_agent, 07.7: a question to another bot, posted in the turn's thread; the
 *                                answer arrives later as `agent.consult_reply.v1`; a refusal may come with a 4xx status
 *                                and the same body)
 *   POST /turns/:eventId/done  ← AgentChannelTurnDone (07.7: a turn that can belong to a consult chain ended; replied |
 *                                failed; idempotent server side)
 *   POST /attachments/read     ← AgentChannelAttachmentRead → AgentChannelAttachmentReadResponse (ocw_attachment_read,
 *                                07.15: one file of the turn's conversation as text, an image or a refusal with its
 *                                sentence; always 200 except 403 `no_trigger` when the turn ended)
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
  /**
   * Phase 07.6 (D-03): an automation run, built like a mention on the run's anchor message (author = the run-as human,
   * text = a server sentence), plus the standing order and, for webhook and mail runs, the outside content apart.
   */
  automationRun: "agent.automation_run.v1",
  /**
   * Phase 07.7 (D-01, ADR-0027): a consulted bot answered, failed or timed out, delivered to the bot that asked as a new
   * turn in the hop's thread (built like a mention; `consultReply` says who answered and how).
   */
  consultReply: "agent.consult_reply.v1",
  /**
   * Phase 07.16 (D-09, PD-16): a Work Zone session this bot started finished a turn, waits for an approval, failed,
   * ended or went offline, delivered as a new turn in the thread of its live card (`workSession` says which and how).
   */
  workSession: "agent.work_session.v1",
  /**
   * Phase 07.17 (D-04, PD-09): a fan-out run opened a conversation for a new item, delivered as a turn in its thread
   * (`automationItem` carries the item as outside content and the escalation targets).
   */
  automationItem: "agent.automation_item.v1",
  /**
   * Phase 07.17.1.1.2 (D-02, D-03): the next turn of the bot's own task, delivered by the API in the task's thread
   * (built like a mention on the task card; `task` says why it came).
   */
  task: "agent.task.v1",
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

// ---------------------------------------------------------------- agent-to-agent consults (07.7, mirror of contracts
// agent-chains.ts and agent-channel.ts; parity: plugin-contract.test.ts)

/** The contracts' A2A limits the cell checks or bounds locally (`A2A_MAX_DEPTH`, `A2A_QUESTION_MAX`, `A2A_MAX_TARGETS`). */
export const A2A_LIMITS = { maxDepth: 2, questionMax: 4000, maxTargets: 20 } as const;
export const CONSULT_MODES = ["consult", "handoff"] as const;
export const ConsultMode = z.enum(CONSULT_MODES);
export type ConsultMode = z.infer<typeof ConsultMode>;

/** A bot this turn may consult (decided by the API: a member of the conversation the `agent.message` decision allows). */
export const ConsultTarget = z.object({
  id: Id,
  handle: z.string().min(1).max(64),
  displayName: z.string().min(1).max(120),
  description: z.string().max(200).nullable(),
});
export type ConsultTarget = z.infer<typeof ConsultTarget>;

/** `TurnContext.consult`: the bots this turn may consult and its depth in its chain (0 = a root turn). */
export const TurnConsult = z.object({
  chainId: Id.nullable(),
  depth: z.number().int().nonnegative(),
  targets: z.array(ConsultTarget).min(1).max(A2A_LIMITS.maxTargets),
});
export type TurnConsult = z.infer<typeof TurnConsult>;

// ---------------------------------------------------------------- turn attachments (07.15, mirror of contracts
// bot-capabilities.ts; parity: plugin-contract.test.ts)

/** `image`, `text` (always returned as text, never rendered), `pdf` or `other` (sandbox import only). */
export const TurnAttachmentKind = z.enum(["image", "text", "pdf", "other"]);
export type TurnAttachmentKind = z.infer<typeof TurnAttachmentKind>;
/** Decided by the API per bot: `read` (`ocw_attachment_read`), `import` (`ocw_sandbox_import` only) or `none`. */
export const TurnAttachmentAccess = z.enum(["read", "import", "none"]);
export type TurnAttachmentAccess = z.infer<typeof TurnAttachmentAccess>;

/** The contracts' fixed notes (D-04); the API sends one of them as `TurnAttachment.note`. */
export const TURN_ATTACHMENT_NOTES = {
  modelNoImages: "This bot's model can't see images.",
  cannotReadImport: "Can't be read as text; copy it into the sandbox with ocw_sandbox_import.",
  cannotReadNoSandbox: "Can't be read as text, and this bot has no sandbox here.",
  cannotReadNarrower:
    "Can't be read as text, and this bot's sandbox is shared more widely than this conversation, so it can't be copied there.",
  tooLarge: "Too large to read.",
  readNotOffered: "Can't be read on this turn: it already has the most tools a turn can offer.",
} as const;

/**
 * One attachment of the messages the turn reads: metadata only (never content, a URL, a storage key or a path). The
 * plugin labels `name` again before the model sees it.
 */
export const TurnAttachment = z.object({
  id: Id,
  messageId: Id,
  name: z.string().max(255),
  mediaType: z.string().max(127),
  size: z.number().int().nonnegative(),
  kind: TurnAttachmentKind,
  access: TurnAttachmentAccess,
  note: z.string().max(200).optional(),
});
export type TurnAttachment = z.infer<typeof TurnAttachment>;

/** The contracts' `ATTACHMENT_READ_LIMITS` (characters = UTF-16 code units); the guard's local read budget reads it. */
export const ATTACHMENT_READ_LIMITS = {
  listPerTurn: 20,
  readsPerTurn: 20,
  charsPerTurn: 200_000,
  charsPerFile: 64_000,
} as const;

// ---------------------------------------------------------------- bot Work Zone sessions (07.16, mirror of contracts
// bot-work-zone.ts, bot-capabilities.ts and agent-channel.ts; parity: plugin-contract.test.ts)

/** The contracts' `BOT_WORK_ZONE_LIMITS`; the tools check the prompt bound locally, the API re-validates everything. */
export const BOT_WORK_ZONE_LIMITS = {
  projectsMax: 50,
  turnProjects: 20,
  allowedValuesMax: 20,
  maxConcurrentDefault: 2,
  maxConcurrentMax: 10,
  promptsPerHourDefault: 30,
  promptsPerHourMax: 120,
  wakesPerSessionDayDefault: 20,
  wakesPerSessionDayMax: 100,
  orgSessionsDefault: 10,
  orgSessionsMax: 1000,
  promptChars: 50_000,
  readOutputChars: 6_000,
  readTools: 10,
  readFiles: 50,
  readApprovals: 10,
  readApprovalPaths: 10,
  readMine: 20,
  deciders: 3,
  summaryChars: 500,
  errorChars: 500,
  toolSummaryChars: 200,
  turnSessions: 10,
} as const;

/** Contracts `RuntimeId`, `PermissionMode`, `WorkSessionStatus`, `EffortLevel` and `ContextWindow`. */
export const WorkZoneRuntimeId = z.enum(["claude-code", "codex"]);
export const WorkZonePermissionMode = z.enum(["default", "acceptEdits", "plan", "auto", "fullAccess"]);
export type WorkZonePermissionMode = z.infer<typeof WorkZonePermissionMode>;
export const WorkSessionStatus = z.enum([
  "provisioning",
  "idle",
  "running",
  "waiting_approval",
  "host_offline",
  "completed",
  "failed",
  "archived",
]);
export type WorkSessionStatus = z.infer<typeof WorkSessionStatus>;
const WorkZoneEffort = z.string().trim().min(1).max(32);
const WorkZoneContextWindow = z.number().int().min(1000).max(10_000_000);
const WorkZoneName = z.string().max(200);

/** `off`: never; `allowed`: the bot may turn fast mode on; `on`: on by default. */
export const BotFastMode = z.enum(["off", "allowed", "on"]);
export type BotFastMode = z.infer<typeof BotFastMode>;

/** Contracts `BotFileLimitSource` and `BotFileLimit` (07.17.1.1 D-07): the per-file limit and the level that set it. */
export const BotFileLimitSource = z.enum(["bot", "organization", "server"]);
export type BotFileLimitSource = z.infer<typeof BotFileLimitSource>;
export const BotFileLimit = z.object({ bytes: z.number().int().positive(), source: BotFileLimitSource });
export type BotFileLimit = z.infer<typeof BotFileLimit>;

/**
 * `TurnContext.workZone` (07.16 D-05, PD-17): what this bot may do in the Work Zone on this turn, from its active
 * profile. Names and ids only (never a host path, a token or a user).
 */
export const TurnWorkZone = z.object({
  runtime: WorkZoneRuntimeId,
  device: z.object({ id: Id, name: z.string().max(120), online: z.boolean() }),
  projects: z.array(z.object({ id: Id, name: WorkZoneName })).max(BOT_WORK_ZONE_LIMITS.turnProjects),
  projectsMore: z.number().int().nonnegative(),
  models: z.array(WorkZoneName).max(BOT_WORK_ZONE_LIMITS.allowedValuesMax),
  defaultModel: WorkZoneName.nullable(),
  efforts: z.array(WorkZoneEffort).max(10),
  fastMode: BotFastMode,
  defaultMode: WorkZonePermissionMode,
  maxMode: WorkZonePermissionMode,
  outsideContent: z.boolean(),
  sessions: z
    .array(z.object({ id: Id, status: WorkSessionStatus, projectName: WorkZoneName }))
    .max(BOT_WORK_ZONE_LIMITS.turnSessions),
  /**
   * 07.17.1.1 (D-07): the per-file limit the two file tools apply on this turn, present only when they are offered.
   * An unknown value reads as absent, never dropping the whole offer.
   */
  files: BotFileLimit.optional().catch(undefined),
});
export type TurnWorkZone = z.infer<typeof TurnWorkZone>;

const BotPrompt = z.string().trim().min(1).max(BOT_WORK_ZONE_LIMITS.promptChars);

/**
 * `POST /work-sessions/start` (`ocw_work_session_start`). Strict: never a device, a user, a visibility, a worktree or an
 * audience; absent options = the profile's defaults.
 */
export const AgentChannelWorkSessionStart = z.strictObject({
  eventId: Id,
  agentId: Id,
  projectId: Id,
  prompt: BotPrompt,
  model: z.string().trim().min(1).max(200).optional(),
  effort: WorkZoneEffort.optional(),
  fastMode: z.boolean().optional(),
  contextWindow: WorkZoneContextWindow.optional(),
  permissionMode: WorkZonePermissionMode.optional(),
});
export type AgentChannelWorkSessionStart = z.infer<typeof AgentChannelWorkSessionStart>;

/** `POST /work-sessions/prompt` (`ocw_work_session_prompt`): one more prompt to a session this bot started. */
export const AgentChannelWorkSessionPrompt = z.strictObject({
  eventId: Id,
  agentId: Id,
  workSessionId: Id,
  prompt: BotPrompt,
});
export type AgentChannelWorkSessionPrompt = z.infer<typeof AgentChannelWorkSessionPrompt>;

/** `POST /work-sessions/read` (`ocw_work_session_read`): output after `cursor` (absent = from the start). */
export const AgentChannelWorkSessionRead = z.strictObject({
  eventId: Id,
  agentId: Id,
  workSessionId: Id,
  cursor: z.number().int().nonnegative().optional(),
});
export type AgentChannelWorkSessionRead = z.infer<typeof AgentChannelWorkSessionRead>;

/** `POST /work-sessions/stop` (`ocw_work_session_stop`): archives a session this bot started. */
export const AgentChannelWorkSessionStop = z.strictObject({
  eventId: Id,
  agentId: Id,
  workSessionId: Id,
});
export type AgentChannelWorkSessionStop = z.infer<typeof AgentChannelWorkSessionStop>;

// ---------------------------------------------------------------- bot file exchange (07.17.1.1, mirror of contracts
// work-session-files.ts and bot-work-zone.ts; parity: plugin-contract.test.ts)

/** The members of the contracts' `BOT_FILE_LIMITS` the plugin uses (the local path check, the caps, the timeout). */
export const BOT_FILE_LIMITS = {
  pathMaxChars: 1024,
  segmentMaxChars: 255,
  filesPerTurnEachWay: 5,
  transferMaxMs: 600_000,
} as const;

/** Contracts `hasUnsafePathChar`: C0 controls, DEL and the bidi controls, compared by code point. */
function hasUnsafeFilePathChar(p: string): boolean {
  for (const ch of p) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x1f || c === 0x7f || c === 0x200e || c === 0x200f) return true;
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return true;
  }
  return false;
}

const isSafeFileSegment = (seg: string) =>
  seg !== "" &&
  seg !== "." &&
  seg !== ".." &&
  seg.length <= BOT_FILE_LIMITS.segmentMaxChars &&
  !seg.endsWith(" ") &&
  !seg.endsWith(".");

/**
 * Contracts `WorkSessionFilePath`: a repo-relative file path (1 … 1 024 characters, never absolute, `~`, a drive, a
 * backslash, a control or bidi character; every segment non-empty, not `.` or `..`, ≤ 255 characters, not ending in a
 * space or a dot). The tools check it locally; the API and the device check it again.
 */
export const WorkSessionFilePath = z
  .string()
  .min(1)
  .max(BOT_FILE_LIMITS.pathMaxChars)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.startsWith("~") &&
      !/^[A-Za-z]:/.test(p) &&
      !p.includes("\\") &&
      !hasUnsafeFilePathChar(p) &&
      p.split("/").every(isSafeFileSegment),
    { message: "must be a file path inside the session's working tree" },
  );

/** Contracts `BOT_FILE_LIMIT_SOURCE_LABELS` (`BotFileLimit` is declared before `TurnWorkZone`, which carries it). */
export const BOT_FILE_LIMIT_SOURCE_LABELS: Readonly<Record<BotFileLimitSource, string>> = {
  bot: "this bot's limit",
  organization: "the organization's limit",
  server: "the server's limit",
};

const FILE_SIZE_UNITS = ["B", "KB", "MB", "GB"] as const;

/** Contracts `fileSizeLabel`: 1 536 → "1.5 KB", 25 MiB → "25 MB" (binary units, one decimal, ".0" dropped). */
export function fileSizeLabel(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < FILE_SIZE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${FILE_SIZE_UNITS[unit]}`;
}

/** Contracts `botFileTooLargeSentence`: the size, the limit and the level that set it (≤ 300 characters). */
export function botFileTooLargeSentence(p: { sizeBytes?: number | null; limit: BotFileLimit }): string {
  const limit = `${fileSizeLabel(p.limit.bytes)} (${BOT_FILE_LIMIT_SOURCE_LABELS[p.limit.source]})`;
  const text =
    p.sizeBytes === null || p.sizeBytes === undefined
      ? `That file is larger than this bot may move: up to ${limit}.`
      : `That file is ${fileSizeLabel(p.sizeBytes)}. This bot moves files up to ${limit}.`;
  return text.slice(0, 300);
}

/** `POST /work-sessions/upload` (`ocw_work_session_upload`): ids and a repo-relative path; strict. */
export const AgentChannelWorkSessionUpload = z.strictObject({
  eventId: Id,
  agentId: Id,
  workSessionId: Id,
  attachmentId: Id,
  path: WorkSessionFilePath,
  overwrite: z.boolean().optional(),
});
export type AgentChannelWorkSessionUpload = z.infer<typeof AgentChannelWorkSessionUpload>;

/** `POST /work-sessions/download` (`ocw_work_session_download`): ids and a repo-relative path; strict. */
export const AgentChannelWorkSessionDownload = z.strictObject({
  eventId: Id,
  agentId: Id,
  workSessionId: Id,
  path: WorkSessionFilePath,
});
export type AgentChannelWorkSessionDownload = z.infer<typeof AgentChannelWorkSessionDownload>;

/** The contracts' refusal codes, in their order. */
export const BotWorkSessionRefusal = z.enum([
  "not_in_turn",
  "cap_reached",
  "profile_inactive",
  "project_not_allowed",
  "setting_not_allowed",
  "mode_not_allowed",
  "prompt_not_allowed",
  "too_many_sessions",
  "org_limit",
  "prompt_rate",
  "tree_busy",
  "device_offline",
  "runtime_unavailable",
  "outside_content",
  "outside_content_bypass",
  "session_output",
  "not_your_session",
  "session_ended",
  "not_allowed",
  "attachment_not_found",
  "path_not_allowed",
  "file_exists",
  "file_not_found",
  "not_a_file",
  "file_too_large",
  "file_cap_reached",
  "session_busy",
  "session_not_running",
  "runtime_too_old",
  "storage_unavailable",
  "transfer_failed",
  "transfer_timeout",
]);
export type BotWorkSessionRefusal = z.infer<typeof BotWorkSessionRefusal>;

/** The contracts' fixed sentence per code; the tools use them for the refusals they decide locally. */
export const BOT_WORK_SESSION_SENTENCES: Readonly<Record<BotWorkSessionRefusal, string>> = {
  not_in_turn: "Work Zone sessions are not available on this turn.",
  cap_reached: "This turn has used all its tool calls. Ask the person to send the request again.",
  profile_inactive:
    "This bot can't run Work Zone sessions right now. Ask whoever manages it to check its Work Zone profile.",
  project_not_allowed:
    "That project is not in this bot's Work Zone profile. Use one of the projects listed for this turn.",
  setting_not_allowed:
    "That model or option is not allowed by this bot's Work Zone profile. Use the defaults or one of the listed values.",
  mode_not_allowed: "That permission mode is above what this bot's Work Zone profile allows here.",
  prompt_not_allowed: "Slash commands can't be sent as prompts. Describe the work in words.",
  too_many_sessions:
    "This bot already runs as many Work Zone sessions as its profile allows. Stop one or wait for one to finish.",
  org_limit: "The organization's limit of bot Work Zone sessions is reached. Try again when one finishes.",
  prompt_rate: "This bot has sent as many prompts this hour as its profile allows. Try again later.",
  tree_busy: "Another session is already working on that project's files. Wait for it to finish.",
  device_offline:
    "The bot's Work Zone device is offline. Tell the person; the session can start when the device is back.",
  runtime_unavailable: "The runtime this bot uses is not available on its device right now.",
  outside_content:
    "This turn read outside content, so the bot can't start or prompt a session on its own. A person must review it.",
  outside_content_bypass:
    "After outside content, Full access runs only on an isolated server. Use a lower mode.",
  session_output:
    "This turn read a session's output: it can't start a session, and it can prompt only the one session it read. Ask the person to send the request again.",
  not_your_session: "This bot can only control Work Zone sessions it started.",
  session_ended: "That session has ended.",
  not_allowed: "The bot's sponsor is not allowed to do this in the Work Zone any more.",
  attachment_not_found:
    "That attachment is not one this turn can use. Use a file attached in this thread before the request.",
  path_not_allowed:
    "That path can't be used. Name a file inside the project, outside .git, .claude, .codex and .ocw-worktrees, and not a secrets file such as .env or a private key.",
  file_exists:
    "That file already exists in the session. Choose another path, or set overwrite to replace it.",
  file_not_found: "There is no file at that path in the session's working tree.",
  not_a_file: "That path is not a regular file. Name one file; folders and links can't be moved.",
  file_too_large: "That file is larger than this bot may move.",
  file_cap_reached: "This turn has moved as many files as it may. Ask the person to send the request again.",
  session_busy: "The session is working. Upload when its turn is done.",
  session_not_running:
    "The session isn't running on its device. Send it a prompt to resume it, then try again.",
  runtime_too_old: "The device's runtime is too old to move files. Update it in Settings › Devices.",
  storage_unavailable: "File storage is not set up on this server, so files can't be moved.",
  transfer_failed: "The file could not be moved. Try again, or tell the person.",
  transfer_timeout: "The device did not finish moving the file in time. Try again, or try a smaller file.",
};

export const BOT_WORK_SESSION_PROPOSED_SENTENCE =
  "The bot proposed the session instead: a person must review the prompt and press Start.";

/** The contracts' inactive-profile reasons, in their order. */
export const BotProfileInactiveReason = z.enum([
  "bot_disabled",
  "no_consent",
  "device_revoked",
  "sponsor_inactive",
  "sponsor_not_allowed",
  "sponsor_device_access",
  "no_projects",
  "org_disabled",
]);
export type BotProfileInactiveReason = z.infer<typeof BotProfileInactiveReason>;

/**
 * The contracts' status line of an inactive profile, one per reason. A `profile_inactive` refusal carries the reason; the
 * start tool tells the model why after the refusal's own sentence.
 */
export const BOT_PROFILE_STATUS_SENTENCES: Readonly<Record<BotProfileInactiveReason, string>> = {
  bot_disabled: "The bot is disabled.",
  no_consent: "The device's owner has not allowed this bot to run sessions there.",
  device_revoked: "The device was removed from the organization.",
  sponsor_inactive: "The person who saved the profile is no longer an active member.",
  sponsor_not_allowed: "The person who saved the profile can no longer start Work Zone sessions.",
  sponsor_device_access: "The person who saved the profile can no longer use the device.",
  no_projects: "None of the profile's projects can be used any more.",
  org_disabled: "The organization does not let bots start Work Zone sessions.",
};

/**
 * A refused call. A code from a newer API stays a string (its sentence still reaches the model); an unknown reason or
 * field reads as absent.
 */
export const BotWorkSessionRefused = z.object({
  kind: z.literal("refused"),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
  sentence: z.string().max(300),
  reason: BotProfileInactiveReason.optional().catch(undefined),
  field: z
    .enum(["model", "effort", "contextWindow", "fastMode", "permissionMode"])
    .optional()
    .catch(undefined),
  /** 07.17.1.1 (D-07): the limit that applied and the file's size on `file_too_large`; unknown values read as absent. */
  limit: BotFileLimit.optional().catch(undefined),
  sizeBytes: z.number().int().nonnegative().optional().catch(undefined),
});
export type BotWorkSessionRefused = z.infer<typeof BotWorkSessionRefused>;

/** `started` (the session and its live card exist), `proposed` (outside content: a person starts it) or refused. */
export const AgentChannelWorkSessionStartResponse = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("started"),
    workSessionId: Id,
    status: WorkSessionStatus,
    cardMessageId: Id.nullable(),
    model: WorkZoneName.nullable(),
    mode: WorkZonePermissionMode,
    projectName: WorkZoneName,
  }),
  z.object({
    kind: z.literal("proposed"),
    approvalId: Id,
    reason: z.literal("outside_content"),
    sentence: z.string().max(300),
  }),
  BotWorkSessionRefused,
]);
export type AgentChannelWorkSessionStartResponse = z.infer<typeof AgentChannelWorkSessionStartResponse>;

/** Contracts `PromptStatus` and `DiffFileStatus`. */
export const WorkPromptStatus = z.enum([
  "queued",
  "dispatched",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
const WorkDiffFileStatus = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "untracked",
  "copied",
  "unmerged",
]);

/** Contracts `RelativePath`: no leading slash, drive letter or home shortcut, no `..` segment (principle 7). */
const WorkZoneRelativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !/^([/\\]|[A-Za-z]:[/\\]|~)/.test(p) && !p.split(/[/\\]/).includes(".."), {
    message: "must be a repo-relative path",
  });

export const AgentChannelWorkSessionPromptResponse = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("queued"),
    workSessionId: Id,
    promptId: Id,
    position: z.number().int(),
    status: WorkPromptStatus,
  }),
  BotWorkSessionRefused,
]);
export type AgentChannelWorkSessionPromptResponse = z.infer<typeof AgentChannelWorkSessionPromptResponse>;

export const AgentChannelWorkSessionStopResponse = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stopped"), workSessionId: Id }),
  BotWorkSessionRefused,
]);
export type AgentChannelWorkSessionStopResponse = z.infer<typeof AgentChannelWorkSessionStopResponse>;

/** 07.17.1.1: the file is in the session's tree at `path`, `sizeBytes` long. */
export const AgentChannelWorkSessionUploadResponse = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("uploaded"),
    workSessionId: Id,
    path: WorkSessionFilePath,
    sizeBytes: z.number().int().nonnegative(),
  }),
  BotWorkSessionRefused,
]);
export type AgentChannelWorkSessionUploadResponse = z.infer<typeof AgentChannelWorkSessionUploadResponse>;

/** 07.17.1.1: the file is a pending attachment of the turn's conversation; the bot's reply links it. Never bytes. */
export const AgentChannelWorkSessionDownloadResponse = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("downloaded"),
    workSessionId: Id,
    attachmentId: Id,
    name: z.string().max(255),
    sizeBytes: z.number().int().nonnegative(),
    contentType: z.string().max(200),
  }),
  BotWorkSessionRefused,
]);
export type AgentChannelWorkSessionDownloadResponse = z.infer<typeof AgentChannelWorkSessionDownloadResponse>;

/** A person who may decide the session's approvals (the bot names them, it never decides). */
export const WorkSessionDecider = z.object({ id: Id, handle: z.string().max(64), displayName: WorkZoneName });
export type WorkSessionDecider = z.infer<typeof WorkSessionDecider>;

const WorkCount = z.number().int().nonnegative();
const WorkToolName = z.string().max(100);
const WorkToolSummary = z.string().max(BOT_WORK_ZONE_LIMITS.toolSummaryChars);

/**
 * What `ocw_work_session_read` returns: bounded and repo-relative. The output is the runtime's work product, untrusted
 * data the tool wraps as such before the model reads it.
 */
export const BotWorkSessionReadModel = z.object({
  session: z.object({
    id: Id,
    status: WorkSessionStatus,
    runtime: WorkZoneRuntimeId,
    model: WorkZoneName.nullable(),
    mode: WorkZonePermissionMode,
    worktree: z.boolean(),
    title: WorkZoneName,
    projectName: WorkZoneName,
    updatedAt: z.string(),
  }),
  queue: z.object({
    queued: WorkCount,
    running: WorkCount,
    completed: WorkCount,
    failed: WorkCount,
    cancelled: WorkCount,
    mine: z
      .array(z.object({ id: Id, status: WorkPromptStatus, position: z.number().int() }))
      .max(BOT_WORK_ZONE_LIMITS.readMine),
  }),
  output: z
    .object({
      texts: z.array(z.object({ seq: WorkCount, text: z.string() })).max(50),
      truncated: z.boolean(),
    })
    .refine((o) => o.texts.reduce((n, t) => n + t.text.length, 0) <= BOT_WORK_ZONE_LIMITS.readOutputChars, {
      message: "output over the read budget",
      path: ["texts"],
    }),
  tools: z
    .array(z.object({ name: WorkToolName, ok: z.boolean().nullable(), summary: WorkToolSummary }))
    .max(BOT_WORK_ZONE_LIMITS.readTools),
  changes: z
    .object({
      files: z
        .array(
          z.object({
            path: WorkZoneRelativePath,
            status: WorkDiffFileStatus,
            additions: WorkCount,
            deletions: WorkCount,
          }),
        )
        .max(BOT_WORK_ZONE_LIMITS.readFiles),
      branch: WorkZoneName.nullable(),
      truncated: z.boolean(),
    })
    .nullable(),
  approvals: z
    .array(
      z.object({
        id: Id,
        tool: WorkToolName,
        paths: z.array(WorkZoneRelativePath).max(BOT_WORK_ZONE_LIMITS.readApprovalPaths),
        summary: WorkToolSummary,
      }),
    )
    .max(BOT_WORK_ZONE_LIMITS.readApprovals),
  deciders: z.array(WorkSessionDecider).max(BOT_WORK_ZONE_LIMITS.deciders),
  error: z.string().max(BOT_WORK_ZONE_LIMITS.errorChars).nullable(),
  cursor: WorkCount,
});
export type BotWorkSessionReadModel = z.infer<typeof BotWorkSessionReadModel>;

export const AgentChannelWorkSessionReadResponse = z.discriminatedUnion("kind", [
  BotWorkSessionReadModel.extend({ kind: z.literal("read") }),
  BotWorkSessionRefused,
]);
export type AgentChannelWorkSessionReadResponse = z.infer<typeof AgentChannelWorkSessionReadResponse>;

// ---------------------------------------------------------------- long-running bot tasks (07.17.1.1.2, mirror of
// contracts bot-tasks.ts, the task names and flags of bot-capabilities.ts and `agent.task.v1` of agent-channel.ts;
// parity: plugin-contract.test.ts "07.17.1.1.2 tasks"). The bot starts, continues and finishes its own task; the API is
// the only scheduler. The bodies name the delivered turn and the bot only (never a person, a conversation, a task, a
// budget or a time); goals and notes are the bot's own untrusted text.

/** The limits the plugin needs (contracts `BOT_TASK_LIMITS`, same values). */
export const BOT_TASK_LIMITS = {
  goalChars: 200,
  noteChars: 500,
  summaryChars: 1000,
  afterSecondsMax: 3600,
  finishedProcessesMax: 10,
} as const;

/** Contracts `TASK_TOOL_NAMES` (`BUILTIN_TOOLS.taskStart|taskContinue|taskFinish`): turn-scoped, never in `GET /cell`. */
export const TASK_TOOL_NAMES = ["ocw_task_start", "ocw_task_continue", "ocw_task_finish"] as const;
export type TaskToolName = (typeof TASK_TOOL_NAMES)[number];
/** Contracts `TASK_TOOL_FLAGS`: they only schedule the bot's own next turn, so neither side-effecting nor untrusted. */
export const TASK_TOOL_FLAGS: Readonly<Record<TaskToolName, TurnToolFlags>> = {
  ocw_task_start: { untrustedOutput: false, sideEffecting: false },
  ocw_task_continue: { untrustedOutput: false, sideEffecting: false },
  ocw_task_finish: { untrustedOutput: false, sideEffecting: false },
};

/** U+200E, U+200F, U+202A–U+202E, U+2066–U+2069 (contracts `hasForbiddenTaskChar`). */
function isBidiControl(c: number): boolean {
  return c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
}

/**
 * True when `s` holds U+0000–U+001F (a `\n` too unless `newlines`), U+007F, a C1 control, U+061C, a bidi control, or
 * U+2028 / U+2029 unless `newlines` (contracts `hasForbiddenTaskChar`, code review IN-07).
 */
export function hasForbiddenTaskChar(s: string, newlines: boolean): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0a && newlines) continue;
    if ((c === 0x2028 || c === 0x2029) && newlines) continue;
    if (c <= 0x1f || c === 0x7f || (c >= 0x80 && c <= 0x9f) || c === 0x061c || isBidiControl(c)) return true;
    if (c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/** Checked before the trim, like the contracts, so a leading or trailing control character is refused too. */
function taskText(max: number, newlines: boolean) {
  return z
    .string()
    .refine((s) => !hasForbiddenTaskChar(s, newlines), {
      message: newlines ? "no control or bidi characters" : "one line, no control or bidi characters",
    })
    .trim()
    .min(1)
    .max(max);
}

export const TaskGoal = taskText(BOT_TASK_LIMITS.goalChars, false);
export const TaskNote = taskText(BOT_TASK_LIMITS.noteChars, false);
export const TaskSummary = taskText(BOT_TASK_LIMITS.summaryChars, true);

/** Contracts `SandboxProcessId`. */
const TaskProcessId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "a process id");

/** Exactly one of a background command or a Work Zone session this task started. */
export const TaskWaitFor = z.union([
  z.strictObject({ processId: TaskProcessId }),
  z.strictObject({ workSessionId: Id }),
]);
export type TaskWaitFor = z.infer<typeof TaskWaitFor>;

/** `POST /tasks/start` (`ocw_task_start`). */
export const AgentChannelTaskStart = z.strictObject({ eventId: Id, agentId: Id, goal: TaskGoal });
export type AgentChannelTaskStart = z.infer<typeof AgentChannelTaskStart>;

/** `POST /tasks/continue` (`ocw_task_continue`): the API decides when the next turn comes, within the task's budgets. */
export const AgentChannelTaskContinue = z.strictObject({
  eventId: Id,
  agentId: Id,
  progress: TaskNote,
  nextStep: TaskNote,
  afterSeconds: z.number().int().min(0).max(BOT_TASK_LIMITS.afterSecondsMax).optional(),
  waitFor: TaskWaitFor.optional(),
});
export type AgentChannelTaskContinue = z.infer<typeof AgentChannelTaskContinue>;

/** `POST /tasks/finish` (`ocw_task_finish`). */
export const AgentChannelTaskFinish = z.strictObject({
  eventId: Id,
  agentId: Id,
  summary: TaskSummary,
  outcome: z.enum(["done", "blocked"]),
});
export type AgentChannelTaskFinish = z.infer<typeof AgentChannelTaskFinish>;

/** The contracts' refusal codes, in their order (`once_per_turn` is the plugin's own, never the API's). */
export const BotTaskRefusal = z.enum([
  "not_in_turn",
  "task_active",
  "no_task",
  "not_requester",
  "task_busy",
  "task_stopped",
  "budget_turns",
  "budget_time",
  "policy_off",
  "org_cap",
  "wait_unknown",
  "once_per_turn",
]);
export type BotTaskRefusal = z.infer<typeof BotTaskRefusal>;

/** The contracts' fixed sentence per code; the tools use them for the refusals they decide locally. */
export const BOT_TASK_SENTENCES: Readonly<Record<BotTaskRefusal, string>> = {
  not_in_turn: "Long tasks are not available on this turn.",
  task_active:
    "You already have a task running in this thread. Continue it with ocw_task_continue or end it with ocw_task_finish.",
  no_task: "There is no task of yours in this thread. Start one with ocw_task_start first.",
  not_requester: "This task runs for another person. Only their turns can continue or finish it.",
  task_busy: "Another turn of this task is running. Answer the person; the task goes on by itself.",
  task_stopped:
    "This task was stopped or has ended. Do not continue it; tell the person briefly where you got to.",
  budget_turns: "This task used all its turns, so it stopped. Tell the person what is done and what is left.",
  budget_time: "This task ran out of time, so it stopped. Tell the person what is done and what is left.",
  policy_off: "Long tasks are turned off for this bot. Do what you can in this turn and tell the person.",
  org_cap:
    "Too many tasks are running in this organization right now. Do what you can in this turn, or ask the person to try again later.",
  wait_unknown:
    "That is not a background command or a Work Zone session of this task. Wait on one this task started, or continue without waitFor.",
  once_per_turn: "That task tool was already called in this turn.",
};

/** A refused call. A code from a newer API stays a string, so its sentence still reaches the model. */
export const BotTaskRefused = z.object({
  ok: z.literal(false),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
  sentence: z.string().max(300),
});
export type BotTaskRefused = z.infer<typeof BotTaskRefused>;

export const AgentChannelTaskStartResponse = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    taskId: Id,
    maxTurns: z.number().int().positive(),
    deadlineAt: z.string(),
  }),
  BotTaskRefused,
]);
export type AgentChannelTaskStartResponse = z.infer<typeof AgentChannelTaskStartResponse>;

/** `quiet`: drop this turn's text (the card shows the progress, D-11). */
export const AgentChannelTaskContinueResponse = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    next: z.enum(["after_turn", "at", "on_process", "on_session"]),
    at: z.string().nullable(),
    turnsLeft: z.number().int().nonnegative(),
    quiet: z.boolean(),
  }),
  BotTaskRefused,
]);
export type AgentChannelTaskContinueResponse = z.infer<typeof AgentChannelTaskContinueResponse>;

export const AgentChannelTaskFinishResponse = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), status: z.enum(["done", "failed"]) }),
  BotTaskRefused,
]);
export type AgentChannelTaskFinishResponse = z.infer<typeof AgentChannelTaskFinishResponse>;

/** Contracts `BotTaskWaitKind` and `BotTaskWakeReason`. */
export const BotTaskWaitKind = z.enum(["turn", "timer", "process", "session", "nudge"]);
export type BotTaskWaitKind = z.infer<typeof BotTaskWaitKind>;
export const BotTaskWakeReason = z.enum(["continue", "timer", "process", "nudge"]);
export type BotTaskWakeReason = z.infer<typeof BotTaskWakeReason>;

/** A background command of the task that ended or was lost: ids and numbers only. */
export const TaskProcessFact = z.object({
  processId: TaskProcessId,
  status: z.enum(["exited", "killed", "timed_out", "lost"]),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
});
export type TaskProcessFact = z.infer<typeof TaskProcessFact>;

/** `TurnContext.task`: the bot's active task in this thread (its own earlier notes, the platform's numbers). */
export const TurnTask = z.object({
  taskId: Id,
  status: z.enum(["running", "waiting"]),
  goal: TaskGoal,
  progress: TaskNote.nullable(),
  nextStep: TaskNote.nullable(),
  turnsUsed: z.number().int().nonnegative(),
  maxTurns: z.number().int().positive(),
  startedAt: z.string(),
  deadlineAt: z.string(),
  requesterId: Id,
  waiting: z
    .object({ kind: BotTaskWaitKind, ref: z.string().max(64).nullable(), until: z.string().nullable() })
    .nullable(),
  finishedProcesses: z.array(TaskProcessFact).max(BOT_TASK_LIMITS.finishedProcessesMax),
});
export type TurnTask = z.infer<typeof TurnTask>;

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
  /**
   * 07.8 (D-11 F-7): sandbox and browser calls this turn may make, counted apart from `maxToolCalls`. Absent (an older
   * API) or invalid → `SANDBOX_LIMITS.callsPerTurn`; the API counts and refuses `budget_exhausted` either way.
   */
  maxSandboxCalls: z.number().int().nonnegative().optional().catch(undefined),
  /**
   * 07.7 (D-01, ADR-0027): present only when the turn is offered `ocw_consult_agent`: the bots it may consult and this
   * turn's depth in its chain. An invalid block reads as absent (the tool then refuses every target: fail closed).
   */
  consult: TurnConsult.optional().catch(undefined),
  /**
   * 07.7 (D-09): the API delivered the turn tainted (07.6 `taintedAtStart`: outside content, an inbound-rooted thread, a
   * consult answer that read web or MCP content); the gate starts the turn read-only. No `.catch`: a malformed value
   * invalidates the whole turn block, so the run gets no tools at all (fail closed, never untainted by accident).
   */
  tainted: z.boolean().optional(),
  /**
   * 07.15 (D-02): the attachments of the messages this turn reads (at most `ATTACHMENT_READ_LIMITS.listPerTurn`).
   * Additive: an older API sends none; an invalid list is dropped, the turn is kept (the bot then lists no files, and
   * the API still decides every read).
   */
  attachments: z.array(TurnAttachment).max(ATTACHMENT_READ_LIMITS.listPerTurn).optional().catch(undefined),
  /** 07.15 (D-05): conversation files not listed because of the cap. Absent or invalid → none mentioned. */
  attachmentsMore: z.number().int().nonnegative().optional().catch(undefined),
  /**
   * 07.15 (D-17): `ocw_attachment_read` calls this turn may make, counted apart from `maxToolCalls`. Absent (an older
   * API) or invalid → `ATTACHMENT_READ_LIMITS.readsPerTurn`; the API counts and refuses `cap_reached` either way.
   */
  maxAttachmentReads: z.number().int().nonnegative().optional().catch(undefined),
  /** 07.15 (D-17): characters all reads of this turn may return. Informational: the API enforces it. */
  maxAttachmentChars: z.number().int().nonnegative().optional().catch(undefined),
  /**
   * 07.16 (D-05, PD-17): present only on turns of a bot with an active Work Zone profile. Informational: an invalid
   * block reads as absent (the tools then list no projects), and the API decides every call anyway.
   */
  workZone: TurnWorkZone.optional().catch(undefined),
  /**
   * 07.17.1.1.2 (D-02, PD-16): the bot's active task in this thread. Informational: an invalid block reads as absent
   * (the turn is kept; the "Your task" block is then missing), and the API decides every task call from its own row.
   */
  task: TurnTask.optional().catch(undefined),
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

/**
 * 07.7 (D-01, ADR-0027): why a bot's turn is a consult. Server-built from the chain ledger, never from message text:
 * `agent` is the bot that asked (also the delivery's `message.author`), `onBehalfOf` the human the chain runs for.
 */
export const AgentTurnOrigin = z.object({
  agent: z.object({ id: Id, handle: z.string(), displayName: z.string() }),
  chainId: Id,
  hopId: Id,
  depth: z.number().int().min(1).max(A2A_LIMITS.maxDepth),
  mode: ConsultMode,
  onBehalfOf: AgentChannelAuthor.extend({ kind: z.literal("user") }),
});
export type AgentTurnOrigin = z.infer<typeof AgentTurnOrigin>;

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
  /**
   * 07.7 (D-01): server-built, present only on a consult delivery (the question to the consulted bot). No `.catch`: a
   * malformed origin fails the event (it is skipped), so a question never arrives without who asked and for whom.
   */
  origin: AgentTurnOrigin.optional(),
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
    /**
     * 07.5 (P-06): who decided. For grant kinds the turn is delivered for the requester (`message.author`), so the
     * decider is named here. A malformed value reads as absent.
     */
    decidedBy: z.object({ id: Id, displayName: z.string() }).optional().catch(undefined),
    /**
     * 07.5 (D-02): an approved `tool.call` grant: call `tool` once with exactly these canonical `arguments` before
     * `useBy`. Lenient on purpose (sizes and names are bounded by the mapper, which drops an oversized grant and says
     * so); a malformed value reads as absent.
     */
    grant: z
      .object({ tool: z.string().min(1), arguments: z.string(), useBy: z.string() })
      .optional()
      .catch(undefined),
    /**
     * 07.5-11: the decider's own note, as a field (the mapper never parses it out of the sentence). Bounded and
     * sanitized by the mapper; a malformed value reads as absent.
     */
    note: z.string().optional().catch(undefined),
    /**
     * 07.5-11: an approved request that failed to apply (a Work Zone Start: `device_offline`, …). The mapper turns
     * known codes into words; a malformed value reads as absent.
     */
    resultCode: z.string().optional().catch(undefined),
    /**
     * 07.8-21: a platform sign-in card's outcome for the requester (`signed_in` or `skipped`) and the page's host. The
     * mapper words it with the UI-SPEC's model-facing sentences; a malformed value reads as absent.
     */
    signIn: z
      .object({ status: z.enum(["signed_in", "skipped"]), host: z.string().min(1).max(260) })
      .optional()
      .catch(undefined),
  }),
});
export type AgentCardActionEvent = z.infer<typeof AgentCardActionEvent>;

/** Phase 07.6: the contracts' `AUTOMATION_LIMITS` the plugin checks or bounds locally (parity: plugin-contract.test.ts). */
export const AUTOMATION_LIMITS = {
  nameMax: 120,
  instructionsMax: 4000,
  maxRunsPerDayCeiling: 288,
  mailTextMaxChars: 32_768,
  pointerMax: 200,
  cronMax: 100,
} as const;
/** The inbound title bound (contracts: `AGENT_CARD_TITLE_MAX`). */
export const AUTOMATION_INBOUND_TITLE_MAX = 200;

/** `ocw_record_update`: at most this many field changes per call (contracts `AgentChannelRecordUpdate`). */
export const RECORD_UPDATE_MAX_CHANGES = 20;
/** The longest string value of one `ocw_record_update` change. */
export const RECORD_UPDATE_VALUE_MAX = 500;

// ---------------------------------------------------------------- automation fan-out (Phase 07.17)

/**
 * Phase 07.17 (D-02, D-03, D-08): mirror of the contracts' `automation-fan-out.ts` and `CONVERSATION_OPEN_FLAGS`
 * (parity: plugin-contract.test.ts). A fan-out run turn opens one conversation per new item through
 * `ocw_conversation_open`; the bot names items only, never a conversation, a column, a person, an automation or a run
 * (the API takes them from the stored turn).
 */
export const FAN_OUT_LIMITS = {
  perRunDefault: 10,
  perRunMax: 25,
  perDayDefault: 100,
  perDayMax: 500,
  externalKeyMax: 200,
  titleMax: 200,
  bodyMax: 4000,
  escalationMax: 5,
} as const;

/** Contracts `BUILTIN_TOOLS.conversationOpen`: offered only on run turns of fan-out automations. */
export const CONVERSATION_OPEN_TOOL = "ocw_conversation_open";
/** Contracts `CONVERSATION_OPEN_FLAGS`: it posts in the automation's target; the answer is the platform's own ids. */
export const CONVERSATION_OPEN_FLAGS: TurnToolFlags = { untrustedOutput: false, sideEffecting: true };

/** A person or team the bot mentions when it finishes or needs help (contracts `EscalationTargetView`). */
export const EscalationTargetView = z.object({
  kind: z.enum(["user", "unit"]),
  id: Id,
  handle: z.string().max(64),
  displayName: z.string().max(200),
});
export type EscalationTargetView = z.infer<typeof EscalationTargetView>;

export const AgentChannelConversationOpenItem = z.strictObject({
  externalKey: z.string().trim().min(1).max(FAN_OUT_LIMITS.externalKeyMax),
  title: z.string().trim().min(1).max(FAN_OUT_LIMITS.titleMax),
  body: z.string().max(FAN_OUT_LIMITS.bodyMax).default(""),
});
export type AgentChannelConversationOpenItem = z.infer<typeof AgentChannelConversationOpenItem>;

/** `POST /conversations/open`: strict, the event and the bot plus the items (`[]` = nothing new). */
export const AgentChannelConversationOpen = z.strictObject({
  eventId: Id,
  agentId: Id,
  items: z.array(AgentChannelConversationOpenItem).max(FAN_OUT_LIMITS.perRunMax),
});
export type AgentChannelConversationOpen = z.infer<typeof AgentChannelConversationOpen>;

/** The contracts' refusal codes, in their order. */
export const ConversationOpenRefusal = z.enum([
  "not_in_turn",
  "not_a_run",
  "automation_inactive",
  "fan_out_off",
  "target_not_postable",
  "cap_reached",
]);
export type ConversationOpenRefusal = z.infer<typeof ConversationOpenRefusal>;

/** The contracts' fixed sentence per code; the tool uses them for the refusals it decides locally. */
export const CONVERSATION_OPEN_SENTENCES: Readonly<Record<ConversationOpenRefusal, string>> = {
  not_in_turn: "Opening conversations is not available on this turn.",
  not_a_run: "Only an automation run can open conversations. Reply in this thread instead.",
  automation_inactive: "This automation is paused or needs attention, so it can't open conversations now.",
  fan_out_off: "This automation no longer opens a conversation per item. Reply in this thread instead.",
  target_not_postable:
    "The bot can't post in this automation's channel or board any more. Tell the person who owns the automation.",
  cap_reached: "This turn has used all its tool calls. List the new items in your reply instead.",
};

/** A refusal code or cap reason from a newer API stays a string, so its answer (and sentence) still reaches the model. */
const OpenCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u);

export const ConversationOpenItemResult = z.object({
  externalKey: z.string().max(FAN_OUT_LIMITS.externalKeyMax),
  opened: z.boolean(),
  conversationId: Id.nullable(),
  threadRootMessageId: Id.nullable(),
  refused: OpenCode.nullable(),
});
export type ConversationOpenItemResult = z.infer<typeof ConversationOpenItemResult>;

export const AgentChannelConversationOpenResponse = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    results: z.array(ConversationOpenItemResult).max(FAN_OUT_LIMITS.perRunMax),
    remainingRun: z.number().int().nonnegative(),
    remainingDay: z.number().int().nonnegative(),
  }),
  z.object({ ok: z.literal(false), code: OpenCode, sentence: z.string().max(300) }),
]);
export type AgentChannelConversationOpenResponse = z.infer<typeof AgentChannelConversationOpenResponse>;

/** Contracts `escalationSentence`: whom the bot mentions when it finishes or needs help; null without targets. */
export function escalationSentence(targets: readonly { handle: string }[]): string | null {
  if (targets.length === 0) return null;
  const handles = targets.map((t) => `@${t.handle}`);
  const last = handles.pop() as string;
  const list = handles.length === 0 ? last : `${handles.join(", ")} and ${last}`;
  return `When you finish or need help, mention ${list}.`;
}

/** Contracts `fanOutLabel`: the run card's status label of a fan-out run. */
export function fanOutLabel(opened: number): string {
  if (opened <= 0) return "Nothing new";
  return opened === 1 ? "Opened 1 conversation" : `Opened ${opened} conversations`;
}

/**
 * Phase 07.6 (D-03, C-01): the outside content that started a run (a webhook payload or a mail), composed by the API.
 * Untrusted: the mapper puts it in its own `external` block, never in the message text or the standing order. A
 * malformed value fails the event (it is skipped), so outside content never arrives unlabelled.
 */
export const AgentAutomationRunInbound = z.object({
  source: z.enum(["webhook", "mail"]),
  title: z.string().max(AUTOMATION_INBOUND_TITLE_MAX),
  text: z.string().max(AUTOMATION_LIMITS.mailTextMaxChars),
  from: z.string().max(320).nullable(),
  receivedAt: z.string(),
});
export type AgentAutomationRunInbound = z.infer<typeof AgentAutomationRunInbound>;

/**
 * `agent.automation_run.v1` (07.6 D-03, P-22): built by the API like a mention of the agent on the run's anchor message:
 * `message.author` is the run-as human, `message.text` a server sentence and `turn` is computed for that human
 * (unattended: never a browser tool, D-12). `trigger` stays a string so a newer trigger never drops the event.
 */
export const AgentAutomationRunEvent = AgentMentionEvent.omit({ type: true }).extend({
  type: z.literal(AgentChannelEventTypes.automationRun),
  automationRun: z.object({
    automationId: Id,
    runId: Id,
    name: z.string().max(AUTOMATION_LIMITS.nameMax),
    trigger: z.string().min(1).max(32),
    instructions: z.string().max(AUTOMATION_LIMITS.instructionsMax),
    inbound: AgentAutomationRunInbound.nullable(),
    /** 07.17 (D-02, PD-08): only on fan-out runs (the turn offers `ocw_conversation_open`); absent or null otherwise. */
    fanOut: z
      .object({
        perRun: z.number().int().min(1).max(FAN_OUT_LIMITS.perRunMax),
        remainingRun: z.number().int().nonnegative(),
        remainingDay: z.number().int().nonnegative(),
      })
      .nullable()
      .optional(),
    /** 07.17 (D-08, PD-15): the people and teams to mention when the work is done or needs help. */
    escalation: z.array(EscalationTargetView).max(FAN_OUT_LIMITS.escalationMax).optional(),
  }),
});
export type AgentAutomationRunEvent = z.infer<typeof AgentAutomationRunEvent>;

/**
 * `agent.consult_reply.v1` (07.7 D-01, D-07, ADR-0027): a consulted bot's hop ended, delivered to the bot that asked as a
 * new turn in the hop's thread. Built like a mention: `message` is the answer (or the question again when there is
 * none), `turn` is computed for the chain's human and starts with the consulted turn's taint (`turn.tainted`, D-09).
 * `cancelled` is never delivered. Older plugins skip the unknown type.
 */
export const AgentConsultReplyEvent = AgentMentionEvent.omit({ type: true }).extend({
  type: z.literal(AgentChannelEventTypes.consultReply),
  consultReply: z
    .object({
      chainId: Id,
      hopId: Id,
      /** The bot that was consulted. */
      target: z.object({ id: Id, handle: z.string(), displayName: z.string() }),
      mode: ConsultMode,
      outcome: z.enum(["answered", "failed", "timed_out"]),
      /** The consulted bot's answer message; null when it failed or timed out. */
      answerMessageId: Id.nullable(),
    })
    // CR-B-08 (mirrors packages/contracts): `answered` names its answer, nothing else does. A contradictory result
    // fails the frame, and the bridge reports the turn `failed` (CR-C-03) instead of running it.
    .refine((r) => (r.outcome === "answered") === (r.answerMessageId !== null), {
      message: "answered carries the answer message id, failed and timed_out carry none",
      path: ["answerMessageId"],
    }),
});
export type AgentConsultReplyEvent = z.infer<typeof AgentConsultReplyEvent>;

/** 07.16 (D-09): why a bot is woken about its session (contracts `WorkSessionTransition`). */
export const WorkSessionTransition = z.enum(["turn_done", "waiting_approval", "failed", "ended", "offline"]);
export type WorkSessionTransition = z.infer<typeof WorkSessionTransition>;

/**
 * 07.16 (D-09, D-10, PD-16): a session this bot started changed state, delivered as a new turn in the thread of its
 * live card (built like a mention; author = the person who asked). `summary` is server-composed from structured facts,
 * never runtime text; `deciders` may decide pending approvals (the bot cannot).
 */
export const AgentWorkSessionEvent = AgentMentionEvent.omit({ type: true }).extend({
  type: z.literal(AgentChannelEventTypes.workSession),
  workSession: z.object({
    workSessionId: Id,
    transition: WorkSessionTransition,
    status: WorkSessionStatus,
    summary: z.string().max(BOT_WORK_ZONE_LIMITS.summaryChars),
    pendingApprovals: z.number().int().nonnegative(),
    deciders: z.array(WorkSessionDecider).max(BOT_WORK_ZONE_LIMITS.deciders),
  }),
});
export type AgentWorkSessionEvent = z.infer<typeof AgentWorkSessionEvent>;

/**
 * `agent.automation_item.v1` (07.17 D-04, PD-09): built by the API like a mention of the bot on the conversation a
 * fan-out run opened: `message.author` is the run-as person, `message.text` a server sentence, `turn` computed for that
 * person and tainted from the start. The item is untrusted: the mapper puts it in its own outside-content block, never
 * in the message text or the standing order; a malformed value fails the event (it is skipped).
 */
export const AgentAutomationItemEvent = AgentMentionEvent.omit({ type: true }).extend({
  type: z.literal(AgentChannelEventTypes.automationItem),
  automationItem: z.object({
    automationId: Id,
    runId: Id,
    itemId: Id,
    name: z.string().max(AUTOMATION_LIMITS.nameMax),
    instructions: z.string().max(AUTOMATION_LIMITS.instructionsMax),
    item: z.object({
      title: z.string().max(FAN_OUT_LIMITS.titleMax),
      text: z.string().max(FAN_OUT_LIMITS.bodyMax),
      openedAt: z.string(),
    }),
    escalation: z.array(EscalationTargetView).max(FAN_OUT_LIMITS.escalationMax),
  }),
});
export type AgentAutomationItemEvent = z.infer<typeof AgentAutomationItemEvent>;

/**
 * `agent.task.v1` (07.17.1.1.2 D-02, D-03, PD-11): built by the API like a mention of the bot on its task card:
 * `message.author` is the person the task runs for, `message.text` a fixed server sentence, `turn` computed for that
 * person with `turn.task`. `task.reason` says why the turn came (`process` carries the ended command); a malformed
 * value fails the event (it is skipped).
 */
export const AgentTaskEvent = AgentMentionEvent.omit({ type: true }).extend({
  type: z.literal(AgentChannelEventTypes.task),
  task: z.object({
    taskId: Id,
    reason: BotTaskWakeReason,
    process: TaskProcessFact.optional(),
  }),
});
export type AgentTaskEvent = z.infer<typeof AgentTaskEvent>;

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
  /**
   * 07.8 (D-14, spike ii): the ids of `models` that accept image input. The reconciler declares them
   * `input: ["text", "image"]`, so a tool's image (`ocw_browser_screenshot`) reaches the model; absent or invalid = text
   * only (OpenClaw then drops tool images).
   */
  imageModels: z.array(z.string()).optional().catch(undefined),
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

/**
 * Quick 261113-id6: the organization's conversation summary settings (`BotPolicy.conversations`). The reconciler writes
 * them to `agents.defaults.compaction`; the bridge applies `freshSessionOnFailure`.
 */
export const CellConversations = z.object({
  strictSummaries: z.boolean(),
  keepIdentifiers: z.boolean(),
  keepRecentTokens: z.number().int().positive(),
  freshSessionOnFailure: z.boolean(),
});
export type CellConversations = z.infer<typeof CellConversations>;

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
  /** Quick 261113-id6: conversation summary settings; absent on older APIs = the lenient defaults. */
  conversations: CellConversations.optional(),
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

/**
 * 07.5-11: who denied exactly this action (`approval_denied`): the decider's display name and their own note. Bounded
 * and sanitized by the sentence that shows them; a malformed one reads as absent.
 */
export const AgentChannelApprovalDenial = z.object({
  deciderName: z.string(),
  note: z.string().nullable(),
});
export type AgentChannelApprovalDenial = z.infer<typeof AgentChannelApprovalDenial>;

export const AgentChannelToolCallDecision = z.object({
  callId: Id,
  allowed: z.boolean(),
  reason: z.string().nullable().optional(),
  /** 07.5: with `approval_required` / `approval_pending`. A malformed one reads as absent (the sentence falls back). */
  approval: AgentChannelToolCallApproval.nullable().optional().catch(null),
  /** 07.5-11: with `approval_denied`. A malformed one reads as absent (the sentence names "an approver"). */
  denial: AgentChannelApprovalDenial.nullable().optional().catch(null),
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
/** The kinds an agent may post with `ocw_agent_card`. */
export const AGENT_POSTABLE_CARD_KINDS = [
  "work_zone",
  "approval",
  "report",
  "artifact",
  "automation",
  "deployment",
  "pr",
  "generic",
] as const;
/**
 * Every kind (contracts parity); `browser` (Phase 07.8 sign-in card) and `task` (Phase 07.17.1.1.2 task card) are
 * platform-owned, never posted by an agent.
 */
export const AGENT_CARD_KINDS = [...AGENT_POSTABLE_CARD_KINDS, "browser", "task"] as const;
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

/** A C0/C1 control character or DEL. */
export function hasControlCharacter(v: string): boolean {
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
  kind: z.enum(AGENT_POSTABLE_CARD_KINDS),
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

/**
 * 07.5: the `details` of a 409 approval refusal from `/connectors/call` and `/http-requests`: the approval waited on
 * (`approval_required` / `approval_pending`) or, 07.5-11, who denied it (`approval_denied`). Each reads as absent when
 * malformed.
 */
export const AgentChannelApprovalRefusalDetails = z.object({
  approval: AgentChannelToolCallApproval.optional().catch(undefined),
  denial: AgentChannelApprovalDenial.optional().catch(undefined),
});
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

// ---------------------------------------------------------------- Work Zone proposals (Phase 07.5)

/*
 * `ocw_work_zone_projects` and `ocw_start_work_zone` (07.5 D-03, C-01): bound to a delivered turn like the connector
 * tools. The human a session is proposed for is always the stored turn's, never a field: the bodies carry the event
 * and the agent plus the tool's own fields. There is deliberately no mode, model or full-access field anywhere, so a
 * bot can never choose how a session runs (APPROVE-04). Mirror of `packages/contracts/src/work-zone-proposals.ts`.
 */

/** The runtimes a proposal may name (contracts `RuntimeId`). */
export const WORK_ZONE_RUNTIMES = ["claude-code", "codex"] as const;
export type WorkZoneRuntime = (typeof WORK_ZONE_RUNTIMES)[number];

/** The bounds of contracts `WORK_ZONE_PROPOSAL_LIMITS` the cell uses. */
export const WORK_ZONE_PROPOSAL_LIMITS = {
  promptChars: 50_000,
  pendingPerRequester: 3,
} as const;

/** Why a proposal was refused before any card existed (contracts `WorkZoneProposalRefusal`). */
export const WORK_ZONE_PROPOSAL_REFUSALS = [
  "unknown_turn",
  "not_in_turn",
  "tainted",
  "cap_reached",
  "not_allowed",
  "prompt_not_allowed",
  "project_not_found",
  "device_not_shared",
  "device_offline",
  "runtime_unavailable",
  "too_many_pending",
] as const;
export type WorkZoneProposalRefusal = (typeof WORK_ZONE_PROPOSAL_REFUSALS)[number];

/** `POST /work-zone/projects`: the turn's ids only. */
export type AgentChannelWorkZoneProjects = { eventId: string; agentId: string };

/** Names and ids only (a host path never leaves the device). Lenient: a newer runtime id stays a string. */
export const AgentChannelWorkZoneProjectsResponse = z.object({
  projects: z
    .array(
      z.object({
        projectId: Id,
        name: z.string(),
        device: z.object({ id: Id, name: z.string(), online: z.boolean() }),
        runtimes: z
          .array(z.object({ id: z.string(), label: z.string(), available: z.boolean() }))
          .default([]),
      }),
    )
    .default([]),
});
export type AgentChannelWorkZoneProjectsResponse = z.infer<typeof AgentChannelWorkZoneProjectsResponse>;

/** `POST /work-zone/proposals`: never a mode, a model or a user. */
export type AgentChannelWorkZonePropose = {
  eventId: string;
  agentId: string;
  projectId: string;
  deviceId: string;
  prompt: string;
  runtime?: WorkZoneRuntime;
};

/**
 * `{approvalId, created}` (created false: the same proposal was already pending) or a 200 `{refused}`. An unknown
 * refusal code from a newer API stays a string (the plugin answers it with its generic sentence).
 */
export const AgentChannelWorkZoneProposeResponse = z.union([
  z.object({ refused: z.string().min(1).max(64) }),
  z.object({ approvalId: Id, created: z.boolean() }),
]);
export type AgentChannelWorkZoneProposeResponse = z.infer<typeof AgentChannelWorkZoneProposeResponse>;

// ---------------------------------------------------------------- automations and watched records (07.6, mirror of
// contracts agent-channel.ts). Bodies carry only the turn's event and agent with the intent: the API derives the
// conversation, the person (run-as) and the record from the stored turn and computes every hash itself (D-03, D-04).

/** `POST /automations/propose` (`ocw_automation_propose`): never a conversation id, a person or a webhook/mail trigger. */
export type AgentChannelAutomationPropose = {
  eventId: string;
  agentId: string;
  name: string;
  instructions: string;
  schedule: { cron: string; timeZone: string };
  /** `here`: the turn's conversation (its thread); `dm`: the person's DM with this bot. */
  target: { kind: "here" } | { kind: "dm" };
  maxRunsPerDay?: number;
};

/** The model reads `sentence` (composed by the API); `code` is the refusal code. */
export const AgentChannelAutomationProposeResponse = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), approvalId: Id, sentence: z.string().max(500) }),
  z.object({ ok: z.literal(false), code: z.string().max(64), sentence: z.string().max(500) }),
]);
export type AgentChannelAutomationProposeResponse = z.infer<typeof AgentChannelAutomationProposeResponse>;

/** One field change of `ocw_record_update`: an RFC 6901 pointer (never `""`) → a scalar value. */
export type RecordChangeValue = string | number | boolean | null;

/** `POST /records/update` (`ocw_record_update`): never a record id or a hash (the API binds the record to the thread). */
export type AgentChannelRecordUpdate = {
  eventId: string;
  agentId: string;
  changes: Record<string, RecordChangeValue>;
};

export const AgentChannelRecordUpdateResponse = z.object({
  ok: z.boolean(),
  code: z.string().max(64).nullable(),
  sentence: z.string().max(500),
});
export type AgentChannelRecordUpdateResponse = z.infer<typeof AgentChannelRecordUpdateResponse>;

// ---------------------------------------------------------------- consults (07.7, mirror of contracts agent-chains.ts)

/**
 * `POST /consultations` (`ocw_consult_agent`, D-08): only the turn's event and agent, the target and the intent. The API
 * derives the conversation, the thread, the human and the chain from the stored turn (strict body: any other key is
 * refused). The key is `<eventId>:consult:<hash of target and question>`; a retry of the same key answers the stored hop.
 */
export type AgentChannelConsultRequest = {
  eventId: string;
  agentId: string;
  target: string;
  question: string;
  mode: ConsultMode;
  idempotencyKey: string;
};

/**
 * The model reads `sentence` (composed by the API). `{ok: false, code: "limit_reached"}` also names the posted hop and
 * question; any other refusal posted nothing. An unknown code from a newer API stays a string.
 */
export const AgentChannelConsultResponse = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    chainId: Id,
    hopId: Id,
    questionMessageId: Id,
    sentence: z.string().max(500),
  }),
  z.object({
    ok: z.literal(false),
    code: z.string().max(64),
    sentence: z.string().max(500),
    hopId: Id.optional(),
    questionMessageId: Id.optional(),
  }),
]);
export type AgentChannelConsultResponse = z.infer<typeof AgentChannelConsultResponse>;

/** `POST /turns/:eventId/done` (P-09): the bridge's `finally` for a turn that can belong to a chain. */
export type AgentChannelTurnDone = { agentId: string; outcome: "replied" | "failed" };

/**
 * A refusal answered with a non-2xx status whose body still carries the server's sentence (`{ok: false, code,
 * sentence}`, 403 `tainted`, 409 `record_changed`, …). Anything else in an error body is never read.
 */
export const AgentChannelSentenceAnswer = z.object({
  ok: z.literal(false),
  code: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/u)
    .nullable(),
  sentence: z.string().min(1).max(500),
});
export type AgentChannelSentenceAnswer = z.infer<typeof AgentChannelSentenceAnswer>;

// ---------------------------------------------------------------- attachment reads (07.15, mirror of contracts
// agent-channel.ts; parity: plugin-contract.test.ts)

/**
 * `POST /attachments/read` (`ocw_attachment_read`, D-03): only the turn's event, the agent and the attachment id from
 * the turn's list. Strict: the API derives the conversation and the human from the stored turn.
 */
export const AgentChannelAttachmentRead = z.strictObject({
  eventId: Id,
  agentId: Id,
  attachmentId: z.uuid(),
});
export type AgentChannelAttachmentRead = z.infer<typeof AgentChannelAttachmentRead>;

/** The contracts' refusal codes (D-04), in their order. */
export const AttachmentReadRefusal = z.enum([
  "not_found",
  "policy_changed",
  "model_no_images",
  "unsupported_type",
  "too_large",
  "no_text_layer",
  "encrypted",
  "extraction_failed",
  "timeout",
  "busy",
  "cap_reached",
  "unavailable",
]);
export type AttachmentReadRefusal = z.infer<typeof AttachmentReadRefusal>;

/** The contracts' fixed sentence per code; the guard uses them for the refusals it decides locally (its read budget). */
export const ATTACHMENT_READ_SENTENCES: Readonly<Record<AttachmentReadRefusal, string>> = {
  not_found: "This file is not available in this conversation (it may have been deleted).",
  policy_changed: "Reading files is not available on this turn.",
  model_no_images: "This bot's model can't see images, so it can't read this image. Tell the person.",
  unsupported_type:
    "This type of file can't be read as text. If the sandbox is available, copy it with ocw_sandbox_import and use the sandbox tools.",
  too_large: "This file is too large to read.",
  no_text_layer: "This PDF has no text layer (it looks scanned). OCR is not available.",
  encrypted: "This PDF is password-protected, so it can't be read.",
  extraction_failed: "This file couldn't be read (it may be damaged).",
  timeout: "Reading this file took too long and was stopped.",
  busy: "Too many files are being read right now. Try again in a moment.",
  cap_reached:
    "This turn has read as many files (or as much text) as it may. Ask the person to send the question again for more.",
  unavailable: "File storage is not available right now.",
};

/** The inline image types a read may return; anything else (SVG included) never reaches the model as an image. */
export const AttachmentImageType = z.enum(["image/webp", "image/png", "image/jpeg", "image/gif"]);
export type AttachmentImageType = z.infer<typeof AttachmentImageType>;

/** Base64 of at most contracts `SANDBOX_LIMITS.previewImageMaxBytes` (5 MiB). */
const ATTACHMENT_IMAGE_DATA_MAX = Math.ceil((5_242_880 * 4) / 3) + 4;

/**
 * The read's answer: the API's untrusted text block (data, never instructions), an image as base64, or a refusal whose
 * `sentence` the model reads. A refusal code from a newer API stays a string, so its sentence still reaches the model.
 */
export const AgentChannelAttachmentReadResponse = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    attachmentId: Id,
    name: z.string().max(120),
    text: z.string().max(ATTACHMENT_READ_LIMITS.charsPerFile + 512),
    chars: z.number().int().nonnegative(),
    truncated: z.boolean(),
    pages: z.number().int().min(1).optional(),
  }),
  z.object({
    kind: z.literal("image"),
    attachmentId: Id,
    name: z.string().max(120),
    mimeType: AttachmentImageType,
    data: z
      .string()
      .max(ATTACHMENT_IMAGE_DATA_MAX)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/u),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
  }),
  z.object({
    kind: z.literal("refused"),
    attachmentId: Id,
    code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    sentence: z.string().max(300),
  }),
]);
export type AgentChannelAttachmentReadResponse = z.infer<typeof AgentChannelAttachmentReadResponse>;

// ---------------------------------------------------------------- confined sandbox tools (07.8, mirror of contracts
// sandbox.ts and bot-capabilities.ts; parity test in sandbox-tools.test.ts)

/**
 * The bounds of contracts `SANDBOX_LIMITS` the cell checks before posting (the API re-validates everything with the
 * strict contract schemas) and `MAX_SANDBOX_CALLS_PER_TURN` (`callsPerTurn`).
 */
export const SANDBOX_LIMITS = {
  execTimeoutMaxSeconds: 600,
  argvMax: 64,
  argMaxChars: 8192,
  pathMaxChars: 1024,
  readMaxBytes: 262_144,
  writeMaxBytes: 1_048_576,
  /** Sandbox and browser calls per turn, separate from the cap of 8 (D-11 F-7). */
  callsPerTurn: 40,
} as const;

/**
 * The cell's budget of contracts `SANDBOX_TIMEOUTS_MS` (CI p142/p164/p178): longer than the API's deadline of every
 * sandbox call (a cold start of the bot's shell included), so the API's own answer (`starting`, `timeout` included)
 * always arrives first; below OpenClaw's 90 s for a Codex-harness tool.
 */
export const SANDBOX_TIMEOUTS_MS = {
  cellCall: 85_000,
} as const;

/** The eight `ocw_sandbox_*` tools (contracts `SANDBOX_TOOL_NAMES`). */
export const SANDBOX_TOOL_NAMES = [
  "ocw_sandbox_exec",
  "ocw_sandbox_process",
  "ocw_sandbox_read",
  "ocw_sandbox_write",
  "ocw_sandbox_list",
  "ocw_sandbox_delete",
  "ocw_sandbox_share",
  "ocw_sandbox_import",
] as const;
export type SandboxToolName = (typeof SANDBOX_TOOL_NAMES)[number];

/** Each sandbox tool's own Agent Channel route (self-validated: never `/tool-calls`). */
export const SANDBOX_TOOL_ROUTES: Readonly<Record<SandboxToolName, string>> = {
  ocw_sandbox_exec: "/sandbox/exec",
  ocw_sandbox_process: "/sandbox/process",
  ocw_sandbox_read: "/sandbox/read",
  ocw_sandbox_write: "/sandbox/write",
  ocw_sandbox_list: "/sandbox/list",
  ocw_sandbox_delete: "/sandbox/delete",
  ocw_sandbox_share: "/sandbox/share",
  ocw_sandbox_import: "/sandbox/import",
};

/** Why the API refused a sandbox call (contracts `SandboxRefusal`); the model reads one fixed sentence per code. */
export const SANDBOX_REFUSALS = [
  "no_trigger",
  "sandbox_off",
  "module_off",
  "bot_off",
  "not_allowed",
  "killed",
  "cap_reached",
  "cpu_budget",
  "disk_full",
  "budget_exhausted",
  "tainted",
  "member_data",
  "audience_narrower",
  "approval_required",
  "approval_pending",
  "approval_denied",
  "approval_used",
  "too_many_pending",
  "policy_changed",
  "service_unavailable",
  "timeout",
  "not_found",
  "too_large",
  "invalid_path",
  "busy",
  "starting",
] as const;
export const SandboxRefusal = z.enum(SANDBOX_REFUSALS);
export type SandboxRefusal = z.infer<typeof SandboxRefusal>;

/**
 * Same rule as contracts `SandboxRelativePath`: relative and normalised (no leading `/`, no `.`/`..`/empty segment, no
 * `\`, no NUL), at most 1024 characters; `""` is the workspace root, allowed only where the contract allows it.
 */
export function isSandboxPath(p: string, allowRoot: boolean): boolean {
  if (p.length > SANDBOX_LIMITS.pathMaxChars) return false;
  if (p === "") return allowRoot;
  if (p.includes("\u0000") || p.includes("\\")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

type TurnRef = { eventId: string; agentId: string };

/** `POST /sandbox/exec`: an argv array (never a shell string; `sh -c` is just an argv). */
export type AgentChannelSandboxExec = TurnRef & {
  argv: string[];
  cwd?: string;
  timeoutSeconds?: number;
  background?: boolean;
};
/** `POST /sandbox/process`: poll or kill a process an exec yielded. */
export type AgentChannelSandboxProcess = TurnRef & { processId: string; action: "poll" | "kill" };
export type AgentChannelSandboxRead = TurnRef & { path: string; offset?: number; limit?: number };
export type AgentChannelSandboxWrite = TurnRef & {
  path: string;
  content: string;
  mode: "create" | "overwrite" | "append";
};
export type AgentChannelSandboxList = TurnRef & { path: string };
export type AgentChannelSandboxDelete = TurnRef & { path: string; recursive?: boolean };
export type AgentChannelSandboxShare = TurnRef & { path: string };
export type AgentChannelSandboxImport = TurnRef & { attachmentId: string; path?: string };

const ExecCommon = {
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  durationMs: z.number().int().nonnegative(),
};
/** Finished, or still running under a process id (unknown fields dropped). */
export const AgentChannelSandboxExecResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("exited"), exitCode: z.number().int(), ...ExecCommon }),
  z.object({ status: z.literal("running"), processId: z.string().min(1).max(64), ...ExecCommon }),
]);
export type AgentChannelSandboxExecResponse = z.infer<typeof AgentChannelSandboxExecResponse>;

export const AgentChannelSandboxReadResponse = z.object({
  path: z.string(),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]),
  size: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type AgentChannelSandboxReadResponse = z.infer<typeof AgentChannelSandboxReadResponse>;

export const AgentChannelSandboxWriteResponse = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
});
export type AgentChannelSandboxWriteResponse = z.infer<typeof AgentChannelSandboxWriteResponse>;

export const SandboxFileEntry = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.enum(["file", "dir"]),
  size: z.number().int().nonnegative().nullable(),
  modifiedAt: z.string(),
  hidden: z.boolean(),
});
export type SandboxFileEntry = z.infer<typeof SandboxFileEntry>;

export const AgentChannelSandboxListResponse = z.object({
  path: z.string(),
  entries: z.array(SandboxFileEntry),
  more: z.number().int().nonnegative(),
});
export type AgentChannelSandboxListResponse = z.infer<typeof AgentChannelSandboxListResponse>;

export const AgentChannelSandboxDeleteResponse = z.object({
  path: z.string(),
  deleted: z.number().int().nonnegative(),
});
export type AgentChannelSandboxDeleteResponse = z.infer<typeof AgentChannelSandboxDeleteResponse>;

export const AgentChannelSandboxShareResponse = z.object({
  attachmentId: Id,
  name: z.string(),
  size: z.number().int().nonnegative(),
});
export type AgentChannelSandboxShareResponse = z.infer<typeof AgentChannelSandboxShareResponse>;

export const AgentChannelSandboxImportResponse = AgentChannelSandboxWriteResponse;
export type AgentChannelSandboxImportResponse = z.infer<typeof AgentChannelSandboxImportResponse>;

/** Per tool: the body it posts and the answer it parses. */
export type SandboxToolBodies = {
  ocw_sandbox_exec: AgentChannelSandboxExec;
  ocw_sandbox_process: AgentChannelSandboxProcess;
  ocw_sandbox_read: AgentChannelSandboxRead;
  ocw_sandbox_write: AgentChannelSandboxWrite;
  ocw_sandbox_list: AgentChannelSandboxList;
  ocw_sandbox_delete: AgentChannelSandboxDelete;
  ocw_sandbox_share: AgentChannelSandboxShare;
  ocw_sandbox_import: AgentChannelSandboxImport;
};
export const SANDBOX_TOOL_RESPONSES = {
  ocw_sandbox_exec: AgentChannelSandboxExecResponse,
  ocw_sandbox_process: AgentChannelSandboxExecResponse,
  ocw_sandbox_read: AgentChannelSandboxReadResponse,
  ocw_sandbox_write: AgentChannelSandboxWriteResponse,
  ocw_sandbox_list: AgentChannelSandboxListResponse,
  ocw_sandbox_delete: AgentChannelSandboxDeleteResponse,
  ocw_sandbox_share: AgentChannelSandboxShareResponse,
  ocw_sandbox_import: AgentChannelSandboxImportResponse,
} as const satisfies Record<SandboxToolName, z.ZodType>;
export type SandboxToolResponses = {
  [K in SandboxToolName]: z.infer<(typeof SANDBOX_TOOL_RESPONSES)[K]>;
};

// ---------------------------------------------------------------- confined browser tools (07.8, mirror of contracts
// browser.ts; parity test in browser-tools.test.ts)

/** The bounds of contracts `BROWSER_LIMITS` the cell checks before posting. */
export const BROWSER_LIMITS = {
  urlMaxChars: 2000,
  typeMaxChars: 2000,
  reasonMaxChars: 200,
} as const;

/**
 * The cell's budgets of contracts `BROWSER_TIMEOUTS_MS` (CI p64/p66): longer than the API's deadline of each call, so
 * the API's own answer (its `timeout` included) always arrives first; below OpenClaw's 90 s for a Codex-harness tool.
 */
export const BROWSER_TIMEOUTS_MS = {
  cellCall: 65_000,
  cellOpen: 85_000,
} as const;

/** The seven `ocw_browser_*` tools (contracts `BROWSER_TOOL_NAMES`). */
export const BROWSER_TOOL_NAMES = [
  "ocw_browser_open",
  "ocw_browser_snapshot",
  "ocw_browser_act",
  "ocw_browser_screenshot",
  "ocw_browser_wait",
  "ocw_browser_signin",
  "ocw_browser_close",
] as const;
export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

/** Each browser tool's own Agent Channel route (self-validated: never `/tool-calls`). */
export const BROWSER_TOOL_ROUTES: Readonly<Record<BrowserToolName, string>> = {
  ocw_browser_open: "/browser/open",
  ocw_browser_snapshot: "/browser/snapshot",
  ocw_browser_act: "/browser/act",
  ocw_browser_screenshot: "/browser/screenshot",
  ocw_browser_wait: "/browser/wait",
  ocw_browser_signin: "/browser/signin",
  ocw_browser_close: "/browser/close",
};

/** Why the API refused a browser call (contracts `BrowserRefusal`); the model reads one fixed sentence per code. */
export const BROWSER_REFUSALS = [
  "no_trigger",
  "sandbox_off",
  "module_off",
  "bot_off",
  "not_allowed",
  "killed",
  "cap_reached",
  "cpu_budget",
  "budget_exhausted",
  "tainted",
  "approval_required",
  "approval_pending",
  "approval_denied",
  "approval_used",
  "too_many_pending",
  "policy_changed",
  "service_unavailable",
  "timeout",
  "not_found",
  "too_large",
  "busy",
  "paused",
  "no_context",
  "signin_not_allowed",
  "signin_pending",
  "element_gone",
  "navigation_refused",
  "screenshot_unavailable",
] as const;
export const BrowserRefusal = z.enum(BROWSER_REFUSALS);
export type BrowserRefusal = z.infer<typeof BrowserRefusal>;

export const BROWSER_ACT_ACTIONS = ["click", "type", "select", "press", "scroll"] as const;
export const BROWSER_SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;

/** Same rule as contracts `BrowserUrl`: http(s), WHATWG-parsable, no user info, no control characters, ≤ 2000. */
export function isBrowserUrl(v: string): boolean {
  if (v.length < 1 || v.length > BROWSER_LIMITS.urlMaxChars || hasControlCharacter(v)) return false;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  return (u.protocol === "http:" || u.protocol === "https:") && u.username === "" && u.password === "";
}

/** Same rule as contracts `BrowserRef`: an opaque snapshot ref, never a CSS, XPath or text selector. */
export function isBrowserRef(v: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/u.test(v);
}

export type AgentChannelBrowserOpen = TurnRef & { url: string };
export type AgentChannelBrowserAct = TurnRef & {
  action: (typeof BROWSER_ACT_ACTIONS)[number];
  ref?: string;
  text?: string;
  key?: string;
  option?: string;
  direction?: (typeof BROWSER_SCROLL_DIRECTIONS)[number];
};
export type AgentChannelBrowserWait = TurnRef & { for: "load" | "text" | "time"; text?: string; ms?: number };
export type AgentChannelBrowserSignIn = TurnRef & { reason: string };

export const AgentChannelBrowserOpenResponse = z.object({
  contextId: Id,
  host: z.string().min(1),
  secure: z.boolean(),
  title: z.string(),
  signedIn: z.boolean(),
});
export type AgentChannelBrowserOpenResponse = z.infer<typeof AgentChannelBrowserOpenResponse>;

/** Unknown fields are dropped: the plugin renders only the redacted text the contract defines (P-10). */
export const AgentChannelBrowserSnapshotResponse = z.object({
  contextId: Id,
  host: z.string().min(1),
  title: z.string(),
  text: z.string(),
  truncated: z.boolean(),
  signedIn: z.boolean(),
});
export type AgentChannelBrowserSnapshotResponse = z.infer<typeof AgentChannelBrowserSnapshotResponse>;

export const BrowserDownload = z.object({
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  stored: z.enum(["workspace", "conversation"]),
  path: z.string().optional(),
  attachmentId: Id.optional(),
});

export const AgentChannelBrowserActResponse = z.object({
  contextId: Id,
  host: z.string().min(1),
  signedIn: z.boolean(),
  navigated: z.boolean(),
  download: BrowserDownload.nullable(),
});
export type AgentChannelBrowserActResponse = z.infer<typeof AgentChannelBrowserActResponse>;

export const AgentChannelBrowserScreenshotResponse = z.object({
  contextId: Id,
  host: z.string().min(1),
  image: z.object({
    mimeType: z.literal("image/jpeg"),
    data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/u),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    masked: z.number().int().nonnegative(),
  }),
});
export type AgentChannelBrowserScreenshotResponse = z.infer<typeof AgentChannelBrowserScreenshotResponse>;

export const AgentChannelBrowserWaitResponse = z.object({
  contextId: Id,
  host: z.string().min(1),
  ok: z.boolean(),
});
export type AgentChannelBrowserWaitResponse = z.infer<typeof AgentChannelBrowserWaitResponse>;

export const AgentChannelBrowserSignInResponse = z.object({
  posted: z.literal(true),
  host: z.string().min(1),
});
export type AgentChannelBrowserSignInResponse = z.infer<typeof AgentChannelBrowserSignInResponse>;

export const AgentChannelBrowserCloseResponse = z.object({ closed: z.literal(true) });
export type AgentChannelBrowserCloseResponse = z.infer<typeof AgentChannelBrowserCloseResponse>;

/** Per tool: the body it posts and the answer it parses. */
export type BrowserToolBodies = {
  ocw_browser_open: AgentChannelBrowserOpen;
  ocw_browser_snapshot: TurnRef;
  ocw_browser_act: AgentChannelBrowserAct;
  ocw_browser_screenshot: TurnRef;
  ocw_browser_wait: AgentChannelBrowserWait;
  ocw_browser_signin: AgentChannelBrowserSignIn;
  ocw_browser_close: TurnRef;
};
export const BROWSER_TOOL_RESPONSES = {
  ocw_browser_open: AgentChannelBrowserOpenResponse,
  ocw_browser_snapshot: AgentChannelBrowserSnapshotResponse,
  ocw_browser_act: AgentChannelBrowserActResponse,
  ocw_browser_screenshot: AgentChannelBrowserScreenshotResponse,
  ocw_browser_wait: AgentChannelBrowserWaitResponse,
  ocw_browser_signin: AgentChannelBrowserSignInResponse,
  ocw_browser_close: AgentChannelBrowserCloseResponse,
} as const satisfies Record<BrowserToolName, z.ZodType>;
export type BrowserToolResponses = {
  [K in BrowserToolName]: z.infer<(typeof BROWSER_TOOL_RESPONSES)[K]>;
};

// ---------------------------------------------------------------- confined tool flags (07.8, mirror of contracts
// CONFINED_TOOL_FLAGS; parity test in tool-guard.test.ts)

export const CONFINED_TOOL_NAMES = [...SANDBOX_TOOL_NAMES, ...BROWSER_TOOL_NAMES] as const;
export type ConfinedToolName = (typeof CONFINED_TOOL_NAMES)[number];

/**
 * The confined tools' static taint flags (D-11 F-7): command output, file content, listings and page text are untrusted;
 * only `ocw_sandbox_share` changes something outside the sandbox (a conversation attachment). `ocw_browser_act` is
 * side-effecting only while a member's session is loaded, which the API decides per call (07.8-14).
 */
export const CONFINED_TOOL_FLAGS: Readonly<
  Record<ConfinedToolName, { untrustedOutput: boolean; sideEffecting: boolean }>
> = {
  ocw_sandbox_exec: { untrustedOutput: true, sideEffecting: false },
  ocw_sandbox_process: { untrustedOutput: true, sideEffecting: false },
  ocw_sandbox_read: { untrustedOutput: true, sideEffecting: false },
  ocw_sandbox_write: { untrustedOutput: false, sideEffecting: false },
  ocw_sandbox_list: { untrustedOutput: true, sideEffecting: false },
  ocw_sandbox_delete: { untrustedOutput: false, sideEffecting: false },
  ocw_sandbox_share: { untrustedOutput: false, sideEffecting: true },
  ocw_sandbox_import: { untrustedOutput: false, sideEffecting: false },
  ocw_browser_open: { untrustedOutput: true, sideEffecting: false },
  ocw_browser_snapshot: { untrustedOutput: true, sideEffecting: false },
  ocw_browser_act: { untrustedOutput: true, sideEffecting: false },
  ocw_browser_screenshot: { untrustedOutput: true, sideEffecting: false },
  ocw_browser_wait: { untrustedOutput: true, sideEffecting: false },
  ocw_browser_signin: { untrustedOutput: false, sideEffecting: false },
  ocw_browser_close: { untrustedOutput: false, sideEffecting: false },
};

const CONFINED_SET: ReadonlySet<string> = new Set(CONFINED_TOOL_NAMES);
export function isConfinedTool(name: string): name is ConfinedToolName {
  return CONFINED_SET.has(name);
}
