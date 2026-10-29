import { createHash, randomUUID } from "node:crypto";
import { MODULE_CATALOG } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "../../testing";
import { FakeDevice } from "../../testing-device";
import { errorCode, invite } from "../../testing-workzone";
import { PAIRING_STARTS_CAP, PAIRING_STARTS_KEY } from "./pairing";

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
/** Every API log line of this file's stack (PD-08: no code ever reaches a log line). */
const logLines: string[] = [];

type Json = Record<string, unknown>;

let ipSeq = 10;
/** A fresh documentation-range client IP per case, so the per-IP limits of one case never touch another. */
const nextIp = () => `198.51.100.${ipSeq++}`;

const anon = () => new TestClient(stack.baseUrl);

/** Every code this file was given (the log case looks for each of them in every captured line). */
const issued: Array<{ deviceCode: string; userCode: string }> = [];

async function startPairing(
  ip: string,
  body: Json = { name: "rack-1", platform: "linux", runtimeVersion: "0.1.0" },
) {
  const res = await anon().request("POST", "/api/v1/devices/pairings", body, {
    headers: { "x-forwarded-for": ip },
  });
  if (res.status === 200) {
    issued.push({ deviceCode: res.body!.deviceCode as string, userCode: res.body!.userCode as string });
  }
  return res;
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
  stack = await startTestStack({
    env: { OCW_TRUST_PROXY: "1", LOG_LEVEL: "debug" },
    logStream: { write: (line) => void logLines.push(line) },
  });
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

  it("the token survives an organization name that cannot be read or does not fit: the field is left out (LO-01)", async () => {
    const identity = stack.built.core.identity;
    const original = identity.organizationName.bind(identity);
    for (const broken of [
      async () => {
        throw new Error("connection terminated");
      },
      async () => "x".repeat(201),
    ]) {
      identity.organizationName = broken;
      try {
        const { ip, deviceCode, userCode } = await started();
        const { client: approver } = await freshAdmin();
        const approve = await approver.request("POST", "/api/v1/devices/pairings/approve", {
          userCode,
          name: "Name-less org",
        });
        expect(approve.status, JSON.stringify(approve.body)).toBe(200);
        const token = await poll(ip, deviceCode);
        // The enrollment is consumed in the same request: a 500 here would lose the only copy of the token.
        expect(token.status, JSON.stringify(token.body)).toBe(200);
        expect(token.body!.deviceToken).toMatch(/^ocwd_/);
        expect(token.body).not.toHaveProperty("organizationName");
        expect(token.body).toMatchObject({ organizationId: orgA, name: "Name-less org" });
      } finally {
        identity.organizationName = original;
      }
    }
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

  it("a decision whose transaction fails after Redis flipped is undone: the request is pending again (LO-02)", async () => {
    const redis = stack.built.core.bus.pub;
    const db = stack.built.core.db;
    const original = db.withTenant;
    for (const decision of ["approve", "deny"] as const) {
      const { ip, deviceCode, userCode } = await started();
      const { client: approver } = await freshAdmin();
      // The transaction that flips this request's record fails at commit (a serialization failure, a dropped
      // connection): everything it wrote rolls back, after the Redis compare-and-set already ran.
      let armed = true;
      db.withTenant = (async (ctx: Parameters<typeof original>[0], fn: Parameters<typeof original>[1]) =>
        original.call(db, ctx, async (tx, afterCommit) => {
          const result = await fn(tx, afterCommit);
          const raw = await redis.get(recordKey(deviceCode));
          if (armed && raw && JSON.parse(raw).status !== "pending") {
            armed = false;
            throw new Error("could not serialize access due to concurrent update");
          }
          return result;
        })) as typeof original;
      let failed: Awaited<ReturnType<typeof approver.request>>;
      try {
        failed = await approver.request(
          "POST",
          `/api/v1/devices/pairings/${decision}`,
          decision === "approve" ? { userCode, name: "Retried" } : { userCode },
        );
      } finally {
        db.withTenant = original;
      }
      expect(armed, "the failing commit ran").toBe(false);
      expect(failed.status).toBe(500);
      expect(await enrollmentRows(deviceCode)).toBe(0);
      expect(JSON.parse((await redis.get(recordKey(deviceCode)))!).status).toBe("pending");

      // The approver retries and it works: no 409, no stranded "approved" without its row.
      expect((await poll(ip, deviceCode)).body).toMatchObject({ error: { code: "authorization_pending" } });
      const retry = await approver.request("POST", "/api/v1/devices/pairings/approve", {
        userCode,
        name: "Retried",
      });
      expect(retry.status, JSON.stringify(retry.body)).toBe(200);
      await agePoll(deviceCode, 10_000);
      const token = await poll(ip, deviceCode);
      expect(token.status, JSON.stringify(token.body)).toBe(200);
      expect(token.body!.deviceToken).toMatch(/^ocwd_/);
    }
  });
});

/** One deny row per Work Zone catalog pattern for `userId` (the 07.3 module-off mechanism); returns the rule ids. */
async function workZoneOff(userId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const permission of MODULE_CATALOG.work_zone.patterns) {
    const rule = await victor.request("POST", "/api/v1/permission-rules", {
      subjectKind: "user",
      subjectId: userId,
      permission,
      effect: "deny",
    });
    expect(rule.status, JSON.stringify(rule.body)).toBe(200);
    ids.push(rule.body!.id as string);
  }
  return ids;
}

/** A member leaves organization A and becomes the admin of a new organization B (the cross-tenant matrix pattern). */
async function moveToOrgB(userId: string, displayName: string): Promise<string> {
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other Co', $2)", [
    orgB,
    `o-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [userId]);
  await su.query("delete from app.org_members where user_id = $1", [userId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    userId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, $3, 'admin')",
    [orgB, userId, displayName],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, userId]);
  return orgB;
}

describe("abuse bounds and isolation (Task 3)", () => {
  it("start: one IPv6 /64 shares one budget of 10, whatever its addresses; another /64 is unaffected (LO-04)", async () => {
    const prefix = `2001:db8:${(ipSeq++).toString(16)}:1`;
    for (let i = 0; i < 10; i++)
      expect((await startPairing(`${prefix}::${(i + 1).toString(16)}`)).status).toBe(200);
    expect((await startPairing(`${prefix}:ffff:ffff:ffff:ffff`)).status).toBe(429);
    expect((await startPairing(`2001:db8:${(ipSeq++).toString(16)}:2::1`)).status).toBe(200);
  });

  it("start: over the workspace-wide cap of pending pairings answers 503 pairing_unavailable (LO-04)", async () => {
    const redis = stack.built.core.bus.pub;
    await redis.set(PAIRING_STARTS_KEY, String(PAIRING_STARTS_CAP), {
      expiration: { type: "EX", value: 600 },
    });
    try {
      const res = await startPairing(nextIp());
      expect(res.status).toBe(503);
      expect(errorCode(res)).toBe("pairing_unavailable");
    } finally {
      await redis.del(PAIRING_STARTS_KEY);
    }
    expect((await startPairing(nextIp())).status).toBe(200);
  });

  it("start: the 11th request from one IP within 10 minutes is 429; another IP is unaffected", async () => {
    const ip = nextIp();
    for (let i = 0; i < 10; i++) expect((await startPairing(ip)).status).toBe(200);
    const over = await startPairing(ip);
    expect(over.status).toBe(429);
    expect((await startPairing(nextIp())).status).toBe(200);
  });

  it("token: the 61st poll from one IP within a minute is 429", async () => {
    const ip = nextIp();
    for (let i = 0; i < 60; i++) {
      const res = await poll(ip, `unknown-device-code-${i}-${"x".repeat(24)}`);
      expect(res.status).toBe(400);
    }
    const over = await poll(ip, `unknown-device-code-61-${"x".repeat(24)}`);
    expect(over.status).toBe(429);
    expect(errorCode(await poll(nextIp(), `unknown-device-code-62-${"x".repeat(24)}`))).toBe("expired_token");
  });

  it("lookup, approve and deny share one bucket of 10 per minute per member; another member is unaffected", async () => {
    const { client: guesser } = await freshAdmin();
    const { client: other } = await freshAdmin();
    const calls = [
      ...Array.from({ length: 4 }, () => ["lookup", { userCode: "ZZZZ-ZZZZ" }] as const),
      ...Array.from({ length: 3 }, () => ["approve", { userCode: "ZZZZ-ZZZZ", name: "x" }] as const),
      ...Array.from({ length: 3 }, () => ["deny", { userCode: "ZZZZ-ZZZZ" }] as const),
    ];
    for (const [path, body] of calls) {
      expect((await guesser.request("POST", `/api/v1/devices/pairings/${path}`, body)).status).toBe(404);
    }
    for (const [path, body] of [
      ["lookup", { userCode: "ZZZZ-ZZZZ" }],
      ["approve", { userCode: "ZZZZ-ZZZZ", name: "x" }],
      ["deny", { userCode: "ZZZZ-ZZZZ" }],
    ] as const) {
      expect((await guesser.request("POST", `/api/v1/devices/pairings/${path}`, body)).status).toBe(429);
    }
    const fine = await other.request("POST", "/api/v1/devices/pairings/lookup", { userCode: "ZZZZ-ZZZZ" });
    expect(fine.status).toBe(404);
  });

  it("without device.pair (standard role, or the Work Zone module off) lookup, approve and deny are 403; anonymous is 401", async () => {
    const { userCode, deviceCode } = await started();
    const { client: standard } = await invite(stack, victor, "stan-pair@example.test", "Stan", "standard");
    const { client: dev, userId: devId } = await invite(
      stack,
      victor,
      "dana-pair@example.test",
      "Dana",
      "developer",
    );
    // Positive control: a developer may look it up.
    expect((await dev.request("POST", "/api/v1/devices/pairings/lookup", { userCode })).status).toBe(200);
    const rules = await workZoneOff(devId);
    try {
      for (const member of [standard, dev]) {
        for (const [path, body] of [
          ["lookup", { userCode }],
          ["approve", { userCode, name: "Mine" }],
          ["deny", { userCode }],
        ] as const) {
          const res = await member.request("POST", `/api/v1/devices/pairings/${path}`, body);
          expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(403);
        }
      }
    } finally {
      for (const id of rules) await victor.request("DELETE", `/api/v1/permission-rules/${id}`);
    }
    for (const path of ["lookup", "deny"]) {
      const res = await anon().request("POST", `/api/v1/devices/pairings/${path}`, { userCode });
      expect(res.status).toBe(401);
    }
    // Nothing was decided: the request is still pending and no enrollment row exists.
    expect(await enrollmentRows(deviceCode)).toBe(0);
    expect(errorCode(await poll(nextIp(), deviceCode))).toBe("authorization_pending");
  });

  it("an admin of organization B approves: the device exists in organization B only, audited there", async () => {
    const { client: eve, userId: eveId } = await invite(
      stack,
      victor,
      "eve-pair@example.test",
      "Eve",
      "developer",
    );
    const orgB = await moveToOrgB(eveId, "Eve");
    const { ip, deviceCode, userCode } = await started();
    const approve = await eve.request("POST", "/api/v1/devices/pairings/approve", {
      userCode,
      name: "B server",
    });
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);
    const token = await poll(ip, deviceCode);
    expect(token.status, JSON.stringify(token.body)).toBe(200);
    expect(token.body).toMatchObject({
      organizationId: orgB,
      organizationName: "Other Co",
      ownerName: "Eve",
    });
    const deviceId = token.body!.deviceId as string;

    const { rows } = await su.query("select organization_id, owner_user_id from app.devices where id = $1", [
      deviceId,
    ]);
    expect(rows).toEqual([{ organization_id: orgB, owner_user_id: eveId }]);
    const listA = await victor.request("GET", "/api/v1/devices");
    expect(listA.status).toBe(200);
    expect(JSON.stringify(listA.body)).not.toContain(deviceId);
    expect((await victor.request("PATCH", `/api/v1/devices/${deviceId}`, { name: "mine now" })).status).toBe(
      404,
    );
    expect((await victor.request("DELETE", `/api/v1/devices/${deviceId}`)).status).toBe(404);
    const listB = await eve.request("GET", "/api/v1/devices");
    expect(JSON.stringify(listB.body)).toContain(deviceId);

    const approved = (await auditRows("device.pairing_approved")).filter((r) => r.actor_id === eveId);
    expect(approved).toHaveLength(1);
    expect(approved[0]!.organization_id).toBe(orgB);
    const enrolled = (await auditRows("device.enrolled")).filter((r) => r.device_id === deviceId);
    expect(enrolled).toHaveLength(1);
    expect(enrolled[0]!.organization_id).toBe(orgB);
  });

  it("logs: no captured API line carries a user code (any form) or a device code", async () => {
    // One more full pairing with the log capture on, then every code this file was ever given.
    const { ip, deviceCode, userCode } = await started();
    const { client: approver } = await freshAdmin();
    expect((await approver.request("POST", "/api/v1/devices/pairings/lookup", { userCode })).status).toBe(
      200,
    );
    expect(
      (await approver.request("POST", "/api/v1/devices/pairings/approve", { userCode, name: "Logged" }))
        .status,
    ).toBe(200);
    expect((await poll(ip, deviceCode)).status).toBe(200);

    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.some((l) => l.includes("/api/v1/devices/pairings"))).toBe(true);
    const all = logLines.join("\n");
    const lower = all.toLowerCase();
    expect(issued.length).toBeGreaterThan(10);
    for (const code of issued) {
      const canonical = code.userCode.replace("-", "");
      expect(all).not.toContain(code.deviceCode);
      expect(all).not.toContain(code.userCode);
      expect(lower).not.toContain(canonical.toLowerCase());
    }
  });
});
