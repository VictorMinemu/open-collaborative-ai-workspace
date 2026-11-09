import { randomUUID } from "node:crypto";
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

// ---------------------------------------------------------------- Task 2: rules (07.4-08)

const SAFE_ADMIN = "m0a1b2c3d";
const SAFE_ERP = "m1b2c3d4e";
const SAFE_CRM = "m2c3d4e5f";
const DELETE_RECORD = `${SAFE_ADMIN}__delete_record`;
const READ_INVOICE = `${SAFE_ERP}__read_invoice`;
const CREATE_EXPENSE = `${SAFE_ERP}__create_expense`;
const FILE_REPORT = `${SAFE_ERP}__file_report`;
const KEY_HANDLE = "k_abcdefghij";

let adminMcp: string;
let erp: string;
let crm: string;
let orgSecretMcp: string;
let backendKey: string;
let frontendKey: string;
let orgTemplateId: string;
let frontendTemplateId: string;
let capsTemplateId: string;
let capsBotId: string;
let samOrgBotId: string;
let joOrgBotId: string;

/** A missing template id answers exactly like a hidden one. */
const MISSING = "0199c0de-0000-7000-8000-000000000000";

const personalBotsOf = async (userId: string) =>
  (
    await su.query(
      "select id from app.agents where scope = 'personal' and owner_user_id = $1 and deleted_at is null order by created_at",
      [userId],
    )
  ).rows.map((r) => r.id as string);

const grantsOf = async (agentId: string) =>
  (
    await su.query("select tool_name from app.bot_tool_grants where agent_id = $1 order by tool_name", [
      agentId,
    ])
  ).rows.map((r) => r.tool_name as string);

const vaultGrantsOf = async (agentId: string) =>
  (
    await su.query(
      "select vault_item_id from app.agent_vault_grants where agent_id = $1 order by vault_item_id",
      [agentId],
    )
  ).rows.map((r) => r.vault_item_id as string);

async function mcpServer(
  id: string,
  name: string,
  safe: string,
  extra: { personalAllowed?: boolean; authMode?: string },
) {
  await su.query(
    `insert into app.mcp_servers (id, organization_id, name, safe_name, transport, url, status, personal_allowed, auth_mode,
       member_header_name)
     values ($1, $2, $3, $4, 'streamable-http', 'https://mcp.example.test/mcp', 'ready', $5, $6, $7)`,
    [
      id,
      orgId,
      name,
      safe,
      extra.personalAllowed ?? false,
      extra.authMode ?? "org_secret",
      extra.authMode === "per_member_secret" ? "authorization" : null,
    ],
  );
}

async function mcpTool(serverId: string, openclawName: string) {
  await su.query(
    `insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only)
     values ($1, $2, $3, $4, false)`,
    [orgId, serverId, openclawName.split("__")[1], openclawName],
  );
}

async function vaultKey(id: string, unitId: string, name: string, handle: string) {
  await su.query(
    `insert into app.vault_items (id, organization_id, scope, unit_id, name, handle, kind, injection, allowed_hosts, secret_ref)
     values ($1, $2, 'unit', $3, $4, $5, 'api_key', '{"header":"authorization","scheme":"bearer"}'::jsonb,
       '{api.example.test}', jsonb_build_object('provider', 'db', 'secretId', gen_random_uuid()::text, 'organizationId', $6::text))`,
    [id, orgId, unitId, name, handle, orgId],
  );
}

const grant = (sourceId: string, toolName: string) => ({ sourceKind: "mcp", sourceId, toolName });

describe("Task 2 setup", () => {
  it("seeds tool sources, a per-member connector, unit keys and a second model provider", async () => {
    adminMcp = randomUUID();
    erp = randomUUID();
    crm = randomUUID();
    orgSecretMcp = randomUUID();
    await mcpServer(adminMcp, "Admin MCP", SAFE_ADMIN, { personalAllowed: false });
    await mcpTool(adminMcp, DELETE_RECORD);
    await mcpServer(erp, "ERP", SAFE_ERP, { personalAllowed: true });
    for (const t of [READ_INVOICE, CREATE_EXPENSE, FILE_REPORT]) await mcpTool(erp, t);
    await mcpServer(crm, "Acme CRM", SAFE_CRM, { authMode: "per_member_secret" });
    await mcpServer(orgSecretMcp, "Docs", "m3d4e5f6a", {});
    backendKey = randomUUID();
    frontendKey = randomUUID();
    await vaultKey(backendKey, backend, "ERP service", KEY_HANDLE);
    await vaultKey(frontendKey, frontend, "Frontend CDN", "k_bcdefghijk");
    await ok(
      admin.request("POST", "/api/v1/model-providers", {
        provider: "anthropic",
        apiKey: "sk-ant-test-fake-key-not-real-000000",
        allowedModels: ["claude-sonnet-5-5"],
      }),
    );
  });
});

describe("every template route is a declared user route; no route edits a published version", () => {
  it("lists exactly the template routes, each `authz: user`", () => {
    const routes = stack.built.authz.routes;
    const expected = [
      "GET /api/v1/agent-templates",
      "POST /api/v1/agent-templates",
      "GET /api/v1/agent-templates/options",
      "PATCH /api/v1/agent-templates/:id",
      "POST /api/v1/agent-templates/:id/versions",
      "GET /api/v1/agent-templates/:id/preview",
      "POST /api/v1/agent-templates/:id/instantiate",
    ].sort();
    const templateRoutes = [...routes.keys()].filter((k) => / \/api\/v1\/agent-templates/.test(k)).sort();
    expect(templateRoutes).toEqual(expected);
    for (const k of [
      ...expected,
      "GET /api/v1/agents/:id/template",
      "POST /api/v1/agents/:id/template/apply",
    ]) {
      expect(routes.get(k), k).toBe("user");
    }
  });
});

describe("visibility: the template's unit subtree (org templates: everyone); nobody learns of others", () => {
  it("Jo (Frontend) does not see the Backend template; its preview and start answer like a missing one", async () => {
    const list = await ok(jo.request("GET", "/api/v1/agent-templates"));
    expect(list.templates.map((t: Json) => t.id)).not.toContain(templateId);
    for (const path of ["preview"]) {
      const hidden = await fails(jo.request("GET", `/api/v1/agent-templates/${templateId}/${path}`), 404);
      const missing = await fails(jo.request("GET", `/api/v1/agent-templates/${MISSING}/${path}`), 404);
      expect(hidden).toEqual(missing);
    }
    expect(
      await fails(jo.request("POST", `/api/v1/agent-templates/${templateId}/instantiate`, {}), 404),
    ).toEqual(await fails(jo.request("POST", `/api/v1/agent-templates/${MISSING}/instantiate`, {}), 404));
  });

  it("an organization template is visible to every member; only admins manage it", async () => {
    const t = await ok(
      admin.request("POST", "/api/v1/agent-templates", {
        unitId: null,
        name: "Support triage",
        version: versionBody({ instructions: "You sort new tickets." }),
      }),
      201,
    );
    orgTemplateId = t.id;
    expect(t).toMatchObject({ unitId: null, unitName: null, canManage: true });
    for (const c of [sam, jo, riley]) {
      const list = await ok(c.request("GET", "/api/v1/agent-templates"));
      const found = list.templates.find((x: Json) => x.id === orgTemplateId);
      expect(found).toMatchObject({ canManage: false });
    }
  });

  it("manageableUnits: the lead gets the units he leads; an admin the organization and every unit", async () => {
    expect((await ok(riley.request("GET", "/api/v1/agent-templates"))).manageableUnits).toEqual([
      { unitId: backend, name: "Backend" },
    ]);
    const mine = (await ok(admin.request("GET", "/api/v1/agent-templates"))).manageableUnits as Json[];
    expect(mine[0]).toEqual({ unitId: null, name: "Organization" });
    expect(
      mine
        .map((u) => u.unitId)
        .slice(1)
        .sort(),
    ).toEqual([backend, eng, frontend].sort());
  });
});

describe("visibility is the resolver's (07.4 gap N5): unit.read on the template, unit-audience precondition", () => {
  it("Sam (a Backend member) sees it; a deny on unit.read scoped to Backend for Sam hides it like a missing one", async () => {
    const seen = async () =>
      ((await ok(sam.request("GET", "/api/v1/agent-templates"))).templates as Json[]).map((t) => t.id);
    expect(await seen()).toContain(templateId);
    const rule = await ok(
      admin.request("POST", "/api/v1/permission-rules", {
        scopeUnitId: backend,
        subjectKind: "user",
        subjectId: samId,
        permission: "unit.read",
        effect: "deny",
      }),
    );
    try {
      expect(await seen()).not.toContain(templateId);
      const hidden = await fails(sam.request("GET", `/api/v1/agent-templates/${templateId}/preview`), 404);
      expect(hidden).toEqual(
        await fails(sam.request("GET", `/api/v1/agent-templates/${MISSING}/preview`), 404),
      );
      // The deny is Sam's alone: Jo still sees the organization template.
      expect(
        ((await ok(jo.request("GET", "/api/v1/agent-templates"))).templates as Json[]).map((t) => t.id),
      ).toContain(orgTemplateId);
      // The lead still manages (and so sees) it.
      const riley_ = ((await ok(riley.request("GET", "/api/v1/agent-templates"))).templates as Json[]).map(
        (t) => t.id,
      );
      expect(riley_).toContain(templateId);
    } finally {
      await ok(admin.request("DELETE", `/api/v1/permission-rules/${rule.id}`));
    }
    expect(await seen()).toContain(templateId);
  });
});

describe("management: agent_template.manage on the unit (leads, admins) or the organization (admins)", () => {
  it("a standard member cannot create; the Backend lead cannot create for Frontend or the organization", async () => {
    await fails(
      sam.request("POST", "/api/v1/agent-templates", {
        unitId: backend,
        name: "Nope",
        version: versionBody(),
      }),
      403,
    );
    await fails(
      sam.request("POST", "/api/v1/agent-templates", { unitId: null, name: "Nope", version: versionBody() }),
      403,
    );
    await fails(
      riley.request("POST", "/api/v1/agent-templates", {
        unitId: frontend,
        name: "Nope",
        version: versionBody(),
      }),
      403,
    );
    await fails(
      riley.request("POST", "/api/v1/agent-templates", {
        unitId: null,
        name: "Nope",
        version: versionBody(),
      }),
      403,
    );
  });

  it("the Backend lead cannot touch a Frontend template (hidden); Sam sees the Backend one but cannot manage it", async () => {
    frontendTemplateId = (
      await ok(
        admin.request("POST", "/api/v1/agent-templates", {
          unitId: frontend,
          name: "Frontend helper",
          version: versionBody(),
        }),
        201,
      )
    ).id;
    await fails(
      riley.request("POST", `/api/v1/agent-templates/${frontendTemplateId}/versions`, versionBody()),
      404,
    );
    await fails(
      riley.request("PATCH", `/api/v1/agent-templates/${frontendTemplateId}`, { name: "Mine" }),
      404,
    );
    await fails(sam.request("POST", `/api/v1/agent-templates/${templateId}/versions`, versionBody()), 403);
    await fails(sam.request("PATCH", `/api/v1/agent-templates/${templateId}`, { archived: true }), 403);
  });

  it("refuses a duplicate live name in the same place, and references this tenant does not have", async () => {
    expect(
      (
        await fails(
          riley.request("POST", "/api/v1/agent-templates", {
            unitId: backend,
            name: "Expense filer",
            version: versionBody(),
          }),
          409,
        )
      ).code,
    ).toBe("template_name_taken");
    const create = (version: Json) =>
      riley.request("POST", "/api/v1/agent-templates", {
        unitId: backend,
        name: `Bad ${randomUUID()}`,
        version,
      });
    expect((await fails(create(versionBody({ modelProvider: "openai", modelId: "gpt-x" })), 400)).code).toBe(
      "model_not_allowed",
    );
    expect(
      (await fails(create(versionBody({ toolGrants: [grant(randomUUID(), READ_INVOICE)] })), 400)).code,
    ).toBe("unknown_tool");
    expect(
      (await fails(create(versionBody({ toolGrants: [grant(erp, `${SAFE_ERP}__nope`)] })), 400)).code,
    ).toBe("unknown_tool");
    // Only per-member connectors are "required": an organization-credential server needs nobody to connect.
    expect((await fails(create(versionBody({ requiredConnectorIds: [orgSecretMcp] })), 400)).code).toBe(
      "unknown_connector",
    );
    // A unit template grants only its own unit's keys.
    expect((await fails(create(versionBody({ unitVaultItemIds: [frontendKey] })), 400)).code).toBe(
      "unknown_vault_item",
    );
  });
});

describe("versions are immutable; updates fork and are applied by the owner only", () => {
  let v1Row: Json;

  it("publishing version 2 leaves version 1 byte-identical; the database refuses any edit of a version", async () => {
    const snapshot = async (v: number) =>
      (
        await su.query(
          "select to_jsonb(v) as row from app.agent_template_versions v where template_id = $1 and version = $2",
          [templateId, v],
        )
      ).rows[0]?.row as Json;
    v1Row = await snapshot(1);
    const t = await ok(
      riley.request(
        "POST",
        `/api/v1/agent-templates/${templateId}/versions`,
        versionBody({
          instructions: "You file expense reports and flag duplicates.",
          modelProvider: "anthropic",
          modelId: "claude-sonnet-5-5",
        }),
      ),
    );
    expect(t).toMatchObject({ currentVersion: 2, latest: { version: 2, createdByName: "Riley Park" } });
    expect(await snapshot(1)).toEqual(v1Row);
    const published = await audits("agent_template.version_published");
    expect(published.map((a) => a.metadata)).toEqual([{ templateId, version: 2 }]);
    await expect(
      su.query(
        "update app.agent_template_versions set instructions = 'changed' where template_id = $1 and version = 1",
        [templateId],
      ),
    ).rejects.toThrow(/agent template versions are immutable/);
    expect(await snapshot(1)).toEqual(v1Row);
  });

  it("Sam's version-1 bot is told what version 2 would overwrite; nobody else learns about it", async () => {
    const link = await ok(sam.request("GET", `/api/v1/agents/${samBotId}/template`));
    expect(link).toMatchObject({
      version: 1,
      latestVersion: 2,
      update: { from: 1, to: 2, changedFields: ["instructions", "model"] },
    });
    for (const c of [jo, riley, admin]) {
      await fails(c.request("GET", `/api/v1/agents/${samBotId}/template`), 404);
      await fails(c.request("POST", `/api/v1/agents/${samBotId}/template/apply`, { toVersion: 2 }), 404);
    }
    // The bot itself did not change.
    const [row] = (
      await su.query("select instructions, template_version from app.agents where id = $1", [samBotId])
    ).rows;
    expect(row).toEqual({
      instructions: "You file expense reports from the receipts people forward.",
      template_version: 1,
    });
  });

  it("only the owner applies it, to the latest version; audited agent.template_updated", async () => {
    expect(
      (await fails(sam.request("POST", `/api/v1/agents/${samBotId}/template/apply`, { toVersion: 1 }), 409))
        .code,
    ).toBe("template_version_conflict");
    expect(
      (await fails(sam.request("POST", `/api/v1/agents/${samBotId}/template/apply`, { toVersion: 3 }), 409))
        .code,
    ).toBe("template_version_conflict");
    const agent = await ok(
      sam.request("POST", `/api/v1/agents/${samBotId}/template/apply`, { toVersion: 2 }),
    );
    expect(agent).toMatchObject({
      id: samBotId,
      instructions: "You file expense reports and flag duplicates.",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-5-5",
    });
    const [row] = (await su.query("select template_version from app.agents where id = $1", [samBotId])).rows;
    expect(row).toEqual({ template_version: 2 });
    const updated = await audits("agent.template_updated");
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ user_id: samId, resource_id: samBotId });
    expect(updated[0]?.metadata).toEqual({ templateId, from: 1, to: 2, skipped: [] });
    expect((await ok(sam.request("GET", `/api/v1/agents/${samBotId}/template`))).update).toBeNull();
    await fails(sam.request("POST", `/api/v1/agents/${samBotId}/template/apply`, { toVersion: 2 }), 409);
  });
});

describe("personal-agent caps apply on instantiation (model, daily limit, personal sources, unit keys, cap)", () => {
  it("the preview lists what is left out, the required connectors with Sam's status, and the cap", async () => {
    capsTemplateId = (
      await ok(
        riley.request("POST", "/api/v1/agent-templates", {
          unitId: backend,
          name: "Caps",
          version: versionBody({
            capabilities: { internet: false, memory: true, dailyLimit: 500 },
            toolGrants: [grant(adminMcp, DELETE_RECORD), grant(erp, READ_INVOICE)],
            requiredConnectorIds: [crm],
            unitVaultItemIds: [backendKey],
          }),
        }),
        201,
      )
    ).id;
    const p = await ok(sam.request("GET", `/api/v1/agent-templates/${capsTemplateId}/preview`));
    expect(p).toEqual({
      skipped: [
        { kind: "capability", id: "dailyLimit", reason: "clamped" },
        { kind: "tool", id: DELETE_RECORD, reason: "not_personal_allowed" },
      ],
      requiredConnectors: [{ serverId: crm, name: "Acme CRM", status: "not_connected" }],
      capReached: false,
      limit: 3,
    });
    const listed = (await ok(sam.request("GET", "/api/v1/agent-templates"))).templates.find(
      (t: Json) => t.id === capsTemplateId,
    );
    expect(listed).toMatchObject({
      requiredConnectors: [{ serverId: crm, name: "Acme CRM" }],
      latest: { createdBy: rileyId, createdByName: "Riley Park" },
    });
  });

  it("the new bot gets only what the personal-bot policy allows: limit 100, personal tools, usable keys", async () => {
    const res = await ok(
      sam.request("POST", `/api/v1/agent-templates/${capsTemplateId}/instantiate`, {}),
      201,
    );
    capsBotId = res.agent.id;
    expect(res.skipped).toEqual([
      { kind: "capability", id: "dailyLimit", reason: "clamped" },
      { kind: "tool", id: DELETE_RECORD, reason: "not_personal_allowed" },
    ]);
    const [row] = (await su.query("select capabilities from app.agents where id = $1", [capsBotId])).rows;
    expect(row.capabilities).toMatchObject({ dailyLimit: 100 });
    expect(await grantsOf(capsBotId)).toEqual([READ_INVOICE]);
    expect(await vaultGrantsOf(capsBotId)).toEqual([backendKey]);
    const audit = (await audits("agent.created_from_template")).find((a) => a.resource_id === capsBotId);
    expect(audit?.metadata).toEqual({
      templateId: capsTemplateId,
      version: 1,
      skipped: res.skipped,
    });
  });

  it("two concurrent starts at the cap create exactly one bot (same advisory lock as one-click bots)", async () => {
    expect(await personalBotsOf(samId)).toHaveLength(2);
    const results = await Promise.all([
      sam.request("POST", `/api/v1/agent-templates/${capsTemplateId}/instantiate`, {}),
      sam.request("POST", `/api/v1/agent-templates/${capsTemplateId}/instantiate`, {}),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const refused = results.find((r) => r.status === 409)?.body as Json | undefined;
    expect(refused?.error?.code).toBe("personal_bot_limit");
    expect(await personalBotsOf(samId)).toHaveLength(3);
    const p = await ok(sam.request("GET", `/api/v1/agent-templates/${capsTemplateId}/preview`));
    expect(p).toMatchObject({ capReached: true, limit: 3 });
    const winner = results.find((r) => r.status === 201)?.body as Json | undefined;
    const extra = winner?.agent?.id as string;
    await ok(sam.request("DELETE", `/api/v1/agents/${extra}`));
  });

  it("a unit key the owner may not use (deny rule on vault.use) is left out and never granted", async () => {
    const rule = await ok(
      admin.request("POST", "/api/v1/permission-rules", {
        scopeUnitId: backend,
        subjectKind: "user",
        subjectId: samId,
        permission: "vault.use",
        effect: "deny",
      }),
    );
    try {
      const p = await ok(sam.request("GET", `/api/v1/agent-templates/${capsTemplateId}/preview`));
      expect(p.skipped).toContainEqual({ kind: "vault_item", id: backendKey, reason: "vault_denied" });
      const res = await ok(
        sam.request("POST", `/api/v1/agent-templates/${capsTemplateId}/instantiate`, {}),
        201,
      );
      expect(await vaultGrantsOf(res.agent.id)).toEqual([]);
      await ok(sam.request("DELETE", `/api/v1/agents/${res.agent.id}`));
    } finally {
      await ok(admin.request("DELETE", `/api/v1/permission-rules/${rule.id}`));
    }
  });

  it("a model not allowed for personal bots falls back to the default and is reported", async () => {
    const sonnet = await ok(
      riley.request("POST", "/api/v1/agent-templates", {
        unitId: backend,
        name: "Sonnet helper",
        version: versionBody({ modelProvider: "anthropic", modelId: "claude-sonnet-5-5" }),
      }),
      201,
    );
    await su.query(
      `insert into app.bot_policies (organization_id, personal_allowed_models) values ($1, '{mock/mock-1}')
       on conflict (organization_id) do update set personal_allowed_models = excluded.personal_allowed_models`,
      [orgId],
    );
    try {
      const res = await ok(sam.request("POST", `/api/v1/agent-templates/${sonnet.id}/instantiate`, {}), 201);
      expect(res.agent).toMatchObject({ modelProvider: "mock", modelId: "mock-1" });
      expect(res.skipped).toEqual([
        { kind: "model", id: "anthropic/claude-sonnet-5-5", reason: "model_not_allowed" },
      ]);
      await ok(sam.request("DELETE", `/api/v1/agents/${res.agent.id}`));
    } finally {
      await su.query(
        "update app.bot_policies set personal_allowed_models = '{}' where organization_id = $1",
        [orgId],
      );
    }
  });

  it("required connectors report the owner's own connection (connections are per member)", async () => {
    expect((await ok(sam.request("GET", `/api/v1/agents/${capsBotId}/template`))).requiredConnectors).toEqual(
      [{ serverId: crm, name: "Acme CRM", status: "not_connected" }],
    );
    await su.query(
      "insert into app.connector_connections (organization_id, user_id, server_id, status) values ($1, $2, $3, 'connected')",
      [orgId, samId, crm],
    );
    expect((await ok(sam.request("GET", `/api/v1/agents/${capsBotId}/template`))).requiredConnectors).toEqual(
      [{ serverId: crm, name: "Acme CRM", status: "connected" }],
    );
  });

  it("applying an update replaces the template's tools and keeps the ones the owner added himself", async () => {
    await ok(
      sam.request("PATCH", `/api/v1/agents/${capsBotId}/capabilities`, {
        tools: [
          { sourceKind: "mcp", sourceId: erp, tool: READ_INVOICE },
          { sourceKind: "mcp", sourceId: erp, tool: CREATE_EXPENSE },
        ],
      }),
    );
    await ok(
      riley.request(
        "POST",
        `/api/v1/agent-templates/${capsTemplateId}/versions`,
        versionBody({
          capabilities: { internet: false, memory: true, dailyLimit: 500 },
          toolGrants: [grant(adminMcp, DELETE_RECORD), grant(erp, FILE_REPORT)],
          requiredConnectorIds: [crm],
          unitVaultItemIds: [backendKey],
        }),
      ),
    );
    expect((await ok(sam.request("GET", `/api/v1/agents/${capsBotId}/template`))).update).toEqual({
      from: 1,
      to: 2,
      changedFields: ["toolGrants"],
    });
    await ok(sam.request("POST", `/api/v1/agents/${capsBotId}/template/apply`, { toVersion: 2 }));
    expect(await grantsOf(capsBotId)).toEqual([CREATE_EXPENSE, FILE_REPORT]);
  });
});

describe("a fresh instance has its own (empty) memory and never sees another instance's", () => {
  let samScope: string;

  it("Sam's and Jo's instances of the same organization template start empty and stay apart", async () => {
    samOrgBotId = (
      await ok(sam.request("POST", `/api/v1/agent-templates/${orgTemplateId}/instantiate`, {}), 201)
    ).agent.id;
    joOrgBotId = (
      await ok(jo.request("POST", `/api/v1/agent-templates/${orgTemplateId}/instantiate`, {}), 201)
    ).agent.id;
    expect((await ok(sam.request("GET", `/api/v1/agents/${samOrgBotId}/memories`))).items).toEqual([]);
    expect((await ok(jo.request("GET", `/api/v1/agents/${joOrgBotId}/memories`))).items).toEqual([]);

    samScope = (
      await ok(sam.request("POST", "/api/v1/memory/scopes", { kind: "personal", agentId: samOrgBotId }))
    ).id;
    const before = await ok(sam.request("GET", `/api/v1/memory/scopes/${samScope}/files`));
    expect(JSON.stringify(before)).not.toContain("CANARY-MEMORY");
    await ok(
      sam.request("POST", `/api/v1/memory/scopes/${samScope}/files`, {
        path: "notes.md",
        content: "CANARY-MEMORY-A",
      }),
    );

    const joScope = (
      await ok(jo.request("POST", "/api/v1/memory/scopes", { kind: "personal", agentId: joOrgBotId }))
    ).id;
    expect(joScope).not.toBe(samScope);
    const joFiles = await ok(jo.request("GET", `/api/v1/memory/scopes/${joScope}/files`));
    expect(JSON.stringify(joFiles)).not.toContain("notes.md");
    await fails(jo.request("GET", `/api/v1/memory/scopes/${samScope}/files`), 404);
    await fails(jo.request("POST", "/api/v1/memory/scopes", { kind: "personal", agentId: samOrgBotId }), 404);
  });
});

describe("options for the editor: catalog tools, per-member connectors and the unit's keys (never a secret)", () => {
  it("the Backend lead reads Backend's options; members and other units' leads are refused", async () => {
    const o = await ok(riley.request("GET", `/api/v1/agent-templates/options?unitId=${backend}`));
    expect(o.tools).toContainEqual({
      sourceKind: "mcp",
      sourceId: erp,
      sourceName: "ERP",
      toolName: READ_INVOICE,
      personalAllowed: true,
    });
    expect(o.tools).toContainEqual({
      sourceKind: "mcp",
      sourceId: adminMcp,
      sourceName: "Admin MCP",
      toolName: DELETE_RECORD,
      personalAllowed: false,
    });
    expect(o.connectors).toEqual([{ serverId: crm, name: "Acme CRM" }]);
    expect(o.vaultItems).toEqual([{ id: backendKey, name: "ERP service", handle: KEY_HANDLE }]);
    expect(JSON.stringify(o)).not.toMatch(/secret/i);
    await fails(sam.request("GET", `/api/v1/agent-templates/options?unitId=${backend}`), 403);
    await fails(riley.request("GET", `/api/v1/agent-templates/options?unitId=${frontend}`), 403);
    await fails(riley.request("GET", "/api/v1/agent-templates/options"), 403);
    expect((await ok(admin.request("GET", "/api/v1/agent-templates/options"))).vaultItems).toEqual([]);
  });
});

describe("privacy (ADR-0010): no template route ever returns an instance's instructions", () => {
  it("the canary in Sam's own edited instructions appears in no response a lead or admin gets", async () => {
    const CANARY = "CANARY-PRIVATE-7f3a9c";
    await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}`, { instructions: `My own rules. ${CANARY}` }));
    const bodies: unknown[] = [];
    for (const c of [riley, admin]) {
      bodies.push((await c.request("GET", "/api/v1/agent-templates")).body);
      bodies.push((await c.request("GET", `/api/v1/agent-templates/${templateId}/preview`)).body);
      bodies.push((await c.request("GET", `/api/v1/agent-templates/options?unitId=${backend}`)).body);
      bodies.push(
        (await c.request("PATCH", `/api/v1/agent-templates/${templateId}`, { description: "Updated." })).body,
      );
      bodies.push((await c.request("GET", `/api/v1/agents/${samBotId}/template`)).body);
    }
    bodies.push(
      (
        await riley.request(
          "POST",
          `/api/v1/agent-templates/${templateId}/versions`,
          versionBody({ instructions: "v3" }),
        )
      ).body,
    );
    for (const b of bodies) expect(JSON.stringify(b)).not.toContain(CANARY);
    // Sam still reads his own.
    expect((await ok(sam.request("GET", `/api/v1/agents/${samBotId}`))).instructions).toContain(CANARY);
  });
});

describe("archive: nobody starts new agents from it; existing ones keep working", () => {
  it("the lead archives Caps; it leaves the gallery, start and preview answer 409, Sam's bot is untouched", async () => {
    const t = await ok(
      riley.request("PATCH", `/api/v1/agent-templates/${capsTemplateId}`, { archived: true }),
    );
    expect(t.archivedAt).not.toBeNull();
    expect((await audits("agent_template.archived")).map((a) => a.metadata)).toEqual([
      { templateId: capsTemplateId },
    ]);
    for (const c of [sam, riley]) {
      const list = await ok(c.request("GET", "/api/v1/agent-templates"));
      expect(list.templates.map((x: Json) => x.id)).not.toContain(capsTemplateId);
    }
    expect(
      (await fails(sam.request("POST", `/api/v1/agent-templates/${capsTemplateId}/instantiate`, {}), 409))
        .code,
    ).toBe("template_archived");
    await fails(sam.request("GET", `/api/v1/agent-templates/${capsTemplateId}/preview`), 409);
    expect(
      (
        await fails(
          riley.request("POST", `/api/v1/agent-templates/${capsTemplateId}/versions`, versionBody()),
          409,
        )
      ).code,
    ).toBe("template_archived");
    const bot = await ok(sam.request("GET", `/api/v1/agents/${capsBotId}`));
    expect(bot.status).not.toBe("disabled");
    await ok(sam.request("GET", `/api/v1/agents/${capsBotId}/template`));
    // Reversible: the lead restores it.
    await ok(riley.request("PATCH", `/api/v1/agent-templates/${capsTemplateId}`, { archived: false }));
    expect((await audits("agent_template.updated")).at(-1)?.metadata).toEqual({
      templateId: capsTemplateId,
      changed: ["archived"],
    });
  });
});

describe("cross-tenant: every referenced id is resolved inside the caller's tenant", () => {
  it("org B's admin never sees, starts, manages or references org A's templates, units, tools, connectors or keys; every template route has a case (WINDOWS #169)", async () => {
    const { client: eve } = await otherOrgAdmin();
    const create = (version: Json) =>
      eve.request("POST", "/api/v1/agent-templates", { unitId: null, name: `X ${randomUUID()}`, version });
    // One org-B case per registered template route (the authz registry), so a new route cannot skip one.
    const cases: Record<string, () => Promise<void>> = {
      "GET /api/v1/agent-templates": async () => {
        expect((await ok(eve.request("GET", "/api/v1/agent-templates"))).templates).toEqual([]);
      },
      "POST /api/v1/agent-templates": async () => {
        expect(
          (
            await fails(
              eve.request("POST", "/api/v1/agent-templates", {
                unitId: backend,
                name: "X",
                version: versionBody(),
              }),
              404,
            )
          ).code,
        ).toBe("unit_not_found");
        expect((await fails(create(versionBody({ toolGrants: [grant(erp, READ_INVOICE)] })), 400)).code).toBe(
          "unknown_tool",
        );
        expect((await fails(create(versionBody({ requiredConnectorIds: [crm] })), 400)).code).toBe(
          "unknown_connector",
        );
        expect((await fails(create(versionBody({ unitVaultItemIds: [backendKey] })), 400)).code).toBe(
          "unknown_vault_item",
        );
      },
      "GET /api/v1/agent-templates/options": async () => {
        await fails(eve.request("GET", `/api/v1/agent-templates/options?unitId=${backend}`), 404);
      },
      "PATCH /api/v1/agent-templates/:p": async () => {
        await fails(eve.request("PATCH", `/api/v1/agent-templates/${templateId}`, { archived: true }), 404);
      },
      "POST /api/v1/agent-templates/:p/versions": async () => {
        await fails(
          eve.request("POST", `/api/v1/agent-templates/${templateId}/versions`, versionBody()),
          404,
        );
      },
      "GET /api/v1/agent-templates/:p/preview": async () => {
        await fails(eve.request("GET", `/api/v1/agent-templates/${templateId}/preview`), 404);
      },
      "POST /api/v1/agent-templates/:p/instantiate": async () => {
        await fails(eve.request("POST", `/api/v1/agent-templates/${templateId}/instantiate`, {}), 404);
      },
      "GET /api/v1/agents/:p/template": async () => {
        await fails(eve.request("GET", `/api/v1/agents/${samBotId}/template`), 404);
      },
      "POST /api/v1/agents/:p/template/apply": async () => {
        await fails(eve.request("POST", `/api/v1/agents/${samBotId}/template/apply`, { toVersion: 3 }), 404);
      },
    };
    const owned = (k: string) => / \/api\/v1\/(agent-templates|agents\/:[A-Za-z]+\/template)/u.test(k);
    const routeKey = (k: string) => k.replace(/:[A-Za-z]+/gu, ":p");
    expect([...stack.built.authz.routes.keys()].filter(owned).map(routeKey).sort()).toEqual(
      Object.keys(cases).sort(),
    );
    for (const run of Object.values(cases)) await run();
    // Nothing of org A changed.
    const [t] = (
      await su.query("select archived_at, current_version from app.agent_templates where id = $1", [
        templateId,
      ])
    ).rows;
    expect(t).toEqual({ archived_at: null, current_version: 3 });
  });
});

describe("the public one-click route keeps its contract", () => {
  it("POST /agents/personal ignores template fields in its body", async () => {
    const res = await ok(
      jo.request("POST", "/api/v1/agents/personal", { name: "Jo's helper", templateId, templateVersion: 1 }),
    );
    const [row] = (
      await su.query("select template_id, template_version from app.agents where id = $1", [res.agent.id])
    ).rows;
    expect(row).toEqual({ template_id: null, template_version: null });
  });
});

describe("required connectors take member modes only (07.14 PD-09)", () => {
  it("an organization-account server is refused as required and left out of the editor's connectors", async () => {
    const orgOauth = randomUUID();
    const orgCc = randomUUID();
    const memberOauth = randomUUID();
    await mcpServer(orgOauth, "Org Drive", "m0a0b0c01", { authMode: "org_oauth" });
    await mcpServer(orgCc, "Org Billing", "m0a0b0c02", { authMode: "org_client_credentials" });
    await mcpServer(memberOauth, "Linear", "m0a0b0c03", { authMode: "per_member_oauth" });
    try {
      const create = (version: Json) =>
        riley.request("POST", "/api/v1/agent-templates", {
          unitId: backend,
          name: `Org ${randomUUID()}`,
          version,
        });
      // The organization's account needs nobody to connect: it is never a member's connector.
      for (const id of [orgOauth, orgCc]) {
        expect((await fails(create(versionBody({ requiredConnectorIds: [id] })), 400)).code).toBe(
          "unknown_connector",
        );
        expect((await fails(create(versionBody({ requiredConnectorIds: [crm, id] })), 400)).code).toBe(
          "unknown_connector",
        );
      }
      await ok(create(versionBody({ requiredConnectorIds: [memberOauth, crm] })), 201);

      const o = await ok(riley.request("GET", `/api/v1/agent-templates/options?unitId=${backend}`));
      expect(o.connectors).toEqual([
        { serverId: crm, name: "Acme CRM" },
        { serverId: memberOauth, name: "Linear" },
      ]);
    } finally {
      await su.query("delete from app.mcp_servers where id = any($1)", [[orgOauth, orgCc, memberOauth]]);
    }
  });
});

/** A client whose membership moved to a fresh organization B, as its admin (module-access.int.test.ts). */
async function otherOrgAdmin(): Promise<{ client: TestClient; orgB: string; userB: string }> {
  const [client, userB] = await joinAs(`eve-${randomUUID().slice(0, 8)}@example.test`, "Eve", "standard");
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
