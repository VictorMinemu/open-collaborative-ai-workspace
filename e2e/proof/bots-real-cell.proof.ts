import { createRequire } from "node:module";
import { join } from "node:path";
import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { bothThemes, DUCKDUCKGO } from "../support/bot-tools";
import { ADMIN, shot } from "../tests/env";

/**
 * The owner's done-criterion of Phase 3.1, in a REAL OpenClaw cell (scripts/cell-proof.sh starts it next to the
 * isolated stack, with egress): bots attach MCP servers and use plugins installed from the OpenClaw Marketplace
 * (ClawHub) in a real conversation.
 *
 *   a. the admin sees the cell connected;          b. Sam's personal bot turns Ready through the cell;
 *   c0. before any install the bot is offered no web_search (OCW_BUNDLED_PLUGINS=none), so what follows is the plugin's;
 *   c. the admin reviews and installs @openclaw/duckduckgo-plugin@2026.9.7 from the real ClawHub (digest, install gate);
 *   d. Sam's bot searches the real web through it;   e. the admin registers the fake MCP, Sam's bot calls its echo;
 *   f. after the uninstall the next turn has no web_search.   Both calls are in the audit log (read-only query).
 *
 * The model is the deterministic fake (`[[call <tool> <json>]]` directives); everything else is real.
 */

test.describe.configure({ mode: "serial" });

const PROJECT = "proof"; // openAs: desktop 1440×900
const DDG_VERSION = process.env.OCW_PROOF_DDG_VERSION ?? "2026.9.7";
const MCP_URL = process.env.OCW_PROOF_MCP_URL ?? "http://fake-model:18999/mcp";
const MCP_TOKEN = process.env.OCW_PROOF_MCP_TOKEN ?? "proof-mcp-token";
const MCP_NAME = "Proof MCP";
/** Real network (ClawHub, DuckDuckGo, a cold cell): generous. */
const REAL = 180_000;

// ---------------------------------------------------------------- audit (read-only, the isolated ocw_e2e database)

type AuditRow = {
  at: string;
  action: string;
  tool: string | null;
  target: string | null;
  result: string;
  status: string | null;
  resultCount: number | null;
  provider: string | null;
};
type PgClient = {
  connect(): Promise<void>;
  query<T>(sql: string): Promise<{ rows: T[] }>;
  end(): Promise<void>;
};
// `pg` is a dependency of packages/db, not of the repo root.
const requireFromDb = createRequire(join(import.meta.dirname, "..", "..", "packages", "db", "package.json"));

async function auditRows(): Promise<AuditRow[]> {
  const url = process.env.OCW_PROOF_DB_URL;
  if (!url) throw new Error("OCW_PROOF_DB_URL is not set (run through scripts/cell-proof.sh)");
  const pg = requireFromDb("pg") as { Client: new (o: { connectionString: string }) => PgClient };
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<AuditRow>(
      `select occurred_at::text as at, action, metadata->>'tool' as tool, metadata->>'target' as target, result,
              metadata->>'status' as status, (metadata->>'resultCount')::int as "resultCount",
              metadata->>'provider' as provider
         from app.audit_events
        where action like 'bot.tool_call%' or action like 'plugin.%'
        order by occurred_at, id`,
    );
    return rows;
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------- helpers

/** Sends `text` in the open DM and returns the text of the bot's reply that answers it (contains `marker`). */
async function askBot(page: Page, text: string, marker: string): Promise<string> {
  const box = page.getByTestId("composer");
  await box.click();
  await box.fill(text);
  await box.press("Enter");
  const reply = page.locator('[data-testid="message"][data-author-kind="agent"]').filter({ hasText: marker });
  await expect(reply.last()).toBeVisible({ timeout: REAL });
  return (await reply.last().innerText()).trim();
}

async function openBotSettings(page: Page) {
  await page.getByTestId("bot-settings").click();
  const sheet = page.getByTestId("bot-settings-sheet");
  await expect(sheet.getByTestId("capabilities-panel")).toBeVisible();
  return sheet;
}

type PluginRow = { id: string; packageName: string; status: string; version: string };
async function plugins(admin: APIRequestContext): Promise<PluginRow[]> {
  const res = await admin.get("/api/v1/cell-plugins");
  expect(res.ok(), "list cell plugins").toBe(true);
  return ((await res.json()) as { plugins: PluginRow[] }).plugins;
}

const installedRow = (page: Page) =>
  page.locator(`[data-testid="installed-plugin"][data-package="${DUCKDUCKGO}"]`);

/** Shared across the serial steps. */
const state: { samId: string; botId: string; dmId: string; installedAt: string; safe: string } = {
  samId: "",
  botId: "",
  dmId: "",
  installedAt: "",
  safe: "",
};

async function samInDm(browser: Browser) {
  const sam = await openAs(browser, SAM, PROJECT);
  await sam.page.goto(`${BASE_URL}/chat/dm/${state.dmId}`);
  await expect(sam.page.getByTestId("dm-view")).toBeVisible();
  return sam;
}

// ---------------------------------------------------------------- the proof

test("a. the admin sees the real cell connected", async ({ browser }) => {
  test.setTimeout(REAL);
  const boss = await openAs(browser, ADMIN, PROJECT);
  await boss.page.goto(`${BASE_URL}/settings/bots-runtime`);
  const status = boss.page.getByTestId("cell-status");
  await expect(status).toHaveAttribute("data-connected", "true", { timeout: 60_000 });
  await expect(status).toContainText("Connected");
  await shot(boss.page, "proof-cell-connected");
  await boss.context.close();
});

test("b. Sam creates his personal bot and it turns Ready through the real cell", async ({ browser }) => {
  test.setTimeout(REAL);
  const admin = await apiAs(ADMIN);
  state.samId = await ensureMember(admin, SAM, "developer");
  await admin.dispose();

  const sam = await openAs(browser, SAM, PROJECT);
  await sam.page.getByTestId("create-personal-bot").click();
  await expect(sam.page).toHaveURL(/\/chat\/dm\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  state.dmId = sam.page.url().match(/\/chat\/dm\/([0-9a-f-]{36})/)?.[1] ?? "";
  await expect(sam.page.getByTestId("dm-view")).toBeVisible();

  const samApi = await apiAs(SAM);
  const mine = async () => {
    const listed = (await (await samApi.get("/api/v1/agents")).json()) as {
      agents: Array<{ id: string; scope: string; ownerUserId: string | null; status: string }>;
    };
    return listed.agents.find((a) => a.scope === "personal" && a.ownerUserId === state.samId);
  };
  await expect.poll(async () => (await mine())?.status, { timeout: 120_000 }).toBe("ready");
  state.botId = (await mine())?.id ?? "";
  await samApi.dispose();

  // A plain message gets a real reply from the cell (the fake model greets the asker by name).
  await askBot(sam.page, "hello from the proof", "Hi Sam Lee!");
  await sam.context.close();
});

test("c0. before any install: internet is not set up and the bot is offered no web_search", async ({
  browser,
}) => {
  test.setTimeout(REAL);
  const admin = await apiAs(ADMIN);
  expect(await plugins(admin), "nothing installed yet").toEqual([]);
  await admin.dispose();
  const sam = await samInDm(browser);
  const sheet = await openBotSettings(sam.page);
  await expect(sheet.getByTestId("capability-internet")).toBeDisabled();
  await expect(sheet.getByTestId("capability-reason-internet")).toHaveText("Not set up yet — ask an admin");
  await sam.page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  const reply = await askBot(
    sam.page,
    'search before install [[call web_search {"query":"OpenClaw"}]]',
    "Tool web_search not offered",
  );
  expect(reply, "no web_search among the offered tools").not.toMatch(/\[tools:[^\]]*web_search/);
  const rows = await auditRows();
  expect(rows.filter((r) => r.action === "bot.tool_call" && r.tool === "web_search")).toEqual([]);
  await bothThemes(sam.page, "proof-before-install");
  await sam.context.close();
});

test("c. the admin reviews DuckDuckGo on the real ClawHub and installs the pinned version", async ({
  browser,
}) => {
  test.setTimeout(2 * REAL);
  const admin = await apiAs(ADMIN);
  const boss = await openAs(browser, ADMIN, PROJECT);
  const page = boss.page;
  await page.goto(`${BASE_URL}/settings/marketplace`);
  await expect(page.getByTestId("marketplace-browser")).toBeVisible();
  await page.getByTestId("marketplace-search").fill("duckduckgo");
  const entry = page.locator(`[data-testid="marketplace-entry"][data-package="${DUCKDUCKGO}"]`);
  await expect(entry).toBeVisible({ timeout: 60_000 });
  // OCW_BUNDLED_PLUGINS=none: nothing is built in, the plugin must come from the marketplace.
  await expect(entry.getByTestId("entry-bundled")).toHaveCount(0);
  await entry.click();
  const sheet = page.getByTestId("plugin-review-sheet");
  await expect(sheet.getByTestId("plugin-risk")).toBeVisible({ timeout: 60_000 });

  // Pin the reviewed version (ClawHub may list newer ones).
  if (!(await sheet.getByTestId("plugin-version").innerText()).includes(DDG_VERSION)) {
    await sheet.getByTestId("plugin-version").click();
    await page.getByRole("option", { name: new RegExp(`^${DDG_VERSION.replaceAll(".", "\\.")}`) }).click();
  }
  await expect(sheet.getByTestId("plugin-version")).toContainText(DDG_VERSION);
  await expect(sheet.getByTestId("plugin-publisher")).toContainText(/openclaw/i);
  await expect(sheet.getByTestId("plugin-channel")).toHaveText("Official");
  await expect(sheet.getByTestId("surface-providers")).toContainText("web search: duckduckgo");
  await expect(sheet.getByTestId("plugin-risk")).toHaveAttribute("data-risk", "medium");
  await expect(sheet.locator('[data-testid="risk-reason"][data-code="network_provider"]')).toBeVisible();
  await expect(sheet.getByTestId("plugin-install")).toHaveText(`Install ${DDG_VERSION}`);
  await bothThemes(page, "proof-marketplace-review");

  // The approval re-reads ClawHub live: a slow or failing ClawHub answers 503, so retry a few times.
  for (let attempt = 1; ; attempt++) {
    const answered = page.waitForResponse(
      (r) => r.url().endsWith("/api/v1/marketplace/installs") && r.request().method() === "POST",
      { timeout: 60_000 },
    );
    await sheet.getByTestId("plugin-install").click();
    const res = await answered;
    if (res.ok()) break;
    console.log(`[proof] install attempt ${attempt}: HTTP ${res.status()} ${await res.text()}`);
    expect(attempt, "ClawHub kept refusing the approval").toBeLessThan(4);
    await page.waitForTimeout(15_000);
    await expect(sheet.getByTestId("plugin-install")).toBeEnabled({ timeout: 60_000 });
  }
  await expect(sheet).toBeHidden();

  // The real executor downloads, verifies the digest, passes the install gate, and reports.
  const row = installedRow(page);
  await expect(row.getByTestId("plugin-status")).toHaveText("Installed", { timeout: REAL });
  await expect(row).toContainText(`v${DDG_VERSION}`);
  await page.getByTestId("marketplace-search").fill("");
  await row.scrollIntoViewIfNeeded();
  await bothThemes(page, "proof-plugin-installed");
  const installed = (await auditRows()).find((r) => r.action === "plugin.installed");
  expect(installed, "plugin.installed audited").toBeTruthy();
  state.installedAt = installed?.at ?? "";
  expect((await plugins(admin)).map((p) => [p.packageName, p.version, p.status])).toEqual([
    [DUCKDUCKGO, DDG_VERSION, "installed"],
  ]);
  await admin.dispose();
  await boss.context.close();
});

test("d. Sam turns internet on and his bot searches the real web through the installed plugin", async ({
  browser,
}) => {
  test.setTimeout(2 * REAL);
  const sam = await samInDm(browser);
  const sheet = await openBotSettings(sam.page);
  await expect(sheet.getByTestId("capability-reason-internet")).toHaveCount(0, { timeout: 30_000 });
  await expect(sheet.getByTestId("capability-internet")).toBeEnabled();
  const saved = sam.page.waitForResponse(
    (r) => r.url().endsWith(`/api/v1/agents/${state.botId}/capabilities`) && r.request().method() === "PATCH",
  );
  await sheet.getByTestId("capability-internet").click();
  expect((await saved).ok()).toBe(true);
  await expect(sheet.getByTestId("capability-internet")).toBeChecked();
  await sam.page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  const reply = await askBot(
    sam.page,
    'what is OpenClaw? [[call web_search {"query":"OpenClaw"}]]',
    "Tool web_search said:",
  );
  console.log(`[proof] web search reply: ${reply}`);
  const said = reply.split("Tool web_search said:")[1]?.split("[tools:")[0]?.trim() ?? "";
  expect(said.length, "the search returned text").toBeGreaterThan(0);
  expect(reply).toMatch(/\[tools:[^\]]*web_search/);

  await expect
    .poll(
      async () => {
        const rows = await auditRows();
        const call = rows.find(
          (r) => r.action === "bot.tool_call" && r.tool === "web_search" && r.result === "success",
        );
        const done = rows.find((r) => r.action === "bot.tool_call.completed" && r.tool === "web_search");
        return call && done && call.at > state.installedAt
          ? `${call.target} ${done.status} ${done.provider} ${done.resultCount}`
          : "";
      },
      { timeout: 30_000 },
    )
    .toMatch(/^duckduckgo\.com ok duckduckgo [1-9]/);
  await bothThemes(sam.page, "proof-web-search-reply");
  await sam.context.close();
});

test("e. the admin registers an MCP server; Sam's bot calls its tool in the same chat", async ({
  browser,
}) => {
  test.setTimeout(2 * REAL);
  const admin = await apiAs(ADMIN);
  const boss = await openAs(browser, ADMIN, PROJECT);
  const page = boss.page;
  await page.goto(`${BASE_URL}/settings/mcp-servers`);
  await page.getByTestId("mcp-add").first().click();
  const dialog = page.getByTestId("mcp-server-dialog");
  await dialog.getByTestId("mcp-name").fill(MCP_NAME);
  await dialog.getByTestId("mcp-url").fill(MCP_URL);
  await dialog.getByTestId("mcp-add-header").click();
  await dialog.getByTestId("mcp-header-value").fill(`Bearer ${MCP_TOKEN}`);
  await dialog.getByTestId("mcp-save").click();
  await expect(dialog).toBeHidden();

  // The real cell probes it with the official MCP SDK client.
  const card = page.locator(`[data-testid="mcp-server"][data-name="${MCP_NAME}"]`);
  await expect(card.getByTestId("mcp-status")).toHaveText("Ready", { timeout: REAL });
  await expect(card.locator('[data-testid="mcp-tool"][data-tool="echo"]')).toBeVisible();
  await expect(card.locator('[data-testid="mcp-tool"][data-tool="write_note"]')).toBeVisible();
  const personal = card.getByTestId("mcp-flag-personalAllowed");
  await personal.click();
  await expect(personal).toBeChecked();
  expect(await page.content()).not.toContain(MCP_TOKEN);
  await bothThemes(page, "proof-mcp-ready");
  const list = (await (await admin.get("/api/v1/mcp-servers")).json()) as {
    servers: Array<{ name: string; safeName: string }>;
  };
  state.safe = list.servers.find((s) => s.name === MCP_NAME)?.safeName ?? "";
  expect(state.safe).not.toBe("");
  await boss.context.close();
  await admin.dispose();

  // Sam turns echo on for his bot and uses it in the same private chat.
  const echo = `${state.safe}__echo`;
  const sam = await samInDm(browser);
  const sheet = await openBotSettings(sam.page);
  const row = sheet.getByTestId("tools-section").locator(`[data-testid="tool-row"][data-tool="${echo}"]`);
  await expect(row.getByTestId("tool-switch")).toBeEnabled();
  await row.getByTestId("tool-switch").click();
  await expect(row.getByTestId("tool-switch")).toBeChecked();
  await sam.page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  const reply = await askBot(
    sam.page,
    'echo it [[call echo {"text":"real cell proof"}]]',
    "echo: real cell proof",
  );
  console.log(`[proof] MCP reply: ${reply}`);
  expect(reply).toContain(echo);
  await expect
    .poll(
      async () =>
        (await auditRows()).find(
          (r) => r.action === "bot.tool_call" && r.tool === echo && r.result === "success",
        )?.target ?? "",
      { timeout: 30_000 },
    )
    .toBe(state.safe);
  await bothThemes(sam.page, "proof-mcp-reply");
  await sam.context.close();
});

test("f. the admin uninstalls DuckDuckGo; Sam's next turn is offered no web_search", async ({ browser }) => {
  test.setTimeout(2 * REAL);
  const admin = await apiAs(ADMIN);
  const boss = await openAs(browser, ADMIN, PROJECT);
  await boss.page.goto(`${BASE_URL}/settings/marketplace`);
  const row = installedRow(boss.page);
  await row.getByTestId("plugin-uninstall").click();
  await boss.page.getByTestId("plugin-uninstall-confirm").click();
  await expect(row).toHaveCount(0, { timeout: REAL });
  expect(await plugins(admin)).toEqual([]);
  await boss.context.close();
  await admin.dispose();

  const sam = await samInDm(browser);
  const reply = await askBot(
    sam.page,
    'search after uninstall [[call web_search {"query":"OpenClaw"}]]',
    "Tool web_search not offered",
  );
  console.log(`[proof] after uninstall: ${reply}`);
  expect(reply).not.toMatch(/\[tools:[^\]]*web_search/);
  const sheet = await openBotSettings(sam.page);
  await expect(sheet.getByTestId("capability-reason-internet")).toHaveText("Not set up yet — ask an admin");
  await sam.page.keyboard.press("Escape");
  await bothThemes(sam.page, "proof-after-uninstall");
  await sam.context.close();

  const actions = (await auditRows()).map((r) => r.action);
  for (const a of [
    "plugin.install_requested",
    "plugin.installed",
    "plugin.uninstall_requested",
    "plugin.uninstalled",
  ]) {
    expect(actions, a).toContain(a);
  }
});
