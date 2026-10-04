import { WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "./testing";

let stack: TestStack;
let su: pg.Client;

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
});
afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

const count = async (table: string) =>
  Number((await su.query(`select count(*)::int as n from ${table}`)).rows[0].n);

const ADMIN = {
  name: "Víctor Ruiz",
  email: "victor@example.test",
  password: "correct-horse-battery",
  orgName: "Autofy Labs",
};

describe("identity + platform core", () => {
  it("health reports db and redis", async () => {
    const res = await new TestClient(stack.baseUrl).request("GET", "/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", checks: { db: "ok", redis: "ok" } });
  });

  it("serves the OpenAPI document", async () => {
    const res = await fetch(`${stack.baseUrl}/docs/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toContain("/api/v1/setup");
  });

  it("SPIKE: setup writes (user, org, member, audit) roll back atomically on failure", async () => {
    await expect(
      stack.built.core.identity.setup(
        { token: TEST_SETUP_TOKEN, ...ADMIN },
        {
          beforeCommit: () => {
            throw new Error("injected failure after audit insert");
          },
        },
      ),
    ).rejects.toThrow("injected failure");
    expect(await count("auth.user")).toBe(0);
    expect(await count("auth.organization")).toBe(0);
    expect(await count("auth.member")).toBe(0);
    expect(await count("auth.session")).toBe(0);
    expect(await count("auth.instance_setup")).toBe(0);
    expect(await count("app.audit_events")).toBe(0);
    expect(await count("app.org_members")).toBe(0);
  });

  it("setup: bad token 401, success sets session, second redemption 409", async () => {
    const c = new TestClient(stack.baseUrl);
    expect((await c.request("GET", "/api/v1/setup/status")).body).toEqual({ setupComplete: false });
    expect(
      (await c.request("POST", "/api/v1/setup", { token: "wrong-token-wrong-token", ...ADMIN })).status,
    ).toBe(401);
    const ok = await c.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      user: { email: ADMIN.email },
      organization: { name: "Autofy Labs", role: "admin" },
    });
    const me = await c.request("GET", "/api/v1/me");
    expect(me.status).toBe(200);
    expect((await c.request("GET", "/api/v1/setup/status")).body).toEqual({ setupComplete: true });
    const again = await new TestClient(stack.baseUrl).request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      ...ADMIN,
    });
    expect(again.status).toBe(409);
    const actions = (await su.query("select action from app.audit_events order by occurred_at")).rows.map(
      (r) => r.action,
    );
    expect(actions).toEqual(expect.arrayContaining(["setup.redeemed", "organization.created"]));
  });

  it("only allowlisted better-auth endpoints are routed", async () => {
    const c = new TestClient(stack.baseUrl);
    const signup = await c.request("POST", "/api/auth/sign-up/email", {
      name: "x",
      email: "x@example.test",
      password: "xxxxxxxxxxxxxx",
    });
    expect(signup.status).toBe(404);
    expect((await c.request("POST", "/api/auth/organization/create", { name: "x", slug: "x" })).status).toBe(
      404,
    );
  });

  it("invite → public lookup → accept → developer; members list; non-admin cannot invite; revoke", async () => {
    const admin = new TestClient(stack.baseUrl);
    expect(
      (
        await admin.request("POST", "/api/auth/sign-in/email", {
          email: ADMIN.email,
          password: ADMIN.password,
        })
      ).status,
    ).toBe(200);
    const adminMe = await admin.request("GET", "/api/v1/me");
    expect(adminMe.status).toBe(200);
    expect(adminMe.body).toMatchObject({ organization: { role: "admin" } });

    // Legacy role names are rejected by the contract.
    const LEGACY_MVP0_ROLE = "member";
    const legacy = await admin.request("POST", "/api/v1/invitations", {
      email: "legacy@example.test",
      role: LEGACY_MVP0_ROLE,
    });
    expect(legacy.status).toBe(400);
    expect(legacy.body).toMatchObject({ error: { code: "validation_error" } });

    const inv = await admin.request("POST", "/api/v1/invitations", {
      email: "Alex@Example.test",
      role: "developer",
    });
    expect(inv.status).toBe(200);
    expect(inv.body).toMatchObject({ email: "alex@example.test", role: "developer", status: "pending" });
    const id = inv.body!.id as string;
    expect(inv.body!.link).toBe(`${WEB_ORIGIN}/invite/${id}`);

    const anon = new TestClient(stack.baseUrl);
    const pub = await anon.request("GET", `/api/v1/invitations/${id}`);
    expect(pub.body).toMatchObject({
      email: "alex@example.test",
      organizationName: "Autofy Labs",
      role: "developer",
      status: "pending",
    });

    const accepted = await anon.request("POST", `/api/v1/invitations/${id}/accept`, {
      name: "Alex",
      password: "another-long-password",
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      user: { email: "alex@example.test" },
      organization: { role: "developer" },
    });
    expect((await anon.request("GET", "/api/v1/me")).body).toMatchObject({
      organization: { role: "developer" },
    });
    // better-auth's member row is existence-only; the role lives in app.org_members.
    const authRoles = (await su.query("select distinct role from auth.member")).rows.map((r) => r.role);
    expect(authRoles).toEqual(["member"]);
    expect(
      (
        await anon.request("POST", `/api/v1/invitations/${id}/accept`, {
          name: "Alex",
          password: "another-long-password",
        })
      ).status,
    ).toBe(409);

    const members = await anon.request("GET", "/api/v1/members");
    const list = members.body!.members as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    for (const m of list) {
      expect(m).toMatchObject({ status: "active", statusEmoji: null, statusText: null });
    }
    expect(list.map((m) => m.role).sort()).toEqual(["admin", "developer"]);

    // A developer cannot invite.
    expect(
      (await anon.request("POST", "/api/v1/invitations", { email: "eve@example.test", role: "standard" }))
        .status,
    ).toBe(403);

    // Inviting an existing member's e-mail → 409 already_member.
    const dup = await admin.request("POST", "/api/v1/invitations", {
      email: "alex@example.test",
      role: "lead",
    });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ error: { code: "already_member" } });

    // Admins can invite with every role; re-inviting a pending e-mail refreshes that invitation.
    const lead = await admin.request("POST", "/api/v1/invitations", {
      email: "lee@example.test",
      role: "lead",
    });
    expect(lead.body).toMatchObject({ role: "lead" });
    const std = await admin.request("POST", "/api/v1/invitations", {
      email: "sam@example.test",
      role: "standard",
    });
    expect(std.status).toBe(200);
    expect(std.body).toMatchObject({ role: "standard" });
    const again = await admin.request("POST", "/api/v1/invitations", {
      email: "sam@example.test",
      role: "developer",
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: std.body!.id, role: "developer" });
    expect(new Date(again.body!.expiresAt as string).getTime()).toBeGreaterThanOrEqual(
      new Date(std.body!.expiresAt as string).getTime(),
    );
    const pending = (await admin.request("GET", "/api/v1/invitations")).body!.invitations as Array<{
      email: string;
    }>;
    expect(pending.map((p) => p.email).sort()).toEqual(["lee@example.test", "sam@example.test"]);

    // Revoke → canceled; accept then answers 409; revoking twice → 409 invitation_not_pending.
    expect((await admin.request("DELETE", `/api/v1/invitations/${std.body!.id}`)).status).toBe(200);
    const row = await su.query("select status from auth.invitation where id = $1", [std.body!.id]);
    expect(row.rows[0].status).toBe("canceled");
    expect(
      (
        await anon.request("POST", `/api/v1/invitations/${std.body!.id}/accept`, {
          name: "Sam",
          password: "sams-long-password",
        })
      ).status,
    ).toBe(409);
    const twice = await admin.request("DELETE", `/api/v1/invitations/${std.body!.id}`);
    expect(twice.status).toBe(409);
    expect(twice.body).toMatchObject({ error: { code: "invitation_not_pending" } });
    expect((await anon.request("DELETE", `/api/v1/invitations/${lead.body!.id}`)).status).toBe(403);

    const actions = (await su.query("select action from app.audit_events")).rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "invitation.created",
        "invitation.accepted",
        "user.signed_up",
        "invitation.revoked",
        "user.signed_in",
      ]),
    );
    const created = await su.query(
      "select metadata from app.audit_events where action = 'invitation.created' and resource_id = $1 order by occurred_at",
      [std.body!.id],
    );
    expect(created.rows.map((r) => r.metadata.role)).toEqual(["standard", "developer"]);
    expect((await admin.request("POST", "/api/auth/sign-out", {})).status).toBe(200);
    expect((await admin.request("GET", "/api/v1/me")).status).toBe(401);
  });

  it("WS: JWT subprotocol required (origin 403, none/cookie/tampered 401); subscribe + live + replay exactly once", async () => {
    const wsUrl = `${stack.baseUrl.replace("http", "ws")}/ws`;
    const c = new TestClient(stack.baseUrl);
    await c.request("POST", "/api/auth/sign-in/email", { email: ADMIN.email, password: ADMIN.password });
    const me = (await c.request("GET", "/api/v1/me")).body as {
      user: { id: string };
      organization: { id: string };
    };
    const token = await c.token();
    const offer = (t: string) => [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${t}`];

    const status = (headers: Record<string, string>, protocols?: string[]) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(wsUrl, protocols ?? [], { headers });
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("error", () => resolve(-1));
        ws.on("open", () => {
          ws.close();
          resolve(101);
        });
      });
    expect(await status({ origin: "https://evil.example" }, offer(token))).toBe(403);
    expect(await status({ origin: WEB_ORIGIN })).toBe(401);
    // The session cookie alone no longer opens the socket (D-01).
    expect(await status({ origin: WEB_ORIGIN, cookie: c.cookieHeader })).toBe(401);
    expect(await status({ origin: WEB_ORIGIN, cookie: c.cookieHeader }, [WS_PROTOCOL])).toBe(401);
    const tampered = `${token.slice(0, -2)}${token.at(-2) === "A" ? "B" : "A"}${token.slice(-1)}`;
    expect(await status({ origin: WEB_ORIGIN }, offer(tampered))).toBe(401);

    const topic = `user:${me.user.id}`;
    const { db, realtime } = stack.built.core;
    const emit = (n: number) =>
      db.withTenant({ organizationId: me.organization.id, userId: me.user.id }, (tx) =>
        realtime.appendEvent(tx, topic, "test.event", { n }),
      );
    await emit(1);
    await emit(2);

    const ws = new WebSocket(wsUrl, offer(token), { headers: { origin: WEB_ORIGIN } });
    const frames: Array<{ op: string; seq?: number; type?: string }> = [];
    ws.on("message", (m) => frames.push(JSON.parse(String(m))));
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    // The server selects the application protocol and never echoes the token entry (A1/A2).
    expect(ws.protocol).toBe(WS_PROTOCOL);
    ws.send(JSON.stringify({ op: "sub", topic, afterSeq: 1 }));
    ws.send(JSON.stringify({ op: "sub", topic: `user:${"0".repeat(8)}-0000-7000-8000-${"0".repeat(12)}` }));
    const waitFor = async (pred: () => boolean) => {
      for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
      expect(pred()).toBe(true);
    };
    await waitFor(() => frames.some((f) => f.op === "subscribed"));
    await emit(3);
    await emit(4);
    await waitFor(() => frames.filter((f) => f.op === "ev").length === 3);
    expect(frames.filter((f) => f.op === "ev").map((f) => f.seq)).toEqual([2, 3, 4]);
    expect(frames.some((f) => f.op === "err")).toBe(true); // other user's topic is forbidden
    await realtime.publishEphemeral(topic, "user.typing", { x: 1 });
    await waitFor(() => frames.some((f) => f.op === "eph"));
    ws.close();
  });
});
