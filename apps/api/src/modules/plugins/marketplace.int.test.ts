import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeClawhub, type FakeClawhub } from "../../../../../infra/fake-model/fake-clawhub.mjs";
import { buildApp } from "../../app";
import { HttpError } from "../../lib/errors";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { getCellPlugin, listCellPlugins } from "./index";

/**
 * 03.1-11 (BOT-09, BOT-10, SC7 review/approve half): Organization Admins browse ClawHub through the API, review a
 * pinned version's risk and approve it; the cell gets exactly the reviewed digest. Real PostgreSQL + Redis; the
 * fake ClawHub runs in-process (no network).
 */

const CELL_TOKEN = "ocw-test-cell-token-marketplace-0123456789ab";
const ADMIN = {
  name: "Víctor Ruiz",
  email: "victor@example.test",
  password: "correct-horse-battery",
  orgName: "Autofy Labs",
};

const NOTES = "@ocw-test/notes-plugin";
const ECHO = "@ocw-test/echo-plugin";
const SHELL = "@ocw-test/shell-plugin";
const RELAY = "@ocw-test/relay-channel-plugin";
const DDG = "@openclaw/duckduckgo-plugin";
const enc = encodeURIComponent;

let fake: FakeClawhub;
let fakeServer: Server;
let clawhubUrl: string;
let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let orgId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const codeOf = (r: { body: Record<string, unknown> | null }) =>
  (r.body as { error?: { code?: string } } | null)?.error?.code;

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

const review = async (name: string, version?: string) =>
  ok(
    admin.request(
      "GET",
      `/api/v1/marketplace/packages/${enc(name)}${version ? `?version=${enc(version)}` : ""}`,
    ),
  );

beforeAll(async () => {
  fake = createFakeClawhub();
  fakeServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!fake(req, res, url)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => fakeServer.listen(0, "127.0.0.1", r));
  const addr = fakeServer.address();
  clawhubUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  stack = await startTestStack({
    env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock", OCW_CLAWHUB_URL: clawhubUrl },
  });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN }));
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
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
  await new Promise<void>((r) => fakeServer?.close(() => r()));
});

describe("browse and review (D-14, BOT-09)", () => {
  it("search goes live first, then from the cache; the bundled DuckDuckGo plugin is marked bundled", async () => {
    // Other test files may share nothing with this Redis, but start from a clean request log.
    fake.reset();
    const first = await ok(admin.request("GET", "/api/v1/marketplace/search?q=duck"));
    expect(first.source).toBe("live");
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]).toMatchObject({
      packageName: DDG,
      publisher: "openclaw",
      publisherOfficial: true,
      channel: "official",
      latestVersion: "2026.9.7",
      bundled: true,
      installed: null,
    });
    const second = await ok(admin.request("GET", "/api/v1/marketplace/search?q=duck"));
    expect(second.source).toBe("cache");
    expect(fake.requests.filter((r) => r.path === "/api/v1/packages/search")).toHaveLength(1);
    // Nothing that identifies the org or the user went to ClawHub.
    for (const r of fake.requests) {
      expect(r.headers["user-agent"]).toBe("ocw-marketplace-proxy");
      expect(r.headers.cookie).toBeUndefined();
      expect(r.headers.authorization).toBeUndefined();
      expect(JSON.stringify(r)).not.toContain(orgId);
    }

    const browse = await ok(admin.request("GET", "/api/v1/marketplace/search?limit=2"));
    expect(browse.entries).toHaveLength(2);
    expect(browse.nextCursor).toBe("2");
  });

  it("with OCW_BUNDLED_PLUGINS=none the same entry is installable (bundled: false)", async () => {
    const none = await buildApp({ ...stack.env, OCW_BUNDLED_PLUGINS: [] }, { logger: false });
    try {
      await none.app.ready();
      const res = await none.app.inject({
        method: "GET",
        url: "/api/v1/marketplace/search?q=duck",
        headers: { cookie: admin.cookieHeader, origin: "http://localhost:3999" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().entries[0]).toMatchObject({ packageName: DDG, bundled: false });
    } finally {
      await none.close();
    }
  });

  it("reviews each fixture with a deterministic risk and reasons", async () => {
    const notes = await review(NOTES, "1.0.0");
    expect(notes.entry).toMatchObject({ packageName: NOTES, latestVersion: "1.1.0", bundled: false });
    expect(notes.versions.map((v: Json) => v.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(notes.review).toMatchObject({
      packageName: NOTES,
      version: "1.0.0",
      channel: "official",
      publisher: "ocw-test",
      verification: { tier: "source-linked", sourceRepo: "ocw-test/notes-plugin" },
      scan: { status: "clean", blockedFromDownload: false, pending: false },
      compatibility: { compatible: true },
      artifact: { sha256: "1a".repeat(32) },
      declared: { tools: ["notes_lookup"] },
      risk: "low",
      riskReasons: [],
    });
    expect(notes.review.reviewToken).toMatch(/^[0-9a-f]{64}$/);
    // Without ?version the latest is reviewed.
    expect((await review(NOTES)).review.version).toBe("1.1.0");

    const echo = await review(ECHO);
    expect(echo.review.risk).toBe("high");
    expect(echo.review.riskReasons.map((r: Json) => r.code)).toEqual(["community_channel"]);

    const shell = await review(SHELL);
    expect(shell.review.risk).toBe("refuse");
    expect(shell.review.riskReasons.map((r: Json) => r.code)).toEqual(
      expect.arrayContaining(["dangerous_tool", "community_channel"]),
    );

    const relay = await review(RELAY);
    expect(relay.review.risk).toBe("refuse");
    expect(relay.review.riskReasons.map((r: Json) => r.code)).toEqual(["channel_bypass"]);

    const ddg = await review(DDG, "2026.9.7");
    expect(ddg.review.risk).toBe("medium");
    expect(ddg.review.riskReasons.map((r: Json) => r.code)).toEqual(["network_provider"]);
    expect(ddg.review.declared.webSearchProviders).toEqual(["duckduckgo"]);
    expect(ddg.review.artifact.sha256).toBe(
      "4b91c155182453529ac1b8f44751cf39e64d1b4d92a44c3637ef63d482453ee5",
    );
    expect(ddg.entry.bundled).toBe(true);

    expect(
      (await admin.request("GET", `/api/v1/marketplace/packages/${enc("@nobody/nothing")}`)).status,
    ).toBe(404);
    const missingVersion = await admin.request(
      "GET",
      `/api/v1/marketplace/packages/${enc(NOTES)}?version=9.9.9`,
    );
    expect(missingVersion.status).toBe(404);
  });

  it("developers get 403 plugin.manage on every marketplace route, and ClawHub is never called for them", async () => {
    fake.reset();
    const denied = await sam.request("GET", "/api/v1/marketplace/search?q=duck");
    expect(denied.status).toBe(403);
    expect((denied.body as Json).error.details).toMatchObject({ permission: "plugin.manage" });
    expect((await sam.request("GET", `/api/v1/marketplace/packages/${enc(NOTES)}`)).status).toBe(403);
    expect(
      (
        await sam.request("POST", "/api/v1/marketplace/installs", {
          packageName: NOTES,
          version: "1.0.0",
          reviewToken: "x",
        })
      ).status,
    ).toBe(403);
    expect((await sam.request("GET", "/api/v1/cell-plugins")).status).toBe(403);
    const id = randomUUID();
    expect((await sam.request("PATCH", `/api/v1/cell-plugins/${id}`, { orgEnabled: false })).status).toBe(
      403,
    );
    expect((await sam.request("DELETE", `/api/v1/cell-plugins/${id}`)).status).toBe(403);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("approve pinned installs (D-14, BOT-09)", () => {
  let notesId: string;
  let notesToken: string;

  it("approving the low-risk plugin with its review token → installing, one plugin.install.v1, audited", async () => {
    const r = await review(NOTES, "1.0.0");
    notesToken = r.review.reviewToken;
    const before = (await cellEvents("plugin.install.v1")).length;
    const plugin = await ok(
      admin.request("POST", "/api/v1/marketplace/installs", {
        packageName: NOTES,
        version: "1.0.0",
        reviewToken: notesToken,
      }),
    );
    notesId = plugin.id;
    expect(plugin).toMatchObject({
      packageName: NOTES,
      pluginId: "ocw-notes",
      version: "1.0.0",
      channel: "official",
      publisher: "ocw-test",
      risk: "low",
      riskReasons: [],
      status: "installing",
      orgEnabled: true,
      personalAllowed: false,
      trustedChaining: false,
      tools: [],
      installedAt: null,
    });
    expect(plugin.approvedAt).toBeTruthy();

    const row = (await su.query("select * from app.cell_plugins where id = $1", [notesId])).rows[0] as Json;
    expect(row).toMatchObject({
      organization_id: orgId,
      artifact_sha256: "1a".repeat(32),
      status: "installing",
      risk: "low",
    });
    expect(row.declared).toMatchObject({ tools: ["notes_lookup"] });
    expect(row.approved_by).toBeTruthy();
    expect(row.flow_id).toBeTruthy();

    const events = await cellEvents("plugin.install.v1");
    expect(events).toHaveLength(before + 1);
    const ev = events.at(-1) as Json;
    expect(ev).toMatchObject({
      type: "plugin.install.v1",
      organizationId: orgId,
      cellId: orgId,
      flowId: row.flow_id,
      pluginRowId: notesId,
      packageName: NOTES,
      version: "1.0.0",
      sha256: "1a".repeat(32),
      expectedPluginId: "ocw-notes",
      mode: "install",
    });
    // The artifact comes from the configured ClawHub origin only.
    expect(new URL(ev.artifactUrl).origin).toBe(new URL(clawhubUrl).origin);
    expect(ev.artifactUrl).toBe(
      `${clawhubUrl}/api/v1/packages/${enc(NOTES)}/versions/1.0.0/artifact/download`,
    );

    const audit = (await audits("plugin.install_requested")).at(-1);
    expect(audit?.resource_id).toBe(notesId);
    expect(audit?.user_id).toBeTruthy();
    expect(audit?.metadata).toMatchObject({
      packageName: NOTES,
      version: "1.0.0",
      sha256: "1a".repeat(32),
      risk: "low",
      flowId: row.flow_id,
    });

    const list = await ok(admin.request("GET", "/api/v1/cell-plugins"));
    expect(list.plugins.map((p: Json) => p.id)).toEqual([notesId]);
    const searched = await ok(admin.request("GET", "/api/v1/marketplace/search?q=notes"));
    expect(searched.entries[0].installed).toEqual({ id: notesId, version: "1.0.0", status: "installing" });
  });

  it("the same package twice → 409 already_installed", async () => {
    const res = await admin.request("POST", "/api/v1/marketplace/installs", {
      packageName: NOTES,
      version: "1.0.0",
      reviewToken: notesToken,
    });
    expect(res.status).toBe(409);
    expect(codeOf(res)).toBe("already_installed");
  });

  it("a release that changed on ClawHub between review and approval → 409 review_changed", async () => {
    const r = await review(ECHO);
    const v = fake.version(ECHO, "0.1.0");
    if (!v) throw new Error("fixture missing");
    v.artifact.sha256 = "9f".repeat(32);
    try {
      const res = await admin.request("POST", "/api/v1/marketplace/installs", {
        packageName: ECHO,
        version: "0.1.0",
        reviewToken: r.review.reviewToken,
        acknowledgeHighRisk: true,
      });
      expect(res.status).toBe(409);
      expect(codeOf(res)).toBe("review_changed");
      // The 409 carries the fresh review, and the admin's next review shows what changed.
      expect((res.body as Json).error.details.review.artifact.sha256).toBe("9f".repeat(32));
      expect((await review(ECHO)).review.artifact.sha256).toBe("9f".repeat(32));
    } finally {
      fake.reset();
    }
    expect((await su.query("select 1 from app.cell_plugins where package_name = $1", [ECHO])).rowCount).toBe(
      0,
    );
  });

  it("refused versions → 422 plugin_refused with the reasons", async () => {
    for (const name of [SHELL, RELAY]) {
      const r = await review(name);
      const res = await admin.request("POST", "/api/v1/marketplace/installs", {
        packageName: name,
        version: r.review.version,
        reviewToken: r.review.reviewToken,
        acknowledgeHighRisk: true,
      });
      expect(res.status).toBe(422);
      expect(codeOf(res)).toBe("plugin_refused");
      expect((res.body as Json).error.details.reasons.length).toBeGreaterThan(0);
    }
  });

  it("a bundled plugin id → 409 bundled_plugin", async () => {
    const r = await review(DDG, "2026.9.7");
    const res = await admin.request("POST", "/api/v1/marketplace/installs", {
      packageName: DDG,
      version: "2026.9.7",
      reviewToken: r.review.reviewToken,
    });
    expect(res.status).toBe(409);
    expect(codeOf(res)).toBe("bundled_plugin");
  });

  it("community: no acknowledgement → 409; with it → 200 and personal bots only when asked together", async () => {
    const r = await review(ECHO);
    const base = { packageName: ECHO, version: "0.1.0", reviewToken: r.review.reviewToken };
    const noAck = await admin.request("POST", "/api/v1/marketplace/installs", {
      ...base,
      personalAllowed: true,
    });
    expect(noAck.status).toBe(409);
    expect(codeOf(noAck)).toBe("high_risk_ack_required");

    const plugin = await ok(
      admin.request("POST", "/api/v1/marketplace/installs", { ...base, acknowledgeHighRisk: true }),
    );
    expect(plugin).toMatchObject({
      channel: "community",
      risk: "high",
      personalAllowed: false,
      status: "installing",
    });
    expect((await audits("plugin.install_requested")).at(-1)?.metadata).toMatchObject({
      packageName: ECHO,
      risk: "high",
      acknowledgeHighRisk: true,
      personalAllowed: false,
    });

    // Turning personal bots on later needs the acknowledgement again.
    const later = await admin.request("PATCH", `/api/v1/cell-plugins/${plugin.id}`, {
      personalAllowed: true,
    });
    expect(later.status).toBe(409);
    expect(codeOf(later)).toBe("high_risk_ack_required");
    const allowed = await ok(
      admin.request("PATCH", `/api/v1/cell-plugins/${plugin.id}`, {
        personalAllowed: true,
        acknowledgeHighRisk: true,
      }),
    );
    expect(allowed.personalAllowed).toBe(true);
    await ok(admin.request("DELETE", `/api/v1/cell-plugins/${plugin.id}`));
  });

  it("community with acknowledgement and personalAllowed requested together → personal allowed", async () => {
    // The previous install of the echo plugin is uninstalling; finish it like the cell would.
    await su.query("update app.cell_plugins set status = 'uninstalled' where package_name = $1", [ECHO]);
    const r = await review(ECHO);
    const plugin = await ok(
      admin.request("POST", "/api/v1/marketplace/installs", {
        packageName: ECHO,
        version: "0.1.0",
        reviewToken: r.review.reviewToken,
        acknowledgeHighRisk: true,
        personalAllowed: true,
      }),
    );
    expect(plugin.personalAllowed).toBe(true);
  });

  it("cross-tenant: another organization sees none of these rows (RLS → 404)", async () => {
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
    expect(await core.db.withTenant(ctxB, (tx) => listCellPlugins(tx))).toEqual([]);
    const err = await core.db.withTenant(ctxB, (tx) => getCellPlugin(tx, notesId)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(404);
    // Not vacuous: the right tenant finds it.
    const mine = await core.db.withTenant({ organizationId: orgId, userId: null }, (tx) =>
      getCellPlugin(tx, notesId),
    );
    expect(mine.id).toBe(notesId);

    // And a row of org B is invisible to org A's admin over HTTP.
    const foreign = randomUUID();
    await su.query(
      `insert into app.cell_plugins (id, organization_id, package_name, version, channel, artifact_sha256, risk, status)
       values ($1, $2, '@evil/plugin', '1.0.0', 'official', $3, 'low', 'installed')`,
      [foreign, orgB, "e".repeat(64)],
    );
    expect(
      (await admin.request("PATCH", `/api/v1/cell-plugins/${foreign}`, { orgEnabled: false })).status,
    ).toBe(404);
    expect((await admin.request("DELETE", `/api/v1/cell-plugins/${foreign}`)).status).toBe(404);
    const list = await ok(admin.request("GET", "/api/v1/cell-plugins"));
    expect(list.plugins.map((p: Json) => p.id)).not.toContain(foreign);
    expect((await su.query("select status from app.cell_plugins where id = $1", [foreign])).rows[0]).toEqual({
      status: "installed",
    });
  });
});

describe("settings, updates and uninstall (D-14, BOT-09, BOT-10)", () => {
  let notesId: string;

  /** What the cell's report (03.1-12) will do: mark the plugin installed with its tools. */
  async function markInstalled(id: string, tools: string[]) {
    await su.query("update app.cell_plugins set status = 'installed', installed_at = now() where id = $1", [
      id,
    ]);
    await su.query("delete from app.cell_plugin_tools where plugin_row_id = $1", [id]);
    for (const name of tools) {
      await su.query(
        "insert into app.cell_plugin_tools (organization_id, plugin_row_id, name, side_effecting) values ($1, $2, $3, true)",
        [orgId, id, name],
      );
    }
  }

  it("PATCH flags → audited plugin.settings_updated and a tools.updated config hint", async () => {
    const list = await ok(admin.request("GET", "/api/v1/cell-plugins"));
    notesId = list.plugins.find((p: Json) => p.packageName === NOTES).id;
    await markInstalled(notesId, ["notes_lookup"]);
    const hintsBefore = (await cellEvents("cell.config.changed")).length;
    const updated = await ok(
      admin.request("PATCH", `/api/v1/cell-plugins/${notesId}`, {
        trustedChaining: true,
        personalAllowed: true,
      }),
    );
    expect(updated).toMatchObject({
      trustedChaining: true,
      personalAllowed: true,
      orgEnabled: true,
      status: "installed",
      tools: [{ name: "notes_lookup", description: null, sideEffecting: true }],
    });
    const hints = await cellEvents("cell.config.changed");
    expect(hints).toHaveLength(hintsBefore + 1);
    expect(hints.at(-1)).toMatchObject({ reason: "tools.updated", agentId: null });
    expect((await audits("plugin.settings_updated")).at(-1)).toMatchObject({
      resource_id: notesId,
      metadata: {
        changed: ["personalAllowed", "trustedChaining"],
        personalAllowed: true,
        trustedChaining: true,
      },
    });
    // No change → no audit, no hint.
    await ok(admin.request("PATCH", `/api/v1/cell-plugins/${notesId}`, { trustedChaining: true }));
    expect(await cellEvents("cell.config.changed")).toHaveLength(hintsBefore + 1);
  });

  it("an upgrade whose declared surface grew after review → 409 review_changed", async () => {
    const r = await review(NOTES, "1.1.0");
    fake.version(NOTES, "1.1.0")?.pluginManifestSummary.contracts.tools.push("notes_export");
    try {
      const res = await admin.request("PATCH", `/api/v1/cell-plugins/${notesId}`, {
        upgrade: { version: "1.1.0", reviewToken: r.review.reviewToken },
      });
      expect(res.status).toBe(409);
      expect(codeOf(res)).toBe("review_changed");
    } finally {
      fake.reset();
    }
    const row = (await su.query("select version, status from app.cell_plugins where id = $1", [notesId]))
      .rows[0];
    expect(row).toEqual({ version: "1.0.0", status: "installed" });
  });

  it("upgrade to a newer version with its fresh token → installing, plugin.install.v1 mode update, audited", async () => {
    const r = await review(NOTES, "1.1.0");
    const before = (await cellEvents("plugin.install.v1")).length;
    const upgraded = await ok(
      admin.request("PATCH", `/api/v1/cell-plugins/${notesId}`, {
        upgrade: { version: "1.1.0", reviewToken: r.review.reviewToken },
      }),
    );
    expect(upgraded).toMatchObject({ version: "1.1.0", status: "installing", risk: "low" });
    const events = await cellEvents("plugin.install.v1");
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toMatchObject({
      pluginRowId: notesId,
      version: "1.1.0",
      sha256: "1b".repeat(32),
      mode: "update",
      expectedPluginId: "ocw-notes",
    });
    expect((await audits("plugin.update_requested")).at(-1)).toMatchObject({
      resource_id: notesId,
      metadata: { packageName: NOTES, fromVersion: "1.0.0", version: "1.1.0", sha256: "1b".repeat(32) },
    });
    const row = (
      await su.query("select declared, artifact_sha256 from app.cell_plugins where id = $1", [notesId])
    ).rows[0] as Json;
    expect(row.declared.tools).toEqual(["notes_lookup", "notes_search"]);
    expect(row.artifact_sha256).toBe("1b".repeat(32));

    // Another upgrade while one is in flight → 409.
    const busy = await admin.request("PATCH", `/api/v1/cell-plugins/${notesId}`, {
      upgrade: { version: "1.0.0", reviewToken: (await review(NOTES, "1.0.0")).review.reviewToken },
    });
    expect(busy.status).toBe(409);
    expect(codeOf(busy)).toBe("plugin_busy");
  });

  it("DELETE → uninstalling, every bot grant of the plugin removed, plugin.uninstall.v1, tools.updated, audited", async () => {
    await markInstalled(notesId, ["notes_lookup", "notes_search"]);
    const bot = await ok(
      admin.request("POST", "/api/v1/agents", {
        name: "Notes Bot",
        instructions: "Help with notes.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    );
    for (const tool of ["notes_lookup", "notes_search"]) {
      await su.query(
        "insert into app.bot_tool_grants (organization_id, agent_id, source_kind, source_id, tool_name) values ($1, $2, 'plugin', $3, $4)",
        [orgId, bot.id, notesId, tool],
      );
    }
    const otherSource = randomUUID();
    await su.query(
      "insert into app.bot_tool_grants (organization_id, agent_id, source_kind, source_id, tool_name) values ($1, $2, 'mcp', $3, 'm12345678__echo')",
      [orgId, bot.id, otherSource],
    );
    const uninstallsBefore = (await cellEvents("plugin.uninstall.v1")).length;
    const hintsBefore = (await cellEvents("cell.config.changed")).length;

    const removed = await ok(admin.request("DELETE", `/api/v1/cell-plugins/${notesId}`));
    expect(removed).toMatchObject({ id: notesId, status: "uninstalling" });

    const grants = (
      await su.query("select source_kind, source_id from app.bot_tool_grants where agent_id = $1", [bot.id])
    ).rows;
    expect(grants).toEqual([{ source_kind: "mcp", source_id: otherSource }]);
    const row = (await su.query("select flow_id from app.cell_plugins where id = $1", [notesId]))
      .rows[0] as Json;
    const events = await cellEvents("plugin.uninstall.v1");
    expect(events).toHaveLength(uninstallsBefore + 1);
    expect(events.at(-1)).toMatchObject({
      type: "plugin.uninstall.v1",
      organizationId: orgId,
      cellId: orgId,
      flowId: row.flow_id,
      pluginRowId: notesId,
      pluginId: "ocw-notes",
    });
    expect((await cellEvents("cell.config.changed")).length).toBe(hintsBefore + 1);
    expect((await audits("plugin.uninstall_requested")).at(-1)).toMatchObject({
      resource_id: notesId,
      metadata: { packageName: NOTES, version: "1.1.0", sha256: "1b".repeat(32), removedGrants: 2 },
    });
    // Idempotent while the cell works on it; changes are refused.
    expect((await ok(admin.request("DELETE", `/api/v1/cell-plugins/${notesId}`))).status).toBe(
      "uninstalling",
    );
    expect((await cellEvents("plugin.uninstall.v1")).length).toBe(uninstallsBefore + 1);
    const patch = await admin.request("PATCH", `/api/v1/cell-plugins/${notesId}`, { orgEnabled: false });
    expect(patch.status).toBe(409);
    expect(codeOf(patch)).toBe("plugin_uninstalling");
  });
});

describe("ClawHub outages (P-B6)", () => {
  it("ClawHub down with nothing cached → 503 marketplace_unavailable; chat routes unaffected", async () => {
    fake.setOutage({ status: 503 });
    try {
      const res = await admin.request("GET", "/api/v1/marketplace/search?q=never-cached-query");
      expect(res.status).toBe(503);
      expect(codeOf(res)).toBe("marketplace_unavailable");
      // A previously cached search still answers (stale copies are kept while ClawHub is down).
      const cached = await ok(admin.request("GET", "/api/v1/marketplace/search?q=duck"));
      expect(cached.source).toBe("cache");
      // So does a review seen before (a cached copy only because ClawHub is down).
      expect((await review(DDG, "2026.9.7")).review.risk).toBe("medium");
      // Approvals never use cached data.
      const r = await admin.request("POST", "/api/v1/marketplace/installs", {
        packageName: DDG,
        version: "2026.9.7",
        reviewToken: "x",
      });
      expect(r.status).toBe(503);
      // Chat keeps working.
      expect((await admin.request("GET", "/api/v1/channels")).status).toBe(200);
    } finally {
      fake.setOutage(null);
    }

    // Fully closed (connection refused) is the same typed error.
    await new Promise<void>((r) => fakeServer.close(() => r()));
    const res = await admin.request("GET", "/api/v1/marketplace/search?q=closed-server-query");
    expect(res.status).toBe(503);
    expect(codeOf(res)).toBe("marketplace_unavailable");
    expect((await admin.request("GET", "/api/v1/channels")).status).toBe(200);
  });
});
