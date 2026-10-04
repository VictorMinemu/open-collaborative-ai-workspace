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
} from "./openclaw-auth.js";
import type { PluginRuntimeLike } from "./openclaw-port.js";

type Profiles = Record<string, Record<string, unknown>>;

function fakeOpenClaw() {
  const profiles: Profiles = {};
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
      profiles["openai:owner@example.test"] = {
        type: "oauth",
        provider: "openai",
        access: "ACCESS-SECRET",
        refresh: "REFRESH-SECRET",
        expires: Date.now() + 3600_000,
        email: "owner@example.test",
        chatgptPlanType: "pro",
      };
      await params.refreshAfterLogin(AUTH_AGENT_ID);
      return {
        providerId: "openai",
        methodId: "device-code",
        authRefresh: "refreshed",
        profiles: [{ profileId: "openai:owner@example.test", provider: "openai", mode: "oauth" }],
      };
    },
    async refreshProviderLoginAuthState(p: { agentId: string }) {
      refreshes.push(p.agentId);
    },
  };
  const removed: Array<Record<string, unknown>> = [];
  const providerAuth = {
    async removeProviderAuthProfilesWithLock(p: { provider: string }) {
      removed.push(p);
      for (const [id, c] of Object.entries(profiles)) if (c.provider === p.provider) delete profiles[id];
      return {};
    },
  };
  const load = async (specifier: string) =>
    specifier.endsWith("provider-auth-login-flow-runtime") ? loginFlow : providerAuth;
  return { runtime, load, profiles, calls, refreshes, removed };
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
    expect(account).toEqual({ email: "owner@example.test", planType: "pro" });
    expect(oc.calls[0]).toMatchObject({
      provider: "openai",
      method: "device-code",
      ownerPluginId: "openai",
      credentialOnly: true,
      agent: "main",
      isRemote: true,
    });
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
});
