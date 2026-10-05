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
let samBotId: string;
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
  await ok(
    sam.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
      name: "Sam Lee",
      password: "another-long-password",
    }),
  );
  const personal = await ok(sam.request("POST", "/api/v1/agents/personal", {}));
  samBotId = personal.agent.id;
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
