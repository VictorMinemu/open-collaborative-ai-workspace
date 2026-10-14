import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import type { AgentChannelMcpProbeResult } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "../../lib/errors";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { loadCatalog } from "../bot-capabilities";
import {
  cellMcpServers,
  getMcpServer,
  listMcpServers,
  oauthClientsOf,
  recordProbeResult,
  replaceServerTools,
  setOAuthStatus,
} from "./index";

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
    expect(JSON.stringify(body)).not.toContain("s3cr3t-token");

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
    expect(JSON.stringify(allAudits)).not.toContain("s3cr3t-token");
    const probes = await cellEvents("mcp.probe");
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({
      type: "mcp.probe",
      organizationId: orgId,
      cellId: orgId,
      serverId: docsId,
    });
    expect(JSON.stringify(probes)).not.toContain("s3cr3t-token");
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
    // 07.5-08: the admin may start Work Zone sessions, so the Work Zone proposal tools follow the card tool.
    expect(turn.tools).toEqual(["ocw_agent_card", "ocw_work_zone_projects", "ocw_start_work_zone", noteName]);
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

// ---------------------------------------------------------------- Phase 07.4-06: connector auth modes (D-01, CONN-01)

const CANARY = "CLIENT-SECRET-CANARY";
const CRM = {
  name: "Acme CRM",
  transport: "streamable-http",
  url: "https://mcp.example.com/mcp",
  authMode: "per_member_oauth",
  oauthScopes: ["crm.read", "crm.write"],
  oauthClient: { issuer: "https://auth.example.com", clientId: "ocw-production", clientSecret: CANARY },
};

describe("per-member connectors on the registry (07.4-06 tracer, D-01, C-01)", () => {
  let crmId: string;

  it("an admin registers a per-member OAuth connector: mode, scopes and the pre-registered client; the secret is sealed and write-only", async () => {
    const probesBefore = (await cellEvents("mcp.probe")).length;
    const body = await ok(admin.request("POST", "/api/v1/mcp-servers", CRM));
    crmId = body.id;
    expect(body).toMatchObject({
      name: "Acme CRM",
      authMode: "per_member_oauth",
      headers: [],
      status: "pending",
      oauthScopes: ["crm.read", "crm.write"],
      oauthStatus: "ready",
      oauthClients: [
        {
          issuer: "https://auth.example.com",
          clientId: "ocw-production",
          hasSecret: true,
          method: "pre_registered",
        },
      ],
      memberHeaderName: null,
      memberHeaderPrefix: null,
      memberConnections: 0,
    });
    // The cell is never asked to probe it.
    expect((await cellEvents("mcp.probe")).length).toBe(probesBefore);

    const list = await ok(admin.request("GET", "/api/v1/mcp-servers"));
    expect(list.oauth).toEqual({
      redirectUri: "http://localhost:4999/api/v1/connectors/oauth/callback",
      clientMetadataUrl: null,
      oauthAvailable: true,
    });
    const listed = (list.servers as Json[]).find((s) => s.id === crmId);
    expect(listed).toMatchObject({ authMode: "per_member_oauth", oauthClients: [{ hasSecret: true }] });
    const one = await ok(admin.request("GET", `/api/v1/mcp-servers/${crmId}`));
    expect(one.oauthClients).toEqual(body.oauthClients);
    expect(JSON.stringify([body, list, one])).not.toContain(CANARY);

    const client = (
      await su.query(
        "select issuer, client_id, client_secret_id, method from app.connector_oauth_clients where server_id = $1",
        [crmId],
      )
    ).rows as Json[];
    expect(client).toHaveLength(1);
    expect(client[0]).toMatchObject({ issuer: "https://auth.example.com", method: "pre_registered" });
    const secret = (
      await su.query("select kind, ciphertext from app.secrets where id = $1", [client[0]?.client_secret_id])
    ).rows[0] as Json;
    expect(secret.kind).toBe("mcp_credential");
    expect(secret.ciphertext).not.toContain(CANARY);
    const stored = (
      await su.query("select auth_mode, oauth_scopes, headers from app.mcp_servers where id = $1", [crmId])
    ).rows[0] as Json;
    expect(stored).toEqual({
      auth_mode: "per_member_oauth",
      oauth_scopes: ["crm.read", "crm.write"],
      headers: [],
    });

    expect((await audits("mcp.server.created")).at(-1)?.metadata).toMatchObject({
      name: "Acme CRM",
      authMode: "per_member_oauth",
      preRegisteredClient: true,
    });
    const allAudits = (
      await su.query("select metadata from app.audit_events where organization_id = $1", [orgId])
    ).rows;
    expect(JSON.stringify(allAudits)).not.toContain(CANARY);
    expect(logLines.join("\n")).not.toContain(CANARY);
  });

  it("the cell snapshot never carries it, enabled or not", async () => {
    const cell = await asTenant<Json[]>((tx) => cellMcpServers(stack.built.core, tx));
    expect(cell.map((s) => s.id)).not.toContain(crmId);
    expect(cell.length).toBeGreaterThan(0);
  });

  it("without HTTPS (a plain-http LAN URL) the list says member sign-in is unavailable and the connector reads https_required", async () => {
    const env = stack.built.core.env;
    const before = env.OCW_PUBLIC_API_URL;
    env.OCW_PUBLIC_API_URL = "http://ocw.lan:4000";
    try {
      const list = await ok(admin.request("GET", "/api/v1/mcp-servers"));
      expect(list.oauth).toEqual({
        redirectUri: "http://ocw.lan:4000/api/v1/connectors/oauth/callback",
        clientMetadataUrl: null,
        oauthAvailable: false,
      });
      expect((list.servers as Json[]).find((s) => s.id === crmId)?.oauthStatus).toBe("https_required");
    } finally {
      env.OCW_PUBLIC_API_URL = before;
    }
  });
});

// ---------------------------------------------------------------- 07.4-06 Task 2: the registry's rules under every edit

/** A sealed-looking member credential (the connectors module seals real ones; only its existence matters here). */
async function seedConnection(org: string, userId: string, serverId: string): Promise<string> {
  const secret = (
    await su.query(
      `insert into app.secrets (organization_id, name, kind, ciphertext, iv, tag)
       values ($1, 'member connector credential', 'connector_credential', 'c', 'i', 't') returning id`,
      [org],
    )
  ).rows[0].id as string;
  await su.query(
    `insert into app.connector_connections (organization_id, user_id, server_id, status, secret_id)
     values ($1, $2, $3, 'connected', $4)`,
    [org, userId, serverId, secret],
  );
  return secret;
}

const rowsOf = async (sqlText: string, params: unknown[]) => (await su.query(sqlText, params)).rows as Json[];

describe("connector rules (07.4-06 Task 2, D-01, D-06, R4)", () => {
  let std: TestClient;
  let stdId: string;
  let crm: Json;

  beforeAll(async () => {
    [std, stdId] = await joinAs("stan@example.test", "Stan Doe", "standard");
    crm = await ok(
      admin.request("POST", "/api/v1/mcp-servers", {
        name: "Rules CRM",
        transport: "streamable-http",
        url: "https://rules.example.com/mcp",
        authMode: "per_member_oauth",
        oauthClient: {
          issuer: "https://auth.rules.example",
          clientId: "ocw",
          clientSecret: "rules-client-secret",
        },
      }),
    );
  });

  it("refuses the modes' broken combinations, and a member key header that could smuggle a request", async () => {
    const bad = async (body: Json, code: string) => {
      const r = await admin.request("POST", "/api/v1/mcp-servers", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(codeOf(r), JSON.stringify(body)).toBe(code);
    };
    const base = { name: "Bad", transport: "streamable-http", url: "https://bad.example.com/mcp" };
    await bad(
      { name: "Bad", transport: "sandboxed-stdio", sandboxServer: "x", authMode: "per_member_oauth" },
      "validation_error",
    );
    await bad(
      { ...base, authMode: "per_member_oauth", headers: [{ name: "Authorization", value: "Bearer x" }] },
      "validation_error",
    );
    await bad({ ...base, authMode: "per_member_secret" }, "validation_error");
    await bad({ ...base, oauthScopes: ["crm.read"] }, "validation_error");
    // isAllowedInjectionHeader (contracts) plus the transport's reserved headers, checked by the API (ledger 178).
    for (const header of [
      "Cookie",
      "Host",
      "Proxy-Authorization",
      "Transfer-Encoding",
      "Mcp-Session-Id",
      "Content-Type",
    ]) {
      await bad(
        { ...base, authMode: "per_member_secret", memberHeaderName: header },
        "member_header_forbidden",
      );
    }
    await bad({ ...base, authMode: "per_member_oauth", oauthScopes: ['crm"read'] }, "invalid_scope");
    const r = await admin.request("PATCH", `/api/v1/mcp-servers/${crm.id}`, {
      authMode: "per_member_secret",
      memberHeaderName: "Cookie",
    });
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("member_header_forbidden");
    // A PATCH without authMode is checked against the stored mode.
    const headerOnOauth = await admin.request("PATCH", `/api/v1/mcp-servers/${crm.id}`, {
      memberHeaderName: "X-Key",
    });
    expect(codeOf(headerOnOauth)).toBe("member_header_not_allowed");
    const orgHeaders = await admin.request("PATCH", `/api/v1/mcp-servers/${crm.id}`, {
      headers: [{ name: "Authorization", value: "Bearer x" }],
    });
    expect(codeOf(orgHeaders)).toBe("headers_not_allowed");
    // Nothing was stored for the refused requests.
    expect((await rowsOf("select 1 from app.mcp_servers where name = 'Bad'", [])).length).toBe(0);
  });

  it("a stdio sandbox server cannot switch to a member mode", async () => {
    const env = stack.built.core.env;
    env.OCW_MCP_SANDBOX_URL = "http://mcp-sandbox:8080/";
    env.OCW_MCP_SANDBOX_SERVERS = ["everything"];
    try {
      const stdio = await ok(
        admin.request("POST", "/api/v1/mcp-servers", {
          name: "Stdio rules",
          transport: "sandboxed-stdio",
          sandboxServer: "everything",
        }),
      );
      const r = await admin.request("PATCH", `/api/v1/mcp-servers/${stdio.id}`, {
        authMode: "per_member_oauth",
      });
      expect(r.status).toBe(400);
      expect(codeOf(r)).toBe("per_member_needs_remote");
      await ok(admin.request("DELETE", `/api/v1/mcp-servers/${stdio.id}`));
    } finally {
      env.OCW_MCP_SANDBOX_URL = null;
      env.OCW_MCP_SANDBOX_SERVERS = [];
    }
  });

  it("a standard member gets 403 mcp.manage on every route (resolver)", async () => {
    const calls: Array<[string, string, unknown?]> = [
      ["GET", "/api/v1/mcp-servers"],
      ["POST", "/api/v1/mcp-servers", { ...CRM, name: "Stan's" }],
      ["GET", `/api/v1/mcp-servers/${crm.id}`],
      ["PATCH", `/api/v1/mcp-servers/${crm.id}`, { authMode: "org_secret", clearConnections: true }],
      ["DELETE", `/api/v1/mcp-servers/${crm.id}?clearConnections=true`],
      ["POST", `/api/v1/mcp-servers/${crm.id}/probe`],
    ];
    for (const [method, path, body] of calls) {
      const r = await std.request(method as "GET", path, body);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect((r.body as Json).error.details).toMatchObject({ permission: "mcp.manage" });
    }
    expect((await getMcpServer_(crm.id)).authMode).toBe("per_member_oauth");
  });

  it("memberConnections counts this organization's connections only, and is 0 for organization-secret servers (R4)", async () => {
    await seedConnection(orgId, samId, crm.id);
    await seedConnection(orgId, stdId, crm.id);
    // Another organization's row pointing at this server (database FKs ignore RLS): never counted, never touched.
    const orgB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
      orgB,
      `other-${orgB}`,
    ]);
    await seedConnection(orgB, randomUUID(), crm.id);
    const list = await ok(admin.request("GET", "/api/v1/mcp-servers"));
    const byId = new Map((list.servers as Json[]).map((s) => [s.id, s]));
    expect(byId.get(crm.id)?.memberConnections).toBe(2);
    for (const s of list.servers as Json[])
      if (s.authMode === "org_secret") expect(s.memberConnections).toBe(0);
    expect((await ok(admin.request("GET", `/api/v1/mcp-servers/${crm.id}`))).memberConnections).toBe(2);
  });

  it("switching away from member sign-in refuses with the count, then clears every connection and its secret on confirmation", async () => {
    const before = await rowsOf(
      "select secret_id from app.connector_connections where server_id = $1 and organization_id = $2",
      [crm.id, orgId],
    );
    expect(before).toHaveLength(2);
    const refused = await admin.request("PATCH", `/api/v1/mcp-servers/${crm.id}`, { authMode: "org_secret" });
    expect(refused.status).toBe(409);
    expect((refused.body as Json).error).toMatchObject({ code: "connections_exist", details: { count: 2 } });
    expect((await getMcpServer_(crm.id)).authMode).toBe("per_member_oauth");
    expect(
      (
        await rowsOf(
          "select 1 from app.connector_connections where server_id = $1 and organization_id = $2",
          [crm.id, orgId],
        )
      ).length,
    ).toBe(2);

    const clientSecretIds = (
      await rowsOf("select client_secret_id from app.connector_oauth_clients where server_id = $1", [crm.id])
    ).map((r) => r.client_secret_id);
    const switched = await ok(
      admin.request("PATCH", `/api/v1/mcp-servers/${crm.id}`, {
        authMode: "org_secret",
        clearConnections: true,
      }),
    );
    expect(switched).toMatchObject({
      authMode: "org_secret",
      memberConnections: 0,
      oauthClients: [],
      oauthScopes: null,
      oauthStatus: null,
      status: "probing",
    });
    expect(
      (
        await rowsOf(
          "select 1 from app.connector_connections where server_id = $1 and organization_id = $2",
          [crm.id, orgId],
        )
      ).length,
    ).toBe(0);
    const gone = [...before.map((r) => r.secret_id), ...clientSecretIds];
    expect((await rowsOf("select 1 from app.secrets where id = any($1::uuid[])", [gone])).length).toBe(0);
    // The other organization's row is out of reach of this transaction (RLS).
    expect(
      (await rowsOf("select 1 from app.connector_connections where server_id = $1", [crm.id])).length,
    ).toBe(1);
    const cleared = await audits("connector.connections_cleared");
    expect(cleared.at(-1)).toMatchObject({
      resource_id: crm.id,
      metadata: { serverId: crm.id, count: 2, reason: "mode_changed" },
    });
    expect((await audits("mcp.server.updated")).at(-1)?.metadata).toMatchObject({
      authMode: "org_secret",
      previousAuthMode: "per_member_oauth",
    });
    await su.query("delete from app.connector_connections where server_id = $1", [crm.id]);
  });

  it("switching between the two member modes needs the confirmation too; with no members it just switches", async () => {
    const svc = await ok(
      admin.request("POST", "/api/v1/mcp-servers", {
        name: "Two modes",
        transport: "streamable-http",
        url: "https://two.example.com/mcp",
        authMode: "per_member_oauth",
        oauthScopes: ["a"],
      }),
    );
    await seedConnection(orgId, samId, svc.id);
    const refused = await admin.request("PATCH", `/api/v1/mcp-servers/${svc.id}`, {
      authMode: "per_member_secret",
      memberHeaderName: "X-Api-Key",
    });
    expect(refused.status).toBe(409);
    expect((refused.body as Json).error.details).toEqual({ count: 1 });
    const switched = await ok(
      admin.request("PATCH", `/api/v1/mcp-servers/${svc.id}`, {
        authMode: "per_member_secret",
        memberHeaderName: "X-Api-Key",
        memberHeaderPrefix: "Token ",
        clearConnections: true,
      }),
    );
    expect(switched).toMatchObject({
      authMode: "per_member_secret",
      memberHeaderName: "X-Api-Key",
      memberHeaderPrefix: "Token ",
      oauthScopes: null,
      memberConnections: 0,
      status: "pending",
    });
    // Back to sign-in with nobody connected: no confirmation needed.
    const back = await ok(
      admin.request("PATCH", `/api/v1/mcp-servers/${svc.id}`, { authMode: "per_member_oauth" }),
    );
    expect(back).toMatchObject({
      authMode: "per_member_oauth",
      memberHeaderName: null,
      memberHeaderPrefix: null,
    });
    await ok(admin.request("DELETE", `/api/v1/mcp-servers/${svc.id}`));
  });

  it("DELETE with members refuses, then removes the server, its connections, their secrets and its client secrets", async () => {
    const svc = await ok(
      admin.request("POST", "/api/v1/mcp-servers", {
        name: "Doomed",
        transport: "sse",
        url: "https://doomed.example.com/sse",
        authMode: "per_member_oauth",
        oauthClient: {
          issuer: "https://auth.doomed.example",
          clientId: "ocw",
          clientSecret: "doomed-secret",
        },
      }),
    );
    const memberSecrets = [
      await seedConnection(orgId, samId, svc.id),
      await seedConnection(orgId, stdId, svc.id),
    ];
    const [client] = await rowsOf(
      "select client_secret_id from app.connector_oauth_clients where server_id = $1",
      [svc.id],
    );
    const refused = await admin.request("DELETE", `/api/v1/mcp-servers/${svc.id}`);
    expect(refused.status).toBe(409);
    expect((refused.body as Json).error).toMatchObject({ code: "connections_exist", details: { count: 2 } });
    expect((await rowsOf("select 1 from app.mcp_servers where id = $1", [svc.id])).length).toBe(1);

    expect(await ok(admin.request("DELETE", `/api/v1/mcp-servers/${svc.id}?clearConnections=true`))).toEqual({
      ok: true,
    });
    expect((await rowsOf("select 1 from app.mcp_servers where id = $1", [svc.id])).length).toBe(0);
    expect(
      (await rowsOf("select 1 from app.connector_connections where server_id = $1", [svc.id])).length,
    ).toBe(0);
    expect(
      (await rowsOf("select 1 from app.connector_oauth_clients where server_id = $1", [svc.id])).length,
    ).toBe(0);
    expect(
      (
        await rowsOf("select 1 from app.secrets where id = any($1::uuid[])", [
          [...memberSecrets, client?.client_secret_id],
        ])
      ).length,
    ).toBe(0);
    expect((await audits("connector.connections_cleared")).at(-1)).toMatchObject({
      resource_id: svc.id,
      metadata: { serverId: svc.id, count: 2, reason: "server_deleted" },
    });
  });

  it("oauthClient null removes the pre-registered client and its secret; a new client replaces the old one", async () => {
    const svc = await ok(
      admin.request("POST", "/api/v1/mcp-servers", {
        name: "Clients",
        transport: "streamable-http",
        url: "https://clients.example.com/mcp",
        authMode: "per_member_oauth",
        oauthClient: { issuer: "https://a.example", clientId: "one", clientSecret: "first-client-secret" },
      }),
    );
    const [first] = await rowsOf(
      "select client_secret_id from app.connector_oauth_clients where server_id = $1",
      [svc.id],
    );
    const replaced = await ok(
      admin.request("PATCH", `/api/v1/mcp-servers/${svc.id}`, {
        oauthClient: { issuer: "https://b.example", clientId: "two" },
      }),
    );
    expect(replaced.oauthClients).toEqual([
      { issuer: "https://b.example", clientId: "two", hasSecret: false, method: "pre_registered" },
    ]);
    expect((await rowsOf("select 1 from app.secrets where id = $1", [first?.client_secret_id])).length).toBe(
      0,
    );
    // 07.4-10's view of the clients: the secret stays a reference.
    expect(await asTenant<Json[]>((tx) => oauthClientsOf(tx, svc.id))).toEqual([
      { issuer: "https://b.example", clientId: "two", clientSecretId: null, method: "pre_registered" },
    ]);
    // An admin's new client answers a needs_client status.
    await asTenant((tx) => setOAuthStatus(tx, svc.id, "needs_client"));
    expect((await ok(admin.request("GET", `/api/v1/mcp-servers/${svc.id}`))).oauthStatus).toBe(
      "needs_client",
    );
    const fixed = await ok(
      admin.request("PATCH", `/api/v1/mcp-servers/${svc.id}`, {
        oauthClient: { issuer: "https://b.example", clientId: "two", clientSecret: "third-client-secret" },
      }),
    );
    expect(fixed).toMatchObject({ oauthStatus: "ready", oauthClients: [{ hasSecret: true }] });
    const removed = await ok(admin.request("PATCH", `/api/v1/mcp-servers/${svc.id}`, { oauthClient: null }));
    expect(removed.oauthClients).toEqual([]);
    expect(
      (await rowsOf("select 1 from app.connector_oauth_clients where server_id = $1", [svc.id])).length,
    ).toBe(0);
    expect((await audits("mcp.server.updated")).at(-1)?.metadata.changed).toEqual(["oauthClient"]);
    expect(JSON.stringify(await audits("mcp.server.updated"))).not.toMatch(/client-secret/);
    await ok(admin.request("DELETE", `/api/v1/mcp-servers/${svc.id}`));
  });

  it("a per-member connector is never probed by the cell: the admin probe refuses and a cell report is ignored", async () => {
    const svc = await ok(
      admin.request("POST", "/api/v1/mcp-servers", {
        name: "No cell probe",
        transport: "streamable-http",
        url: "https://nocell.example.com/mcp",
        authMode: "per_member_secret",
        memberHeaderName: "X-Api-Key",
      }),
    );
    const r = await admin.request("POST", `/api/v1/mcp-servers/${svc.id}/probe`);
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("member_connector");
    const res = await asTenant<Json>((tx) =>
      recordProbeResult(stack.built.core, tx, {
        probeId: randomUUID(),
        serverId: svc.id,
        ok: true,
        tools: [],
      }),
    );
    expect(res).toEqual({ applied: false });
    // Toggling it on for bots does not ask the cell either.
    const probes = (await cellEvents("mcp.probe")).length;
    await ok(admin.request("PATCH", `/api/v1/mcp-servers/${svc.id}`, { orgEnabled: false }));
    await ok(admin.request("PATCH", `/api/v1/mcp-servers/${svc.id}`, { orgEnabled: true }));
    expect((await cellEvents("mcp.probe")).length).toBe(probes);
    await ok(admin.request("DELETE", `/api/v1/mcp-servers/${svc.id}`));
  });

  it("replaceServerTools (the API-side probe): input schemas, OpenClaw names, removed tools lose their grants, ready, audited; the catalog carries authMode", async () => {
    const svc = await ok(
      admin.request("POST", "/api/v1/mcp-servers", {
        name: "Probed by members",
        transport: "streamable-http",
        url: "https://members.example.com/mcp",
        authMode: "per_member_secret",
        memberHeaderName: "Authorization",
        memberHeaderPrefix: "Bearer ",
      }),
    );
    const schema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
    const huge = { type: "object", description: "x".repeat(17 * 1024) };
    const changes = (await cellEvents("cell.config.changed")).length;
    const first = await asTenant<Json>((tx) =>
      replaceServerTools(stack.built.core, tx, svc.id, [
        {
          name: "search",
          title: "Search",
          description: "Finds records",
          readOnly: true,
          destructive: false,
          inputSchema: schema,
        },
        { name: "update", readOnly: false, destructive: true, inputSchema: huge },
      ]),
    );
    expect(first).toEqual({ toolCount: 2, removedTools: [] });
    const s = await ok(admin.request("GET", `/api/v1/mcp-servers/${svc.id}`));
    expect(s.status).toBe("ready");
    expect(s.tools).toEqual([
      {
        name: "search",
        openclawName: `${svc.safeName}__search`,
        title: "Search",
        description: "Finds records",
        readOnly: true,
        destructive: false,
        inputSchema: schema,
      },
      {
        name: "update",
        openclawName: `${svc.safeName}__update`,
        title: null,
        description: null,
        readOnly: false,
        destructive: true,
      },
    ]);
    expect((await cellEvents("cell.config.changed")).length).toBe(changes + 1);

    // Granted to a team bot: the capability rules are the same as for any MCP server.
    const team = await ok(
      admin.request("POST", "/api/v1/agents", {
        name: "Member-account bot",
        instructions: "You are a test bot.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    );
    const view = await ok(
      admin.request("PATCH", `/api/v1/agents/${team.id}/capabilities`, {
        tools: [
          { sourceKind: "mcp", sourceId: svc.id, tool: `${svc.safeName}__search` },
          { sourceKind: "mcp", sourceId: svc.id, tool: `${svc.safeName}__update` },
        ],
      }),
    );
    expect((view.tools as Json[]).find((t) => t.tool === `${svc.safeName}__search`)).toMatchObject({
      granted: true,
      effective: true,
      reason: null,
    });
    const catalog = await asTenant<Json[]>((tx) => loadCatalog(tx));
    expect(catalog.find((c) => c.sourceId === svc.id)).toMatchObject({
      authMode: "per_member_secret",
      status: "ready",
    });
    expect(catalog.find((c) => c.sourceId === crm.id)?.authMode).toBe("org_secret");

    // A later probe without `update`: the tool and its grant go; audited with the removed name.
    const second = await asTenant<Json>((tx) =>
      replaceServerTools(stack.built.core, tx, svc.id, [
        { name: "search", readOnly: true, destructive: false },
      ]),
    );
    expect(second).toEqual({ toolCount: 1, removedTools: [`${svc.safeName}__update`] });
    expect(
      (await rowsOf("select tool_name from app.bot_tool_grants where source_id = $1", [svc.id])).map(
        (r) => r.tool_name,
      ),
    ).toEqual([`${svc.safeName}__search`]);
    expect((await audits("mcp.server.probed")).at(-1)).toMatchObject({
      resource_id: svc.id,
      metadata: { ok: true, toolCount: 1, removedTools: [`${svc.safeName}__update`] },
    });
    await ok(admin.request("DELETE", `/api/v1/agents/${team.id}`));
    await ok(admin.request("DELETE", `/api/v1/mcp-servers/${svc.id}`));
  });
});

describe("cross-tenant: another organization's admin cannot read, change or delete a connector (07.4-06, T-07.4-06-05)", () => {
  let eve: TestClient;
  let target: Json;

  beforeAll(async () => {
    target = await ok(
      admin.request("POST", "/api/v1/mcp-servers", {
        name: "Tenant A connector",
        transport: "streamable-http",
        url: "https://tenant-a.example.com/mcp",
        authMode: "per_member_oauth",
        oauthClient: {
          issuer: "https://auth.tenant-a.example",
          clientId: "tenant-a-client",
          clientSecret: "tenant-a-sec",
        },
      }),
    );
    await seedConnection(orgId, samId, target.id);
    // Eve: invited into org A, then moved into her own organization as its admin.
    const [client, eveId] = await joinAs("eve@example.test", "Eve", "developer");
    eve = client;
    const orgB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil Corp', $2)", [
      orgB,
      `evil-corp-${orgB}`,
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
    expect((await ok(eve.request("GET", "/api/v1/me/permissions"))).role).toBe("admin");
  });

  it("org B's admin gets 404 on GET, PATCH (incl. clearConnections) and DELETE, and org A's rows are untouched", async () => {
    const snapshot = async () => ({
      server: await rowsOf("select auth_mode, name, oauth_scopes from app.mcp_servers where id = $1", [
        target.id,
      ]),
      clients: await rowsOf(
        "select issuer, client_id, client_secret_id from app.connector_oauth_clients where server_id = $1",
        [target.id],
      ),
      connections: await rowsOf(
        "select user_id, secret_id from app.connector_connections where server_id = $1",
        [target.id],
      ),
    });
    const before = await snapshot();
    const cases: Array<[string, string, unknown?]> = [
      ["GET", `/api/v1/mcp-servers/${target.id}`],
      ["PATCH", `/api/v1/mcp-servers/${target.id}`, { name: "Pwned" }],
      ["PATCH", `/api/v1/mcp-servers/${target.id}`, { authMode: "org_secret", clearConnections: true }],
      ["PATCH", `/api/v1/mcp-servers/${target.id}`, { oauthClient: null }],
      ["DELETE", `/api/v1/mcp-servers/${target.id}?clearConnections=true`],
      ["POST", `/api/v1/mcp-servers/${target.id}/probe`],
    ];
    for (const [method, path, body] of cases) {
      const r = await eve.request(method as "GET", path, body);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain("tenant-a");
    }
    expect(await snapshot()).toEqual(before);
  });

  it("org B's list shows none of org A's connectors or OAuth clients", async () => {
    const list = await ok(eve.request("GET", "/api/v1/mcp-servers"));
    expect(list.servers).toEqual([]);
    expect(JSON.stringify(list)).not.toContain("tenant-a");
    // Not vacuous: org A's admin sees it with its client and its member.
    const mine = await ok(admin.request("GET", `/api/v1/mcp-servers/${target.id}`));
    expect(mine).toMatchObject({ memberConnections: 1, oauthClients: [{ clientId: "tenant-a-client" }] });
  });

  it("every MCP server route (the authz registry) has an org-B case above, and org B's own create stays in org B (WINDOWS #169)", async () => {
    const covered = [
      "GET /api/v1/mcp-servers",
      "POST /api/v1/mcp-servers",
      "GET /api/v1/mcp-servers/:p",
      "PATCH /api/v1/mcp-servers/:p",
      "DELETE /api/v1/mcp-servers/:p",
      "POST /api/v1/mcp-servers/:p/probe",
    ].sort();
    const registered = [...stack.built.authz.routes.keys()]
      .filter((k) => / \/api\/v1\/mcp-servers/u.test(k))
      .map((k) => k.replace(/:[A-Za-z]+/gu, ":p"))
      .sort();
    expect(registered).toEqual(covered);
    // The one route without an id: a create always lands in the caller's own organization.
    const created = await ok(
      eve.request("POST", "/api/v1/mcp-servers", {
        name: "Evil CRM",
        transport: "streamable-http",
        url: "https://crm.evil.example/mcp",
        authMode: "per_member_secret",
        memberHeaderName: "X-Api-Key",
      }),
    );
    const placed = await rowsOf("select organization_id from app.mcp_servers where id = $1", [created.id]);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.organization_id).not.toBe(orgId);
    expect(
      ((await ok(admin.request("GET", "/api/v1/mcp-servers"))).servers as Json[]).map((x) => x.id),
    ).not.toContain(created.id);
  });
});

/** Org A's tenant read, for assertions that must not go through HTTP (no request-scoped decision). */
async function getMcpServer_(id: string): Promise<Json> {
  return asTenant<Json>((tx) => getMcpServer(tx, id));
}
