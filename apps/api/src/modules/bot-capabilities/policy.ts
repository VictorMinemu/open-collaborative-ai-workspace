import {
  type AgentScope,
  BotPolicy,
  BuiltinCapability,
  CapabilityPolicyEntry,
  DEFAULT_BOT_POLICY,
  SearchProvider,
  type UpdateBotPolicyRequest,
} from "@ocw/contracts";
import { botPolicies, cellPlugins, type Tx, tenantOf } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { Env } from "../../config/env";
import { badRequest } from "../../lib/errors";
import { readCapabilities, type TaskPolicy, taskPolicyFor } from "./capabilities";

export type { TaskPolicy } from "./capabilities";

/**
 * The organization bot policy (D-06): one `bot_policies` row per org, the defaults (allow everything) when it
 * is absent. Also answers whether the internet capability is `configured` (D-09).
 */

type PolicyRow = typeof botPolicies.$inferSelect;
/** The only configuration the capability model reads. */
export type SearchEnv = Pick<Env, "OCW_SEARXNG_URL" | "OCW_BUNDLED_PLUGINS">;

function fromRow(row: PolicyRow | undefined): BotPolicy {
  if (!row) return { ...structuredClone(DEFAULT_BOT_POLICY), updatedAt: null };
  const stored = (row.capabilities ?? {}) as Record<string, unknown>;
  const capabilities = structuredClone(DEFAULT_BOT_POLICY.capabilities);
  for (const cap of BuiltinCapability.options) {
    const parsed = CapabilityPolicyEntry.safeParse(stored[cap]);
    if (parsed.success) capabilities[cap] = parsed.data;
  }
  const provider = SearchProvider.safeParse(row.searchProvider);
  // 07.17.1.1.2 (D-04): the long-task limits (database checks hold the same bounds); a value out of range reads as the
  // default rather than failing the policy.
  const tasks = BotPolicy.shape.tasks.safeParse({
    maxTurns: row.taskMaxTurns,
    maxHours: row.taskMaxHours,
    maxRunning: row.maxRunningTasks,
  });
  // Quick 261113-id6: how long conversations are summarized (the database check holds the token bounds).
  const conversations = BotPolicy.shape.conversations.safeParse({
    strictSummaries: row.conversationStrictSummaries,
    keepIdentifiers: row.conversationKeepIdentifiers,
    keepRecentTokens: row.conversationKeepRecentTokens,
    freshSessionOnFailure: row.conversationFreshSessionOnFailure,
  });
  return {
    capabilities,
    searchProvider: provider.success ? provider.data : DEFAULT_BOT_POLICY.searchProvider,
    maxPersonalBotsPerUser: row.maxPersonalBotsPerUser,
    personalDailyLimitMax: row.personalDailyLimitMax,
    personalAllowedModels: row.personalAllowedModels,
    tasks: tasks.success ? tasks.data : { ...DEFAULT_BOT_POLICY.tasks },
    conversations: conversations.success ? conversations.data : { ...DEFAULT_BOT_POLICY.conversations },
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export async function loadPolicy(tx: Tx): Promise<BotPolicy> {
  const [row] = await tx.select().from(botPolicies).limit(1);
  return fromRow(row);
}

/**
 * Phase 07.17.1.1.2 (D-04, E11): may this bot run long tasks now, and within which limits. The bot's own toggle, then
 * the organization's "Allow long tasks", then its personal sub-switch for a personal bot. Re-decided at every task
 * start and continuation (08, 09); the turn reads the same rule through `computeTurn.longTasks`.
 */
export async function loadTaskPolicy(
  tx: Tx,
  agent: { scope: AgentScope; capabilities: unknown },
): Promise<TaskPolicy> {
  return taskPolicyFor({ scope: agent.scope, caps: readCapabilities(agent), policy: await loadPolicy(tx) });
}

/**
 * Search providers the cell can run from its bundled plugins plus `installed` plugin names (pure). Must match what
 * infra/openclaw/render-config.mjs loads for the same env (parity test: search-parity.test.ts).
 */
export function searchProvidersFor(env: SearchEnv, installed: Iterable<string> = []): Set<SearchProvider> {
  const out = new Set<SearchProvider>();
  const names = new Set(env.OCW_BUNDLED_PLUGINS);
  for (const name of installed) names.add(name.toLowerCase());
  if (names.has("duckduckgo")) out.add("duckduckgo");
  if (names.has("searxng") && env.OCW_SEARXNG_URL) out.add("searxng");
  return out;
}

/** Search providers the cell can run right now: bundled in the image or installed from the marketplace. */
export async function availableSearchProviders(tx: Tx, env: SearchEnv): Promise<Set<SearchProvider>> {
  const names: string[] = [];
  const installed = await tx
    .select({ declared: cellPlugins.declared })
    .from(cellPlugins)
    .where(eq(cellPlugins.status, "installed"));
  for (const p of installed) {
    const declared = (p.declared as { webSearchProviders?: unknown }).webSearchProviders;
    if (!Array.isArray(declared)) continue;
    for (const name of declared) if (typeof name === "string") names.push(name);
  }
  return searchProvidersFor(env, names);
}

/** Internet is `configured` when the policy's search provider is available in the cell. */
export async function internetConfigured(tx: Tx, env: SearchEnv, policy: BotPolicy): Promise<boolean> {
  return (await availableSearchProviders(tx, env)).has(policy.searchProvider);
}

/** Dotted keys that differ between two policies (`capabilities.internet`, `searchProvider`, …). */
function changedKeys(before: BotPolicy, after: BotPolicy): string[] {
  const out: string[] = [];
  for (const cap of BuiltinCapability.options) {
    const a = before.capabilities[cap];
    const b = after.capabilities[cap];
    if (a.orgWide !== b.orgWide || a.personal !== b.personal) out.push(`capabilities.${cap}`);
  }
  if (before.searchProvider !== after.searchProvider) out.push("searchProvider");
  if (before.maxPersonalBotsPerUser !== after.maxPersonalBotsPerUser) out.push("maxPersonalBotsPerUser");
  if (before.personalDailyLimitMax !== after.personalDailyLimitMax) out.push("personalDailyLimitMax");
  if (before.personalAllowedModels.join("\n") !== after.personalAllowedModels.join("\n")) {
    out.push("personalAllowedModels");
  }
  for (const key of ["maxTurns", "maxHours", "maxRunning"] as const) {
    if (before.tasks[key] !== after.tasks[key]) out.push(`tasks.${key}`);
  }
  for (const key of [
    "strictSummaries",
    "keepIdentifiers",
    "keepRecentTokens",
    "freshSessionOnFailure",
  ] as const) {
    if (before.conversations[key] !== after.conversations[key]) out.push(`conversations.${key}`);
  }
  return out;
}

/**
 * Upserts the policy (validated: `searxng` only when it is available, 400 `not_configured`). Returns the new
 * policy and the changed keys (empty = nothing written).
 */
export async function savePolicy(
  tx: Tx,
  env: SearchEnv,
  patch: UpdateBotPolicyRequest,
  actorUserId: string | null,
): Promise<{ policy: BotPolicy; changed: string[] }> {
  const before = await loadPolicy(tx);
  const next: BotPolicy = {
    capabilities: { ...before.capabilities, ...patch.capabilities },
    searchProvider: patch.searchProvider ?? before.searchProvider,
    maxPersonalBotsPerUser: patch.maxPersonalBotsPerUser ?? before.maxPersonalBotsPerUser,
    personalDailyLimitMax: patch.personalDailyLimitMax ?? before.personalDailyLimitMax,
    personalAllowedModels: patch.personalAllowedModels
      ? [...new Set(patch.personalAllowedModels)]
      : before.personalAllowedModels,
    // Merged per limit: a patch naming one limit leaves the others as they were.
    tasks: { ...before.tasks, ...patch.tasks },
    // Quick 261113-id6: merged per field, like the task limits.
    conversations: { ...before.conversations, ...patch.conversations },
    updatedAt: before.updatedAt,
  };
  if (patch.searchProvider && patch.searchProvider !== before.searchProvider) {
    if (!(await availableSearchProviders(tx, env)).has(patch.searchProvider)) {
      throw badRequest(`The ${patch.searchProvider} search provider is not configured`, "not_configured");
    }
  }
  const changed = changedKeys(before, next);
  if (changed.length === 0) return { policy: before, changed };

  const now = new Date().toISOString();
  const values = {
    capabilities: next.capabilities,
    searchProvider: next.searchProvider,
    maxPersonalBotsPerUser: next.maxPersonalBotsPerUser,
    personalDailyLimitMax: next.personalDailyLimitMax,
    personalAllowedModels: next.personalAllowedModels,
    taskMaxTurns: next.tasks.maxTurns,
    taskMaxHours: next.tasks.maxHours,
    maxRunningTasks: next.tasks.maxRunning,
    conversationStrictSummaries: next.conversations.strictSummaries,
    conversationKeepIdentifiers: next.conversations.keepIdentifiers,
    conversationKeepRecentTokens: next.conversations.keepRecentTokens,
    conversationFreshSessionOnFailure: next.conversations.freshSessionOnFailure,
    updatedBy: actorUserId,
    updatedAt: now,
  };
  const [row] = await tx
    .insert(botPolicies)
    .values({ organizationId: tenantOf(tx).organizationId, ...values })
    .onConflictDoUpdate({ target: botPolicies.organizationId, set: values })
    .returning();
  return { policy: fromRow(row), changed };
}
