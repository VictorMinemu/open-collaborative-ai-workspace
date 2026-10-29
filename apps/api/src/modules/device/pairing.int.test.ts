import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "../../testing";
import { FakeDevice } from "../../testing-device";
import { errorCode, invite } from "../../testing-workzone";

/**
 * Phase 07.12-02 (HSR-03, D-03, PD-06..PD-08): terminal pairing by device code against real PostgreSQL and Redis. A
 * server starts a pairing without a session, a signed-in owner holding `device.pair` approves it by its user code, and
 * the server's poll gets today's `ocwd_` device token through the same enroll transaction as the typed code. The stack
 * trusts one proxy hop so each case can speak from its own client IP (the per-IP limits are per stack).
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };
const USER_CODE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let victorId: string;
let orgA: string;
const devices: FakeDevice[] = [];

type Res = { status: number; body: Record<string, unknown> | null };
type Json = Record<string, unknown>;

let ipSeq = 10;
/** A fresh documentation-range client IP per case, so the per-IP limits of one case never touch another. */
const nextIp = () => `198.51.100.${ipSeq++}`;

const anon = () => new TestClient(stack.baseUrl);

function startPairing(ip: string, body: Json = { name: "rack-1", platform: "linux", runtimeVersion: "0.1.0" }) {
  return anon().request("POST", "/api/v1/devices/pairings", body, { headers: { "x-forwarded-for": ip } });
}

function poll(ip: string, deviceCode: string) {
  return anon().request(
    "POST",
    "/api/v1/devices/pairings/token",
    { deviceCode },
    { headers: { "x-forwarded-for": ip } },
  );
}

async function started(ip = nextIp(), body?: Json) {
  const res = await startPairing(ip, body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { ip, deviceCode: res.body!.deviceCode as string, userCode: res.body!.userCode as string, body: res.body! };
}

let adminSeq = 0;
/** A new admin of organization A (each approver has its own per-user bucket). */
async function freshAdmin() {
  adminSeq++;
  return invite(stack, victor, `approver-${adminSeq}@example.test`, `Approver ${adminSeq}`, "admin");
}

async function auditRows(action: string): Promise<Array<Json>> {
  const { rows } = await su.query(
    "select organization_id, actor_id, device_id, resource_type, metadata from app.audit_events where action = $1 order by occurred_at",
    [action],
  );
  return rows;
}

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_TRUST_PROXY: "1" } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  victor = new TestClient(stack.baseUrl);
  const setup = await victor.request("POST", "/api/v1/setup", {
    token: TEST_SETUP_TOKEN,
    ...ADMIN,
    orgName: "Autofy Labs",
  });
  expect(setup.status, JSON.stringify(setup.body)).toBe(200);
  orgA = (setup.body!.organization as { id: string }).id;
  victorId = ((await victor.request("GET", "/api/v1/me")).body!.user as { id: string }).id;
}, 180_000);

afterAll(async () => {
  for (const d of devices) await d.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

describe("start → approve → token (Task 1)", () => {
  it("a server with no session starts a pairing and gets a short code, the link and a poll secret", async () => {
    const ip = nextIp();
    const res = await startPairing(ip);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body!;
    expect(body.userCode).toMatch(USER_CODE);
    expect(body.verificationUri).toBe(`${WEB_ORIGIN}/settings/devices?add=server`);
    expect(body.verificationUriComplete).toBe(`${WEB_ORIGIN}/settings/devices?pair=${body.userCode as string}`);
    expect(body.expiresIn).toBe(600);
    expect(body.interval).toBe(5);
    expect((body.deviceCode as string).length).toBeGreaterThanOrEqual(32);
    // Only hashes reach Redis: neither code is a key or a value.
    const keys = await stack.built.core.bus.pub.keys("ocw:pair:*");
    const values = await Promise.all(keys.map((k) => stack.built.core.bus.pub.get(k)));
    const dump = JSON.stringify([keys, values]);
    expect(dump).not.toContain(body.deviceCode as string);
    expect(dump).not.toContain((body.userCode as string).replace("-", ""));
    expect(dump).not.toContain(body.userCode as string);
  });

  it("the owner approves by the typed code; the next poll mints an ocwd_ device owned by the approver", async () => {
    const { ip, deviceCode, userCode } = await started();
    const approve = await victor.request("POST", "/api/v1/devices/pairings/approve", {
      userCode: userCode.toLowerCase().replace("-", ""),
      name: "Build server",
    });
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);

    const token = await poll(ip, deviceCode);
    expect(token.status, JSON.stringify(token.body)).toBe(200);
    const body = token.body!;
    expect(body.deviceToken).toMatch(/^ocwd_/);
    expect(body).toMatchObject({
      organizationId: orgA,
      name: "Build server",
      webUrl: WEB_ORIGIN,
      organizationName: "Autofy Labs",
      ownerName: ADMIN.name,
    });

    const { rows } = await su.query(
      "select organization_id, owner_user_id, platform, name, token_hash from app.devices where id = $1",
      [body.deviceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organization_id: orgA,
      owner_user_id: victorId,
      platform: "linux",
      name: "Build server",
      token_hash: createHash("sha256")
        .update(body.deviceToken as string)
        .digest("hex"),
    });

    const device = await FakeDevice.connect(stack.baseUrl, body.deviceToken as string);
    devices.push(device);

    const approved = await auditRows("device.pairing_approved");
    expect(approved).toHaveLength(1);
    expect(approved[0]).toMatchObject({
      organization_id: orgA,
      actor_id: victorId,
      resource_type: "device_pairing",
      metadata: {
        name: "Build server",
        requestedName: "rack-1",
        platform: "linux",
        requestIp: ip,
        runtimeVersion: "0.1.0",
      },
    });
    const enrolled = (await auditRows("device.enrolled")).filter((r) => r.device_id === body.deviceId);
    expect(enrolled).toHaveLength(1);
    expect(enrolled[0]).toMatchObject({
      organization_id: orgA,
      actor_id: victorId,
      metadata: { name: "Build server", platform: "linux", via: "device_code" },
    });
    const all = JSON.stringify(await su.query("select metadata from app.audit_events"));
    expect(all).not.toContain(deviceCode);
    expect(all).not.toContain(userCode.replace("-", ""));
  });

  it("the typed-code flow answers as before plus name, webUrl, organizationName and ownerName (via: code)", async () => {
    const code = (await victor.request("POST", "/api/v1/devices/enrollments")).body!.code as string;
    const res = await anon().request("POST", "/api/v1/devices/enroll", {
      code,
      name: "Víctor's MacBook",
      platform: "darwin",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      organizationId: orgA,
      name: "Víctor's MacBook",
      webUrl: WEB_ORIGIN,
      organizationName: "Autofy Labs",
      ownerName: ADMIN.name,
    });
    expect(res.body!.deviceToken).toMatch(/^ocwd_/);
    const enrolled = (await auditRows("device.enrolled")).filter((r) => r.device_id === res.body!.deviceId);
    expect(enrolled[0]).toMatchObject({ metadata: { name: "Víctor's MacBook", platform: "darwin", via: "code" } });

    const reuse = await anon().request("POST", "/api/v1/devices/enroll", { code, name: "y", platform: "linux" });
    expect(reuse.status).toBe(410);
    expect(errorCode(reuse)).toBe("code_used");
    const bad = await anon().request("POST", "/api/v1/devices/enroll", {
      code: "ZZZZ-ZZZZ",
      name: "x",
      platform: "darwin",
    });
    expect(bad.status).toBe(400);
    expect(errorCode(bad)).toBe("invalid_code");
  });
});
