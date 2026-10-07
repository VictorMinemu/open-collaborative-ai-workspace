import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * 06-07 (AGENT-01, D-07, P-04): bots become scoped personas. A shared persona belongs to the organization or to a
 * department, team or project (`agents.unit_id`) and may have an accountable owner. Admins create them anywhere;
 * unit leads only inside the units they lead (`bot.manage_unit`, `bot.configure` through LEAD_PERMISSIONS). A unit
 * persona is seen and mentioned only by its unit subtree, its leads, its owner and admins (`unit_agent`). A unit
 * with personas cannot be deleted. Real PostgreSQL + Redis.
 */

const CELL_TOKEN = "ocw-test-cell-token-personas-0123456789abcdefgh";
const ADMIN = {
  name: "Víctor Ruiz",
  email: "victor@example.test",
  password: "correct-horse-battery",
  orgName: "Autofy Labs",
};
const SAFE = "m0123abcd";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let riley: TestClient;
let alex: TestClient;
let jo: TestClient;
let orgId: string;
let adminId: string;
let rileyId: string;
let alexId: string;
let joId: string;
let samId: string;
let eng: string;
let backend: string;
let payments: string;
let frontend: string;
let archieId: string;
let mcpId: string;
let personaId: string;
let opsId: string;

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

const persona = (extra: Json = {}) => ({
  name: "Deploy helper",
  username: "deploy-helper",
  instructions: "You help the Backend team ship.",
  modelProvider: "mock",
  modelId: "mock-1",
  ...extra,
});

const usernamesOf = async (c: TestClient) =>
  ((await ok(c.request("GET", "/api/v1/agents"))).agents as Json[]).map((a) => a.username as string);

const eventsOn = async (streamId: string, type: string, agentId: string) =>
  (
    await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = $2 and payload->>'id' = $3 order by seq",
      [streamId, type, agentId],
    )
  ).rows.map((r) => r.payload as Json);

const mentionsOf = async (messageId: string) =>
  (
    await su.query(
      `select payload from app.stream_events
       where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2`,
      [`cell:${orgId}`, messageId],
    )
  ).rows.map((r) => r.payload as Json);

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN }));
  orgId = setup.organization.id;
  adminId = setup.user.id;
  // Riley's org role is Lead (only Lead/Admin may lead a unit); the role itself grants no bot right.
  [riley, rileyId] = await joinAs("riley@example.test", "Riley Park", "lead");
  [alex, alexId] = await joinAs("alex@example.test", "Alex Kim", "standard");
  [jo, joId] = await joinAs("jo@example.test", "Jo Diaz", "standard");
  [, samId] = await joinAs("sam@example.test", "Sam Lee", "standard");

  eng = await unit("department", "Engineering", null);
  backend = await unit("team", "Backend", eng);
  payments = await unit("project", "Payments", backend);
  frontend = await unit("team", "Frontend", eng);
  await ok(admin.request("POST", `/api/v1/units/${backend}/members`, { userId: rileyId, role: "lead" }));
  await ok(admin.request("POST", `/api/v1/units/${backend}/members`, { userId: alexId }));
  await ok(admin.request("POST", `/api/v1/units/${frontend}/members`, { userId: joId }));

  // A Phase 1 one-click bot: it keeps working as an organization persona.
  archieId = (
    await ok(
      admin.request("POST", "/api/v1/agents", {
        name: "Archie",
        instructions: "You are Archie.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    )
  ).id;

  mcpId = randomUUID();
  await su.query(
    `insert into app.mcp_servers (id, organization_id, name, safe_name, transport, url, status)
     values ($1, $2, 'Docs', $3, 'streamable-http', 'https://mcp.example.test/mcp', 'ready')`,
    [mcpId, orgId, SAFE],
  );
  await su.query(
    `insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only)
     values ($1, $2, 'echo', $3, true)`,
    [orgId, mcpId, `${SAFE}__echo`],
  );

  opsId = (await ok(admin.request("POST", "/api/v1/channels", { name: "ops", visibility: "public" }))).id;
  for (const id of [alexId, joId]) {
    await ok(admin.request("POST", `/api/v1/channels/${opsId}/members`, { kind: "user", id }));
  }
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("creating personas: admins anywhere, leads only in the units they lead", () => {
  it("Riley (lead of Backend) creates @deploy-helper in Backend with himself as owner", async () => {
    const created = await ok(
      riley.request("POST", "/api/v1/agents", persona({ unitId: backend, ownerUserId: rileyId })),
    );
    expect(created).toMatchObject({
      username: "deploy-helper",
      scope: "team",
      unitId: backend,
      unit: { id: backend, name: "Backend", kind: "team" },
      ownerUserId: rileyId,
    });
    personaId = created.id;
    expect(created.viewerCan).toEqual(
      expect.arrayContaining(["bot.read", "bot.configure", "bot.manage_unit"]),
    );
    // Ids only in the audit row (T-06-07-05).
    const audit = await su.query(
      "select user_id, metadata from app.audit_events where action = 'agent.created' and resource_id = $1",
      [personaId],
    );
    expect(audit.rows[0]).toMatchObject({
      user_id: rileyId,
      metadata: { unitId: backend, ownerUserId: rileyId },
    });
  });

  it("a unit persona defaults its owner to the creator", async () => {
    const p = await ok(
      riley.request(
        "POST",
        "/api/v1/agents",
        persona({ name: "Pay bot", username: "pay-bot", unitId: payments }),
      ),
    );
    expect(p).toMatchObject({ unitId: payments, unit: { kind: "project" }, ownerUserId: rileyId });
    await ok(admin.request("DELETE", `/api/v1/agents/${p.id}`));
  });

  it("Riley cannot create in Frontend (bot.manage_unit) nor for the organization (bot.manage)", async () => {
    const outside = await fails(
      riley.request("POST", "/api/v1/agents", persona({ username: "fe-bot", unitId: frontend })),
      403,
    );
    expect(outside.details).toMatchObject({ permission: "bot.manage_unit" });
    const org = await fails(riley.request("POST", "/api/v1/agents", persona({ username: "org-bot" })), 403);
    expect(org.details).toMatchObject({ permission: "bot.manage" });
    // A standard member creates nothing anywhere.
    await fails(alex.request("POST", "/api/v1/agents", persona({ username: "a-bot", unitId: backend })), 403);
  });

  it("the admin creates an organization persona with an owner and a department persona", async () => {
    const org = await ok(
      admin.request(
        "POST",
        "/api/v1/agents",
        persona({ name: "Concierge", username: "concierge", ownerUserId: samId }),
      ),
    );
    expect(org).toMatchObject({ unitId: null, unit: null, ownerUserId: samId, scope: "team" });
    const dept = await ok(
      admin.request(
        "POST",
        "/api/v1/agents",
        persona({ name: "Eng guide", username: "eng-guide", unitId: eng }),
      ),
    );
    expect(dept).toMatchObject({ unitId: eng, unit: { name: "Engineering", kind: "department" } });
    // Organization personas have no owner by default.
    const plain = await ok(
      admin.request("POST", "/api/v1/agents", persona({ name: "Plain", username: "plain" })),
    );
    expect(plain.ownerUserId).toBeNull();
  });

  it("the owner must be an active member of this organization (404), the unit must exist in it (404)", async () => {
    expect(
      (
        await fails(
          admin.request("POST", "/api/v1/agents", persona({ username: "x1", ownerUserId: randomUUID() })),
          404,
        )
      ).code,
    ).toBe("owner_not_found");
    expect(
      (
        await fails(
          admin.request("POST", "/api/v1/agents", persona({ username: "x2", unitId: randomUUID() })),
          404,
        )
      ).code,
    ).toBe("unit_not_found");
  });

  it("cross-tenant: a unit or an owner of another organization is not found (the FK alone would accept it)", async () => {
    const orgB = randomUUID();
    const userB = randomUUID();
    const unitB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
      orgB,
      `evil-${orgB}`,
    ]);
    await su.query("insert into auth.user (id, name, email) values ($1, 'Eve', $2)", [
      userB,
      `${userB}@evil.test`,
    ]);
    await su.query(
      "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
      [orgB, userB],
    );
    await su.query(
      "insert into app.org_units (id, organization_id, kind, name, path) values ($1, $2, 'team', 'Evil team', $3)",
      [unitB, orgB, `{${unitB}}`],
    );
    expect(
      (await fails(admin.request("POST", "/api/v1/agents", persona({ username: "x3", unitId: unitB })), 404))
        .code,
    ).toBe("unit_not_found");
    expect(
      (
        await fails(
          admin.request("POST", "/api/v1/agents", persona({ username: "x4", ownerUserId: userB })),
          404,
        )
      ).code,
    ).toBe("owner_not_found");
    await fails(admin.request("PATCH", `/api/v1/agents/${personaId}`, { unitId: unitB }), 404);
    const stored = await su.query("select count(*)::int as n from app.agents where unit_id = $1", [unitB]);
    expect(stored.rows[0].n).toBe(0);
  });
});

describe("visibility follows the unit subtree", () => {
  it("Alex (Backend) and the admin list @deploy-helper; Jo (Frontend) does not", async () => {
    expect(await usernamesOf(alex)).toContain("deploy-helper");
    expect(await usernamesOf(admin)).toContain("deploy-helper");
    const joSees = await usernamesOf(jo);
    expect(joSees).not.toContain("deploy-helper");
    // The department persona of Engineering is visible to every member of its subtree, Jo included.
    expect(joSees).toEqual(expect.arrayContaining(["eng-guide", "archie", "concierge"]));
    // Jo learns nothing about it: 404 on the detail, the DM and the capabilities.
    await fails(jo.request("GET", `/api/v1/agents/${personaId}`), 404);
    await fails(jo.request("POST", `/api/v1/agents/${personaId}/dm`), 404);
    await fails(jo.request("GET", `/api/v1/agents/${personaId}/capabilities`), 404);
  });

  it("the list tells each caller where they may create", async () => {
    const r = await ok(riley.request("GET", "/api/v1/agents"));
    expect(r.create.organization).toBe(false);
    expect([...r.create.unitIds].sort()).toEqual([backend, payments].sort());
    const a = await ok(admin.request("GET", "/api/v1/agents"));
    expect(a.create.organization).toBe(true);
    expect([...a.create.unitIds].sort()).toEqual([eng, backend, payments, frontend].sort());
    const j = await ok(jo.request("GET", "/api/v1/agents"));
    expect(j.create).toEqual({ organization: false, unitIds: [] });
  });

  it("existing Phase 1 bots list as organization personas", async () => {
    const list = (await ok(alex.request("GET", "/api/v1/agents"))).agents as Json[];
    expect(list.find((a) => a.id === archieId)).toMatchObject({ unitId: null, unit: null, scope: "team" });
  });

  it("realtime: the persona travels on its readers' user topics, never on the org topic", async () => {
    expect(await eventsOn(`org:${orgId}`, "agent.created", personaId)).toEqual([]);
    expect(await eventsOn(`user:${alexId}`, "agent.created", personaId)).toHaveLength(1);
    expect(await eventsOn(`user:${adminId}`, "agent.created", personaId)).toHaveLength(1);
    expect(await eventsOn(`user:${joId}`, "agent.created", personaId)).toEqual([]);
    // Organization personas keep the org topic.
    expect(await eventsOn(`org:${orgId}`, "agent.created", archieId)).toHaveLength(1);
  });
});

describe("lead configuration through the Phase 3.1 routes", () => {
  it("Riley toggles internet and grants an MCP tool; Jo gets 404; Alex gets 403", async () => {
    const v = await ok(
      riley.request("PATCH", `/api/v1/agents/${personaId}/capabilities`, {
        internet: true,
        tools: [{ sourceKind: "mcp", sourceId: mcpId, tool: `${SAFE}__echo` }],
      }),
    );
    expect(v.capabilities.internet).toBe(true);
    expect(v.tools.find((t: Json) => t.tool === `${SAFE}__echo`)).toMatchObject({ granted: true });
    await fails(jo.request("PATCH", `/api/v1/agents/${personaId}/capabilities`, { internet: false }), 404);
    await fails(alex.request("PATCH", `/api/v1/agents/${personaId}/capabilities`, { internet: false }), 403);
  });

  it("Riley edits the persona's profile; Alex cannot; Riley cannot touch Archie", async () => {
    const r = await ok(
      riley.request("PATCH", `/api/v1/agents/${personaId}`, { description: "Ships Backend" }),
    );
    expect(r.description).toBe("Ships Backend");
    await fails(alex.request("PATCH", `/api/v1/agents/${personaId}`, { description: "x" }), 403);
    await fails(jo.request("PATCH", `/api/v1/agents/${personaId}`, { description: "x" }), 404);
    await fails(riley.request("PATCH", `/api/v1/agents/${archieId}`, { description: "x" }), 403);
  });

  it("moving the persona to the organization needs bot.manage (Riley 403, admin 200), and back needs the unit right", async () => {
    const denied = await fails(riley.request("PATCH", `/api/v1/agents/${personaId}`, { unitId: null }), 403);
    expect(denied.details).toMatchObject({ permission: "bot.manage" });
    await fails(riley.request("PATCH", `/api/v1/agents/${personaId}`, { unitId: frontend }), 403);
    // Within his subtree Riley may move it (Backend → Payments → Backend).
    expect(
      (await ok(riley.request("PATCH", `/api/v1/agents/${personaId}`, { unitId: payments }))).unit,
    ).toMatchObject({ id: payments, kind: "project" });
    expect(
      (await ok(riley.request("PATCH", `/api/v1/agents/${personaId}`, { unitId: backend }))).unitId,
    ).toBe(backend);
    const moved = await ok(admin.request("PATCH", `/api/v1/agents/${personaId}`, { unitId: null }));
    expect(moved).toMatchObject({ unitId: null, unit: null });
    expect(await usernamesOf(jo)).toContain("deploy-helper");
    // Back into Backend: Jo loses it again, and her client is told (agent.deleted on her user topic).
    await ok(admin.request("PATCH", `/api/v1/agents/${personaId}`, { unitId: backend }));
    expect(await usernamesOf(jo)).not.toContain("deploy-helper");
    expect(await eventsOn(`user:${joId}`, "agent.deleted", personaId)).toHaveLength(1);
    const audit = await su.query(
      "select metadata from app.audit_events where action = 'agent.updated' and resource_id = $1 order by occurred_at desc limit 1",
      [personaId],
    );
    expect(audit.rows[0].metadata).toMatchObject({
      unitId: backend,
      changed: expect.arrayContaining(["unitId"]),
    });
  });
});

describe("mentions follow visibility", () => {
  it("Jo's @deploy-helper in #ops is not delivered (and does not add it); Alex's is", async () => {
    const joMsg = await ok(
      jo.request("POST", `/api/v1/conversations/${opsId}/messages`, { body: "@deploy-helper status?" }),
    );
    expect(await mentionsOf(joMsg.id)).toEqual([]);
    const members = await su.query(
      "select count(*)::int as n from app.conversation_members where conversation_id = $1 and member_id = $2",
      [opsId, personaId],
    );
    expect(members.rows[0].n).toBe(0);
    const alexMsg = await ok(
      alex.request("POST", `/api/v1/conversations/${opsId}/messages`, { body: "@deploy-helper status?" }),
    );
    const delivered = await mentionsOf(alexMsg.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.agent.id).toBe(personaId);
    // Now a member of #ops, it still answers only those who may see it.
    const again = await ok(
      jo.request("POST", `/api/v1/conversations/${opsId}/messages`, { body: "@deploy-helper hi" }),
    );
    expect(await mentionsOf(again.id)).toEqual([]);
  });

  it("Jo cannot add it to a channel she owns (404)", async () => {
    const mine = (await ok(jo.request("POST", "/api/v1/channels", { name: "jo-room", visibility: "public" })))
      .id;
    await fails(
      jo.request("POST", `/api/v1/channels/${mine}/members`, { kind: "agent", id: personaId }),
      404,
    );
  });
});

describe("unit deletion and personal bots", () => {
  it("deleting Backend while it has a persona → 409 unit_has_bots", async () => {
    const tmp = await unit("team", "Tmp", eng);
    const p = await ok(
      admin.request("POST", "/api/v1/agents", persona({ name: "Tmp bot", username: "tmp-bot", unitId: tmp })),
    );
    expect((await fails(admin.request("DELETE", `/api/v1/units/${tmp}`), 409)).code).toBe("unit_has_bots");
    // A deleted persona no longer blocks it (its unit reference is released).
    await ok(admin.request("DELETE", `/api/v1/agents/${p.id}`));
    await ok(admin.request("DELETE", `/api/v1/units/${tmp}`));
    const payKids = await su.query("select count(*)::int as n from app.org_units where id = $1", [tmp]);
    expect(payKids.rows[0].n).toBe(0);
  });

  it("personal bots stay owner-only and never take a unit (400 personal_bot_unit)", async () => {
    const mine = await ok(alex.request("POST", "/api/v1/agents/personal", {}));
    const id = mine.agent.id as string;
    expect(mine.agent).toMatchObject({ scope: "personal", unitId: null });
    expect((await fails(alex.request("PATCH", `/api/v1/agents/${id}`, { unitId: backend }), 400)).code).toBe(
      "personal_bot_unit",
    );
    expect(await usernamesOf(admin)).not.toContain(mine.agent.username);
    expect(await usernamesOf(riley)).not.toContain(mine.agent.username);
  });
});

describe("ownership (Task 2)", () => {
  it("Riley reassigns the owner to Alex; agent.updated carries unitId and ownerUserId", async () => {
    const r = await ok(riley.request("PATCH", `/api/v1/agents/${personaId}`, { ownerUserId: alexId }));
    expect(r).toMatchObject({ ownerUserId: alexId, unitId: backend });
    const events = await eventsOn(`user:${alexId}`, "agent.updated", personaId);
    expect(events.at(-1)).toMatchObject({
      ownerUserId: alexId,
      unitId: backend,
      unit: { id: backend, name: "Backend", kind: "team" },
    });
    // An owner outside the organization (or inactive) is refused.
    await fails(riley.request("PATCH", `/api/v1/agents/${personaId}`, { ownerUserId: randomUUID() }), 404);
  });

  it("a deactivated owner leaves the persona working for others; the admin reassigns it", async () => {
    const org = await ok(
      admin.request(
        "POST",
        "/api/v1/agents",
        persona({ name: "Owned", username: "owned", unitId: backend, ownerUserId: samId }),
      ),
    );
    await su.query("update app.org_members set deactivated_at = now() where user_id = $1", [samId]);
    try {
      expect(await usernamesOf(alex)).toContain("owned");
      const msg = await ok(
        alex.request("POST", `/api/v1/conversations/${opsId}/messages`, { body: "@owned ping" }),
      );
      expect(await mentionsOf(msg.id)).toHaveLength(1);
      await fails(admin.request("PATCH", `/api/v1/agents/${org.id}`, { ownerUserId: samId }), 404);
      const re = await ok(admin.request("PATCH", `/api/v1/agents/${org.id}`, { ownerUserId: rileyId }));
      expect(re.ownerUserId).toBe(rileyId);
    } finally {
      await su.query("update app.org_members set deactivated_at = null where user_id = $1", [samId]);
    }
  });
});
