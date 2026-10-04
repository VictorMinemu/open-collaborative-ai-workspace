import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeCellPlugin } from "../../../../../e2e/support/fake-cell-plugin";
import {
  type FakeDeviceAuthServer,
  startFakeDeviceAuthServer,
} from "../../../../../e2e/support/fake-device-auth-server";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "../../testing";

/**
 * ChatGPT subscription (Codex) sign-in, end to end against real PostgreSQL/Redis: admin "Connect" → the
 * (fake) OpenClaw cell runs the device-code flow against a fake OAuth device-authorization server → the
 * account is recorded, audited and offered to bots. No real account, no metered call.
 */

const CELL_TOKEN = "ocw-test-cell-token-subscription-0123456789abcdef";
const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };
const ELECTRON_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ocw-desktop/0.1.0 Chrome/140.0.7339.80 Electron/38.1.0 Safari/537.36";
const ACCOUNT = { email: "owner@autofylabs.test", planType: "pro" };

let stack: TestStack;
let su: pg.Client;
let device: FakeDeviceAuthServer;
let admin: TestClient;
let member: TestClient;
let orgId: string;
let adminId: string;
const logLines: string[] = [];
const apiBodies: string[] = [];
const plugins: FakeCellPlugin[] = [];
const userCodes: string[] = [];

type AuthStatus = {
  state: string;
  flowId: string | null;
  verificationUrl: string | null;
  userCode: string | null;
  expiresAt: string | null;
  error: { code: string; message: string } | null;
  account: { email: string | null; planType: string | null; needsReconnect: boolean } | null;
  cellConnected: boolean;
};

async function call<T = unknown>(c: TestClient, method: string, path: string, body?: unknown) {
  const res = await c.request(method, path, body);
  apiBodies.push(JSON.stringify(res.body));
  return res as { status: number; body: T };
}

const authStatus = async () =>
  (await call<AuthStatus>(admin, "GET", "/api/v1/model-providers/openai-codex/auth")).body;

async function waitForState(state: string, timeoutMs = 10_000): Promise<AuthStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await authStatus();
    if (s.state === state) return s;
    if (Date.now() > deadline) throw new Error(`auth state stayed ${s.state} (wanted ${state})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function startPlugin(opts: Partial<ConstructorParameters<typeof FakeCellPlugin>[0]> = {}) {
  const p = new FakeCellPlugin({
    apiUrl: stack.baseUrl,
    token: CELL_TOKEN,
    autoAck: true,
    deviceAuth: { serverUrl: device.url, pollMs: 50 },
    ...opts,
  });
  plugins.push(p);
  return p;
}

const audit = async (action: string) =>
  (
    await su.query(
      "select user_id, actor_kind, result, client_kind, metadata from app.audit_events where action = $1 and organization_id = $2 order by occurred_at, id",
      [action, orgId],
    )
  ).rows as Array<{
    user_id: string | null;
    actor_kind: string;
    result: string;
    client_kind: string | null;
    metadata: Record<string, unknown>;
  }>;

const cellEventTypes = async () =>
  (
    await su.query("select type from app.stream_events where stream_id = $1 order by seq", [`cell:${orgId}`])
  ).rows.map((r: { type: string }) => r.type);

let plugin: FakeCellPlugin;

beforeAll(async () => {
  device = await startFakeDeviceAuthServer({ email: ACCOUNT.email, planType: ACCOUNT.planType });
  stack = await startTestStack({
    env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock", LOG_LEVEL: "trace" },
    logStream: { write: (line) => void logLines.push(line) },
  });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await call<{ user: { id: string }; organization: { id: string } }>(
    admin,
    "POST",
    "/api/v1/setup",
    { token: TEST_SETUP_TOKEN, ...ADMIN, orgName: "Autofy Labs" },
  );
  expect(setup.status).toBe(200);
  orgId = setup.body.organization.id;
  adminId = setup.body.user.id;
  const inv = await call<{ id: string }>(admin, "POST", "/api/v1/invitations", {
    email: "alex@example.test",
    role: "developer",
  });
  member = new TestClient(stack.baseUrl);
  await call(member, "POST", `/api/v1/invitations/${inv.body.id}/accept`, {
    name: "Alex",
    password: "another-long-password",
  });
}, 180_000);

afterAll(async () => {
  for (const p of plugins) await p.stop();
  await device?.close();
  await su?.end();
  await stack?.stop();
});

describe("ChatGPT subscription sign-in (device code in the cell)", () => {
  it("is decided as provider.manage (a developer gets 403) and refuses to start without a connected cell", async () => {
    for (const method of ["GET", "POST", "DELETE"]) {
      const denied = await call<{ error: { code: string; details: Record<string, unknown> } }>(
        member,
        method,
        "/api/v1/model-providers/openai-codex/auth",
        method === "POST" ? {} : undefined,
      );
      expect(denied.status, method).toBe(403);
      expect(denied.body.error.details).toMatchObject({ permission: "provider.manage", layer: "role" });
    }
    expect((await call(admin, "GET", "/api/v1/model-providers/anthropic/auth")).status).toBe(400);

    const idle = await authStatus();
    expect(idle).toMatchObject({ state: "idle", userCode: null, account: null, cellConnected: false });
    const offline = await call<{ error: { code: string } }>(
      admin,
      "POST",
      "/api/v1/model-providers/openai-codex/auth",
      {},
    );
    expect(offline.status).toBe(409);
    expect(offline.body.error.code).toBe("cell_offline");
    // A key cannot create a subscription provider, nor edit one that is not connected.
    expect(
      (
        await call(admin, "POST", "/api/v1/model-providers", {
          provider: "openai-codex",
          apiKey: "sk-not-a-subscription-0000",
          allowedModels: ["gpt-6-astra"],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(admin, "POST", "/api/v1/model-providers", {
          provider: "openai-codex",
          allowedModels: ["gpt-6-astra"],
        })
      ).status,
    ).toBe(409);
  });

  it("connect → code shown to the admin → approved in the browser → connected, audited, offered to bots", async () => {
    plugin = startPlugin();
    await plugin.start();

    const started = await call<AuthStatus>(admin, "POST", "/api/v1/model-providers/openai-codex/auth", {});
    expect(started.status).toBe(200);
    expect(["starting", "pending"]).toContain(started.body.state);
    expect(started.body.cellConnected).toBe(true);
    const flowId = started.body.flowId;
    expect(flowId).toBeTruthy();

    const pending = await waitForState("pending");
    expect(pending.flowId).toBe(flowId);
    expect(pending.verificationUrl).toBe(`${device.url}/codex/device`);
    expect(pending.userCode).toMatch(/^[0-9A-F]{4}-[0-9A-F]{6}$/);
    expect(new Date(pending.expiresAt!).getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    userCodes.push(pending.userCode!);

    // Idempotent while pending: same flow, no second start command.
    const again = await call<AuthStatus>(admin, "POST", "/api/v1/model-providers/openai-codex/auth", {});
    expect(again.body.flowId).toBe(flowId);
    expect((await cellEventTypes()).filter((t) => t === "provider.auth.start")).toHaveLength(1);

    // The owner approves on the (fake) verification page.
    expect(device.approve(pending.userCode!)).toBe(true);
    const connected = await waitForState("connected");
    expect(connected.userCode).toBeNull();
    expect(connected.account).toMatchObject({ ...ACCOUNT, needsReconnect: false });

    const providers = await call<{ providers: Array<Record<string, unknown>> }>(
      admin,
      "GET",
      "/api/v1/model-providers",
    );
    const codex = providers.body.providers.find((p) => p.provider === "openai-codex");
    expect(codex).toMatchObject({
      authMode: "subscription",
      hasKey: false,
      keyHint: null,
      allowedModels: ["gpt-6-astra", "gpt-5.6-terra", "gpt-5.6-luna"],
      account: { email: ACCOUNT.email, planType: ACCOUNT.planType },
    });

    // Audited in the same transactions, attributed to the admin who started it.
    const startedAudit = await audit("model_provider.connect_started");
    expect(startedAudit).toHaveLength(1);
    expect(startedAudit[0]).toMatchObject({
      user_id: adminId,
      actor_kind: "user",
      result: "success",
      client_kind: "web",
    });
    const connectedAudit = await audit("model_provider.connected");
    expect(connectedAudit).toHaveLength(1);
    expect(connectedAudit[0]!.user_id).toBe(adminId);
    expect(connectedAudit[0]!.metadata).toMatchObject({
      provider: "openai-codex",
      flowId,
      accountEmail: ACCOUNT.email,
      planType: ACCOUNT.planType,
    });

    // Bots can pick the subscription models; the cell gets the subscription (never a token).
    const models = await call<{ models: Array<{ provider: string; modelId: string; label: string }> }>(
      member,
      "GET",
      "/api/v1/models",
    );
    expect(models.body.models.filter((m) => m.provider === "openai-codex").map((m) => m.label)).toEqual([
      "GPT-6 Astra",
      "GPT-5.6 Terra",
      "GPT-5.6 Luna",
    ]);
    const bot = await call<{ id: string; modelProvider: string }>(admin, "POST", "/api/v1/agents", {
      name: "Codex PM",
      instructions: "You are a product manager.",
      modelProvider: "openai-codex",
      modelId: "gpt-6-astra",
    });
    expect(bot.status).toBe(200);
    const cell = await plugin.fetchCell();
    expect(cell.subscriptions).toEqual([
      {
        id: "openai-codex",
        kind: "openai-codex",
        runtimeProvider: "openai",
        models: ["gpt-6-astra", "gpt-5.6-terra", "gpt-5.6-luna"],
        account: { email: ACCOUNT.email },
      },
    ]);
    expect(cell.providers.map((p) => p.id)).toEqual(["fake"]);
    expect(cell.agents.find((a) => a.id === bot.body.id)?.modelRef).toBe("openai-codex/gpt-6-astra");
    expect(await cellEventTypes()).toContain("cell.config.changed");

    // Allowed models stay editable; keys stay refused.
    const edited = await call(admin, "POST", "/api/v1/model-providers", {
      provider: "openai-codex",
      allowedModels: ["gpt-6-astra", "gpt-5.5"],
    });
    expect(edited.status).toBe(200);
    expect(
      (
        await call(admin, "POST", "/api/v1/model-providers", {
          provider: "openai-codex",
          apiKey: "sk-not-a-subscription-0000",
          allowedModels: ["gpt-6-astra"],
        })
      ).status,
    ).toBe(400);
  });

  it("rejects reports for unknown flows and from a second cell instance (first reporter owns the flow)", async () => {
    const started = await call<AuthStatus>(admin, "POST", "/api/v1/model-providers/openai-codex/auth", {
      restart: true,
    });
    const pending = await waitForState("pending");
    userCodes.push(pending.userCode!);
    const other = new FakeCellPlugin({ apiUrl: stack.baseUrl, token: CELL_TOKEN });
    const claimed = await other.reportAuth({
      provider: "openai-codex",
      flowId: started.body.flowId,
      state: "pending",
      verificationUrl: "https://evil.example/device",
      userCode: "EVIL-CODE",
    });
    expect(claimed.status).toBe(409);
    expect((claimed.body as { error: { code: string } }).error.code).toBe("flow_claimed");
    const unknown = await other.reportAuth({
      provider: "openai-codex",
      flowId: randomUUID(),
      state: "connected",
      account: { email: "x@y.z", planType: "free" },
    });
    expect(unknown.status).toBe(409);
    expect((await authStatus()).verificationUrl).toBe(`${device.url}/codex/device`);

    // Cancel: the cell is told, the flow ends, the code disappears.
    const cancelled = await call<AuthStatus>(admin, "DELETE", "/api/v1/model-providers/openai-codex/auth");
    expect(cancelled.body.state).toBe("error");
    expect(cancelled.body.error?.code).toBe("cancelled");
    expect(cancelled.body.userCode).toBeNull();
    await plugin.waitFor((e) => e.type === "provider.auth.cancel");
    expect(await audit("model_provider.connect_cancelled")).toHaveLength(1);
  });

  it("start and cancel from the desktop app are audited with client kind desktop", async () => {
    const res = await fetch(`${stack.baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: WEB_ORIGIN, "content-type": "application/json", "user-agent": ELECTRON_UA },
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
    });
    expect(res.status).toBe(200);
    const desktop = new TestClient(stack.baseUrl);
    for (const c of res.headers.getSetCookie()) {
      const [pair = ""] = c.split(";");
      const i = pair.indexOf("=");
      desktop.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const started = await call(desktop, "POST", "/api/v1/model-providers/openai-codex/auth", {
      restart: true,
    });
    expect(started.status).toBe(200);
    userCodes.push((await waitForState("pending")).userCode!);
    expect((await call(desktop, "DELETE", "/api/v1/model-providers/openai-codex/auth")).status).toBe(200);
    expect((await audit("model_provider.connect_started")).at(-1)).toMatchObject({
      user_id: adminId,
      client_kind: "desktop",
    });
    expect((await audit("model_provider.connect_cancelled")).at(-1)).toMatchObject({
      user_id: adminId,
      client_kind: "desktop",
    });
  });

  it("a denied request ends in a clear error and is audited", async () => {
    await call(admin, "POST", "/api/v1/model-providers/openai-codex/auth", { restart: true });
    const pending = await waitForState("pending");
    userCodes.push(pending.userCode!);
    expect(device.deny(pending.userCode!)).toBe(true);
    const failed = await waitForState("error");
    expect(failed.error?.code).toBe("denied");
    expect(failed.error?.message).toMatch(/denied/i);
    const rows = await audit("model_provider.connect_failed");
    expect(rows.at(-1)).toMatchObject({ result: "error", metadata: { code: "denied" } });
    // The existing connection is untouched by a failed re-connect.
    expect(failed.account?.email).toBe(ACCOUNT.email);
  });

  it("a cell that lost its credentials flags the subscription for reconnection", async () => {
    const lost = await plugin.reportAuth({ provider: "openai-codex", flowId: null, state: "disconnected" });
    expect(lost.status).toBe(200);
    expect((await authStatus()).account?.needsReconnect).toBe(true);
    expect(await audit("model_provider.credentials_lost")).toHaveLength(1);
    // A fresh sign-in clears the flag.
    await call(admin, "POST", "/api/v1/model-providers/openai-codex/auth", { restart: true });
    const pending = await waitForState("pending");
    userCodes.push(pending.userCode!);
    device.approve(pending.userCode!);
    expect((await waitForState("connected")).account?.needsReconnect).toBe(false);
  });

  it("disconnect deletes the row, tells the cell to drop its credentials and is audited", async () => {
    expect(plugin.credentials.get("openai-codex")).toEqual(ACCOUNT);
    const removed = await call(admin, "DELETE", "/api/v1/model-providers/openai-codex");
    expect(removed.status).toBe(200);
    await plugin.waitFor((e) => e.type === "provider.auth.revoke");
    await plugin.waitUntil(() => !plugin.credentials.has("openai-codex"));
    expect((await audit("model_provider.disconnected"))[0]).toMatchObject({
      user_id: adminId,
      metadata: { provider: "openai-codex", accountEmail: ACCOUNT.email },
    });
    const idle = await authStatus();
    expect(idle).toMatchObject({ state: "idle", account: null });
    expect((await plugin.fetchCell()).subscriptions).toEqual([]);
    const models = await call<{ models: Array<{ provider: string }> }>(admin, "GET", "/api/v1/models");
    expect(models.body.models.some((m) => m.provider === "openai-codex")).toBe(false);
  });

  it("an expired code ends in `expired`", async () => {
    for (const p of plugins) await p.stop();
    const shortLived = await startFakeDeviceAuthServer({ codeTtlMs: 300 });
    try {
      const p = startPlugin({ deviceAuth: { serverUrl: shortLived.url, pollMs: 100 } });
      await p.start();
      await call(admin, "POST", "/api/v1/model-providers/openai-codex/auth", { restart: true });
      const failed = await waitForState("error");
      expect(failed.error?.code).toBe("expired");
      userCodes.push(...shortLived.codes.map((c) => c.userCode));
    } finally {
      await shortLived.close();
    }
  });

  it("codes and tokens never reach logs, streams, audit or other API responses", async () => {
    expect(userCodes.length).toBeGreaterThanOrEqual(4);
    expect(logLines.length).toBeGreaterThan(10);
    const streams = (await su.query("select payload::text as p from app.stream_events")).rows.map(
      (r: { p: string }) => r.p,
    );
    const audits = (await su.query("select metadata::text as m from app.audit_events")).rows.map(
      (r: { m: string }) => r.m,
    );
    for (const code of userCodes) {
      for (const line of logLines) expect(line).not.toContain(code);
      for (const p of streams) expect(p).not.toContain(code);
      for (const m of audits) expect(m).not.toContain(code);
    }
    // Refresh/access tokens only ever exist inside the (fake) cell.
    for (const text of [...logLines, ...streams, ...audits, ...apiBodies]) {
      expect(text).not.toContain("fake-refresh-");
      expect(text).not.toContain("fake-verifier");
    }
    // The only /api/v1 bodies with a code are the admin's own auth-status responses.
    for (const body of apiBodies) {
      if (userCodes.some((c) => body.includes(c))) expect(body).toContain('"state":"pending"');
    }
  });
});
