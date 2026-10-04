import { randomUUID } from "node:crypto";
import type { OrgRole } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let orgId: string;
let lead: TestClient;
let leadId: string;
let developer: TestClient;
let standard: TestClient;

const ADMIN = {
  name: "Ines Admin",
  email: "ines@example.test",
  password: "correct-horse-battery",
  orgName: "Invitations Org",
};

const email = (tag: string) => `${tag}-${randomUUID().slice(0, 8)}@example.test`;

async function invite(by: TestClient, role: OrgRole, to = email(role)) {
  return by.request("POST", "/api/v1/invitations", { email: to, role });
}

/** Admin invites, a fresh anonymous client accepts. */
async function join(role: OrgRole): Promise<{ client: TestClient; userId: string }> {
  const inv = await invite(admin, role);
  expect(inv.status).toBe(200);
  const client = new TestClient(stack.baseUrl);
  const accepted = await client.request("POST", `/api/v1/invitations/${inv.body!.id}/accept`, {
    name: `A ${role}`,
    password: "a-long-enough-password",
  });
  expect(accepted.status).toBe(200);
  expect(accepted.body).toMatchObject({ organization: { role } });
  return { client, userId: (accepted.body!.user as { id: string }).id };
}

const auditRows = async (action: string) =>
  (
    await su.query(
      "select * from app.audit_events where action = $1 and organization_id = $2 order by occurred_at",
      [action, orgId],
    )
  ).rows;

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN });
  expect(setup.status).toBe(200);
  orgId = (setup.body!.organization as { id: string }).id;
  const l = await join("lead");
  lead = l.client;
  leadId = l.userId;
  developer = (await join("developer")).client;
  standard = (await join("standard")).client;
});
afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("invitations decided by the resolver (SC2, ORG-02)", () => {
  it("an admin invites with each of the four roles", async () => {
    for (const role of ["standard", "developer", "lead", "admin"] as const) {
      const res = await invite(admin, role);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ role, status: "pending" });
    }
  });

  it("a lead invites standard and developer users, audited", async () => {
    for (const role of ["standard", "developer"] as const) {
      const to = email(`lead-${role}`);
      const res = await invite(lead, role, to);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ role, inviterId: leadId });
      const audit = (await auditRows("invitation.created")).filter((r) => r.resource_id === res.body!.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ user_id: leadId });
      expect(audit[0].metadata).toMatchObject({ email: to, role });
    }
  });

  it("a lead inviting a lead or an admin gets 403 role_ceiling with an authz.denied row", async () => {
    for (const role of ["lead", "admin"] as const) {
      const before = (await auditRows("authz.denied")).length;
      const to = email(`ceiling-${role}`);
      const res = await invite(lead, role, to);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        error: {
          code: "role_ceiling",
          details: { permission: "invitation.create", layer: "resource", reason: "role_ceiling" },
        },
      });
      const denials = await auditRows("authz.denied");
      expect(denials).toHaveLength(before + 1);
      expect(denials.at(-1)).toMatchObject({ user_id: leadId, result: "denied" });
      const rows = await su.query("select count(*)::int as n from auth.invitation where email = $1", [to]);
      expect(rows.rows[0].n).toBe(0);
    }
  });

  it("developers and standard users cannot invite; standard users cannot list", async () => {
    const dev = await invite(developer, "standard");
    expect(dev.status).toBe(403);
    expect(dev.body).toMatchObject({ error: { details: { reason: "missing_permission" } } });
    expect((await invite(standard, "standard")).status).toBe(403);
    const list = await standard.request("GET", "/api/v1/invitations");
    expect(list.status).toBe(403);
    expect(list.body).toMatchObject({ error: { details: { permission: "invitation.read" } } });
  });

  it("a lead lists invitations; viewerCan offers revoke only on the ones they created", async () => {
    const mine = await invite(lead, "developer");
    const theirs = await invite(admin, "developer");
    const res = await lead.request("GET", "/api/v1/invitations");
    expect(res.status).toBe(200);
    const list = res.body!.invitations as Array<{ id: string; inviterId: string; viewerCan: string[] }>;
    expect(list.length).toBeGreaterThan(2);
    for (const inv of list) {
      expect(inv.viewerCan).toEqual(inv.inviterId === leadId ? ["invitation.revoke"] : []);
    }
    expect(list.find((i) => i.id === mine.body!.id)!.viewerCan).toEqual(["invitation.revoke"]);
    expect(list.find((i) => i.id === theirs.body!.id)!.viewerCan).toEqual([]);
    // Admins may revoke every invitation.
    const adminList = (await admin.request("GET", "/api/v1/invitations")).body!.invitations as Array<{
      viewerCan: string[];
    }>;
    expect(adminList.every((i) => i.viewerCan.includes("invitation.revoke"))).toBe(true);
  });

  it("a lead revokes their own invitation but not an admin's; an admin revokes a lead's", async () => {
    const own = await invite(lead, "standard");
    expect((await lead.request("DELETE", `/api/v1/invitations/${own.body!.id}`)).status).toBe(200);
    expect((await auditRows("invitation.revoked")).some((r) => r.resource_id === own.body!.id)).toBe(true);

    const adminInv = await invite(admin, "lead");
    const denied = await lead.request("DELETE", `/api/v1/invitations/${adminInv.body!.id}`);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { details: { permission: "invitation.revoke" } } });
    const still = await su.query("select status from auth.invitation where id = $1", [adminInv.body!.id]);
    expect(still.rows[0].status).toBe("pending");

    const leadInv = await invite(lead, "developer");
    expect((await admin.request("DELETE", `/api/v1/invitations/${leadInv.body!.id}`)).status).toBe(200);
    const canceled = await su.query("select status from auth.invitation where id = $1", [leadInv.body!.id]);
    expect(canceled.rows[0].status).toBe("canceled");

    expect((await admin.request("DELETE", `/api/v1/invitations/${randomUUID()}`)).status).toBe(404);
  });

  it("a lead cannot take over an admin's pending invitation by re-inviting the same e-mail", async () => {
    const to = email("takeover");
    const adminInv = await invite(admin, "admin", to);
    const res = await invite(lead, "developer", to);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { details: { permission: "invitation.revoke" } } });
    const row = await su.query("select role, inviter_id from auth.invitation where id = $1", [
      adminInv.body!.id,
    ]);
    expect(row.rows[0].role).toBe("admin");
    // The lead may refresh their own pending invitation.
    const leadTo = email("refresh");
    const first = await invite(lead, "standard", leadTo);
    const again = await invite(lead, "developer", leadTo);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: first.body!.id, role: "developer", inviterId: leadId });
  });

  it("public lookup and accept work without a session; the new member's role is the invitation's", async () => {
    const inv = await invite(lead, "developer");
    const anon = new TestClient(stack.baseUrl);
    const pub = await anon.request("GET", `/api/v1/invitations/${inv.body!.id}`);
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ role: "developer", status: "pending", inviterName: "A lead" });
    const accepted = await anon.request("POST", `/api/v1/invitations/${inv.body!.id}/accept`, {
      name: "New Dev",
      password: "a-long-enough-password",
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ organization: { role: "developer" } });
    const userId = (accepted.body!.user as { id: string }).id;
    const member = await su.query("select role from app.org_members where user_id = $1", [userId]);
    expect(member.rows[0].role).toBe("developer");
  });

  it("every invitation route declares its authz mode and none answered undecided", () => {
    const declared = [...stack.built.authz.routes].filter(([key]) => key.includes(" /api/v1/invitations"));
    expect(Object.fromEntries(declared)).toEqual({
      "GET /api/v1/invitations": "user",
      "POST /api/v1/invitations": "user",
      "DELETE /api/v1/invitations/:id": "user",
      "GET /api/v1/invitations/:id": "public",
      "POST /api/v1/invitations/:id/accept": "public",
    });
    const undecided = stack.built.authz.undecided.filter((u) => u.url.startsWith("/api/v1/invitations"));
    expect(undecided).toEqual([]);
  });
});
