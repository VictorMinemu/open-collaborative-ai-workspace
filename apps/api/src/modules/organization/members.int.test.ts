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
