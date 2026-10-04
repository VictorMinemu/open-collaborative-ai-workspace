import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "./testing";

/**
 * AUTH-06 daemon connections (D-03): the Device Link accepts 10-minute device JWTs; raw device tokens only
 * while OCW_ACCEPT_LEGACY_DEVICE_TOKEN is true (audited at most once per device per hour); revoked devices
 * and user tokens never open it.
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };

interface Ctx {
  stack: TestStack;
  su: pg.Client;
  admin: TestClient;
  logs: string[];
}

async function start(env: Record<string, string> = {}): Promise<Ctx> {
  const logs: string[] = [];
  const stack = await startTestStack({
    env: { LOG_LEVEL: "warn", ...env },
    logStream: { write: (line: string) => void logs.push(line) },
  });
  const su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  const admin = new TestClient(stack.baseUrl);
  const setup = await admin.request("POST", "/api/v1/setup", {
    token: TEST_SETUP_TOKEN,
    ...ADMIN,
    orgName: "Autofy Labs",
  });
  expect(setup.status, JSON.stringify(setup.body)).toBe(200);
  return { stack, su, admin, logs };
}

async function stop(ctx: Ctx | undefined) {
  await ctx?.su.end();
  await ctx?.stack.stop();
}

/** Pair a device through the API, as the desktop app does. */
async function enroll(ctx: Ctx, name = "Test Mac") {
  const code = await ctx.admin.request("POST", "/api/v1/devices/enrollments");
  expect(code.status).toBe(200);
  const res = await new TestClient(ctx.stack.baseUrl).request("POST", "/api/v1/devices/enroll", {
    code: code.body!.code,
    name,
    platform: "darwin",
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { deviceId: res.body!.deviceId as string, deviceToken: res.body!.deviceToken as string };
}

/** POST /api/v1/devices/token with `credential` as Bearer. */
async function exchange(ctx: Ctx, credential: string) {
  const res = await fetch(`${ctx.stack.baseUrl}/api/v1/devices/token`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, token: body.token as string | undefined };
}

/** Open `/runtime/ws` with `credential`; resolves with the open socket, rejects with `HTTP <status>`. */
function openLink(ctx: Ctx, credential: string): Promise<WebSocket> {
  const ws = new WebSocket(`${ctx.stack.baseUrl.replace(/^http/, "ws")}/runtime/ws`, {
    headers: { authorization: `Bearer ${credential}` },
  });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once("error", reject);
  });
}

async function linkOpens(ctx: Ctx, credential: string): Promise<true> {
  const ws = await openLink(ctx, credential);
  await new Promise<void>((r) => {
    ws.once("close", () => r());
    ws.close();
  });
  return true;
}

async function legacyAuditRows(ctx: Ctx, deviceId: string) {
  const res = await ctx.su.query(
    "select actor_kind, actor_id, device_id, result from app.audit_events where action = 'device.legacy_token_used' and device_id = $1",
    [deviceId],
  );
  return res.rows as Array<{ actor_kind: string; actor_id: string; device_id: string; result: string }>;
}

describe("Device Link auth with legacy device tokens accepted (default until Phase 8)", () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await start();
  }, 180_000);
  afterAll(() => stop(ctx));

  it("opens with a device JWT and writes no legacy audit row", async () => {
    const { deviceId, deviceToken } = await enroll(ctx, "JWT Mac");
    const jwt = await exchange(ctx, deviceToken);
    expect(jwt.status).toBe(200);
    expect(await linkOpens(ctx, jwt.token!)).toBe(true);
    expect(await legacyAuditRows(ctx, deviceId)).toEqual([]);
  });

  it("a raw device token still opens, warned and audited at most once per device per hour", async () => {
    const { deviceId, deviceToken } = await enroll(ctx, "Legacy Mac");
    expect(await linkOpens(ctx, deviceToken)).toBe(true);
    expect(await legacyAuditRows(ctx, deviceId)).toEqual([
      { actor_kind: "device", actor_id: deviceId, device_id: deviceId, result: "success" },
    ]);
    expect(await linkOpens(ctx, deviceToken)).toBe(true);
    expect(await legacyAuditRows(ctx, deviceId)).toHaveLength(1);

    const warnings = ctx.logs.filter((l) => l.includes("legacy device token"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(deviceId);
    expect(ctx.logs.join("\n")).not.toContain(deviceToken);
  });

  it("a user access JWT never opens the Device Link, and a device JWT is not a user token", async () => {
    await expect(openLink(ctx, await ctx.admin.token())).rejects.toThrow("HTTP 401");
    const { deviceToken } = await enroll(ctx, "Audience Mac");
    const jwt = await exchange(ctx, deviceToken);
    const me = await ctx.admin.request("GET", "/api/v1/me", undefined, {
      headers: { authorization: `Bearer ${jwt.token!}` },
      noCookies: true,
    });
    expect(me.status).toBe(401);
  });

  it("a revoked device can neither obtain a device JWT nor connect with one minted before", async () => {
    const { deviceId, deviceToken } = await enroll(ctx, "Revoked Mac");
    const before = await exchange(ctx, deviceToken);
    expect(before.status).toBe(200);
    expect((await ctx.admin.request("DELETE", `/api/v1/devices/${deviceId}`)).status).toBe(200);

    expect((await exchange(ctx, deviceToken)).status).toBe(401);
    await expect(openLink(ctx, before.token!)).rejects.toThrow("HTTP 401");
    await expect(openLink(ctx, deviceToken)).rejects.toThrow("HTTP 401");
  });
});

describe("Device Link auth with OCW_ACCEPT_LEGACY_DEVICE_TOKEN=false", () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await start({ OCW_ACCEPT_LEGACY_DEVICE_TOKEN: "false" });
  }, 180_000);
  afterAll(() => stop(ctx));

  it("refuses the raw device token and still accepts the device JWT", async () => {
    const { deviceId, deviceToken } = await enroll(ctx);
    await expect(openLink(ctx, deviceToken)).rejects.toThrow("HTTP 401");
    expect(await legacyAuditRows(ctx, deviceId)).toEqual([]);

    const jwt = await exchange(ctx, deviceToken);
    expect(jwt.status).toBe(200);
    expect(await linkOpens(ctx, jwt.token!)).toBe(true);
  });
});
