import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * 03.1-10 (BOT-06, BOT-08, BOT-10; SC6 cell half): the cell's side of MCP. `/cell` delivers the org-enabled
 * servers (header values only over the cell channel), the cell reports what a probe found, every MCP tool call
 * goes through the tool gate (`POST /tool-calls`) and is audited with the server, and MCP output taints the
 * turn unless the admin trusts the server for chained calls. Real PostgreSQL + Redis.
 */

const CELL_TOKEN = "ocw-test-cell-token-mcp-cell-0123456789abcdef";
const SECRET = "mcp-cell-s3cr3t-value";
const FAKE_TOOLS = [
  {
    name: "echo",
    title: "Echo",
    description: "Echo the given text back. Read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "write_note",
    title: "Write note",
    description: "Store a note on the server. Has side effects.",
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let orgId: string;
let samId: string;
let samBotId: string;
let samDmId: string;
let server: Json;
let safe: string;
let echoName: string;
let noteName: string;
const logLines: string[] = [];

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function cell(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  token = CELL_TOKEN,
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${stack.baseUrl}/agent-channel/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

const audits = async (action: string) =>
  (
    await su.query(
      "select actor_kind, actor_id, agent_id, user_id, resource_type, resource_id, result, metadata from app.audit_events where action = $1 and organization_id = $2 order by occurred_at",
      [action, orgId],
    )
  ).rows as Json[];

const cellEvents = async (type: string) =>
  (
    await su.query("select payload from app.stream_events where stream_id = $1 and type = $2 order by seq", [
      `cell:${orgId}`,
      type,
    ])
  ).rows.map((r) => r.payload as Json);

const latestProbeId = async (serverId: string) =>
  (await cellEvents("mcp.probe")).filter((p) => p.serverId === serverId).at(-1)?.probeId as string;

/** The delivered event of a message (its turn). */
async function deliveredFor(messageId: string): Promise<Json> {
  const rows = (
    await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2",
      [`cell:${orgId}`, messageId],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0].payload as Json;
}

const say = async (c: TestClient, conversationId: string, body: string, mentions: Json[] = []) =>
  (await ok(c.request("POST", `/api/v1/conversations/${conversationId}/messages`, { body, mentions })))
    .id as string;

const askTool = (eventId: string, agentId: string, tool: string, params: Json = {}) =>
  cell("POST", "/tool-calls", { eventId, agentId, tool, params });

const cellServer = async () =>
  ((await ok(cell("GET", "/cell"))).mcpServers as Json[]).find((s) => s.id === server.id);

beforeAll(async () => {
  stack = await startTestStack({
    env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock", LOG_LEVEL: "info" },
    logStream: { write: (line: string) => void logLines.push(line) },
  });
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
  const inv = await ok(
    admin.request("POST", "/api/v1/invitations", { email: "sam@example.test", role: "developer" }),
  );
  sam = new TestClient(stack.baseUrl);
  const acc = await ok(
    sam.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
      name: "Sam Lee",
      password: "another-long-password",
    }),
  );
  const personal = await ok(sam.request("POST", "/api/v1/agents/personal", {}));
  samId = acc.user.id;
  samBotId = personal.agent.id;
  samDmId = personal.dmId;
  server = await ok(
    admin.request("POST", "/api/v1/mcp-servers", {
      name: "Notes",
      transport: "streamable-http",
      url: "http://fake-model:18999/mcp",
      headers: [{ name: "Authorization", value: `Bearer ${SECRET}` }],
      personalAllowed: true,
    }),
  );
  safe = server.safeName;
  echoName = `${safe}__echo`;
  noteName = `${safe}__write_note`;
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("GET /cell mcpServers and POST /mcp/probe-results (Task 1, D-13)", () => {
  it("lists the org-enabled server with header env names and values, no tools before any grant", async () => {
    const r = await cell("GET", "/cell");
    expect(r.status).toBe(200);
    expect(r.body.mcpServers).toEqual([
      {
        id: server.id,
        safeName: safe,
        transport: "streamable-http",
        url: "http://fake-model:18999/mcp",
        headers: [
          { name: "Authorization", envName: `OCW_MCP_${safe.toUpperCase()}_0`, value: `Bearer ${SECRET}` },
        ],
        tools: [],
      },
    ]);
    // The audit names the delivered servers, never a header value.
    const read = (await audits("agent_cell.config_read")).at(-1);
    expect(read?.metadata.mcpServers).toEqual([server.id]);
    expect(JSON.stringify(await audits("agent_cell.config_read"))).not.toContain(SECRET);
    expect(logLines.join("\n")).not.toContain(SECRET);
  });

  it("needs the cell token: a user session or a wrong token gets nothing", async () => {
    expect((await cell("GET", "/cell", undefined, "ocw_cell_wrong")).status).toBe(401);
    expect((await admin.request("GET", "/agent-channel/v1/cell")).status).toBe(401);
    const probeId = await latestProbeId(server.id);
    const r = await cell("POST", "/mcp/probe-results", { probeId, serverId: server.id, ok: true }, "nope");
    expect(r.status).toBe(401);
  });

  it("a failed probe marks the server error with the (redacted) message", async () => {
    const probeId = await latestProbeId(server.id);
    const r = await cell("POST", "/mcp/probe-results", {
      probeId,
      serverId: server.id,
      ok: false,
      error: `The MCP server refused the credentials (HTTP 401). Bearer ${SECRET}`,
    });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    const s = await ok(admin.request("GET", `/api/v1/mcp-servers/${server.id}`));
    expect(s.status).toBe("error");
    expect(s.statusDetail).toContain("refused the credentials (HTTP 401)");
    expect(s.statusDetail).not.toContain(SECRET);
    expect((await audits("mcp.server.probed")).at(-1)?.metadata).toEqual({ ok: false, toolCount: 0 });
  });

  it("a successful probe records the tools and marks the server ready; the cell is told", async () => {
    await ok(admin.request("POST", `/api/v1/mcp-servers/${server.id}/probe`));
    const changes = (await cellEvents("cell.config.changed")).length;
    const probeId = await latestProbeId(server.id);
    const r = await cell("POST", "/mcp/probe-results", {
      probeId,
      serverId: server.id,
      ok: true,
      tools: FAKE_TOOLS,
    });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    const s = await ok(admin.request("GET", `/api/v1/mcp-servers/${server.id}`));
    expect(s.status).toBe("ready");
    expect(s.tools.map((t: Json) => [t.openclawName, t.readOnly, t.destructive])).toEqual([
      [echoName, true, false],
      [noteName, false, true],
    ]);
    expect((await cellEvents("cell.config.changed")).length).toBe(changes + 1);
  });

  it("an unknown server is 404; a stale probe id is accepted and ignored", async () => {
    const missing = await cell("POST", "/mcp/probe-results", {
      probeId: "0199a000-0000-7000-8000-000000000001",
      serverId: "0199a000-0000-7000-8000-000000000002",
      ok: true,
      tools: [],
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("mcp_server_not_found");
    const stale = await cell("POST", "/mcp/probe-results", {
      probeId: "0199a000-0000-7000-8000-000000000003",
      serverId: server.id,
      ok: true,
      tools: [],
    });
    expect(stale.status).toBe(200);
    expect((await ok(admin.request("GET", `/api/v1/mcp-servers/${server.id}`))).tools).toHaveLength(2);
  });

  it("after a grant, /cell lists exactly the granted tool (raw MCP name) for toolFilter.include", async () => {
    expect((await cellServer())?.tools).toEqual([]);
    await ok(
      sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, {
        tools: [{ sourceKind: "mcp", sourceId: server.id, tool: echoName }],
      }),
    );
    expect((await cellServer())?.tools).toEqual(["echo"]);
    const bot = ((await ok(cell("GET", "/cell"))).agents as Json[]).find((a) => a.id === samBotId);
    expect(bot?.capabilities.tools).toContain(echoName);
    expect(bot?.capabilities.tools).not.toContain(noteName);
  });
});

describe("an MCP call in a conversation goes through the gate and is audited (Task 2, BOT-06, SC6)", () => {
  let eventId: string;

  it("the delivered turn offers exactly the enabled MCP tool with its taint flags; write_note never", async () => {
    const msg = await say(sam, samDmId, 'please echo [[call echo {"text":"hi from mcp"}]]');
    const ev = await deliveredFor(msg);
    eventId = ev.eventId;
    expect(ev.turn.tools).toContain(echoName);
    expect(ev.turn.tools).not.toContain(noteName);
    expect(ev.turn.toolFlags[echoName]).toEqual({ untrustedOutput: true, sideEffecting: false });
  });

  it("the call is allowed, recorded with the server as source and audited with bot, human, server and tool", async () => {
    const r = await askTool(eventId, samBotId, echoName);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ callId: expect.any(String), allowed: true, reason: null });
    const row = (await su.query("select * from app.agent_tool_calls where id = $1", [r.body.callId])).rows[0];
    expect(row).toMatchObject({
      event_id: eventId,
      agent_id: samBotId,
      user_id: samId,
      tool: echoName,
      source_kind: "mcp",
      source_id: server.id,
      target: safe,
      decision: "allowed",
      reason: null,
    });
    const audit = (await audits("bot.tool_call")).at(-1);
    expect(audit).toMatchObject({
      actor_kind: "agent",
      actor_id: samBotId,
      agent_id: samBotId,
      user_id: samId,
      resource_type: "tool",
      resource_id: echoName,
      result: "success",
    });
    expect(audit?.metadata).toMatchObject({
      tool: echoName,
      sourceKind: "mcp",
      sourceId: server.id,
      target: safe,
      reason: null,
    });

    const done = await cell("POST", `/tool-calls/${r.body.callId}/result`, { status: "ok", durationMs: 12 });
    expect(done.status).toBe(200);
    expect((await audits("bot.tool_call.completed")).at(-1)).toMatchObject({
      resource_id: echoName,
      result: "success",
      user_id: samId,
    });
  });

  it("a tool that is not enabled for the bot is refused at call time too: not_in_turn, audited", async () => {
    const r = await askTool(eventId, samBotId, noteName);
    expect(r.body).toMatchObject({ allowed: false, reason: "not_in_turn" });
    expect((await audits("bot.tool_call")).at(-1)).toMatchObject({
      resource_id: noteName,
      result: "denied",
      user_id: samId,
    });
  });

  it("a deny rule for the asking human: absent from the next turn (denied_for_you), policy_changed at call time", async () => {
    const before = await say(sam, samDmId, "echo before the rule");
    const delivered = (await deliveredFor(before)).eventId as string;
    const rule = await ok(
      admin.request("POST", "/api/v1/permission-rules", {
        subjectKind: "user",
        subjectId: samId,
        permission: "bot.tool.use",
        tool: echoName,
        effect: "deny",
      }),
    );
    try {
      const view = await ok(sam.request("GET", `/api/v1/agents/${samBotId}/capabilities`));
      expect((view.tools as Json[]).find((t) => t.tool === echoName)).toMatchObject({
        effective: false,
        reason: "denied_for_you",
      });
      const after = await say(sam, samDmId, "echo after the rule");
      expect((await deliveredFor(after)).turn.tools).not.toContain(echoName);
      // A turn delivered before the rule is re-decided at call time.
      const r = await askTool(delivered, samBotId, echoName);
      expect(r.body).toMatchObject({ allowed: false, reason: "policy_changed" });
      expect((await audits("bot.tool_call")).at(-1)?.metadata).toMatchObject({
        sourceKind: "mcp",
        target: safe,
        reason: "policy_changed",
      });
    } finally {
      await ok(admin.request("DELETE", `/api/v1/permission-rules/${rule.id}`));
    }
  });

  it("no audit row, tool call row or log line ever carries the credential", async () => {
    const all = (await su.query("select metadata from app.audit_events where organization_id = $1", [orgId]))
      .rows;
    expect(JSON.stringify(all)).not.toContain(SECRET);
    const calls = (await su.query("select * from app.agent_tool_calls where organization_id = $1", [orgId]))
      .rows;
    expect(JSON.stringify(calls)).not.toContain(SECRET);
    expect(logLines.join("\n")).not.toContain(SECRET);
  });
});

describe("MCP output taints the turn unless the server is trusted for chained calls (Task 3, D-08)", () => {
  let teamBotId: string;
  let channelId: string;
  const mention = () => [{ kind: "agent", id: teamBotId }];

  beforeAll(async () => {
    const team = await ok(
      admin.request("POST", "/api/v1/agents", {
        name: "Scribe",
        instructions: "You are Scribe.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    );
    teamBotId = team.id;
    channelId = (await ok(admin.request("POST", "/api/v1/channels", { name: "notes" }))).id;
    await ok(
      admin.request("PATCH", `/api/v1/agents/${teamBotId}/capabilities`, {
        tools: [
          { sourceKind: "mcp", sourceId: server.id, tool: echoName },
          { sourceKind: "mcp", sourceId: server.id, tool: noteName },
        ],
      }),
    );
  });

  it("one turn: echo is allowed, then write_note is refused as tainted; both decisions audited", async () => {
    const msg = await say(admin, channelId, "@scribe read then write", mention());
    const ev = await deliveredFor(msg);
    expect(ev.turn.tools).toEqual(expect.arrayContaining([echoName, noteName]));
    expect(ev.turn.toolFlags[noteName]).toEqual({ untrustedOutput: true, sideEffecting: true });

    const read = await askTool(ev.eventId, teamBotId, echoName);
    expect(read.body).toMatchObject({ allowed: true, reason: null });
    const write = await askTool(ev.eventId, teamBotId, noteName);
    expect(write.body).toMatchObject({ allowed: false, reason: "tainted" });

    const decisions = (await audits("bot.tool_call")).slice(-2);
    expect(decisions.map((a) => [a.resource_id, a.result, a.metadata.reason, a.metadata.sourceKind])).toEqual(
      [
        [echoName, "success", null, "mcp"],
        [noteName, "denied", "tainted", "mcp"],
      ],
    );
    const row = (
      await su.query("select tainted, tool_calls from app.agent_turns where event_id = $1", [ev.eventId])
    ).rows[0];
    expect(row).toEqual({ tainted: true, tool_calls: 1 });
  });

  it("with trustedChaining on the server, a new turn may write after reading; both allowed and audited", async () => {
    await ok(admin.request("PATCH", `/api/v1/mcp-servers/${server.id}`, { trustedChaining: true }));
    try {
      const msg = await say(admin, channelId, "@scribe read then write, trusted", mention());
      const ev = await deliveredFor(msg);
      expect(ev.turn.toolFlags[noteName]).toEqual({ untrustedOutput: true, sideEffecting: false });
      expect((await askTool(ev.eventId, teamBotId, echoName)).body).toMatchObject({ allowed: true });
      expect((await askTool(ev.eventId, teamBotId, noteName)).body).toMatchObject({
        allowed: true,
        reason: null,
      });
      const decisions = (await audits("bot.tool_call")).slice(-2);
      expect(decisions.map((a) => [a.resource_id, a.result])).toEqual([
        [echoName, "success"],
        [noteName, "success"],
      ]);
    } finally {
      await ok(admin.request("PATCH", `/api/v1/mcp-servers/${server.id}`, { trustedChaining: false }));
    }
  });

  it("revoking trust bites a turn delivered while trusted: the stricter (current) flags apply at call time", async () => {
    await ok(admin.request("PATCH", `/api/v1/mcp-servers/${server.id}`, { trustedChaining: true }));
    const msg = await say(admin, channelId, "@scribe trusted at delivery", mention());
    const ev = await deliveredFor(msg);
    expect(ev.turn.toolFlags[noteName]).toEqual({ untrustedOutput: true, sideEffecting: false });
    await ok(admin.request("PATCH", `/api/v1/mcp-servers/${server.id}`, { trustedChaining: false }));
    expect((await askTool(ev.eventId, teamBotId, echoName)).body).toMatchObject({ allowed: true });
    expect((await askTool(ev.eventId, teamBotId, noteName)).body).toMatchObject({
      allowed: false,
      reason: "tainted",
    });
  });
});
