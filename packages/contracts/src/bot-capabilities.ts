import { z } from "zod";
import { AgentScope, AgentStatus, ModelProviderKind } from "./agent";
import { TurnConsult } from "./agent-chains";
import { BOT_TASK_LIMITS, TurnTask } from "./bot-tasks";
import { TurnWorkZone } from "./bot-work-zone";
import { Id, IsoDateTime } from "./common";
import { MemberAccountResourceKind } from "./connectors";
import { MEMORY_LIMITS, MemoryPath, MemoryScopeKind } from "./memory";
import { Permission } from "./permissions";
import { SANDBOX_LIMITS } from "./sandbox";

/**
 * Bot capabilities (Phase 3.1, D-06 … D-08; BOT-04, BOT-05, BOT-10). Defined ONCE here; the API computes
 * them (`modules/bot-capabilities`), the cell enforces the result it receives per turn, the web renders it.
 *
 * Effective capability = bot toggle ∧ org-wide policy ∧ (personal bot ? personal policy : true) ∧ configured
 * ∧ resolver(agent ∩ asking human). Every refusal carries a `CapabilityDenialReason` the UI can show.
 *
 * `DANGEROUS_TOOL_NAMES` / `isDangerousToolName` are mirrored in `infra/openclaw/render-config.mjs` (global
 * deny list) and `apps/openclaw-channel` (tool gate); 03.1-04 adds the parity test. Never put the wildcard
 * `*` or a `BUILTIN_TOOLS` name in it.
 */

// ---------------------------------------------------------------- per-bot toggles

/** `all` = answer every human message in a channel (team bots only, D-12); `mentions` = only when @mentioned. */
export const ReplyMode = z.enum(["mentions", "all"]);
export type ReplyMode = z.infer<typeof ReplyMode>;

/**
 * Built-in capabilities governed by the org policy (`replyModeAll` = reply mode `all`). `longTasks` (07.17.1.1.2 D-04):
 * "Allow long tasks", a bot keeps working across turns on its own, within `BotPolicy.tasks`.
 */
export const BuiltinCapability = z.enum(["internet", "memory", "dateTime", "replyModeAll", "longTasks"]);
export type BuiltinCapability = z.infer<typeof BuiltinCapability>;

/** Highest daily limit any bot may have (team bots; personal bots are capped by the org policy). */
export const MAX_DAILY_LIMIT = 10_000;

export const BotCapabilities = z.object({
  /** Web search + page fetch (read-only). */
  internet: z.boolean(),
  /** Remembers facts per human, only in that human's DM (D-10). */
  memory: z.boolean(),
  /** The turn carries the asking human's exact local time (D-12). */
  dateTime: z.boolean(),
  replyMode: ReplyMode,
  /** Turns per UTC day (D-11). */
  dailyLimit: z.number().int().min(1).max(MAX_DAILY_LIMIT),
  /**
   * Phase 07.8 (D-12): the per-bot switches of the confined tools, off by default. A stored object without them parses
   * as off. Effective only with the organization switch, no kill, the module allowed for the human and agent ∩ human.
   */
  sandbox: z.boolean().default(false),
  browser: z.boolean().default(false),
  /**
   * Phase 07.17.1.1.2 (D-04): the bot may start a long task that keeps working across turns. On by default (a stored
   * object without it parses as on); effective only with the organization's "Allow long tasks" switch (and its
   * personal sub-switch for a personal bot).
   */
  longTasks: z.boolean().default(true),
});
export type BotCapabilities = z.infer<typeof BotCapabilities>;

/** D-06 defaults per bot scope (07.8 D-12: Sandbox and Browser off for every bot). */
export const DEFAULT_CAPABILITIES: Record<AgentScope, BotCapabilities> = {
  team: {
    internet: false,
    memory: false,
    dateTime: true,
    replyMode: "mentions",
    dailyLimit: 100,
    sandbox: false,
    browser: false,
    longTasks: true,
  },
  personal: {
    internet: false,
    memory: true,
    dateTime: true,
    replyMode: "mentions",
    dailyLimit: 30,
    sandbox: false,
    browser: false,
    longTasks: true,
  },
};

// ---------------------------------------------------------------- organization policy

export const CapabilityPolicyEntry = z.object({
  /** Allowed for every bot of the organization. */
  orgWide: z.boolean(),
  /** Additionally allowed for personal bots. */
  personal: z.boolean(),
});
export type CapabilityPolicyEntry = z.infer<typeof CapabilityPolicyEntry>;

/** `duckduckgo` is bundled in the cell (keyless); `searxng` needs the compose `search` profile (D-09). */
export const SearchProvider = z.enum(["duckduckgo", "searxng"]);
export type SearchProvider = z.infer<typeof SearchProvider>;

/**
 * Phase 07.17.1.1.2 (D-04, PD-09): the organization's long-task limits. A task snapshots `maxTurns` and `maxHours` at
 * start; `maxRunning` caps the organization's active tasks (0 = no task may start).
 */
export const BotTaskPolicyLimits = z.object({
  maxTurns: z.number().int().min(1).max(BOT_TASK_LIMITS.maxTurnsCap),
  maxHours: z.number().int().min(1).max(BOT_TASK_LIMITS.maxHoursCap),
  maxRunning: z.number().int().min(0).max(BOT_TASK_LIMITS.maxRunningCap),
});
export type BotTaskPolicyLimits = z.infer<typeof BotTaskPolicyLimits>;

export const BotPolicy = z.object({
  capabilities: z.object({
    internet: CapabilityPolicyEntry,
    memory: CapabilityPolicyEntry,
    dateTime: CapabilityPolicyEntry,
    replyModeAll: CapabilityPolicyEntry,
    longTasks: CapabilityPolicyEntry,
  }),
  searchProvider: SearchProvider,
  maxPersonalBotsPerUser: z.number().int().min(0).max(20),
  personalDailyLimitMax: z.number().int().min(1).max(10_000),
  /** `provider/modelId` entries; empty = every allowed model of the organization. */
  personalAllowedModels: z.array(z.string().max(250)).max(100),
  /** Phase 07.17.1.1.2 (D-04): the long-task limits. */
  tasks: BotTaskPolicyLimits,
  /** null = no policy saved yet (the defaults apply). */
  updatedAt: IsoDateTime.nullable(),
});
export type BotPolicy = z.infer<typeof BotPolicy>;

/**
 * `GET/PUT /api/v1/bot-policy` response: the policy plus the search providers the cell can run right now
 * (bundled or installed; SearXNG also needs `OCW_SEARXNG_URL`, the compose `search` profile).
 */
export const BotPolicyView = BotPolicy.extend({
  availableSearchProviders: z.array(SearchProvider),
});
export type BotPolicyView = z.infer<typeof BotPolicyView>;

const ALLOW = { orgWide: true, personal: true } as const;

/** Defaults when an organization has no `bot_policies` row: everything allowed (D-06). */
export const DEFAULT_BOT_POLICY: Omit<BotPolicy, "updatedAt"> = {
  capabilities: { internet: ALLOW, memory: ALLOW, dateTime: ALLOW, replyModeAll: ALLOW, longTasks: ALLOW },
  searchProvider: "duckduckgo",
  maxPersonalBotsPerUser: 3,
  personalDailyLimitMax: 100,
  personalAllowedModels: [],
  tasks: {
    maxTurns: BOT_TASK_LIMITS.maxTurnsDefault,
    maxHours: BOT_TASK_LIMITS.maxHoursDefault,
    maxRunning: BOT_TASK_LIMITS.maxRunningDefault,
  },
};

/**
 * `PUT /api/v1/bot-policy`: any subset; `capabilities` entries are merged per capability and `tasks` per limit (a patch
 * naming one limit leaves the others unchanged).
 */
export const UpdateBotPolicyRequest = BotPolicy.omit({ updatedAt: true })
  .extend({
    capabilities: z
      .object({
        internet: CapabilityPolicyEntry,
        memory: CapabilityPolicyEntry,
        dateTime: CapabilityPolicyEntry,
        replyModeAll: CapabilityPolicyEntry,
        longTasks: CapabilityPolicyEntry,
      })
      .partial(),
    tasks: BotTaskPolicyLimits.partial(),
  })
  .partial();
export type UpdateBotPolicyRequest = z.infer<typeof UpdateBotPolicyRequest>;

// ---------------------------------------------------------------- effective view

export const CapabilityDenialReason = z.enum([
  /** The organization turned it off for every bot. */
  "org_policy",
  /** The organization turned it off for personal bots. */
  "personal_policy",
  /** Nothing is set up to provide it (e.g. no search provider). */
  "not_configured",
  /** A permission rule denies it to the asking human (agent ∩ human). */
  "denied_for_you",
  /** The MCP server or plugin providing the tool is not ready / installed. */
  "source_unavailable",
  /** The tool name belongs to a class that is never offered (shell, filesystem, browser, …). */
  "dangerous",
  /** Personal bots only live in their owner's DM (reply mode `all` is a channel setting). */
  "dm_only",
]);
export type CapabilityDenialReason = z.infer<typeof CapabilityDenialReason>;

export const EffectiveCapability = z.object({
  /** The bot's own toggle. */
  enabled: z.boolean(),
  /** What the bot really gets on its next turn for this viewer. */
  effective: z.boolean(),
  /**
   * Why the capability is not (or, while the toggle is off, would not be) effective; null when nothing stands
   * in the way. The UI shows it and refuses the toggle, so a denied capability is never switched on in vain.
   */
  reason: CapabilityDenialReason.nullable(),
});
export type EffectiveCapability = z.infer<typeof EffectiveCapability>;

export const ToolSourceKind = z.enum(["mcp", "plugin"]);
export type ToolSourceKind = z.infer<typeof ToolSourceKind>;

/** One MCP or plugin tool enabled on one bot. `tool` is the OpenClaw tool name (`<safe>__<tool>` for MCP). */
export const ToolGrant = z.object({
  sourceKind: ToolSourceKind,
  sourceId: Id,
  tool: z.string().min(1).max(64),
});
export type ToolGrant = z.infer<typeof ToolGrant>;

export const CatalogTool = ToolGrant.extend({
  sourceName: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  sideEffecting: z.boolean(),
  granted: z.boolean(),
  effective: z.boolean(),
  reason: CapabilityDenialReason.nullable(),
});
export type CatalogTool = z.infer<typeof CatalogTool>;

export const BotUsage = z.object({
  /** Turns delivered today (UTC day). */
  today: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  /** Next UTC midnight. */
  resetsAt: IsoDateTime,
});
export type BotUsage = z.infer<typeof BotUsage>;

/**
 * Phase 07.8 (R11): one per-bot confined switch as the bot page shows it. `available` is false while something above
 * the bot stands in the way: the organization switch (`org_off`), the kill switch, the module for this viewer or
 * sandboxd being down.
 */
export const ConfinedCapabilityState = z.object({
  enabled: z.boolean(),
  available: z.boolean(),
  reason: z.enum(["org_off", "killed", "module_off", "service_down"]).nullable(),
});
export type ConfinedCapabilityState = z.infer<typeof ConfinedCapabilityState>;

/** `GET /api/v1/agents/:id/capabilities` — toggles, the effective result for the caller, tools and usage. */
export const BotCapabilityView = z.object({
  agentId: Id,
  scope: AgentScope,
  capabilities: BotCapabilities,
  effective: z.object({
    internet: EffectiveCapability,
    memory: EffectiveCapability,
    dateTime: EffectiveCapability,
    replyModeAll: EffectiveCapability,
    /** Phase 07.17.1.1.2 (D-04): "Long tasks"; absent on older payloads. */
    longTasks: EffectiveCapability.optional(),
  }),
  tools: z.array(CatalogTool),
  usage: BotUsage,
  /** Highest `dailyLimit` this bot accepts: the org's personal maximum for personal bots. */
  dailyLimitMax: z.number().int().positive(),
  viewerCan: z.array(Permission),
  /** Phase 07.8 (R11): the Sandbox and Browser rows; absent on older payloads. */
  confined: z.object({ sandbox: ConfinedCapabilityState, browser: ConfinedCapabilityState }).optional(),
  /**
   * How many of the bot's usable tools do not fit in one turn (`TURN_TOOLS_MAX`, counted on a channel turn after the
   * platform tools), so the sheet can say so instead of the bot failing silently. Absent on older payloads.
   */
  toolsOverLimit: z.number().int().nonnegative().optional(),
});
export type BotCapabilityView = z.infer<typeof BotCapabilityView>;

/**
 * `PATCH /api/v1/agents/:id/capabilities`. `tools`, when present, REPLACES the bot's grant set. The 07.8 switches are
 * plain optionals here: a patch that does not name them never resets them to their default.
 */
export const UpdateBotCapabilitiesRequest = BotCapabilities.partial().extend({
  sandbox: z.boolean().optional(),
  browser: z.boolean().optional(),
  longTasks: z.boolean().optional(),
  tools: z.array(ToolGrant).max(200).optional(),
});
export type UpdateBotCapabilitiesRequest = z.infer<typeof UpdateBotCapabilitiesRequest>;

// ---------------------------------------------------------------- personal-bot governance (admins)

/** Governance metadata only: NEVER instructions, DMs or memory (D-01, Pitfall 5). */
export const BotGovernanceEntry = z.object({
  id: Id,
  name: z.string(),
  username: z.string(),
  avatarUrl: z.string().nullable(),
  owner: z.object({ id: Id, displayName: z.string() }),
  model: z.object({ provider: ModelProviderKind, modelId: z.string() }),
  status: AgentStatus,
  capabilities: BotCapabilities,
  usage: BotUsage,
  createdAt: IsoDateTime,
});
export type BotGovernanceEntry = z.infer<typeof BotGovernanceEntry>;

export const BotGovernanceList = z.object({ bots: z.array(BotGovernanceEntry) });
export type BotGovernanceList = z.infer<typeof BotGovernanceList>;

// ---------------------------------------------------------------- memory (D-10)

export const MemoryItem = z.object({ id: Id, text: z.string().min(1).max(500), createdAt: IsoDateTime });
export type MemoryItem = z.infer<typeof MemoryItem>;

export const MemoryList = z.object({ items: z.array(MemoryItem) });
export type MemoryList = z.infer<typeof MemoryList>;

// ---------------------------------------------------------------- per-turn context (D-07)

/** The asking human's local time (D-12). */
export const TurnNow = z.object({
  iso: IsoDateTime,
  /** IANA zone, `UTC` when the client sent none or an invalid one. */
  timeZone: z.string().max(64),
  /** Human-readable, e.g. "Monday 5 October 2026 at 12:00". */
  local: z.string().max(80),
});
export type TurnNow = z.infer<typeof TurnNow>;

export const TurnToolFlags = z.object({
  /** The tool returns third-party content (prompt-injection source): taints the turn. */
  untrustedOutput: z.boolean(),
  /** Blocked after a taint unless the source is trusted for chained calls (D-08). */
  sideEffecting: z.boolean(),
  /**
   * Phase 07.5 (D-01): the tool has an approval policy for this bot and this human; the gate sends its full arguments
   * and leaves the taint decision to the API (`when_tainted` asks only after outside content). Absent = no policy.
   */
  approval: z.enum(["always", "when_tainted"]).optional(),
});
export type TurnToolFlags = z.infer<typeof TurnToolFlags>;

/**
 * `agent.mention.v1.turn`: exactly what this bot may do for this human on this turn. A plugin that receives
 * no `turn` runs with no tools (fail closed).
 */
/**
 * Why a tool the bot could use is not offered on this turn. Shared AI chats (06-10, D-06): `not_every_participant` (a
 * joined human may not use it), `shared_with_group` (a team, department or the organization holds a grant, so the readers
 * are not a list) or `denied_for_you` (the asking human may not use it). Any delivery (07.4, D-03): `member_account` (the
 * tool would act with the asker's own account or personal key, and the conversation is not a private one with the bot
 * nor shared for it by the asker).
 */
export const TurnWithheldReason = z.enum([
  "not_every_participant",
  "shared_with_group",
  "denied_for_you",
  "member_account",
  // 07.8-14 (additive): the bot's sandbox or browser is switched on, but the organization's Sandbox & Browser switch is
  // off (`sandbox_off`) or an admin stopped every sandbox and browser (`killed`), so the bot can say why.
  "sandbox_off",
  "killed",
  // 07.17.1.1.2 code review WR-07 (additive; an older plugin reads any reason as "not available"): the turn already
  // carries `TURN_TOOLS_MAX` tools, so a task tool was not offered (`ocw_task_start`), or a granted tool gave its place to
  // the task's continue and finish on a turn of a running task.
  "turn_full",
]);
export type TurnWithheldReason = z.infer<typeof TurnWithheldReason>;

/**
 * The member account behind a `member_account` entry (07.4 R7): one entry per withheld per-member connector or personal
 * key, so the persona can link the share page (`?share=<conversation>&connector=<id>` / `&key=<id>`).
 */
export const TurnWithheldResource = z.object({
  kind: MemberAccountResourceKind,
  id: Id,
  name: z.string().max(80),
});
export type TurnWithheldResource = z.infer<typeof TurnWithheldResource>;

export const TurnWithheld = z.object({
  tool: z.string(),
  reason: TurnWithheldReason,
  resource: TurnWithheldResource.optional(),
});
export type TurnWithheld = z.infer<typeof TurnWithheld>;

/**
 * A `MEMORY.md` injected into a turn (Phase 07.2, D-02): the personal one (1-human DMs only) and the bot's own one.
 * `content` is cut to `MEMORY_LIMITS.turnFileBytes` UTF-8 bytes, with `truncated` set.
 */
export const TurnMemoryFile = z.object({
  scopeKind: MemoryScopeKind,
  scopeId: Id,
  path: MemoryPath,
  version: z.number().int().positive(),
  content: z.string().refine((s) => new TextEncoder().encode(s).length <= MEMORY_LIMITS.turnFileBytes, {
    message: "too large",
  }),
  truncated: z.boolean(),
});
export type TurnMemoryFile = z.infer<typeof TurnMemoryFile>;

// ---------------------------------------------------------------- turn attachments (Phase 07.15, D-02, D-04, D-05)

/**
 * How the API classifies an attachment for a bot (07.15 PD-07): `image` by sniffed type, `pdf` by sniffed
 * `application/pdf`, `text` for text-like files (text, Markdown, CSV, JSON, code, SVG, HTML, XML: always returned as text,
 * never rendered), `other` for everything else (archives, office documents, audio, video).
 */
export const TurnAttachmentKind = z.enum(["image", "text", "pdf", "other"]);
export type TurnAttachmentKind = z.infer<typeof TurnAttachmentKind>;

/**
 * How this bot can use the file on this turn, decided server-side per bot (D-02, D-04, PD-04): `read` through
 * `ocw_attachment_read`, `import` only by copying it into the bot's sandbox with `ocw_sandbox_import`, `none` neither.
 */
export const TurnAttachmentAccess = z.enum(["read", "import", "none"]);
export type TurnAttachmentAccess = z.infer<typeof TurnAttachmentAccess>;

/**
 * The only notes a turn attachment may carry (D-04): a fixed server sentence that tells the bot up front why it cannot
 * read a file, so it can tell the person. Never provider text or file content.
 */
export const TURN_ATTACHMENT_NOTES = {
  modelNoImages: "This bot's model can't see images.",
  cannotReadImport: "Can't be read as text; copy it into the sandbox with ocw_sandbox_import.",
  cannotReadNoSandbox: "Can't be read as text, and this bot has no sandbox here.",
  cannotReadNarrower:
    "Can't be read as text, and this bot's sandbox is shared more widely than this conversation, so it can't be copied there.",
  tooLarge: "Too large to read.",
  readNotOffered: "Can't be read on this turn: it already has the most tools a turn can offer.",
} as const;
export type TurnAttachmentNote = (typeof TURN_ATTACHMENT_NOTES)[keyof typeof TURN_ATTACHMENT_NOTES];

/**
 * One attachment of the messages a turn reads (07.15, D-02): metadata only, decided server-side per bot at delivery.
 * Never file content, a presigned URL, a storage key or a path (ADR-0015); the bot fetches the content through
 * `ocw_attachment_read`, which the API re-decides on every call. `name` was sanitized at upload; the plugin labels it
 * again before the model sees it.
 */
export const TurnAttachment = z.object({
  id: Id,
  /** The message the file is attached to (the current one or one of the turn's history window). */
  messageId: Id,
  name: z.string().max(255),
  mediaType: z.string().max(127),
  size: z.number().int().nonnegative(),
  kind: TurnAttachmentKind,
  access: TurnAttachmentAccess,
  /** One of `TURN_ATTACHMENT_NOTES` when the bot cannot read the file as listed (D-04). */
  note: z.string().max(200).optional(),
});
export type TurnAttachment = z.infer<typeof TurnAttachment>;

/**
 * Bounds of the attachment reads (D-05, D-17; defaults changed in code, A-02). Characters are UTF-16 code units
 * (PD-07). `listPerTurn`: files listed on one turn (the rest are counted in `attachmentsMore`); `readsPerTurn` and
 * `charsPerTurn`: the turn's read budget, counted by the API apart from the cap of 8 tool calls; `charsPerFile`: the
 * longest text one read returns.
 */
export const ATTACHMENT_READ_LIMITS = {
  listPerTurn: 20,
  readsPerTurn: 20,
  charsPerTurn: 200_000,
  charsPerFile: 64_000,
} as const;

/**
 * The most tools one bot turn carries: platform tools first, then the bot's MCP and plugin tools. Raised from 64 on
 * 2026-11-11, because an ERP MCP server's tools past the cap were silently dropped and the bot said it could not use
 * them. 128 is the most function tools OpenAI's API accepts in one request.
 */
export const TURN_TOOLS_MAX = 128;

export const TurnContext = z.object({
  tools: z.array(z.string()).max(TURN_TOOLS_MAX),
  toolFlags: z.record(z.string(), TurnToolFlags),
  memory: z.array(MemoryItem).max(50),
  now: TurnNow.nullable(),
  maxToolCalls: z.number().int(),
  maxWebCalls: z.number().int(),
  /**
   * What was withheld and why, so the persona can say so. Never enables a tool. Any delivery kind: shared AI chats
   * since 06-10, every conversation for `member_account` since 07.4 (D-03).
   */
  withheld: z.array(TurnWithheld).max(64).optional(),
  /** Phase 07.2: memory files for this turn; optional so older payloads parse (`memory` stays for compatibility). */
  memoryFiles: z.array(TurnMemoryFile).max(2).optional(),
  /** Phase 07.8 (D-11 F-7): sandbox and browser calls this turn may make; absent on older payloads. */
  maxSandboxCalls: z.number().int().optional(),
  /**
   * Phase 07.7 (D-01, ADR-0027): present only when the turn is offered `ocw_consult_agent`: the bots it may consult
   * (decided by the API) and this turn's depth in its chain. Absent on older payloads and on every other turn.
   */
  consult: TurnConsult.optional(),
  /**
   * Phase 07.7 (D-09): the turn starts tainted (07.6 `taintedAtStart`: outside content, an inbound-rooted thread, a
   * consult answer that read web or MCP content); the plugin starts its local taint from it. Absent = untainted.
   */
  tainted: z.boolean().optional(),
  /**
   * Phase 07.15 (D-02, PD-04): the attachments of the messages this turn reads, the current message's files first, then
   * the history newest first, at most `ATTACHMENT_READ_LIMITS.listPerTurn`. Absent on older payloads and on turns
   * without files.
   */
  attachments: z.array(TurnAttachment).max(ATTACHMENT_READ_LIMITS.listPerTurn).optional(),
  /** Phase 07.15 (D-05): files of the conversation not listed because of the cap; absent when none. */
  attachmentsMore: z.number().int().nonnegative().optional(),
  /** Phase 07.15 (D-05, D-17): `ocw_attachment_read` calls this turn may make; absent on older payloads. */
  maxAttachmentReads: z.number().int().optional(),
  /** Phase 07.15 (D-05, D-17): characters all reads of this turn may return together; absent on older payloads. */
  maxAttachmentChars: z.number().int().optional(),
  /**
   * Phase 07.16 (D-05, PD-17): present only on turns of a bot whose Work Zone profile is active (offered with the
   * `WORK_SESSION_TOOL_NAMES`, six since 07.17.1.1): the runtime, device, projects, options, the bot's own sessions and
   * the file limit. Absent on older payloads and for every bot without a profile (BWZ-06).
   */
  workZone: TurnWorkZone.optional(),
  /**
   * Phase 07.17.1.1.2 (D-02, PD-07, PD-16): present on every turn of the bot in a thread with its active task (its own
   * turns of the task, and any other turn there, which may only read it): goal, notes, budget, times, the wait and the
   * background commands that ended. Absent on older payloads, without an active task and in AI chats (D-10).
   */
  task: TurnTask.optional(),
});
export type TurnContext = z.infer<typeof TurnContext>;

/** OpenClaw names of the built-in tools a capability maps to. */
export const BUILTIN_TOOLS = {
  webSearch: "web_search",
  webFetch: "web_fetch",
  memorySave: "ocw_memory_save",
  /** Phase 6 (AGENT-04, D-07): the persona posts or updates an Agent Card in the conversation of the turn. */
  agentCard: "ocw_agent_card",
  /**
   * Phase 07.1 (D-07, P-03): the agent creates a card or moves it / sets its waiting state on the turn's board. Offered
   * only on board channels (07.1-10); no turn offers it before then.
   */
  boardCard: "ocw_board_card",
  /**
   * Phase 07.2 (D-02): memory files through the Agent Channel API. List and read any scope the turn may read; write the
   * agent's own scopes; propose into shared ones (a person approves). Names avoid the dangerous-name word filter.
   */
  memoryList: "ocw_memory_list",
  memoryRead: "ocw_memory_read",
  memoryWrite: "ocw_memory_write",
  memoryPropose: "ocw_memory_propose",
  /**
   * Phase 07.4 (D-02, D-04, D-07): the only connector and keychain tools the cell sees. `ocw_connector_list` lists the
   * turn's per-member connector tools and keychain handles; `ocw_connector_call` runs one logical `<safeName>__<tool>`
   * with the asker's credential through the API; `ocw_http_request` sends a request with a keychain handle, the API
   * injecting the secret towards allowed hosts only.
   */
  connectorList: "ocw_connector_list",
  connectorCall: "ocw_connector_call",
  httpRequest: "ocw_http_request",
  /**
   * Phase 07.5 (D-03, P-08): Work Zone proposals. `ocw_work_zone_projects` lists the projects the turn's human may start
   * on; `ocw_start_work_zone` proposes a session (project, device, prompt, runtime; never a mode) as a card the human
   * starts. Offered only when the turn's human holds `work_session.create`; never approvable (their own flow).
   */
  workZoneProjects: "ocw_work_zone_projects",
  startWorkZone: "ocw_start_work_zone",
  /**
   * Phase 07.8 (D-02, P-07): the confined tools. Each posts to the Agent Channel API, which decides and audits the call
   * and runs it in the bot's own sandbox (`sandboxd`). Listed here so `isDangerousToolName` never refuses them although
   * their names hold `exec`, `process` or `browser` (Pitfall 2). There is no page-script, DOM, cookie, storage, HAR or
   * network-log tool, and no tool takes a selector or a script.
   */
  sandboxExec: "ocw_sandbox_exec",
  sandboxProcess: "ocw_sandbox_process",
  sandboxRead: "ocw_sandbox_read",
  sandboxWrite: "ocw_sandbox_write",
  sandboxList: "ocw_sandbox_list",
  sandboxDelete: "ocw_sandbox_delete",
  sandboxShare: "ocw_sandbox_share",
  sandboxImport: "ocw_sandbox_import",
  browserOpen: "ocw_browser_open",
  browserSnapshot: "ocw_browser_snapshot",
  browserAct: "ocw_browser_act",
  browserScreenshot: "ocw_browser_screenshot",
  browserWait: "ocw_browser_wait",
  browserSignIn: "ocw_browser_signin",
  browserClose: "ocw_browser_close",
  /**
   * Phase 07.6 (AUTO-03, AUTO-04, P-21): `ocw_automation_propose` proposes a scheduled automation as a card the person
   * confirms (offered by 07.6-12 to a human holding `automation.create`); `ocw_record_update` changes fields of the
   * watched record of the turn's card with compare-and-set (offered by 07.6-14 only in that thread). Both are
   * side-effecting: a tainted turn uses them only with a 07.5 approval.
   */
  automationPropose: "ocw_automation_propose",
  recordUpdate: "ocw_record_update",
  /**
   * 07.7 (ADR-0027): consult another bot through `POST /consultations`; self-validated by its route, always
   * side-effecting, never approvable (not in `APPROVABLE_BUILTINS`, D-10). Offered only with `TurnContext.consult`.
   */
  consultAgent: "ocw_consult_agent",
  /**
   * 07.15 (D-03, ADR-0037): read one attachment of the turn's conversation through `POST /attachments/read`, which
   * decides, claims, extracts and audits each call (the bytes travel only in its answer, never a URL or key).
   * Self-validated in the cell, counted apart from the cap of 8, never approvable (not in `APPROVABLE_BUILTINS`, PD-08).
   * Offered only on a turn that lists a readable file (PD-03), never in `GET /cell`.
   */
  attachmentRead: "ocw_attachment_read",
  /**
   * 07.16 (D-05, PD-09): a bot with an active Work Zone profile starts, prompts, reads and stops its own sessions
   * through `POST /work-sessions/start|prompt|read|stop`, which decide, claim and audit each call as the profile's
   * sponsor. Self-validated in the cell, turn-scoped (never in `GET /cell`), never approvable (not in
   * `APPROVABLE_BUILTINS`: the profile and its sponsor's live controls are their gate).
   */
  workSessionStart: "ocw_work_session_start",
  workSessionPrompt: "ocw_work_session_prompt",
  workSessionRead: "ocw_work_session_read",
  workSessionStop: "ocw_work_session_stop",
  /**
   * 07.17.1.1 (D-01, D-02, ADR-0041): upload one attachment of the turn's thread into a session this bot started, as a
   * repo-relative path, through `POST /work-sessions/upload`. Turn-scoped (never in `GET /cell`), offered with the four
   * 07.16 tools all-or-none, self-validated in the cell, never approvable (not in `APPROVABLE_BUILTINS`).
   */
  workSessionUpload: "ocw_work_session_upload",
  /**
   * 07.17.1.1 (D-01, D-03): download one file of a session this bot started back to the conversation as a pending
   * attachment the bot's reply links, through `POST /work-sessions/download`. Same offer and gates as the upload.
   */
  workSessionDownload: "ocw_work_session_download",
  /**
   * 07.17 (D-02, PD-07, ADR-0039): a fan-out automation's run turn opens one conversation per new item (a thread in
   * the automation's channel, or a card on its board) through `POST /conversations/open`, which decides the target,
   * the run, the caps and the dedupe from the stored turn and audits each call. Offered only on run turns of fan-out
   * automations, self-validated in the cell, turn-scoped (never in `GET /cell`), never approvable (not in
   * `APPROVABLE_BUILTINS`).
   */
  conversationOpen: "ocw_conversation_open",
  /**
   * 07.17.1.1.2 (D-02, ADR-0042): the bot's long tasks. `ocw_task_start` starts one in the turn's thread (one active
   * task per bot per thread), `ocw_task_continue` schedules this bot's own next turn there for the same person,
   * `ocw_task_finish` ends it, through `POST /tasks/start|continue|finish`, which decide, claim and audit each call from
   * the stored turn and the task row. Turn-scoped (never in `GET /cell`), self-validated in the cell, never approvable
   * (not in `APPROVABLE_BUILTINS`) and never on `/tool-calls`.
   */
  taskStart: "ocw_task_start",
  taskContinue: "ocw_task_continue",
  taskFinish: "ocw_task_finish",
} as const;

/** 07.17.1.1.2 (D-02): the three task tools, in this order (start, continue, finish). */
export const TASK_TOOL_NAMES = [
  BUILTIN_TOOLS.taskStart,
  BUILTIN_TOOLS.taskContinue,
  BUILTIN_TOOLS.taskFinish,
] as const;
export type TaskToolName = (typeof TASK_TOOL_NAMES)[number];

/**
 * 07.17.1.1.2 (D-08, D-13): the task tools only schedule this bot's own next turn for this person, within the task's
 * budgets, and answer the platform's own ids and numbers: neither side-effecting nor untrusted output, so a tainted turn
 * may still continue (budgets, not taint, bound a task). Not counted in `MAX_TOOL_CALLS_PER_TURN`.
 */
export const TASK_TOOL_FLAGS: Readonly<Record<TaskToolName, TurnToolFlags>> = {
  ocw_task_start: { untrustedOutput: false, sideEffecting: false },
  ocw_task_continue: { untrustedOutput: false, sideEffecting: false },
  ocw_task_finish: { untrustedOutput: false, sideEffecting: false },
};

/**
 * 07.17.1.1 (D-01, PD-26): the two file tools, declared apart (the file routes and their tests name them on their own)
 * and closing `WORK_SESSION_TOOL_NAMES`.
 */
export const WORK_SESSION_FILE_TOOL_NAMES = [
  BUILTIN_TOOLS.workSessionUpload,
  BUILTIN_TOOLS.workSessionDownload,
] as const;
export type WorkSessionFileToolName = (typeof WORK_SESSION_FILE_TOOL_NAMES)[number];

/**
 * 07.17.1.1 (D-02, D-03, D-10): both write somewhere (the session's tree, the conversation), so side-effecting; the
 * answer is the platform's own ids and the name the bot asked for, never the file's content.
 */
export const WORK_SESSION_FILE_TOOL_FLAGS: Readonly<Record<WorkSessionFileToolName, TurnToolFlags>> = {
  ocw_work_session_upload: { untrustedOutput: false, sideEffecting: true },
  ocw_work_session_download: { untrustedOutput: false, sideEffecting: true },
};

/**
 * 07.16 (D-05): the Work Zone session tools, offered together (PD-17). 07.17.1.1 (D-01): six, all or none: the four
 * session tools, then upload and download.
 */
export const WORK_SESSION_TOOL_NAMES = [
  BUILTIN_TOOLS.workSessionStart,
  BUILTIN_TOOLS.workSessionPrompt,
  BUILTIN_TOOLS.workSessionRead,
  BUILTIN_TOOLS.workSessionStop,
  ...WORK_SESSION_FILE_TOOL_NAMES,
] as const;
export type WorkSessionToolName = (typeof WORK_SESSION_TOOL_NAMES)[number];

/**
 * 07.16 (D-05, D-20): start, prompt and stop act on a device; a read returns the runtime's own work product, which the
 * API scopes through `agent_turns.session_output_read` (D-20) rather than the general taint, so it is not
 * `untrustedOutput`. 07.17.1.1 (D-01): with the two file tools' flags.
 */
export const WORK_SESSION_TOOL_FLAGS: Readonly<Record<WorkSessionToolName, TurnToolFlags>> = {
  ocw_work_session_start: { untrustedOutput: false, sideEffecting: true },
  ocw_work_session_prompt: { untrustedOutput: false, sideEffecting: true },
  ocw_work_session_read: { untrustedOutput: false, sideEffecting: false },
  ocw_work_session_stop: { untrustedOutput: false, sideEffecting: true },
  ...WORK_SESSION_FILE_TOOL_FLAGS,
};

/**
 * 07.17 (D-02, D-05): opening conversations posts in the automation's target, so it is side-effecting; the answer is
 * the platform's own ids, never outside content.
 */
export const CONVERSATION_OPEN_FLAGS: TurnToolFlags = { untrustedOutput: false, sideEffecting: true };

/**
 * 07.15 (D-08, PD-08): a read returns a person's file, third-party content: it taints the turn (and its return turns).
 * Nothing leaves the platform, so it is not side-effecting.
 */
export const ATTACHMENT_READ_FLAGS: TurnToolFlags = { untrustedOutput: true, sideEffecting: false };

export const MAX_TOOL_CALLS_PER_TURN = 8;
export const MAX_WEB_CALLS_PER_TURN = 5;

// ---------------------------------------------------------------- confined tools (Phase 07.8)

export const SANDBOX_TOOL_NAMES = [
  BUILTIN_TOOLS.sandboxExec,
  BUILTIN_TOOLS.sandboxProcess,
  BUILTIN_TOOLS.sandboxRead,
  BUILTIN_TOOLS.sandboxWrite,
  BUILTIN_TOOLS.sandboxList,
  BUILTIN_TOOLS.sandboxDelete,
  BUILTIN_TOOLS.sandboxShare,
  BUILTIN_TOOLS.sandboxImport,
] as const;
export type SandboxToolName = (typeof SANDBOX_TOOL_NAMES)[number];

export const BROWSER_TOOL_NAMES = [
  BUILTIN_TOOLS.browserOpen,
  BUILTIN_TOOLS.browserSnapshot,
  BUILTIN_TOOLS.browserAct,
  BUILTIN_TOOLS.browserScreenshot,
  BUILTIN_TOOLS.browserWait,
  BUILTIN_TOOLS.browserSignIn,
  BUILTIN_TOOLS.browserClose,
] as const;
export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

export type ConfinedToolName = SandboxToolName | BrowserToolName;

/**
 * What a confined tool needs once a member's sealed browser session was loaded in the turn (D-13, P-18;
 * `agent_turns.member_data` is true): `cross_site` = the requester's approval before reaching a host other than the
 * session's site (an `ocw_browser_open` there, or an `ocw_browser_act` the site lock reports as a blocked navigation);
 * `egress_exec` = the requester's approval before every call while the sandbox shell's egress mode is not `off`;
 * `none` = no extra rule. Personal and team bots alike. The approval is 07.5's card with floor `always`, approver =
 * the requester, a 15-minute expiry.
 */
export const MemberDataRule = z.enum(["none", "cross_site", "egress_exec"]);
export type MemberDataRule = z.infer<typeof MemberDataRule>;

export const ConfinedToolFlags = TurnToolFlags.extend({ memberData: MemberDataRule });
export type ConfinedToolFlags = z.infer<typeof ConfinedToolFlags>;

/**
 * Static taint flags of the confined tools (D-11 F-7, Pattern 4) and their D-13 rule. Confined writes are not
 * side-effecting (nothing leaves the sandbox); `ocw_sandbox_share` is (a file becomes a conversation attachment).
 * `ocw_browser_act` is side-effecting only while a member session is loaded for the current origin: the API decides
 * that per call (07.8-14), so the static flag stays false. 07.5 approval policies apply on top (strictest wins).
 */
export const CONFINED_TOOL_FLAGS: Record<ConfinedToolName, ConfinedToolFlags> = {
  ocw_sandbox_exec: { untrustedOutput: true, sideEffecting: false, memberData: "egress_exec" },
  ocw_sandbox_process: { untrustedOutput: true, sideEffecting: false, memberData: "none" },
  ocw_sandbox_read: { untrustedOutput: true, sideEffecting: false, memberData: "none" },
  ocw_sandbox_write: { untrustedOutput: false, sideEffecting: false, memberData: "none" },
  ocw_sandbox_list: { untrustedOutput: true, sideEffecting: false, memberData: "none" },
  ocw_sandbox_delete: { untrustedOutput: false, sideEffecting: false, memberData: "none" },
  ocw_sandbox_share: { untrustedOutput: false, sideEffecting: true, memberData: "none" },
  ocw_sandbox_import: { untrustedOutput: false, sideEffecting: false, memberData: "none" },
  ocw_browser_open: { untrustedOutput: true, sideEffecting: false, memberData: "cross_site" },
  ocw_browser_snapshot: { untrustedOutput: true, sideEffecting: false, memberData: "none" },
  ocw_browser_act: { untrustedOutput: true, sideEffecting: false, memberData: "cross_site" },
  ocw_browser_screenshot: { untrustedOutput: true, sideEffecting: false, memberData: "none" },
  ocw_browser_wait: { untrustedOutput: true, sideEffecting: false, memberData: "none" },
  ocw_browser_signin: { untrustedOutput: false, sideEffecting: false, memberData: "none" },
  ocw_browser_close: { untrustedOutput: false, sideEffecting: false, memberData: "none" },
};

/** Sandbox and browser calls per turn, separate from the cap of 8 (D-11 F-7). */
export const MAX_SANDBOX_CALLS_PER_TURN = SANDBOX_LIMITS.callsPerTurn;

// ---------------------------------------------------------------- dangerous tools (D-08, Pitfall 3)

/** Exact OpenClaw core names and groups that are never offered to a bot. */
export const DANGEROUS_TOOL_NAMES: readonly string[] = [
  "apply_patch",
  "edit",
  "exec",
  "ls",
  "openclaw",
  "process",
  "read",
  "write",
  "sessions_yield",
  "tool_call",
  "tool_describe",
  "tool_search",
  "presence",
  "session_status",
  "browser",
  "canvas",
  "message",
  "gateway",
  "nodes",
  "x_search",
  "code_execution",
  "group:runtime",
  "group:fs",
  "group:ui",
  "group:automation",
  "group:nodes",
  "group:sessions",
  "group:messaging",
  "group:media",
];

/**
 * Phase 07.8 (D-03, D-11): names refused even for a tool hosted in a bot's sandbox: platform administration
 * (`openclaw`, `gateway`, `nodes`, `presence`, `session(s)_*`), meta-tools that reach any tool, messaging outside the
 * Agent Channel API, the hosted paid `code_execution` / `x_search` and the node `canvas`, plus every `group:*`. This is
 * `DANGEROUS_TOOL_NAMES` without the shell, file and browser names the sandbox confines.
 */
export const SANDBOX_REFUSED_TOOL_NAMES: readonly string[] = DANGEROUS_TOOL_NAMES.filter(
  (n) => !["apply_patch", "edit", "exec", "ls", "process", "read", "write", "browser"].includes(n),
);

/** Where a tool runs: the OpenClaw cell (default) or a bot's sandbox (07.8 sandbox packages). */
export const ToolHost = z.enum(["cell", "sandbox"]);
export type ToolHost = z.infer<typeof ToolHost>;

const DANGEROUS_EXACT = new Set(DANGEROUS_TOOL_NAMES.map((n) => n.toLowerCase()));
const SANDBOX_REFUSED_EXACT = new Set(SANDBOX_REFUSED_TOOL_NAMES.map((n) => n.toLowerCase()));
const BUILTIN_NAMES = new Set<string>(Object.values(BUILTIN_TOOLS));

/** Shell / process execution. */
const SHELL_WORDS = new Set([
  "exec",
  "execute",
  "execution",
  "shell",
  "bash",
  "zsh",
  "sh",
  "powershell",
  "cmd",
  "spawn",
  "process",
  "subprocess",
  "terminal",
  "pty",
]);
/** Browser, desktop and screen control. */
const CONTROL_WORDS = new Set([
  "browser",
  "puppeteer",
  "playwright",
  "computer",
  "canvas",
  "screen",
  "mouse",
  "keyboard",
]);
/** Gateway, node and runtime administration. */
const ADMIN_WORDS = new Set(["gateway", "node", "nodes", "openclaw"]);
/** Outbound messaging on behalf of the bot. */
const MESSAGING_WORDS = new Set(["send", "message", "messages", "messaging", "sms", "sessions"]);
/** Filesystem objects … */
const FS_WORDS = new Set(["fs", "file", "files", "filesystem", "dir", "directory", "folder", "path"]);
/** … and mutating verbs on them (alone they are fine: `write_note` on a notes server is not a filesystem write). */
const FS_MUTATIONS = new Set([
  "write",
  "edit",
  "delete",
  "remove",
  "rm",
  "move",
  "mv",
  "rename",
  "create",
  "mkdir",
  "patch",
  "chmod",
]);
const CONFIG_WORDS = new Set(["config", "configuration", "settings"]);
const CONFIG_MUTATIONS = new Set(["set", "write", "update", "patch", "apply", "edit"]);

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * True for tool names that must never become effective, whatever a source declares: the exact core list,
 * every `group:*`, and word patterns for shell/exec/spawn/process/terminal, filesystem write/edit/delete/move,
 * browser/computer/canvas/screen control, gateway/node/config administration and outbound messaging. Never
 * true for the `BUILTIN_TOOLS`.
 *
 * Phase 07.8 (D-03): `host: "sandbox"` is for tools that run only inside a bot's sandbox. It skips the shell, file and
 * browser-control word sets and uses `SANDBOX_REFUSED_TOOL_NAMES` as the exact list; administration, messaging,
 * `session(s)_*`, `group:*` and config mutation stay refused. The default host (`cell`) is unchanged.
 *
 * Phase 07.7 (C-01): `subagents`, `conversations_*` and `agents_*` (OpenClaw's in-cell agent-to-agent tools) are refused
 * on both hosts. A predicate change only: `DANGEROUS_TOOL_NAMES` and its mirrors stay identical.
 */
export function isDangerousToolName(name: string, host: ToolHost = "cell"): boolean {
  const lower = name.trim().toLowerCase();
  if (BUILTIN_NAMES.has(lower)) return false;
  const confined = host === "sandbox";
  if ((confined ? SANDBOX_REFUSED_EXACT : DANGEROUS_EXACT).has(lower) || lower.startsWith("group:"))
    return true;
  if (lower.startsWith("session_") || lower.startsWith("sessions_")) return true;
  // Phase 07.7 (C-01, ADR-0027): OpenClaw's in-cell agent-to-agent tools. Bots reach each other only through
  // `ocw_consult_agent`, which the Agent Channel API decides and audits.
  if (lower === "subagents" || lower.startsWith("conversations_") || lower.startsWith("agents_")) return true;
  const w = words(name);
  const has = (set: Set<string>) => w.some((x) => set.has(x));
  if (has(ADMIN_WORDS) || has(MESSAGING_WORDS)) return true;
  if (!confined && (has(SHELL_WORDS) || has(CONTROL_WORDS))) return true;
  if (!confined && has(FS_WORDS) && has(FS_MUTATIONS)) return true;
  if (has(CONFIG_WORDS) && has(CONFIG_MUTATIONS)) return true;
  return false;
}
