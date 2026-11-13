import { randomUUID } from "node:crypto";
import { TASK_TOOL_NAMES, TURN_CATALOG_TOOLS_MAX } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { createPermissionService } from "../organization";
import { currentTurn, currentTurnTools, findBot, governanceList, loadPolicy, loadTaskPolicy } from "./index";

/**
 * 03.1-03 (BOT-04, BOT-05, BOT-10, SC4): bot capabilities, the org policy and personal-bot governance through
 * the resolver, against real PostgreSQL + Redis. Every change is audited (keys only) and reaches the cell.
 */

const CELL_TOKEN = "ocw-test-cell-token-capabilities-0123456789ab";
const ADMIN = {
  name: "Víctor Ruiz",
  email: "victor@example.test",
  password: "correct-horse-battery",
  orgName: "Autofy Labs",
};
const SAFE = "m3f9a12c4";

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let alex: TestClient;
let orgId: string;
let samId: string;
let samBotId: string;
let samDmId: string;
let teamBotId: string;
let mcpId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const codeOf = (r: { body: Record<string, unknown> | null }) =>
  (r.body as { error?: { code?: string } } | null)?.error?.code;

async function joinAs(email: string, name: string, role: "developer" | "standard") {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

/** Superuser-inserted rule; returns its removal. */
async function rule(
  effect: "allow" | "deny",
  subjectKind: "user" | "agent" | "role",
  subjectId: string,
  permission: string,
  tool: string | null = null,
) {
  const id = randomUUID();
  await su.query(
    `insert into app.permission_rules (id, organization_id, subject_kind, subject_id, permission, tool, effect)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, orgId, subjectKind, subjectId, permission, tool, effect],
  );
  return async () => {
    await su.query("delete from app.permission_rules where id = $1", [id]);
  };
}

const audits = async (action: string) =>
  (
    await su.query(
      "select resource_id, user_id, metadata from app.audit_events where action = $1 and organization_id = $2 order by occurred_at",
      [action, orgId],
    )
  ).rows as Array<{ resource_id: string; user_id: string; metadata: Json }>;

const configChanges = async (reason: string) =>
  (
    await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'cell.config.changed' and payload->>'reason' = $2 order by seq",
      [`cell:${orgId}`, reason],
    )
  ).rows.map((r) => r.payload as Json);

function nextUtcMidnight(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN }));
  orgId = setup.organization.id;
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee", "developer");
  [alex] = await joinAs("alex@example.test", "Alex Kim", "developer");

  const personal = await ok(sam.request("POST", "/api/v1/agents/personal", {}));
  samBotId = personal.agent.id;
  samDmId = personal.dmId;
  const team = await ok(
    admin.request("POST", "/api/v1/agents", {
      name: "Archie",
      instructions: "You are Archie.",
      modelProvider: "mock",
      modelId: "mock-1",
    }),
  );
  teamBotId = team.id;

  // A probed, ready MCP server with one read-only tool and one dangerous one (03.1-09 fills these for real).
  mcpId = randomUUID();
  await su.query(
    `insert into app.mcp_servers (id, organization_id, name, safe_name, transport, url, status)
     values ($1, $2, 'Docs', $3, 'streamable-http', 'https://mcp.example.test/mcp', 'ready')`,
    [mcpId, orgId, SAFE],
  );
  for (const [name, readOnly] of [
    ["echo", true],
    ["exec", false],
  ] as const) {
    await su.query(
      `insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only)
       values ($1, $2, $3, $4, $5)`,
      [orgId, mcpId, name, `${SAFE}__${name}`, readOnly],
    );
  }
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("GET /agents/:id/capabilities", () => {
  it("the owner sees personal defaults, today's usage against the limit, and the catalog", async () => {
    const v = await ok(sam.request("GET", `/api/v1/agents/${samBotId}/capabilities`));
    expect(v).toMatchObject({
      agentId: samBotId,
      scope: "personal",
      capabilities: { internet: false, memory: true, dateTime: true, replyMode: "mentions", dailyLimit: 30 },
      effective: {
        internet: { enabled: false, effective: false, reason: null },
        memory: { enabled: true, effective: true, reason: null },
        dateTime: { enabled: true, effective: true, reason: null },
        // Off, and refused while off: a personal bot only lives in its owner's DM.
        replyModeAll: { enabled: false, effective: false, reason: "dm_only" },
      },
      usage: { today: 0, limit: 30, resetsAt: nextUtcMidnight() },
      dailyLimitMax: 100,
    });
    expect(v.viewerCan).toEqual(expect.arrayContaining(["bot.read", "bot.configure"]));
    const echo = v.tools.find((t: Json) => t.tool === `${SAFE}__echo`);
    expect(echo).toMatchObject({
      sourceKind: "mcp",
      sourceId: mcpId,
      sourceName: "Docs",
      sideEffecting: false,
      granted: false,
      effective: false,
      // Not granted, and it could not be: Docs is not allowed for personal bots (the UI explains it).
      reason: "personal_policy",
    });
    expect(v.tools.find((t: Json) => t.tool === `${SAFE}__exec`)).toMatchObject({ reason: "dangerous" });
  });

  it("nobody else (admins included) learns a personal bot exists: 404", async () => {
    const asAdmin = await admin.request("GET", `/api/v1/agents/${samBotId}/capabilities`);
    expect(asAdmin.status).toBe(404);
    expect((await alex.request("GET", `/api/v1/agents/${samBotId}/capabilities`)).status).toBe(404);
    expect((await sam.request("GET", `/api/v1/agents/${randomUUID()}/capabilities`)).status).toBe(404);
  });

  it("team bots: admins manage them, a developer gets 403 bot.configure", async () => {
    const v = await ok(admin.request("GET", `/api/v1/agents/${teamBotId}/capabilities`));
    expect(v).toMatchObject({
      scope: "team",
      capabilities: { internet: false, memory: false, dateTime: true, dailyLimit: 100 },
      usage: { limit: 100 },
      dailyLimitMax: 10_000,
    });
    const denied = await sam.request("GET", `/api/v1/agents/${teamBotId}/capabilities`);
    expect(denied.status).toBe(403);
    expect((denied.body as Json).error.details).toMatchObject({ permission: "bot.configure" });
  });

  it("without sandboxd configured, the Sandbox and Browser rows are unavailable: service_down (07.8-11, R11)", async () => {
    const v = await ok(admin.request("GET", `/api/v1/agents/${teamBotId}/capabilities`));
    expect(v.confined).toEqual({
      sandbox: { enabled: false, available: false, reason: "service_down" },
      browser: { enabled: false, available: false, reason: "service_down" },
    });
  });

  it("usage counts today's turns from agent_usage_daily", async () => {
    await su.query(
      "insert into app.agent_usage_daily (organization_id, agent_id, day, turns) values ($1, $2, (now() at time zone 'utc')::date, 7)",
      [orgId, teamBotId],
    );
    const v = await ok(admin.request("GET", `/api/v1/agents/${teamBotId}/capabilities`));
    expect(v.usage).toMatchObject({ today: 7, limit: 100 });
  });
});

describe("PATCH /agents/:id/capabilities", () => {
  it("the owner turns internet on: stored, audited with the changed keys only, the cell is told", async () => {
    const before = (await configChanges("agent.capabilities_updated")).length;
    const v = await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { internet: true }));
    expect(v.capabilities.internet).toBe(true);
    expect(v.effective.internet).toEqual({ enabled: true, effective: true, reason: null });
    const row = (await su.query("select capabilities from app.agents where id = $1", [samBotId])).rows[0];
    expect(row.capabilities).toMatchObject({ internet: true });

    const rows = (await audits("agent.capabilities_updated")).filter((r) => r.resource_id === samBotId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(samId);
    expect(rows[0]!.metadata.changed).toEqual(["internet"]);
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain("dailyLimit");

    const changes = await configChanges("agent.capabilities_updated");
    expect(changes).toHaveLength(before + 1);
    expect(changes.at(-1)).toMatchObject({ agentId: samBotId });
  });

  it("a no-op PATCH neither audits nor notifies", async () => {
    const before = (await configChanges("agent.capabilities_updated")).length;
    await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { internet: true }));
    expect(await configChanges("agent.capabilities_updated")).toHaveLength(before);
  });

  it("refuses limits above the policy, reply mode `all` on a personal bot, unknown and dangerous tools", async () => {
    const above = await sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { dailyLimit: 500 });
    expect([above.status, codeOf(above)]).toEqual([400, "limit_above_policy"]);
    const all = await sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { replyMode: "all" });
    expect([all.status, codeOf(all)]).toEqual([400, "dm_only"]);
    const unknown = await sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, {
      tools: [{ sourceKind: "mcp", sourceId: randomUUID(), tool: "m00000000__echo" }],
    });
    expect([unknown.status, codeOf(unknown)]).toEqual([400, "unknown_tool"]);
    const danger = await sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, {
      tools: [{ sourceKind: "mcp", sourceId: mcpId, tool: `${SAFE}__exec` }],
    });
    expect([danger.status, codeOf(danger)]).toEqual([400, "dangerous_tool"]);
    const zero = await sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { dailyLimit: 0 });
    expect(zero.status).toBe(400);
    // A team bot may go above the personal maximum.
    const team = await ok(
      admin.request("PATCH", `/api/v1/agents/${teamBotId}/capabilities`, { dailyLimit: 500 }),
    );
    expect(team.capabilities.dailyLimit).toBe(500);
  });

  it("grants replace the tool set; a personal bot's MCP tool waits for personal_allowed", async () => {
    const v = await ok(
      sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, {
        tools: [{ sourceKind: "mcp", sourceId: mcpId, tool: `${SAFE}__echo` }],
      }),
    );
    expect(v.tools.find((t: Json) => t.tool === `${SAFE}__echo`)).toMatchObject({
      granted: true,
      effective: false,
      reason: "personal_policy",
    });
    const rows = (await audits("agent.capabilities_updated")).filter((r) => r.resource_id === samBotId);
    expect(rows.at(-1)!.metadata).toMatchObject({
      changed: ["tools"],
      granted: [`${SAFE}__echo`],
      revoked: [],
    });

    await su.query("update app.mcp_servers set personal_allowed = true where id = $1", [mcpId]);
    const after = await ok(sam.request("GET", `/api/v1/agents/${samBotId}/capabilities`));
    expect(after.tools.find((t: Json) => t.tool === `${SAFE}__echo`)).toMatchObject({
      effective: true,
      reason: null,
    });
  });

  it("more usable tools than one turn carries: the view counts the ones left out (toolsOverLimit), none when they fit", async () => {
    const bulkId = randomUUID();
    await su.query(
      `insert into app.mcp_servers (id, organization_id, name, safe_name, transport, url, status)
       values ($1, $2, 'Bulk', 'bulk', 'streamable-http', 'https://bulk.example.test/mcp', 'ready')`,
      [bulkId, orgId],
    );
    const names = Array.from({ length: 140 }, (_, i) => `t${String(i).padStart(3, "0")}`);
    for (const name of names) {
      await su.query(
        `insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only)
         values ($1, $2, $3, $4, true)`,
        [orgId, bulkId, name, `bulk__${name}`],
      );
    }
    const grant = (n: number) =>
      ok(
        admin.request("PATCH", `/api/v1/agents/${teamBotId}/capabilities`, {
          tools: names.slice(0, n).map((t) => ({ sourceKind: "mcp", sourceId: bulkId, tool: `bulk__${t}` })),
        }),
      );
    try {
      const full = await grant(140);
      const usable = full.tools.filter((t: Json) => t.effective).length;
      expect(usable).toBe(140);
      // The platform's tools come first, and catalog tools stop at TURN_CATALOG_TOOLS_MAX turn tools (the rest of the
      // 128 is kept for the turn-scoped platform tools): the ones left out are counted, never silently lost.
      expect(full.toolsOverLimit).toBeGreaterThan(140 - TURN_CATALOG_TOOLS_MAX);
      expect(full.toolsOverLimit).toBeLessThan(140);
      // Exactly the catalog share: the platform tools `assemble` adds first take some of it.
      const share = await grant(TURN_CATALOG_TOOLS_MAX);
      expect(share.toolsOverLimit).toBeGreaterThan(0);
      expect(share.toolsOverLimit).toBe(full.toolsOverLimit - (140 - TURN_CATALOG_TOOLS_MAX));
      const fits = await grant(10);
      expect(fits.toolsOverLimit).toBe(0);
    } finally {
      await grant(0);
      await su.query("delete from app.mcp_servers where id = $1", [bulkId]);
    }
  });

  it("other members cannot change a personal bot (404) nor a developer a team bot (403)", async () => {
    expect(
      (await admin.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { internet: false })).status,
    ).toBe(404);
    expect(
      (await sam.request("PATCH", `/api/v1/agents/${teamBotId}/capabilities`, { internet: true })).status,
    ).toBe(403);
  });
});

describe("org bot policy", () => {
  it("admins read the defaults; developers are refused", async () => {
    const p = await ok(admin.request("GET", "/api/v1/bot-policy"));
    expect(p).toMatchObject({
      searchProvider: "duckduckgo",
      maxPersonalBotsPerUser: 3,
      personalDailyLimitMax: 100,
      personalAllowedModels: [],
      updatedAt: null,
      // SearXNG is bundled but has no OCW_SEARXNG_URL here (no compose `search` profile).
      availableSearchProviders: ["duckduckgo"],
    });
    expect(p.capabilities.internet).toEqual({ orgWide: true, personal: true });
    expect((await sam.request("GET", "/api/v1/bot-policy")).status).toBe(403);
    expect((await sam.request("PUT", "/api/v1/bot-policy", { maxPersonalBotsPerUser: 9 })).status).toBe(403);
  });

  it("SearXNG cannot be chosen when it is not configured", async () => {
    const r = await admin.request("PUT", "/api/v1/bot-policy", { searchProvider: "searxng" });
    expect([r.status, codeOf(r)]).toEqual([400, "not_configured"]);
  });

  it("denying internet to personal bots is audited, reaches the cell and bites in the effective view", async () => {
    await ok(admin.request("PATCH", `/api/v1/agents/${teamBotId}/capabilities`, { internet: true }));
    const before = (await configChanges("policy.updated")).length;
    const p = await ok(
      admin.request("PUT", "/api/v1/bot-policy", {
        capabilities: { internet: { orgWide: true, personal: false } },
      }),
    );
    expect(p.capabilities.internet).toEqual({ orgWide: true, personal: false });
    expect(p.capabilities.memory).toEqual({ orgWide: true, personal: true });
    expect(p.updatedAt).not.toBeNull();

    const rows = await audits("bot_policy.updated");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata.changed).toEqual(["capabilities.internet"]);
    const changes = await configChanges("policy.updated");
    expect(changes).toHaveLength(before + 1);
    expect(changes.at(-1)).toMatchObject({ agentId: null });

    const samView = await ok(sam.request("GET", `/api/v1/agents/${samBotId}/capabilities`));
    expect(samView.effective.internet).toEqual({
      enabled: true,
      effective: false,
      reason: "personal_policy",
    });
    const teamView = await ok(admin.request("GET", `/api/v1/agents/${teamBotId}/capabilities`));
    expect(teamView.effective.internet).toEqual({ enabled: true, effective: true, reason: null });

    // The personal daily-limit maximum is the policy's.
    await ok(admin.request("PUT", "/api/v1/bot-policy", { personalDailyLimitMax: 1000 }));
    expect(
      (await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { dailyLimit: 500 })))
        .capabilities.dailyLimit,
    ).toBe(500);

    // Restore for the next tests.
    await ok(
      admin.request("PUT", "/api/v1/bot-policy", {
        capabilities: { internet: { orgWide: true, personal: true } },
        personalDailyLimitMax: 100,
      }),
    );
  });

  it("a deny rule on bot.internet for Sam shows denied_for_you in his view", async () => {
    const drop = await rule("deny", "user", samId, "bot.internet");
    try {
      const v = await ok(sam.request("GET", `/api/v1/agents/${samBotId}/capabilities`));
      expect(v.effective.internet).toEqual({ enabled: true, effective: false, reason: "denied_for_you" });
    } finally {
      await drop();
    }
  });

  it("a tool-layer deny rule on bot.tool.use shows denied_for_you for that tool only", async () => {
    const drop = await rule("deny", "user", samId, "bot.tool.use", `${SAFE}__echo`);
    try {
      const v = await ok(sam.request("GET", `/api/v1/agents/${samBotId}/capabilities`));
      expect(v.tools.find((t: Json) => t.tool === `${SAFE}__echo`)).toMatchObject({
        granted: true,
        effective: false,
        reason: "denied_for_you",
      });
    } finally {
      await drop();
    }
  });
});

describe("personal-bot governance", () => {
  it("admins see every personal bot's metadata and usage, never its instructions", async () => {
    const res = await admin.request("GET", "/api/v1/bot-governance");
    expect(res.status).toBe(200);
    const body = res.body as Json;
    expect(body.bots).toHaveLength(1);
    expect(body.bots[0]).toMatchObject({
      id: samBotId,
      owner: { id: samId, displayName: "Sam Lee" },
      model: { provider: "mock", modelId: "mock-1" },
      capabilities: { internet: true },
      usage: { today: 0 },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('"instructions"');
    expect(serialized).not.toContain("personal assistant of Sam Lee");
    expect(serialized).not.toContain(samDmId);
    expect((await sam.request("GET", "/api/v1/bot-governance")).status).toBe(403);
  });

  it("cross-tenant: another organization finds neither the bot nor any governance entry", async () => {
    const orgB = randomUUID();
    const userB = randomUUID();
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
    const { db } = stack.built.core;
    const ctxB = { organizationId: orgB, userId: userB };
    expect(await db.withTenant(ctxB, (tx) => findBot(tx, samBotId))).toBeNull();
    expect(await db.withTenant(ctxB, (tx) => findBot(tx, teamBotId))).toBeNull();
    expect(await db.withTenant(ctxB, (tx) => governanceList(tx))).toEqual([]);
    // Same calls in the right tenant do find them (the test is not vacuous).
    const ctxA = { organizationId: orgId, userId: samId };
    expect((await db.withTenant(ctxA, (tx) => findBot(tx, samBotId)))?.id).toBe(samBotId);
    expect(await db.withTenant(ctxA, (tx) => governanceList(tx))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- Task 3: the turn travels with every delivery

const mentionsFor = async (agentId: string) =>
  (
    await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'agent'->>'id' = $2 order by seq",
      [`cell:${orgId}`, agentId],
    )
  ).rows.map((r) => r.payload as Json);

async function lastMention(agentId: string, messageId: string) {
  const ev = (await mentionsFor(agentId)).at(-1);
  expect(ev?.message.id).toBe(messageId);
  return ev as Json;
}

const say = async (c: TestClient, conversationId: string, body: string, mentions: Json[] = []) =>
  (await ok(c.request("POST", `/api/v1/conversations/${conversationId}/messages`, { body, mentions })))
    .id as string;

async function cellSnapshot(): Promise<Json> {
  const res = await fetch(`${stack.baseUrl}/agent-channel/v1/cell`, {
    headers: { authorization: `Bearer ${CELL_TOKEN}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Json;
}

describe("per-turn policy (D-07, SC4)", () => {
  let channelId: string;
  const WEB_FLAGS = { untrustedOutput: true, sideEffecting: false };
  /** The memory tools in their fixed position (07.2-11): save and write in a one-person DM only. */
  const DM_MEMORY = [
    "ocw_memory_save",
    "ocw_memory_list",
    "ocw_memory_read",
    "ocw_memory_write",
    "ocw_memory_propose",
  ];
  const SHARED_MEMORY = ["ocw_memory_list", "ocw_memory_read", "ocw_memory_propose"];
  const DM_TOOLS = ["web_search", "web_fetch", ...DM_MEMORY, "ocw_agent_card"];
  /**
   * 07.5-08: Work Zone proposals, right after the card tool, on every delivered turn whose human holds
   * `work_session.create` (Sam is a developer, the admin an admin). Never in the cell-wide view (no human).
   */
  const WORK_ZONE = ["ocw_work_zone_projects", "ocw_start_work_zone"];
  /**
   * 07.6-12: natural-language automations, after the other built-ins, on every turn whose human holds
   * `automation.create` in their DM with the bot or a channel they may post in. Never in the cell-wide view.
   */
  const AUTOMATIONS = ["ocw_automation_propose"];
  /**
   * 07.17.1.1.2 (PD-07): the three task tools, last, on every person's turn in a thread without the bot's task (long
   * tasks are on by default). Turn-scoped: never in the cell-wide view nor in `currentTurnTools`.
   */
  const TASKS: string[] = [...TASK_TOOL_NAMES];
  const DM_TURN = [...DM_TOOLS, ...WORK_ZONE, ...AUTOMATIONS];

  it("Sam's DM message carries the effective turn and an agent_turns row in the same transaction", async () => {
    await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { tools: [] }));
    const messageId = await say(sam, samDmId, "What's new today?");
    const ev = await lastMention(samBotId, messageId);
    expect(ev.turn).toMatchObject({
      tools: [...DM_TURN, ...TASKS],
      toolFlags: {
        web_search: WEB_FLAGS,
        web_fetch: WEB_FLAGS,
        ocw_memory_save: { untrustedOutput: false, sideEffecting: true },
        // 07.2-11: memory files; write only here (a one-person DM), list/read/propose wherever memory is effective.
        ocw_memory_list: { untrustedOutput: false, sideEffecting: false },
        ocw_memory_read: { untrustedOutput: false, sideEffecting: false },
        ocw_memory_write: { untrustedOutput: false, sideEffecting: true },
        ocw_memory_propose: { untrustedOutput: false, sideEffecting: false },
        ocw_agent_card: { untrustedOutput: false, sideEffecting: false },
        ocw_work_zone_projects: { untrustedOutput: false, sideEffecting: false },
        ocw_start_work_zone: { untrustedOutput: false, sideEffecting: true },
        ocw_automation_propose: { untrustedOutput: false, sideEffecting: true },
      },
      memory: [],
      maxToolCalls: 8,
      maxWebCalls: 5,
    });
    expect(ev.turn.now.timeZone).toBe("UTC");
    expect(Math.abs(Date.parse(ev.turn.now.iso) - Date.now())).toBeLessThan(60_000);
    expect(ev.turn.now.local).toMatch(/\d{4}/);

    const row = (await su.query("select * from app.agent_turns where event_id = $1", [ev.eventId])).rows[0];
    expect(row).toMatchObject({
      organization_id: orgId,
      agent_id: samBotId,
      user_id: samId,
      conversation_id: samDmId,
      conversation_kind: "dm",
      message_id: messageId,
      tools: [...DM_TURN, ...TASKS],
      tool_calls: 0,
      web_calls: 0,
      tainted: false,
    });
    expect(row.tool_flags).toEqual(ev.turn.toolFlags);
  });

  it("currentTurnTools returns the same set as the event for an unchanged state", async () => {
    const { core } = stack.built;
    const ev = (await mentionsFor(samBotId)).at(-1) as Json;
    const now = await core.db.withTenant({ organizationId: orgId, userId: null }, (tx) =>
      currentTurnTools(
        tx,
        createPermissionService(core),
        { agentId: samBotId, humanUserId: samId, conversationKind: "dm" },
        core.env,
      ),
    );
    // The turn-scoped task tools are decided at delivery only (PD-07); everything else is the same set.
    const tools = (ev.turn.tools as string[]).filter((t) => !TASKS.includes(t));
    const toolFlags = Object.fromEntries(
      Object.entries(ev.turn.toolFlags as Record<string, unknown>).filter(([t]) => !TASKS.includes(t)),
    );
    expect(now).toEqual({ tools, toolFlags });
  });

  it("denying internet to personal bots bites on the very next DM message, before any cell reconcile", async () => {
    await ok(
      admin.request("PUT", "/api/v1/bot-policy", {
        capabilities: { internet: { orgWide: true, personal: false } },
      }),
    );
    try {
      const messageId = await say(sam, samDmId, "And now?");
      const ev = await lastMention(samBotId, messageId);
      expect(ev.turn.tools).toEqual([...DM_MEMORY, "ocw_agent_card", ...WORK_ZONE, ...AUTOMATIONS, ...TASKS]);
      // jsonb orders object keys by length: compare as a set.
      expect(Object.keys(ev.turn.toolFlags).sort()).toEqual(
        [...DM_MEMORY, "ocw_agent_card", ...WORK_ZONE, ...AUTOMATIONS, ...TASKS].sort(),
      );
    } finally {
      await ok(
        admin.request("PUT", "/api/v1/bot-policy", {
          capabilities: { internet: { orgWide: true, personal: true } },
        }),
      );
    }
  });

  it("dateTime off → the turn carries no time", async () => {
    await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { dateTime: false }));
    try {
      const messageId = await say(sam, samDmId, "What time is it?");
      expect((await lastMention(samBotId, messageId)).turn.now).toBeNull();
    } finally {
      await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { dateTime: true }));
    }
  });

  it("a team bot in a channel never gets memory writes (list/read/propose only); a deny rule removes the web tools for that human only", async () => {
    await ok(admin.request("PATCH", `/api/v1/agents/${teamBotId}/capabilities`, { memory: true }));
    channelId = (await ok(admin.request("POST", "/api/v1/channels", { name: "research" }))).id;
    await ok(sam.request("POST", `/api/v1/channels/${channelId}/join`));
    const mention = [{ kind: "agent", id: teamBotId }];

    const fromAdmin = await say(admin, channelId, "@archie what changed?", mention);
    const evAdmin = await lastMention(teamBotId, fromAdmin);
    expect(evAdmin.turn.tools).toEqual([
      "web_search",
      "web_fetch",
      ...SHARED_MEMORY,
      "ocw_agent_card",
      ...WORK_ZONE,
      ...AUTOMATIONS,
      ...TASKS,
    ]);
    expect(evAdmin.conversation.kind).toBe("channel");

    const drop = await rule("deny", "user", samId, "bot.internet");
    try {
      const fromSam = await say(sam, channelId, "@archie and for me?", mention);
      const evSam = await lastMention(teamBotId, fromSam);
      expect(evSam.turn.tools).toEqual([
        ...SHARED_MEMORY,
        "ocw_agent_card",
        ...WORK_ZONE,
        ...AUTOMATIONS,
        ...TASKS,
      ]);
      const row = (
        await su.query("select tools, user_id from app.agent_turns where event_id = $1", [evSam.eventId])
      ).rows[0];
      expect(row).toEqual({
        tools: [...SHARED_MEMORY, "ocw_agent_card", ...WORK_ZONE, ...AUTOMATIONS, ...TASKS],
        user_id: samId,
      });

      const again = await say(admin, channelId, "@archie still there?", mention);
      expect((await lastMention(teamBotId, again)).turn.tools).toEqual([
        "web_search",
        "web_fetch",
        ...SHARED_MEMORY,
        "ocw_agent_card",
        ...WORK_ZONE,
        ...AUTOMATIONS,
        ...TASKS,
      ]);
    } finally {
      await drop();
    }
  });

  it("granted catalog tools ride in the turn with their flags; a tool-layer deny removes only that tool", async () => {
    await ok(
      sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, {
        tools: [{ sourceKind: "mcp", sourceId: mcpId, tool: `${SAFE}__echo` }],
      }),
    );
    const messageId = await say(sam, samDmId, "Echo please");
    const ev = await lastMention(samBotId, messageId);
    expect(ev.turn.tools).toEqual([...DM_TURN, `${SAFE}__echo`, ...TASKS]);
    expect(ev.turn.toolFlags[`${SAFE}__echo`]).toEqual({ untrustedOutput: true, sideEffecting: false });

    const drop = await rule("deny", "user", samId, "bot.tool.use", `${SAFE}__echo`);
    try {
      const denied = await say(sam, samDmId, "Echo again");
      expect((await lastMention(samBotId, denied)).turn.tools).toEqual([...DM_TURN, ...TASKS]);
    } finally {
      await drop();
    }
  });

  it("GET /cell lists each bot's possible tools (ignoring per-human rules) and the search provider", async () => {
    const quiet = await ok(
      admin.request("POST", "/api/v1/agents", {
        name: "Quiet",
        instructions: "You are quiet.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    );
    const drop = await rule("deny", "user", samId, "bot.internet");
    try {
      const snap = await cellSnapshot();
      expect(snap.webSearch).toEqual({ provider: "duckduckgo" });
      const byId = new Map((snap.agents as Json[]).map((a) => [a.id, a.capabilities.tools]));
      // The cell-wide view (any conversation): every memory tool where memory is on (07.2-11).
      expect(byId.get(samBotId)).toEqual([...DM_TOOLS, `${SAFE}__echo`]);
      expect(byId.get(teamBotId)).toEqual(DM_TOOLS);
      // Cards are offered to every enabled bot (06-14); nothing else without a capability (no memory tool either).
      expect(byId.get(quiet.id)).toEqual(["ocw_agent_card"]);
    } finally {
      await drop();
    }
  });

  it("a bot without memory is offered no memory tool, in its DM or in a channel (07.2-11)", async () => {
    const mute = await ok(
      admin.request("POST", "/api/v1/agents", {
        name: "Mute",
        instructions: "You are mute.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    );
    const dmId = (await ok(admin.request("POST", `/api/v1/agents/${mute.id}/dm`))).dmId as string;
    const inDm = await say(admin, dmId, "hello");
    expect((await lastMention(mute.id, inDm)).turn.tools).toEqual([
      "ocw_agent_card",
      ...WORK_ZONE,
      ...AUTOMATIONS,
      ...TASKS,
    ]);
    const inChannel = await say(admin, channelId, "@mute hello", [{ kind: "agent", id: mute.id }]);
    expect((await lastMention(mute.id, inChannel)).turn.tools).toEqual([
      "ocw_agent_card",
      ...WORK_ZONE,
      ...AUTOMATIONS,
      ...TASKS,
    ]);
  });

  it("07.16 BWZ-06: a bot without a Work Zone profile is never offered the ocw_work_session_* tools", async () => {
    const SESSION_TOOLS = [
      "ocw_work_session_start",
      "ocw_work_session_prompt",
      "ocw_work_session_read",
      "ocw_work_session_stop",
    ];
    const profiles = await su.query("select 1 from app.bot_work_zone_profiles where organization_id = $1", [
      orgId,
    ]);
    expect(profiles.rows).toEqual([]);
    const inDm = await say(sam, samDmId, "anything to run?");
    const dm = await lastMention(samBotId, inDm);
    const inChannel = await say(admin, channelId, "@archie anything to run?", [
      { kind: "agent", id: teamBotId },
    ]);
    const channel = await lastMention(teamBotId, inChannel);
    for (const ev of [dm, channel]) {
      for (const name of SESSION_TOOLS) {
        expect(ev.turn.tools).not.toContain(name);
        expect(ev.turn.toolFlags).not.toHaveProperty(name);
      }
      expect(ev.turn).not.toHaveProperty("workZone");
      // The proposal stays the bot's Work Zone path (D-05), under its unchanged rule.
      expect(ev.turn.tools).toEqual(expect.arrayContaining(WORK_ZONE));
    }
    const snap = await cellSnapshot();
    for (const a of snap.agents as Json[]) {
      for (const name of SESSION_TOOLS) expect(a.capabilities.tools).not.toContain(name);
    }
  });
});

// ---------------------------------------------------------------- 07.17.1.1.2-04: "Allow long tasks" and its limits

describe("long tasks policy (07.17.1.1.2 D-04, E11, E22)", () => {
  let adminId: string;
  let orgB: string;
  let userB: string;

  const putPolicy = (body: Json) => admin.request("PUT", "/api/v1/bot-policy", body);
  const taskPolicyOf = async (agentId: string) => {
    const { db } = stack.built.core;
    return db.withTenant({ organizationId: orgId, userId: null }, async (tx) => {
      const row = await findBot(tx, agentId);
      if (!row) throw new Error("bot not found");
      return loadTaskPolicy(tx, row);
    });
  };
  const longTasksOnTurn = async (agentId: string, humanUserId: string, conversationKind: string) => {
    const { core } = stack.built;
    const turn = await core.db.withTenant({ organizationId: orgId, userId: null }, (tx) =>
      currentTurn(tx, createPermissionService(core), { agentId, humanUserId, conversationKind }, core.env),
    );
    return turn.longTasks;
  };

  beforeAll(async () => {
    adminId = (
      await su.query("select user_id from app.org_members where organization_id = $1 and role = 'admin'", [
        orgId,
      ])
    ).rows[0].user_id as string;
    orgB = randomUUID();
    userB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
      orgB,
      `other-${orgB}`,
    ]);
    await su.query("insert into auth.user (id, name, email) values ($1, 'Bea', $2)", [
      userB,
      `${userB}@other.test`,
    ]);
    await su.query(
      "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Bea', 'admin')",
      [orgB, userB],
    );
  });

  it("an organization that never chose answers long tasks allowed with 40 turns, 8 hours and 10 running", async () => {
    const p = await ok(admin.request("GET", "/api/v1/bot-policy"));
    expect(p.capabilities.longTasks).toEqual({ orgWide: true, personal: true });
    expect(p.tasks).toEqual({ maxTurns: 40, maxHours: 8, maxRunning: 10 });
  });

  it("a PUT of one limit saves only it, audited as tasks.maxTurns; out-of-range limits are 400; members 403", async () => {
    const before = (await audits("bot_policy.updated")).length;
    const p = await ok(putPolicy({ tasks: { maxTurns: 12 } }));
    expect(p.tasks).toEqual({ maxTurns: 12, maxHours: 8, maxRunning: 10 });
    expect((await ok(admin.request("GET", "/api/v1/bot-policy"))).tasks).toEqual({
      maxTurns: 12,
      maxHours: 8,
      maxRunning: 10,
    });
    const rows = await audits("bot_policy.updated");
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)!.metadata.changed).toEqual(["tasks.maxTurns"]);
    const stored = (
      await su.query(
        "select task_max_turns, task_max_hours, max_running_tasks from app.bot_policies where organization_id = $1",
        [orgId],
      )
    ).rows[0];
    expect(stored).toEqual({ task_max_turns: 12, task_max_hours: 8, max_running_tasks: 10 });

    for (const tasks of [{ maxTurns: 201 }, { maxHours: 0 }, { maxRunning: 101 }]) {
      expect((await putPolicy({ tasks })).status, JSON.stringify(tasks)).toBe(400);
    }
    expect((await sam.request("PUT", "/api/v1/bot-policy", { tasks: { maxTurns: 200 } })).status).toBe(403);
    expect((await ok(admin.request("GET", "/api/v1/bot-policy"))).tasks.maxTurns).toBe(12);
    expect(await audits("bot_policy.updated")).toHaveLength(before + 1);
  });

  it("loadTaskPolicy: the bot's toggle, then the organization's switch, then the personal one, with the limits", async () => {
    expect(await taskPolicyOf(teamBotId)).toEqual({
      enabled: true,
      reason: null,
      maxTurns: 12,
      maxHours: 8,
      maxRunning: 10,
    });
    await ok(putPolicy({ capabilities: { longTasks: { orgWide: true, personal: false } } }));
    try {
      expect(await taskPolicyOf(samBotId)).toMatchObject({ enabled: false, reason: "personal_policy" });
      expect(await taskPolicyOf(teamBotId)).toMatchObject({ enabled: true, reason: null });
      await ok(putPolicy({ capabilities: { longTasks: { orgWide: false, personal: false } } }));
      expect(await taskPolicyOf(teamBotId)).toMatchObject({ enabled: false, reason: "org_policy" });
      const rows = await audits("bot_policy.updated");
      expect(rows.at(-1)!.metadata.changed).toEqual(["capabilities.longTasks"]);
    } finally {
      await ok(putPolicy({ capabilities: { longTasks: { orgWide: true, personal: true } } }));
    }
    const stored = (await su.query("select capabilities from app.agents where id = $1", [teamBotId])).rows[0]
      .capabilities as Json;
    await su.query("update app.agents set capabilities = $2 where id = $1", [
      teamBotId,
      { ...stored, longTasks: false },
    ]);
    try {
      expect(await taskPolicyOf(teamBotId)).toMatchObject({ enabled: false, reason: null });
    } finally {
      await su.query("update app.agents set capabilities = $2 where id = $1", [teamBotId, stored]);
    }
  });

  it("every turn knows whether its bot may run a long task (computeTurn.longTasks)", async () => {
    expect(await longTasksOnTurn(teamBotId, adminId, "channel")).toBe(true);
    await ok(putPolicy({ capabilities: { longTasks: { orgWide: false, personal: true } } }));
    try {
      expect(await longTasksOnTurn(teamBotId, adminId, "channel")).toBe(false);
      expect(await longTasksOnTurn(samBotId, samId, "dm")).toBe(false);
    } finally {
      await ok(putPolicy({ capabilities: { longTasks: { orgWide: true, personal: true } } }));
    }
    expect(await longTasksOnTurn(samBotId, samId, "dm")).toBe(true);
  });

  it("the bot's view: a stored bot without the key reads Long tasks on and effective", async () => {
    const stored = (await su.query("select capabilities from app.agents where id = $1", [teamBotId])).rows[0]
      .capabilities as Json;
    expect(stored).not.toHaveProperty("longTasks");
    const v = await ok(admin.request("GET", `/api/v1/agents/${teamBotId}/capabilities`));
    expect(v.capabilities.longTasks).toBe(true);
    expect(v.effective.longTasks).toEqual({ enabled: true, effective: true, reason: null });
  });

  it("PATCH longTasks is saved and audited like internet; others are refused like internet (403 / 404)", async () => {
    const audited = async () =>
      (await audits("agent.capabilities_updated")).filter((r) => r.resource_id === samBotId);
    const before = (await audited()).length;
    const v = await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { longTasks: false }));
    expect(v.capabilities.longTasks).toBe(false);
    expect(v.effective.longTasks).toEqual({ enabled: false, effective: false, reason: null });
    const row = (await su.query("select capabilities from app.agents where id = $1", [samBotId])).rows[0];
    expect(row.capabilities).toMatchObject({ longTasks: false });
    const rows = await audited();
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)!.user_id).toBe(samId);
    expect(rows.at(-1)!.metadata.changed).toEqual(["longTasks"]);
    expect(await taskPolicyOf(samBotId)).toMatchObject({ enabled: false, reason: null });
    expect(await longTasksOnTurn(samBotId, samId, "dm")).toBe(false);

    // A no-op PATCH neither audits nor changes anything.
    await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { longTasks: false }));
    expect(await audited()).toHaveLength(before + 1);

    expect(
      (await sam.request("PATCH", `/api/v1/agents/${teamBotId}/capabilities`, { longTasks: false })).status,
    ).toBe(403);
    expect(
      (await admin.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { longTasks: true })).status,
    ).toBe(404);
    const { db } = stack.built.core;
    expect(
      await db.withTenant({ organizationId: orgB, userId: userB }, (tx) => findBot(tx, samBotId)),
    ).toBeNull();
    await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { longTasks: true }));
  });

  it("with the organization switch off, the toggle is answered as internet's under org_policy", async () => {
    await ok(admin.request("PATCH", `/api/v1/agents/${teamBotId}/capabilities`, { longTasks: false }));
    const internetBefore = (await ok(admin.request("GET", `/api/v1/agents/${teamBotId}/capabilities`)))
      .capabilities.internet as boolean;
    const denied = { orgWide: false, personal: true };
    await ok(putPolicy({ capabilities: { longTasks: denied, internet: denied } }));
    try {
      const off = await ok(admin.request("GET", `/api/v1/agents/${teamBotId}/capabilities`));
      expect(off.effective.longTasks).toEqual({ enabled: false, effective: false, reason: "org_policy" });
      const patched = await admin.request("PATCH", `/api/v1/agents/${teamBotId}/capabilities`, {
        longTasks: true,
      });
      const internet = await admin.request("PATCH", `/api/v1/agents/${teamBotId}/capabilities`, {
        internet: !internetBefore,
      });
      // Both switches under org_policy: stored, and never effective while the organization says no.
      expect([patched.status, codeOf(patched)]).toEqual([internet.status, codeOf(internet)]);
      expect((internet.body as Json).effective.internet.reason).toBe("org_policy");
      expect((patched.body as Json).effective.longTasks).toEqual({
        enabled: true,
        effective: false,
        reason: "org_policy",
      });
      expect(await taskPolicyOf(teamBotId)).toMatchObject({ enabled: false, reason: "org_policy" });
    } finally {
      const allow = { orgWide: true, personal: true };
      await ok(putPolicy({ capabilities: { longTasks: allow, internet: allow } }));
      await ok(
        admin.request("PATCH", `/api/v1/agents/${teamBotId}/capabilities`, { internet: internetBefore }),
      );
    }
    const back = await ok(admin.request("GET", `/api/v1/agents/${teamBotId}/capabilities`));
    expect(back.effective.longTasks).toEqual({ enabled: true, effective: true, reason: null });
  });

  it("organization B reads its own defaults after A saved limits (E22)", async () => {
    const { db } = stack.built.core;
    const policyB = await db.withTenant({ organizationId: orgB, userId: userB }, (tx) => loadPolicy(tx));
    expect(policyB.tasks).toEqual({ maxTurns: 40, maxHours: 8, maxRunning: 10 });
    expect(policyB.capabilities.longTasks).toEqual({ orgWide: true, personal: true });
    expect(policyB.updatedAt).toBeNull();
    // Not vacuous: A's saved limit is read in A.
    const policyA = await db.withTenant({ organizationId: orgId, userId: adminId }, (tx) => loadPolicy(tx));
    expect(policyA.tasks.maxTurns).toBe(12);
  });
});
