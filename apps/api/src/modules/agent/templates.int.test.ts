import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * 07.4-08 (CONN-06, D-05, SC4): agent templates. A unit lead publishes immutable numbered versions; a member starts
 * their own personal agent from one (a fork: `template_id` + `template_version`, its own DM, its own memory), within
 * the personal-agent caps and under the same advisory lock as one-click personal bots. Real PostgreSQL + Redis.
 */

const CELL_TOKEN = "ocw-test-cell-token-templates-0123456789abcdef";
const ADMIN = {
  name: "Víctor Ruiz",
  email: "victor@example.test",
  password: "correct-horse-battery",
  orgName: "Autofy Labs",
};

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let riley: TestClient;
let sam: TestClient;
let jo: TestClient;
let orgId: string;
let rileyId: string;
let samId: string;
let joId: string;
let eng: string;
let backend: string;
let frontend: string;
let templateId: string;
let samBotId: string;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function fails(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status: number) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return ((r.body as Json | null)?.error ?? {}) as Json;
}

async function joinAs(email: string, name: string, role: "standard" | "developer" | "lead") {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

const unit = async (kind: string, name: string, parentId: string | null) =>
  (await ok(admin.request("POST", "/api/v1/units", { kind, name, parentId }))).id as string;

/** A version body; the mock model is the one every org allows when `OCW_MODEL_PROVIDER=mock`. */
const versionBody = (extra: Json = {}) => ({
  instructions: "You file expense reports from the receipts people forward.",
  modelProvider: "mock",
  modelId: "mock-1",
  capabilities: { internet: false, memory: true, dailyLimit: 20 },
  toolGrants: [],
  requiredConnectorIds: [],
  unitVaultItemIds: [],
  ...extra,
});

const audits = async (action: string) =>
  (
    await su.query(
      "select user_id, resource_id, metadata from app.audit_events where action = $1 and organization_id = $2 order by occurred_at",
      [action, orgId],
    )
  ).rows as Json[];

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN }));
  orgId = setup.organization.id;
  // Riley leads Backend (only Lead/Admin may lead a unit); Sam is a Backend member, Jo a Frontend member.
  [riley, rileyId] = await joinAs("riley@example.test", "Riley Park", "lead");
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee", "standard");
  [jo, joId] = await joinAs("jo@example.test", "Jo Diaz", "standard");
  eng = await unit("department", "Engineering", null);
  backend = await unit("team", "Backend", eng);
  frontend = await unit("team", "Frontend", eng);
  await ok(admin.request("POST", `/api/v1/units/${backend}/members`, { userId: rileyId, role: "lead" }));
  await ok(admin.request("POST", `/api/v1/units/${backend}/members`, { userId: samId }));
  await ok(admin.request("POST", `/api/v1/units/${frontend}/members`, { userId: joId }));
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("tracer: a lead publishes a template, a member starts their own agent from it", () => {
  it("the Backend lead creates a template with version 1", async () => {
    const t = await ok(
      riley.request("POST", "/api/v1/agent-templates", {
        unitId: backend,
        name: "Expense filer",
        description: "Files expense reports.",
        version: versionBody(),
      }),
      201,
    );
    expect(t).toMatchObject({
      unitId: backend,
      unitName: "Backend",
      name: "Expense filer",
      currentVersion: 1,
      archivedAt: null,
      canManage: true,
      requiredConnectors: [],
      latest: {
        version: 1,
        modelProvider: "mock",
        modelId: "mock-1",
        createdBy: rileyId,
        createdByName: "Riley Park",
      },
    });
    templateId = t.id;
    const created = await audits("agent_template.created");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ user_id: rileyId, resource_id: templateId });
    expect(created[0]?.metadata).toEqual({ templateId, unitId: backend, version: 1 });
  });

  it("Sam (a Backend member) sees it in GET /agent-templates", async () => {
    const list = await ok(sam.request("GET", "/api/v1/agent-templates"));
    expect(list.templates.map((t: Json) => t.id)).toEqual([templateId]);
    expect(list.templates[0]).toMatchObject({ name: "Expense filer", canManage: false, currentVersion: 1 });
    expect(list.manageableUnits).toEqual([]);
  });

  it("Sam starts his own agent: a personal bot with the template id and version, its instructions and a DM", async () => {
    const res = await ok(sam.request("POST", `/api/v1/agent-templates/${templateId}/instantiate`, {}), 201);
    expect(res.agent).toMatchObject({
      scope: "personal",
      ownerUserId: samId,
      name: "Expense filer",
      modelProvider: "mock",
      modelId: "mock-1",
      instructions: "You file expense reports from the receipts people forward.",
    });
    expect(res.skipped).toEqual([]);
    samBotId = res.agent.id;
    const [row] = (
      await su.query(
        "select scope, owner_user_id, template_id, template_version, capabilities from app.agents where id = $1",
        [samBotId],
      )
    ).rows;
    expect(row).toMatchObject({
      scope: "personal",
      owner_user_id: samId,
      template_id: templateId,
      template_version: 1,
    });
    expect(row.capabilities).toMatchObject({ internet: false, memory: true, dailyLimit: 20 });
    const [dm] = (
      await su.query("select kind, dm_key from app.conversations where id = $1", [res.dmConversationId])
    ).rows;
    expect(dm).toEqual({ kind: "dm", dm_key: `agent:${samBotId}|user:${samId}` });
    const fromTemplate = await audits("agent.created_from_template");
    expect(fromTemplate).toHaveLength(1);
    expect(fromTemplate[0]).toMatchObject({ user_id: samId, resource_id: samBotId });
    expect(fromTemplate[0]?.metadata).toEqual({ templateId, version: 1, skipped: [] });
    // The one-click audit is still written by the shared creation path.
    expect((await audits("agent.created")).some((a) => a.resource_id === samBotId)).toBe(true);
  });

  it("the bot's detail reads its template link (owner only): name, version 1, no update yet", async () => {
    const link = await ok(sam.request("GET", `/api/v1/agents/${samBotId}/template`));
    expect(link).toEqual({
      templateId,
      templateName: "Expense filer",
      version: 1,
      latestVersion: 1,
      update: null,
      requiredConnectors: [],
    });
  });
});
