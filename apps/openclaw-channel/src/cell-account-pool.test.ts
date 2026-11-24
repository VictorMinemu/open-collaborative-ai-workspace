/**
 * 07.18 (D-02, D-04, D-12, PD-13): the cell applies the API's account pool. The plan is pure; the apply runs against an
 * in-memory stand-in of OpenClaw's auth store (profiles + per-provider order), and the real driver against stand-ins of
 * the pinned 2026.9.7 `openclaw/plugin-sdk/provider-auth` functions (probes A-04, A-05 in openclaw-sdk.d.ts).
 */
import { describe, expect, it } from "vitest";
import type { CellAccountPool, CellAgent, CellProvider, CellSnapshot } from "./agent-channel-protocol.js";
import {
  applyCellAccountPool,
  type CellPoolDriver,
  type CellPoolStoreState,
  createOpenClawPoolDriver,
  ORG_KEY_PROFILE_ID,
  planCellAccountPool,
} from "./cell-account-pool.js";
import { createOpenClawPort, type PluginRuntimeLike } from "./openclaw-port.js";
import { envRef } from "./reconciler.js";

const A = "0199a000-0000-7000-8000-0000000000a1";
const B = "0199a000-0000-7000-8000-0000000000b2";
const P = "0199a000-0000-7000-8000-0000000000c3";
const Q = "0199a000-0000-7000-8000-0000000000d4";
/** Token-shaped test values joined at runtime: no credential literal in the repo. */
const TOKEN_A = ["sk-ant", "oat01", "AAAAAAAAAAAAAAAAAAAAAAAA"].join("-");
const TOKEN_B = ["sk-ant", "oat01", "BBBBBBBBBBBBBBBBBBBBBBBB"].join("-");
const KEY_ENV = "OCW_PROVIDER_KEY_ANTHROPIC";

function pool(
  over: { claude?: Partial<CellAccountPool["claude"]>; chatgpt?: Partial<CellAccountPool["chatgpt"]> } = {},
) {
  return {
    claude: {
      order: [`anthropic:pool-${A}`, `anthropic:pool-${B}`],
      tokens: [
        { accountId: A, profileId: `anthropic:pool-${A}`, envName: "OCW_POOL_TOKEN_1", token: TOKEN_A },
        { accountId: B, profileId: `anthropic:pool-${B}`, envName: "OCW_POOL_TOKEN_2", token: TOKEN_B },
      ],
      apiKeyLast: true,
      ...over.claude,
    },
    chatgpt: {
      order: null,
      profiles: [
        { accountId: P, profileId: `openai:pool-${P}`, enabled: true },
        { accountId: Q, profileId: `openai:pool-${Q}`, enabled: true },
      ],
      ...over.chatgpt,
    },
  } satisfies CellAccountPool;
}

describe("planCellAccountPool", () => {
  it("two Claude tokens: env names with their values, env-referenced token profiles, the org key last", () => {
    const plan = planCellAccountPool(pool(), { anthropicKeyEnv: KEY_ENV });
    expect(plan.managed).toBe(true);
    expect(plan.env).toEqual({ OCW_POOL_TOKEN_1: TOKEN_A, OCW_POOL_TOKEN_2: TOKEN_B });
    expect(plan.profiles).toEqual([
      { profileId: `anthropic:pool-${A}`, provider: "anthropic", type: "token", envName: "OCW_POOL_TOKEN_1" },
      { profileId: `anthropic:pool-${B}`, provider: "anthropic", type: "token", envName: "OCW_POOL_TOKEN_2" },
      { profileId: ORG_KEY_PROFILE_ID, provider: "anthropic", type: "api_key", envName: KEY_ENV },
    ]);
    // Only env names reach the profiles: never the literal token.
    expect(JSON.stringify(plan.profiles)).not.toContain("sk-ant");
    expect(plan.order.anthropic).toEqual([`anthropic:pool-${A}`, `anthropic:pool-${B}`, ORG_KEY_PROFILE_ID]);
    expect(plan.order.openai).toBeNull();
    expect(plan.keyInProfiles).toBe(true);
  });

  it("orders: null = no explicit order; a ChatGPT list is used as given; no key without apiKeyLast or a key", () => {
    const roundRobin = planCellAccountPool(pool({ claude: { order: null } }), { anthropicKeyEnv: KEY_ENV });
    // No explicit order: OpenClaw rotates least-recently-used, and api_key profiles sort after tokens by type.
    expect(roundRobin.order.anthropic).toBeNull();
    expect(roundRobin.profiles.map((p) => p.profileId)).toContain(ORG_KEY_PROFILE_ID);

    const failover = planCellAccountPool(pool({ chatgpt: { order: [`openai:pool-${Q}`] } }), {
      anthropicKeyEnv: null,
    });
    expect(failover.order.openai).toEqual([`openai:pool-${Q}`]);
    expect(failover.order.anthropic).toEqual([`anthropic:pool-${A}`, `anthropic:pool-${B}`]);
    expect(failover.profiles.map((p) => p.type)).toEqual(["token", "token"]);

    const noLast = planCellAccountPool(pool({ claude: { apiKeyLast: false } }), { anthropicKeyEnv: KEY_ENV });
    expect(noLast.profiles.map((p) => p.profileId)).not.toContain(ORG_KEY_PROFILE_ID);

    // An id outside the pool's namespaces is never planned (the store holds other profiles too).
    const foreign = planCellAccountPool(
      pool({ claude: { order: ["anthropic:default", `anthropic:pool-${A}`] }, chatgpt: { order: ["x:y"] } }),
      { anthropicKeyEnv: null },
    );
    expect(foreign.order.anthropic).toEqual([`anthropic:pool-${A}`]);
    expect(foreign.order.openai).toBeNull();
  });

  it("no Claude tokens: no profiles, no anthropic order, the key stays in the provider entry", () => {
    const plan = planCellAccountPool(pool({ claude: { tokens: [], order: null } }), {
      anthropicKeyEnv: KEY_ENV,
    });
    expect(plan.profiles).toEqual([]);
    expect(plan.env).toEqual({});
    expect(plan.order.anthropic).toBeNull();
    expect(plan.keyInProfiles).toBe(false);
  });

  it("an absent pool is an empty, unmanaged plan (P7)", () => {
    expect(planCellAccountPool(undefined, { anthropicKeyEnv: KEY_ENV })).toEqual({
      managed: false,
      env: {},
      profiles: [],
      order: { anthropic: null, openai: null },
      keyInProfiles: false,
    });
  });
});

/** In-memory auth store: what the real driver reads and writes. */
function fakeStore(initial: Partial<CellPoolStoreState> = {}) {
  const state: CellPoolStoreState = {
    profiles: { ...(initial.profiles ?? {}) },
    order: { ...(initial.order ?? {}) },
  };
  const writes: string[] = [];
  let failNext: string | null = null;
  const step = (name: string) => {
    writes.push(name);
    if (failNext && name.startsWith(failNext)) {
      failNext = null;
      throw new Error("Failed to update auth profile store; the auth store lock may be busy.");
    }
  };
  const driver: CellPoolDriver = {
    async read() {
      return structuredClone(state);
    },
    async writeProfile(p) {
      step(`write ${p.profileId}`);
      state.profiles[p.profileId] = { provider: p.provider, type: p.type, envName: p.envName };
    },
    async removeProfiles(ids) {
      step(`remove ${ids.join(",")}`);
      for (const id of ids) delete state.profiles[id];
    },
    async setOrder(provider, ids) {
      step(`order ${provider} ${ids ? ids.join(",") : "clear"}`);
      if (ids) state.order[provider] = [...ids];
      else delete state.order[provider];
    },
    async refresh() {
      step("refresh");
    },
  };
  return { state, driver, writes, failOn: (prefix: string) => (failNext = prefix) };
}

describe("applyCellAccountPool", () => {
  it("writes the token profiles and the order, then nothing for the same plan (idempotent)", async () => {
    const store = fakeStore({
      profiles: { "openai:owner@example.test": { provider: "openai", type: "oauth", envName: null } },
    });
    const plan = planCellAccountPool(pool({ chatgpt: { order: [`openai:pool-${P}`] } }), {
      anthropicKeyEnv: KEY_ENV,
    });
    expect((await applyCellAccountPool(plan, store.driver)).ok).toBe(true);
    expect(store.writes).toEqual([
      `write anthropic:pool-${A}`,
      `write anthropic:pool-${B}`,
      `write ${ORG_KEY_PROFILE_ID}`,
      `order anthropic anthropic:pool-${A},anthropic:pool-${B},${ORG_KEY_PROFILE_ID}`,
      `order openai openai:pool-${P}`,
      "refresh",
    ]);
    // Stored credentials reference env vars only.
    expect(store.state.profiles[`anthropic:pool-${A}`]).toEqual({
      provider: "anthropic",
      type: "token",
      envName: "OCW_POOL_TOKEN_1",
    });
    expect(JSON.stringify(store.state)).not.toContain("sk-ant");

    const again = await applyCellAccountPool(plan, store.driver);
    expect(again).toEqual({ ok: true, writes: 0 });
    expect(store.writes).toHaveLength(6);
    // A rotated token (same env name, new value): only a refresh, so OpenClaw re-reads the env.
    await applyCellAccountPool(plan, store.driver, { envChanged: true });
    expect(store.writes.slice(6)).toEqual(["refresh"]);
  });

  it("removes pool token profiles that left the plan and clears an order that went back to null", async () => {
    const store = fakeStore();
    await applyCellAccountPool(planCellAccountPool(pool(), { anthropicKeyEnv: KEY_ENV }), store.driver);
    store.writes.length = 0;
    store.state.profiles["anthropic:default"] = { provider: "anthropic", type: "api_key", envName: null };
    const onlyA = pool({
      claude: { order: null, tokens: [pool().claude.tokens[0]!] },
      chatgpt: { order: null },
    });
    await applyCellAccountPool(planCellAccountPool(onlyA, { anthropicKeyEnv: KEY_ENV }), store.driver);
    expect(store.writes).toEqual([`remove anthropic:pool-${B}`, "order anthropic clear", "refresh"]);
    // Profiles the plugin never wrote are left alone.
    expect(Object.keys(store.state.profiles).sort()).toEqual(
      [`anthropic:pool-${A}`, ORG_KEY_PROFILE_ID, "anthropic:default"].sort(),
    );
  });

  it("an absent pool removes only leftovers this plugin wrote and never touches an order", async () => {
    const today = fakeStore({
      profiles: { "openai:owner@example.test": { provider: "openai", type: "oauth", envName: null } },
      order: { openai: ["openai:owner@example.test"] },
    });
    const empty = planCellAccountPool(undefined, { anthropicKeyEnv: KEY_ENV });
    expect(await applyCellAccountPool(empty, today.driver)).toEqual({ ok: true, writes: 0 });
    expect(today.writes).toEqual([]);

    const leftover = fakeStore({
      profiles: {
        [`anthropic:pool-${A}`]: { provider: "anthropic", type: "token", envName: "OCW_POOL_TOKEN_1" },
        [ORG_KEY_PROFILE_ID]: { provider: "anthropic", type: "api_key", envName: KEY_ENV },
      },
      order: { anthropic: [`anthropic:pool-${A}`] },
    });
    await applyCellAccountPool(empty, leftover.driver);
    expect(leftover.writes).toEqual([`remove anthropic:pool-${A},${ORG_KEY_PROFILE_ID}`, "refresh"]);
  });

  it("a driver failure is logged without any token and retried on the next reconcile", async () => {
    const store = fakeStore();
    const logs: string[] = [];
    const log = { warn: (m: string) => logs.push(m) };
    const plan = planCellAccountPool(pool(), { anthropicKeyEnv: KEY_ENV });
    store.failOn(`write anthropic:pool-${B}`);
    const first = await applyCellAccountPool(plan, store.driver, { log });
    expect(first.ok).toBe(false);
    expect(logs.join("\n")).toContain(`anthropic:pool-${B}`);
    expect(logs.join("\n")).not.toContain("sk-ant");
    expect(store.state.profiles[`anthropic:pool-${B}`]).toBeUndefined();
    const second = await applyCellAccountPool(plan, store.driver, { log });
    expect(second.ok).toBe(true);
    expect(store.state.profiles[`anthropic:pool-${B}`]).toMatchObject({ type: "token" });
  });

  it("does nothing when the auth store cannot be read", async () => {
    const plan = planCellAccountPool(pool(), { anthropicKeyEnv: KEY_ENV });
    const driver = { ...fakeStore().driver, read: async () => null };
    expect(await applyCellAccountPool(plan, driver)).toEqual({ ok: false, writes: 0 });
  });
});

describe("createOpenClawPoolDriver (2026.9.7 provider-auth stand-ins)", () => {
  function fakeSdk() {
    const store: { profiles: Record<string, Record<string, unknown>>; order?: Record<string, string[]> } = {
      profiles: { "openai:owner@example.test": { type: "oauth", provider: "openai", refresh: "R" } },
    };
    const calls: Array<[string, unknown]> = [];
    const providerAuth = {
      async upsertAuthProfileWithLock(p: { profileId: string; credential: Record<string, unknown> }) {
        calls.push(["upsert", p]);
        store.profiles[p.profileId] = p.credential;
        return store;
      },
      async removeProviderAuthProfilesWithLock(p: { provider: string; profileIds?: string[] }) {
        calls.push(["remove", p]);
        for (const id of p.profileIds ?? []) delete store.profiles[id];
        return store;
      },
      async updateAuthProfileStoreWithLock(p: {
        updater: (s: typeof store) => boolean;
        saveOptions?: unknown;
      }) {
        calls.push(["update", { saveOptions: p.saveOptions }]);
        const draft = structuredClone(store);
        if (p.updater(draft)) Object.assign(store, draft);
        if (!draft.order) delete store.order;
        return store;
      },
    };
    const loginFlow = {
      async refreshProviderLoginAuthState(p: { agentId: string }) {
        calls.push(["refresh", p.agentId]);
      },
    };
    const runtime = {
      config: { current: () => ({ agents: {} }), mutateConfigFile: async () => undefined },
      channel: {},
      modelAuth: { ensureAuthProfileStore: () => structuredClone(store) },
    } as unknown as PluginRuntimeLike;
    const load = async (specifier: string) =>
      specifier.endsWith("provider-auth-login-flow-runtime") ? loginFlow : providerAuth;
    return { store, calls, runtime, load };
  }

  it("writes env SecretRefs (never the literal), sets and clears the store order, refreshes the main agent", async () => {
    const sdk = fakeSdk();
    const driver = createOpenClawPoolDriver({ runtime: sdk.runtime, load: sdk.load });
    await driver.writeProfile({
      profileId: `anthropic:pool-${A}`,
      provider: "anthropic",
      type: "token",
      envName: "OCW_POOL_TOKEN_1",
    });
    await driver.writeProfile({
      profileId: ORG_KEY_PROFILE_ID,
      provider: "anthropic",
      type: "api_key",
      envName: KEY_ENV,
    });
    expect(sdk.store.profiles[`anthropic:pool-${A}`]).toEqual({
      type: "token",
      provider: "anthropic",
      tokenRef: { source: "env", provider: "default", id: "OCW_POOL_TOKEN_1" },
    });
    expect(sdk.store.profiles[ORG_KEY_PROFILE_ID]).toEqual({
      type: "api_key",
      provider: "anthropic",
      keyRef: { source: "env", provider: "default", id: KEY_ENV },
    });
    const read = await driver.read();
    expect(read?.profiles[`anthropic:pool-${A}`]).toEqual({
      provider: "anthropic",
      type: "token",
      envName: "OCW_POOL_TOKEN_1",
    });
    expect(read?.profiles["openai:owner@example.test"]).toEqual({
      provider: "openai",
      type: "oauth",
      envName: null,
    });

    await driver.setOrder("openai", [`openai:pool-${P}`]);
    expect(sdk.store.order).toEqual({ openai: [`openai:pool-${P}`] });
    expect((await driver.read())?.order).toEqual({ openai: [`openai:pool-${P}`] });
    await driver.setOrder("openai", null);
    expect(sdk.store.order).toBeUndefined();

    await driver.removeProfiles([`anthropic:pool-${A}`]);
    expect(sdk.calls.find(([k]) => k === "remove")?.[1]).toMatchObject({
      provider: "anthropic",
      profileIds: [`anthropic:pool-${A}`],
    });
    await driver.refresh();
    expect(sdk.calls.at(-1)).toEqual(["refresh", "main"]);
  });

  it("a busy store (null) is an error the apply logs and retries", async () => {
    const sdk = fakeSdk();
    const busy = async (specifier: string) => {
      const mod = (await sdk.load(specifier)) as Record<string, unknown>;
      return { ...mod, upsertAuthProfileWithLock: async () => null };
    };
    const driver = createOpenClawPoolDriver({ runtime: sdk.runtime, load: busy });
    await expect(
      driver.writeProfile({
        profileId: `anthropic:pool-${A}`,
        provider: "anthropic",
        type: "token",
        envName: "OCW_POOL_TOKEN_1",
      }),
    ).rejects.toThrow(/busy/);
  });

  it("reads null without OpenClaw's modelAuth", async () => {
    const runtime = { config: { current: () => ({}) }, channel: {} } as unknown as PluginRuntimeLike;
    expect(await createOpenClawPoolDriver({ runtime }).read()).toBeNull();
  });
});

describe("real port: the snapshot's pool is applied after each reconcile", () => {
  const BOT: CellAgent = {
    id: "agent-claude",
    handle: "claude",
    displayName: "Claude",
    avatarUrl: null,
    description: null,
    instructions: "",
    status: "ready",
    modelRef: "anthropic/claude-sonnet-5-5",
    model: { provider: "anthropic", providerId: "anthropic", id: "claude-sonnet-5-5" },
    capabilities: { tools: [] },
  };
  const ANTHROPIC: CellProvider = {
    id: "anthropic",
    kind: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    apiKey: ["sk-ant", "api03", "KEYKEYKEYKEYKEYKEY"].join("-"),
    models: ["claude-sonnet-5-5"],
  };
  const snapshot = (accountPool?: CellAccountPool): CellSnapshot => ({
    protocolVersion: 1,
    cellId: "0199a000-0000-7000-8000-00000000ce11",
    organizationId: "0199a000-0000-7000-8000-00000000000a",
    topic: "cell:0199a000-0000-7000-8000-00000000ce11",
    lastSeq: 0,
    agents: [BOT],
    providers: [ANTHROPIC],
    ...(accountPool ? { accountPool } : {}),
  });

  it("tokens reach the gateway env only, the anthropic entry drops its key, the store gets the pool once", async () => {
    const config: Record<string, unknown> = {};
    const runtime = {
      config: {
        current: () => config,
        mutateConfigFile: async (p: { mutate: (d: Record<string, unknown>) => void }) => p.mutate(config),
      },
      channel: { routing: { buildAgentSessionKey: () => "k" } },
    } as unknown as PluginRuntimeLike;
    const store = fakeStore();
    const port = createOpenClawPort({ runtime, accountId: "default", cfg: {}, poolDriver: store.driver });
    const before = { ...process.env };
    try {
      await port.reconcile(snapshot(pool()));
      expect(process.env.OCW_POOL_TOKEN_1).toBe(TOKEN_A);
      expect(process.env.OCW_POOL_TOKEN_2).toBe(TOKEN_B);
      const providers = (config.models as { providers: Record<string, Record<string, unknown>> }).providers;
      expect(providers.anthropic).not.toHaveProperty("apiKey");
      expect(JSON.stringify(config)).not.toContain("sk-ant");
      expect(Object.keys(store.state.profiles)).toEqual([
        `anthropic:pool-${A}`,
        `anthropic:pool-${B}`,
        ORG_KEY_PROFILE_ID,
      ]);
      const writes = store.writes.length;
      await port.reconcile(snapshot(pool()));
      expect(store.writes).toHaveLength(writes);

      // The pool goes away: its env leaves the gateway, the key comes back to the entry, the profiles go.
      await port.reconcile(snapshot());
      expect(process.env.OCW_POOL_TOKEN_1).toBeUndefined();
      expect(providers.anthropic?.apiKey).toBe(envRef(KEY_ENV));
      expect(Object.keys(store.state.profiles)).toEqual([]);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
    }
  });
});
