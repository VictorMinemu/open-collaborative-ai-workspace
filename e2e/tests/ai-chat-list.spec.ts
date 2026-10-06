import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { chatIdOf, lastAssistant, openNewAiChat, seedPlan, sendAi } from "../support/ai-chat";
import { ALEX } from "../support/chat";
import { ADMIN, shot } from "./env";

/**
 * AICHAT-04 in the browser (05-10): a chat's first answer gives it a short generated title, live in the header and
 * the sidebar's "AI chats" section; /chat/ai groups the member's chats by recency with rename and archive; search
 * finds the member's own chats and nobody else's. Everything runs against the harness's fake ChatGPT plan.
 */

test.describe.configure({ mode: "serial" });

const PLAN = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");
/** A single word unique to this run and project (titles keep it as typed). */
const tagOf = (project: string) =>
  `Zq${project === "mobile" ? "m" : "d"}${Date.now().toString(36).slice(-5)}`;

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

let sam: APIRequestContext;

test.beforeAll(async () => {
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  await admin.dispose();
  sam = await apiAs(SAM);
  await seedPlan(sam);
});

test.afterAll(async () => {
  await sam?.dispose();
});

/** Opens the chat sidebar (the drawer at 390) and returns its "AI chats" section. */
async function aiSection(page: Page, mobile: boolean): Promise<Locator> {
  if (mobile) await page.getByTestId("mobile-nav-trigger").click();
  const section = page.getByTestId("sidebar-ai-chats").filter({ visible: true }).first();
  await expect(section).toBeVisible();
  return section;
}

async function closeDrawer(page: Page, mobile: boolean) {
  if (mobile) await page.keyboard.press("Escape");
}

/** A chat created through the API whose first answer and generated title have landed. */
async function apiChat(text: string): Promise<{ id: string; title: string }> {
  const res = await sam.post("/api/v1/ai-chats", {
    data: { clientMessageId: `e2e-${crypto.randomUUID()}`, body: text, model: PLAN },
  });
  expect(res.status(), `create AI chat: ${res.status()}`).toBe(201);
  const id = ((await res.json()) as { chat: { id: string } }).chat.id;
  let title = "";
  await expect
    .poll(
      async () => {
        const snap = (await (await sam.get(`/api/v1/ai-chats/${id}`)).json()) as {
          chat: { title: string; titleSource: string };
          running: unknown;
        };
        title = snap.chat.title;
        return snap.running === null && snap.chat.titleSource === "auto";
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return { id, title };
}

async function setActivity(id: string, daysAgo: number) {
  const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const res = await sam.post(`/api/v1/test/ai/chats/${id}/activity`, { data: { lastActivityAt: at } });
  expect(res.status(), `set activity: ${res.status()}`).toBe(204);
}

const row = (page: Page, id: string) => page.locator(`[data-testid="ai-chat-row"][data-chat-id="${id}"]`);

test("the first answer titles the chat live in the header and the sidebar", async ({ browser }, info) => {
  const project = info.project.name;
  const mobile = project === "mobile";
  const w = widthOf(project);
  const tag = tagOf(project);
  const { context, page } = await openAs(browser, SAM, project);

  await openNewAiChat(page);
  // Every text the header shows, in order, across the move from /chat/ai/new to /chat/ai/<id> (no reload).
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __titles: string[] }).__titles = seen;
    const read = () => {
      const t = document.querySelector('[data-testid="ai-chat-title"]')?.textContent?.trim() ?? "";
      if (t && seen.at(-1) !== t) seen.push(t);
    };
    new MutationObserver(read).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    read();
  });
  const first = `Plan the ${tag} offsite agenda`;
  await sendAi(page, first);
  await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/);
  const chatId = chatIdOf(page);
  await expect(lastAssistant(page)).toHaveAttribute("data-status", "completed", { timeout: 15_000 });

  const generated = `Plan the ${tag}`;
  const title = page.getByTestId("ai-chat-title");
  await expect(title).toHaveText(generated, { timeout: 5_000 });
  const seen = await page.evaluate(() => (window as unknown as { __titles: string[] }).__titles);
  expect(seen).toContain(first);
  expect(seen.indexOf(first)).toBeLessThan(seen.indexOf(generated));
  await bothThemes(page, `ai-chat-title-live-${w}`);

  const section = await aiSection(page, mobile);
  const top = section.getByTestId("sidebar-ai-chat").first();
  await expect(top).toHaveAttribute("data-chat-id", chatId);
  await expect(top).toHaveText(generated);
  await expect(top).toHaveAttribute("aria-current", "page");
  await expect(section.getByTestId("sidebar-ai-see-all")).toBeVisible();
  await bothThemes(page, `sidebar-ai-chats-${w}`);
  await closeDrawer(page, mobile);

  // Still there after a reload, and the title is the stored one.
  await page.reload();
  await expect(page.getByTestId("ai-chat-title")).toHaveText(generated);
  await context.close();
});

test("/chat/ai groups the member's chats and lets them rename and archive", async ({ browser }, info) => {
  const project = info.project.name;
  const mobile = project === "mobile";
  const w = widthOf(project);
  const tag = tagOf(project);

  const older = await apiChat(`Archive ${tag} quarterly reports`);
  const week = await apiChat(`Review ${tag} hiring pipeline`);
  const today = await apiChat(`Draft ${tag} launch email`);
  await setActivity(older.id, 30);
  await setActivity(week.id, 3);

  const { context, page } = await openAs(browser, SAM, project);
  await page.goto(`${BASE_URL}/chat/ai`);
  await expect(page.getByTestId("ai-new-chat")).toBeVisible();
  const group = (key: string) => page.locator(`[data-testid="ai-chat-group"][data-group="${key}"]`);
  await expect(group("today").locator(`[data-chat-id="${today.id}"]`)).toBeVisible();
  await expect(group("week").locator(`[data-chat-id="${week.id}"]`)).toBeVisible();
  await expect(group("older").locator(`[data-chat-id="${older.id}"]`)).toBeVisible();
  await expect(group("today")).toContainText("Today");
  await expect(group("week")).toContainText("Previous 7 days");
  await expect(group("older")).toContainText("Older");
  const todayRow = row(page, today.id);
  await expect(todayRow.getByTestId("ai-chat-row-title")).toHaveText(today.title);
  await expect(todayRow.getByTestId("ai-chat-row-model")).toHaveText("GPT-6 Astra");
  await expect(todayRow.locator("time")).toHaveText(/^(now|\d+m)$/);
  await expect(row(page, week.id).locator("time")).toHaveText("3d");
  // The groups come in order, before anything else on the page.
  const order = await page
    .getByTestId("ai-chat-group")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-group")));
  expect(order.indexOf("today")).toBeLessThan(order.indexOf("week"));
  expect(order.indexOf("week")).toBeLessThan(order.indexOf("older"));
  await bothThemes(page, `ai-chats-list-${w}`);

  // Rename from the row menu (a sheet at 390).
  const rowMenu = async (id: string) => {
    await row(page, id).hover();
    await row(page, id).getByTestId("ai-chat-row-menu-button").click();
    const menu = page.getByTestId("ai-chat-row-menu").filter({ visible: true });
    await expect(menu).toBeVisible();
    return menu;
  };
  await (await rowMenu(week.id)).getByTestId("ai-chat-menu-rename").click();
  const rowInput = row(page, week.id).getByTestId("ai-chat-row-title-input");
  await expect(rowInput).toBeFocused();
  await rowInput.fill(`Pipeline ${tag} review`);
  await rowInput.press("Enter");
  await expect(row(page, week.id).getByTestId("ai-chat-row-title")).toHaveText(`Pipeline ${tag} review`);

  // Archive from the row menu: it leaves the recent list and shows under Archived.
  await (await rowMenu(older.id)).getByTestId("ai-chat-menu-archive").click();
  await expect(row(page, older.id)).toHaveCount(0);
  await page.getByTestId("ai-chats-archived").click();
  await expect(row(page, older.id)).toBeVisible();
  await expect(row(page, today.id)).toHaveCount(0);

  // An archived chat opens read-only until it is unarchived.
  await row(page, older.id).getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/chat/ai/${older.id}$`));
  const notice = page.getByTestId("ai-archived-notice");
  await expect(notice).toBeVisible();
  await expect(page.getByTestId("ai-unarchive")).toHaveText("Unarchive to continue");
  await expect(page.getByTestId("ai-composer")).toHaveCount(0);
  await expect(page.getByTestId("ai-chat-archived-badge")).toBeVisible();
  await page.getByTestId("ai-unarchive").click();
  await expect(page.getByTestId("ai-composer")).toBeVisible();
  await expect(notice).toHaveCount(0);

  // Rename inline from the header: click the title, type, Enter. The sidebar follows live.
  await page.goto(`${BASE_URL}/chat/ai/${today.id}`);
  await page.getByTestId("ai-chat-title").click();
  const input = page.getByTestId("ai-chat-title-input");
  await expect(input).toBeFocused();
  await input.fill(`Launch ${tag} email v2`);
  await shot(page, `ai-chat-rename-${w}`);
  await input.press("Enter");
  await expect(page.getByTestId("ai-chat-title")).toHaveText(`Launch ${tag} email v2`);
  const section = await aiSection(page, mobile);
  await expect(section.locator(`[data-chat-id="${today.id}"]`)).toHaveText(`Launch ${tag} email v2`);
  await closeDrawer(page, mobile);

  // Escape cancels; the header menu renames too.
  await page.getByTestId("ai-chat-title").click();
  await page.getByTestId("ai-chat-title-input").fill("Not this one");
  await page.getByTestId("ai-chat-title-input").press("Escape");
  await expect(page.getByTestId("ai-chat-title")).toHaveText(`Launch ${tag} email v2`);
  await page.getByTestId("ai-chat-menu-button").click();
  await page.getByTestId("ai-chat-menu").filter({ visible: true }).getByTestId("ai-chat-menu-rename").click();
  await expect(page.getByTestId("ai-chat-title-input")).toBeFocused();
  await page.getByTestId("ai-chat-title-input").fill(`Launch ${tag} email final`);
  await page.getByTestId("ai-chat-title-input").press("Enter");
  await expect(page.getByTestId("ai-chat-title")).toHaveText(`Launch ${tag} email final`);
  await page.reload();
  await expect(page.getByTestId("ai-chat-title")).toHaveText(`Launch ${tag} email final`);
  await shot(page, `ai-chat-renamed-${w}`);

  await context.close();
});

/** A lowercase token unique to this run (letters only: titles and the full-text index keep it whole). */
const uniqueWord = () =>
  `zq${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.replace(/[0-9]/g, (d) =>
    String.fromCharCode(97 + Number(d)),
  );

async function openPalette(page: Page, project: string) {
  if (project === "mobile") await page.getByTestId("open-search").click();
  else await page.keyboard.press("ControlOrMeta+K");
  const palette = page.getByTestId("search-palette");
  await expect(palette).toBeVisible();
  await expect(palette.getByTestId("search-input")).toBeFocused();
  return palette;
}

test("search finds the member's own AI chats by title and text, and nobody else's", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const w = widthOf(project);
  const word = uniqueWord();
  const chat = await apiChat(`Plan the ${word} tasting menu`);
  expect(chat.title).toBe(`Plan the ${word}`);

  const { context, page } = await openAs(browser, SAM, project);
  let palette = await openPalette(page, project);
  await palette.getByTestId("search-input").pressSequentially(word, { delay: 30 });
  const entry = palette.locator(`[data-kind="ai_chat"][data-chat-id="${chat.id}"]`);
  await expect(entry).toBeVisible();
  await expect(entry).toContainText(chat.title);
  await expect(entry).toContainText("Your AI chat · GPT-6 Astra");
  await expect(palette.getByRole("group", { name: "AI chats" })).toBeVisible();
  // The chat's messages are hits too, labelled with the chat title; the answer is by the model.
  const hits = palette.locator('[data-kind="message"]').filter({ hasText: word });
  await expect(hits.first()).toBeVisible();
  await expect(hits.first()).toContainText(chat.title);
  await expect(
    palette.locator('[data-kind="message"]').filter({ hasText: "GPT-6 Astra" }).first(),
  ).toBeVisible();
  await bothThemes(page, `search-ai-chats-${w}`);
  await entry.click();
  await expect(page).toHaveURL(new RegExp(`/chat/ai/${chat.id}$`));
  await expect(page.getByTestId("ai-chat-title")).toHaveText(chat.title);

  // A message hit opens the chat too.
  palette = await openPalette(page, project);
  await palette.getByTestId("search-input").pressSequentially(`${word} tasting`, { delay: 30 });
  await palette.locator('[data-kind="message"]').filter({ hasText: word }).first().click();
  await expect(page).toHaveURL(new RegExp(`/chat/ai/${chat.id}$`));

  // The results page lists the hits under the chat's title, linking to the chat.
  await page.goto(`${BASE_URL}/search?q=${word}`);
  const group = page.locator('[data-testid="search-page-group"][data-kind="ai_chat"]').first();
  await expect(group).toContainText(chat.title);
  await expect(group).toContainText("AI chat");
  await expect(group.getByTestId("search-page-hit").first()).toHaveAttribute("href", `/chat/ai/${chat.id}`);
  await shot(page, `search-ai-chats-results-${w}`);
  await context.close();

  // Alex searching the same word sees nothing of Sam's chat.
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, ALEX, "developer");
  await admin.dispose();
  const alex = await openAs(browser, ALEX, project);
  const theirs = await openPalette(alex.page, project);
  await theirs.getByTestId("search-input").pressSequentially(word, { delay: 30 });
  await expect(theirs.getByTestId("search-empty")).toBeVisible();
  await expect(theirs.locator('[data-kind="ai_chat"]')).toHaveCount(0);
  await expect(theirs).not.toContainText(chat.title);
  await alex.page.goto(`${BASE_URL}/search?q=${word}`);
  await expect(alex.page.getByTestId("search-results-empty")).toBeVisible();
  await alex.context.close();
});
