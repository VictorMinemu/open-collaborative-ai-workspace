import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeClawhub, type FakeClawhub } from "../../../../../infra/fake-model/fake-clawhub.mjs";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * 03.1-12 (BOT-09, BOT-10; SC7 cell half, API side): what the cell installed becomes what the API knows. `/cell`
 * delivers the approved rows, the install gate asks `verify-install` (approved only for the exact in-flight tuple),
 * the boot render asks `GET /plugins`, and `POST /plugins/report` records the outcome: declared tools become
 * grantable capabilities, a plugin that reports a refused surface is rejected and uninstalled, uninstall removes the
 * tools. Real PostgreSQL + Redis; ClawHub is the in-process fake.
 */

const CELL_TOKEN = "ocw-test-cell-token-plugins-cell-0123456789ab";
const ECHO = "@ocw-test/echo-plugin";
const NOTES = "@ocw-test/notes-plugin";
const DDG = "@openclaw/duckduckgo-plugin";
const enc = encodeURIComponent;

let fake: FakeClawhub;
let fakeServer: Server;
let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let orgId: string;

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
      "select actor_kind, resource_type, resource_id, result, metadata from app.audit_events where action = $1 and organization_id = $2 order by occurred_at",
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

const row = async (id: string) =>
  (await su.query("select * from app.cell_plugins where id = $1", [id])).rows[0] as Json;
const toolRows = async (id: string) =>
  (await su.query("select name, side_effecting from app.cell_plugin_tools where plugin_row_id = $1", [id]))
    .rows as Json[];

/** Admin review + approval through the real marketplace routes (fake ClawHub). */
async function approve(name: string, version: string, acknowledgeHighRisk = false): Promise<Json> {
  const detail = await ok(
    admin.request("GET", `/api/v1/marketplace/packages/${enc(name)}?version=${enc(version)}`),
  );
  return ok(
    admin.request("POST", "/api/v1/marketplace/installs", {
      packageName: name,
      version,
      reviewToken: detail.review.reviewToken,
      acknowledgeHighRisk,
    }),
  );
}

const installEvent = async (pluginRowId: string) =>
  (await cellEvents("plugin.install.v1")).filter((e) => e.pluginRowId === pluginRowId).at(-1) as Json;

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

beforeAll(async () => {
  fake = createFakeClawhub();
  fakeServer = createServer((req, res) => {
    if (!fake(req, res, new URL(req.url ?? "/", "http://localhost"))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => fakeServer.listen(0, "127.0.0.1", r));
  const addr = fakeServer.address();
  stack = await startTestStack({
    env: {
      OCW_CELL_TOKEN: CELL_TOKEN,
      OCW_MODEL_PROVIDER: "mock",
      OCW_CLAWHUB_URL: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`,
      // DuckDuckGo is installable here (only SearXNG bundled), so three fixtures can be approved.
      OCW_BUNDLED_PLUGINS: "searxng",
    },
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
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
  await new Promise<void>((r) => fakeServer?.close(() => r()));
});

describe("the cell's view of approved plugins (D-14)", () => {
  let echo: Json;

  beforeAll(async () => {
    echo = await approve(ECHO, "0.1.0", true);
  });

  it("GET /cell lists the approved plugin in flight with package, version, sha256 and plugin id", async () => {
    const r = await cell("GET", "/cell");
    expect(r.status).toBe(200);
    expect(r.body.plugins).toEqual([
      {
        pluginRowId: echo.id,
        packageName: ECHO,
        version: "0.1.0",
        sha256: "2c".repeat(32),
        pluginId: "ocw-echo",
        status: "installing",
      },
    ]);
  });

  it("POST /plugins/verify-install approves exactly the in-flight package, version and digest", async () => {
    const tuple = { packageName: ECHO, version: "0.1.0", sha256: "2c".repeat(32) };
    expect(await cell("POST", "/plugins/verify-install", tuple)).toEqual({
      status: 200,
      body: { approved: true, reason: null },
    });
    const refusals: Array<[Json, string]> = [
      [{ ...tuple, version: "0.2.0" }, "version_mismatch"],
      [{ ...tuple, sha256: "f".repeat(64) }, "digest_mismatch"],
      [{ ...tuple, packageName: "@evil/plugin" }, "not_approved"],
    ];
    for (const [body, reason] of refusals) {
      expect(await cell("POST", "/plugins/verify-install", body)).toEqual({
        status: 200,
        body: { approved: false, reason },
      });
    }
    // Every refusal is audited (the gate blocked an install), the approval is not (a read).
    const blocked = await audits("plugin.install_blocked");
    expect(blocked.map((a) => a.metadata.reason)).toEqual([
      "version_mismatch",
      "digest_mismatch",
      "not_approved",
    ]);
    expect(blocked[0]).toMatchObject({ actor_kind: "system", result: "denied" });
    expect(blocked[0]?.metadata).toMatchObject({ packageName: ECHO, version: "0.2.0" });
  });

  it("the gate's questions need the cell token; malformed questions are 400", async () => {
    const tuple = { packageName: ECHO, version: "0.1.0", sha256: "2c".repeat(32) };
    expect((await cell("POST", "/plugins/verify-install", tuple, "ocw_cell_wrong")).status).toBe(401);
    expect((await admin.request("POST", "/agent-channel/v1/plugins/verify-install", tuple)).status).toBe(401);
    expect((await cell("GET", "/plugins", undefined, "nope")).status).toBe(401);
    expect((await cell("POST", "/plugins/verify-install", { ...tuple, sha256: "short" })).status).toBe(400);
  });

  it("GET /plugins lists plugin ids, packages, versions and status, never a digest or a secret", async () => {
    const r = await cell("GET", "/plugins");
    expect(r).toEqual({
      status: 200,
      body: {
        plugins: [{ pluginId: "ocw-echo", packageName: ECHO, version: "0.1.0", status: "installing" }],
      },
    });
  });

  it("another organization's in-flight row never approves an install of this cell", async () => {
    const orgB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
      orgB,
      `evil-${orgB}`,
    ]);
    const foreign = randomUUID();
    const flow = randomUUID();
    await su.query(
      `insert into app.cell_plugins (id, organization_id, package_name, plugin_id, version, channel, artifact_sha256, risk, status, flow_id)
       values ($1, $2, '@evil/plugin', 'evil', '1.0.0', 'official', $3, 'low', 'installing', $4)`,
      [foreign, orgB, "e".repeat(64), flow],
    );
    expect(
      await cell("POST", "/plugins/verify-install", {
        packageName: "@evil/plugin",
        version: "1.0.0",
        sha256: "e".repeat(64),
      }),
    ).toEqual({ status: 200, body: { approved: false, reason: "not_approved" } });
    // Its flow cannot be reported by this cell either (RLS → 404), and nothing changed.
    const r = await cell("POST", "/plugins/report", {
      flowId: flow,
      pluginRowId: foreign,
      state: "installed",
      pluginId: "evil",
      version: "1.0.0",
      declaredTools: [{ name: "evil_tool" }],
    });
    expect(r.status).toBe(404);
    expect((await su.query("select status from app.cell_plugins where id = $1", [foreign])).rows[0]).toEqual({
      status: "installing",
    });
    expect((await cell("GET", "/cell")).body.plugins.map((p: Json) => p.pluginRowId)).not.toContain(foreign);
  });
});

describe("POST /plugins/report: what got installed becomes a capability (BOT-10)", () => {
  let echoId: string;
  let flowId: string;
  let botId: string;
  let channelId: string;

  beforeAll(async () => {
    echoId = (await ok(admin.request("GET", "/api/v1/cell-plugins"))).plugins.find(
      (p: Json) => p.packageName === ECHO,
    ).id;
    flowId = (await installEvent(echoId)).flowId;
    botId = (
      await ok(
        admin.request("POST", "/api/v1/agents", {
          name: "Scribe",
          instructions: "You are Scribe.",
          modelProvider: "mock",
          modelId: "mock-1",
        }),
      )
    ).id;
    channelId = (await ok(admin.request("POST", "/api/v1/channels", { name: "plugins" }))).id;
  });

  it("a report for an unknown flow or row is 404 and changes nothing", async () => {
    for (const body of [
      { flowId: randomUUID(), pluginRowId: echoId, state: "installed", pluginId: "ocw-echo" },
      { flowId, pluginRowId: randomUUID(), state: "installed", pluginId: "ocw-echo" },
    ]) {
      const r = await cell("POST", "/plugins/report", body);
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe("plugin_flow_not_found");
    }
    expect((await row(echoId)).status).toBe("installing");
  });

  it("installed with declared tools → row installed with the plugin id, side-effecting tool rows, audited, cell told", async () => {
    const changes = (await cellEvents("cell.config.changed")).length;
    const r = await cell("POST", "/plugins/report", {
      flowId,
      pluginRowId: echoId,
      state: "installed",
      pluginId: "ocw-echo",
      version: "0.1.0",
      declared: {
        tools: ["ocw_echo"],
        hooks: [],
        channels: [],
        providers: [],
        webSearchProviders: [],
        webFetchProviders: [],
        mcpServers: [],
        other: [],
      },
      declaredTools: [{ name: "ocw_echo", description: "Echo the given text back." }],
    });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    const stored = await row(echoId);
    expect(stored).toMatchObject({ status: "installed", plugin_id: "ocw-echo", status_detail: null });
    expect(stored.installed_at).not.toBeNull();
    expect(await toolRows(echoId)).toEqual([{ name: "ocw_echo", side_effecting: true }]);
    expect((await audits("plugin.installed")).at(-1)?.metadata).toMatchObject({
      packageName: ECHO,
      version: "0.1.0",
      pluginId: "ocw-echo",
      sha256: "2c".repeat(32),
      tools: ["ocw_echo"],
    });
    const after = await cellEvents("cell.config.changed");
    expect(after.length).toBe(changes + 1);
    expect(after.at(-1)?.reason).toBe("tools.updated");
    // A replayed report of the same flow is accepted and changes nothing.
    const again = await cell("POST", "/plugins/report", {
      flowId,
      pluginRowId: echoId,
      state: "installed",
      pluginId: "ocw-echo",
      version: "0.1.0",
      declaredTools: [{ name: "ocw_echo" }],
    });
    expect(again.status).toBe(200);
    expect(await audits("plugin.installed")).toHaveLength(1);
    // The boot allowlist now names it.
    expect((await cell("GET", "/plugins")).body.plugins).toEqual([
      { pluginId: "ocw-echo", packageName: ECHO, version: "0.1.0", status: "installed" },
    ]);
  });

  it("granted to a team bot, ocw_echo reaches the next turn with plugin taint flags; its call is audited as a plugin call", async () => {
    await ok(
      admin.request("PATCH", `/api/v1/agents/${botId}/capabilities`, {
        tools: [{ sourceKind: "plugin", sourceId: echoId, tool: "ocw_echo" }],
      }),
    );
    const snapshotBot = ((await cell("GET", "/cell")).body.agents as Json[]).find((a) => a.id === botId);
    expect(snapshotBot?.capabilities.tools).toContain("ocw_echo");

    const msg = await ok(
      admin.request("POST", `/api/v1/conversations/${channelId}/messages`, {
        body: '@scribe echo [[call ocw_echo {"text":"marketplace"}]]',
        mentions: [{ kind: "agent", id: botId }],
      }),
    );
    const ev = await deliveredFor(msg.id);
    expect(ev.turn.tools).toContain("ocw_echo");
    expect(ev.turn.toolFlags.ocw_echo).toEqual({ untrustedOutput: true, sideEffecting: true });

    const call = await cell("POST", "/tool-calls", {
      eventId: ev.eventId,
      agentId: botId,
      tool: "ocw_echo",
      params: {},
    });
    expect(call.body).toMatchObject({ allowed: true, reason: null });
    expect((await audits("bot.tool_call")).at(-1)).toMatchObject({
      resource_id: "ocw_echo",
      result: "success",
      metadata: expect.objectContaining({ sourceKind: "plugin", target: ECHO, sourceId: echoId }),
    });
  });

  it("uninstalled → row uninstalled, tool rows gone, audited; the next turn has no ocw_echo", async () => {
    await ok(admin.request("DELETE", `/api/v1/cell-plugins/${echoId}`));
    const un = (await cellEvents("plugin.uninstall.v1")).filter((e) => e.pluginRowId === echoId).at(-1);
    expect(un).toMatchObject({ pluginId: "ocw-echo" });
    const r = await cell("POST", "/plugins/report", {
      flowId: un?.flowId,
      pluginRowId: echoId,
      state: "uninstalled",
      pluginId: "ocw-echo",
    });
    expect(r.status).toBe(200);
    expect((await row(echoId)).status).toBe("uninstalled");
    expect(await toolRows(echoId)).toEqual([]);
    expect((await audits("plugin.uninstalled")).at(-1)?.metadata).toMatchObject({
      packageName: ECHO,
      version: "0.1.0",
      pluginId: "ocw-echo",
    });
    const msg = await ok(
      admin.request("POST", `/api/v1/conversations/${channelId}/messages`, {
        body: "@scribe echo again",
        mentions: [{ kind: "agent", id: botId }],
      }),
    );
    expect((await deliveredFor(msg.id)).turn.tools).not.toContain("ocw_echo");
    expect((await cell("GET", "/cell")).body.plugins.map((p: Json) => p.pluginRowId)).not.toContain(echoId);
    expect((await cell("GET", "/plugins")).body.plugins).toEqual([]);
  });
});

describe("plugins that lie about their surface, and failures (D-14)", () => {
  it("a report declaring run_shell → failed dangerous_tool, no tool rows, uninstall command, audited", async () => {
    const notes = await approve(NOTES, "1.0.0");
    const flow = (await installEvent(notes.id)).flowId;
    const uninstallsBefore = (await cellEvents("plugin.uninstall.v1")).length;
    const r = await cell("POST", "/plugins/report", {
      flowId: flow,
      pluginRowId: notes.id,
      state: "installed",
      pluginId: "ocw-notes",
      version: "1.0.0",
      declaredTools: [{ name: "notes_lookup" }, { name: "run_shell" }],
    });
    expect(r.status).toBe(200);
    const stored = await row(notes.id);
    expect(stored.status).toBe("failed");
    expect(stored.status_detail).toContain("dangerous_tool");
    expect(await toolRows(notes.id)).toEqual([]);
    const uninstalls = await cellEvents("plugin.uninstall.v1");
    expect(uninstalls.length).toBe(uninstallsBefore + 1);
    expect(uninstalls.at(-1)).toMatchObject({ pluginRowId: notes.id, pluginId: "ocw-notes" });
    expect(uninstalls.at(-1)?.flowId).toBe(stored.flow_id);
    const audit = (await audits("plugin.rejected_after_install")).at(-1);
    expect(audit).toMatchObject({ resource_id: notes.id });
    expect(audit?.metadata).toMatchObject({ packageName: NOTES, pluginId: "ocw-notes" });
    expect(audit?.metadata.reasons).toContain("dangerous_tool");
    // The verdict stays visible to the admin; nothing reaches a bot.
    expect((await cell("GET", "/cell")).body.plugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ pluginRowId: notes.id, status: "failed" })]),
    );
    // The cell's uninstall of the rejected plugin is recorded; the row keeps its verdict.
    const done = await cell("POST", "/plugins/report", {
      flowId: stored.flow_id,
      pluginRowId: notes.id,
      state: "uninstalled",
      pluginId: "ocw-notes",
    });
    expect(done.status).toBe(200);
    const after = await row(notes.id);
    expect(after.status).toBe("failed");
    expect(after.status_detail).toContain("dangerous_tool");
    expect((await audits("plugin.uninstalled")).at(-1)).toMatchObject({ resource_id: notes.id });
  });

  it("a report naming another plugin id or version than approved is rejected the same way", async () => {
    // ocw-echo was uninstalled above: approving it again is a new row and a new flow.
    const echo = await approve(ECHO, "0.1.0", true);
    const flow = (await installEvent(echo.id)).flowId;
    const r = await cell("POST", "/plugins/report", {
      flowId: flow,
      pluginRowId: echo.id,
      state: "installed",
      pluginId: "not-ocw-echo",
      version: "0.1.0",
      declaredTools: [{ name: "ocw_echo" }],
    });
    expect(r.status).toBe(200);
    const stored = await row(echo.id);
    expect(stored.status).toBe("failed");
    expect(stored.status_detail).toContain("plugin_mismatch");
    expect(await toolRows(echo.id)).toEqual([]);
    // The cell is told to remove what it actually installed.
    expect((await cellEvents("plugin.uninstall.v1")).at(-1)).toMatchObject({
      pluginRowId: echo.id,
      pluginId: "not-ocw-echo",
      flowId: stored.flow_id,
    });
    expect((await audits("plugin.rejected_after_install")).at(-1)?.metadata.reasons).toContain(
      "plugin_mismatch",
    );
  });

  it("failed → row failed with the classified reason, audited plugin.install_failed; no longer in flight", async () => {
    const ddg = await approve(DDG, "2026.9.7");
    const flow = (await installEvent(ddg.id)).flowId;
    const r = await cell("POST", "/plugins/report", {
      flowId: flow,
      pluginRowId: ddg.id,
      state: "failed",
      error: { code: "install_blocked", message: "OpenClaw's install gate blocked the install." },
    });
    expect(r.status).toBe(200);
    const stored = await row(ddg.id);
    expect(stored.status).toBe("failed");
    expect(stored.status_detail).toBe("install_blocked: OpenClaw's install gate blocked the install.");
    expect((await audits("plugin.install_failed")).at(-1)).toMatchObject({
      resource_id: ddg.id,
      result: "error",
      metadata: expect.objectContaining({ packageName: DDG, version: "2026.9.7", code: "install_blocked" }),
    });
    expect(
      (
        await cell("POST", "/plugins/verify-install", {
          packageName: DDG,
          version: "2026.9.7",
          sha256: stored.artifact_sha256,
        })
      ).body,
    ).toEqual({ approved: false, reason: "not_in_flight" });
    // A late "installed" for a failed flow is refused (409), never resurrects the row.
    const late = await cell("POST", "/plugins/report", {
      flowId: flow,
      pluginRowId: ddg.id,
      state: "installed",
      pluginId: "duckduckgo",
      version: "2026.9.7",
    });
    expect(late.status).toBe(409);
    expect((await row(ddg.id)).status).toBe("failed");
  });
});
