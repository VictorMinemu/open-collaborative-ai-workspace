import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice } from "../../testing-device";
import { pairDevice } from "../../testing-workzone";
import { deviceSignInKey } from "./index";

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
let dana: TestClient; // developer of org A (pairs her own laptops, R3.2)
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

async function joinAs(email: string, name: string, role = "standard") {
  const inv = await ok(victor.request("POST", "/api/v1/invitations", { email, role }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

async function connect(
  name: string,
  opts: Parameters<typeof FakeDevice.connect>[3] = {},
  owner: TestClient = victor,
): Promise<Dev> {
  const paired = await pairDevice(stack, owner, name);
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
  [dana] = await joinAs("dana@example.test", "Dana Kim", "developer");
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

// ---------------------------------------------------------------- 07.18-13 T3: refusals, failures, cancel, sign-out

/** Starts a sign-in on `dev` and returns it with the `account.login` command the device received. */
async function begin(dev: Dev, label = "ops@acme") {
  const signIn = await ok(start(victor, dev.deviceId, label));
  const cmd = await dev.device.command("account.login");
  return { signIn, cmd, slotId: cmd.payload.slotId as string };
}

/** The current sign-in once `pred` holds. */
const settle = (dev: Dev, pred: (s: Json) => boolean) =>
  eventually(async () => {
    const r = await ok(current(victor, dev.deviceId));
    return r && pred(r) ? r : undefined;
  });

const failedAudits = async (flowSlot: string) =>
  (await auditRows(["account_pool.sign_in_failed"])).filter((a) => a.metadata.slotId === flowSlot);

const failedCodes = async (flowSlot: string) => (await failedAudits(flowSlot)).map((a) => a.metadata.code);

/**
 * The flow's failure audits read exactly `codes`. The end of a flow is claimed in Redis inside the transaction that
 * writes its audit, so the state can read `error` a moment before the audit row commits: wait for it (bounded), then
 * assert the exact array once more so a second audit still fails "audited once".
 */
async function expectFailedAudits(flowSlot: string, codes: string[]) {
  await expect.poll(() => failedCodes(flowSlot), { timeout: 10_000, interval: 50 }).toEqual(codes);
  expect(await failedCodes(flowSlot)).toEqual(codes);
}

/** Rewrites the device's Redis flow record (to age it without waiting). */
async function ageRecord(dev: Dev, patch: Json) {
  const redis = stack.built.core.bus.pub;
  const key = deviceSignInKey(orgA, dev.deviceId);
  const raw = await redis.get(key);
  if (!raw) throw new Error("no flow record");
  await redis.set(key, JSON.stringify({ ...JSON.parse(raw), ...patch }), {
    expiration: { type: "EX", value: 600 },
  });
}

describe("refusals, failures, cancel and sign-out on removal (07.18-13 T3)", () => {
  let desktop: Dev;
  let old: Dev;
  let other: Dev;

  beforeAll(async () => {
    // R3.2: a member's laptop that is not shared with the admin (another member's private device).
    desktop = await connect("Dana's laptop", { host: "desktop", accountPool: 1 }, dana);
    old = await connect("Old server", { host: "service" });
    other = await connect("Other server", { host: "service", accountPool: 1 });
  }, 120_000);

  afterAll(async () => {
    for (const dev of [desktop, old, other]) await dev?.device.close().catch(() => {});
  });

  it("another member's private laptop, an older daemon, an offline or a revoked device are refused, with plain sentences", async () => {
    // R3.2: the command to run on the device instead, never a sign-in on someone else's private laptop.
    const notYours = await fails(start(victor, desktop.deviceId), 409, "device_not_allowed");
    expect(notYours.error.message).toContain("ocw-runtime account add codex");
    const tooOld = await fails(start(victor, old.deviceId), 409, "not_a_service_device");
    expect(tooOld.error.message).toContain("Update the OCW runtime on this device first");

    const offline = await pairDevice(stack, victor, "Parked server");
    await su.query(
      "update app.devices set host_kind = 'service', account_pool_version = 1, status = 'offline' where id = $1",
      [offline.deviceId],
    );
    await fails(start(victor, offline.deviceId), 409, "device_offline");

    const revoked = await pairDevice(stack, victor, "Revoked server");
    await su.query(
      "update app.devices set host_kind = 'service', account_pool_version = 1, status = 'online', revoked_at = now() where id = $1",
      [revoked.deviceId],
    );
    await fails(start(victor, revoked.deviceId), 409, "device_offline");

    expect(desktop.device.pending("account.login")).toEqual([]);
    expect(old.device.pending("account.login")).toEqual([]);
    expect(await auditRows(["account_pool.sign_in_started"])).toHaveLength(1); // only T1's
  });

  it("one sign-in per device: a second start while one is pending answers it and sends no second command", async () => {
    const { signIn, cmd, slotId } = await begin(other);
    other.device.send(codeFrame(cmd.id, slotId));
    await settle(other, (s) => s.state === "pending");
    const again = await ok(start(victor, other.deviceId, "someone-else@acme"));
    expect(again).toMatchObject({ id: signIn.id, label: "ops@acme", state: "pending" });
    await new Promise((r) => setTimeout(r, 300));
    expect(other.device.pending("account.login")).toEqual([]);

    // Cancel: the device signs the slot out; the flow reads cancelled, audited once with the code only.
    const cancelled = await ok(cancel(victor, other.deviceId));
    expect(cancelled).toMatchObject({ state: "error", error: { code: "cancelled" }, userCode: null });
    const logout = await other.device.command("account.logout");
    expect(logout.payload).toEqual({ slotId });
    other.device.ack(logout.id);
    // The daemon's own `failed` (cancelled) after the cancel changes nothing.
    other.device.send({
      type: "account.login",
      requestId: cmd.id,
      slotId,
      phase: "failed",
      error: { code: "cancelled", message: "cancelled" },
    });
    other.device.ack(cmd.id, false, "cancelled");
    await new Promise((r) => setTimeout(r, 300));
    expect(await ok(current(victor, other.deviceId))).toMatchObject({
      state: "error",
      error: { code: "cancelled" },
    });
    const audits = await failedAudits(slotId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toEqual({
      provider: "chatgpt",
      deviceId: other.deviceId,
      slotId,
      label: "ops@acme",
      code: "cancelled",
    });
    // A cancel with nothing running answers the last flow and sends nothing.
    expect(await ok(cancel(victor, other.deviceId))).toMatchObject({ error: { code: "cancelled" } });
  });

  it("an older daemon's refusal ends runtime_too_old; a denied login ends denied; each audited once", async () => {
    const a = await begin(server);
    server.device.ack(a.cmd.id, false, "invalid command frame");
    const tooOld = await settle(server, (s) => s.state === "error");
    expect(tooOld.error).toEqual({
      code: "runtime_too_old",
      message: "Update the OCW runtime on this device first.",
    });
    await expectFailedAudits(a.slotId, ["runtime_too_old"]);

    const b = await begin(server);
    server.device.send(codeFrame(b.cmd.id, b.slotId));
    await settle(server, (s) => s.state === "pending");
    server.device.send({
      type: "account.login",
      requestId: b.cmd.id,
      slotId: b.slotId,
      phase: "failed",
      error: { code: "denied", message: `denied for ${CODE}` },
    });
    server.device.ack(b.cmd.id, false, "denied");
    const denied = await settle(server, (s) => s.state === "error");
    expect(denied).toMatchObject({
      id: b.signIn.id,
      error: { code: "denied", message: "The sign-in was denied in the browser." },
      verificationUrl: null,
      userCode: null,
    });
    await expectFailedAudits(b.slotId, ["denied"]);

    const c = await begin(server);
    server.device.send({
      type: "account.login",
      requestId: c.cmd.id,
      slotId: c.slotId,
      phase: "failed",
      error: { code: "unsupported", message: "no device code" },
    });
    expect((await settle(server, (s) => s.state === "error")).error).toEqual({
      code: "unsupported",
      message: "Update Codex on this device and try again.",
    });
  });

  it("no code within 45 s reads device_offline; a code past its expiry reads expired; each audited once", async () => {
    const a = await begin(server);
    await ageRecord(server, { startedAt: new Date(Date.now() - 60_000).toISOString() });
    const silent = await settle(server, (s) => s.state === "error");
    expect(silent.error.code).toBe("device_offline");
    await ok(current(victor, server.deviceId));
    await expectFailedAudits(a.slotId, ["device_offline"]);
    // A late code changes nothing.
    server.device.send(codeFrame(a.cmd.id, a.slotId));
    await new Promise((r) => setTimeout(r, 300));
    expect((await ok(current(victor, server.deviceId))).state).toBe("error");

    const b = await begin(server);
    server.device.send(codeFrame(b.cmd.id, b.slotId));
    await settle(server, (s) => s.state === "pending");
    await ageRecord(server, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const expired = await settle(server, (s) => s.state === "error");
    expect(expired).toMatchObject({ error: { code: "expired" }, userCode: null, verificationUrl: null });
    await expectFailedAudits(b.slotId, ["expired"]);
  });

  it("a frame for another device's command, or for no account.login, changes nothing (E11)", async () => {
    const { signIn, cmd, slotId } = await begin(server);
    // Device `other` replays server's command id and slot.
    other.device.send(codeFrame(cmd.id, slotId));
    other.device.send({
      type: "account.login",
      requestId: cmd.id,
      slotId,
      phase: "completed",
      planType: "pro",
    });
    other.device.ack(cmd.id);
    // Server itself, with an unknown request id.
    server.device.send(codeFrame(randomUUID(), slotId));
    server.device.send({ type: "account.login", requestId: randomUUID(), slotId, phase: "completed" });
    await new Promise((r) => setTimeout(r, 400));
    expect(await ok(current(victor, server.deviceId))).toMatchObject({ id: signIn.id, state: "starting" });
    expect(
      (
        await su.query("select count(*)::int as n from app.account_pool_accounts where slot_id = $1", [
          slotId,
        ])
      ).rows[0].n,
    ).toBe(0);
    await ok(cancel(victor, server.deviceId));
    server.device.ack((await server.device.command("account.logout")).id);
  });

  it("removing a device_slot account signs it out on its device, even while the device is offline", async () => {
    const { cmd, slotId } = await begin(other, "gone@acme");
    other.device.send({
      type: "account.login",
      requestId: cmd.id,
      slotId,
      phase: "completed",
      planType: "plus",
    });
    other.device.ack(cmd.id);
    const done = await settle(other, (s) => s.state === "connected");

    await ok(victor.request("DELETE", `/api/v1/account-pool/accounts/${done.accountId}`));
    const logout = await other.device.command("account.logout");
    expect(logout.payload).toEqual({ slotId });
    other.device.ack(logout.id);

    // Offline: the row is removed now, the command waits in the queue.
    const second = await begin(other, "later@acme");
    other.device.send({
      type: "account.login",
      requestId: second.cmd.id,
      slotId: second.slotId,
      phase: "completed",
    });
    other.device.ack(second.cmd.id);
    const connected = await settle(other, (s) => s.state === "connected");
    await other.device.close();
    await su.query("update app.devices set status = 'offline' where id = $1", [other.deviceId]);
    await ok(victor.request("DELETE", `/api/v1/account-pool/accounts/${connected.accountId}`));
    const row = (
      await su.query("select removed_at from app.account_pool_accounts where id = $1", [connected.accountId])
    ).rows[0];
    expect(row.removed_at).not.toBeNull();
    const queued = (
      await su.query(
        "select status, payload from app.device_commands where device_id = $1 and kind = 'account.logout' order by created_at desc limit 1",
        [other.deviceId],
      )
    ).rows[0];
    expect(queued).toMatchObject({ status: "pending", payload: { slotId: second.slotId } });
    // A removed sign-in's account reads as no sign-in.
    expect(await ok(current(victor, other.deviceId))).toBeNull();

    // A token account's removal sends nothing to any device.
    const before = (
      await su.query("select count(*)::int as n from app.device_commands where kind = 'account.logout'")
    ).rows[0].n as number;
    const token = ["sk", "ant", "oat01", "Q".repeat(48)].join("-");
    const added = await ok(
      victor.request("POST", "/api/v1/account-pool/claude/accounts", { label: "t", token }),
    );
    await ok(victor.request("DELETE", `/api/v1/account-pool/accounts/${added.id}`));
    expect(
      (await su.query("select count(*)::int as n from app.device_commands where kind = 'account.logout'"))
        .rows[0].n,
    ).toBe(before);
  });

  it("a member gets 403 on the three routes; another organization's admin gets 404 for A's device", async () => {
    await fails(start(sam, server.deviceId), 403);
    await fails(current(sam, server.deviceId), 403);
    await fails(cancel(sam, server.deviceId), 403);
    await fails(start(eve, server.deviceId), 404);
    await fails(current(eve, server.deviceId), 404);
    await fails(cancel(eve, server.deviceId), 404);
    await fails(start(victor, randomUUID()), 404);
    expect(server.device.pending("account.login")).toEqual([]);
  });
});

// ---------------------------------------------------------------- 07.18-19 R3.2: desktop devices

describe("R3.2: a desktop device the admin may use signs a ChatGPT account in from the panel", () => {
  let mine: Dev;
  let danasDesk: Dev;
  let danasDeskId = "";

  beforeAll(async () => {
    mine = await connect("Víctor's MacBook", { host: "desktop", accountPool: 1 });
    danasDesk = await connect("Dana's desk", { host: "desktop", accountPool: 1 }, dana);
    danasDeskId = danasDesk.deviceId;
  }, 120_000);

  afterAll(async () => {
    for (const dev of [mine, danasDesk]) await dev?.device.close().catch(() => {});
  });

  it("the admin's own laptop: the device runs the login and the slot joins the pool enabled", async () => {
    const { signIn, cmd, slotId } = await begin(mine, "mine@acme");
    expect(signIn).toMatchObject({ deviceId: mine.deviceId, state: "starting", label: "mine@acme" });
    expect(cmd.payload).toEqual({ provider: "chatgpt", slotId, label: "mine@acme" });
    mine.device.send({
      type: "account.login",
      requestId: cmd.id,
      slotId,
      phase: "completed",
      planType: "pro",
    });
    mine.device.ack(cmd.id);
    const done = await settle(mine, (s) => s.state === "connected");
    const pool = await ok(victor.request("GET", "/api/v1/account-pool"));
    expect((pool.chatgpt.accounts as Json[]).find((a) => a.id === done.accountId)).toMatchObject({
      kind: "device_slot",
      enabled: true,
      origin: "admin",
      device: { id: mine.deviceId },
    });
  });

  it("another member's laptop: refused until its owner shares it, then the admin signs in from the panel", async () => {
    const refused = await fails(start(victor, danasDeskId, "desk@acme"), 409, "device_not_allowed");
    expect(refused.error.message).toBe(
      'This device is not shared with you. Run "ocw-runtime account add codex" on it instead.',
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(danasDesk.device.pending("account.login")).toEqual([]);

    // The owner shares the device (Settings › Devices): the admin may use it, so the sign-in runs there.
    await ok(dana.request("PATCH", `/api/v1/devices/${danasDeskId}`, { shared: true }));
    const { signIn, cmd, slotId } = await begin(danasDesk, "desk@acme");
    expect(signIn).toMatchObject({ deviceId: danasDeskId, state: "starting" });
    expect(cmd.payload).toEqual({ provider: "chatgpt", slotId, label: "desk@acme" });
    await ok(cancel(victor, danasDeskId));
    const logout = await danasDesk.device.command("account.logout");
    danasDesk.device.ack(logout.id);

    // Shared no more: refused again (decided on every start, never remembered).
    await ok(dana.request("PATCH", `/api/v1/devices/${danasDeskId}`, { shared: false }));
    await fails(start(victor, danasDeskId, "desk@acme"), 409, "device_not_allowed");
  });
});
