import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Bot capabilities (03.1-06; SC3, SC4, SC5, BOT-01/04/05/07). The owner of a personal bot switches its
 * capabilities from the DM header, the manager of a team bot from its detail sheet; an admin sets the
 * organization's bot policy in Settings › Bot policy and governs personal bots by metadata only. The fake cell
 * appends ` [turn tools: …]` to every reply, so the browser sees which tools the API gave the bot on that turn.
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
    await ask(sam.page, "what's new?", "[turn tools: ocw_memory_save,web_fetch,web_search]");
    await expect(sam.page.getByTestId("bot-settings")).toBeVisible();
    await bothThemes(sam.page, `bot-settings-dm-${tag}`);

    // ---- usage against the limit, as the API counts it (03.1-05 meters turns)
    const samApi = await apiAs(SAM);
    const view = (await (await samApi.get(`/api/v1/agents/${bot.id}/capabilities`)).json()) as {
      usage: { today: number; limit: number };
    };
    await samApi.dispose();
    sheet = await openBotSettings(sam.page);
    await expect(sheet.getByTestId("usage-meter")).toContainText(`${view.usage.today} of 30 replies today`);
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
