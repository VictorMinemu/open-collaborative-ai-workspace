import { randomUUID } from "node:crypto";
import { MODULE_CATALOG } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import { type AiStack, seedPlan, startAiStack } from "../../testing-ai";
import { invite } from "../../testing-workzone";

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
