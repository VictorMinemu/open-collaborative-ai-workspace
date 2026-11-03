import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { invite } from "../../testing-workzone";
import { messagingDecision } from "./agent-messaging";
import { createPermissionService } from "./index";

/**
 * Phase 07.7 (A2A-02, D-02, D-04, P-03 … P-05, ADR-0027): who may consult whom is resolver data. The organization switch
 * "Bots may consult each other" (`GET/PUT /api/v1/agent-messaging`) and the per-bot consult rules
 * (`GET/PUT /api/v1/agents/:id/messaging`) write ordinary `agent.message` rules through 07.3's audited helpers; the
 * canonical decision (`messagingDecision`, the call 07.7-04's consult route makes) reads them with the target's
 * visibility for the human the asking bot acts for. Real PostgreSQL + Redis; no model, no cell.
 *
 * Cast: Víctor (admin, setup), Sam (standard, no unit), Lee (org role lead, lead of Ops), Pat (standard, member of Ops).
 * Bots: Archie and Bea (organization team bots), Opsy (unit persona of Ops), Pebble (Víctor's personal bot).
 */

let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let sam: TestClient;
let lee: TestClient;
let orgId: string;
let victorId: string;
let samId: string;
let leeId: string;
let patId: string;
let opsId: string;
let archie: string;
let bea: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };

async function ok(res: Promise<Res>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function fails(res: Promise<Res>, status: number) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return (r.body as Json).error as { code: string; message: string; details?: Json };
}

async function insertBot(
  organizationId: string,
  name: string,
  extra: { scope?: "team" | "personal"; ownerUserId?: string; unitId?: string } = {},
): Promise<string> {
  return (
    await su.query(
      `insert into app.agents (organization_id, name, username, instructions, model_provider, model_id, status, scope,
                               owner_user_id, unit_id)
       values ($1, $2, $3, 'Help', 'mock', 'mock-1', 'ready', $4, $5, $6) returning id`,
      [
        organizationId,
        name,
        `${name.toLowerCase()}-${randomUUID().slice(0, 6)}`,
        extra.scope ?? "team",
        extra.ownerUserId ?? null,
        extra.unitId ?? null,
      ],
    )
  ).rows[0].id as string;
}

/** Every `agent.message` row of an organization (superuser view). */
const messagingRows = async (organizationId = orgId) =>
  (
    await su.query(
      `select * from app.permission_rules where organization_id = $1 and permission = 'agent.message'
        order by created_at, id`,
      [organizationId],
    )
  ).rows as Json[];

const switchRows = async (organizationId = orgId) =>
  (await messagingRows(organizationId)).filter(
    (r) =>
      r.scope_unit_id === null &&
      r.subject_kind === "everyone" &&
      r.tool === null &&
      r.effect === "allow" &&
      r.path_prefix === null,
  );

const auditRows = async (action: string) =>
  (
    await su.query(
      "select * from app.audit_events where organization_id = $1 and action = $2 order by occurred_at, id",
      [orgId, action],
    )
  ).rows as Json[];

const ruleEvents = async (organizationId = orgId) =>
  (
    await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'permission_rules.updated' order by seq",
      [`org:${organizationId}`],
    )
  ).rows as Json[];

/** The canonical decision (P-05): `source` consults `target` on behalf of `human`. */
async function decision(source: string, human: string, target: string, organizationId = orgId) {
  return stack.built.core.db.withTenant({ organizationId, userId: human }, (tx) =>
    messagingDecision(tx, createPermissionService(stack.built.core), {
      sourceAgentId: source,
      humanUserId: human,
      targetAgentId: target,
    }),
  );
}

const setSwitch = (as: TestClient, enabled: boolean) =>
  as.request("PUT", "/api/v1/agent-messaging", { enabled });

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  victor = new TestClient(stack.baseUrl);
  const setup = await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = setup.organization.id;
  victorId = setup.user.id;
  ({ client: sam, userId: samId } = await invite(
    stack,
    victor,
    "sam@example.test",
    "Sam Standard",
    "standard",
  ));
  ({ client: lee, userId: leeId } = await invite(stack, victor, "lee@example.test", "Lee Lead", "lead"));
  ({ userId: patId } = await invite(stack, victor, "pat@example.test", "Pat Ops", "standard"));
  opsId = (
    await ok(victor.request("POST", "/api/v1/units", { kind: "department", name: "Ops", parentId: null }))
  ).id;
  await ok(victor.request("POST", `/api/v1/units/${opsId}/members`, { userId: leeId, role: "lead" }));
  await ok(victor.request("POST", `/api/v1/units/${opsId}/members`, { userId: patId }));

  archie = await insertBot(orgId, "Archie");
  bea = await insertBot(orgId, "Bea");
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("the organization switch: closed by default, one audited rule (D-04, P-03)", () => {
  it("closed by default → the admin turns it on → the canonical decision is allowed → off closes it again", async () => {
    const closed = await decision(archie, samId, bea);
    expect(closed.allowed).toBe(false);
    expect(closed.denial).toMatchObject({ permission: "agent.message", layer: "role" });

    expect(await ok(victor.request("GET", "/api/v1/agent-messaging"))).toEqual({
      enabled: false,
      canManage: true,
    });

    const createdBefore = (await auditRows("permission_rule.created")).length;
    const eventsBefore = (await ruleEvents()).length;
    expect(await ok(setSwitch(victor, true))).toEqual({ enabled: true, canManage: true });
    const rows = await switchRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject_id: null, created_by: victorId });
    expect(await messagingRows()).toHaveLength(1);
    const created = (await auditRows("permission_rule.created")).slice(createdBefore);
    expect(created).toHaveLength(1);
    expect(created[0]?.resource_id).toBe(rows[0]?.id);
    expect(created[0]?.metadata).toMatchObject({ via: "agent_messaging" });
    expect((await ruleEvents()).length).toBe(eventsBefore + 1);

    expect((await decision(archie, samId, bea)).allowed).toBe(true);

    // Idempotent: on again writes nothing.
    expect(await ok(setSwitch(victor, true))).toEqual({ enabled: true, canManage: true });
    expect(await switchRows()).toHaveLength(1);
    expect((await auditRows("permission_rule.created")).length).toBe(createdBefore + 1);
    expect((await ruleEvents()).length).toBe(eventsBefore + 1);

    // A hand-written duplicate goes with the switch (one audit per row, one event).
    await su.query(
      `insert into app.permission_rules (organization_id, subject_kind, permission, effect)
       values ($1, 'everyone', 'agent.message', 'allow')`,
      [orgId],
    );
    const deletedBefore = (await auditRows("permission_rule.deleted")).length;
    expect(await ok(setSwitch(victor, false))).toEqual({ enabled: false, canManage: true });
    expect(await switchRows()).toHaveLength(0);
    const deleted = (await auditRows("permission_rule.deleted")).slice(deletedBefore);
    expect(deleted).toHaveLength(2);
    for (const d of deleted) expect(d.metadata).toMatchObject({ via: "agent_messaging" });
    expect((await ruleEvents()).length).toBe(eventsBefore + 2);
    expect((await decision(archie, samId, bea)).allowed).toBe(false);

    // Off again: nothing to do.
    await ok(setSwitch(victor, false));
    expect((await auditRows("permission_rule.deleted")).length).toBe(deletedBefore + 2);
    expect((await ruleEvents()).length).toBe(eventsBefore + 2);
  });

  it("only admins see and change the switch: a unit lead and a standard member get 403 and nothing changes", async () => {
    const before = await messagingRows();
    for (const c of [sam, lee]) {
      expect((await fails(c.request("GET", "/api/v1/agent-messaging"), 403)).details).toMatchObject({
        permission: "rule.read",
      });
      expect((await fails(setSwitch(c, true), 403)).details).toMatchObject({ permission: "rule.manage" });
    }
    expect(await messagingRows()).toEqual(before);
  });

  it("a malformed body is 400 validation_error and writes nothing", async () => {
    const before = await messagingRows();
    for (const body of [{}, { enabled: "yes" }, { enabled: null }]) {
      expect((await fails(victor.request("PUT", "/api/v1/agent-messaging", body), 400)).code).toBe(
        "validation_error",
      );
    }
    expect(await messagingRows()).toEqual(before);
  });
});

// TASK2_HUMAN_SIDE

// TASK3_PER_BOT

/** A client whose membership moved to a fresh organization B, as its admin (module-access.int.test.ts). */
async function otherOrgAdmin(): Promise<{ client: TestClient; orgB: string; userB: string }> {
  const { client, userId: userB } = await invite(
    stack,
    victor,
    `eve-${randomUUID().slice(0, 8)}@example.test`,
    "Eve",
    "standard",
  );
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    orgB,
    `evil-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [userB]);
  await su.query("delete from app.org_members where user_id = $1", [userB]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    userB,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, userB],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, userB]);
  return { client, orgB, userB };
}

describe("tenant isolation (C-02)", () => {
  let eve: { client: TestClient; orgB: string; userB: string };

  beforeAll(async () => {
    eve = await otherOrgAdmin();
  });

  it("organization B's switch never changes organization A's decisions or view", async () => {
    expect(await ok(setSwitch(eve.client, true))).toEqual({ enabled: true, canManage: true });
    expect(await switchRows(eve.orgB)).toHaveLength(1);
    expect(await switchRows()).toHaveLength(0);
    expect((await decision(archie, samId, bea)).allowed).toBe(false);
    expect(await ok(victor.request("GET", "/api/v1/agent-messaging"))).toEqual({
      enabled: false,
      canManage: true,
    });
    await ok(setSwitch(eve.client, false));
    expect(await switchRows(eve.orgB)).toHaveLength(0);
  });

  // TASK3_CROSS_TENANT
});
