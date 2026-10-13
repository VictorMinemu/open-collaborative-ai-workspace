import { z } from "zod";
import { AgentScope, AgentStatus, ModelProviderKind } from "./agent";
import { Id, IsoDateTime } from "./common";
import { MEMORY_LIMITS, MemoryPath, MemoryScopeKind } from "./memory";
import { Permission } from "./permissions";

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

/** Built-in capabilities governed by the org policy (`replyModeAll` = reply mode `all`). */
export const BuiltinCapability = z.enum(["internet", "memory", "dateTime", "replyModeAll"]);
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
});
export type BotCapabilities = z.infer<typeof BotCapabilities>;

/** D-06 defaults per bot scope. */
export const DEFAULT_CAPABILITIES: Record<AgentScope, BotCapabilities> = {
  team: { internet: false, memory: false, dateTime: true, replyMode: "mentions", dailyLimit: 100 },
  personal: { internet: false, memory: true, dateTime: true, replyMode: "mentions", dailyLimit: 30 },
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

export const BotPolicy = z.object({
  capabilities: z.object({
    internet: CapabilityPolicyEntry,
    memory: CapabilityPolicyEntry,
    dateTime: CapabilityPolicyEntry,
    replyModeAll: CapabilityPolicyEntry,
  }),
  searchProvider: SearchProvider,
  maxPersonalBotsPerUser: z.number().int().min(0).max(20),
  personalDailyLimitMax: z.number().int().min(1).max(10_000),
  /** `provider/modelId` entries; empty = every allowed model of the organization. */
  personalAllowedModels: z.array(z.string().max(250)).max(100),
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
  capabilities: { internet: ALLOW, memory: ALLOW, dateTime: ALLOW, replyModeAll: ALLOW },
  searchProvider: "duckduckgo",
  maxPersonalBotsPerUser: 3,
  personalDailyLimitMax: 100,
  personalAllowedModels: [],
};

/** `PUT /api/v1/bot-policy`: any subset; `capabilities` entries are merged per capability. */
export const UpdateBotPolicyRequest = BotPolicy.omit({ updatedAt: true })
  .extend({
    capabilities: z
      .object({
        internet: CapabilityPolicyEntry,
        memory: CapabilityPolicyEntry,
        dateTime: CapabilityPolicyEntry,
        replyModeAll: CapabilityPolicyEntry,
      })
      .partial(),
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
  }),
  tools: z.array(CatalogTool),
  usage: BotUsage,
  /** Highest `dailyLimit` this bot accepts: the org's personal maximum for personal bots. */
  dailyLimitMax: z.number().int().positive(),
  viewerCan: z.array(Permission),
});
export type BotCapabilityView = z.infer<typeof BotCapabilityView>;

/** `PATCH /api/v1/agents/:id/capabilities`. `tools`, when present, REPLACES the bot's grant set. */
export const UpdateBotCapabilitiesRequest = BotCapabilities.partial().extend({
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
});
export type TurnToolFlags = z.infer<typeof TurnToolFlags>;

/**
 * `agent.mention.v1.turn`: exactly what this bot may do for this human on this turn. A plugin that receives
 * no `turn` runs with no tools (fail closed).
 */
/**
 * Why a tool the bot could use is not offered on this turn of a shared AI chat (06-10, D-06): `not_every_participant` (a
 * joined human may not use it), `shared_with_group` (a team, department or the organization holds a grant, so the readers
 * are not a list) or `denied_for_you` (the asking human may not use it).
 */
export const TurnWithheldReason = z.enum(["not_every_participant", "shared_with_group", "denied_for_you"]);
export type TurnWithheldReason = z.infer<typeof TurnWithheldReason>;

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

export const TurnContext = z.object({
  tools: z.array(z.string()).max(64),
  toolFlags: z.record(z.string(), TurnToolFlags),
  memory: z.array(MemoryItem).max(50),
  now: TurnNow.nullable(),
  maxToolCalls: z.number().int(),
  maxWebCalls: z.number().int(),
  /** AI chat deliveries only (06-10): what was withheld and why, so the persona can say so. Never enables a tool. */
  withheld: z
    .array(z.object({ tool: z.string(), reason: TurnWithheldReason }))
    .max(64)
    .optional(),
  /** Phase 07.2: memory files for this turn; optional so older payloads parse (`memory` stays for compatibility). */
  memoryFiles: z.array(TurnMemoryFile).max(2).optional(),
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
} as const;

export const MAX_TOOL_CALLS_PER_TURN = 8;
export const MAX_WEB_CALLS_PER_TURN = 5;

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

const DANGEROUS_EXACT = new Set(DANGEROUS_TOOL_NAMES.map((n) => n.toLowerCase()));
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
 */
export function isDangerousToolName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (BUILTIN_NAMES.has(lower)) return false;
  if (DANGEROUS_EXACT.has(lower) || lower.startsWith("group:")) return true;
  if (lower.startsWith("session_") || lower.startsWith("sessions_")) return true;
  const w = words(name);
  const has = (set: Set<string>) => w.some((x) => set.has(x));
  if (has(SHELL_WORDS) || has(CONTROL_WORDS) || has(ADMIN_WORDS) || has(MESSAGING_WORDS)) return true;
  if (has(FS_WORDS) && has(FS_MUTATIONS)) return true;
  if (has(CONFIG_WORDS) && has(CONFIG_MUTATIONS)) return true;
  return false;
}
