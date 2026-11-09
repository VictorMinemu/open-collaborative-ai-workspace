import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import {
  type Actor,
  apiAs,
  BASE_URL,
  ensureMember,
  expectChannelLanding,
  openAs,
  SAM,
} from "../support/actors";
import { postAs } from "../support/chat";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import { ADMIN, API_URL, shot } from "./env";

/**
 * CHAT-04 (D-06): direct messages between people. The admin opens a DM with a colleague from the New message
 * picker; it appears in both sidebars live and messages flow both ways; "Message" on the colleague's card in the
 * search palette lands in the same conversation. Then a mixed group DM with a team bot that answers only when
 * @mentioned, at the top level (D-06).
 */

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

/** A fresh team bot on the never-metered mock model (bots left by earlier runs are deleted first). */
async function freshTeamBot(
  admin: APIRequestContext,
  name: string,
): Promise<{ id: string; username: string }> {
  const listed = (await (await admin.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; name: string }>;
  };
  for (const a of listed.agents.filter((x) => x.name === name)) {
    expect((await admin.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
  const res = await admin.post("/api/v1/agents", {
    data: {
      name,
      description: "Answers when someone in a group asks it.",
      instructions: "Answer briefly.",
      modelProvider: "mock",
      modelId: "mock-1",
    },
  });
  expect(res.ok(), "create team bot").toBe(true);
  return (await res.json()) as { id: string; username: string };
}

/** One colleague per project, so desktop and mobile each create their own DM. */
const COLLEAGUE: Record<string, Actor> = {
  desktop: { name: "Rosa Díaz", email: "rosa@ocw.test", password: "rosa-e2e-password-123" },
  mobile: { name: "Theo Park", email: "theo@ocw.test", password: "theo-e2e-password-123" },
};

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** Opens the sidebar on phones (it lives in the navigation sheet there). */
async function openNav(page: Page, mobile: boolean) {
  if (mobile) await page.getByTestId("mobile-nav-trigger").click();
}

async function openPalette(page: Page, mobile: boolean) {
  if (mobile) await page.getByTestId("open-search").click();
  else await page.keyboard.press("ControlOrMeta+K");
  const palette = page.getByTestId("search-palette");
  await expect(palette).toBeVisible();
  await expect(palette.getByTestId("search-input")).toBeFocused();
  return palette;
}

test.describe.configure({ mode: "serial" });

test("a member opens a DM with a colleague from New message; both chat live; search opens the same DM", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const tag = mobile ? "390" : "1440";
  const colleague = COLLEAGUE[project] ?? (COLLEAGUE.desktop as Actor);

  const admin = await apiAs(ADMIN);
  const colleagueId = await ensureMember(admin, colleague, "developer");

  // The colleague is already in the app, on a channel, when the DM is created.
  const them = await openAs(browser, colleague, project);
  const me = await openAs(browser, ADMIN, project);

  // ---- New message → pick the colleague → Go
  await openNav(me.page, mobile);
  await me.page.getByTestId("dm-section").getByTestId("new-dm").click();
  const dialog = me.page.getByTestId("new-dm-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("new-dm-input")).toBeFocused();
  if (mobile) {
    // A full-height sheet on phones.
    const box = await dialog.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThan(800);
  }
  await dialog
    .getByTestId("new-dm-input")
    .pressSequentially(colleague.name.split(" ")[0] ?? "", { delay: 20 });
  await dialog.locator(`[data-testid="new-dm-option"][data-name="${colleague.name}"]`).click();
  await expect(dialog.getByTestId("new-dm-chip")).toContainText(colleague.name);
  await expect(dialog.getByTestId("new-dm-hint")).toHaveText("Direct message");
  await bothThemes(me.page, `dm-new-dialog-${tag}`);
  await dialog.getByTestId("new-dm-go").click();

  await expect(me.page).toHaveURL(/\/chat\/dm\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const dmId = me.page.url().match(/\/chat\/dm\/([0-9a-f-]{36})/)?.[1] ?? "";
  await expect(me.page.getByTestId("dm-view")).toHaveAttribute("data-dm-kind", "user");
  await expect(me.page.getByTestId("dm-title")).toHaveText(colleague.name);
  await expect(me.page.getByTestId("new-dm-dialog")).toBeHidden();

  // ---- the colleague's sidebar lists it live (no reload)
  await openNav(them.page, mobile);
  const link = them.page.locator(`[data-testid="dm-link"][href="/chat/dm/${dmId}"]`);
  await expect(link).toBeVisible({ timeout: 5_000 });
  await expect(link).toContainText(ADMIN.name);
  await link.click();
  await expect(them.page.getByTestId("dm-title")).toHaveText(ADMIN.name);

  // ---- a message each way, live
  const word = Date.now().toString(36);
  const box = them.page.getByTestId("composer");
  await box.click();
  await box.fill(`hola ${word}, ¿tienes un minuto?`);
  await box.press("Enter");
  await expect(me.page.getByText(`hola ${word}, ¿tienes un minuto?`)).toBeVisible({ timeout: 10_000 });
  const mine = me.page.getByTestId("composer");
  await mine.click();
  await mine.fill(`Claro ${word}, dime`);
  await mine.press("Enter");
  await expect(them.page.getByText(`Claro ${word}, dime`)).toBeVisible({ timeout: 10_000 });
  await bothThemes(me.page, `dm-human-${tag}`);
  await them.context.close();

  // ---- search palette: the colleague's card → Message → the same DM
  await me.page.goto(`${BASE_URL}/chat`);
  await expectChannelLanding(me.page);
  await expect(me.page.getByTestId("composer")).toBeVisible();
  const palette = await openPalette(me.page, mobile);
  await palette
    .getByTestId("search-input")
    .pressSequentially(colleague.name.split(" ")[0] ?? "", { delay: 30 });
  const person = palette.locator(`[data-kind="person"][data-person-id="${colleagueId}"]`);
  await expect(person).toBeVisible();
  await person.click();
  await expect(palette.getByTestId("search-profile")).toContainText(colleague.name);
  await palette.getByTestId("search-profile-message").click();
  await expect(palette).toBeHidden();
  await expect(me.page).toHaveURL(new RegExp(`/chat/dm/${dmId}$`));
  await expect(me.page.getByText(`Claro ${word}, dime`)).toBeVisible();
  await me.context.close();

  // Over the API the same pair always resolves to this conversation.
  const again = await admin.post("/api/v1/dms", {
    data: { participants: [{ kind: "user", id: colleagueId }] },
  });
  expect(((await again.json()) as { id: string }).id).toBe(dmId);
  await postAs(admin, dmId, `api ${word}`);
  await admin.dispose();
});

test("a mixed group DM: the admin adds Sam and a team bot; Sam sees it live; the bot answers only when @mentioned", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const tag = mobile ? "390" : "1440";
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");

  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  const botName = mobile ? "Relay" : "Courier";
  const bot = await freshTeamBot(admin, botName);
  const plugin = new FakeCellPlugin({ apiUrl: API_URL, token, autoAck: true, autoReply: true });
  await plugin.start();
  try {
    const sam = await openAs(browser, SAM, project);
    const me = await openAs(browser, ADMIN, project);

    // ---- New message → Sam + the bot → a group of 3
    await openNav(me.page, mobile);
    await me.page.getByTestId("dm-section").getByTestId("new-dm").click();
    const dialog = me.page.getByTestId("new-dm-dialog");
    await expect(dialog).toBeVisible();
    const input = dialog.getByTestId("new-dm-input");
    await input.pressSequentially("Sam", { delay: 20 });
    await dialog.locator('[data-testid="new-dm-option"][data-name="Sam Lee"]').click();
    await input.pressSequentially(botName, { delay: 20 });
    await dialog.locator(`[data-testid="new-dm-option"][data-name="${botName}"]`).click();
    await expect(dialog.getByTestId("new-dm-chip")).toHaveCount(2);
    await expect(dialog.getByTestId("new-dm-hint")).toHaveText("Group of 3, you included");
    await shot(me.page, `dm-group-dialog-${tag}`);
    await dialog.getByTestId("new-dm-go").click();

    await expect(me.page).toHaveURL(/\/chat\/dm\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    const groupId = me.page.url().match(/\/chat\/dm\/([0-9a-f-]{36})/)?.[1] ?? "";
    await expect(me.page.getByTestId("dm-view")).toHaveAttribute("data-dm-kind", "group");
    await expect(me.page.getByTestId("dm-title")).toHaveText(`Sam Lee and ${botName}`);

    // ---- Sam's sidebar lists it live
    await openNav(sam.page, mobile);
    const link = sam.page.locator(`[data-testid="dm-link"][href="/chat/dm/${groupId}"]`);
    await expect(link).toBeVisible({ timeout: 5_000 });
    await expect(link).toHaveAttribute("data-dm-kind", "group");
    await link.click();
    await expect(sam.page.getByTestId("dm-title")).toHaveText(`${ADMIN.name} and ${botName}`);

    const deliveries = () =>
      plugin.events.filter(
        (e) =>
          e.type === "agent.mention.v1" &&
          (e.data as { conversation?: { id?: string } }).conversation?.id === groupId,
      ).length;

    // ---- no mention: humans only, no bot turn
    const box = sam.page.getByTestId("composer");
    await box.click();
    await box.fill("Morning! Quick sync on the release?");
    await box.press("Enter");
    await expect(me.page.getByText("Morning! Quick sync on the release?")).toBeVisible({ timeout: 10_000 });

    // ---- @bot: one delivery, the reply lands at the top level for everyone
    await box.fill(`@${bot.username} what's the status?`);
    await box.press("Enter");
    const reply = (page: Page) =>
      page
        .locator('[data-testid="message"][data-author-kind="agent"]')
        .filter({ hasText: "Asked by Sam Lee" });
    await expect(reply(sam.page).first()).toBeVisible({ timeout: 15_000 });
    await expect(reply(me.page).first()).toBeVisible({ timeout: 10_000 });
    await expect(me.page.getByTestId("thread-summary")).toHaveCount(0);
    expect(deliveries()).toBe(1);

    // ---- header: stacked avatars and the fixed member list
    await me.page.getByTestId("group-members").click();
    const list = me.page.getByTestId("group-members-list");
    await expect(list).toBeVisible();
    await expect(list).toContainText("Sam Lee");
    await expect(list).toContainText(botName);
    await expect(list.getByTestId("bot-badge")).toHaveCount(1);
    await shot(me.page, `dm-group-members-${tag}`);
    await me.page.keyboard.press("Escape");
    await bothThemes(me.page, `dm-group-${tag}`);
    await sam.context.close();
    await me.context.close();
  } finally {
    await plugin.stop();
    await admin.dispose();
  }
});
