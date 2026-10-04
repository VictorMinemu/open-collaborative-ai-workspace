import { runWithTransaction } from "@better-auth/core/context";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearMemoryOutbox, memoryOutbox } from "../../lib/mailer";
import { startTestStack, TEST_SETUP_TOKEN, type TestStack, WEB_ORIGIN } from "../../testing";

const ELECTRON_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ocw-desktop/0.1.0 Chrome/140.0.7339.80 Electron/38.1.0 Safari/537.36";

const ADMIN = {
  name: "Víctor Ruiz",
  email: "victor@example.test",
  password: "correct-horse-battery",
  orgName: "Autofy Labs",
};

/** Cookie-jar fetch with extra headers. testing.ts belongs to 02-08 in this wave. */
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

interface World {
  stack: TestStack;
  su: pg.Client;
  orgId: string;
  adminId: string;
  admin: Client;
}

async function startWorld(env: Record<string, string> = {}): Promise<World> {
  const stack = await startTestStack({ env });
  const su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  const admin = new Client(stack.baseUrl);
  const setup = await admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN });
  expect(setup.status).toBe(200);
  return { stack, su, orgId: setup.body.organization.id, adminId: setup.body.user.id, admin };
}

async function addMember(w: World, email: string, role: "developer" | "standard" = "developer") {
  const inv = await w.admin.request("POST", "/api/v1/invitations", { email, role });
  expect(inv.status).toBe(200);
  const c = new Client(w.stack.baseUrl);
  const password = `${email}-initial-password`;
  const accepted = await c.request("POST", `/api/v1/invitations/${inv.body.id}/accept`, {
    name: email.split("@")[0],
    password,
  });
  expect(accepted.status).toBe(200);
  return { id: accepted.body.user.id as string, email, password, client: c };
}

async function signIn(w: World, email: string, password: string, ua?: string) {
  const c = new Client(w.stack.baseUrl, ua ? { "user-agent": ua } : {});
  const res = await c.request("POST", "/api/auth/sign-in/email", { email, password });
  return { client: c, status: res.status };
}

const auditRows = async (w: World, action: string) =>
  (
    await w.su.query(
      "select organization_id, user_id, resource_id, metadata from app.audit_events where action = $1 order by occurred_at",
      [action],
    )
  ).rows as Array<{
    organization_id: string;
    user_id: string | null;
    resource_id: string | null;
    metadata: Record<string, unknown>;
  }>;

const sessionCount = async (w: World, userId: string) =>
  Number(
    (await w.su.query("select count(*)::int as n from auth.session where user_id = $1", [userId])).rows[0].n,
  );

const tokenOf = (link: string) => new URL(link).searchParams.get("token") ?? "";

describe("password reset without SMTP: admin-issued links (AUTH-04)", () => {
  let w: World;
  beforeAll(async () => {
    w = await startWorld();
  });
  afterAll(async () => {
    await w?.su.end();
    await w?.stack.stop();
  });
  beforeEach(() => clearMemoryOutbox());

  it("capabilities say there is no reset e-mail, and a request sends nothing but still answers ok", async () => {
    const caps = await new Client(w.stack.baseUrl).request("GET", "/api/v1/auth/capabilities");
    expect(caps.status).toBe(200);
    expect(caps.body).toEqual({ passwordResetEmail: false });
    const res = await new Client(w.stack.baseUrl).request("POST", "/api/v1/password-reset/request", {
      email: ADMIN.email,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(memoryOutbox()).toEqual([]);
  });

  it("an admin issues a single-use 24-hour link; completing it revokes every session of that user", async () => {
    const alex = await addMember(w, "alex@example.test");
    const desktop = await signIn(w, alex.email, alex.password, ELECTRON_MAC_UA);
    expect(desktop.status).toBe(200);
    const sids = (await w.su.query("select id from auth.session where user_id = $1", [alex.id])).rows.map(
      (r) => r.id as string,
    );
    expect(sids.length).toBe(2);

    const issued = await w.admin.request("POST", `/api/v1/members/${alex.id}/password-reset-link`, {});
    expect(issued.status).toBe(200);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    expect(issued.body.link.startsWith(`${WEB_ORIGIN}/reset-password?token=`)).toBe(true);
    const expiresIn = new Date(issued.body.expiresAt).getTime() - Date.now();
    expect(Math.abs(expiresIn - 24 * 60 * 60 * 1000)).toBeLessThan(60_000);
    const token = tokenOf(issued.body.link);
    expect(token.length).toBeGreaterThanOrEqual(32);

    const audit = (await auditRows(w, "password.reset_link_issued")).at(-1);
    expect(audit).toMatchObject({ organization_id: w.orgId, user_id: w.adminId, resource_id: alex.id });
    expect(audit?.metadata.targetUserId).toBe(alex.id);
    const allAudit = await w.su.query("select metadata::text as m from app.audit_events");
    expect(allAudit.rows.some((r) => String(r.m).includes(token))).toBe(false);

    const anon = new Client(w.stack.baseUrl);
    const done = await anon.request("POST", "/api/v1/password-reset", {
      token,
      newPassword: "a-brand-new-password",
    });
    expect(done.status).toBe(200);
    expect(await sessionCount(w, alex.id)).toBe(0);
    expect((await alex.client.request("GET", "/api/v1/me")).status).toBe(401);
    expect((await desktop.client.request("GET", "/api/v1/me")).status).toBe(401);
    for (const sid of sids) expect(await w.stack.built.core.realtime.isSessionRevoked(sid)).toBe(true);
    expect((await signIn(w, alex.email, alex.password)).status).toBe(401);
    expect((await signIn(w, alex.email, "a-brand-new-password")).status).toBe(200);
    const completed = (await auditRows(w, "password.reset_completed")).at(-1);
    expect(completed).toMatchObject({ organization_id: w.orgId, user_id: alex.id, resource_id: alex.id });

    const again = await anon.request("POST", "/api/v1/password-reset", {
      token,
      newPassword: "yet-another-password",
    });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("invalid_token");
    const garbage = await anon.request("POST", "/api/v1/password-reset", {
      token: "x".repeat(43),
      newPassword: "yet-another-password",
    });
    expect(garbage.status).toBe(400);
    expect(garbage.body.error.code).toBe("invalid_token");
  });

  it("a new link replaces the previous one", async () => {
    const bea = await addMember(w, "bea@example.test");
    const first = await w.admin.request("POST", `/api/v1/members/${bea.id}/password-reset-link`, {});
    const second = await w.admin.request("POST", `/api/v1/members/${bea.id}/password-reset-link`, {});
    const anon = new Client(w.stack.baseUrl);
    const stale = await anon.request("POST", "/api/v1/password-reset", {
      token: tokenOf(first.body.link),
      newPassword: "bea-new-password-1",
    });
    expect(stale.status).toBe(400);
    const fresh = await anon.request("POST", "/api/v1/password-reset", {
      token: tokenOf(second.body.link),
      newPassword: "bea-new-password-2",
    });
    expect(fresh.status).toBe(200);
  });

  it("a developer cannot issue links (403), an admin cannot target themselves (400), a deactivated member gets none (409)", async () => {
    const dev = await addMember(w, "dev@example.test");
    const denied = await dev.client.request("POST", `/api/v1/members/${w.adminId}/password-reset-link`, {});
    expect(denied.status).toBe(403);
    expect((await auditRows(w, "authz.denied")).length).toBeGreaterThan(0);

    const self = await w.admin.request("POST", `/api/v1/members/${w.adminId}/password-reset-link`, {});
    expect(self.status).toBe(400);
    expect(self.body.error.code).toBe("use_change_password");

    const gone = await addMember(w, "gone@example.test");
    await w.su.query("update app.org_members set deactivated_at = now() where user_id = $1", [gone.id]);
    const deactivated = await w.admin.request("POST", `/api/v1/members/${gone.id}/password-reset-link`, {});
    expect(deactivated.status).toBe(409);
    expect(deactivated.body.error.code).toBe("member_deactivated");

    const unknown = await w.admin.request(
      "POST",
      "/api/v1/members/00000000-0000-4000-8000-000000000000/password-reset-link",
      {},
    );
    expect(unknown.status).toBe(404);
  });

  it("SPIKE A9: auth.api.resetPassword joins an outer runWithTransaction and rolls back with it", async () => {
    const cy = await addMember(w, "cy@example.test");
    const issued = await w.admin.request("POST", `/api/v1/members/${cy.id}/password-reset-link`, {});
    const token = tokenOf(issued.body.link);
    const { identity } = w.stack.built.core;
    const ctx = await identity.auth.$context;
    await expect(
      runWithTransaction(ctx.adapter, async () => {
        await identity.auth.api.resetPassword({ body: { token, newPassword: "rolled-back-password" } });
        throw new Error("abort after reset");
      }),
    ).rejects.toThrow("abort after reset");
    // Everything the reset did is gone: the token row, the password change and the session deletion.
    const row = await w.su.query("select 1 from auth.verification where identifier = $1", [
      `reset-password:${token}`,
    ]);
    expect(row.rowCount).toBe(1);
    expect(await sessionCount(w, cy.id)).toBe(1);
    expect((await signIn(w, cy.email, cy.password)).status).toBe(200);
    expect((await signIn(w, cy.email, "rolled-back-password")).status).toBe(401);
  });

  it("a signed-in user changes their password with the current one; other sessions are signed out", async () => {
    const dana = await addMember(w, "dana@example.test");
    const other = await signIn(w, dana.email, dana.password, ELECTRON_MAC_UA);
    expect(other.status).toBe(200);
    const otherSid = (await other.client.request("GET", "/api/v1/me")).body.sessionId as string;

    const wrong = await dana.client.request("POST", "/api/v1/me/password", {
      currentPassword: "not-my-password",
      newPassword: "dana-second-password",
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("invalid_password");

    const ok = await dana.client.request("POST", "/api/v1/me/password", {
      currentPassword: dana.password,
      newPassword: "dana-second-password",
    });
    expect(ok.status).toBe(200);
    expect((await dana.client.request("GET", "/api/v1/me")).status).toBe(200);
    expect((await other.client.request("GET", "/api/v1/me")).status).toBe(401);
    expect(await w.stack.built.core.realtime.isSessionRevoked(otherSid)).toBe(true);
    const audit = (await auditRows(w, "password.changed")).at(-1);
    expect(audit).toMatchObject({ organization_id: w.orgId, user_id: dana.id, resource_id: dana.id });
    expect(audit?.metadata.revokedOtherSessions).toBe(1);
    expect((await signIn(w, dana.email, dana.password)).status).toBe(401);
    expect((await signIn(w, dana.email, "dana-second-password")).status).toBe(200);

    // Opting out keeps the other sessions.
    const kept = await dana.client.request("POST", "/api/v1/me/password", {
      currentPassword: "dana-second-password",
      newPassword: "dana-third-password",
      revokeOtherSessions: false,
    });
    expect(kept.status).toBe(200);
    expect(await sessionCount(w, dana.id)).toBe(2);

    expect(
      (
        await new Client(w.stack.baseUrl).request("POST", "/api/v1/me/password", {
          currentPassword: "x",
          newPassword: "dana-fourth-password",
        })
      ).status,
    ).toBe(401);
  });
});

describe("password reset by e-mail when SMTP is configured (AUTH-04)", () => {
  let w: World;
  beforeAll(async () => {
    w = await startWorld({ OCW_SMTP_URL: "memory:" });
  });
  afterAll(async () => {
    await w?.su.end();
    await w?.stack.stop();
  });
  beforeEach(() => clearMemoryOutbox());

  it("capabilities offer the reset e-mail", async () => {
    const caps = await new Client(w.stack.baseUrl).request("GET", "/api/v1/auth/capabilities");
    expect(caps.body).toEqual({ passwordResetEmail: true });
  });

  it("a member gets one e-mail with a web link; completing it works once; unknown e-mails look the same", async () => {
    const eve = await addMember(w, "eve@example.test");
    const anon = new Client(w.stack.baseUrl);
    const res = await anon.request("POST", "/api/v1/password-reset/request", { email: "Eve@Example.test" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const outbox = memoryOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.to).toBe("eve@example.test");
    const link = outbox[0]?.text.match(/https?:\/\/\S+/)?.[0] ?? "";
    expect(link.startsWith(`${WEB_ORIGIN}/reset-password?token=`)).toBe(true);
    expect(outbox[0]?.html).toContain("/reset-password?token=");
    const requested = (await auditRows(w, "password.reset_requested")).at(-1);
    expect(requested).toMatchObject({ organization_id: w.orgId, resource_id: eve.id });

    const unknown = await anon.request("POST", "/api/v1/password-reset/request", {
      email: "nobody@example.test",
    });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual(res.body);
    expect(memoryOutbox()).toHaveLength(1);

    const token = tokenOf(link);
    const done = await anon.request("POST", "/api/v1/password-reset", {
      token,
      newPassword: "eve-new-password",
    });
    expect(done.status).toBe(200);
    expect(await sessionCount(w, eve.id)).toBe(0);
    expect((await signIn(w, eve.email, "eve-new-password")).status).toBe(200);
    const again = await anon.request("POST", "/api/v1/password-reset", {
      token,
      newPassword: "eve-other-password",
    });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("invalid_token");
  });

  it("a deactivated member gets no e-mail", async () => {
    const fin = await addMember(w, "fin@example.test");
    await w.su.query("update app.org_members set deactivated_at = now() where user_id = $1", [fin.id]);
    const res = await new Client(w.stack.baseUrl).request("POST", "/api/v1/password-reset/request", {
      email: fin.email,
    });
    expect(res.status).toBe(200);
    expect(memoryOutbox()).toEqual([]);
  });
});
