/**
 * The OpenClaw-backed driver against a stand-in of OpenClaw's `runModelsAuthLoginFlow` that behaves like
 * the real 2026.9.7 `openai` device-code method (openUrl(verification URL) first, then prompter.deviceCode,
 * then the credential lands in the auth store). The real module is exercised by the container smoke test.
 */
import { describe, expect, it } from "vitest";
import {
  AUTH_AGENT_ID,
  accountFromStore,
  createOpenClawAuthDriver,
  emailFromProfileId,
  profilesFromStore,
} from "./openclaw-auth.js";
import type { PluginRuntimeLike } from "./openclaw-port.js";

type Profiles = Record<string, Record<string, unknown>>;

const POOL_B = "openai:pool-0199a000-0000-7000-8000-0000000000b2";

/** The account each successive sign-in approves (default: one owner account). */
type Signed = { email: string; plan: string };

function fakeOpenClaw(accounts: Signed[] = [{ email: "owner@example.test", plan: "pro" }]) {
  const profiles: Profiles = {};
  let signIns = 0;
  const calls: Array<Record<string, unknown>> = [];
  const refreshes: string[] = [];
  const runtime = {
    config: { current: () => ({ agents: { entries: {} } }), mutateConfigFile: async () => undefined },
    channel: {} as PluginRuntimeLike["channel"],
    modelAuth: { ensureAuthProfileStore: () => ({ profiles }) },
  } as unknown as PluginRuntimeLike;
  const loginFlow = {
    async runModelsAuthLoginFlow(
      params: {
        prompter: {
          deviceCode(p: { code: string; expiresInMinutes: number }): Promise<void>;
          progress(m: string): { update(m: string): void; stop(m?: string): void };
          note(m: string): Promise<void>;
        };
        runtime: { log(...a: unknown[]): void };
        openUrl(url: string): Promise<void>;
        signal: AbortSignal;
        refreshAfterLogin(agentId: string): Promise<void>;
      } & Record<string, unknown>,
    ) {
      calls.push(params);
      const spin = params.prompter.progress("Starting device code flow…");
      await params.openUrl("https://auth.openai.com/codex/device");
      await params.prompter.deviceCode({ code: "WXYZ-12345", expiresInMinutes: 15 });
      params.runtime.log("\nOpen this URL in your LOCAL browser:\n\nhttps://auth.openai.com/codex/device\n");
      spin.update("Waiting for device authorization…");
      await new Promise((r) => setTimeout(r, 5));
      params.signal.throwIfAborted();
      const signed = accounts[Math.min(signIns++, accounts.length - 1)]!;
      // 2026.9.7 (A-03): a requested `profileId` renames the one returned profile (resolveReloginProfileIdentity).
      const requested = typeof params.profileId === "string" ? params.profileId : undefined;
      const profileId = requested ?? `openai:${signed.email}`;
      profiles[profileId] = {
        type: "oauth",
        provider: "openai",
        access: "ACCESS-SECRET",
        refresh: "REFRESH-SECRET",
        expires: Date.now() + 3600_000,
        email: signed.email,
        chatgptPlanType: signed.plan,
      };
      await params.refreshAfterLogin(AUTH_AGENT_ID);
      return {
        providerId: "openai",
        methodId: "device-code",
        authRefresh: "refreshed",
        profiles: [{ profileId, provider: "openai", mode: "oauth" }],
      };
    },
    async refreshProviderLoginAuthState(p: { agentId: string }) {
      refreshes.push(p.agentId);
    },
  };
  const removed: Array<Record<string, unknown>> = [];
  /** Lock contention: the removal changes nothing and resolves null (as 2026.9.7's compat wrapper does). */
  const busy = { on: false };
  const providerAuth = {
    async removeProviderAuthProfilesWithLock(p: { provider: string; profileIds?: string[] }) {
      removed.push(p);
      if (busy.on) return null;
      // 2026.9.7: exact ids when given (whatever their provider), else every profile of the provider.
      for (const [id, c] of Object.entries(profiles)) {
        if (p.profileIds ? p.profileIds.includes(id) : c.provider === p.provider) delete profiles[id];
      }
      return {};
    },
  };
  const load = async (specifier: string) =>
    specifier.endsWith("provider-auth-login-flow-runtime") ? loginFlow : providerAuth;
  return { runtime, load, profiles, calls, refreshes, removed, busy };
}

describe("OpenClaw auth driver", () => {
  it("drives OpenClaw's device-code login for the openai provider on the shared-main store", async () => {
    const oc = fakeOpenClaw();
    const logs: string[] = [];
    const driver = createOpenClawAuthDriver({
      runtime: oc.runtime,
      load: oc.load,
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    });
    const prompts: unknown[] = [];
    const account = await driver.login({
      provider: "openai-codex",
      signal: new AbortController().signal,
      onDeviceCode: async (p) => {
        prompts.push(p);
      },
    });
    expect(prompts).toEqual([
      {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "WXYZ-12345",
        expiresInMs: 900_000,
      },
    ]);
    expect(account).toEqual({
      email: "owner@example.test",
      planType: "pro",
      profileId: "openai:owner@example.test",
    });
    expect(oc.calls[0]).toMatchObject({
      provider: "openai",
      method: "device-code",
      ownerPluginId: "openai",
      credentialOnly: true,
      agent: "main",
      isRemote: true,
    });
    // No profile id asked: the flow is called exactly as before 07.18.
    expect(oc.calls[0]).not.toHaveProperty("profileId");
    expect(oc.refreshes).toEqual(["main"]);
    // OpenClaw's own console output (which echoes URLs) is swallowed; nothing secret is logged.
    expect(logs.join("\n")).not.toMatch(/WXYZ|SECRET/);
    expect(await driver.status("openai-codex")).toEqual({ email: "owner@example.test", planType: "pro" });
  });

  it("logout removes the provider's profiles and refreshes the gateway", async () => {
    const oc = fakeOpenClaw();
    oc.profiles["openai:x@y.z"] = { type: "oauth", provider: "openai", refresh: "r" };
    oc.profiles["anthropic:default"] = { type: "api_key", provider: "anthropic", key: "k" };
    const driver = createOpenClawAuthDriver({ runtime: oc.runtime, load: oc.load });
    await driver.logout("openai-codex");
    expect(oc.removed).toEqual([{ cfg: { agents: { entries: {} } }, provider: "openai" }]);
    expect(Object.keys(oc.profiles)).toEqual(["anthropic:default"]);
    expect(oc.refreshes).toEqual(["main"]);
    expect(await driver.status("openai-codex")).toBeNull();
  });

  it("logout with profile ids removes only those profiles of the provider (E15)", async () => {
    const oc = fakeOpenClaw();
    oc.profiles["openai:pool-a"] = { type: "oauth", provider: "openai", refresh: "r", email: "a@y.z" };
    oc.profiles[POOL_B] = { type: "oauth", provider: "openai", refresh: "r", email: "b@y.z" };
    oc.profiles["anthropic:pool-c"] = { type: "token", provider: "anthropic", tokenRef: {} };
    const driver = createOpenClawAuthDriver({ runtime: oc.runtime, load: oc.load });
    // An id of another provider is never removed through an openai revoke.
    await driver.logout("openai-codex", [POOL_B, "anthropic:pool-c"]);
    expect(oc.removed).toEqual([
      { cfg: { agents: { entries: {} } }, provider: "openai", profileIds: [POOL_B] },
    ]);
    expect(Object.keys(oc.profiles)).toEqual(["openai:pool-a", "anthropic:pool-c"]);
    expect(oc.refreshes).toEqual(["main"]);
    expect((await driver.profiles?.("openai-codex"))?.map((p) => p.profileId)).toEqual(["openai:pool-a"]);
    expect(await driver.status("openai-codex")).toEqual({ email: "a@y.z", planType: null });

    // Nothing of this provider left to remove: no call at all (never widened to "every profile").
    await driver.logout("openai-codex", ["anthropic:pool-c"]);
    await driver.logout("openai-codex", []);
    expect(oc.removed).toHaveLength(1);
  });

  it("a per-profile logout whose profile is still there reports the busy store", async () => {
    const oc = fakeOpenClaw();
    oc.profiles["openai:pool-a"] = { type: "oauth", provider: "openai", refresh: "r" };
    oc.profiles[POOL_B] = { type: "oauth", provider: "openai", refresh: "r" };
    oc.busy.on = true;
    const driver = createOpenClawAuthDriver({ runtime: oc.runtime, load: oc.load });
    await expect(driver.logout("openai-codex", [POOL_B])).rejects.toThrow(
      "the auth store is busy; the credential is still present",
    );
    await expect(driver.logout("openai-codex")).rejects.toThrow("the auth store is busy");
  });

  it("propagates an abort (cancel) from the login", async () => {
    const oc = fakeOpenClaw();
    const driver = createOpenClawAuthDriver({ runtime: oc.runtime, load: oc.load });
    const ac = new AbortController();
    await expect(
      driver.login({ provider: "openai-codex", signal: ac.signal, onDeviceCode: async () => ac.abort() }),
    ).rejects.toThrow();
    expect(await driver.status("openai-codex")).toBeNull();
  });

  it("reads identity from stored OAuth profiles only", () => {
    expect(emailFromProfileId("openai:owner@example.test")).toBe("owner@example.test");
    expect(emailFromProfileId("openai:default")).toBeNull();
    expect(
      accountFromStore(
        { profiles: { "openai:default": { type: "api_key", provider: "openai", key: "k" } } },
        "openai",
      ),
    ).toBeNull();
    expect(
      accountFromStore(
        { profiles: { "openai:a@b.c": { type: "oauth", provider: "openai", refresh: "r" } } },
        "openai",
      ),
    ).toEqual({ email: "a@b.c", planType: null });
  });

  it("a pool sign-in asks for its profile id and lands next to the first account (A-03, PD-12)", async () => {
    const oc = fakeOpenClaw([
      { email: "owner@example.test", plan: "pro" },
      { email: "bots@example.test", plan: "plus" },
    ]);
    const driver = createOpenClawAuthDriver({ runtime: oc.runtime, load: oc.load });
    const signal = new AbortController().signal;
    const onDeviceCode = async () => {};
    await driver.login({ provider: "openai-codex", signal, onDeviceCode });
    const second = await driver.login({
      provider: "openai-codex",
      profileId: POOL_B,
      signal,
      onDeviceCode,
    });
    expect(oc.calls[1]).toMatchObject({ profileId: POOL_B, credentialOnly: true, agent: "main" });
    // The signed-in account, not the store's first one.
    expect(second).toEqual({ email: "bots@example.test", planType: "plus", profileId: POOL_B });
    expect(Object.keys(oc.profiles)).toEqual(["openai:owner@example.test", POOL_B]);
    // status keeps reporting the first usable account; profiles lists both (never a token).
    expect(await driver.status("openai-codex")).toEqual({ email: "owner@example.test", planType: "pro" });
    const listed = await driver.profiles?.("openai-codex");
    expect(listed).toEqual([
      { profileId: "openai:owner@example.test", email: "owner@example.test", planType: "pro", usable: true },
      { profileId: POOL_B, email: "bots@example.test", planType: "plus", usable: true },
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/SECRET/);
  });

  it("profilesFromStore lists every OAuth profile of the provider in store order", () => {
    const store = {
      profiles: {
        "openai:a@b.c": { type: "oauth", provider: "openai", refresh: "r", chatgptPlanType: "pro" },
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "k" },
        "openai:pool-x": { type: "oauth", provider: "openai", email: "x@y.z" },
        "openai:key": { type: "api_key", provider: "openai", key: "k" },
        "openai:pool-y": { type: "oauth", provider: "openai", access: "a", email: "y@y.z" },
      },
    };
    expect(profilesFromStore(store, "openai")).toEqual([
      { profileId: "openai:a@b.c", email: "a@b.c", planType: "pro", usable: true },
      { profileId: "openai:pool-x", email: "x@y.z", planType: null, usable: false },
      { profileId: "openai:pool-y", email: "y@y.z", planType: null, usable: true },
    ]);
    expect(profilesFromStore(undefined, "openai")).toEqual([]);
    // The first usable one, as before.
    expect(accountFromStore(store, "openai")).toEqual({ email: "a@b.c", planType: "pro" });
  });
});
