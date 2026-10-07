import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { chatIdOf, lastAssistant, openNewAiChat, seedPlan, sendAi, waitForLonger } from "../support/ai-chat";
import { ALEX } from "../support/chat";
import { ADMIN, shot } from "./env";

/**
 * The AI chat review walk (05-14, D-08): every AI chat screen and state at the project's width (1440 desktop, 390
 * phone) in light and dark, captured as `review-<screen>-<1440|390>[-dark].png` when OCW_E2E_SCREENSHOT_DIR is set.
 * Each capture first checks the layout invariants (soft, so one broken screen never hides the others): nothing
 * scrolls sideways, the composer sits inside the viewport, the conversation column stays within 800 px at 1440, and
 * every visible control has an accessible name. Pickers and menus are bottom sheets at 390. The fake plan and fake
 * Anthropic endpoint answer; no real provider is called.
 */

test.describe.configure({ mode: "serial" });

const FAKE_URL = process.env.OCW_E2E_FAKE_URL ?? "";
const FAKE_ANTHROPIC_KEY = "sk-ant-e2e-fake-key-not-real-0000";
const PLAN = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

interface Checks {
  /** The composer is on screen and must lie inside the viewport. */
  composer?: boolean;
  /** The conversation column is on screen (≤ 800 px wide at 1440). */
  column?: boolean;
  /** Buttons that must resolve by accessible name (icon-only controls). */
  buttons?: Array<string | RegExp>;
}

/** Visible controls without an accessible name (aria-label, labelledby, text or title). */
async function unnamedControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const nameOf = (el: Element) => {
      const label = el.getAttribute("aria-label")?.trim();
      if (label) return label;
      const by = el.getAttribute("aria-labelledby");
      if (by) {
        const text = by
          .split(/\s+/u)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim();
        if (text) return text;
      }
      const text = (el as HTMLElement).innerText?.trim() || el.textContent?.trim();
      if (text) return text;
      if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return "label";
      return el.getAttribute("title")?.trim() ?? "";
    };
    const selector = 'button, [role="button"], a[href], [role="menuitem"], [role="option"], [role="switch"]';
    return [...document.querySelectorAll(selector)]
      .filter((el) => !el.closest('[aria-hidden="true"], [inert]') && visible(el) && !nameOf(el))
      .map((el) => el.outerHTML.slice(0, 200));
  });
}

async function invariants(page: Page, w: string, screen: string, checks: Checks) {
  const label = `${screen} @${w}`;
  const { scrollWidth, innerWidth, innerHeight } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  }));
  expect.soft(scrollWidth, `${label}: no sideways scroll`).toBeLessThanOrEqual(innerWidth);
  if (checks.composer) {
    const box = await page.getByTestId("ai-composer-form").boundingBox();
    expect.soft(box, `${label}: composer rendered`).toBeTruthy();
    if (box) {
      expect.soft(box.x, `${label}: composer left edge`).toBeGreaterThanOrEqual(0);
      expect.soft(box.x + box.width, `${label}: composer right edge`).toBeLessThanOrEqual(innerWidth + 0.5);
      expect.soft(box.y, `${label}: composer top`).toBeGreaterThanOrEqual(0);
      expect.soft(box.y + box.height, `${label}: composer bottom`).toBeLessThanOrEqual(innerHeight + 0.5);
    }
  }
  if (checks.column && w === "1440") {
    const width = await page
      .getByTestId("ai-message-list")
      .locator(":scope > div")
      .first()
      .evaluate((el) => el.getBoundingClientRect().width);
    expect.soft(width, `${label}: message column width`).toBeLessThanOrEqual(800);
  }
  for (const name of checks.buttons ?? []) {
    await expect
      .soft(page.getByRole("button", { name }).filter({ visible: true }).first(), `${label}: button ${name}`)
      .toBeVisible();
  }
  expect.soft(await unnamedControls(page), `${label}: controls without an accessible name`).toEqual([]);
}

/** One theme of one screen: invariants, then the capture. */
async function capture(page: Page, screen: string, w: string, theme: Theme, checks: Checks = {}) {
  await page.emulateMedia({ colorScheme: theme });
  await invariants(page, w, `${screen} (${theme})`, checks);
  await shot(page, `review-${screen}-${w}${theme === "dark" ? "-dark" : ""}`);
}

/** Both themes of one screen, back to light afterwards. */
async function review(page: Page, screen: string, w: string, checks: Checks = {}) {
  for (const theme of THEMES) await capture(page, screen, w, theme, checks);
  await page.emulateMedia({ colorScheme: "light" });
}

/** A surface that must be a popover at 1440 and a bottom sheet at 390. */
async function expectSurface(page: Page, testId: string, mobile: boolean) {
  const surface = page.getByTestId(testId).filter({ visible: true });
  await expect(surface).toBeVisible();
  await expect.soft(surface).toHaveAttribute("data-surface", mobile ? "sheet" : /popover|side/u);
  return surface;
}

let admin: APIRequestContext;
let sam: APIRequestContext;
const created: string[] = [];
let shareLink = "";

test.beforeAll(async () => {
  test.skip(!FAKE_URL, "OCW_E2E_FAKE_URL is not set (the fake model is not running)");
  admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  await ensureMember(admin, ALEX, "developer");
  sam = await apiAs(SAM);
  await seedPlan(sam);
  await sam.post("/api/v1/me/model-credentials/chatgpt/welcome-seen", { data: {} });
  // The standard organization models of the AI chat specs (METERED rows, the usage-limit fallback).
  const res = await admin.post("/api/v1/model-providers", {
    data: {
      provider: "anthropic",
      apiKey: FAKE_ANTHROPIC_KEY,
      baseUrl: FAKE_URL,
      allowedModels: ["claude-sonnet-5-5", "claude-haiku-4-5"],
      enabled: true,
    },
  });
  expect(res.ok(), `configure Anthropic: ${res.status()}`).toBe(true);
});

/** Later specs share Sam's chat list (it pages at 30): archive what this spec made. */
test.afterAll(async () => {
  for (const id of created) await sam?.patch(`/api/v1/ai-chats/${id}`, { data: { archived: true } });
  await sam?.dispose();
  await admin?.dispose();
});

test("new chat, streaming, stopped and finished answers, with the composer's menus", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const w = widthOf(project);
  const { context, page } = await openAs(browser, SAM, project);

  // New chat: the calm empty state with the composer.
  await openNewAiChat(page);
  await review(page, "new-chat", w, { composer: true, buttons: ["Send", "Tools", /^Model: /u] });

  // Streaming, then Stopped, once per theme (a slow answer lasts about four seconds).
  await sendAi(page, "count to forty [[slow]]");
  await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/u);
  created.push(chatIdOf(page));
  for (const theme of THEMES) {
    if (theme === "dark") await sendAi(page, "count again [[slow]]");
    const answer = lastAssistant(page);
    await expect(answer).toHaveAttribute("data-status", "streaming");
    await waitForLonger(answer, "Echo: count to forty 1 2".length);
    await capture(page, "streaming", w, theme, {
      composer: true,
      column: true,
      buttons: ["Stop writing", "Tools", /^Model: /u],
    });
    await page.getByTestId("ai-stop").click();
    await expect(answer).toHaveAttribute("data-status", "completed", { timeout: 5_000 });
    await expect(answer.getByTestId("ai-generation-state")).toHaveText("Stopped");
    await capture(page, "stopped", w, theme, { composer: true, column: true, buttons: ["Send"] });
  }
  await page.emulateMedia({ colorScheme: "light" });

  // A finished chat with Markdown in the answer and the footer.
  await openNewAiChat(page);
  await sendAi(
    page,
    "Plan a **two-day** team offsite in Lisbon:\n\n1. Day one — workshops\n2. Day two — a `retro` and dinner\n\n> Keep it under budget",
  );
  await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/u);
  const chatId = chatIdOf(page);
  created.push(chatId);
  await expect(lastAssistant(page)).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
  await sendAi(page, "Add a rough budget for twelve people");
  await expect(page.locator('[data-testid="ai-message"][data-role="assistant"]')).toHaveCount(2);
  await expect(lastAssistant(page)).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
  await review(page, "finished", w, {
    composer: true,
    column: true,
    buttons: ["Copy answer", "Regenerate", "Chat options", "Send", "Tools", /^Model: /u],
  });

  // The model picker, the tools menu and the regenerate menu (bottom sheets at 390).
  await page.getByTestId("ai-model-chip").click();
  await expectSurface(page, "ai-model-picker", mobile);
  await review(page, "model-picker", w, { composer: true });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("ai-model-picker")).toBeHidden();

  await page.getByTestId("ai-tools-button").click();
  await expectSurface(page, "ai-tools-menu", mobile);
  await review(page, "tools-menu", w, { composer: true });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("ai-tools-menu")).toBeHidden();

  await lastAssistant(page).getByTestId("ai-regenerate").click();
  await expectSurface(page, "ai-regenerate-menu", mobile);
  await review(page, "regenerate-menu", w, { composer: true });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("ai-regenerate-menu")).toBeHidden();

  // Chat settings (side sheet at 1440, bottom sheet at 390).
  await page.getByTestId("ai-chat-menu-button").click();
  await page.getByTestId("ai-chat-menu-settings").filter({ visible: true }).click();
  await expectSurface(page, "chat-settings-sheet", mobile);
  await review(page, "chat-settings", w);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-settings-sheet")).toBeHidden();

  // Share dialog with a fresh link.
  await page.getByTestId("ai-chat-menu-button").click();
  await page.getByTestId("ai-chat-menu-share").filter({ visible: true }).click();
  const dialog = page.getByTestId("ai-share-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("ai-share-create").click();
  const url = dialog.getByTestId("ai-share-url").first();
  await expect(url).toHaveValue(/\/share\/ai\//u);
  shareLink = await url.inputValue();
  await review(page, "share-dialog", w);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // The AI chats list, and the sidebar section (the drawer at 390).
  await page.goto(`${BASE_URL}/chat/ai`);
  await expect(page.getByTestId("ai-chat-row").first()).toBeVisible();
  await review(page, "ai-chats-list", w);
  if (mobile) await page.getByTestId("mobile-nav-trigger").click();
  await expect(page.getByTestId("sidebar-ai-chats").filter({ visible: true }).first()).toBeVisible();
  await review(page, "sidebar-ai-chats", w);
  if (mobile) await page.keyboard.press("Escape");

  await context.close();
});

test("a usage limit: the dialog, then the calm card under the kept text", async ({ browser }, info) => {
  const project = info.project.name;
  const w = widthOf(project);
  const { context, page } = await openAs(browser, SAM, project);
  await openNewAiChat(page);
  await sendAi(page, "hello [[plan:usage_limit]]");
  await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/u);
  created.push(chatIdOf(page));
  await expect(lastAssistant(page)).toHaveAttribute("data-status", "failed", { timeout: 15_000 });
  const dialog = page.getByTestId("ai-usage-limit-dialog");
  await expect(dialog).toBeVisible();
  await review(page, "usage-limit-dialog", w);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(lastAssistant(page).getByTestId("ai-generation-error-card")).toBeVisible();
  await review(page, "usage-limit-card", w, { composer: true, column: true });
  await context.close();
});

test("the shared snapshot as a colleague reads it", async ({ browser }, info) => {
  const project = info.project.name;
  const w = widthOf(project);
  let link = shareLink;
  if (!link) {
    // The first test did not get as far as the share dialog: share a chat through the API instead.
    const res = await sam.post("/api/v1/ai-chats", {
      data: {
        clientMessageId: `cm-${randomUUID()}`,
        body: "Plan a two-day team offsite in Lisbon",
        model: PLAN,
      },
    });
    expect(res.ok()).toBe(true);
    const id = ((await res.json()) as { chat: { id: string } }).chat.id;
    created.push(id);
    await expect
      .poll(
        async () =>
          ((await (await sam.get(`/api/v1/ai-chats/${id}`)).json()) as { running: unknown }).running,
      )
      .toBeNull();
    const share = await sam.post(`/api/v1/ai-chats/${id}/shares`, { data: {} });
    expect(share.ok(), `share: ${share.status()}`).toBe(true);
    link = `${BASE_URL}${((await share.json()) as { path: string }).path}`;
  }
  const { context, page } = await openAs(browser, ALEX, project);
  await page.goto(link);
  await expect(page.getByTestId("ai-share-view")).toBeVisible();
  await expect(page.getByTestId("ai-share-message").first()).toBeVisible();
  await review(page, "share-view", w);
  await context.close();
});

test("Settings › AI chat, and Settings › Models › AI chats and Usage", async ({ browser }, info) => {
  const project = info.project.name;
  const w = widthOf(project);
  const member = await openAs(browser, SAM, project);
  await member.page.goto(`${BASE_URL}/settings/ai-chat`);
  await expect(member.page.getByTestId("chatgpt-plan-card")).toBeVisible();
  await expect(member.page.getByTestId("usage-card")).toBeVisible();
  await review(member.page, "settings-ai-chat", w);
  await member.context.close();

  const owner = await openAs(browser, ADMIN, project);
  const page = owner.page;
  await page.goto(`${BASE_URL}/settings/models`);
  const policy = page.getByTestId("ai-chat-policy-settings");
  await expect(policy).toBeVisible();
  await policy.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await review(page, "settings-models-ai-chats", w);
  const report = page.getByTestId("ai-usage-report");
  await expect(report.getByRole("heading", { name: "Usage" })).toBeVisible();
  await report
    .getByRole("heading", { name: "Usage" })
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await review(page, "settings-models-usage", w);
  await owner.context.close();
});
