import { randomUUID } from "node:crypto";
import type { OrgRole } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let adminId: string;
let orgId: string;

const ADMIN = {
  name: "Ada Admin",
  email: "ada@example.test",
  password: "correct-horse-battery",
  orgName: "Members Org",
};

interface Joined {
  client: TestClient;
  userId: string;
  email: string;
  password: string;
}

let seq = 0;
/** Invites through the API as the admin and accepts as a fresh client. */
async function join(role: OrgRole, name = `${role} ${++seq}`): Promise<Joined> {
  const email = `${role}-${seq}-${randomUUID().slice(0, 8)}@example.test`;
  const password = "a-long-enough-password";
  const inv = await admin.request("POST", "/api/v1/invitations", { email, role });
  expect(inv.status).toBe(200);
  const client = new TestClient(stack.baseUrl);
  const accepted = await client.request("POST", `/api/v1/invitations/${inv.body!.id}/accept`, {
    name,
    password,
  });
  expect(accepted.status).toBe(200);
  return { client, userId: (accepted.body!.user as { id: string }).id, email, password };
}

const auditRows = async (action: string) =>
  (
    await su.query("select * from app.audit_events where action = $1 and organization_id = $2", [
      action,
      orgId,
    ])
  ).rows;

const permissionsOf = async (c: TestClient) =>
  (await c.request("GET", "/api/v1/me/permissions")).body as { role: string; permissions: string[] };

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN });
  expect(setup.status).toBe(200);
  adminId = (setup.body!.user as { id: string }).id;
  orgId = (setup.body!.organization as { id: string }).id;
});
afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("members: role assignment (ORG-02, D-06)", () => {
  it("an admin promotes a developer to lead; the change is effective on their next request and audited", async () => {
    const dev = await join("developer");
    expect((await permissionsOf(dev.client)).permissions).not.toContain("invitation.create");

    const res = await admin.request("PATCH", `/api/v1/members/${dev.userId}/role`, { role: "lead" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: dev.userId, role: "lead", status: "active", units: [] });

    const after = await permissionsOf(dev.client);
    expect(after.role).toBe("lead");
    expect(after.permissions).toContain("invitation.create");

    const audit = (await auditRows("member.role_changed")).filter((r) => r.resource_id === dev.userId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ user_id: adminId, result: "success" });
    expect(audit[0].metadata).toMatchObject({ userId: dev.userId, from: "developer", to: "lead" });

    const ev = await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'member.updated' order by seq desc limit 1",
      [`org:${orgId}`],
    );
    expect(ev.rows[0].payload).toEqual({ userId: dev.userId, changed: ["role"] });
  });

  it("every PRD role is assignable", async () => {
    const m = await join("standard");
    for (const role of ["developer", "lead", "admin", "standard"] as const) {
      const res = await admin.request("PATCH", `/api/v1/members/${m.userId}/role`, { role });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ role });
    }
    const legacy = await admin.request("PATCH", `/api/v1/members/${m.userId}/role`, { role: "member" });
    expect(legacy.status).toBe(400);
  });

  it("the only active admin cannot be demoted (409 last_admin); with two admins the demotion succeeds", async () => {
    const before = await auditRows("member.role_changed");
    const alone = await admin.request("PATCH", `/api/v1/members/${adminId}/role`, { role: "developer" });
    expect(alone.status).toBe(409);
    expect(alone.body).toMatchObject({ error: { code: "last_admin" } });
    const row = await su.query("select role from app.org_members where user_id = $1", [adminId]);
    expect(row.rows[0].role).toBe("admin");
    expect(await auditRows("member.role_changed")).toHaveLength(before.length);

    const second = await join("admin");
    const demoted = await second.client.request("PATCH", `/api/v1/members/${adminId}/role`, {
      role: "developer",
    });
    expect(demoted.status).toBe(200);
    // The remaining admin is now the last one: they cannot demote themselves either.
    const self = await second.client.request("PATCH", `/api/v1/members/${second.userId}/role`, {
      role: "lead",
    });
    expect(self.status).toBe(409);
    expect(self.body).toMatchObject({ error: { code: "last_admin" } });
    // Restore the original admin for the rest of the file.
    expect(
      (await second.client.request("PATCH", `/api/v1/members/${adminId}/role`, { role: "admin" })).status,
    ).toBe(200);
  });

  it("demoting a lead to developer downgrades their unit lead memberships, audited in the same transaction", async () => {
    const lead = await join("lead");
    const team = randomUUID();
    const other = randomUUID();
    await su.query(
      `insert into app.org_units (id, organization_id, kind, name, path) values
         ($1, $3, 'department', 'Engineering', ARRAY[$1]::uuid[]),
         ($2, $3, 'department', 'Design', ARRAY[$2]::uuid[])`,
      [team, other, orgId],
    );
    await su.query(
      `insert into app.unit_memberships (organization_id, unit_id, user_id, role) values
         ($1, $2, $4, 'lead'), ($1, $3, $4, 'member')`,
      [orgId, team, other, lead.userId],
    );

    const res = await admin.request("PATCH", `/api/v1/members/${lead.userId}/role`, { role: "developer" });
    expect(res.status).toBe(200);
    const units = (
      res.body!.units as Array<{ unitId: string; role: string; name: string; kind: string }>
    ).sort((a, b) => a.name.localeCompare(b.name));
    expect(units).toEqual([
      { unitId: other, name: "Design", kind: "department", role: "member" },
      { unitId: team, name: "Engineering", kind: "department", role: "member" },
    ]);
    const downgrades = (await auditRows("unit_membership.role_changed")).filter(
      (r) => r.metadata.userId === lead.userId,
    );
    expect(downgrades).toHaveLength(1);
    expect(downgrades[0].metadata).toEqual({
      userId: lead.userId,
      unitId: team,
      from: "lead",
      to: "member",
      reason: "org_role_changed",
    });
  });

  it("a developer gets 403 (member.manage) with an authz.denied row; unknown and other-org ids are 404", async () => {
    const dev = await join("developer");
    const victim = await join("standard");
    const before = (await auditRows("authz.denied")).length;
    const denied = await dev.client.request("PATCH", `/api/v1/members/${victim.userId}/role`, {
      role: "admin",
    });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { details: { permission: "member.manage" } } });
    const denials = await auditRows("authz.denied");
    expect(denials).toHaveLength(before + 1);
    expect(denials.some((d) => d.user_id === dev.userId && d.metadata.permission === "member.manage")).toBe(
      true,
    );
    const role = await su.query("select role from app.org_members where user_id = $1", [victim.userId]);
    expect(role.rows[0].role).toBe("standard");

    const unknown = await admin.request("PATCH", `/api/v1/members/${randomUUID()}/role`, { role: "lead" });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ error: { code: "member_not_found" } });

    // A member of another organization is invisible through RLS.
    const foreignOrg = randomUUID();
    const foreignUser = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
      foreignOrg,
      `other-${foreignOrg}`,
    ]);
    await su.query("insert into auth.user (id, name, email) values ($1, 'F', $2)", [
      foreignUser,
      `${foreignUser}@example.test`,
    ]);
    await su.query(
      "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'F', 'developer')",
      [foreignOrg, foreignUser],
    );
    const foreign = await admin.request("PATCH", `/api/v1/members/${foreignUser}/role`, { role: "admin" });
    expect(foreign.status).toBe(404);
    const untouched = await su.query("select role from app.org_members where user_id = $1", [foreignUser]);
    expect(untouched.rows[0].role).toBe("developer");
  });
});

describe("members: directory, profiles, deactivation (ORG-04, ORG-06)", () => {
  const signIn = (c: TestClient, m: Joined) =>
    c.request("POST", "/api/auth/sign-in/email", { email: m.email, password: m.password });

  it("every member reads the directory with roles, units and status, and any member's profile", async () => {
    const std = await join("standard", "Zed Standard");
    const unit = randomUUID();
    await su.query(
      "insert into app.org_units (id, organization_id, kind, name, path) values ($1, $2, 'team', 'Support', ARRAY[$1]::uuid[])",
      [unit, orgId],
    );
    await su.query(
      "insert into app.unit_memberships (organization_id, unit_id, user_id, role) values ($1, $2, $3, 'member')",
      [orgId, unit, std.userId],
    );
    const res = await std.client.request("GET", "/api/v1/members");
    expect(res.status).toBe(200);
    const members = res.body!.members as Array<Record<string, unknown>>;
    const names = members.map((m) => m.displayName as string);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    const me = members.find((m) => m.userId === std.userId);
    expect(me).toMatchObject({
      role: "standard",
      status: "active",
      statusEmoji: null,
      statusText: null,
      units: [{ unitId: unit, name: "Support", kind: "team", role: "member" }],
    });
    expect(members.find((m) => m.userId === adminId)).toMatchObject({ role: "admin", units: [] });

    const profile = await std.client.request("GET", `/api/v1/members/${adminId}`);
    expect(profile.status).toBe(200);
    expect(profile.body).toMatchObject({ userId: adminId, displayName: ADMIN.name, role: "admin" });
    expect((await std.client.request("GET", `/api/v1/members/${randomUUID()}`)).status).toBe(404);
    expect((await new TestClient(stack.baseUrl).request("GET", "/api/v1/members")).status).toBe(401);
  });

  it("deactivation ends sessions and sign-in, keeps the member in the directory; reactivation restores access", async () => {
    const dev = await join("developer", "Dee Deactivated");
    const second = new TestClient(stack.baseUrl);
    expect((await signIn(second, dev)).status).toBe(200);
    const sid = ((await dev.client.request("GET", "/api/v1/me")).body as { sessionId: string }).sessionId;
    expect(sid).toBeTruthy();
    const sessions = async () =>
      Number(
        (await su.query("select count(*)::int as n from auth.session where user_id = $1", [dev.userId]))
          .rows[0].n,
      );
    expect(await sessions()).toBe(2);

    const res = await admin.request("POST", `/api/v1/members/${dev.userId}/deactivate`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: dev.userId, status: "deactivated" });

    expect((await dev.client.request("GET", "/api/v1/me")).status).toBe(401);
    expect((await second.request("GET", "/api/v1/me")).status).toBe(401);
    expect(await sessions()).toBe(0);
    expect(await stack.built.core.realtime.isSessionRevoked(sid)).toBe(true);
    expect((await signIn(new TestClient(stack.baseUrl), dev)).status).toBe(401);

    const audit = (await auditRows("member.deactivated")).filter((r) => r.resource_id === dev.userId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ user_id: adminId });
    const ev = await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'member.updated' order by seq desc limit 1",
      [`org:${orgId}`],
    );
    expect(ev.rows[0].payload).toEqual({ userId: dev.userId, changed: ["status"] });

    const directory = (await admin.request("GET", "/api/v1/members")).body!.members as Array<
      Record<string, unknown>
    >;
    expect(directory.find((m) => m.userId === dev.userId)).toMatchObject({
      displayName: "Dee Deactivated",
      status: "deactivated",
    });

    const again = await admin.request("POST", `/api/v1/members/${dev.userId}/deactivate`);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { code: "already_deactivated" } });

    const back = await admin.request("POST", `/api/v1/members/${dev.userId}/reactivate`);
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ status: "active" });
    const fresh = new TestClient(stack.baseUrl);
    expect((await signIn(fresh, dev)).status).toBe(200);
    expect((await fresh.request("GET", "/api/v1/me")).status).toBe(200);
    expect((await auditRows("member.reactivated")).some((r) => r.resource_id === dev.userId)).toBe(true);
    const twice = await admin.request("POST", `/api/v1/members/${dev.userId}/reactivate`);
    expect(twice.status).toBe(409);
    expect(twice.body).toMatchObject({ error: { code: "not_deactivated" } });
  });

  it("refuses self-deactivation and non-admins", async () => {
    const self = await admin.request("POST", `/api/v1/members/${adminId}/deactivate`);
    expect(self.status).toBe(400);
    expect(self.body).toMatchObject({ error: { code: "cannot_deactivate_self" } });

    const lead = await join("lead");
    const before = (await auditRows("authz.denied")).length;
    expect((await lead.client.request("POST", `/api/v1/members/${adminId}/deactivate`)).status).toBe(403);
    expect((await lead.client.request("POST", `/api/v1/members/${lead.userId}/reactivate`)).status).toBe(403);
    expect((await auditRows("authz.denied")).length).toBe(before + 2);
    expect((await admin.request("POST", `/api/v1/members/${randomUUID()}/deactivate`)).status).toBe(404);
  });

  it("two admins deactivating each other at once leave exactly one active admin (409 last_admin under the lock)", async () => {
    // Leave exactly two active admins: the original and a fresh one.
    const directory = (await admin.request("GET", "/api/v1/members")).body!.members as Array<{
      userId: string;
      role: string;
      status: string;
    }>;
    for (const m of directory.filter((d) => d.role === "admin" && d.userId !== adminId)) {
      expect(
        (await admin.request("PATCH", `/api/v1/members/${m.userId}/role`, { role: "developer" })).status,
      ).toBe(200);
    }
    const other = await join("admin");

    // Hold the admin rows so both requests pass authorization and then queue on the last-admin lock.
    const holder = new pg.Client({ connectionString: stack.db.superuserUrl });
    await holder.connect();
    await holder.query("begin");
    await holder.query(
      "select user_id from app.org_members where organization_id = $1 and role = 'admin' and deactivated_at is null for update",
      [orgId],
    );
    const pending = Promise.all([
      admin.request("POST", `/api/v1/members/${other.userId}/deactivate`),
      other.client.request("POST", `/api/v1/members/${adminId}/deactivate`),
    ]);
    const waiting = async () =>
      Number(
        (
          await su.query(
            "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%org_members%for update%'",
          )
        ).rows[0].n,
      );
    for (let i = 0; i < 200 && (await waiting()) < 2; i++) await new Promise((r) => setTimeout(r, 25));
    expect(await waiting()).toBe(2);
    await holder.query("commit");
    await holder.end();

    const [a, b] = await pending;
    const loser = [a, b].find((r) => r.status !== 200);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(loser!.body).toMatchObject({ error: { code: "last_admin" } });
    const active = await su.query(
      "select user_id from app.org_members where organization_id = $1 and role = 'admin' and deactivated_at is null",
      [orgId],
    );
    expect(active.rows).toHaveLength(1);

    // Restore the original admin for later tests.
    const survivor = active.rows[0].user_id === adminId ? admin : other.client;
    const loserId = active.rows[0].user_id === adminId ? other.userId : adminId;
    expect((await survivor.request("POST", `/api/v1/members/${loserId}/reactivate`)).status).toBe(200);
    if (loserId === adminId) {
      admin = new TestClient(stack.baseUrl);
      expect((await signIn(admin, { ...ADMIN, client: admin, userId: adminId })).status).toBe(200);
    }
  });
});
