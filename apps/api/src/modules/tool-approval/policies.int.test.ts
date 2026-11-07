import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * Approval policies (Phase 07.5-03, APPROVE-01, D-01, P-03, P-04, UI-SPEC R4/R5): the management routes on a real
 * PostgreSQL + Redis stack. Organization A: Víctor (admin), Marta (lead of Sales), Sam (Sales member), Dana (Marketing
 * member). Organization B: Eve (admin). One org MCP server "Acme CRM" with a writing and a read-only tool, one
 * per-member connector, one approved plugin tool.
 */

const CELL_TOKEN = "ocw-test-cell-token-tool-approval-0123456789abcdef";
/** Safe names (`m` + 8 hex) of the seeded servers. */
const CRM = "m1a2b3c4d";
const CONN = "m5e6f7a8b";
const CREATE = `${CRM}__create_invoice`;
const LIST = `${CRM}__list_invoices`;
const ALL_CRM = `${CRM}__*`;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Json | null };

async function ok(res: Promise<Res>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function fails(res: Promise<Res>, status: number, code?: string): Promise<Json> {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  if (code) expect(r.body?.error?.code, JSON.stringify(r.body)).toBe(code);
  return (r.body ?? {}) as Json;
}

let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let sam: TestClient;
let marta: TestClient;
let dana: TestClient;
let eve: TestClient;
let orgA: string;
let orgB: string;
let victorId: string;
let samId: string;
let martaId: string;
let danaId: string;
let sales: string;
let salesEast: string;
let marketing: string;
let crmId: string;
let connId: string;
let botId: string;
let eastBotId: string;

async function joinAs(email: string, name: string, role: string): Promise<readonly [TestClient, string]> {
  const inv = await ok(victor.request("POST", "/api/v1/invitations", { email, role }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

const unit = async (kind: string, name: string, parentId: string | null) =>
  (await ok(victor.request("POST", "/api/v1/units", { kind, name, parentId }))).id as string;

const audits = async (org: string, actions: string[]) =>
  (
    await su.query(
      "select user_id, resource_type, resource_id, action, metadata from app.audit_events where organization_id = $1 and action = any($2) order by occurred_at, id",
      [org, actions],
    )
  ).rows as Json[];

const POLICY_ACTIONS = [
  "tool_approval_policy.created",
  "tool_approval_policy.updated",
  "tool_approval_policy.deleted",
];

const clearPolicies = async () => {
  await su.query("delete from app.tool_approval_policies");
};

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
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
  orgA = setup.organization.id;
  victorId = setup.user.id;
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee", "standard");
  [marta, martaId] = await joinAs("marta@example.test", "Marta Gil", "lead");
  [dana, danaId] = await joinAs("dana@example.test", "Dana Cole", "standard");
  [eve] = await joinAs("eve@example.test", "Eve Black", "standard");

  sales = await unit("department", "Sales", null);
  salesEast = await unit("team", "Sales East", sales);
  marketing = await unit("department", "Marketing", null);
  await ok(victor.request("POST", `/api/v1/units/${sales}/members`, { userId: martaId, role: "lead" }));
  await ok(victor.request("POST", `/api/v1/units/${sales}/members`, { userId: samId }));
  await ok(victor.request("POST", `/api/v1/units/${marketing}/members`, { userId: danaId }));

  // Org B: Eve moves into her own organization as its admin.
  orgB = randomUUID();
  const eveId = (await su.query("select id from auth.user where email = 'eve@example.test'")).rows[0].id;
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    orgB,
    `evil-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [eveId]);
  await su.query("delete from app.org_members where user_id = $1", [eveId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    eveId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, eveId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, eveId]);

  // The catalog: an org MCP server, a per-member connector and one approved plugin, plus web tools that must never
  // be offered.
  crmId = randomUUID();
  connId = randomUUID();
  for (const [id, name, safe, mode] of [
    [crmId, "Acme CRM", CRM, "org_secret"],
    [connId, "Linear", CONN, "per_member_oauth"],
  ] as const) {
    await su.query(
      `insert into app.mcp_servers (id, organization_id, name, safe_name, transport, url, status, auth_mode)
       values ($1, $2, $3, $4, 'streamable-http', $5, 'ready', $6)`,
      [id, orgA, name, safe, `https://${safe}.example.test/mcp`, mode],
    );
  }
  for (const [server, name, safe, readOnly] of [
    [crmId, "create_invoice", CRM, false],
    [crmId, "list_invoices", CRM, true],
    [connId, "create_issue", CONN, false],
  ] as const) {
    await su.query(
      `insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only)
       values ($1, $2, $3, $4, $5)`,
      [orgA, server, name, `${safe}__${name}`, readOnly],
    );
  }
  const pluginId = randomUUID();
  await su.query(
    `insert into app.cell_plugins (id, organization_id, package_name, version, channel, artifact_sha256, risk, status)
     values ($1, $2, '@acme/weather', '1.0.0', 'official', $3, 'low', 'installed')`,
    [pluginId, orgA, "a".repeat(64)],
  );
  for (const name of ["weather_lookup", "web_fetch", "ocw_memory_save"]) {
    await su.query(
      `insert into app.cell_plugin_tools (organization_id, plugin_row_id, name, side_effecting) values ($1, $2, $3, $4)`,
      [orgA, pluginId, name, name !== "weather_lookup"],
    );
  }

  // An organization bot (no unit) for the per-turn modes.
  botId = randomUUID();
  await su.query(
    `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status)
     values ($1, $2, 'Scout', 'scout', 'You help.', 'mock', 'mock-1', 'ready')`,
    [botId, orgA],
  );
  // A Sales East bot: Sales rules reach it whoever asks.
  eastBotId = randomUUID();
  await su.query(
    `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status, unit_id)
     values ($1, $2, 'Closer', 'closer', 'You help.', 'mock', 'mock-1', 'ready', $3)`,
    [eastBotId, orgA, salesEast],
  );
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("tracer: an admin asks before every Acme CRM tool and reads it back with the catalog", () => {
  it("POST creates the rule (version 1) and audits it with ids, pattern, mode and approvers only", async () => {
    await clearPolicies();
    const created = await ok(
      victor.request("POST", "/api/v1/tool-approval-policies", {
        scopeUnitId: null,
        toolPattern: ALL_CRM,
        mode: "always",
        approverKind: "admins",
      }),
      201,
    );
    expect(created).toMatchObject({
      scopeUnitId: null,
      toolPattern: ALL_CRM,
      mode: "always",
      approverKind: "admins",
      approverUserIds: [],
      version: 1,
      updatedBy: { id: victorId, displayName: "Víctor Ruiz" },
    });
    const rows = await audits(orgA, POLICY_ACTIONS);
    expect(rows).toEqual([
      {
        user_id: victorId,
        resource_type: "tool_approval_policy",
        resource_id: created.id,
        action: "tool_approval_policy.created",
        metadata: {
          policyId: created.id,
          scopeUnitId: null,
          toolPattern: ALL_CRM,
          mode: "always",
          approverKind: "admins",
          approverUserIds: [],
        },
      },
    ]);

    const page = await ok(victor.request("GET", "/api/v1/tool-approval-policies?scope=org"));
    expect(page.scope).toEqual({ unitId: null, label: "Organization" });
    expect(page.policies.map((p: Json) => p.id)).toEqual([created.id]);
    expect(page.inherited).toEqual([]);
    expect(page.approverLabels).toEqual({ [created.id]: "Admins" });

    const crm = page.catalog.find((g: Json) => g.source.kind === "mcp" && g.source.name === "Acme CRM");
    expect(crm).toEqual({
      source: { kind: "mcp", id: crmId, name: "Acme CRM", safeName: CRM },
      tools: [
        { name: CREATE, sideEffecting: true },
        { name: LIST, sideEffecting: false },
      ],
    });
    const connector = page.catalog.find((g: Json) => g.source.kind === "connector");
    expect(connector).toEqual({
      source: { kind: "connector", id: connId, name: "Linear", safeName: CONN },
      tools: [{ name: `${CONN}__create_issue`, sideEffecting: true }],
    });
    const plugin = page.catalog.find((g: Json) => g.source.kind === "plugin");
    expect(plugin.tools).toEqual([{ name: "weather_lookup", sideEffecting: false }]);
    const http = page.catalog.find((g: Json) => g.source.kind === "http");
    expect(http.tools).toEqual([{ name: "ocw_http_request", sideEffecting: true }]);
    const names = page.catalog.flatMap((g: Json) => g.tools.map((t: Json) => t.name));
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("web_fetch");
    expect(names.filter((n: string) => n.toLowerCase().startsWith("ocw_"))).toEqual(["ocw_http_request"]);
  });

  it("the access probe tells an admin everything and a standard member nothing", async () => {
    const all = (
      await su.query("select id from app.org_units where organization_id = $1 order by id", [orgA])
    ).rows
      .map((r) => r.id)
      .sort();
    const v = await ok(victor.request("GET", "/api/v1/tool-approval-policies/access"));
    expect(v.manageable.organization).toBe(true);
    expect([...v.manageable.unitIds].sort()).toEqual(all);
    for (const member of [sam, dana]) {
      expect(await ok(member.request("GET", "/api/v1/tool-approval-policies/access"))).toEqual({
        manageable: { organization: false, unitIds: [] },
      });
    }
    // A lead manages the units they lead and their subtrees, never the organization.
    const m = await ok(marta.request("GET", "/api/v1/tool-approval-policies/access"));
    expect(m.manageable.organization).toBe(false);
    expect([...m.manageable.unitIds].sort()).toEqual([sales, salesEast].sort());
    // Organization B's admin manages organization B, which has no units: none of organization A's ids.
    expect(await ok(eve.request("GET", "/api/v1/tool-approval-policies/access"))).toEqual({
      manageable: { organization: true, unitIds: [] },
    });
  });

  it("a standard member can neither read nor change the organization's rules; a cell token is refused", async () => {
    await fails(sam.request("GET", "/api/v1/tool-approval-policies?scope=org"), 403);
    await fails(
      sam.request("POST", "/api/v1/tool-approval-policies", {
        scopeUnitId: null,
        toolPattern: CREATE,
        mode: "always",
        approverKind: "requester",
      }),
      403,
    );
    const asCell = { noCookies: true, headers: { authorization: `Bearer ${CELL_TOKEN}` } };
    const anon = new TestClient(stack.baseUrl);
    for (const [method, path, body] of [
      ["GET", "/api/v1/tool-approval-policies/access", undefined],
      ["GET", "/api/v1/tool-approval-policies?scope=org", undefined],
      [
        "POST",
        "/api/v1/tool-approval-policies",
        { scopeUnitId: null, toolPattern: CREATE, mode: "always", approverKind: "requester" },
      ],
    ] as const) {
      expect((await anon.request(method, path, body, asCell)).status).toBe(401);
    }
    expect((await audits(orgA, POLICY_ACTIONS)).length).toBe(1);
  });
});

describe("per-turn approval modes (D-01, D-04)", () => {
  const modes = (agentId: string, userId: string, tools: string[]) =>
    stack.built.core.db.withTenant({ organizationId: orgA }, (tx) =>
      stack.built.toolApprovals.approvalModesFor(tx, { agentId, userId }, tools),
    );
  const TOOLS = [CREATE, LIST, "ocw_http_request", "web_fetch"];

  it("an organization rule over the server covers both tools; web tools are skipped even with a stray rule", async () => {
    await clearPolicies();
    await ok(
      victor.request("POST", "/api/v1/tool-approval-policies", {
        scopeUnitId: null,
        toolPattern: ALL_CRM,
        mode: "always",
        approverKind: "admins",
      }),
      201,
    );
    // A rule the contract would refuse, written straight into the database: it never applies and is never shown.
    await su.query(
      `insert into app.tool_approval_policies (organization_id, tool_pattern, mode, approver_kind) values ($1, 'web_fetch', 'always', 'requester')`,
      [orgA],
    );
    expect(Object.fromEntries(await modes(botId, samId, TOOLS))).toEqual({
      [CREATE]: "always",
      [LIST]: "always",
    });
    const page = await ok(victor.request("GET", "/api/v1/tool-approval-policies?scope=org"));
    expect(page.policies.map((p: Json) => p.toolPattern)).toEqual([ALL_CRM]);
    await su.query("delete from app.tool_approval_policies where tool_pattern = 'web_fetch'");
  });

  it("a Sales `when_tainted` rule reaches Sam (Sales), not Dana (Marketing), unless the bot itself is under Sales", async () => {
    await ok(
      victor.request("POST", "/api/v1/tool-approval-policies", {
        scopeUnitId: sales,
        toolPattern: "ocw_http_request",
        mode: "when_tainted",
        approverKind: "unit_leads",
      }),
      201,
    );
    expect((await modes(botId, samId, TOOLS)).get("ocw_http_request")).toBe("when_tainted");
    expect((await modes(botId, danaId, TOOLS)).has("ocw_http_request")).toBe(false);
    expect((await modes(eastBotId, danaId, TOOLS)).get("ocw_http_request")).toBe("when_tainted");

    const resolved = await stack.built.core.db.withTenant({ organizationId: orgA }, (tx) =>
      stack.built.toolApprovals.resolveFor(tx, { agentId: botId, userId: samId }, "ocw_http_request"),
    );
    expect(resolved).toMatchObject({ mode: "when_tainted", approverKind: "unit_leads", scopeUnitId: sales });
    if (!resolved) throw new Error("no rule resolved");
    const label = await stack.built.core.db.withTenant({ organizationId: orgA }, (tx) =>
      stack.built.toolApprovals.approverLabel(tx, resolved),
    );
    expect(label).toBe("Leads of Sales");
  });
});

const create = (as: TestClient, body: Json) => as.request("POST", "/api/v1/tool-approval-policies", body);
const orgRule = (toolPattern: string, mode: string, approverKind = "admins", extra: Json = {}) => ({
  scopeUnitId: null,
  toolPattern,
  mode,
  approverKind,
  ...extra,
});
const unitRule = (unitId: string, toolPattern: string, mode: string, approverKind = "unit_leads") => ({
  scopeUnitId: unitId,
  toolPattern,
  mode,
  approverKind,
});

describe("leads manage the units they lead, under the organization's rules", () => {
  it("Marta reads Sales with the inherited rules, adds a stricter Sales rule, and is refused everywhere else", async () => {
    await clearPolicies();
    const org = await ok(create(victor, orgRule(ALL_CRM, "when_tainted")), 201);
    const mine = await ok(create(marta, unitRule(sales, CREATE, "always")), 201);
    expect(mine).toMatchObject({
      scopeUnitId: sales,
      mode: "always",
      approverKind: "unit_leads",
      version: 1,
    });

    const page = await ok(marta.request("GET", `/api/v1/tool-approval-policies?scope=${sales}`));
    expect(page.scope).toEqual({ unitId: sales, label: "Sales" });
    expect(page.policies.map((p: Json) => p.id)).toEqual([mine.id]);
    expect(page.inherited).toEqual([{ ...org, scopeLabel: "Organization" }]);
    expect(page.approverLabels).toEqual({ [mine.id]: "Leads of Sales", [org.id]: "Admins" });

    // The team below Sales inherits both, each labelled with its scope.
    const east = await ok(marta.request("GET", `/api/v1/tool-approval-policies?scope=${salesEast}`));
    expect(east.policies).toEqual([]);
    expect(east.inherited.map((p: Json) => [p.id, p.scopeLabel]).sort()).toEqual(
      [
        [org.id, "Organization"],
        [mine.id, "Sales"],
      ].sort(),
    );

    await fails(create(marta, unitRule(marketing, CREATE, "always")), 403);
    await fails(create(marta, orgRule(LIST, "always")), 403);
    await fails(marta.request("GET", "/api/v1/tool-approval-policies?scope=org"), 403);
    await fails(marta.request("GET", `/api/v1/tool-approval-policies?scope=${marketing}`), 403);
    await fails(
      marta.request("PATCH", `/api/v1/tool-approval-policies/${org.id}`, {
        expectedVersion: 1,
        mode: "always",
      }),
      403,
    );
    await fails(marta.request("DELETE", `/api/v1/tool-approval-policies/${org.id}?expectedVersion=1`), 403);
    // Nothing a refused call tried was stored.
    expect((await su.query("select count(*)::int as n from app.tool_approval_policies")).rows[0].n).toBe(2);
  });

  it("a unit rule weaker than an inherited one is refused (create and update); a stricter one is accepted", async () => {
    await clearPolicies();
    await ok(create(victor, orgRule(ALL_CRM, "always")), 201);
    await fails(create(marta, unitRule(sales, CREATE, "when_tainted")), 409, "policy_weaker_than_inherited");
    await fails(
      create(marta, unitRule(sales, CREATE, "never", "requester")),
      409,
      "policy_weaker_than_inherited",
    );
    await fails(
      create(victor, unitRule(sales, ALL_CRM, "when_tainted")),
      409,
      "policy_weaker_than_inherited",
    );

    await clearPolicies();
    await ok(create(victor, orgRule(ALL_CRM, "when_tainted")), 201);
    const tight = await ok(create(marta, unitRule(sales, CREATE, "always")), 201);
    // A team below Sales cannot undercut Sales either.
    await fails(
      create(marta, unitRule(salesEast, CREATE, "when_tainted")),
      409,
      "policy_weaker_than_inherited",
    );
    // Updating the Sales rule below the organization's mode is refused the same way, and nothing changes.
    await fails(
      marta.request("PATCH", `/api/v1/tool-approval-policies/${tight.id}`, {
        expectedVersion: 1,
        mode: "never",
      }),
      409,
      "policy_weaker_than_inherited",
    );
    const kept = (
      await su.query("select mode, version from app.tool_approval_policies where id = $1", [tight.id])
    ).rows[0];
    expect(kept).toEqual({ mode: "always", version: 1 });
    // Equal to the inherited mode is not weaker.
    await ok(
      marta.request("PATCH", `/api/v1/tool-approval-policies/${tight.id}`, {
        expectedVersion: 1,
        mode: "when_tainted",
      }),
    );
  });
});

describe("rule errors map to 4xx, never a 500", () => {
  it("duplicates, non-approvable tools, bad patterns and wrong approvers", async () => {
    await clearPolicies();
    await ok(create(victor, orgRule(CREATE, "always")), 201);
    await fails(create(victor, orgRule(CREATE, "when_tainted")), 409, "policy_exists");
    await fails(create(victor, orgRule("web_fetch", "always")), 400, "tool_not_approvable");
    await fails(create(victor, orgRule("web_search", "always")), 400, "tool_not_approvable");
    await fails(create(victor, orgRule("ocw_memory_save", "always")), 400, "tool_not_approvable");
    await fails(create(victor, orgRule("m1a2b3c4d*", "always")), 400, "invalid_tool_pattern");
    await fails(create(victor, orgRule("crm tools", "always")), 400, "invalid_tool_pattern");
    // Unit leads need a unit; a never rule asks nobody.
    await fails(create(victor, orgRule(LIST, "always", "unit_leads")), 400);
    await fails(create(victor, orgRule(LIST, "never", "admins")), 400);
    // Named approvers are members of this organization: never a bot, a stranger or another organization's person.
    const eveId = (await su.query("select id from auth.user where email = 'eve@example.test'")).rows[0].id;
    for (const outsider of [botId, randomUUID(), eveId]) {
      await fails(
        create(victor, orgRule(LIST, "always", "users", { approverUserIds: [martaId, outsider] })),
        400,
        "approver_not_member",
      );
    }
    const named = await ok(
      create(victor, orgRule(LIST, "always", "users", { approverUserIds: [martaId, danaId] })),
      201,
    );
    const page = await ok(victor.request("GET", "/api/v1/tool-approval-policies?scope=org"));
    expect(page.approverLabels[named.id]).toBe("Marta Gil or 1 other");
    // An unknown rule id is not found.
    await fails(
      victor.request("PATCH", `/api/v1/tool-approval-policies/${randomUUID()}`, {
        expectedVersion: 1,
        mode: "always",
      }),
      404,
    );
    await fails(
      victor.request("DELETE", `/api/v1/tool-approval-policies/${randomUUID()}?expectedVersion=1`),
      404,
    );
  });

  it("a stale version is a 409 carrying the current rule; delete with the current version is audited", async () => {
    await clearPolicies();
    const rule = await ok(create(victor, orgRule(LIST, "always")), 201);
    const v2 = await ok(
      victor.request("PATCH", `/api/v1/tool-approval-policies/${rule.id}`, {
        expectedVersion: 1,
        approverKind: "users",
        approverUserIds: [martaId],
      }),
    );
    expect(v2).toMatchObject({
      version: 2,
      approverKind: "users",
      approverUserIds: [martaId],
      mode: "always",
    });
    const stale = await fails(
      victor.request("PATCH", `/api/v1/tool-approval-policies/${rule.id}`, {
        expectedVersion: 1,
        mode: "when_tainted",
      }),
      409,
      "policy_version_conflict",
    );
    expect(stale.error.details.policy).toMatchObject({ id: rule.id, version: 2, mode: "always" });
    await fails(
      victor.request("DELETE", `/api/v1/tool-approval-policies/${rule.id}?expectedVersion=1`),
      409,
      "policy_version_conflict",
    );
    const del = await victor.request("DELETE", `/api/v1/tool-approval-policies/${rule.id}?expectedVersion=2`);
    expect(del.status).toBe(204);
    const rows = await audits(orgA, POLICY_ACTIONS);
    const mine = rows.filter((r) => r.resource_id === rule.id);
    expect(mine.map((r) => r.action)).toEqual([
      "tool_approval_policy.created",
      "tool_approval_policy.updated",
      "tool_approval_policy.deleted",
    ]);
    expect(mine[1]?.metadata).toEqual({
      policyId: rule.id,
      scopeUnitId: null,
      toolPattern: LIST,
      mode: "always",
      approverKind: "users",
      approverUserIds: [martaId],
    });
    expect(mine[2]?.metadata).toEqual(mine[1]?.metadata);
  });
});

describe("change history per scope (UI-SPEC R5)", () => {
  it("lists created, updated and deleted newest first with actors and labels, 30 per page", async () => {
    await clearPolicies();
    const rule = await ok(create(victor, orgRule(CREATE, "always")), 201);
    await ok(
      victor.request("PATCH", `/api/v1/tool-approval-policies/${rule.id}`, {
        expectedVersion: 1,
        mode: "when_tainted",
      }),
    );
    expect(
      (await victor.request("DELETE", `/api/v1/tool-approval-policies/${rule.id}?expectedVersion=2`)).status,
    ).toBe(204);
    const first = await ok(victor.request("GET", "/api/v1/tool-approval-policies/history?scope=org"));
    expect(first.items.slice(0, 3)).toEqual([
      {
        id: expect.any(String),
        at: expect.any(String),
        actor: { id: victorId, displayName: "Víctor Ruiz" },
        action: "deleted",
        toolPattern: CREATE,
        mode: null,
        approverLabel: null,
      },
      {
        id: expect.any(String),
        at: expect.any(String),
        actor: { id: victorId, displayName: "Víctor Ruiz" },
        action: "updated",
        toolPattern: CREATE,
        mode: "when_tainted",
        approverLabel: "Admins",
      },
      {
        id: expect.any(String),
        at: expect.any(String),
        actor: { id: victorId, displayName: "Víctor Ruiz" },
        action: "created",
        toolPattern: CREATE,
        mode: "always",
        approverLabel: "Admins",
      },
    ]);

    // Enough changes for two pages: every organization change of the file so far plus these.
    for (let i = 0; i < 31; i++) await ok(create(victor, orgRule(`plugin_tool_${i}`, "always")), 201);
    const total = (
      await su.query(
        `select count(*)::int as n from app.audit_events where organization_id = $1 and action = any($2)
           and metadata->'scopeUnitId' = 'null'::jsonb`,
        [orgA, POLICY_ACTIONS],
      )
    ).rows[0].n as number;
    const p1 = await ok(victor.request("GET", "/api/v1/tool-approval-policies/history?scope=org"));
    expect(p1.items).toHaveLength(30);
    expect(p1.items[0]).toMatchObject({ action: "created", toolPattern: "plugin_tool_30" });
    expect(typeof p1.nextCursor).toBe("string");
    const seen = new Set<string>(p1.items.map((x: Json) => x.id));
    let cursor: string | null = p1.nextCursor;
    while (cursor) {
      const page = await ok(
        victor.request(
          "GET",
          `/api/v1/tool-approval-policies/history?scope=org&cursor=${encodeURIComponent(cursor)}`,
        ),
      );
      for (const x of page.items) {
        expect(seen.has(x.id)).toBe(false);
        seen.add(x.id);
      }
      cursor = page.nextCursor;
    }
    expect(seen.size).toBe(total);
    await fails(
      victor.request("GET", "/api/v1/tool-approval-policies/history?scope=org&cursor=not-a-cursor"),
      400,
    );
  });

  it("each scope has its own history: Marta reads Sales, not the organization; Sam reads neither", async () => {
    await clearPolicies();
    await ok(create(marta, unitRule(sales, LIST, "always")), 201);
    const h = await ok(marta.request("GET", `/api/v1/tool-approval-policies/history?scope=${sales}`));
    expect(h.items[0]).toMatchObject({
      action: "created",
      toolPattern: LIST,
      mode: "always",
      approverLabel: "Leads of Sales",
      actor: { id: martaId, displayName: "Marta Gil" },
    });
    expect(h.items.every((x: Json) => x.toolPattern !== `plugin_tool_0`)).toBe(true);
    await fails(marta.request("GET", "/api/v1/tool-approval-policies/history?scope=org"), 403);
    await fails(sam.request("GET", "/api/v1/tool-approval-policies/history?scope=org"), 403);
    await fails(sam.request("GET", `/api/v1/tool-approval-policies/history?scope=${sales}`), 403);
  });
});

describe("organization B never sees or changes organization A's rules (C-02)", () => {
  it("every route of the family has an org-B case, and org A's rules and audit are unchanged", async () => {
    await clearPolicies();
    const aOrg = await ok(create(victor, orgRule(ALL_CRM, "always")), 201);
    const aSales = await ok(create(marta, unitRule(sales, CREATE, "always")), 201);
    const snapshot = async () =>
      JSON.stringify([
        (
          await su.query("select * from app.tool_approval_policies where organization_id = $1 order by id", [
            orgA,
          ])
        ).rows,
        (
          await su.query(
            "select id from app.audit_events where organization_id = $1 and action like 'tool_approval_policy.%' order by id",
            [orgA],
          )
        ).rows,
      ]);
    const before = await snapshot();
    const A_WORDS = ["Acme CRM", "Linear", "Sales", CRM, CONN, aOrg.id, aSales.id];
    const clean = (body: unknown) => {
      const text = JSON.stringify(body);
      for (const w of A_WORDS) expect(text, w).not.toContain(w);
    };

    const cases: Record<string, () => Promise<void>> = {
      "GET /api/v1/tool-approval-policies/access": async () => {
        clean(await ok(eve.request("GET", "/api/v1/tool-approval-policies/access")));
      },
      "GET /api/v1/tool-approval-policies": async () => {
        const page = await ok(eve.request("GET", "/api/v1/tool-approval-policies?scope=org"));
        expect(page.policies).toEqual([]);
        expect(page.catalog.map((g: Json) => g.source.kind)).toEqual(["http"]);
        clean(page);
        await fails(eve.request("GET", `/api/v1/tool-approval-policies?scope=${sales}`), 404);
      },
      "POST /api/v1/tool-approval-policies": async () => {
        await fails(create(eve, unitRule(sales, LIST, "always", "admins")), 404);
      },
      "PATCH /api/v1/tool-approval-policies/:p": async () => {
        for (const id of [aOrg.id, aSales.id]) {
          await fails(
            eve.request("PATCH", `/api/v1/tool-approval-policies/${id}`, {
              expectedVersion: 1,
              mode: "never",
            }),
            404,
          );
        }
      },
      "DELETE /api/v1/tool-approval-policies/:p": async () => {
        for (const id of [aOrg.id, aSales.id]) {
          await fails(eve.request("DELETE", `/api/v1/tool-approval-policies/${id}?expectedVersion=1`), 404);
        }
      },
      "GET /api/v1/tool-approval-policies/history": async () => {
        const h = await ok(eve.request("GET", "/api/v1/tool-approval-policies/history?scope=org"));
        expect(h).toEqual({ items: [], nextCursor: null });
        await fails(eve.request("GET", `/api/v1/tool-approval-policies/history?scope=${sales}`), 404);
      },
    };
    const owned = (k: string) => (k.split(" ")[1] ?? "").startsWith("/api/v1/tool-approval-policies");
    const routeKey = (k: string) => k.replace(/:[A-Za-z]+/gu, ":p");
    const registered = [...stack.built.authz.routes.keys()].filter(owned).map(routeKey).sort();
    expect(registered).toEqual(Object.keys(cases).sort());
    for (const [k, mode] of stack.built.authz.routes) if (owned(k)) expect(mode, k).toBe("user");
    for (const run of Object.values(cases)) await run();
    expect(await snapshot()).toBe(before);
    // Organization B's own rule stays in organization B.
    const bRule = await ok(create(eve, orgRule("weather_lookup", "always")), 201);
    expect(
      (await su.query("select organization_id from app.tool_approval_policies where id = $1", [bRule.id]))
        .rows[0],
    ).toEqual({ organization_id: orgB });
    const aPage = await ok(victor.request("GET", "/api/v1/tool-approval-policies?scope=org"));
    expect(aPage.policies.map((p: Json) => p.id)).toEqual([aOrg.id]);
  });
});

describe("the approvable groups by the server's mode (07.14 D-04, PD-09)", () => {
  it("organization-account servers are listed under mcp, member connectors under connector", async () => {
    const extra = [
      [randomUUID(), "Org Drive", "m0a0b0c01", "org_oauth"],
      [randomUUID(), "Org Billing", "m0a0b0c02", "org_client_credentials"],
    ] as const;
    try {
      for (const [id, name, safe, mode] of extra) {
        await su.query(
          `insert into app.mcp_servers (id, organization_id, name, safe_name, transport, url, status, auth_mode)
           values ($1, $2, $3, $4, 'streamable-http', $5, 'ready', $6)`,
          [id, orgA, name, safe, `https://${safe}.example.test/mcp`, mode],
        );
        await su.query(
          `insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only)
           values ($1, $2, 'sync', $3, false)`,
          [orgA, id, `${safe}__sync`],
        );
      }
      const page = await ok(victor.request("GET", "/api/v1/tool-approval-policies?scope=org"));
      const kindOf = (name: string) => page.catalog.find((g: Json) => g.source.name === name)?.source.kind;
      expect(kindOf("Org Drive")).toBe("mcp");
      expect(kindOf("Org Billing")).toBe("mcp");
      expect(kindOf("Acme CRM")).toBe("mcp");
      expect(kindOf("Linear")).toBe("connector");
      for (const [id, name, safe] of extra) {
        expect(page.catalog.find((g: Json) => g.source.id === id)).toEqual({
          source: { kind: "mcp", id, name, safeName: safe },
          tools: [{ name: `${safe}__sync`, sideEffecting: true }],
        });
      }
    } finally {
      await su.query("delete from app.mcp_servers where id = any($1)", [extra.map(([id]) => id)]);
    }
  });
});
