import { expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import {
  ask,
  bothThemes,
  cellToken,
  clearPlugins,
  DUCKDUCKGO,
  ECHO,
  ensurePluginInstalled,
  FAKE_URL,
  freshTeamBot,
  listPlugins,
  NOTES,
  openTeamBotSheet,
  PLUGIN_TOOLS,
  SHELL,
} from "../support/bot-tools";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Settings › Marketplace (03.1-13; SC7, BOT-09, BOT-10). An admin browses the fake ClawHub through the API,
 * reviews a pinned version (publisher, channel, verification, scan, declared tools, risk with reasons), installs
 * it, updates it to a newer reviewed version and uninstalls it; the simulated cell reports each install with its
 * tools. High risk needs the typed acknowledgement, Blocked versions have no install button, bundled plugins
 * have nothing to install. A plugin tool then becomes an ordinary per-bot tool, used through the real gate.
 */

test.describe.configure({ mode: "serial" });

function newCell(token: string) {
  return new FakeCellPlugin({
    apiUrl: API_URL,
    token,
    autoAck: true,
    autoReply: true,
    pluginTools: PLUGIN_TOOLS,
    stepMs: 1200,
  });
}

async function search(page: Page, q: string) {
  const box = page.getByTestId("marketplace-search");
  await box.fill(q);
  await expect(page.getByTestId("marketplace-entry").first()).toBeVisible();
}

async function openEntry(page: Page, packageName: string) {
  await page.locator(`[data-testid="marketplace-entry"][data-package="${packageName}"]`).click();
  const sheet = page.getByTestId("plugin-review-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("plugin-risk")).toBeVisible();
  return sheet;
}

const installedRow = (page: Page, packageName: string) =>
  page.locator(`[data-testid="installed-plugin"][data-package="${packageName}"]`);

test("admin: browse, review, install a pinned version, update it, judge high-risk and blocked plugins, uninstall", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const tag = mobile ? "390" : "1440";
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");
  test.skip(!FAKE_URL, "OCW_E2E_FAKE_URL is not set (the fake ClawHub is not running)");

  const admin = await apiAs(ADMIN);
  const cell = newCell(token);
  await cell.start();
  try {
    await clearPlugins(admin, cell);
    const boss = await openAs(browser, ADMIN, project);
    const page = boss.page;
    await page.goto(`${BASE_URL}/settings/marketplace`);
    if (!mobile) await expect(page.getByTestId("settings-nav-marketplace")).toBeVisible();
    await expect(page.getByTestId("marketplace-browser")).toBeVisible();
    await expect(page.locator(`[data-testid="marketplace-entry"][data-package="${NOTES}"]`)).toBeVisible();
    await expect(page.getByTestId("installed-plugins")).toHaveCount(0);
    await bothThemes(page, `marketplace-${tag}`);

    // ---- search, then review the official notes plugin
    await search(page, "notes");
    await expect(page.locator(`[data-testid="marketplace-entry"][data-package="${ECHO}"]`)).toHaveCount(0);
    let sheet = await openEntry(page, NOTES);
    await expect(sheet.getByTestId("plugin-publisher")).toContainText("ocw-test");
    await expect(sheet.getByTestId("plugin-channel")).toHaveText("Official");
    await expect(sheet.getByTestId("plugin-version")).toContainText("1.1.0");
    await expect(sheet.getByTestId("plugin-verification")).toContainText("source linked");
    await expect(sheet.getByTestId("plugin-scan")).toContainText("Scan clean");
    await expect(sheet.getByTestId("risk-low")).toBeVisible();
    await expect(sheet.getByTestId("plugin-risk")).toHaveAttribute("data-risk", "low");
    await expect(sheet.getByTestId("surface-tools")).toContainText("notes_search");
    await expect(sheet.getByTestId("plugin-trust-note")).toContainText(
      "Plugins run inside your bots' runtime. Only install plugins you trust.",
    );

    // ---- pin the older version: the review follows it
    await sheet.getByTestId("plugin-version").click();
    await page.getByRole("option", { name: /^1\.0\.0/ }).click();
    await expect(sheet.getByTestId("plugin-install")).toHaveText("Install 1.0.0");
    await expect(sheet.getByTestId("surface-tools")).toContainText("notes_lookup");
    await expect(sheet.getByTestId("surface-tools")).not.toContainText("notes_search");
    await bothThemes(page, `plugin-review-${tag}`);
    await sheet.getByTestId("plugin-install").click();
    await expect(sheet).toBeHidden();

    // ---- the simulated cell installs it: Installing, then Installed with its tool
    let row = installedRow(page, NOTES);
    await expect(row.getByTestId("plugin-status")).toHaveText("Installing");
    await expect(row.getByTestId("plugin-status")).toHaveText("Installed", { timeout: 15_000 });
    await expect(row).toContainText("v1.0.0");
    await expect(row.getByTestId("plugin-tools")).toContainText("notes_lookup");

    // ---- a newer version: a fresh review, then the update
    await row.getByTestId("plugin-update-available").click();
    sheet = page.getByTestId("plugin-review-sheet");
    await expect(sheet.getByTestId("plugin-version")).toContainText("1.1.0");
    await expect(sheet.getByTestId("surface-tools")).toContainText("notes_search");
    await sheet.getByTestId("plugin-update").click();
    await expect(sheet).toBeHidden();
    row = installedRow(page, NOTES);
    await expect(row.getByTestId("plugin-status")).toHaveText("Updating");
    await expect(row.getByTestId("plugin-status")).toHaveText("Installed", { timeout: 15_000 });
    await expect(row).toContainText("v1.1.0");
    await expect(row.getByTestId("plugin-tools")).toContainText("notes_search");
    await expect(row.getByTestId("plugin-update-available")).toHaveCount(0);

    // ---- a community plugin: High risk, install only after the typed acknowledgement
    await search(page, "echo");
    sheet = await openEntry(page, ECHO);
    await expect(sheet.getByTestId("risk-high")).toBeVisible();
    await expect(sheet.getByTestId("plugin-channel")).toHaveText("Community");
    await expect(sheet.locator('[data-testid="risk-reason"][data-code="community_channel"]')).toBeVisible();
    await expect(sheet.getByTestId("plugin-install")).toBeDisabled();
    await expect(sheet.getByTestId("plugin-personal")).toBeDisabled();
    await sheet.getByTestId("ack-high-risk").fill("install anyway");
    await expect(sheet.getByTestId("plugin-install")).toBeEnabled();
    await expect(sheet.getByTestId("plugin-personal")).toBeEnabled();
    if (!mobile) await shot(page, "plugin-review-high-1440");
    await sheet.getByTestId("plugin-install").click();
    await expect(sheet).toBeHidden();
    await expect(installedRow(page, ECHO).getByTestId("plugin-status")).toHaveText("Installed", {
      timeout: 15_000,
    });
    await expect(installedRow(page, ECHO).getByTestId("plugin-tools")).toContainText("ocw_echo");

    // ---- a refused plugin: Blocked with its reasons, no install button
    await search(page, "shell");
    sheet = await openEntry(page, SHELL);
    await expect(sheet.getByTestId("risk-refuse")).toHaveText("Blocked");
    await expect(sheet.locator('[data-testid="risk-reason"][data-code="dangerous_tool"]')).toBeVisible();
    await expect(sheet.getByTestId("plugin-blocked")).toBeVisible();
    await expect(sheet.getByTestId("plugin-install")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    // ---- a bundled plugin: nothing to install
    const ddg = (await (await admin.get("/api/v1/marketplace/search?q=duckduckgo")).json()) as {
      entries: Array<{ packageName: string; bundled: boolean }>;
    };
    expect(ddg.entries.find((e) => e.packageName === DUCKDUCKGO)?.bundled, "DuckDuckGo is bundled").toBe(
      true,
    );
    await search(page, "duckduckgo");
    await expect(
      page
        .locator(`[data-testid="marketplace-entry"][data-package="${DUCKDUCKGO}"]`)
        .getByTestId("entry-bundled"),
    ).toHaveText("Built in");
    sheet = await openEntry(page, DUCKDUCKGO);
    await expect(sheet.getByTestId("plugin-bundled")).toContainText("Included with the workspace");
    await expect(sheet.getByTestId("plugin-install")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    // ---- the installed list
    await page.getByTestId("marketplace-search").fill("");
    await page.getByTestId("installed-plugins").scrollIntoViewIfNeeded();
    if (!mobile) await bothThemes(page, "installed-plugins-1440");

    // ---- uninstall after a confirmation
    row = installedRow(page, NOTES);
    await row.getByTestId("plugin-uninstall").click();
    const confirm = page.getByTestId("plugin-confirm");
    await expect(confirm).toContainText("Uninstall @ocw-test/notes-plugin?");
    await confirm.getByTestId("plugin-uninstall-confirm").click();
    await expect(row.getByTestId("plugin-status")).toHaveText("Uninstalling");
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    expect((await listPlugins(admin)).map((p) => p.packageName)).toEqual([ECHO]);
    await boss.context.close();
  } finally {
    await cell.stop();
    await admin.dispose();
  }
});

test("bot manager: a marketplace plugin's tool is enabled per bot, used through the gate, and gone after uninstall", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");
  test.skip(!FAKE_URL, "OCW_E2E_FAKE_URL is not set (the fake ClawHub is not running)");

  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  const cell = newCell(token);
  await cell.start();
  const samApi = await apiAs(SAM);
  try {
    await ensurePluginInstalled(admin, ECHO);
    const teamName = mobile ? "Parrot" : "Echoer";
    const teamId = await freshTeamBot(admin, teamName);
    const dmId = ((await (await samApi.post(`/api/v1/agents/${teamId}/dm`)).json()) as { dmId: string }).dmId;

    // ---- the admin turns ocw_echo on in the team bot's settings
    const boss = await openAs(browser, ADMIN, project);
    let sheet = await openTeamBotSheet(boss.page, teamName);
    let tool = sheet.locator('[data-testid="tool-row"][data-tool="ocw_echo"]');
    await expect(tool).toBeVisible();
    await expect(tool.getByTestId("tool-effect")).toHaveText("Changes data");
    await expect(tool.getByTestId("tool-switch")).not.toBeChecked();
    const saved = boss.page.waitForResponse(
      (r) => r.url().endsWith(`/api/v1/agents/${teamId}/capabilities`) && r.request().method() === "PATCH",
    );
    await tool.getByTestId("tool-switch").click();
    expect((await saved).ok()).toBe(true);
    await expect(tool.getByTestId("tool-switch")).toBeChecked();

    // ---- Sam asks the bot to use it: the simulated cell asks the real /tool-calls gate, which decides it for
    // the bot ∩ Sam and audits it (bot.tool_call; asserted by the API's plugins-cell / tool-calls integration tests)
    const sam = await openAs(browser, SAM, project);
    await sam.page.goto(`${BASE_URL}/chat/dm/${dmId}`);
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();
    await ask(
      sam.page,
      'echo this [[call ocw_echo {"text":"x"}]]',
      "Tool ocw_echo: allowed",
      "[turn tools: ocw_agent_card,ocw_automation_propose,ocw_echo,ocw_start_work_zone,ocw_task_continue,ocw_task_finish,ocw_task_start,ocw_work_zone_projects]",
    );
    // ---- the admin uninstalls the plugin from Settings › Marketplace
    await boss.page.goto(`${BASE_URL}/settings/marketplace`);
    const row = installedRow(boss.page, ECHO);
    await row.getByTestId("plugin-uninstall").click();
    await boss.page.getByTestId("plugin-uninstall-confirm").click();
    await expect(row).toHaveCount(0, { timeout: 15_000 });

    // ---- the tool left the bot's settings, and the next turn no longer carries it
    sheet = await openTeamBotSheet(boss.page, teamName);
    tool = sheet.locator('[data-testid="tool-row"][data-tool="ocw_echo"]');
    await expect(tool).toHaveCount(0);
    await ask(
      sam.page,
      'again [[call ocw_echo {"text":"y"}]]',
      "Tool ocw_echo: not offered",
      "[turn tools: ocw_agent_card,ocw_automation_propose,ocw_start_work_zone,ocw_task_continue,ocw_task_finish,ocw_task_start,ocw_work_zone_projects]",
    );
    await sam.context.close();
    await boss.context.close();
  } finally {
    await clearPlugins(admin, cell).catch(() => undefined);
    await cell.stop();
    await samApi.dispose();
    await admin.dispose();
  }
});

test("member: no Marketplace entry, and the page asks for an admin", async ({ browser }, info) => {
  const project = info.project.name;
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  await admin.dispose();
  const dev = await openAs(browser, SAM, project);
  await dev.page.goto(`${BASE_URL}/settings/marketplace`);
  await expect(dev.page.getByTestId("marketplace-admin-only")).toBeVisible();
  await expect(dev.page.getByTestId("marketplace-browser")).toHaveCount(0);
  if (project !== "mobile") await expect(dev.page.getByTestId("settings-nav-marketplace")).toHaveCount(0);
  await dev.context.close();
});
