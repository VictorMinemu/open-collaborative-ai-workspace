import path from "node:path";
import type {
  CellAgent,
  CellMcpServer,
  CellProvider,
  CellSnapshot,
  CellSubscription,
} from "./agent-channel-protocol.js";
import { openClawAgentIdFor, sanitizeName } from "./mention-mapper.js";
import { withTurnScopedTools } from "./turn-scoped-tools.js";

/** Prefix that marks agent entries owned by this plugin. Entries without it are never touched. */
export const OWNED_AGENT_PREFIX = "ocw-";

/**
 * Tools no bot may ever be offered (lockdown v2, D-08). Mirrors `DANGEROUS_TOOL_NAMES` in
 * packages/contracts/src/bot-capabilities.ts and `DANGEROUS_TOOLS` in infra/openclaw/render-config.mjs (parity
 * test in reconciler.test.ts). No wildcard: tools are an allowlist (profile `minimal` + per-agent `alsoAllow`),
 * and a global `*` deny would also remove the web tools (deny always wins).
 */
export const DANGEROUS_TOOLS = [
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
] as const;

const DANGEROUS_SET: ReadonlySet<string> = new Set(DANGEROUS_TOOLS.map((t) => t.toLowerCase()));
/**
 * Policy entries that grant a whole tool family at once: OpenClaw treats `bundle-mcp` as "every MCP server" and
 * `bundle-lsp` as every LSP tool. A bot is only ever granted exact names.
 */
const FAMILY_GRANTS: ReadonlySet<string> = new Set(["bundle-mcp", "bundle-lsp"]);

/** The tools a bot entry may list in `alsoAllow`: never a dangerous name, a group, a family or a wildcard. */
export function allowedAgentTools(tools: readonly string[] | undefined): string[] {
  return [...new Set(tools ?? [])].filter((t) => {
    const lower = t.trim().toLowerCase();
    return (
      lower.length > 0 &&
      !lower.includes("*") &&
      !lower.startsWith("group:") &&
      !DANGEROUS_SET.has(lower) &&
      !FAMILY_GRANTS.has(lower)
    );
  });
}

/** A plugin-owned OpenClaw agent id (`openClawAgentIdFor`): `ocw-` + lower-case letters, digits, `-`, `_`. */
const OWNED_AGENT_ID = /^ocw-[a-z0-9_-]+$/u;

/**
 * The directory holding a removed bot's OpenClaw state (session rows, transcripts, archives):
 * `<stateDir>/agents/<agentId>`. Removing an entry from config does not delete it (only
 * `openclaw agents delete` does), so the port purges it after a successful write (research Pitfall 12).
 * Null — never purge — for anything but a plugin-owned `ocw-*` id under an absolute state dir.
 */
export function agentStateDirFor(stateDir: string, agentId: string): string | null {
  if (!stateDir || !path.isAbsolute(stateDir) || !OWNED_AGENT_ID.test(agentId)) return null;
  const agentsRoot = path.resolve(stateDir, "agents");
  const dir = path.resolve(agentsRoot, agentId);
  return path.dirname(dir) === agentsRoot ? dir : null;
}

/** Env var that carries a provider key inside the gateway process (never written to config). */
export function providerKeyEnvName(providerId: string): string {
  return `OCW_PROVIDER_KEY_${providerId.toUpperCase().replace(/[^A-Z0-9]/gu, "_")}`;
}

/** `${NAME}`: OpenClaw substitutes it from its process env when it loads the config. */
export function envRef(name: string): string {
  return `$${"{"}${name}}`;
}

/** Plugin-owned MCP server names: the API's immutable `m` + 8 hex (`safeServerName`). Nothing else is touched. */
export const OWNED_MCP_SERVER = /^m[0-9a-f]{8}$/u;
/** Env var names the API assigns to MCP header values (`cellEnvName`). */
const MCP_ENV_NAME = /^OCW_MCP_[A-Z0-9_]{1,64}$/u;
/** RFC 9110 token: what an HTTP header name may be. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u;

/**
 * `mcp.servers.<safeName>` for one snapshot server (D-13): exact tool names in `toolFilter.include` (never a glob),
 * header values as `${ENV}` references (the value goes to the gateway env only). Null when the entry cannot be
 * rendered safely (not a plugin-owned name, an env or header name we would not write, or no enabled tool).
 */
export function desiredMcpServerEntry(s: CellMcpServer): McpServerEntry | null {
  if (!OWNED_MCP_SERVER.test(s.safeName)) return null;
  // OpenClaw validates the whole config on write: one unusable URL must not block every bot's sync.
  if (!isHttpUrl(s.url)) return null;
  if (s.headers.some((h) => !MCP_ENV_NAME.test(h.envName) || !HEADER_NAME.test(h.name))) return null;
  const include = [...new Set(s.tools.map((t) => t.trim()))]
    .filter((t) => t.length > 0 && !t.includes("*"))
    .sort();
  if (include.length === 0) return null;
  return {
    url: s.url,
    transport: s.transport,
    ...(s.headers.length > 0
      ? { headers: Object.fromEntries(s.headers.map((h) => [h.name, envRef(h.envName)])) }
      : {}),
    toolFilter: { include },
  };
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function includeOf(filter: unknown): string[] {
  const include = (filter as { include?: unknown } | undefined)?.include;
  return Array.isArray(include) ? include.filter((t): t is string => typeof t === "string").sort() : [];
}

/**
 * Semantic MCP server comparison (a needless write retires the server's live connections): OpenClaw's runtime view shows `${ENV}` header refs already resolved, so a header
 * matches when it is the ref or the secret it stands for.
 */
function sameMcpServer(
  before: McpServerEntry | undefined,
  desired: McpServerEntry,
  secrets: ReadonlyMap<string, string>,
): boolean {
  if (!before) return false;
  const want = (desired.headers ?? {}) as Record<string, string>;
  const have = (before.headers && typeof before.headers === "object" ? before.headers : {}) as Record<
    string,
    unknown
  >;
  const headersMatch =
    Object.keys(want).length === Object.keys(have).length &&
    Object.entries(want).every(([name, ref]) => have[name] === ref || have[name] === secrets.get(ref));
  return (
    headersMatch &&
    before.url === desired.url &&
    before.transport === desired.transport &&
    stableStringify(includeOf(before.toolFilter)) === stableStringify(includeOf(desired.toolFilter))
  );
}

export type McpServerEntry = { headers?: Record<string, string> } & Record<string, unknown>;
export type McpServerEntries = Record<string, McpServerEntry>;
export type AgentEntry = Record<string, unknown>;
export type AgentEntries = Record<string, AgentEntry>;
export type ProviderEntry = Record<string, unknown>;
export type ProviderEntries = Record<string, ProviderEntry>;

/**
 * OpenClaw id for the API-key OpenAI provider while a ChatGPT subscription is connected: OpenClaw keeps
 * ChatGPT sign-ins and OpenAI API keys under ONE provider id (`openai`), so the key-based provider moves to
 * a plain custom id and both work side by side without auth-order games.
 */
export const RENAMED_OPENAI_PROVIDER = "ocw-openai";

/**
 * @param modelRef OpenClaw model ref (defaults to the cell's ref).
 * @param pinEmbeddedRuntime subscription models: force OpenClaw's embedded runtime (never the native Codex
 *   harness, which has its own tools) for this agent's model.
 */
export function desiredAgentEntry(
  agent: CellAgent,
  modelRef: string = agent.modelRef,
  pinEmbeddedRuntime = false,
): AgentEntry {
  const name = sanitizeName(agent.displayName);
  return {
    name,
    model: { primary: modelRef, fallbacks: [] },
    // Explicitly unset for API-key bots so a bot moved off a subscription loses the old pin.
    models: pinEmbeddedRuntime ? { [modelRef]: { agentRuntime: { id: "openclaw" } } } : undefined,
    skills: [],
    identity: { name },
    // Allowlist: only this bot's effective tools on top of `minimal`; dangerous names stay denied regardless.
    tools: (() => {
      // Plus the turn-scoped tools (`ocw_board_card`): each turn's `toolsAllow` still decides (turn-scoped-tools.ts).
      const alsoAllow = allowedAgentTools(withTurnScopedTools(agent.capabilities?.tools));
      return {
        profile: "minimal",
        ...(alsoAllow.length > 0 ? { alsoAllow } : {}),
        deny: [...DANGEROUS_TOOLS],
        // Code Mode (default `auto` for catalog-preferred models such as ChatGPT's) hides every tool behind
        // `exec`, which stays denied, so the bot could call nothing. Per agent, it beats per-model defaults.
        codeMode: false,
      };
    })(),
  };
}

/** What a model that accepts images declares (07.8 D-14, spike ii); every other model stays text only (no `input`). */
export const IMAGE_MODEL_INPUT = ["text", "image"] as const;

export function desiredProviderEntry(provider: CellProvider, extraModels: string[] = []): ProviderEntry {
  const ids = [...new Set([...provider.models, ...extraModels])];
  // 07.8 (D-14): OpenClaw passes a tool's image to the model only when the model declares image input; our custom
  // providers have no catalog discovery, so the API's per-model flag is the only source.
  const images = new Set(provider.imageModels ?? []);
  return {
    baseUrl: provider.baseUrl,
    api: provider.api,
    apiKey: provider.apiKey ? envRef(providerKeyEnvName(provider.id)) : "none",
    models: ids.map((id) =>
      images.has(id) ? { id, name: id, input: [...IMAGE_MODEL_INPUT] } : { id, name: id },
    ),
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameOwnedKeys(
  before: Record<string, unknown> | undefined,
  desired: Record<string, unknown>,
): boolean {
  if (!before) return false;
  const owned = Object.fromEntries(Object.keys(desired).map((k) => [k, before[k]]));
  return stableStringify(owned) === stableStringify(desired);
}

function modelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string")
    .sort();
}

/** The ids of the models that declare image input (an enriched runtime view fills `input: ["text"]` for the rest). */
function imageModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((m) => m && typeof m === "object" && Array.isArray((m as { input?: unknown }).input))
    .filter((m) => ((m as { input: unknown[] }).input as unknown[]).includes("image"))
    .map((m) => (m as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string")
    .sort();
}

/**
 * Semantic provider comparison. OpenClaw's runtime view enriches model entries and shows `${ENV}`
 * refs already resolved, so compare baseUrl, api, key (ref or resolved secret), model id sets and (07.8) the ids of the
 * image models.
 */
function sameProvider(
  before: ProviderEntry | undefined,
  desired: ProviderEntry,
  secret: string | null,
): boolean {
  if (!before) return false;
  const keyMatches = before.apiKey === desired.apiKey || (secret !== null && before.apiKey === secret);
  return (
    keyMatches &&
    before.baseUrl === desired.baseUrl &&
    before.api === desired.api &&
    stableStringify(modelIds(before.models)) === stableStringify(modelIds(desired.models)) &&
    stableStringify(imageModelIds(before.models)) === stableStringify(imageModelIds(desired.models))
  );
}

export type AgentProvisioningResult = { agentId: string; status: "ready" | "error"; detail?: string };

export type ReconcilePlan = {
  upsertAgents: Record<string, AgentEntry>;
  removeAgents: string[];
  upsertProviders: Record<string, ProviderEntry>;
  /** Plugin-written provider entries that must go (the API-key OpenAI entry moving to/from its renamed id). */
  removeProviders: string[];
  /** env var → secret value; applied to process.env, never written to the config file. */
  env: Record<string, string>;
  /** What to report via POST /agents/:id/status once the write succeeded. */
  results: AgentProvisioningResult[];
  /** New `tools.web.search.provider` (D-09), or null to leave it alone. */
  webSearchProvider: string | null;
  /** `mcp.servers.<safeName>` to write (D-13). */
  upsertMcpServers: McpServerEntries;
  /** Plugin-owned MCP servers that must go (left the snapshot or lost every enabled tool). */
  removeMcpServers: string[];
  changed: boolean;
};

export const SUBSCRIPTION_NOT_SIGNED_IN =
  "The ChatGPT subscription is not signed in on the bot runtime. Reconnect it in Settings › Models.";

/**
 * Pure diff between OpenClaw's current config and what the cell snapshot asks for.
 * `readySubscriptions`: subscription ids whose credentials OpenClaw holds right now (see
 * subscription-auth.ts); bots on any other listed subscription are reported as `error`.
 */
export function planReconcile(
  current: {
    agents?: AgentEntries;
    providers?: ProviderEntries;
    webSearchProvider?: string;
    mcpServers?: McpServerEntries;
  },
  cell: Pick<CellSnapshot, "agents" | "providers" | "subscriptions" | "webSearch" | "mcpServers">,
  opts: {
    readySubscriptions?: ReadonlySet<string>;
    /** Search provider plugins loaded in this cell (`plugins.allow`); a provider not loaded is never set. */
    searchProviders?: ReadonlySet<string>;
    /**
     * The gateway env as OpenClaw last resolved it (the port passes `process.env`): an MCP header whose value
     * changed there forces a re-render, so a rotated credential is applied even when the runtime view shows the
     * unresolved `${ref}`.
     */
    env?: Readonly<Record<string, string | undefined>>;
  } = {},
): ReconcilePlan {
  const existingAgents = current.agents ?? {};
  const existingProviders = current.providers ?? {};
  const providersById = new Map(cell.providers.map((p) => [p.id, p]));
  const subscriptions = new Map<string, CellSubscription>((cell.subscriptions ?? []).map((s) => [s.id, s]));
  const ready = opts.readySubscriptions ?? new Set<string>();
  const renameOpenAI =
    providersById.has("openai") && [...subscriptions.values()].some((s) => s.runtimeProvider === "openai");
  /** OpenClaw provider id for an API-key provider of the cell. */
  const openClawProviderId = (id: string) => (renameOpenAI && id === "openai" ? RENAMED_OPENAI_PROVIDER : id);

  const results: AgentProvisioningResult[] = [];
  const desiredAgents = new Map<string, AgentEntry>();
  const extraModels = new Map<string, string[]>();
  for (const agent of cell.agents) {
    if (agent.status === "disabled") continue;
    const slash = agent.modelRef.indexOf("/");
    const providerId = slash > 0 ? agent.modelRef.slice(0, slash) : agent.model.providerId;
    const modelId = slash > 0 ? agent.modelRef.slice(slash + 1) : agent.model.id;
    const subscription = subscriptions.get(providerId);
    if (subscription) {
      if (!ready.has(providerId)) {
        results.push({ agentId: agent.id, status: "error", detail: SUBSCRIPTION_NOT_SIGNED_IN });
        continue;
      }
      // The subscription's credential and catalog belong to OpenClaw's own provider (`openai/<model>`).
      const ref = `${subscription.runtimeProvider}/${modelId}`;
      desiredAgents.set(openClawAgentIdFor(agent.id), desiredAgentEntry(agent, ref, true));
      results.push({ agentId: agent.id, status: "ready" });
      continue;
    }
    if (!providersById.has(providerId)) {
      results.push({
        agentId: agent.id,
        status: "error",
        detail: `Model provider "${providerId}" is not configured (Settings › Models).`,
      });
      continue;
    }
    const list = extraModels.get(providerId) ?? [];
    list.push(modelId);
    extraModels.set(providerId, list);
    const ref = `${openClawProviderId(providerId)}/${modelId}`;
    desiredAgents.set(openClawAgentIdFor(agent.id), desiredAgentEntry(agent, ref));
    results.push({ agentId: agent.id, status: "ready" });
  }

  const upsertAgents: Record<string, AgentEntry> = {};
  for (const [id, entry] of desiredAgents) {
    // Compare only the keys we own so OpenClaw-added defaults (workspace, agentDir) don't cause churn.
    if (!sameOwnedKeys(existingAgents[id], entry)) upsertAgents[id] = entry;
  }
  const removeAgents = Object.keys(existingAgents).filter(
    (id) => id.startsWith(OWNED_AGENT_PREFIX) && !desiredAgents.has(id),
  );

  const upsertProviders: Record<string, ProviderEntry> = {};
  const env: Record<string, string> = {};
  for (const provider of cell.providers) {
    const id = openClawProviderId(provider.id);
    const entry = desiredProviderEntry({ ...provider, id }, extraModels.get(provider.id));
    if (!sameProvider(existingProviders[id], entry, provider.apiKey)) upsertProviders[id] = entry;
    if (provider.apiKey) env[providerKeyEnvName(id)] = provider.apiKey;
  }
  // The API-key OpenAI entry lives under exactly one id; drop the other one if we wrote it before.
  const staleOpenAIId = renameOpenAI ? "openai" : RENAMED_OPENAI_PROVIDER;
  const removeProviders = staleOpenAIId in existingProviders ? [staleOpenAIId] : [];

  const wantedSearch = cell.webSearch?.provider;
  const webSearchProvider =
    wantedSearch && wantedSearch !== current.webSearchProvider && opts.searchProviders?.has(wantedSearch)
      ? wantedSearch
      : null;

  // MCP servers (D-13): only servers with an enabled tool are rendered, so the cell never connects to the rest.
  const existingMcp = current.mcpServers ?? {};
  const upsertMcpServers: McpServerEntries = {};
  const desiredMcp = new Set<string>();
  for (const server of cell.mcpServers ?? []) {
    const entry = desiredMcpServerEntry(server);
    if (!entry) continue;
    desiredMcp.add(server.safeName);
    const secrets = new Map<string, string>();
    for (const h of server.headers) {
      env[h.envName] = h.value;
      secrets.set(envRef(h.envName), h.value);
    }
    const rotated = opts.env !== undefined && server.headers.some((h) => opts.env?.[h.envName] !== h.value);
    if (rotated || !sameMcpServer(existingMcp[server.safeName], entry, secrets)) {
      upsertMcpServers[server.safeName] = entry;
    }
  }
  const removeMcpServers = Object.keys(existingMcp).filter(
    (name) => OWNED_MCP_SERVER.test(name) && !desiredMcp.has(name),
  );

  return {
    upsertAgents,
    removeAgents,
    upsertProviders,
    removeProviders,
    env,
    results,
    webSearchProvider,
    upsertMcpServers,
    removeMcpServers,
    changed:
      webSearchProvider !== null ||
      Object.keys(upsertMcpServers).length > 0 ||
      removeMcpServers.length > 0 ||
      Object.keys(upsertAgents).length > 0 ||
      removeAgents.length > 0 ||
      Object.keys(upsertProviders).length > 0 ||
      removeProviders.length > 0,
  };
}

export type MutableConfig = {
  agents?: { entries?: AgentEntries; [k: string]: unknown };
  models?: { providers?: ProviderEntries; [k: string]: unknown };
  tools?: { web?: { search?: Record<string, unknown>; [k: string]: unknown }; [k: string]: unknown };
  plugins?: { allow?: unknown; [k: string]: unknown };
  mcp?: { servers?: McpServerEntries; [k: string]: unknown };
  [k: string]: unknown;
};

/** Applies a plan to a mutable config draft (inside OpenClaw's `mutateConfigFile`). */
export function applyPlanToDraft(draft: MutableConfig, plan: ReconcilePlan): void {
  if (plan.webSearchProvider) {
    draft.tools ??= {};
    draft.tools.web ??= {};
    draft.tools.web.search = { ...(draft.tools.web.search ?? {}), provider: plan.webSearchProvider };
  }
  if (Object.keys(plan.upsertProviders).length > 0) {
    draft.models ??= {};
    draft.models.providers ??= {};
    for (const [id, entry] of Object.entries(plan.upsertProviders)) {
      draft.models.providers[id] = { ...(draft.models.providers[id] ?? {}), ...entry };
    }
  }
  for (const id of plan.removeProviders ?? []) delete draft.models?.providers?.[id];
  const mcpUpserts = Object.entries(plan.upsertMcpServers ?? {});
  if (mcpUpserts.length > 0) {
    draft.mcp ??= {};
    draft.mcp.servers ??= {};
    // Replaced whole: a header or filter entry removed by the admin must not survive a merge.
    for (const [name, entry] of mcpUpserts) draft.mcp.servers[name] = entry;
  }
  for (const name of plan.removeMcpServers ?? []) delete draft.mcp?.servers?.[name];
  if (Object.keys(plan.upsertAgents).length > 0 || plan.removeAgents.length > 0) {
    draft.agents ??= {};
    draft.agents.entries ??= {};
    const entries = draft.agents.entries;
    for (const [id, entry] of Object.entries(plan.upsertAgents)) {
      const next: AgentEntry = { ...(entries[id] ?? {}), ...entry };
      for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
      entries[id] = next;
    }
    for (const id of plan.removeAgents) delete entries[id];
  }
}
