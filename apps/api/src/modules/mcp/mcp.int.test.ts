import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import type { AgentChannelMcpProbeResult } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "../../lib/errors";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { cellMcpServers, getMcpServer, listMcpServers, recordProbeResult } from "./index";

/**
 * 03.1-09 (BOT-08, BOT-10, SC6 registry half): Organization Admins register MCP servers with write-only
 * credentials; the cell is asked to discover the tools; recorded tools become grantable, policy-capped bot
 * capabilities. Real PostgreSQL + Redis.
 */

const CELL_TOKEN = "ocw-test-cell-token-mcp-registry-0123456789ab";
const SECRET = "s3cr3t-token";
const ADMIN = {
  name: "Víctor Ruiz",
  email: "victor@example.test",
  password: "correct-horse-battery",
  orgName: "Autofy Labs",
};

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let orgId: string;
let samId: string;
const logLines: string[] = [];

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

const audits = async (action: string) =>
  (
    await su.query(
      "select resource_id, user_id, metadata from app.audit_events where action = $1 and organization_id = $2 order by occurred_at",
      [action, orgId],
    )
  ).rows as Array<{ resource_id: string; user_id: string | null; metadata: Json }>;

const cellEvents = async (type: string) =>
  (
    await su.query("select payload from app.stream_events where stream_id = $1 and type = $2 order by seq", [
      `cell:${orgId}`,
      type,
    ])
  ).rows.map((r) => r.payload as Json);

const asTenant = <T>(fn: Parameters<TestStack["built"]["core"]["db"]["withTenant"]>[1]) =>
  stack.built.core.db.withTenant({ organizationId: orgId, userId: null }, fn) as Promise<T>;

const DOCS = {
  name: "Docs",
  transport: "streamable-http",
  url: "https://mcp.example.com/mcp",
  headers: [{ name: "Authorization", value: `Bearer ${SECRET}` }],
};

beforeAll(async () => {
  stack = await startTestStack({
    env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock", LOG_LEVEL: "info" },
    logStream: { write: (line: string) => void logLines.push(line) },
  });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN }));
  orgId = setup.organization.id;
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee", "developer");
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("registry (D-13, BOT-08)", () => {
  let docsId: string;

  it("an admin registers a server: safe name, probing, header names only, secret stored as mcp_credential", async () => {
    const res = await admin.request("POST", "/api/v1/mcp-servers", DOCS);
    expect(res.status).toBe(200);
    const body = res.body as Json;
    docsId = body.id;
    expect(body).toMatchObject({
      name: "Docs",
      transport: "streamable-http",
      url: "https://mcp.example.com/mcp",
      sandboxServer: null,
      headers: [{ name: "Authorization", hasValue: true }],
      orgEnabled: true,
      personalAllowed: false,
      trustedChaining: false,
      status: "probing",
      tools: [],
    });
    expect(body.safeName).toMatch(/^m[0-9a-f]{8}$/);
    // The credential never comes back.
    expect(JSON.stringify(body)).not.toContain(SECRET);

    const stored = (await su.query("select headers from app.mcp_servers where id = $1", [docsId]))
      .rows[0] as Json;
    expect(stored.headers).toHaveLength(1);
    expect(JSON.stringify(stored.headers)).not.toContain(SECRET);
    const secret = (
      await su.query("select kind, ciphertext from app.secrets where id = $1", [stored.headers[0].secretId])
    ).rows[0] as Json;
    expect(secret.kind).toBe("mcp_credential");
    expect(secret.ciphertext).not.toContain(SECRET);

    // Audited with names and host only; the probe event carries ids only.
    const created = await audits("mcp.server.created");
    expect(created).toHaveLength(1);
    expect(created[0]?.metadata).toMatchObject({
      name: "Docs",
      transport: "streamable-http",
      host: "mcp.example.com",
      headerNames: ["Authorization"],
    });
    const allAudits = (
      await su.query("select metadata from app.audit_events where organization_id = $1", [orgId])
    ).rows;
    expect(JSON.stringify(allAudits)).not.toContain(SECRET);
    const probes = await cellEvents("mcp.probe");
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({
      type: "mcp.probe",
      organizationId: orgId,
      cellId: orgId,
      serverId: docsId,
    });
    expect(JSON.stringify(probes)).not.toContain(SECRET);
    expect((await cellEvents("cell.config.changed")).at(-1)).toMatchObject({ reason: "tools.updated" });
    expect(logLines.join("\n")).not.toContain(SECRET);
  });

  it("GET lists and reads the server without the value; the sandbox is reported unavailable", async () => {
    const list = await ok(admin.request("GET", "/api/v1/mcp-servers"));
    expect(list.sandbox).toEqual({ available: false, servers: [] });
    expect(list.servers.map((s: Json) => s.id)).toEqual([docsId]);
    const one = await ok(admin.request("GET", `/api/v1/mcp-servers/${docsId}`));
    expect(one.headers).toEqual([{ name: "Authorization", hasValue: true }]);
    expect(JSON.stringify([list, one])).not.toContain(SECRET);
    expect((await admin.request("GET", `/api/v1/mcp-servers/${randomUUID()}`)).status).toBe(404);
  });

  it("only the cell snapshot builder reveals the credential, as an env-var reference", async () => {
    const [docs] = await asTenant<Json[]>((tx) => cellMcpServers(stack.built.core, tx));
    const safe = (await ok(admin.request("GET", `/api/v1/mcp-servers/${docsId}`))).safeName as string;
    expect(docs).toEqual({
      id: docsId,
      safeName: safe,
      transport: "streamable-http",
      url: "https://mcp.example.com/mcp",
      headers: [
        { name: "Authorization", envName: `OCW_MCP_${safe.toUpperCase()}_0`, value: `Bearer ${SECRET}` },
      ],
      tools: [],
    });
  });

  it("refuses unsafe URLs, missing values, reserved and duplicate headers", async () => {
    const bad = async (body: Json, code: string) => {
      const r = await admin.request("POST", "/api/v1/mcp-servers", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(codeOf(r)).toBe(code);
    };
    await bad({ ...DOCS, url: "http://169.254.169.254/latest" }, "invalid_url");
    await bad({ ...DOCS, url: "http://mcp.example.com/mcp" }, "invalid_url");
    await bad({ name: "No url", transport: "sse" }, "url_required");
    await bad({ ...DOCS, headers: [{ name: "Authorization", keep: true }] }, "header_value_required");
    await bad({ ...DOCS, headers: [{ name: "Host", value: "evil" }] }, "reserved_header");
    await bad(
      {
        ...DOCS,
        headers: [
          { name: "X-Key", value: "a" },
          { name: "x-key", value: "b" },
        ],
      },
      "duplicate_header",
    );
    await bad({ ...DOCS, headers: [{ name: "X-Key", value: "a\r\nX-Evil: 1" }] }, "invalid_header_value");
    await bad({ ...DOCS, sandboxServer: "everything" }, "sandbox_server_not_allowed");
  });

  it("developers get 403 mcp.manage on every route", async () => {
    const denied = await sam.request("POST", "/api/v1/mcp-servers", DOCS);
    expect(denied.status).toBe(403);
    expect((denied.body as Json).error.details).toMatchObject({ permission: "mcp.manage" });
    expect((await sam.request("GET", "/api/v1/mcp-servers")).status).toBe(403);
    expect((await sam.request("GET", `/api/v1/mcp-servers/${docsId}`)).status).toBe(403);
    expect((await sam.request("PATCH", `/api/v1/mcp-servers/${docsId}`, { orgEnabled: false })).status).toBe(
      403,
    );
    expect((await sam.request("POST", `/api/v1/mcp-servers/${docsId}/probe`)).status).toBe(403);
    expect((await sam.request("DELETE", `/api/v1/mcp-servers/${docsId}`)).status).toBe(403);
  });

  it("cross-tenant: another organization sees nothing (RLS → 404)", async () => {
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
    const { core } = stack.built;
    const ctxB = { organizationId: orgB, userId: userB };
    expect(await core.db.withTenant(ctxB, (tx) => listMcpServers(tx))).toEqual([]);
    expect(await core.db.withTenant(ctxB, (tx) => cellMcpServers(core, tx))).toEqual([]);
    const err = await core.db.withTenant(ctxB, (tx) => getMcpServer(tx, docsId)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(404);
    // Not vacuous: the right tenant finds it.
    expect((await asTenant<Json>((tx) => getMcpServer(tx, docsId))).id).toBe(docsId);
  });

  it("PATCH keep reuses the secret; a new value replaces it and removes the old secret row", async () => {
    const secretIdOf = async () =>
      ((await su.query("select headers from app.mcp_servers where id = $1", [docsId])).rows[0] as Json)
        .headers[0].secretId as string;
    const before = await secretIdOf();
    const probesBefore = (await cellEvents("mcp.probe")).length;

    const kept = await ok(
      admin.request("PATCH", `/api/v1/mcp-servers/${docsId}`, {
        name: "Docs v2",
        headers: [{ name: "Authorization", keep: true }],
      }),
    );
    expect(kept).toMatchObject({ name: "Docs v2", headers: [{ name: "Authorization", hasValue: true }] });
    expect(await secretIdOf()).toBe(before);
    // Nothing that reaches the cell changed: no re-probe.
    expect((await cellEvents("mcp.probe")).length).toBe(probesBefore);

    const replaced = await ok(
      admin.request("PATCH", `/api/v1/mcp-servers/${docsId}`, {
        headers: [{ name: "Authorization", value: "Bearer rotated-token" }],
      }),
    );
    expect(JSON.stringify(replaced)).not.toContain("rotated-token");
    const after = await secretIdOf();
    expect(after).not.toBe(before);
    expect((await su.query("select 1 from app.secrets where id = $1", [before])).rowCount).toBe(0);
    // New credentials: the cell probes again.
    expect((await cellEvents("mcp.probe")).length).toBe(probesBefore + 1);

    const updated = await audits("mcp.server.updated");
    expect(updated.at(-1)?.metadata).toMatchObject({ changed: ["headers"], headerNames: ["Authorization"] });
    expect(JSON.stringify(updated)).not.toContain("rotated-token");

    // A flag-only PATCH keeps the headers (no create defaults leak into an update).
    const flagged = await ok(
      admin.request("PATCH", `/api/v1/mcp-servers/${docsId}`, { trustedChaining: true }),
    );
    expect(flagged.headers).toEqual([{ name: "Authorization", hasValue: true }]);
    expect(await secretIdOf()).toBe(after);
    await ok(admin.request("PATCH", `/api/v1/mcp-servers/${docsId}`, { trustedChaining: false }));

    // keep on a header that was never stored is refused.
    const r = await admin.request("PATCH", `/api/v1/mcp-servers/${docsId}`, {
      headers: [{ name: "X-Other", keep: true }],
    });
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("header_value_required");
  });

  it("POST /:id/probe asks the cell again and audits the request", async () => {
    const before = (await cellEvents("mcp.probe")).length;
    const body = await ok(admin.request("POST", `/api/v1/mcp-servers/${docsId}/probe`));
    expect(body.status).toBe("probing");
    const probes = await cellEvents("mcp.probe");
    expect(probes.length).toBe(before + 1);
    const requested = await audits("mcp.server.probe_requested");
    expect(requested.at(-1)).toMatchObject({ resource_id: docsId });
    expect(requested.at(-1)?.metadata.probeId).toBe(probes.at(-1)?.probeId);
  });

  it("an org-disabled server is not probed and is not sent to the cell", async () => {
    await ok(admin.request("PATCH", `/api/v1/mcp-servers/${docsId}`, { orgEnabled: false }));
    expect(await asTenant<Json[]>((tx) => cellMcpServers(stack.built.core, tx))).toEqual([]);
    const r = await admin.request("POST", `/api/v1/mcp-servers/${docsId}/probe`);
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("server_disabled");
    const before = (await cellEvents("mcp.probe")).length;
    await ok(admin.request("PATCH", `/api/v1/mcp-servers/${docsId}`, { orgEnabled: true }));
    // Re-enabled: probed again.
    expect((await cellEvents("mcp.probe")).length).toBe(before + 1);
  });
});

describe("sandboxed stdio servers (D-13)", () => {
  const env = () => stack.built.core.env;

  it("without OCW_MCP_SANDBOX_URL: 409 sandbox_unavailable", async () => {
    const r = await admin.request("POST", "/api/v1/mcp-servers", {
      name: "Everything",
      transport: "sandboxed-stdio",
      sandboxServer: "everything",
    });
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("sandbox_unavailable");
  });

  it("with the sandbox: a vetted server is exposed to the cell as streamable HTTP on the sidecar", async () => {
    env().OCW_MCP_SANDBOX_URL = "http://mcp-sandbox:8080/";
    env().OCW_MCP_SANDBOX_SERVERS = ["everything"];
    try {
      const list = await ok(admin.request("GET", "/api/v1/mcp-servers"));
      expect(list.sandbox).toEqual({ available: true, servers: ["everything"] });

      const unknown = await admin.request("POST", "/api/v1/mcp-servers", {
        name: "Shell",
        transport: "sandboxed-stdio",
        sandboxServer: "shell",
      });
      expect(unknown.status).toBe(400);
      expect(codeOf(unknown)).toBe("unknown_sandbox_server");

      const created = await ok(
        admin.request("POST", "/api/v1/mcp-servers", {
          name: "Everything",
          transport: "sandboxed-stdio",
          sandboxServer: "everything",
        }),
      );
      expect(created).toMatchObject({ transport: "sandboxed-stdio", sandboxServer: "everything", url: null });
      const cell = await asTenant<Json[]>((tx) => cellMcpServers(stack.built.core, tx));
      expect(cell.find((s) => s.id === created.id)).toEqual({
        id: created.id,
        safeName: created.safeName,
        transport: "streamable-http",
        url: "http://mcp-sandbox:8080/everything/mcp",
        headers: [],
        tools: [],
      });
      await ok(admin.request("DELETE", `/api/v1/mcp-servers/${created.id}`));
    } finally {
      env().OCW_MCP_SANDBOX_URL = null;
      env().OCW_MCP_SANDBOX_SERVERS = [];
    }
  });
});

describe("DELETE (D-13)", () => {
  it("removes the server, its secrets, tools and every grant; tells the cell; audits", async () => {
    const created = await ok(admin.request("POST", "/api/v1/mcp-servers", { ...DOCS, name: "Temp" }));
    const id = created.id as string;
    const secretIds = (
      ((await su.query("select headers from app.mcp_servers where id = $1", [id])).rows[0] as Json)
        .headers as Json[]
    ).map((h) => h.secretId);
    const team = await ok(
      admin.request("POST", "/api/v1/agents", {
        name: "Deleter",
        instructions: "You are a test bot.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    );
    await su.query(
      `insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only)
       values ($1, $2, 'echo', $3, true)`,
      [orgId, id, `${created.safeName}__echo`],
    );
    await su.query(
      `insert into app.bot_tool_grants (organization_id, agent_id, source_kind, source_id, tool_name)
       values ($1, $2, 'mcp', $3, $4)`,
      [orgId, team.id, id, `${created.safeName}__echo`],
    );
    const changesBefore = (await cellEvents("cell.config.changed")).length;

    expect(await ok(admin.request("DELETE", `/api/v1/mcp-servers/${id}`))).toEqual({ ok: true });

    expect((await su.query("select 1 from app.mcp_servers where id = $1", [id])).rowCount).toBe(0);
    expect((await su.query("select 1 from app.mcp_server_tools where server_id = $1", [id])).rowCount).toBe(
      0,
    );
    expect((await su.query("select 1 from app.bot_tool_grants where source_id = $1", [id])).rowCount).toBe(0);
    expect(
      (await su.query("select 1 from app.secrets where id = any($1::uuid[])", [secretIds])).rowCount,
    ).toBe(0);
    const changes = await cellEvents("cell.config.changed");
    expect(changes.length).toBe(changesBefore + 1);
    expect(changes.at(-1)).toMatchObject({ reason: "tools.updated", agentId: null });
    expect((await audits("mcp.server.deleted")).at(-1)).toMatchObject({ resource_id: id });
    expect((await admin.request("GET", `/api/v1/mcp-servers/${id}`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------- Task 3: probe → catalog → grants → policy

const FAKE_SERVER = fileURLToPath(new URL("../../../../../infra/fake-model/server.mjs", import.meta.url));
const FAKE_TOKEN = "fake-mcp-int-token";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** What the cell does in a probe, against the real fake MCP server: initialize, initialized, tools/list. */
async function probeFakeMcp(base: string): Promise<NonNullable<AgentChannelMcpProbeResult["tools"]>> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${FAKE_TOKEN}`,
  };
  const init = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "ocw-int", version: "1" },
      },
    }),
  });
  expect(init.status).toBe(200);
  const session = init.headers.get("mcp-session-id") as string;
  const withSession = { ...headers, "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" };
  await fetch(`${base}/mcp`, {
    method: "POST",
    headers: withSession,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  const list = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: withSession,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  const body = (await list.json()) as Json;
  return (body.result.tools as Json[]).map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    annotations: {
      readOnlyHint: t.annotations?.readOnlyHint,
      destructiveHint: t.annotations?.destructiveHint,
    },
  }));
}

const mentionsFor = async (agentId: string) =>
  (
    await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'agent'->>'id' = $2 order by seq",
      [`cell:${orgId}`, agentId],
    )
  ).rows.map((r) => r.payload as Json);

async function turnFor(agentId: string, messageId: string): Promise<Json> {
  const ev = (await mentionsFor(agentId)).at(-1);
  expect(ev?.message.id).toBe(messageId);
  return ev?.turn as Json;
}

const say = async (c: TestClient, conversationId: string, body: string, mentions: Json[] = []) =>
  (await ok(c.request("POST", `/api/v1/conversations/${conversationId}/messages`, { body, mentions })))
    .id as string;

describe("probe results become policy-capped bot capabilities (BOT-10, SC6)", () => {
  let fake: ChildProcess;
  let fakeBase: string;
  let notes: Json;
  let safe: string;
  let echoName: string;
  let noteName: string;
  let samBotId: string;
  let samDmId: string;
  let teamBotId: string;
  let channelId: string;

  const latestProbe = async () =>
    (await cellEvents("mcp.probe")).filter((p) => p.serverId === notes.id).at(-1);
  const record = (r: AgentChannelMcpProbeResult) =>
    asTenant<{ applied: boolean }>((tx) => recordProbeResult(stack.built.core, tx, r));
  const view = async (c: TestClient, botId: string) =>
    ok(c.request("GET", `/api/v1/agents/${botId}/capabilities`));
  const toolOf = (v: Json, name: string) => (v.tools as Json[]).find((t) => t.tool === name);

  beforeAll(async () => {
    const port = await freePort();
    fake = spawn(process.execPath, [FAKE_SERVER], {
      env: { ...process.env, PORT: String(port), FAKE_MCP_TOKEN: FAKE_TOKEN },
      stdio: "ignore",
    });
    fakeBase = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      const up = await fetch(`${fakeBase}/health`).then(
        (r) => r.ok,
        () => false,
      );
      if (up) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    notes = await ok(
      admin.request("POST", "/api/v1/mcp-servers", {
        name: "Notes",
        transport: "streamable-http",
        url: "http://fake-model:18999/mcp",
        headers: [{ name: "Authorization", value: `Bearer ${SECRET}` }],
      }),
    );
    safe = notes.safeName;
    echoName = `${safe}__echo`;
    noteName = `${safe}__write_note`;
    const personal = await ok(sam.request("POST", "/api/v1/agents/personal", {}));
    samBotId = personal.agent.id;
    samDmId = personal.dmId;
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
  });

  afterAll(() => {
    fake?.kill();
  });

  it("a failed probe stores a redacted reason; the tools stay unusable", async () => {
    const probe = await latestProbe();
    const res = await record({
      probeId: probe?.probeId,
      serverId: notes.id,
      ok: false,
      error: `401 Unauthorized for Authorization: Bearer ${SECRET}`,
    });
    expect(res).toEqual({ applied: true });
    const s = await ok(admin.request("GET", `/api/v1/mcp-servers/${notes.id}`));
    expect(s).toMatchObject({ status: "error", tools: [] });
    expect(s.statusDetail).toContain("[redacted]");
    expect(s.statusDetail).not.toContain(SECRET);
    expect((await audits("mcp.server.probed")).at(-1)?.metadata).toEqual({ ok: false, toolCount: 0 });
  });

  it("the fake MCP's tool list, recorded: ready, two catalog entries named <safe>__<tool>", async () => {
    await ok(admin.request("POST", `/api/v1/mcp-servers/${notes.id}/probe`));
    const probe = await latestProbe();
    const tools = await probeFakeMcp(fakeBase);
    expect(tools.map((t) => t.name)).toEqual(["echo", "write_note"]);
    const changes = (await cellEvents("cell.config.changed")).length;
    expect(await record({ probeId: probe?.probeId, serverId: notes.id, ok: true, tools })).toEqual({
      applied: true,
    });

    const s = await ok(admin.request("GET", `/api/v1/mcp-servers/${notes.id}`));
    expect(s.status).toBe("ready");
    expect(s.statusDetail).toBeNull();
    expect(s.probedAt).not.toBeNull();
    expect(s.tools).toEqual([
      {
        name: "echo",
        openclawName: echoName,
        title: "Echo",
        description: expect.any(String),
        readOnly: true,
        destructive: false,
      },
      {
        name: "write_note",
        openclawName: noteName,
        title: "Write note",
        description: expect.any(String),
        readOnly: false,
        destructive: true,
      },
    ]);
    const rows = (
      await su.query(
        "select name, openclaw_name, read_only, destructive from app.mcp_server_tools where server_id = $1 order by name",
        [notes.id],
      )
    ).rows;
    expect(rows).toEqual([
      { name: "echo", openclaw_name: echoName, read_only: true, destructive: false },
      { name: "write_note", openclaw_name: noteName, read_only: false, destructive: true },
    ]);
    expect((await audits("mcp.server.probed")).at(-1)?.metadata).toEqual({ ok: true, toolCount: 2 });
    expect((await cellEvents("cell.config.changed")).length).toBe(changes + 1);
  });

  it("a stale probe report (not the newest probe) is ignored", async () => {
    const res = await record({ probeId: randomUUID(), serverId: notes.id, ok: true, tools: [] });
    expect(res).toEqual({ applied: false });
    expect((await ok(admin.request("GET", `/api/v1/mcp-servers/${notes.id}`))).tools).toHaveLength(2);
  });

  it("Sam grants echo to his personal bot: personal_policy until the admin allows the server for personal bots", async () => {
    const patched = await ok(
      sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, {
        tools: [{ sourceKind: "mcp", sourceId: notes.id, tool: echoName }],
      }),
    );
    expect(toolOf(patched, echoName)).toMatchObject({
      sourceName: "Notes",
      granted: true,
      effective: false,
      reason: "personal_policy",
      sideEffecting: false,
    });
    const blocked = await say(sam, samDmId, "Echo?");
    expect((await turnFor(samBotId, blocked)).tools).not.toContain(echoName);

    await ok(admin.request("PATCH", `/api/v1/mcp-servers/${notes.id}`, { personalAllowed: true }));
    expect(toolOf(await view(sam, samBotId), echoName)).toMatchObject({ effective: true, reason: null });
    const allowed = await say(sam, samDmId, "Echo now?");
    const turn = await turnFor(samBotId, allowed);
    expect(turn.tools).toContain(echoName);
    expect(turn.toolFlags[echoName]).toEqual({ untrustedOutput: true, sideEffecting: false });

    // The cell's toolFilter.include now names echo (raw MCP name), never write_note (granted nowhere).
    const cell = await asTenant<Json[]>((tx) => cellMcpServers(stack.built.core, tx));
    expect(cell.find((c) => c.id === notes.id)?.tools).toEqual(["echo"]);
  });

  it("write_note on a team bot is side-effecting unless the server is trusted for chained calls", async () => {
    await ok(
      admin.request("PATCH", `/api/v1/agents/${teamBotId}/capabilities`, {
        tools: [{ sourceKind: "mcp", sourceId: notes.id, tool: noteName }],
      }),
    );
    const mention = [{ kind: "agent", id: teamBotId }];
    const first = await say(admin, channelId, "@scribe note this", mention);
    const turn = await turnFor(teamBotId, first);
    expect(turn.tools).toEqual([noteName]);
    expect(turn.toolFlags[noteName]).toEqual({ untrustedOutput: true, sideEffecting: true });

    await ok(admin.request("PATCH", `/api/v1/mcp-servers/${notes.id}`, { trustedChaining: true }));
    try {
      const trusted = await say(admin, channelId, "@scribe and this", mention);
      expect((await turnFor(teamBotId, trusted)).toolFlags[noteName]).toEqual({
        untrustedOutput: true,
        sideEffecting: false,
      });
    } finally {
      await ok(admin.request("PATCH", `/api/v1/mcp-servers/${notes.id}`, { trustedChaining: false }));
    }
    const cell = await asTenant<Json[]>((tx) => cellMcpServers(stack.built.core, tx));
    expect(cell.find((c) => c.id === notes.id)?.tools).toEqual(["echo", "write_note"]);
  });

  it("an admin denies one MCP tool to Sam through the rules API: denied_for_you, absent from his turn", async () => {
    const created = await ok(
      admin.request("POST", "/api/v1/permission-rules", {
        subjectKind: "user",
        subjectId: samId,
        permission: "bot.tool.use",
        tool: echoName,
        effect: "deny",
      }),
    );
    expect(created).toMatchObject({ permission: "bot.tool.use", tool: echoName, effect: "deny" });
    try {
      expect(toolOf(await view(sam, samBotId), echoName)).toMatchObject({
        granted: true,
        effective: false,
        reason: "denied_for_you",
      });
      const denied = await say(sam, samDmId, "Echo again?");
      expect((await turnFor(samBotId, denied)).tools).not.toContain(echoName);
    } finally {
      await ok(admin.request("DELETE", `/api/v1/permission-rules/${created.id}`));
    }
    const back = await say(sam, samDmId, "Echo once more?");
    expect((await turnFor(samBotId, back)).tools).toContain(echoName);
  });

  it("a later probe without echo deletes the tool and every grant of it", async () => {
    await ok(admin.request("POST", `/api/v1/mcp-servers/${notes.id}/probe`));
    const probe = await latestProbe();
    const tools = (await probeFakeMcp(fakeBase)).filter((t) => t.name !== "echo");
    expect(await record({ probeId: probe?.probeId, serverId: notes.id, ok: true, tools })).toEqual({
      applied: true,
    });

    const s = await ok(admin.request("GET", `/api/v1/mcp-servers/${notes.id}`));
    expect(s.tools.map((t: Json) => t.openclawName)).toEqual([noteName]);
    expect(
      (
        await su.query("select 1 from app.bot_tool_grants where source_id = $1 and tool_name = $2", [
          notes.id,
          echoName,
        ])
      ).rowCount,
    ).toBe(0);
    // The team bot's write_note grant survives.
    expect(
      (
        await su.query("select 1 from app.bot_tool_grants where source_id = $1 and tool_name = $2", [
          notes.id,
          noteName,
        ])
      ).rowCount,
    ).toBe(1);
    expect(toolOf(await view(sam, samBotId), echoName)).toBeUndefined();
    expect((await audits("mcp.server.probed")).at(-1)?.metadata).toEqual({
      ok: true,
      toolCount: 1,
      removedTools: [echoName],
    });
    const next = await say(sam, samDmId, "Echo gone?");
    expect((await turnFor(samBotId, next)).tools).not.toContain(echoName);
  });
});
