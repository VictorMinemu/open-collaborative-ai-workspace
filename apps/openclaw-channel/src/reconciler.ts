import path from "node:path";
import type { CellAgent, CellProvider, CellSnapshot, CellSubscription } from "./agent-channel-protocol.js";
import { openClawAgentIdFor, sanitizeName } from "./mention-mapper.js";

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

/** The tools a bot entry may list in `alsoAllow`: never a dangerous name, a group or a wildcard. */
export function allowedAgentTools(tools: readonly string[] | undefined): string[] {
  return [...new Set(tools ?? [])].filter((t) => {
    const lower = t.trim().toLowerCase();
    return (
      lower.length > 0 && !lower.includes("*") && !lower.startsWith("group:") && !DANGEROUS_SET.has(lower)
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
      const alsoAllow = allowedAgentTools(agent.capabilities?.tools);
      return {
        profile: "minimal",
        ...(alsoAllow.length > 0 ? { alsoAllow } : {}),
        deny: [...DANGEROUS_TOOLS],
      };
    })(),
  };
}

export function desiredProviderEntry(provider: CellProvider, extraModels: string[] = []): ProviderEntry {
  const ids = [...new Set([...provider.models, ...extraModels])];
  return {
    baseUrl: provider.baseUrl,
    api: provider.api,
    apiKey: provider.apiKey ? envRef(providerKeyEnvName(provider.id)) : "none",
    models: ids.map((id) => ({ id, name: id })),
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

/**
 * Semantic provider comparison. OpenClaw's runtime view enriches model entries and shows `${ENV}`
 * refs already resolved, so compare baseUrl, api, key (ref or resolved secret) and model id sets.
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
    stableStringify(modelIds(before.models)) === stableStringify(modelIds(desired.models))
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
  current: { agents?: AgentEntries; providers?: ProviderEntries; webSearchProvider?: string },
  cell: Pick<CellSnapshot, "agents" | "providers" | "subscriptions" | "webSearch">,
  opts: {
    readySubscriptions?: ReadonlySet<string>;
    /** Search provider plugins loaded in this cell (`plugins.allow`); a provider not loaded is never set. */
    searchProviders?: ReadonlySet<string>;
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

  return {
    upsertAgents,
    removeAgents,
    upsertProviders,
    removeProviders,
    env,
    results,
    webSearchProvider,
    changed:
      webSearchProvider !== null ||
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
