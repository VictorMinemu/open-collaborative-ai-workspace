/**
 * Contract tests for subscription sign-in in the cell: Agent Channel commands (`provider.auth.*`) →
 * driver (OpenClaw's device-code login, faked here) → `POST /provider-auth` reports, against the fake
 * Agent Channel API. Also covers the bridge wiring and the snapshot sync rules.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CellAgent, CellSubscription } from "./agent-channel-protocol.js";
import { createAgentChannelClient } from "./api-client.js";
import { createBridge, type OpenClawPort } from "./bridge.js";
import { planReconcile, SUBSCRIPTION_NOT_SIGNED_IN } from "./reconciler.js";
import {
  classifyLoginError,
  createSubscriptionAuth,
  type DeviceCodePrompt,
  type SubscriptionAccount,
  type SubscriptionAuthDriver,
} from "./subscription-auth.js";
import { type FakeAgentChannelApi, startFakeAgentChannelApi } from "./testing/fake-agent-channel-api.js";

const FLOW = "0199a000-0000-7000-8000-00000000f001";
const ACCOUNT: SubscriptionAccount = { email: "owner@example.test", planType: "plus" };
const CODEX: CellSubscription = {
  id: "openai-codex",
  kind: "openai-codex",
  runtimeProvider: "openai",
  models: ["gpt-6-astra"],
  account: { email: ACCOUNT.email },
};
const BOT: CellAgent = {
  id: "agent-codex",
  handle: "codex",
  displayName: "Codex PM",
  avatarUrl: null,
  description: null,
  instructions: "Be brief.",
  status: "provisioning",
  modelRef: "openai-codex/gpt-6-astra",
  model: { provider: "openai-codex", providerId: "openai-codex", id: "gpt-6-astra" },
};

type FakeDriver = {
  stored: Map<string, SubscriptionAccount>;
  logins: number;
  logouts: number;
  prompt: DeviceCodePrompt;
  approve(a?: SubscriptionAccount): void;
  fail(message: string): void;
  driver: SubscriptionAuthDriver;
};

/** In-memory stand-in for OpenClaw's device-code login + auth store. */
function fakeDriver(): FakeDriver {
  let approve: ((a: SubscriptionAccount) => void) | null = null;
  let fail: ((e: Error) => void) | null = null;
  const d: FakeDriver = {
    stored: new Map<string, SubscriptionAccount>(),
    logins: 0,
    logouts: 0,
    prompt: {
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGHI",
      expiresInMs: 900_000,
    },
    approve: (a: SubscriptionAccount = ACCOUNT) => approve?.(a),
    fail: (message: string) => fail?.(new Error(message)),
    driver: {
      async login({ provider, signal, onDeviceCode }) {
        d.logins++;
        await onDeviceCode(d.prompt);
        const account = await new Promise<SubscriptionAccount>((resolve, reject) => {
          approve = resolve;
          fail = reject;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        d.stored.set(provider, account);
        return account;
      },
      async status(provider) {
        return d.stored.get(provider) ?? null;
      },
      async logout(provider) {
        d.logouts++;
        d.stored.delete(provider);
      },
    },
  };
  return d;
}

let api: FakeAgentChannelApi;
let abort: AbortController;

beforeEach(async () => {
  api = await startFakeAgentChannelApi();
  abort = new AbortController();
});
afterEach(async () => {
  abort.abort();
  await api.close();
});

function setup(driver = fakeDriver()) {
  const client = createAgentChannelClient({
    apiUrl: api.url,
    token: () => api.token,
    backoff: { baseMs: 1, maxMs: 2 },
  });
  const logs: string[] = [];
  const log = {
    info: (m: string) => logs.push(m),
    warn: (m: string) => logs.push(m),
    error: (m: string) => logs.push(m),
  };
  const auth = createSubscriptionAuth({
    client,
    driver: driver.driver,
    signal: abort.signal,
    log,
    reporterId: "cell-test-1",
  });
  return { client, auth, driver, logs };
}

const start = (over: Record<string, unknown> = {}) => ({
  type: "provider.auth.start" as const,
  seq: 1,
  flowId: FLOW,
  provider: "openai-codex" as const,
  method: "device-code" as const,
  startBefore: new Date(Date.now() + 60_000).toISOString(),
  ...over,
});

describe("subscription sign-in in the cell", () => {
  it("start → reports the code → approved → reports the account (never tokens), code never logged", async () => {
    const { auth, driver, logs } = setup();
    auth.handleStart(start());
    await api.waitFor(() => api.authReports.length >= 1);
    expect(api.authReports[0]).toMatchObject({
      provider: "openai-codex",
      flowId: FLOW,
      reporterId: "cell-test-1",
      state: "pending",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGHI",
    });
    expect(Date.parse(api.authReports[0]!.expiresAt!)).toBeGreaterThan(Date.now() + 800_000);

    driver.approve();
    await api.waitFor(() => api.authReports.length >= 2);
    expect(api.authReports[1]).toEqual({
      provider: "openai-codex",
      flowId: FLOW,
      reporterId: "cell-test-1",
      state: "connected",
      account: ACCOUNT,
    });
    expect(logs.join("\n")).not.toContain("ABCD-EFGHI");
    expect(await driver.driver.status("openai-codex")).toEqual(ACCOUNT);
  });

  it("ignores stale (replayed) start commands", async () => {
    const { auth, driver } = setup();
    auth.handleStart(start({ startBefore: new Date(Date.now() - 1).toISOString() }));
    await new Promise((r) => setTimeout(r, 30));
    expect(driver.logins).toBe(0);
    expect(api.authReports).toEqual([]);
  });

  it("cancel aborts the login without an error report", async () => {
    const { auth } = setup();
    auth.handleStart(start());
    await api.waitFor(() => api.authReports.length >= 1);
    auth.handleCancel({ type: "provider.auth.cancel", seq: 2, flowId: FLOW, provider: "openai-codex" });
    await Promise.all(auth.running());
    expect(api.authReports.map((r) => r.state)).toEqual(["pending"]);
  });

  it("a 409 on the pending report (another instance owns the flow) stops this attempt silently", async () => {
    api.authResponder = () => 409;
    const { auth, logs } = setup();
    auth.handleStart(start());
    await api.waitFor(() => api.authReports.length >= 1);
    await Promise.all(auth.running());
    expect(api.authReports).toHaveLength(1);
    expect(logs.some((l) => l.includes("stopped (claimed)"))).toBe(true);
  });

  it("login failures are classified (expired / denied / unsupported / failed)", async () => {
    const { auth, driver } = setup();
    auth.handleStart(start());
    await api.waitFor(() => api.authReports.length >= 1);
    driver.fail("OpenAI device authorization timed out after 15 minutes.");
    await api.waitFor(() => api.authReports.length >= 2);
    expect(api.authReports[1]).toMatchObject({ state: "error", error: { code: "expired" } });

    expect(classifyLoginError(new Error("OpenAI device authorization failed: access_denied")).code).toBe(
      "denied",
    );
    expect(
      classifyLoginError(new Error("OpenAI Codex device code login is not enabled for this server.")).code,
    ).toBe("unsupported");
    const generic = classifyLoginError(new Error("boom ABCD-EFGHI boom"), "ABCD-EFGHI");
    expect(generic).toEqual({ code: "failed", message: "boom [code] boom" });
  });

  it("revoke deletes the stored credential", async () => {
    const { auth, driver } = setup();
    driver.stored.set("openai-codex", ACCOUNT);
    await auth.handleRevoke({ type: "provider.auth.revoke", seq: 3, provider: "openai-codex" });
    expect(driver.logouts).toBe(1);
    expect(await driver.driver.status("openai-codex")).toBeNull();
  });

  it("sync: ready when signed in; reports a lost sign-in once; drops credentials disconnected while offline", async () => {
    const { auth, driver } = setup();
    driver.stored.set("openai-codex", ACCOUNT);
    expect([...(await auth.sync({ subscriptions: [CODEX] }))]).toEqual(["openai-codex"]);
    expect(api.authReports).toEqual([]);

    // Plan upgraded: identity refreshed out of band.
    driver.stored.set("openai-codex", { email: "new@example.test", planType: "pro" });
    await auth.sync({ subscriptions: [CODEX] });
    expect(api.authReports.at(-1)).toMatchObject({
      flowId: null,
      state: "connected",
      account: { email: "new@example.test" },
    });

    driver.stored.clear();
    expect((await auth.sync({ subscriptions: [CODEX] })).size).toBe(0);
    await auth.sync({ subscriptions: [CODEX] });
    expect(api.authReports.filter((r) => r.state === "disconnected")).toHaveLength(1);

    // Older API (no field): never touch stored sign-ins. Field present without it: log out.
    driver.stored.set("openai-codex", ACCOUNT);
    await auth.sync({});
    expect(driver.logouts).toBe(0);
    await auth.sync({ subscriptions: [] });
    expect(driver.logouts).toBe(1);
  });

  it("bridge: auth commands from the stream, bots on a subscription are ready only once signed in", async () => {
    const driver = fakeDriver();
    const { client, auth } = setup(driver);
    api.agents = [BOT];
    api.cellSubscriptions = [CODEX];
    const reconciled: Array<ReadonlySet<string> | undefined> = [];
    const port: OpenClawPort = {
      async dispatchMention() {},
      async reconcile(cell, opts) {
        reconciled.push(opts?.readySubscriptions);
        const plan = planReconcile({}, cell, opts);
        return { changed: plan.changed, results: plan.results };
      },
    };
    const bridge = createBridge({ client, port, signal: abort.signal, subscriptions: auth });
    await bridge.refreshCell();
    expect(api.statusReports.at(-1)).toEqual({
      agentId: BOT.id,
      status: "error",
      detail: SUBSCRIPTION_NOT_SIGNED_IN,
    });

    await bridge.handleFrame({ seq: 5, type: "provider.auth.start", data: start() });
    await api.waitFor(() => api.authReports.some((r) => r.state === "pending"));
    driver.approve();
    await api.waitFor(() => api.authReports.some((r) => r.state === "connected"));

    // The API answers a connect with cell.config.changed → refresh → the bot becomes ready.
    await bridge.handleFrame({ seq: 6, type: "cell.config.changed", data: {} });
    expect([...(reconciled.at(-1) ?? [])]).toEqual(["openai-codex"]);
    expect(api.statusReports.at(-1)).toEqual({ agentId: BOT.id, status: "ready" });

    await bridge.handleFrame({
      seq: 7,
      type: "provider.auth.revoke",
      data: { type: "provider.auth.revoke", seq: 7, provider: "openai-codex" },
    });
    expect(driver.stored.size).toBe(0);
  });
});
