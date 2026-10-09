import { randomUUID } from "node:crypto";
import { MODULE_CATALOG } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import {
  type AiStack,
  type ConvSubscription,
  seedPlan,
  startAiStack,
  subscribeConv,
  subscribeTopic,
} from "../../testing-ai";
import { sleep } from "../../testing-device";
import { connectWithProject, invite, pairDevice, startSession } from "../../testing-workzone";

/**
 * Phase 07.3 (ADR-0024, ACCESS-02, ACCESS-03): `GET/PUT /api/v1/module-access`. A module is turned off or on for the
 * organization, a unit or a person by writing or deleting exactly the catalog deny rows at that scope and subject,
 * through the same rule-row helpers, audit and `permission_rules.updated` event as `/permission-rules`; the resolver
 * then refuses at once. Real PostgreSQL + Redis, the in-process fake model; no real provider is ever called.
 *
 * Cast: Víctor (admin, setup), Dana (developer, Backend), Sam (developer, Sales), Lena (org role lead, lead of Backend),
 * Ada (admin, member of Backend). Units: Engineering (department) › Backend (team) › Payments (project); Engineering
 * › Frontend (team); Sales (department).
 */

let stack: AiStack;
let su: pg.Client;
let victor: TestClient;
let dana: TestClient;
let sam: TestClient;
let lena: TestClient;
let ada: TestClient;
let orgId: string;
let victorId: string;
let danaId: string;
let samId: string;
let lenaId: string;
let adaId: string;
let engineeringId: string;
let backendId: string;
let paymentsId: string;
let frontendId: string;
let salesId: string;
let danaChat: string;

const CELL_TOKEN = "ocw-test-cell-token-module-access-api-0123456789";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };

const PLAN_MODEL = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const cid = () => `cm-${randomUUID()}`;

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

type Subject = { kind: "everyone" } | { kind: "user"; userId: string };
const everyone: Subject = { kind: "everyone" };
const person = (userId: string): Subject => ({ kind: "user", userId });

const put = (
  as: TestClient,
  module: string,
  scopeUnitId: string | null,
  subject: Subject,
  enabled: boolean,
) => as.request("PUT", "/api/v1/module-access", { module, scopeUnitId, subject, enabled });

const view = (as: TestClient, unitId: string | null) =>
  as.request("GET", `/api/v1/module-access${unitId ? `?unitId=${unitId}` : ""}`);

const stateOf = (v: Json, module: string) => (v.modules as Json[]).find((m) => m.module === module) as Json;

/** The exact rows of one (scope, subject) through the superuser client. */
async function rowsAt(scopeUnitId: string | null, subject: Subject) {
  return (
    await su.query(
      `select * from app.permission_rules
        where organization_id = $1
          and scope_unit_id is not distinct from $2::uuid
          and subject_kind = $3
          and subject_id is not distinct from $4::text
        order by permission`,
      [orgId, scopeUnitId, subject.kind, subject.kind === "user" ? subject.userId : null],
    )
  ).rows as Json[];
}

const auditCount = async (action: string) =>
  Number(
    (
      await su.query(
        "select count(*)::int as n from app.audit_events where organization_id = $1 and action = $2",
        [orgId, action],
      )
    ).rows[0].n,
  );

const auditRows = async (action: string, since: number) =>
  (
    await su.query(
      "select * from app.audit_events where organization_id = $1 and action = $2 order by occurred_at, id offset $3",
      [orgId, action, since],
    )
  ).rows as Json[];

const ruleEvents = async () =>
  (
    await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'permission_rules.updated' order by seq",
      [`org:${orgId}`],
    )
  ).rows.map((r) => r.payload as Json);

const myPermissions = async (c: TestClient) =>
  (await ok(c.request("GET", "/api/v1/me/permissions"))).permissions as string[];

async function settled(generationId: string, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = (await su.query("select status from app.ai_generations where id = $1", [generationId])).rows[0];
    if (g && g.status !== "running") return;
    if (Date.now() > until) throw new Error(`generation ${generationId} still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function unit(kind: string, name: string, parentId: string | null): Promise<string> {
  return (await ok(victor.request("POST", "/api/v1/units", { kind, name, parentId }))).id as string;
}

beforeAll(async () => {
  stack = await startAiStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN } });
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
  orgId = setup.organization.id as string;
  victorId = setup.user.id as string;
  ({ client: dana, userId: danaId } = await invite(
    stack,
    victor,
    "dana@example.test",
    "Dana Dev",
    "developer",
  ));
  ({ client: sam, userId: samId } = await invite(
    stack,
    victor,
    "sam@example.test",
    "Sam Rivera",
    "developer",
  ));
  ({ client: lena, userId: lenaId } = await invite(stack, victor, "lena@example.test", "Lena Lead", "lead"));
  ({ client: ada, userId: adaId } = await invite(stack, victor, "ada@example.test", "Ada Admin", "admin"));
  await seedPlan(dana);

  engineeringId = await unit("department", "Engineering", null);
  backendId = await unit("team", "Backend", engineeringId);
  paymentsId = await unit("project", "Payments", backendId);
  frontendId = await unit("team", "Frontend", engineeringId);
  salesId = await unit("department", "Sales", null);
  await ok(victor.request("POST", `/api/v1/units/${backendId}/members`, { userId: danaId }));
  await ok(victor.request("POST", `/api/v1/units/${backendId}/members`, { userId: lenaId, role: "lead" }));
  await ok(victor.request("POST", `/api/v1/units/${backendId}/members`, { userId: adaId }));
  await ok(victor.request("POST", `/api/v1/units/${salesId}/members`, { userId: samId }));

  const created = await ok(
    dana.request("POST", "/api/v1/ai-chats", {
      clientMessageId: cid(),
      body: "Quarterly ledger review",
      model: PLAN_MODEL,
    }),
    201,
  );
  await settled(created.generation.id as string);
  danaChat = created.chat.id as string;
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("tracer: one PUT turns AI chats off for Backend, its member is refused at once, one PUT turns it back on", () => {
  it("off writes one catalog deny row per pattern, audited per row, announced once; Dana loses her chat", async () => {
    await ok(dana.request("GET", `/api/v1/ai-chats/${danaChat}`));
    const createdBefore = await auditCount("permission_rule.created");
    const eventsBefore = (await ruleEvents()).length;

    const res = await ok(put(victor, "ai_chats", backendId, everyone, false));
    expect(res.scope).toEqual({ scopeUnitId: backendId, name: "Backend" });
    expect(stateOf(res, "ai_chats")).toMatchObject({ module: "ai_chats", state: "off" });
    expect(stateOf(res, "work_zone")).toMatchObject({ state: "on" });

    const rows = await rowsAt(backendId, everyone);
    expect(rows.map((r) => r.permission).sort()).toEqual([...MODULE_CATALOG.ai_chats.patterns].sort());
    for (const r of rows) {
      expect(r).toMatchObject({
        scope_unit_id: backendId,
        subject_kind: "everyone",
        subject_id: null,
        effect: "deny",
        tool: null,
        created_by: victorId,
      });
    }
    const audits = await auditRows("permission_rule.created", createdBefore);
    expect(audits).toHaveLength(MODULE_CATALOG.ai_chats.patterns.length);
    for (const a of audits) {
      expect(a.metadata).toMatchObject({ module: "ai_chats", via: "module_access" });
      expect(a.metadata.rule).toMatchObject({ scopeUnitId: backendId, effect: "deny" });
      expect(a.user_id).toBe(victorId);
    }
    const events = (await ruleEvents()).slice(eventsBefore);
    expect(events).toEqual([{ ruleId: expect.any(String), action: "module_disabled" }]);
    expect(rows.map((r) => r.id)).toContain(events[0]?.ruleId);

    await fails(dana.request("GET", `/api/v1/ai-chats/${danaChat}`), 404);
    expect(await myPermissions(dana)).not.toContain("ai_chat.read");
  });

  it("the same PUT again is a no-op: no row, no audit, no event", async () => {
    const rowsBefore = await rowsAt(backendId, everyone);
    const auditsBefore = await auditCount("permission_rule.created");
    const eventsBefore = (await ruleEvents()).length;
    const res = await ok(put(victor, "ai_chats", backendId, everyone, false));
    expect(stateOf(res, "ai_chats").state).toBe("off");
    expect((await rowsAt(backendId, everyone)).map((r) => r.id)).toEqual(rowsBefore.map((r) => r.id));
    expect(await auditCount("permission_rule.created")).toBe(auditsBefore);
    expect((await ruleEvents()).length).toBe(eventsBefore);
  });

  it("on deletes every exact row, audited per row, announced once; Dana reads her chat again", async () => {
    const rowsBefore = await rowsAt(backendId, everyone);
    const deletedBefore = await auditCount("permission_rule.deleted");
    const eventsBefore = (await ruleEvents()).length;
    const res = await ok(put(victor, "ai_chats", backendId, everyone, true));
    expect(stateOf(res, "ai_chats").state).toBe("on");
    expect(await rowsAt(backendId, everyone)).toEqual([]);
    const audits = await auditRows("permission_rule.deleted", deletedBefore);
    expect(audits.map((a) => a.resource_id).sort()).toEqual(rowsBefore.map((r) => r.id).sort());
    for (const a of audits) expect(a.metadata).toMatchObject({ module: "ai_chats", via: "module_access" });
    expect((await ruleEvents()).slice(eventsBefore)).toEqual([
      { ruleId: expect.any(String), action: "module_enabled" },
    ]);
    await ok(dana.request("GET", `/api/v1/ai-chats/${danaChat}`));
    expect(await myPermissions(dana)).toContain("ai_chat.read");
    // A second on is a no-op too.
    const eventsNow = (await ruleEvents()).length;
    await ok(put(victor, "ai_chats", backendId, everyone, true));
    expect((await ruleEvents()).length).toBe(eventsNow);
  });
});

describe("the read model and inheritance through the API (admin)", () => {
  let personaId: string;

  it("Backend's view: its people with canEdit, its persona count, every module on", async () => {
    personaId = (
      await ok(
        victor.request("POST", "/api/v1/agents", {
          name: "Deploy helper",
          username: "deploy-helper",
          instructions: "You help the Backend team ship.",
          modelProvider: "mock",
          modelId: "mock-1",
          unitId: backendId,
        }),
      )
    ).id as string;
    const v = await ok(view(victor, backendId));
    expect(v.scope).toEqual({ scopeUnitId: backendId, name: "Backend" });
    expect(v.unitBotCount).toBe(1);
    expect((v.modules as Json[]).map((m) => [m.module, m.state, m.inherited])).toEqual([
      ["work_zone", "on", null],
      ["ai_chats", "on", null],
      ["bots", "on", null],
    ]);
    expect((v.people as Json[]).map((p) => [p.displayName, p.canEdit])).toEqual([
      ["Ada Admin", true],
      ["Dana Dev", true],
      ["Lena Lead", true],
    ]);
    expect(v.overrides).toEqual([]);
    // Engineering counts the personas of its whole subtree; the organization has none of its own.
    expect((await ok(view(victor, engineeringId))).unitBotCount).toBe(1);
    const org = await ok(view(victor, null));
    expect(org.scope).toEqual({ scopeUnitId: null, name: "Organization" });
    expect(org.unitBotCount).toBe(0);
    expect((org.people as Json[]).map((p) => p.userId).sort()).toEqual(
      [victorId, danaId, samId, lenaId, adaId].sort(),
    );
  });

  it("a person row at organization scope turns Work Zone off for Dana only", async () => {
    await ok(dana.request("GET", "/api/v1/work-sessions"));
    const v = await ok(put(victor, "work_zone", null, person(danaId), false));
    const danaRow = (v.people as Json[]).find((p) => p.userId === danaId);
    expect(stateOf(danaRow as Json, "work_zone").state).toBe("off");
    expect(stateOf(v, "work_zone").state).toBe("on");
    expect((await fails(dana.request("GET", "/api/v1/work-sessions"), 403)).details).toMatchObject({
      permission: "work_session.read",
      layer: "user",
    });
    await ok(sam.request("GET", "/api/v1/work-sessions"));
    await ok(put(victor, "work_zone", null, person(danaId), true));
    await ok(dana.request("GET", "/api/v1/work-sessions"));
  });

  it("a department off reaches a team member and an admin member, not a sibling department; Backend shows it inherited", async () => {
    await ok(put(victor, "work_zone", engineeringId, everyone, false));
    try {
      expect((await fails(dana.request("GET", "/api/v1/work-sessions"), 403)).details).toMatchObject({
        permission: "work_session.read",
        layer: "unit",
        unitId: engineeringId,
      });
      // Deny beats admin: Ada is an admin and a member of Backend, under Engineering.
      expect((await fails(ada.request("GET", "/api/v1/work-sessions"), 403)).details).toMatchObject({
        layer: "unit",
        unitId: engineeringId,
      });
      await ok(sam.request("GET", "/api/v1/work-sessions"));
      await ok(victor.request("GET", "/api/v1/work-sessions"));

      const backend = await ok(view(victor, backendId));
      expect(stateOf(backend, "work_zone")).toEqual({
        module: "work_zone",
        state: "on",
        inherited: { scopeUnitId: engineeringId, name: "Engineering", state: "off" },
      });
      expect(stateOf((backend.people as Json[])[0] as Json, "work_zone").inherited).toMatchObject({
        scopeUnitId: engineeringId,
      });
      expect(stateOf(await ok(view(victor, engineeringId)), "work_zone").state).toBe("off");
      const org = await ok(view(victor, null));
      expect(org.overrides).toEqual([
        {
          unitId: engineeringId,
          name: "Engineering",
          modules: [
            { module: "work_zone", state: "off", inherited: null },
            { module: "ai_chats", state: "on", inherited: null },
            { module: "bots", state: "on", inherited: null },
          ],
        },
      ]);
    } finally {
      await ok(put(victor, "work_zone", engineeringId, everyone, true));
    }
    await ok(dana.request("GET", "/api/v1/work-sessions"));
    await ok(ada.request("GET", "/api/v1/work-sessions"));
  });

  it("side effect pinned (D-05): Bots off for Backend hides Backend's own persona from an admin outside Backend", async () => {
    await ok(victor.request("GET", `/api/v1/agents/${personaId}`));
    await ok(put(victor, "bots", backendId, everyone, false));
    try {
      await fails(victor.request("GET", `/api/v1/agents/${personaId}`), 404);
    } finally {
      await ok(put(victor, "bots", backendId, everyone, true));
    }
    await ok(victor.request("GET", `/api/v1/agents/${personaId}`));
  });

  it("a hand-written device.pair deny shows Work Zone custom; on deletes it with the catalog rows (P-06)", async () => {
    await ok(
      victor.request("POST", "/api/v1/permission-rules", {
        scopeUnitId: backendId,
        subjectKind: "everyone",
        permission: "device.pair",
        effect: "deny",
      }),
    );
    // A non-catalog deny at the same scope and subject is never touched.
    const other = await ok(
      victor.request("POST", "/api/v1/permission-rules", {
        scopeUnitId: backendId,
        subjectKind: "everyone",
        permission: "channel.archive",
        effect: "deny",
      }),
    );
    expect(stateOf(await ok(view(victor, backendId)), "work_zone").state).toBe("custom");
    expect((await ok(view(victor, engineeringId))).overrides).toEqual([
      expect.objectContaining({ unitId: backendId, name: "Backend" }),
    ]);
    const v = await ok(put(victor, "work_zone", backendId, everyone, true));
    expect(stateOf(v, "work_zone").state).toBe("on");
    expect((await rowsAt(backendId, everyone)).map((r) => r.id)).toEqual([other.id]);
    await ok(victor.request("DELETE", `/api/v1/permission-rules/${other.id as string}`));
  });
});

describe("lead rights: Lena leads Backend", () => {
  it("manages Backend and its child project; refused on Engineering, a sibling team and the organization", async () => {
    await ok(view(lena, backendId));
    await ok(view(lena, paymentsId));
    await ok(put(lena, "ai_chats", paymentsId, everyone, false));
    expect((await rowsAt(paymentsId, everyone)).length).toBe(MODULE_CATALOG.ai_chats.patterns.length);
    await ok(put(lena, "ai_chats", paymentsId, everyone, true));
    expect(await rowsAt(paymentsId, everyone)).toEqual([]);
    for (const scope of [engineeringId, frontendId, null]) {
      expect((await fails(view(lena, scope), 403)).details).toMatchObject({
        permission: "unit.modules.manage",
      });
      expect((await fails(put(lena, "ai_chats", scope, everyone, false), 403)).details).toMatchObject({
        permission: "unit.modules.manage",
      });
    }
    expect(await rowsAt(engineeringId, everyone)).toEqual([]);
    expect(await rowsAt(null, everyone)).toEqual([]);
  });

  it("a person row for a Backend member is scoped to Backend; outside the subtree is not_in_unit", async () => {
    await ok(put(lena, "bots", backendId, person(danaId), false));
    const rows = await rowsAt(backendId, person(danaId));
    expect(rows.length).toBe(MODULE_CATALOG.bots.patterns.length);
    for (const r of rows)
      expect(r).toMatchObject({ scope_unit_id: backendId, subject_kind: "user", subject_id: danaId });
    await ok(put(lena, "bots", backendId, person(danaId), true));
    expect(await rowsAt(backendId, person(danaId))).toEqual([]);

    const err = await fails(put(lena, "bots", backendId, person(samId), false), 400);
    expect(err).toMatchObject({ code: "not_in_unit", message: "This person is not in Backend" });
    expect(await rowsAt(backendId, person(samId))).toEqual([]);
  });

  it("never an admin: a person row for Ada is role_ceiling, and her canEdit is false", async () => {
    const err = await fails(put(lena, "work_zone", backendId, person(adaId), false), 403);
    expect(err.details).toMatchObject({ permission: "unit.modules.manage", reason: "role_ceiling" });
    expect(await rowsAt(backendId, person(adaId))).toEqual([]);
    const v = await ok(view(lena, backendId));
    expect((v.people as Json[]).map((p) => [p.displayName, p.canEdit])).toEqual([
      ["Ada Admin", false],
      ["Dana Dev", true],
      ["Lena Lead", true],
    ]);
  });

  it("an Engineering off stays: Lena's on at Backend deletes nothing above and Dana stays refused", async () => {
    await ok(put(victor, "work_zone", engineeringId, everyone, false));
    try {
      const above = (await rowsAt(engineeringId, everyone)).map((r) => r.id);
      const v = await ok(put(lena, "work_zone", backendId, everyone, true));
      expect(stateOf(v, "work_zone").inherited).toEqual({
        scopeUnitId: engineeringId,
        name: "Engineering",
        state: "off",
      });
      expect((await rowsAt(engineeringId, everyone)).map((r) => r.id)).toEqual(above);
      await fails(dana.request("GET", "/api/v1/work-sessions"), 403);
    } finally {
      await ok(put(victor, "work_zone", engineeringId, everyone, true));
    }
    await ok(dana.request("GET", "/api/v1/work-sessions"));
  });

  it("re-enables at Backend what Víctor turned off at Backend (D-05 (2))", async () => {
    await ok(put(victor, "work_zone", backendId, everyone, false));
    await fails(dana.request("GET", "/api/v1/work-sessions"), 403);
    await ok(put(lena, "work_zone", backendId, everyone, true));
    expect(await rowsAt(backendId, everyone)).toEqual([]);
    await ok(dana.request("GET", "/api/v1/work-sessions"));
  });

  it("a lead's unit-wide off refuses Ada, an admin member of Backend; an admin outside Backend keeps it (ADR-0024)", async () => {
    await ok(ada.request("GET", "/api/v1/work-sessions"));
    await ok(put(lena, "work_zone", backendId, everyone, false));
    try {
      expect((await fails(ada.request("GET", "/api/v1/work-sessions"), 403)).details).toMatchObject({
        permission: "work_session.read",
        layer: "unit",
        unitId: backendId,
      });
      expect(await myPermissions(ada)).not.toContain("work_session.read");
      await ok(victor.request("GET", "/api/v1/work-sessions"));
    } finally {
      await ok(put(lena, "work_zone", backendId, everyone, true));
    }
    await ok(ada.request("GET", "/api/v1/work-sessions"));
  });

  it("Dana, a plain member, may neither read nor change Backend's modules", async () => {
    expect((await fails(view(dana, backendId), 403)).details).toMatchObject({
      permission: "unit.modules.manage",
    });
    await fails(put(dana, "ai_chats", backendId, everyone, false), 403);
    await fails(put(dana, "ai_chats", backendId, person(danaId), false), 403);
    expect(await rowsAt(backendId, everyone)).toEqual([]);
  });
});

describe("live application: open subscriptions are re-decided within a second (ADR-0009)", () => {
  it("Work Zone off revokes Dana's ws: and keeps conv:; AI chats off revokes conv:; on lets her subscribe again", async () => {
    const { token } = await pairDevice(stack, dana, "Dana's Mac");
    const { device, projectId } = await connectWithProject(stack, dana, token, {
      localId: "ledger",
      name: "ledger",
    });
    const sessionId = await startSession(dana, device, projectId);
    const ws = await subscribeTopic(stack.baseUrl, dana, `ws:${sessionId}`);
    const conv = await subscribeConv(stack.baseUrl, dana, danaChat);
    const revoked = (s: ConvSubscription, topic: string) =>
      s.frames.some((f) => f.op === "revoked" && f.topic === topic);
    try {
      expect(ws.outcome).toBe("subscribed");
      expect(conv.outcome).toBe("subscribed");

      await ok(put(victor, "work_zone", null, person(danaId), false));
      await ws.waitFor(() => revoked(ws, `ws:${sessionId}`), 1000);
      await sleep(300);
      expect(revoked(conv, `conv:${danaChat}`)).toBe(false);

      await ok(put(victor, "ai_chats", null, person(danaId), false));
      await conv.waitFor(() => revoked(conv, `conv:${danaChat}`), 1000);
      const held = await myPermissions(dana);
      expect(held).not.toContain("work_session.read");
      expect(held).not.toContain("ai_chat.read");
      expect((await subscribeTopic(stack.baseUrl, dana, `ws:${sessionId}`)).outcome).toBe("error");
    } finally {
      ws.close();
      conv.close();
      await ok(put(victor, "work_zone", null, person(danaId), true));
      await ok(put(victor, "ai_chats", null, person(danaId), true));
    }
    const again = await subscribeTopic(stack.baseUrl, dana, `ws:${sessionId}`);
    const againConv = await subscribeConv(stack.baseUrl, dana, danaChat);
    try {
      expect(again.outcome).toBe("subscribed");
      expect(againConv.outcome).toBe("subscribed");
      expect(await myPermissions(dana)).toEqual(
        expect.arrayContaining(["work_session.read", "ai_chat.read"]),
      );
    } finally {
      again.close();
      againConv.close();
      await device.close();
    }
  });
});

/** A client whose membership moved to a fresh organization B, as its admin (artifact/attachments.int.test.ts). */
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

const orgRuleCount = async (organizationId: string) =>
  Number(
    (
      await su.query("select count(*)::int as n from app.permission_rules where organization_id = $1", [
        organizationId,
      ])
    ).rows[0].n,
  );

describe("tenant isolation (C-02)", () => {
  it("organization B can neither read nor change organization A's module rules", async () => {
    await ok(put(victor, "bots", backendId, everyone, false));
    try {
      const before = await orgRuleCount(orgId);
      const { client: eve, orgB, userB } = await otherOrgAdmin();
      expect((await ok(eve.request("GET", "/api/v1/me/permissions"))).role).toBe("admin");

      expect((await fails(view(eve, backendId), 404)).code).toBe("unit_not_found");
      expect((await fails(put(eve, "bots", backendId, everyone, true), 404)).code).toBe("unit_not_found");
      expect((await fails(put(eve, "work_zone", null, person(danaId), false), 400)).code).toBe(
        "unknown_subject",
      );

      const bView = await ok(view(eve, null));
      expect((bView.people as Json[]).map((p) => p.userId)).toEqual([userB]);
      expect(bView.overrides).toEqual([]);
      expect((bView.modules as Json[]).every((m) => m.state === "on")).toBe(true);

      expect(await orgRuleCount(orgId)).toBe(before);
      expect(await orgRuleCount(orgB)).toBe(0);
      expect((await rowsAt(backendId, everyone)).length).toBe(MODULE_CATALOG.bots.patterns.length);
    } finally {
      await ok(put(victor, "bots", backendId, everyone, true));
    }
  });
});

describe("request hygiene", () => {
  it("a malformed PUT is 400 validation_error and writes no row, audit or event", async () => {
    const rules = await orgRuleCount(orgId);
    const created = await auditCount("permission_rule.created");
    const events = (await ruleEvents()).length;
    const bad = [
      { module: "search", scopeUnitId: null, subject: everyone, enabled: false },
      { module: "bots", scopeUnitId: null, subject: { kind: "role", role: "standard" }, enabled: false },
      { module: "bots", scopeUnitId: null, subject: everyone },
      { module: "bots", scopeUnitId: null, subject: { kind: "everyone", userId: danaId }, enabled: false },
    ];
    for (const body of bad) {
      expect((await fails(victor.request("PUT", "/api/v1/module-access", body), 400)).code).toBe(
        "validation_error",
      );
    }
    // A refused (403) request writes nothing either.
    await fails(put(dana, "bots", null, everyone, false), 403);
    expect(await orgRuleCount(orgId)).toBe(rules);
    expect(await auditCount("permission_rule.created")).toBe(created);
    expect((await ruleEvents()).length).toBe(events);
  });
});
