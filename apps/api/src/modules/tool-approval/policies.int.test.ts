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
