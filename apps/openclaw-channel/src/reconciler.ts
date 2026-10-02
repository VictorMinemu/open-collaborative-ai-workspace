import type { CellAgent, CellProvider, CellSnapshot } from "./agent-channel-protocol.js";
import { openClawAgentIdFor, sanitizeName } from "./mention-mapper.js";

/** Prefix that marks agent entries owned by this plugin. Entries without it are never touched. */
export const OWNED_AGENT_PREFIX = "ocw-";

/**
 * Every tool OpenClaw 2026.9.7 can offer by default, plus the wildcard. Verified: profile "minimal" +
 * this deny list + toolSearch off ⇒ the model receives 0 tools. The plugin also passes
 * `disableTools: true` on every dispatch (second guard).
 */
export const DENIED_TOOLS = [
  "*",
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
] as const;

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

export function desiredAgentEntry(agent: CellAgent): AgentEntry {
  const name = sanitizeName(agent.displayName);
  return {
    name,
    model: { primary: agent.modelRef, fallbacks: [] },
    skills: [],
    identity: { name },
    tools: { profile: "minimal", deny: [...DENIED_TOOLS] },
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
  /** env var → secret value; applied to process.env, never written to the config file. */
  env: Record<string, string>;
  /** What to report via POST /agents/:id/status once the write succeeded. */
  results: AgentProvisioningResult[];
  changed: boolean;
};

/** Pure diff between OpenClaw's current config and what the cell snapshot asks for. */
export function planReconcile(
  current: { agents?: AgentEntries; providers?: ProviderEntries },
  cell: Pick<CellSnapshot, "agents" | "providers">,
): ReconcilePlan {
  const existingAgents = current.agents ?? {};
  const existingProviders = current.providers ?? {};
  const providersById = new Map(cell.providers.map((p) => [p.id, p]));

  const results: AgentProvisioningResult[] = [];
  const desiredAgents = new Map<string, AgentEntry>();
  const extraModels = new Map<string, string[]>();
  for (const agent of cell.agents) {
    if (agent.status === "disabled") continue;
    const slash = agent.modelRef.indexOf("/");
    const providerId = slash > 0 ? agent.modelRef.slice(0, slash) : agent.model.providerId;
    const modelId = slash > 0 ? agent.modelRef.slice(slash + 1) : agent.model.id;
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
    desiredAgents.set(openClawAgentIdFor(agent.id), desiredAgentEntry(agent));
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
    const entry = desiredProviderEntry(provider, extraModels.get(provider.id));
    if (!sameProvider(existingProviders[provider.id], entry, provider.apiKey))
      upsertProviders[provider.id] = entry;
    if (provider.apiKey) env[providerKeyEnvName(provider.id)] = provider.apiKey;
  }

  return {
    upsertAgents,
    removeAgents,
    upsertProviders,
    env,
    results,
    changed:
      Object.keys(upsertAgents).length > 0 ||
      removeAgents.length > 0 ||
      Object.keys(upsertProviders).length > 0,
  };
}

export type MutableConfig = {
  agents?: { entries?: AgentEntries; [k: string]: unknown };
  models?: { providers?: ProviderEntries; [k: string]: unknown };
  [k: string]: unknown;
};

/** Applies a plan to a mutable config draft (inside OpenClaw's `mutateConfigFile`). */
export function applyPlanToDraft(draft: MutableConfig, plan: ReconcilePlan): void {
  if (Object.keys(plan.upsertProviders).length > 0) {
    draft.models ??= {};
    draft.models.providers ??= {};
    for (const [id, entry] of Object.entries(plan.upsertProviders)) {
      draft.models.providers[id] = { ...(draft.models.providers[id] ?? {}), ...entry };
    }
  }
  if (Object.keys(plan.upsertAgents).length > 0 || plan.removeAgents.length > 0) {
    draft.agents ??= {};
    draft.agents.entries ??= {};
    const entries = draft.agents.entries;
    for (const [id, entry] of Object.entries(plan.upsertAgents))
      entries[id] = { ...(entries[id] ?? {}), ...entry };
    for (const id of plan.removeAgents) delete entries[id];
  }
}
