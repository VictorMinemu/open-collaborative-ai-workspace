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

type Json = Record<string, unknown>;

let ipSeq = 10;
/** A fresh documentation-range client IP per case, so the per-IP limits of one case never touch another. */
const nextIp = () => `198.51.100.${ipSeq++}`;

const anon = () => new TestClient(stack.baseUrl);

function startPairing(
  ip: string,
  body: Json = { name: "rack-1", platform: "linux", runtimeVersion: "0.1.0" },
) {
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
  return {
    ip,
    deviceCode: res.body!.deviceCode as string,
    userCode: res.body!.userCode as string,
    body: res.body!,
  };
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
    expect(body.verificationUriComplete).toBe(
      `${WEB_ORIGIN}/settings/devices?pair=${body.userCode as string}`,
    );
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
    expect(enrolled[0]).toMatchObject({
      metadata: { name: "Víctor's MacBook", platform: "darwin", via: "code" },
    });

    const reuse = await anon().request("POST", "/api/v1/devices/enroll", {
      code,
      name: "y",
      platform: "linux",
    });
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

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const recordKey = (deviceCode: string) => `ocw:pair:dc:${sha(deviceCode)}`;

/** Move the stored `lastPollAt` back by `ms` (instead of sleeping through the interval). */
async function agePoll(deviceCode: string, ms: number) {
  const redis = stack.built.core.bus.pub;
  const raw = await redis.get(recordKey(deviceCode));
  const record = JSON.parse(raw!) as { lastPollAt: string | null };
  record.lastPollAt = new Date(Date.now() - ms).toISOString();
  await redis.set(recordKey(deviceCode), JSON.stringify(record), { expiration: "KEEPTTL" });
}

async function enrollmentRows(deviceCode: string): Promise<number> {
  const { rows } = await su.query(
    "select count(*)::int as n from app.device_enrollments where code_hash = $1",
    [sha(`pair:${deviceCode}`)],
  );
  return rows[0].n as number;
}

describe("every RFC 8628 answer, lookup, deny and single use (Task 2)", () => {
  it("pending: authorization_pending, then slow_down within the interval, then pending again", async () => {
    const { ip, deviceCode } = await started();
    const first = await poll(ip, deviceCode);
    expect(first.status).toBe(400);
    expect(errorCode(first)).toBe("authorization_pending");
    const fast = await poll(ip, deviceCode);
    expect(fast.status).toBe(400);
    expect(errorCode(fast)).toBe("slow_down");
    await agePoll(deviceCode, 6_000);
    const later = await poll(ip, deviceCode);
    expect(errorCode(later)).toBe("authorization_pending");
    // A device code nobody started reads as expired (start again).
    const unknown = await poll(ip, "x".repeat(43));
    expect(unknown.status).toBe(400);
    expect(errorCode(unknown)).toBe("expired_token");
  });

  it("lookup shows what is asking, without the device code; unknown and malformed codes are refused", async () => {
    const ip = nextIp();
    const { deviceCode, userCode } = await started(ip, {
      name: "gpu-box",
      platform: "linux",
      runtimeVersion: "0.2.0",
    });
    const { client: approver } = await freshAdmin();
    const view = await approver.request("POST", "/api/v1/devices/pairings/lookup", {
      userCode: userCode.toLowerCase(),
    });
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body).toMatchObject({
      userCode,
      name: "gpu-box",
      platform: "linux",
      runtimeVersion: "0.2.0",
      requestIp: ip,
    });
    const requestedAt = new Date(view.body!.requestedAt as string).getTime();
    const expiresAt = new Date(view.body!.expiresAt as string).getTime();
    expect(expiresAt - requestedAt).toBe(600_000);
    expect(JSON.stringify(view.body)).not.toContain(deviceCode);

    const unknown = await approver.request("POST", "/api/v1/devices/pairings/lookup", {
      userCode: "ZZZZ-ZZZZ",
    });
    expect(unknown.status).toBe(404);
    expect(errorCode(unknown)).toBe("pairing_not_found");
    const malformed = await approver.request("POST", "/api/v1/devices/pairings/lookup", {
      userCode: "UUUU-UUUU",
    });
    expect(malformed.status).toBe(400);
  });

  it("deny: audited, the next poll is access_denied, then expired_token; a later approve is 404", async () => {
    const { ip, deviceCode, userCode } = await started();
    const { client: approver, userId } = await freshAdmin();
    const deny = await approver.request("POST", "/api/v1/devices/pairings/deny", { userCode });
    expect(deny.status, JSON.stringify(deny.body)).toBe(200);
    const denied = (await auditRows("device.pairing_denied")).filter((r) => r.actor_id === userId);
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      organization_id: orgA,
      resource_type: "device_pairing",
      metadata: { requestedName: "rack-1", platform: "linux", requestIp: ip },
    });
    expect(JSON.stringify(denied)).not.toContain(userCode.replace("-", ""));

    const first = await poll(ip, deviceCode);
    expect(first.status).toBe(400);
    expect(errorCode(first)).toBe("access_denied");
    const second = await poll(ip, deviceCode);
    expect(errorCode(second)).toBe("expired_token");
    const approve = await approver.request("POST", "/api/v1/devices/pairings/approve", {
      userCode,
      name: "x",
    });
    expect(approve.status).toBe(404);
    expect(await enrollmentRows(deviceCode)).toBe(0);
  });

  it("single use: after the token a poll is expired_token, approving again is 404, one device only", async () => {
    const { ip, deviceCode, userCode } = await started(nextIp(), { name: "once-1", platform: "darwin" });
    const { client: approver } = await freshAdmin();
    expect(
      (await approver.request("POST", "/api/v1/devices/pairings/approve", { userCode, name: "Once" })).status,
    ).toBe(200);
    const token = await poll(ip, deviceCode);
    expect(token.status, JSON.stringify(token.body)).toBe(200);
    expect(token.body).toMatchObject({ name: "Once" });
    const again = await poll(ip, deviceCode);
    expect(again.status).toBe(400);
    expect(errorCode(again)).toBe("expired_token");
    const reapprove = await approver.request("POST", "/api/v1/devices/pairings/approve", {
      userCode,
      name: "Twice",
    });
    expect(reapprove.status).toBe(404);
    const { rows } = await su.query(
      "select count(*)::int as n from app.devices where name in ('Once', 'Twice')",
    );
    expect(rows[0].n).toBe(1);
    expect(await enrollmentRows(deviceCode)).toBe(1);
  });

  it("expiry: once Redis forgets the request, the poll is expired_token and the lookup 404", async () => {
    const { ip, deviceCode, userCode } = await started();
    const redis = stack.built.core.bus.pub;
    const ucKey = `ocw:pair:uc:${sha(userCode.replace("-", ""))}`;
    expect(await redis.ttl(recordKey(deviceCode))).toBeGreaterThan(590);
    expect(await redis.ttl(ucKey)).toBeGreaterThan(590);
    await redis.del([recordKey(deviceCode), ucKey]);
    const res = await poll(ip, deviceCode);
    expect(errorCode(res)).toBe("expired_token");
    const { client: approver } = await freshAdmin();
    const lookup = await approver.request("POST", "/api/v1/devices/pairings/lookup", { userCode });
    expect(lookup.status).toBe(404);
  });

  it("race: two approvals at once give one 200 and one 409 already_decided, one enrollment row", async () => {
    const { deviceCode, userCode } = await started();
    const [{ client: a }, { client: b }] = await Promise.all([freshAdmin(), freshAdmin()]);
    const results = await Promise.all([
      a.request("POST", "/api/v1/devices/pairings/approve", { userCode, name: "A" }),
      b.request("POST", "/api/v1/devices/pairings/approve", { userCode, name: "B" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(errorCode(results.find((r) => r.status === 409)!)).toBe("already_decided");
    expect(await enrollmentRows(deviceCode)).toBe(1);
    // Approved first, so a deny afterwards loses.
    const deny = await a.request("POST", "/api/v1/devices/pairings/deny", { userCode });
    expect(deny.status).toBe(409);
    expect(errorCode(deny)).toBe("already_decided");
  });

  it("race: an approval and a denial at once give one 200 and one 409; the loser leaves no row behind", async () => {
    const { deviceCode, userCode } = await started();
    const { client: a } = await freshAdmin();
    const { client: b, userId: bId } = await freshAdmin();
    const [approve, deny] = await Promise.all([
      a.request("POST", "/api/v1/devices/pairings/approve", { userCode, name: "A" }),
      b.request("POST", "/api/v1/devices/pairings/deny", { userCode }),
    ]);
    expect([approve.status, deny.status].sort()).toEqual([200, 409]);
    const deniedAudit = (await auditRows("device.pairing_denied")).filter((r) => r.actor_id === bId);
    expect(await enrollmentRows(deviceCode)).toBe(approve.status === 200 ? 1 : 0);
    expect(deniedAudit).toHaveLength(deny.status === 200 ? 1 : 0);
  });
});
