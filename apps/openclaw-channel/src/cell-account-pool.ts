import type { CellAccountPool } from "./agent-channel-protocol.js";
import type { EventStreamLogger } from "./event-stream.js";
import { AUTH_AGENT_ID } from "./openclaw-auth.js";
import type { PluginRuntimeLike } from "./openclaw-port.js";

/**
 * 07.18 (D-02, D-04, D-12, PD-13): the organization's account pool for bots, applied to OpenClaw's shared `main` auth
 * store after each reconcile.
 *
 * - Claude setup-tokens become `anthropic` **token profiles** (`anthropic:pool-<accountId>`). A token lives only in the
 *   gateway env (`OCW_POOL_TOKEN_<n>`); the stored profile references it (`tokenRef`, an env SecretRef) and never holds
 *   the literal. The org's Anthropic API key, when the API puts it last (`apiKeyLast`), becomes one more `api_key`
 *   profile referencing the env var it already lives in, and the provider entry drops its `apiKey` (see reconciler).
 *   OpenClaw tries profiles before a provider entry's key (probe A-05), so the key is the last resort.
 * - The order the strategy sets is written per provider (`anthropic`, `openai`) as the store order, the one
 *   `openclaw models auth order set` writes: an explicit list (failover: profiles it does not list are never used,
 *   probe A-04), or none (round-robin: OpenClaw's least-recently-used rotation, cooling profiles last).
 * - ChatGPT sign-ins stay where the sign-in flow stored them (openclaw-auth.ts); only their order is set here.
 *
 * OpenClaw keeps its own session stickiness, rate-limit failover and cooldowns (D-05); nothing here rotates per request.
 * Idempotent by state: the store is read and only differences are written, so an unchanged snapshot writes nothing and a
 * failed write is retried by the next reconcile. The driver never sees a token value (env names only), so no error it
 * raises can carry one.
 */

/** Store providers the pool orders. */
export type PoolStoreProvider = "anthropic" | "openai";
const PROVIDERS: readonly PoolStoreProvider[] = ["anthropic", "openai"];

/** Plugin-owned `anthropic` profiles: the pool's tokens, and the org key put last. */
export const POOL_TOKEN_PROFILE_PREFIX = "anthropic:pool-";
export const ORG_KEY_PROFILE_ID = "anthropic:ocw-org-key";
const CHATGPT_PROFILE_PREFIX = "openai:";

/** One profile the cell writes. `envName` is the env var the credential is read from (never the value). */
export type CellPoolProfile = {
  profileId: string;
  provider: "anthropic";
  type: "token" | "api_key";
  envName: string;
};

export type CellPoolPlan = {
  /** false: the snapshot carries no pool (an older API, or no pool rows); only leftovers this plugin wrote go. */
  managed: boolean;
  /** SECRETS: env var → Claude token. Gateway env only; never config, store or logs. */
  env: Record<string, string>;
  profiles: CellPoolProfile[];
  /** Per provider: an explicit order, or null = none. Applied only when `managed`. */
  order: Record<PoolStoreProvider, string[] | null>;
  /** The `anthropic` provider entry omits its `apiKey` (token profiles serve bots; the key is a profile). */
  keyInProfiles: boolean;
};

/**
 * What the plan reads back from the store: each profile's provider, type and env reference (no secret), and (07.18-19
 * R2.2) `refused: true` while OpenClaw holds the profile out for an auth failure (`authRefused`).
 */
export type CellPoolStoreState = {
  profiles: Record<string, { provider: string; type: string; envName: string | null; refused?: true }>;
  order: Partial<Record<string, string[]>>;
};

/** What the apply needs from OpenClaw. Real: `createOpenClawPoolDriver`. Tests: in-memory fakes. */
export interface CellPoolDriver {
  /** The store as it is now, or null when this OpenClaw cannot be read (nothing is then written). */
  read(): Promise<CellPoolStoreState | null>;
  writeProfile(profile: CellPoolProfile): Promise<void>;
  removeProfiles(profileIds: readonly string[]): Promise<void>;
  /** An explicit order, or null to clear it. */
  setOrder(provider: PoolStoreProvider, profileIds: readonly string[] | null): Promise<void>;
  /** Re-publish OpenClaw's auth state (re-reads env-referenced credentials). */
  refresh(): Promise<void>;
}

const EMPTY: CellPoolPlan = {
  managed: false,
  env: {},
  profiles: [],
  order: { anthropic: null, openai: null },
  keyInProfiles: false,
};

/**
 * Pure: what the cell must hold for `pool`. `anthropicKeyEnv`: the env var of the org's Anthropic key when the cell has
 * one (`providerKeyEnvName("anthropic")`), else null. Ids outside the pool's namespaces are never planned.
 */
export function planCellAccountPool(
  pool: CellAccountPool | undefined,
  opts: { anthropicKeyEnv: string | null },
): CellPoolPlan {
  if (!pool) return structuredClone(EMPTY);
  const env: Record<string, string> = {};
  const profiles: CellPoolProfile[] = [];
  const tokenIds = new Set<string>();
  for (const t of pool.claude.tokens) {
    if (!t.profileId.startsWith(POOL_TOKEN_PROFILE_PREFIX) || tokenIds.has(t.profileId) || t.envName in env) {
      continue;
    }
    tokenIds.add(t.profileId);
    env[t.envName] = t.token;
    profiles.push({ profileId: t.profileId, provider: "anthropic", type: "token", envName: t.envName });
  }
  const keyLast = tokenIds.size > 0 && pool.claude.apiKeyLast && opts.anthropicKeyEnv !== null;
  if (keyLast && opts.anthropicKeyEnv) {
    profiles.push({
      profileId: ORG_KEY_PROFILE_ID,
      provider: "anthropic",
      type: "api_key",
      envName: opts.anthropicKeyEnv,
    });
  }
  const claudeOrder =
    tokenIds.size > 0 && pool.claude.order
      ? nonEmpty([...new Set(pool.claude.order.filter((id) => tokenIds.has(id)))])
      : null;
  return {
    managed: true,
    env,
    profiles,
    order: {
      anthropic: claudeOrder ? [...claudeOrder, ...(keyLast ? [ORG_KEY_PROFILE_ID] : [])] : null,
      openai: pool.chatgpt.order
        ? nonEmpty([...new Set(pool.chatgpt.order.filter((id) => id.startsWith(CHATGPT_PROFILE_PREFIX)))])
        : null,
    },
    keyInProfiles: tokenIds.size > 0,
  };
}

/**
 * OpenClaw cannot hold an empty explicit order (writing one clears it), so an empty list plans no order. With every
 * ChatGPT profile disabled the API must keep bots off the subscription itself (07.18-07 SUMMARY, for plan 14).
 */
function nonEmpty(ids: string[]): string[] | null {
  return ids.length > 0 ? ids : null;
}

function isOwnedAnthropicProfile(id: string, provider: string): boolean {
  return provider === "anthropic" && (id.startsWith(POOL_TOKEN_PROFILE_PREFIX) || id === ORG_KEY_PROFILE_ID);
}

function sameOrder(a: readonly string[] | null | undefined, b: readonly string[] | null): boolean {
  const left = a && a.length > 0 ? a : null;
  if (left === null || b === null) return left === b;
  return left.length === b.length && left.every((id, i) => id === b[i]);
}

/**
 * Brings the store to `plan`: writes missing or changed pool profiles, removes the pool profiles that left it, and sets
 * or clears each provider's order (only for a managed plan; an absent pool never touches an order). `envChanged`: a
 * referenced env value changed (a rotated token or key) and OpenClaw must re-read it. Never throws.
 */
export async function applyCellAccountPool(
  plan: CellPoolPlan,
  driver: CellPoolDriver,
  opts: { envChanged?: boolean; log?: EventStreamLogger } = {},
): Promise<{ ok: boolean; writes: number }> {
  const warn = (what: string, error: unknown) =>
    opts.log?.warn?.(
      `account pool: ${what} failed (retried on the next sync): ${error instanceof Error ? error.message : String(error)}`,
    );
  let state: CellPoolStoreState | null;
  try {
    state = await driver.read();
  } catch (error) {
    warn("reading the auth store", error);
    return { ok: false, writes: 0 };
  }
  if (!state) return { ok: false, writes: 0 };
  let ok = true;
  let writes = 0;
  const run = async (what: string, step: () => Promise<void>) => {
    try {
      await step();
      writes++;
    } catch (error) {
      ok = false;
      warn(what, error);
    }
  };

  const wanted = new Set(plan.profiles.map((p) => p.profileId));
  for (const p of plan.profiles) {
    const current = state.profiles[p.profileId];
    if (current?.provider === p.provider && current.type === p.type && current.envName === p.envName)
      continue;
    await run(`writing ${p.profileId}`, () => driver.writeProfile(p));
  }
  const stale = Object.entries(state.profiles)
    .filter(([id, cred]) => isOwnedAnthropicProfile(id, cred.provider) && !wanted.has(id))
    .map(([id]) => id);
  if (stale.length > 0) await run(`removing ${stale.join(", ")}`, () => driver.removeProfiles(stale));
  if (plan.managed) {
    for (const provider of PROVIDERS) {
      const want = plan.order[provider];
      if (sameOrder(state.order[provider], want)) continue;
      await run(`setting the ${provider} order`, () => driver.setOrder(provider, want));
    }
  }
  if (writes > 0 || (opts.envChanged && plan.profiles.length > 0)) {
    try {
      await driver.refresh();
    } catch (error) {
      ok = false;
      warn("refreshing the gateway auth state", error);
    }
  }
  return { ok, writes };
}

// ---------------------------------------------------------------- token health (07.18-19 R2.2)

/** OpenClaw's failure reasons that mean the credential itself was refused (2026.9.7 `usage-state` priority list). */
const AUTH_FAILURE_REASONS = new Set(["auth", "auth_permanent"]);

function activeUntil(value: unknown, now: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > now;
}

/**
 * Pure: whether OpenClaw holds a profile out right now because the provider refused its credential. OpenClaw 2026.9.7
 * keeps per-profile `usageStats` in the auth store (`profile-usage-stats`, `usage-failure-state`): a 401/403 or a
 * revoked-key message is `auth` (a cooldown of 30 s to 5 min), a high-confidence revoke or deactivation is
 * `auth_permanent` (a disable window of 10 min to 1 h), and a successful run clears both. Rate limits, overloads,
 * billing and subscription blocks are not a bad credential. A window that ended is not reported (OpenClaw tries the
 * profile again).
 */
export function authRefused(stats: unknown, now: number): boolean {
  if (!stats || typeof stats !== "object") return false;
  const s = stats as Record<string, unknown>;
  const disabled = activeUntil(s.disabledUntil, now) && AUTH_FAILURE_REASONS.has(String(s.disabledReason));
  const cooling = activeUntil(s.cooldownUntil, now) && AUTH_FAILURE_REASONS.has(String(s.cooldownReason));
  return disabled || cooling;
}

export type PoolTokenHealth = { profileId: string; usable: boolean };

/** Pure: the pool's Claude token profiles in the store (`anthropic:pool-*`), by id, with whether they can be used. */
export function poolTokenHealth(state: CellPoolStoreState): PoolTokenHealth[] {
  return Object.entries(state.profiles)
    .filter(
      ([id, p]) =>
        id.startsWith(POOL_TOKEN_PROFILE_PREFIX) && p.provider === "anthropic" && p.type === "token",
    )
    .map(([profileId, p]) => ({ profileId, usable: p.refused !== true }))
    .sort((a, b) => (a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0));
}

/**
 * Reports the pool tokens' health to the API (`POST /agent-channel/v1/pool-health`) when it changed since the last
 * report the API took, the way the ChatGPT profile list is reported (subscription-auth.ts). Checked after every cell sync
 * and after every bot turn, while OpenClaw's failure window is still open. Never throws; a failed report is retried on
 * the next check. Ids and flags only, never a token. Concurrent checks share one run.
 */
export function createPoolHealthReporter(opts: {
  driver: Pick<CellPoolDriver, "read">;
  report: (body: { claude: PoolTokenHealth[] }) => Promise<void>;
  log?: EventStreamLogger;
}) {
  let last: string | null = null;
  let running: Promise<void> | null = null;
  async function run(): Promise<void> {
    let state: CellPoolStoreState | null;
    try {
      state = await opts.driver.read();
    } catch {
      return;
    }
    if (!state) return;
    const claude = poolTokenHealth(state).slice(0, 20);
    const key = JSON.stringify(claude);
    // Nothing to say: no token was ever reported and the cell holds none.
    if (key === last || (last === null && claude.length === 0)) return;
    try {
      await opts.report({ claude });
      last = key;
      const refused = claude.filter((t) => !t.usable).length;
      if (refused > 0)
        opts.log?.warn?.(`account pool: ${refused} Claude token(s) refused by the provider; reported`);
    } catch (error) {
      opts.log?.warn?.(
        `account pool: token health not reported (retried on the next check): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    check(): Promise<void> {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
  };
}

export type PoolHealthReporter = ReturnType<typeof createPoolHealthReporter>;

const PROVIDER_AUTH_MODULE = "openclaw/plugin-sdk/provider-auth";
const LOGIN_FLOW_MODULE = "openclaw/plugin-sdk/provider-auth-login-flow-runtime";

type ProviderAuthModule = typeof import("openclaw/plugin-sdk/provider-auth");
type LoginFlowModule = typeof import("openclaw/plugin-sdk/provider-auth-login-flow-runtime");

/** An env SecretRef in OpenClaw's canonical shape (exactly these three keys, `ref-contract` in 2026.9.7). */
function envSecretRef(envName: string) {
  return { source: "env" as const, provider: "default", id: envName };
}

function envNameOf(cred: Record<string, unknown>): string | null {
  const ref = cred.type === "token" ? cred.tokenRef : cred.type === "api_key" ? cred.keyRef : undefined;
  if (!ref || typeof ref !== "object") return null;
  const r = ref as { source?: unknown; id?: unknown };
  return r.source === "env" && typeof r.id === "string" ? r.id : null;
}

/**
 * The driver over the pinned OpenClaw 2026.9.7 plugin SDK (`provider-auth`: `upsertAuthProfileWithLock`,
 * `removeProviderAuthProfilesWithLock`, `updateAuthProfileStoreWithLock`; the login flow runtime's
 * `refreshProviderLoginAuthState`), all on the shared `main` store the sign-ins use.
 */
export function createOpenClawPoolDriver(opts: {
  runtime: PluginRuntimeLike;
  /** Test seam: module loader (defaults to dynamic import of the OpenClaw SDK subpaths). */
  load?: (specifier: string) => Promise<unknown>;
}): CellPoolDriver {
  const { runtime } = opts;
  // Literal specifiers: OpenClaw's plugin loader only aliases `openclaw/plugin-sdk/*` it can see statically.
  const load =
    opts.load ??
    ((specifier: string) =>
      specifier === LOGIN_FLOW_MODULE
        ? import("openclaw/plugin-sdk/provider-auth-login-flow-runtime")
        : import("openclaw/plugin-sdk/provider-auth"));
  const providerAuth = () => load(PROVIDER_AUTH_MODULE) as Promise<ProviderAuthModule>;
  const busy = (what: string) =>
    new Error(`the auth store is busy (${what}); OpenClaw's lock is held by another writer`);

  return {
    async read() {
      if (!runtime.modelAuth) return null;
      const store = runtime.modelAuth.ensureAuthProfileStore(undefined, {
        readOnly: true,
        allowKeychainPrompt: false,
      });
      const profiles: CellPoolStoreState["profiles"] = {};
      const usage = (store as { usageStats?: Record<string, unknown> } | undefined)?.usageStats ?? {};
      const now = Date.now();
      for (const [id, cred] of Object.entries(store?.profiles ?? {})) {
        if (!cred || typeof cred !== "object") continue;
        profiles[id] = {
          provider: typeof cred.provider === "string" ? cred.provider : "",
          type: typeof cred.type === "string" ? cred.type : "",
          envName: envNameOf(cred),
          ...(authRefused(usage[id], now) ? { refused: true as const } : {}),
        };
      }
      const order: CellPoolStoreState["order"] = {};
      for (const [provider, ids] of Object.entries(store?.order ?? {})) {
        if (Array.isArray(ids)) order[provider] = ids.filter((id): id is string => typeof id === "string");
      }
      return { profiles, order };
    },

    async writeProfile(p) {
      const auth = await providerAuth();
      const credential =
        p.type === "token"
          ? { type: "token" as const, provider: p.provider, tokenRef: envSecretRef(p.envName) }
          : { type: "api_key" as const, provider: p.provider, keyRef: envSecretRef(p.envName) };
      if ((await auth.upsertAuthProfileWithLock({ profileId: p.profileId, credential })) === null) {
        throw busy(`writing ${p.profileId}`);
      }
    },

    async removeProfiles(profileIds) {
      const auth = await providerAuth();
      const result = await auth.removeProviderAuthProfilesWithLock({
        cfg: runtime.config.current(),
        provider: "anthropic",
        profileIds: [...profileIds],
      });
      if (result === null) throw busy("removing profiles");
    },

    async setOrder(provider, profileIds) {
      const auth = await providerAuth();
      const ids = profileIds ? [...profileIds] : null;
      // What `setAuthProfileOrder` (behind `models auth order set|clear`) does, under the same lock. The gateway's
      // `models.authOrderSet` is not used: it refuses a list that leaves any stored profile out (A-04).
      const result = await auth.updateAuthProfileStoreWithLock({
        ...(ids && ids.length > 0 ? { saveOptions: { preserveOrderProfileIds: ids } } : {}),
        updater: (store) => {
          const order = { ...(store.order ?? {}) };
          if (!ids || ids.length === 0) {
            if (!(provider in order)) return false;
            delete order[provider];
          } else {
            order[provider] = ids;
          }
          store.order = Object.keys(order).length > 0 ? order : undefined;
          return true;
        },
      });
      if (result === null) throw busy(`setting the ${provider} order`);
    },

    async refresh() {
      const flow = (await load(LOGIN_FLOW_MODULE)) as LoginFlowModule;
      await flow.refreshProviderLoginAuthState({
        agentId: AUTH_AGENT_ID,
        readConfig: () => runtime.config.current(),
        assertCurrent: () => {},
      });
    },
  };
}
