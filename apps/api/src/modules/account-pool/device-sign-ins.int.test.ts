import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice } from "../../testing-device";
import { pairDevice } from "../../testing-workzone";

/**
 * Phase 07.18-13 (D-02, D-10, D-13, PD-11, PD-20, PD-25, A-08, E10, E11): an admin signs a ChatGPT account in on a
 * service device from Settings. The device runs Codex's own device-code login in a new slot and shows the code
 * through the API (admins only, never on a stream or in audit); on success the slot is an enabled `device_slot` pool
 * account usable on that device only. Refusals, failures, cancel and the sign-out of a removed slot follow.
 */

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Json | null };

const URL_ = "https://auth.openai.com/codex/device";
const CODE = "WXYZ-9876";

let stack: TestStack;
let su: pg.Client;
let victor: TestClient; // admin of org A
let sam: TestClient; // member of org A
let eve: TestClient; // admin of org B
let orgA = "";

interface Dev {
  device: FakeDevice;
  deviceId: string;
}
let server: Dev;

async function ok(res: Promise<Res>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function fails(res: Promise<Res>, status: number, code?: string): Promise<Json> {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  if (code) expect((r.body?.error as Json | undefined)?.code, JSON.stringify(r.body)).toBe(code);
  return r.body as Json;
}

async function joinAs(email: string, name: string) {
  const inv = await ok(victor.request("POST", "/api/v1/invitations", { email, role: "standard" }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

async function connect(name: string, opts: Parameters<typeof FakeDevice.connect>[3] = {}): Promise<Dev> {
  const paired = await pairDevice(stack, victor, name);
  const device = await FakeDevice.connect(stack.baseUrl, paired.token, undefined, opts);
  // The device is online once its hello was stored.
  await eventually(
    async () =>
      (await su.query("select status from app.devices where id = $1", [paired.deviceId])).rows[0]?.status ===
      "online",
  );
  return { device, deviceId: paired.deviceId };
}

const start = (client: TestClient, deviceId: string, label = "ops@acme") =>
  client.request("POST", "/api/v1/account-pool/chatgpt/device-sign-ins", { deviceId, label });
const current = (client: TestClient, deviceId: string) =>
  client.request("GET", `/api/v1/account-pool/chatgpt/device-sign-ins/current?deviceId=${deviceId}`);
const cancel = (client: TestClient, deviceId: string) =>
  client.request("DELETE", `/api/v1/account-pool/chatgpt/device-sign-ins/current?deviceId=${deviceId}`);

const auditRows = async (actions: string[]) =>
  (
    await su.query(
      "select action, resource_id, device_id, user_id, metadata from app.audit_events where organization_id = $1 and action = any($2) order by occurred_at, id",
      [orgA, actions],
    )
  ).rows as Json[];

const codeFrame = (requestId: string, slotId: string, over: Json = {}) => ({
  type: "account.login",
  requestId,
  slotId,
  phase: "code",
  verificationUrl: URL_,
  userCode: CODE,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  ...over,
});

const slotReport = (slotId: string, label: string, over: Json = {}) => ({
  slotId,
  label,
  origin: "server",
  signedIn: true,
  planType: "plus",
  usage: null,
  ...over,
});

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  victor = new TestClient(stack.baseUrl);
  const setup = await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgA = setup.organization.id;
  [sam] = await joinAs("sam@example.test", "Sam Lee");
  let eveId: string;
  [eve, eveId] = await joinAs("eve@example.test", "Eve Black");
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    orgB,
    `evil-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [eveId]);
  await su.query("delete from app.org_members where user_id = $1", [eveId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    eveId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, eveId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, eveId]);

  server = await connect("Build server", { host: "service", accountPool: 1 });
}, 240_000);

afterAll(async () => {
  await server?.device.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an admin signs a ChatGPT account in on a service device (07.18-13 T1)", () => {
  it("the device runs the login, the code reaches admins only, and the slot joins the pool enabled", async () => {
    const published = vi.spyOn(stack.built.core.realtime, "publishEphemeral");

    const res = await fetch(`${stack.baseUrl}/api/v1/account-pool/chatgpt/device-sign-ins`, {
      method: "POST",
      headers: {
        origin: "http://localhost:3999",
        cookie: victor.cookieHeader,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId: server.deviceId, label: "ops@acme" }),
    });
    const startedText = await res.text();
    expect(res.status, startedText).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const started = JSON.parse(startedText) as Json;
    expect(started).toMatchObject({
      deviceId: server.deviceId,
      label: "ops@acme",
      state: "starting",
      verificationUrl: null,
      userCode: null,
      error: null,
      accountId: null,
    });

    const cmd = await server.device.command("account.login");
    expect(cmd.id).toBe(started.id);
    expect(cmd.payload).toEqual({ provider: "chatgpt", slotId: expect.any(String), label: "ops@acme" });
    const slotId = cmd.payload.slotId as string;

    server.device.send(codeFrame(cmd.id, slotId));
    const pending = await eventually(async () => {
      const r = await ok(current(victor, server.deviceId));
      return r?.state === "pending" ? r : undefined;
    });
    expect(pending).toMatchObject({ verificationUrl: URL_, userCode: CODE, error: null });
    expect(pending.expiresAt).toEqual(expect.any(String));

    server.device.send({
      type: "account.login",
      requestId: cmd.id,
      slotId,
      phase: "completed",
      planType: "plus",
    });
    server.device.send({ type: "accounts.sync", codexSlots: [slotReport(slotId, "ops@acme")] });
    server.device.ack(cmd.id);

    const connected = await eventually(async () => {
      const r = await ok(current(victor, server.deviceId));
      return r?.state === "connected" ? r : undefined;
    });
    expect(connected).toMatchObject({ verificationUrl: null, userCode: null, error: null });
    expect(connected.accountId).toEqual(expect.any(String));

    const pool = await ok(victor.request("GET", "/api/v1/account-pool"));
    const account = (pool.chatgpt.accounts as Json[]).find((a) => a.id === connected.accountId);
    expect(account).toMatchObject({
      kind: "device_slot",
      provider: "chatgpt",
      label: "ops@acme",
      enabled: true,
      origin: "admin",
      planType: "plus",
      status: "ready",
      device: { id: server.deviceId, online: true },
    });

    // Every realtime signal says only that the sign-in changed: never the code or the link.
    const signals = published.mock.calls.filter(([, type]) => String(type).startsWith("account_pool."));
    expect(signals.length).toBeGreaterThan(0);
    for (const [topic, , data] of signals) {
      expect(topic).toBe(`org:${orgA}`);
      expect(data).toEqual({ deviceId: server.deviceId });
    }
    expect(JSON.stringify(published.mock.calls)).not.toContain(CODE);

    const audit = await auditRows([
      "account_pool.sign_in_started",
      "account_pool.signed_in",
      "account_pool.account_added",
      "account_pool.slot_reported",
    ]);
    expect(audit.map((a) => a.action)).toEqual([
      "account_pool.sign_in_started",
      "account_pool.account_added",
      "account_pool.signed_in",
    ]);
    expect(audit[0]).toMatchObject({
      device_id: server.deviceId,
      metadata: { provider: "chatgpt", deviceId: server.deviceId, slotId, label: "ops@acme" },
    });
    expect(audit[2]).toMatchObject({
      resource_id: connected.accountId,
      device_id: server.deviceId,
      metadata: {
        provider: "chatgpt",
        deviceId: server.deviceId,
        slotId,
        label: "ops@acme",
        planType: "plus",
      },
    });
    const all = JSON.stringify(
      (await su.query("select metadata from app.audit_events where organization_id = $1", [orgA])).rows,
    );
    expect(all).not.toContain(CODE);
    expect(all).not.toContain(URL_);
    const stream = JSON.stringify(
      (await su.query("select payload from app.stream_events where organization_id = $1", [orgA])).rows,
    );
    expect(stream).not.toContain(CODE);
  });
});
