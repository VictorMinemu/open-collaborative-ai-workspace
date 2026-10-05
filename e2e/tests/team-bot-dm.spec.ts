import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Team bot DMs (03.1-02, SC2): any member opens a private chat with a team bot from its card or detail sheet;
 * the chat appears under Bots, the bot answers without an @mention (fake cell), and a second member who opens
 * a chat with the same bot gets their own, empty chat, never the first member's messages.
 */

/** A second developer, local to this spec (support/actors.ts is frozen). */
const ALEX: Actor = { name: "Alex Kim", email: "alex@ocw.test", password: "alex-e2e-password-123" };

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

/** A fresh team bot on the never-metered mock model (bots left by earlier runs are deleted first). */
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
      description: "Answers status questions for anyone on the team.",
      instructions: "Answer status questions briefly.",
      modelProvider: "mock",
      modelId: "mock-1",
    },
  });
  expect(res.ok(), "create team bot").toBe(true);
  return ((await res.json()) as { id: string }).id;
}

/** Opens the bot's private chat from the gallery: the card's Message button (desktop) or the sheet's (mobile). */
async function messageFromGallery(page: Page, name: string, mobile: boolean, shotName?: string) {
  await page.goto(`${BASE_URL}/bots`);
  const card = page.getByTestId("bot-card").filter({ hasText: name }).first();
  await expect(card.getByTestId("bot-status")).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
  await expect(card.getByTestId("bot-message")).toBeVisible();
  if (shotName) await bothThemes(page, shotName);
  if (mobile) {
    await card.getByRole("button", { name }).click();
    const sheet = page.getByTestId("bot-detail-sheet");
    await expect(sheet).toBeVisible();
    if (shotName) await shot(page, `${shotName}-sheet`);
    await sheet.getByTestId("bot-message").click();
  } else {
    await card.getByTestId("bot-message").click();
  }
  await expect(page).toHaveURL(/\/chat\/dm\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  await expect(page.getByTestId("dm-view")).toBeVisible();
  return page.url().match(/\/chat\/dm\/([0-9a-f-]{36})/)?.[1] ?? "";
}

test.describe.configure({ mode: "serial" });

test("team bot: each member gets a private chat from the card; histories stay separate", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const tag = mobile ? "390" : "1440";
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");

  const admin = await apiAs(ADMIN);
  const samId = await ensureMember(admin, SAM, "developer");
  await ensureMember(admin, ALEX, "developer");
  // Sam also owns a personal bot: only he sees it (badge), and nobody is offered it as an @mention.
  const samApi = await apiAs(SAM);
  const own = (await (await samApi.get("/api/v1/agents")).json()) as {
    agents: Array<{ name: string; scope: string; ownerUserId: string | null }>;
  };
  let personalName = own.agents.find((a) => a.scope === "personal" && a.ownerUserId === samId)?.name;
  if (!personalName) {
    const res = await samApi.post("/api/v1/agents/personal", { data: {} });
    expect(res.ok(), "create Sam's personal bot").toBe(true);
    personalName = ((await res.json()) as { agent: { name: string } }).agent.name;
  }
  await samApi.dispose();
  const name = mobile ? "Beacon" : "Pulse";
  await freshTeamBot(admin, name);

  const plugin = new FakeCellPlugin({ apiUrl: API_URL, token, autoAck: true, autoReply: true });
  await plugin.start();
  try {
    // ---- Sam: Bots › the team bot › Message → his private chat
    const sam = await openAs(browser, SAM, project);
    // The channel @mention autocomplete never offers a personal bot, not even to its owner.
    const channelBox = sam.page.getByTestId("composer");
    await channelBox.click();
    // "@a" matches Alex Kim and, by its last word, "Sam's assistant": only the person is offered.
    await channelBox.pressSequentially("@a");
    await expect(sam.page.getByTestId("mention-option").filter({ hasText: ALEX.name })).toBeVisible();
    await expect(sam.page.getByTestId("mention-option").filter({ hasText: personalName })).toHaveCount(0);
    await channelBox.fill("");

    const samDm = await messageFromGallery(sam.page, name, mobile, `team-bot-dm-gallery-${tag}`);
    await expect(sam.page.getByTestId("dm-title")).toHaveText(name);
    await expect(sam.page.getByTestId("dm-privacy")).toHaveText("Private chat · only you can see it");

    const box = sam.page.getByTestId("composer");
    await box.click();
    await box.fill("status?");
    await box.press("Enter");
    const reply = sam.page
      .locator('[data-testid="message"][data-author-kind="agent"]')
      .filter({ hasText: "Asked by Sam Lee" });
    await expect(reply.first()).toBeVisible({ timeout: 10_000 });
    await expect(sam.page.getByTestId("thread-summary")).toHaveCount(0);
    const delivered = plugin.events.filter(
      (e) =>
        e.type === "agent.mention.v1" &&
        (e.data as { conversation?: { id?: string } }).conversation?.id === samDm,
    );
    expect(delivered).toHaveLength(1);
    await bothThemes(sam.page, `team-bot-dm-${tag}`);

    // ---- the chat is listed under Bots
    if (mobile) await sam.page.getByTestId("mobile-nav-trigger").click();
    const link = sam.page.getByTestId("dm-link").filter({ hasText: name });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("aria-current", "page");
    await shot(sam.page, `team-bot-dm-sidebar-${tag}`);
    if (mobile) await sam.page.keyboard.press("Escape");

    // Opening again from the gallery lands in the same chat.
    expect(await messageFromGallery(sam.page, name, mobile)).toBe(samDm);

    // His personal bot carries the Personal badge and cannot be added to a channel.
    await sam.page.goto(`${BASE_URL}/bots`);
    const personalCard = sam.page.getByTestId("bot-card").filter({ hasText: personalName });
    await expect(personalCard.getByTestId("bot-personal-badge")).toBeVisible();
    await expect(personalCard.getByTestId("add-to-channel")).toHaveCount(0);
    await personalCard.scrollIntoViewIfNeeded();
    await shot(sam.page, `team-bot-dm-personal-card-${tag}`);
    await sam.context.close();

    // ---- Alex: same bot, his own empty chat; Sam's messages never appear
    const alex = await openAs(browser, ALEX, project);
    const alexDm = await messageFromGallery(alex.page, name, mobile);
    // Sam's personal bot never shows up for Alex.
    await alex.page.goto(`${BASE_URL}/bots`);
    await expect(alex.page.getByTestId("bot-card").filter({ hasText: name })).toBeVisible();
    await expect(alex.page.getByTestId("bot-card").filter({ hasText: personalName })).toHaveCount(0);
    await expect(alex.page.getByTestId("bot-personal-badge")).toHaveCount(0);
    await alex.page.goto(`${BASE_URL}/chat/dm/${alexDm}`);
    await expect(alex.page.getByTestId("dm-view")).toBeVisible();
    expect(alexDm).not.toBe(samDm);
    await expect(alex.page.getByTestId("dm-title")).toHaveText(name);
    await expect(alex.page.getByTestId("dm-intro")).toBeVisible();
    await expect(alex.page.getByTestId("message")).toHaveCount(0);
    await expect(alex.page.getByText("status?")).toHaveCount(0);
    await expect(alex.page.getByText("Asked by Sam Lee")).toHaveCount(0);
    if (mobile) await alex.page.getByTestId("mobile-nav-trigger").click();
    await expect(alex.page.getByTestId("dm-link").filter({ hasText: name })).toHaveCount(1);
    if (mobile) await alex.page.keyboard.press("Escape");
    await alex.page.goto(`${BASE_URL}/chat/dm/${samDm}`);
    await expect(alex.page.getByTestId("dm-missing")).toBeVisible();
    await alex.context.close();

    // And over the API: Alex cannot read Sam's chat (hidden as 404).
    const alexApi = await apiAs(ALEX);
    expect((await alexApi.get(`/api/v1/conversations/${samDm}/messages`)).status()).toBe(404);
    await alexApi.dispose();
  } finally {
    await plugin.stop();
    await admin.dispose();
  }
});
