import { randomUUID } from "node:crypto";
import { decodeJwt, decodeProtectedHeader } from "jose";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { createTokenService, DEVICE_TOKEN_TTL_SECONDS, type TokenAuth } from "./jwt";

const ADMIN = {
  name: "Víctor Ruiz",
  email: "victor@example.test",
  password: "correct-horse-battery",
  orgName: "Autofy Labs",
};
const MEMBER = { name: "Alex Kim", password: "another-long-password" };

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let member: TestClient;
let orgId: string;
let adminId: string;
let memberId: string;

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` }, noCookies: true });
const nowSeconds = () => Math.floor(Date.now() / 1000);

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN });
  expect(setup.status).toBe(200);
  const body = setup.body as { organization: { id: string }; user: { id: string } };
  orgId = body.organization.id;
  adminId = body.user.id;

  const inv = await admin.request("POST", "/api/v1/invitations", {
    email: "alex@example.test",
    role: "developer",
  });
  member = new TestClient(stack.baseUrl);
  const accepted = await member.request("POST", `/api/v1/invitations/${inv.body!.id}/accept`, MEMBER);
  expect(accepted.status).toBe(200);
  memberId = (accepted.body as { user: { id: string } }).user.id;
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

/** A user-shaped token signed by our own key with chosen claims (to isolate one failing check). */
const craft = async (claims: Record<string, unknown>) => {
  const { token } = await stack.built.core.identity.auth.api.signJWT({ body: { payload: claims } });
  return token;
};

describe("Bearer access JWTs on REST (AUTH-06, D-01)", () => {
  it("every user route accepts Authorization: Bearer <jwt> without a cookie; audit rows carry the JWT's sid", async () => {
    const token = await admin.token();
    const { sid } = decodeJwt(token) as { sid: string };

    const me = await admin.request("GET", "/api/v1/me", undefined, bearer(token));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ user: { id: adminId }, organization: { id: orgId }, sessionId: sid });
    for (const path of ["/api/v1/channels", "/api/v1/members", "/api/v1/work-sessions"]) {
      expect((await admin.request("GET", path, undefined, bearer(token))).status, path).toBe(200);
    }
    // Without any credential the same routes answer 401 (the Bearer is what authenticated them).
    expect((await admin.request("GET", "/api/v1/me", undefined, { noCookies: true })).status).toBe(401);

    const created = await admin.request("POST", "/api/v1/channels", { name: "bearer-made" }, bearer(token));
    expect(created.status).toBe(200);
    const row = await su.query(
      "select session_id, user_id from app.audit_events where action = 'channel.created' and resource_id = $1",
      [created.body!.id],
    );
    expect(row.rows).toEqual([{ session_id: sid, user_id: adminId }]);

    // The web keeps the cookie for REST.
    expect((await admin.request("GET", "/api/v1/me")).status).toBe(200);
  });

  it("tampered, expired and other-audience tokens are rejected; a crafted valid token is accepted", async () => {
    const token = await admin.token();
    const claims = decodeJwt(token) as Record<string, unknown>;
    const { iss, sub, sid, org, ck } = claims;
    const base = { sub, sid, org, ck, iss };

    // Control: the crafting path itself yields an acceptable token.
    const valid = await craft({ ...base, aud: iss, iat: nowSeconds(), exp: nowSeconds() + 300 });
    expect((await admin.request("GET", "/api/v1/me", undefined, bearer(valid))).status).toBe(200);

    const tampered = `${token.slice(0, -2)}${token.at(-2) === "A" ? "B" : "A"}${token.slice(-1)}`;
    const expired = await craft({ ...base, aud: iss, iat: nowSeconds() - 1200, exp: nowSeconds() - 600 });
    const otherAudience = await craft({
      ...base,
      aud: "https://elsewhere.example",
      iat: nowSeconds(),
      exp: nowSeconds() + 300,
    });
    for (const [name, bad] of Object.entries({ tampered, expired, otherAudience })) {
      expect((await admin.request("GET", "/api/v1/me", undefined, bearer(bad))).status, name).toBe(401);
      expect(await stack.built.core.identity.verifyAccessToken(bad), name).toBeNull();
    }
    // A failed Bearer JWT never falls back to the cookie that came with it.
    expect(
      (
        await admin.request("GET", "/api/v1/me", undefined, {
          headers: { authorization: `Bearer ${tampered}` },
        })
      ).status,
    ).toBe(401);
  });

  it("device tokens and user tokens cannot be used in place of each other", async () => {
    const { identity } = stack.built.core;
    const deviceId = randomUUID();
    const before = Date.now();
    const device = await identity.signDeviceAccessToken({ deviceId, organizationId: orgId });
    const claims = decodeJwt(device.token);
    expect(claims).toMatchObject({ sub: deviceId, org: orgId, typ: "device", aud: "ocw:device-link" });
    expect(claims.exp! - claims.iat!).toBe(DEVICE_TOKEN_TTL_SECONDS);
    expect(decodeProtectedHeader(device.token).alg).toBe("EdDSA");
    const ttl = new Date(device.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan((DEVICE_TOKEN_TTL_SECONDS - 5) * 1000);
    expect(ttl).toBeLessThanOrEqual((DEVICE_TOKEN_TTL_SECONDS + 1) * 1000);

    expect(await identity.verifyDeviceAccessToken(device.token)).toEqual({ deviceId, organizationId: orgId });
    expect((await admin.request("GET", "/api/v1/me", undefined, bearer(device.token))).status).toBe(401);
    expect(await identity.verifyAccessToken(device.token)).toBeNull();

    const user = await admin.token();
    expect(await identity.verifyDeviceAccessToken(user)).toBeNull();
    // A device-audience token shaped like a user token is still not a user token (strict claims, typ).
    const { iss, sub, sid, org, ck } = decodeJwt(user) as Record<string, unknown>;
    const mixed = await craft({
      sub,
      sid,
      org,
      ck,
      iss,
      typ: "device",
      aud: iss,
      iat: nowSeconds(),
      exp: nowSeconds() + 300,
    });
    expect(await identity.verifyAccessToken(mixed)).toBeNull();
  });

  it("a revoked session's unexpired JWT is rejected immediately; so is a deactivated member's", async () => {
    const second = new TestClient(stack.baseUrl);
    expect(
      (
        await second.request("POST", "/api/auth/sign-in/email", {
          email: ADMIN.email,
          password: ADMIN.password,
        })
      ).status,
    ).toBe(200);
    const token = await second.token();
    const { sid } = decodeJwt(token) as { sid: string };
    expect((await second.request("GET", "/api/v1/me", undefined, bearer(token))).status).toBe(200);
    await stack.built.core.realtime.publishRevocation({ sessionIds: [sid], reason: "session_revoked" });
    expect((await second.request("GET", "/api/v1/me", undefined, bearer(token))).status).toBe(401);
    // Another session of the same user is unaffected.
    expect((await admin.request("GET", "/api/v1/me", undefined, bearer(await admin.token()))).status).toBe(
      200,
    );

    const memberToken = await member.token();
    expect((await member.request("GET", "/api/v1/me", undefined, bearer(memberToken))).status).toBe(200);
    await su.query("update app.org_members set deactivated_at = now() where user_id = $1", [memberId]);
    try {
      expect((await member.request("GET", "/api/v1/me", undefined, bearer(memberToken))).status).toBe(401);
    } finally {
      await su.query("update app.org_members set deactivated_at = null where user_id = $1", [memberId]);
    }
  });

  it("an unknown kid triggers one JWKS refetch per cooldown window", async () => {
    const getJwks = vi.fn(() => stack.built.core.identity.auth.api.getJwks());
    let clock = 1_000_000;
    const auth: TokenAuth = {
      api: { getJwks, signJWT: async () => ({ token: "unused" }) },
    };
    const tokens = createTokenService({
      auth,
      env: stack.env,
      now: () => clock,
    });
    const good = await admin.token();
    expect(await tokens.verifyUserToken(good)).not.toBeNull();
    expect(getJwks).toHaveBeenCalledTimes(1);

    // Same signature input but a kid we never issued: one refetch, then the cooldown holds.
    const [h, p, s] = good.split(".");
    const header = JSON.parse(Buffer.from(h!, "base64url").toString()) as Record<string, unknown>;
    const forged = (kid: string) =>
      `${Buffer.from(JSON.stringify({ ...header, kid })).toString("base64url")}.${p}.${s}`;
    expect(await tokens.verifyUserToken(forged("unknown-1"))).toBeNull();
    expect(getJwks).toHaveBeenCalledTimes(2);
    expect(await tokens.verifyUserToken(forged("unknown-2"))).toBeNull();
    expect(getJwks).toHaveBeenCalledTimes(2);
    clock += 30_000;
    expect(await tokens.verifyUserToken(forged("unknown-3"))).toBeNull();
    expect(getJwks).toHaveBeenCalledTimes(3);
  });

  it("JWKS rotation: after the keys are replaced the verifier refetches once and accepts the new kid", async () => {
    const before = await admin.token();
    expect((await admin.request("GET", "/api/v1/me", undefined, bearer(before))).status).toBe(200);
    const spy = vi.spyOn(stack.built.core.identity.auth.api, "getJwks");
    try {
      await su.query("delete from auth.jwks");
      const after = await admin.token(); // better-auth mints a fresh key lazily
      expect(decodeProtectedHeader(after).kid).not.toBe(decodeProtectedHeader(before).kid);
      expect((await admin.request("GET", "/api/v1/me", undefined, bearer(after))).status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      // The old key is gone from the JWKS: its tokens no longer verify.
      expect((await admin.request("GET", "/api/v1/me", undefined, bearer(before))).status).toBe(401);
    } finally {
      spy.mockRestore();
    }
  });
});
