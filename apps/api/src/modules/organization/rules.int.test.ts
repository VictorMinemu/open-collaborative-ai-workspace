import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthContext } from "../../core";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let dev: TestClient;
let std: TestClient;
let other: TestClient;
let orgId: string;
let adminId: string;
let devId: string;
let stdId: string;
let otherId: string;
let itId: string;
let backendId: string;

type Res = { status: number; body: Record<string, unknown> | null };

async function ok(res: Promise<Res>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  // biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
  return r.body as Record<string, any>;
}

async function fails(res: Promise<Res>, status: number) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  // biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
  return (r.body as Record<string, any>).error as { code: string; details?: Record<string, unknown> };
}

const audit = async (action: string) =>
  (await su.query("select * from app.audit_events where action = $1 order by occurred_at", [action])).rows;

async function invite(email: string, role: string, name: string) {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role }));
  const client = new TestClient(stack.baseUrl);
  const accepted = await ok(
    client.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
      name,
      password: "another-long-password",
    }),
  );
  return { client, id: accepted.user.id as string };
}

const myPermissions = async (c: TestClient) =>
  (await ok(c.request("GET", "/api/v1/me/permissions"))).permissions;

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(
    admin.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = setup.organization.id;
  adminId = setup.user.id;
  ({ client: dev, id: devId } = await invite("dev@example.test", "developer", "Dana Dev"));
  ({ client: std, id: stdId } = await invite("sam@example.test", "standard", "Sam Standard"));
  ({ client: other, id: otherId } = await invite("olga@example.test", "standard", "Olga Other"));

  itId = (
    await ok(admin.request("POST", "/api/v1/units", { kind: "department", name: "IT", parentId: null }))
  ).id;
  backendId = (
    await ok(admin.request("POST", "/api/v1/units", { kind: "team", name: "Backend", parentId: itId }))
  ).id;
  await ok(admin.request("POST", `/api/v1/units/${backendId}/members`, { userId: devId }));
  await ok(admin.request("POST", `/api/v1/units/${backendId}/members`, { userId: stdId }));
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("permission rules: explicit deny and allow at the unit grain", () => {
  let denyId: string;
  let keepChannel: string;

  it("only admins read the rules", async () => {
    expect((await ok(admin.request("GET", "/api/v1/permission-rules"))).rules).toEqual([]);
    expect((await fails(dev.request("GET", "/api/v1/permission-rules"), 403)).details).toMatchObject({
      permission: "rule.read",
    });
    await fails(
      dev.request("POST", "/api/v1/permission-rules", {
        subjectKind: "everyone",
        permission: "channel.create",
        effect: "deny",
      }),
      403,
    );
  });

  it("a deny on a department reaches a team member's org-level channel; admins outside the unit keep it", async () => {
    keepChannel = (await ok(dev.request("POST", "/api/v1/channels", { name: "dev-notes" }))).id;
    const adminTarget = (await ok(dev.request("POST", "/api/v1/channels", { name: "dev-scratch" }))).id;

    const rule = await ok(
      admin.request("POST", "/api/v1/permission-rules", {
        scopeUnitId: itId,
        subjectKind: "everyone",
        permission: "channel.archive",
        effect: "deny",
      }),
    );
    denyId = rule.id;
    expect(rule).toMatchObject({
      scopeUnitId: itId,
      subjectKind: "everyone",
      subjectId: null,
      permission: "channel.archive",
      tool: null,
      effect: "deny",
      createdBy: adminId,
    });

    const denied = await fails(dev.request("POST", `/api/v1/channels/${keepChannel}/archive`), 403);
    expect(denied.details).toMatchObject({
      permission: "channel.archive",
      layer: "unit",
      unitId: itId,
      ruleId: denyId,
    });
    const archived = await ok(admin.request("POST", `/api/v1/channels/${adminTarget}/archive`));
    expect(archived.archivedAt).not.toBeNull();
  });

  it("an allow extends a role inside its unit only", async () => {
    expect(await myPermissions(std)).not.toContain("work_session.create");
    const allow = await ok(
      admin.request("POST", "/api/v1/permission-rules", {
        scopeUnitId: backendId,
        subjectKind: "role",
        subjectId: "standard",
        permission: "work_session.create",
        effect: "allow",
      }),
    );
    expect(allow).toMatchObject({ subjectKind: "role", subjectId: "standard", effect: "allow" });
    expect(await myPermissions(std)).toContain("work_session.create");
    expect(await myPermissions(other)).not.toContain("work_session.create");
  });

  it("rejects admin-only allows, unknown scopes and unknown subjects", async () => {
    for (const permission of ["member.manage", "rule.*", "rule.manage"]) {
      const err = await fails(
        admin.request("POST", "/api/v1/permission-rules", {
          subjectKind: "everyone",
          permission,
          effect: "allow",
        }),
        400,
      );
      expect(err.code, permission).toBe("validation_error");
    }
    expect(
      (
        await fails(
          admin.request("POST", "/api/v1/permission-rules", {
            scopeUnitId: randomUUID(),
            subjectKind: "everyone",
            permission: "channel.create",
            effect: "deny",
          }),
          404,
        )
      ).code,
    ).toBe("unit_not_found");
    for (const subjectKind of ["user", "agent"]) {
      const err = await fails(
        admin.request("POST", "/api/v1/permission-rules", {
          subjectKind,
          subjectId: randomUUID(),
          permission: "channel.create",
          effect: "deny",
        }),
        400,
      );
      expect(err.code, subjectKind).toBe("unknown_subject");
    }
    const userRule = await ok(
      admin.request("POST", "/api/v1/permission-rules", {
        subjectKind: "user",
        subjectId: otherId,
        permission: "channel.create",
        effect: "deny",
      }),
    );
    expect(await myPermissions(other)).not.toContain("channel.create");
    expect(await myPermissions(std)).toContain("channel.create");
    await ok(admin.request("DELETE", `/api/v1/permission-rules/${userRule.id}`));
    expect(await myPermissions(other)).toContain("channel.create");
  });

  it("deleting the deny restores the permission; every change is audited and emitted", async () => {
    await ok(admin.request("DELETE", `/api/v1/permission-rules/${denyId}`));
    expect((await fails(admin.request("DELETE", `/api/v1/permission-rules/${denyId}`), 404)).code).toBe(
      "rule_not_found",
    );
    await fails(dev.request("DELETE", `/api/v1/permission-rules/${denyId}`), 403);
    await ok(dev.request("POST", `/api/v1/channels/${keepChannel}/archive`));

    const created = await audit("permission_rule.created");
    expect(created).toHaveLength(3);
    expect(created[0]).toMatchObject({ resource_id: denyId, user_id: adminId, result: "success" });
    expect(created[0].metadata.rule).toMatchObject({ id: denyId, effect: "deny", scopeUnitId: itId });
    const deleted = await audit("permission_rule.deleted");
    expect(deleted.map((r) => r.metadata.rule.id)).toContain(denyId);

    const events = (
      await su.query(
        "select payload from app.stream_events where stream_id = $1 and type = $2 order by seq",
        [`org:${orgId}`, "permission_rules.updated"],
      )
    ).rows.map((r) => r.payload as { ruleId: string; action: string });
    expect(events.filter((e) => e.action === "created")).toHaveLength(3);
    expect(events.filter((e) => e.action === "deleted")).toHaveLength(2);
    expect(events.at(-1)).toEqual({ ruleId: denyId, action: "deleted" });
  });
});

describe("realtime: org and user topics are resolver decisions", () => {
  const authOf = (userId: string, organizationId = orgId) => ({ userId, organizationId }) as AuthContext;

  it("members subscribe to their own org and their own user topic only", async () => {
    const rt = stack.built.core.realtime;
    expect(await rt.authorizeTopic(authOf(stdId), `org:${orgId}`)).toBe(true);
    expect(await rt.authorizeTopic(authOf(stdId), `org:${randomUUID()}`)).toBe(false);
    expect(await rt.authorizeTopic(authOf(stdId), `user:${stdId}`)).toBe(true);
    expect(await rt.authorizeTopic(authOf(stdId), `user:${adminId}`)).toBe(false);
    // A session of another organization cannot read this one by naming it.
    expect(await rt.authorizeTopic(authOf(stdId, randomUUID()), `org:${orgId}`)).toBe(false);
  });

  it("a deactivated member is denied both", async () => {
    await su.query("update app.org_members set deactivated_at = now() where user_id = $1", [otherId]);
    const rt = stack.built.core.realtime;
    expect(await rt.authorizeTopic(authOf(otherId), `org:${orgId}`)).toBe(false);
    expect(await rt.authorizeTopic(authOf(otherId), `user:${otherId}`)).toBe(false);
  });
});
