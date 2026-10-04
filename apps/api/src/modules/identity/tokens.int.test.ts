import { AccessTokenClaims } from "@ocw/contracts";
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from "jose";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, type TestStack, WEB_ORIGIN } from "../../testing";

const ELECTRON_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ocw-desktop/0.1.0 Chrome/140.0.7339.80 Electron/38.1.0 Safari/537.36";
const CHROME_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const ADMIN = {
  name: "Víctor Ruiz",
  email: "victor@example.test",
  password: "correct-horse-battery",
  orgName: "Autofy Labs",
};
const MEMBER = { name: "Alex Kim", password: "another-long-password" };

/**
 * Local cookie-jar fetch that also sends extra headers (user agent, x-ocw-client). testing.ts belongs to
 * 02-08 in wave 3, so this helper stays here.
 */
class Client {
  cookies = new Map<string, string>();
  constructor(
    private readonly baseUrl: string,
    private readonly extra: Record<string, string> = {},
  ) {}

  get cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async request(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { origin: WEB_ORIGIN, ...this.extra };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.cookies.size) headers.cookie = this.cookieHeader;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair = ""] = c.split(";");
      const idx = pair.indexOf("=");
      const k = pair.slice(0, idx);
      const v = pair.slice(idx + 1);
      if (v === "" || /max-age=0/i.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const text = await res.text();
    // biome-ignore lint/suspicious/noExplicitAny: test helper returns loosely typed JSON bodies
    const json = text ? (JSON.parse(text) as any) : null;
    return { status: res.status, headers: res.headers, body: json };
  }
}

let stack: TestStack;
let su: pg.Client;
let orgId: string;
let adminId: string;
let memberId: string;
let memberEmail: string;

const sessionsOf = async (userId: string) =>
  (
    await su.query(
      "select id, client_kind, client_label, active_organization_id from auth.session where user_id = $1 order by created_at",
      [userId],
    )
  ).rows as Array<{
    id: string;
    client_kind: string | null;
    client_label: string | null;
    active_organization_id: string | null;
  }>;

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();

  const admin = new Client(stack.baseUrl, { "user-agent": CHROME_MAC_UA });
  const setup = await admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN });
  expect(setup.status).toBe(200);
  orgId = setup.body.organization.id;
  adminId = setup.body.user.id;

  const inv = await admin.request("POST", "/api/v1/invitations", {
    email: "alex@example.test",
    role: "developer",
  });
  expect(inv.status).toBe(200);
  memberEmail = inv.body.email;
  const accepted = await new Client(stack.baseUrl, { "user-agent": CHROME_MAC_UA }).request(
    "POST",
    `/api/v1/invitations/${inv.body.id}/accept`,
    MEMBER,
  );
  expect(accepted.status).toBe(200);
  memberId = accepted.body.user.id;
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("session client identity and access JWTs (AUTH-05, AUTH-06)", () => {
  it("a desktop sign-in yields a desktop session and a minimal 10-minute EdDSA JWT verifiable against the JWKS", async () => {
    const desktop = new Client(stack.baseUrl, { "user-agent": ELECTRON_MAC_UA });
    const signIn = await desktop.request("POST", "/api/auth/sign-in/email", {
      email: ADMIN.email,
      password: ADMIN.password,
    });
    expect(signIn.status).toBe(200);
    const me = await desktop.request("GET", "/api/v1/me");
    expect(me.status).toBe(200);
    const sessionId = me.body.sessionId as string;

    const row = (await sessionsOf(adminId)).find((s) => s.id === sessionId);
    expect(row?.client_kind).toBe("desktop");
    expect(row?.client_label).toMatch(/ on macOS$/);
    expect(row?.client_label).toBe("Desktop app on macOS");
    expect(row?.active_organization_id).toBe(orgId);

    const tokenRes = await desktop.request("GET", "/api/auth/token");
    expect(tokenRes.status).toBe(200);
    const token = tokenRes.body.token as string;
    expect(typeof token).toBe("string");

    const jwksRes = await new Client(stack.baseUrl).request("GET", "/api/auth/jwks");
    expect(jwksRes.status).toBe(200);
    const jwks = jwksRes.body as JSONWebKeySet;
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA" });
    expect(jwks.keys[0]).not.toHaveProperty("d"); // never the private part

    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: stack.env.OCW_PUBLIC_API_URL,
      audience: stack.env.OCW_PUBLIC_API_URL,
      algorithms: ["EdDSA"],
    });
    expect(protectedHeader.kid).toBe(jwks.keys[0]!.kid);
    expect(Object.keys(payload).sort()).toEqual(["aud", "ck", "exp", "iat", "iss", "org", "sid", "sub"]);
    expect(payload).toMatchObject({ sub: adminId, sid: sessionId, org: orgId, ck: "desktop" });
    expect(payload.exp! - payload.iat!).toBe(600);
    expect(() => AccessTokenClaims.parse(payload)).not.toThrow();

    // No JWT rides along on get-session (T-02-03-03).
    const gs = await desktop.request("GET", "/api/auth/get-session");
    expect(gs.status).toBe(200);
    expect(gs.headers.get("set-auth-jwt")).toBeNull();

    // Without a session there is no token.
    expect((await new Client(stack.baseUrl).request("GET", "/api/auth/token")).status).toBe(401);
  });

  it("x-ocw-client marks a mobile session; a browser session is web with a readable label", async () => {
    const mobile = new Client(stack.baseUrl, { "user-agent": CHROME_MAC_UA, "x-ocw-client": "mobile" });
    expect(
      (
        await mobile.request("POST", "/api/auth/sign-in/email", {
          email: ADMIN.email,
          password: ADMIN.password,
        })
      ).status,
    ).toBe(200);
    const mobileSid = (await mobile.request("GET", "/api/v1/me")).body.sessionId;
    const browser = new Client(stack.baseUrl, { "user-agent": CHROME_MAC_UA });
    expect(
      (
        await browser.request("POST", "/api/auth/sign-in/email", {
          email: ADMIN.email,
          password: ADMIN.password,
        })
      ).status,
    ).toBe(200);
    const browserSid = (await browser.request("GET", "/api/v1/me")).body.sessionId;
    const rows = await sessionsOf(adminId);
    expect(rows.find((r) => r.id === mobileSid)).toMatchObject({ client_kind: "mobile" });
    expect(rows.find((r) => r.id === browserSid)).toMatchObject({
      client_kind: "web",
      client_label: "Chrome on macOS",
    });
  });

  it("a deactivated member cannot sign in and no session is created", async () => {
    await su.query("update app.org_members set deactivated_at = now() where user_id = $1", [memberId]);
    try {
      const before = (await sessionsOf(memberId)).length;
      const res = await new Client(stack.baseUrl, { "user-agent": CHROME_MAC_UA }).request(
        "POST",
        "/api/auth/sign-in/email",
        { email: memberEmail, password: MEMBER.password },
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect((await sessionsOf(memberId)).length).toBe(before);
    } finally {
      await su.query("update app.org_members set deactivated_at = null where user_id = $1", [memberId]);
    }
  });
});
