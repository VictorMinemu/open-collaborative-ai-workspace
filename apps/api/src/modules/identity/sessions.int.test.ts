import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, type TestStack, WEB_ORIGIN } from "../../testing";
import type { RevocationEvent } from "../realtime";

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
const MEMBER = { name: "Alex Kim", email: "alex@example.test", password: "another-long-password" };

/** Cookie-jar fetch with extra headers (user agent). testing.ts belongs to 02-08 in this wave. */
class Client {
  cookies = new Map<string, string>();
  constructor(
    private readonly baseUrl: string,
    private readonly extra: Record<string, string> = {},
  ) {}

  async request(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { origin: WEB_ORIGIN, ...this.extra };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
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
    return { status: res.status, headers: res.headers, text, body: json };
  }
}

let stack: TestStack;
let su: pg.Client;
let orgId: string;
let adminId: string;
let memberId: string;
let web: Client;

const signIn = async (ua: string, creds: { email: string; password: string } = ADMIN) => {
  const c = new Client(stack.baseUrl, { "user-agent": ua });
  const res = await c.request("POST", "/api/auth/sign-in/email", {
    email: creds.email,
    password: creds.password,
  });
  expect(res.status).toBe(200);
  const me = await c.request("GET", "/api/v1/me");
  expect(me.status).toBe(200);
  return { client: c, sessionId: me.body.sessionId as string };
};

/** Collects revocation events published on the fan-out channel while `fn` runs. */
const revocationsDuring = async (fn: () => Promise<void>, until: (e: RevocationEvent[]) => boolean) => {
  const events: RevocationEvent[] = [];
  const stop = await stack.built.core.realtime.onRevocation((e) => events.push(e));
  try {
    await fn();
    const end = Date.now() + 3000;
    while (!until(events) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  } finally {
    await stop();
  }
  return events;
};

const auditRows = async (action: string) =>
  (
    await su.query(
      "select organization_id, actor_kind, user_id, session_id, client_kind, resource_id, result, metadata from app.audit_events where action = $1 order by occurred_at",
      [action],
    )
  ).rows as Array<{
    organization_id: string;
    actor_kind: string;
    user_id: string | null;
    session_id: string | null;
    client_kind: string | null;
    resource_id: string | null;
    result: string;
    metadata: Record<string, unknown>;
  }>;

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();

  web = new Client(stack.baseUrl, { "user-agent": CHROME_MAC_UA });
  const setup = await web.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN });
  expect(setup.status).toBe(200);
  orgId = setup.body.organization.id;
  adminId = setup.body.user.id;

  const inv = await web.request("POST", "/api/v1/invitations", { email: MEMBER.email, role: "developer" });
  expect(inv.status).toBe(200);
  const accepted = await new Client(stack.baseUrl, { "user-agent": CHROME_MAC_UA }).request(
    "POST",
    `/api/v1/invitations/${inv.body.id}/accept`,
    { name: MEMBER.name, password: MEMBER.password },
  );
  expect(accepted.status).toBe(200);
  memberId = accepted.body.user.id;
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("my sessions (AUTH-05)", () => {
  it("lists web and desktop sessions with client identity, one current, and never a token", async () => {
    const desktop = await signIn(ELECTRON_MAC_UA);
    const res = await web.request("GET", "/api/v1/me/sessions");
    expect(res.status).toBe(200);
    const sessions = res.body.sessions as Array<Record<string, unknown>>;
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.clientKind).sort()).toEqual(["desktop", "web"]);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    const current = sessions.find((s) => s.current);
    expect(current?.clientKind).toBe("web");
    expect(current?.clientLabel).toBe("Chrome on macOS");
    const d = sessions.find((s) => s.id === desktop.sessionId);
    expect(d?.clientLabel).toBe("Desktop app on macOS");
    expect(d?.current).toBe(false);
    for (const s of sessions) {
      expect(Object.keys(s).sort()).toEqual(
        ["clientKind", "clientLabel", "createdAt", "current", "id", "ipAddress", "lastActiveAt"].sort(),
      );
      expect(typeof s.lastActiveAt).toBe("string");
    }
    expect(res.text.toLowerCase()).not.toContain("token");

    // Revoke the desktop session: it stops working everywhere at once.
    const revokedEvents = await revocationsDuring(
      async () => {
        const del = await web.request("DELETE", `/api/v1/me/sessions/${desktop.sessionId}`);
        expect(del.status).toBe(200);
      },
      (e) => e.length > 0,
    );
    // Session ids only: a userId would make the gateway close the caller's own sockets as well.
    expect(revokedEvents).toEqual([{ sessionIds: [desktop.sessionId], reason: "session_revoked" }]);
    expect((await desktop.client.request("GET", "/api/v1/me")).status).toBe(401);
    expect(await stack.built.core.realtime.isSessionRevoked(desktop.sessionId)).toBe(true);
    const audit = (await auditRows("session.revoked")).filter(
      (r) => r.metadata.revokedSessionId === desktop.sessionId,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ organization_id: orgId, user_id: adminId, result: "success" });
    expect(audit[0]?.metadata.scope).toBe("one");

    // A second delete of the same id finds nothing.
    expect((await web.request("DELETE", `/api/v1/me/sessions/${desktop.sessionId}`)).status).toBe(404);
  });

  it("cannot revoke another user's session (404) or the current one (400)", async () => {
    const other = await signIn(CHROME_MAC_UA, MEMBER);
    const foreign = await web.request("DELETE", `/api/v1/me/sessions/${other.sessionId}`);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("session_not_found");
    expect((await other.client.request("GET", "/api/v1/me")).status).toBe(200);

    const me = await web.request("GET", "/api/v1/me");
    const own = await web.request("DELETE", `/api/v1/me/sessions/${me.body.sessionId}`);
    expect(own.status).toBe(400);
    expect(own.body.error.code).toBe("current_session");
    expect((await web.request("GET", "/api/v1/me")).status).toBe(200);

    // A malformed id is a validation error, not a server error.
    expect((await web.request("DELETE", "/api/v1/me/sessions/not-a-uuid")).status).toBe(400);
  });

  it("revoke-others leaves only the current session and audits the revoked ids", async () => {
    const a = await signIn(ELECTRON_MAC_UA);
    const b = await signIn(CHROME_MAC_UA);
    const res = await web.request("POST", "/api/v1/me/sessions/revoke-others", {});
    expect(res.status).toBe(200);
    const list = await web.request("GET", "/api/v1/me/sessions");
    expect(list.body.sessions).toHaveLength(1);
    expect(list.body.sessions[0].current).toBe(true);
    expect((await a.client.request("GET", "/api/v1/me")).status).toBe(401);
    expect((await b.client.request("GET", "/api/v1/me")).status).toBe(401);
    expect(await stack.built.core.realtime.isSessionRevoked(a.sessionId)).toBe(true);
    expect(await stack.built.core.realtime.isSessionRevoked(b.sessionId)).toBe(true);
    const audit = (await auditRows("session.revoked")).find((r) => r.metadata.scope === "others");
    expect(audit?.metadata.revokedSessionIds).toEqual(expect.arrayContaining([a.sessionId, b.sessionId]));
    // The member's session was untouched.
    const memberSessions = await su.query("select count(*)::int as n from auth.session where user_id = $1", [
      memberId,
    ]);
    expect(memberSessions.rows[0].n).toBeGreaterThan(0);
  });

  it("requires a signed-in user", async () => {
    const anon = new Client(stack.baseUrl);
    expect((await anon.request("GET", "/api/v1/me/sessions")).status).toBe(401);
    expect((await anon.request("POST", "/api/v1/me/sessions/revoke-others", {})).status).toBe(401);
  });
});

describe("sign-in and sign-out audit (ORG-05)", () => {
  it("a wrong password answers 401 and audits user.sign_in_failed in the user's organization", async () => {
    const c = new Client(stack.baseUrl, { "user-agent": CHROME_MAC_UA });
    const res = await c.request("POST", "/api/auth/sign-in/email", {
      email: "Victor@Example.test",
      password: "definitely-the-wrong-one",
    });
    expect(res.status).toBe(401);
    const rows = await auditRows("user.sign_in_failed");
    const row = rows.find((r) => r.metadata.email === "victor@example.test");
    expect(row).toMatchObject({
      organization_id: orgId,
      actor_kind: "system",
      user_id: adminId,
      resource_id: adminId,
      result: "denied",
    });
    expect(row?.metadata.ip).toEqual(expect.any(String));
    expect(row?.metadata.reason).toEqual(expect.any(String));
    // The attempted password is never stored.
    expect(JSON.stringify(rows)).not.toContain("definitely-the-wrong-one");
  });

  it("an unknown e-mail is audited against the instance organization", async () => {
    const c = new Client(stack.baseUrl);
    const res = await c.request("POST", "/api/auth/sign-in/email", {
      email: "nobody@example.test",
      password: "whatever-password",
    });
    expect(res.status).toBe(401);
    const row = (await auditRows("user.sign_in_failed")).find(
      (r) => r.metadata.email === "nobody@example.test",
    );
    expect(row).toMatchObject({ organization_id: orgId, user_id: null, result: "denied" });
  });

  it("sign-in records the real client; sign-out is audited and flags the session revoked", async () => {
    const { client, sessionId } = await signIn(ELECTRON_MAC_UA);
    const signedIn = (await auditRows("user.signed_in")).at(-1);
    expect(signedIn?.client_kind).toBe("desktop");

    const events = await revocationsDuring(
      async () => {
        const out = await client.request("POST", "/api/auth/sign-out", {});
        expect(out.status).toBe(200);
      },
      (e) => e.length > 0,
    );
    expect(events).toEqual([{ sessionIds: [sessionId], reason: "signed_out" }]);
    expect((await client.request("GET", "/api/v1/me")).status).toBe(401);
    const row = (await auditRows("user.signed_out")).at(-1);
    expect(row).toMatchObject({ organization_id: orgId, user_id: adminId, session_id: sessionId });
    expect(row?.client_kind).toBe("desktop");
    expect(await stack.built.core.realtime.isSessionRevoked(sessionId)).toBe(true);
  });

  it("an anonymous sign-out is a no-op without audit", async () => {
    const before = (await auditRows("user.signed_out")).length;
    const out = await new Client(stack.baseUrl).request("POST", "/api/auth/sign-out", {});
    expect(out.status).toBeLessThan(500);
    expect((await auditRows("user.signed_out")).length).toBe(before);
  });
});

describe("route declarations (ORG-03)", () => {
  it("every identity route declares config.authz and /me is decided by the resolver", async () => {
    const routes = stack.built.authz.routes;
    const expected: Record<string, string> = {
      "POST /api/auth/sign-in/email": "public",
      "POST /api/auth/sign-out": "public",
      "GET /api/auth/get-session": "public",
      "GET /api/auth/token": "public",
      "GET /api/auth/jwks": "public",
      "GET /api/v1/setup/status": "public",
      "POST /api/v1/setup": "public",
      "GET /api/v1/me": "user",
      "GET /api/v1/me/sessions": "user",
      "DELETE /api/v1/me/sessions/:id": "user",
      "POST /api/v1/me/sessions/revoke-others": "user",
    };
    for (const [route, mode] of Object.entries(expected)) expect(routes.get(route), route).toBe(mode);

    expect((await web.request("GET", "/api/v1/me")).status).toBe(200);
    expect((await web.request("GET", "/api/v1/me/sessions")).status).toBe(200);
    const undecided = stack.built.authz.undecided.map((u) => u.url);
    expect(undecided).not.toContain("/api/v1/me");
    expect(undecided).not.toContain("/api/v1/me/sessions");
  });
});
