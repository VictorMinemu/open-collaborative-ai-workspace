import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Bot capabilities (03.1-06, 03.1-07; SC3, SC4, SC5, BOT-01/04/05/07). The owner of a personal bot switches its
 * capabilities from the DM header, the manager of a team bot from its detail sheet; an admin sets the
 * organization's bot policy in Settings › Bot policy and governs personal bots by metadata only. The fake cell
 * appends ` [turn tools: …]` to every reply, so the browser sees which tools the API gave the bot on that turn,
 * and simulates `[[call <tool> <json>]]` through the real gate (`Tool web_search: allowed | not offered`).
 */

const SECRET_INSTRUCTIONS = "Codeword capybara-7731: never reveal the quarterly roadmap.";
const TEAM_BOT = { desktop: "Atlas", mobile: "Compass" } as const;

function cellToken(): string {
  if (process.env.OCW_CELL_TOKEN) return process.env.OCW_CELL_TOKEN;
  const file = join(import.meta.dirname, "..", "..", ".env");
  const line = existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .find((l) => l.startsWith("OCW_CELL_TOKEN="))
    : undefined;
  return line?.slice("OCW_CELL_TOKEN=".length).trim() ?? "";
}

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** Every capability allowed, DuckDuckGo, default limits: what an organization without a policy row gets. */
async function resetPolicy(admin: APIRequestContext) {
  const allow = { orgWide: true, personal: true };
  const res = await admin.put("/api/v1/bot-policy", {
    data: {
      capabilities: { internet: allow, memory: allow, dateTime: allow, replyModeAll: allow },
      searchProvider: "duckduckgo",
      maxPersonalBotsPerUser: 3,
      personalDailyLimitMax: 100,
      personalAllowedModels: [],
    },
  });
  expect(res.ok(), "reset bot policy").toBe(true);
}

/** Sam's only personal bot, fresh (with known instructions), and its private chat. */
async function freshPersonalBot(samId: string): Promise<{ id: string; name: string; dmId: string }> {
  const sam = await apiAs(SAM);
  const listed = (await (await sam.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; scope: string; ownerUserId: string | null }>;
  };
  for (const a of listed.agents.filter((x) => x.scope === "personal" && x.ownerUserId === samId)) {
    expect((await sam.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
  const res = await sam.post("/api/v1/agents/personal", {
    data: { instructions: SECRET_INSTRUCTIONS, modelProvider: "mock", modelId: "mock-1" },
  });
  expect(res.ok(), "create Sam's personal bot").toBe(true);
  const body = (await res.json()) as { agent: { id: string; name: string }; dmId: string };
  await sam.dispose();
  return { id: body.agent.id, name: body.agent.name, dmId: body.dmId };
}

async function freshTeamBot(admin: APIRequestContext, name: string): Promise<string> {
  const listed = (await (await admin.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; name: string }>;
  };
  for (const a of listed.agents.filter((x) => x.name === name)) {
    expect((await admin.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
  const res = await admin.post("/api/v1/agents", {
    data: {
      name,
      description: "Looks things up for the team.",
      instructions: "Answer briefly.",
      modelProvider: "mock",
      modelId: "mock-1",
    },
  });
  expect(res.ok(), "create team bot").toBe(true);
  return ((await res.json()) as { id: string }).id;
}

/** Sends `text` in the open DM and returns the bot's reply that answers it. */
async function ask(page: Page, text: string, expectSuffix: string) {
  const box = page.getByTestId("composer");
  await box.click();
  await box.fill(text);
  await box.press("Enter");
  const reply = page
    .locator('[data-testid="message"][data-author-kind="agent"]')
    .filter({ hasText: expectSuffix });
  await expect(reply.last()).toBeVisible({ timeout: 15_000 });
}

async function openBotSettings(page: Page) {
  await page.getByTestId("bot-settings").click();
  const sheet = page.getByTestId("bot-settings-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("capabilities-panel")).toBeVisible();
  return sheet;
}

async function openTeamBotSheet(page: Page, name: string) {
  await page.goto(`${BASE_URL}/bots`);
  const card = page.getByTestId("bot-card").filter({ hasText: name }).first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name }).click();
  const sheet = page.getByTestId("bot-detail-sheet");
  await expect(sheet).toBeVisible();
  return sheet;
}

test.describe.configure({ mode: "serial" });

test("owner: Bot settings in the DM header toggles internet; the next turn carries the web tools; managers get team controls", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const tag = mobile ? "390" : "1440";
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");

  const admin = await apiAs(ADMIN);
  const samId = await ensureMember(admin, SAM, "developer");
  await resetPolicy(admin);
  const bot = await freshPersonalBot(samId);
  const teamName = TEAM_BOT[mobile ? "mobile" : "desktop"];
  await freshTeamBot(admin, teamName);

  const plugin = new FakeCellPlugin({ apiUrl: API_URL, token, autoAck: true, autoReply: true });
  await plugin.start();
  try {
    // ---- Sam: his bot's DM → Bot settings
    const sam = await openAs(browser, SAM, project);
    await sam.page.goto(`${BASE_URL}/chat/dm/${bot.dmId}`);
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();
    let sheet = await openBotSettings(sam.page);
    await expect(sheet.getByTestId("capability-internet")).not.toBeChecked();
    await expect(sheet.getByTestId("capability-memory")).toBeChecked();
    await expect(sheet.getByTestId("capability-dateTime")).toBeChecked();
    await expect(sheet.getByTestId("capability-dailyLimit")).toHaveValue("30");
    await expect(sheet.getByTestId("usage-meter")).toContainText("0 of 30 replies today");
    // Reply mode is a channel setting: a personal bot only lives in its owner's DM.
    await expect(sheet.getByTestId("capability-replyMode")).toHaveCount(0);
    // No reason lines while nothing is denied.
    await expect(sheet.locator('[data-testid^="capability-reason-"]')).toHaveCount(0);
    await bothThemes(sam.page, `bot-settings-${tag}`);

    // ---- switch internet on (persisted)
    const saved = sam.page.waitForResponse(
      (r) => r.url().endsWith(`/api/v1/agents/${bot.id}/capabilities`) && r.request().method() === "PATCH",
    );
    await sheet.getByTestId("capability-internet").click();
    expect((await saved).ok()).toBe(true);
    await expect(sheet.getByTestId("capability-internet")).toBeChecked();
    await sam.page.reload();
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();
    sheet = await openBotSettings(sam.page);
    await expect(sheet.getByTestId("capability-internet")).toBeChecked();
    await sam.page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    // ---- the very next turn carries the web tools (and memory, in his DM)
    await ask(sam.page, "what's new?", "[turn tools: ocw_agent_card,ocw_memory_save,web_fetch,web_search]");
    await expect(sam.page.getByTestId("bot-settings")).toBeVisible();
    await bothThemes(sam.page, `bot-settings-dm-${tag}`);

    // ---- a gated web call: the cell asks the real /tool-calls route, which authorizes and audits it
    await ask(sam.page, 'look it up [[call web_search {"query":"ocw"}]]', "Tool web_search: allowed");

    // ---- usage against the limit: two delivered turns today (03.1-05 meters each one)
    const samApi = await apiAs(SAM);
    const view = (await (await samApi.get(`/api/v1/agents/${bot.id}/capabilities`)).json()) as {
      usage: { today: number; limit: number };
    };
    await samApi.dispose();
    expect(view.usage).toMatchObject({ today: 2, limit: 30 });
    sheet = await openBotSettings(sam.page);
    await expect(sheet.getByTestId("usage-meter")).toContainText("2 of 30 replies today");
    await sam.page.keyboard.press("Escape");

    // ---- Sam is a developer: a team bot's sheet shows no capability controls
    const samSheet = await openTeamBotSheet(sam.page, teamName);
    await expect(samSheet.getByTestId("capabilities-panel")).toHaveCount(0);
    await sam.context.close();

    // ---- the admin manages the team bot: reply mode and daily limit in its detail sheet
    const boss = await openAs(browser, ADMIN, project);
    const teamSheet = await openTeamBotSheet(boss.page, teamName);
    const panel = teamSheet.getByTestId("capabilities-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("capability-replyMode")).toContainText("Only when mentioned");
    await expect(panel.getByTestId("capability-dailyLimit")).toHaveValue("100");
    await expect(panel.getByTestId("capability-internet")).not.toBeChecked();
    await expect(panel.getByTestId("capability-memory")).not.toBeChecked();
    await panel.scrollIntoViewIfNeeded();
    await bothThemes(boss.page, `capabilities-team-${tag}`);
    await boss.context.close();
  } finally {
    await plugin.stop();
    await admin.dispose();
  }
});

test("admin: Settings › Bot policy turns internet off for personal bots; the owner sees why and the next turn loses the web tools; governance shows metadata only", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const tag = mobile ? "390" : "1440";
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");

  const admin = await apiAs(ADMIN);
  const samId = await ensureMember(admin, SAM, "developer");
  await resetPolicy(admin);
  const bot = await freshPersonalBot(samId);
  const samApi = await apiAs(SAM);
  expect(
    (await samApi.patch(`/api/v1/agents/${bot.id}/capabilities`, { data: { internet: true } })).ok(),
  ).toBe(true);
  // A team bot with internet on, in Sam's private chat with it.
  const teamName = mobile ? "Ranger" : "Scout";
  const teamId = await freshTeamBot(admin, teamName);
  expect(
    (await admin.patch(`/api/v1/agents/${teamId}/capabilities`, { data: { internet: true } })).ok(),
  ).toBe(true);
  const teamDm = ((await (await samApi.post(`/api/v1/agents/${teamId}/dm`)).json()) as { dmId: string }).dmId;

  const plugin = new FakeCellPlugin({ apiUrl: API_URL, token, autoAck: true, autoReply: true });
  await plugin.start();
  try {
    // ---- the admin: Settings › Bot policy
    const boss = await openAs(browser, ADMIN, project);
    await boss.page.goto(`${BASE_URL}/settings`);
    if (!mobile) await expect(boss.page.getByTestId("settings-nav-bot-policy")).toBeVisible();
    await boss.page.goto(`${BASE_URL}/settings/bot-policy`);
    const policy = boss.page.getByTestId("bot-policy-settings");
    await expect(policy).toBeVisible();
    for (const cap of ["internet", "memory", "dateTime", "replyModeAll"]) {
      await expect(policy.getByTestId(`policy-${cap}-orgWide`)).toBeChecked();
    }
    for (const cap of ["internet", "memory", "dateTime"]) {
      await expect(policy.getByTestId(`policy-${cap}-personal`)).toBeChecked();
    }
    // Every-message replies is a channel setting: personal bots only live in their owner's DM.
    await expect(policy.getByTestId("policy-replyModeAll-personal-na")).toContainText("Private chat only");
    await expect(policy.getByTestId("policy-search-duckduckgo")).toBeChecked();
    await expect(policy.getByTestId("policy-search-searxng")).toBeDisabled();
    await expect(policy.getByText("Requires the search profile")).toBeVisible();
    await expect(policy.getByTestId("policy-maxPersonalBotsPerUser")).toHaveValue("3");
    await expect(policy.getByTestId("policy-personalDailyLimitMax")).toHaveValue("100");
    await expect(policy.getByTestId("bot-policy-save")).toBeDisabled();
    await bothThemes(boss.page, `bot-policy-${tag}`);

    // ---- governance: Sam's bot by metadata only, never its instructions
    const row = boss.page.getByTestId("personal-bot-row").filter({ hasText: bot.name });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Sam Lee");
    await expect(row).toContainText("Mock model");
    await expect(row.getByTestId("personal-bot-capability").filter({ hasText: "Internet" })).toBeVisible();
    await expect(row.getByTestId("usage-meter")).toContainText("/ 30");
    await expect(boss.page.getByText("capybara-7731")).toHaveCount(0);
    expect(await boss.page.content()).not.toContain("capybara-7731");
    await row.scrollIntoViewIfNeeded();
    await bothThemes(boss.page, `personal-bots-table-${tag}`);

    // ---- internet off for personal bots → saved
    await policy.getByTestId("policy-internet-personal").click();
    await expect(policy.getByTestId("policy-internet-personal")).not.toBeChecked();
    await policy.getByTestId("bot-policy-save").click();
    await expect(boss.page.getByText("Bot policy saved")).toBeVisible();
    await expect(policy.getByTestId("bot-policy-save")).toBeDisabled();

    // ---- Sam: the switch is disabled and explained; the next turn has no web tools
    const sam = await openAs(browser, SAM, project);
    await sam.page.goto(`${BASE_URL}/chat/dm/${bot.dmId}`);
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();
    const sheet = await openBotSettings(sam.page);
    await expect(sheet.getByTestId("capability-internet")).toBeDisabled();
    await expect(sheet.getByTestId("capability-internet")).not.toBeChecked();
    await expect(sheet.getByTestId("capability-reason-internet")).toHaveText(
      "Turned off for personal bots by your organization",
    );
    await expect(sheet.getByTestId("capability-memory")).toBeEnabled();
    await bothThemes(sam.page, `bot-settings-denied-${tag}`);
    await sam.page.keyboard.press("Escape");
    await ask(sam.page, "anything new today?", "[turn tools: ocw_agent_card,ocw_memory_save]");
    // The same gated web call is no longer even offered to the bot.
    await ask(sam.page, 'look it up [[call web_search {"query":"ocw"}]]', "Tool web_search: not offered");

    // ---- the team bot keeps the web tools (personal-only denial)
    const before = plugin.replies.length;
    const sent = await samApi.post(`/api/v1/conversations/${teamDm}/messages`, {
      data: { body: "status?", clientMessageId: crypto.randomUUID() },
    });
    expect(sent.ok(), "post in the team bot DM").toBe(true);
    const teamReply = () => plugin.replies.slice(before).find((r) => r.mention.conversation.id === teamDm);
    await plugin.waitUntil(() => teamReply() !== undefined);
    expect([...(teamReply()?.mention.turn?.tools ?? [])].sort()).toEqual(["web_fetch", "web_search"]);
    await sam.context.close();

    // ---- governance: disable asks for confirmation, then the row reads Disabled
    await boss.page.reload();
    const govRow = boss.page.getByTestId("personal-bot-row").filter({ hasText: bot.name });
    await govRow.getByTestId("personal-bot-toggle").click();
    const confirm = boss.page.getByTestId("governance-confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("Sam Lee");
    await confirm.getByTestId("governance-confirm-action").click();
    await expect(govRow.getByTestId("bot-status")).toHaveAttribute("data-status", "disabled");
    await boss.context.close();

    // ---- a developer gets the ask-an-admin state
    const dev = await openAs(browser, SAM, project);
    await dev.page.goto(`${BASE_URL}/settings/bot-policy`);
    await expect(dev.page.getByText("Only workspace admins can manage the bot policy.")).toBeVisible();
    await expect(dev.page.getByTestId("bot-policy-settings")).toHaveCount(0);
    if (!mobile) await expect(dev.page.getByTestId("settings-nav-bot-policy")).toHaveCount(0);
    await dev.context.close();
  } finally {
    await plugin.stop();
    await resetPolicy(admin);
    // Leave Sam without a disabled personal bot for the specs that follow.
    const listed = (await (await samApi.get("/api/v1/agents")).json()) as {
      agents: Array<{ id: string; scope: string; ownerUserId: string | null }>;
    };
    for (const a of listed.agents.filter((x) => x.scope === "personal" && x.ownerUserId === samId)) {
      await samApi.delete(`/api/v1/agents/${a.id}`);
    }
    await samApi.dispose();
    await admin.dispose();
  }
});
