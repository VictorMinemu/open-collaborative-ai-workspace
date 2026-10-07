import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { lastAssistant, openNewAiChat, seedPlan, sendAi } from "../support/ai-chat";
import { ADMIN, shot } from "./env";

/**
 * AICHAT-05/06 in the browser (05-11): the composer's tools menu (Web, Company Knowledge, MCP, Skills; only Web
 * works), web search with visible sources on the member's ChatGPT plan and through the self-hosted SearXNG on other
 * models, every disabled state explained in words, and personal and per-chat instructions. Everything runs on the
 * isolated harness: the fake ChatGPT API and the fake SearXNG.
 */

test.describe.configure({ mode: "serial" });

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

const MOCK_KEY = "mock:mock/mock-1";

let sam: APIRequestContext;

async function pick(page: Page, key: string) {
  await page.getByTestId("ai-model-chip").click();
  const picker = page.getByTestId("ai-model-picker");
  await expect(picker).toBeVisible();
  await picker.getByTestId(`ai-model-${key}`).click();
  await expect(picker).toBeHidden();
}

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

async function openTools(page: Page) {
  await page.getByTestId("ai-tools-button").click();
  const menu = page.getByTestId("ai-tools-menu");
  await expect(menu).toBeVisible();
  return menu;
}

test("the tools menu offers four toggles; Web on a ChatGPT-plan answer shows its source", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const w = widthOf(project);
  const { context, page } = await openAs(browser, SAM, project);

  await openNewAiChat(page);
  await expect(page.getByTestId("ai-model-chip")).toContainText("GPT-6 Astra");
  const menu = await openTools(page);
  await expect(menu).toHaveAttribute("data-surface", project === "mobile" ? "sheet" : "popover");
  for (const key of ["companyKnowledge", "mcp", "skills"]) {
    const row = menu.getByTestId(`ai-tool-${key}`);
    await expect(row).toHaveAttribute("data-available", "false");
    await expect(row.getByTestId("ai-tool-reason")).toHaveText("Not available yet");
    await expect(row.getByTestId(`ai-tool-${key}-switch`)).toHaveAttribute("data-disabled", "");
  }
  const web = menu.getByTestId("ai-tool-web");
  await expect(web).toHaveAttribute("data-available", "true");
  await expect(web).toContainText("Runs on your ChatGPT plan");
  await bothThemes(page, `ai-tools-menu-${w}`);

  await web.getByTestId("ai-tool-web-switch").click();
  await expect(web.getByTestId("ai-tool-web-switch")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.getByTestId("ai-tool-chip-web")).toHaveText("Web");

  await sendAi(page, "latest news [[web ocw release]]");
  await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/);
  const answer = lastAssistant(page);
  await expect(answer).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
  const chip = answer.getByTestId("ai-source-chip");
  await expect(chip).toHaveText("example.com");
  await expect(chip).toHaveAttribute("href", "https://example.com/ocw-fake/ocw-release");
  await expect(chip).toHaveAttribute("target", "_blank");
  await expect(chip).toHaveAttribute("rel", /noopener/u);
  // Web stays on for this chat (sticky): the chip is still there for the next message.
  await expect(page.getByTestId("ai-tool-chip-web")).toBeVisible();
  await bothThemes(page, `ai-chat-web-sources-${w}`);

  // After a reload the chat still has Web on and the answer keeps its source.
  await page.reload();
  await expect(lastAssistant(page).getByTestId("ai-source-chip")).toHaveText("example.com");
  await expect(page.getByTestId("ai-tool-chip-web")).toBeVisible();

  await context.close();
});

test("on other models Web searches the self-hosted SearXNG; an admin can turn it off and the menu says so", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const w = widthOf(project);
  const admin = await apiAs(ADMIN);
  const { context, page } = await openAs(browser, SAM, project);
  try {
    await openNewAiChat(page);
    await pick(page, MOCK_KEY);
    const menu = await openTools(page);
    const web = menu.getByTestId("ai-tool-web");
    await expect(web).toContainText("Self-hosted search (SearXNG)");
    await web.getByTestId("ai-tool-web-switch").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("ai-tool-chip-web")).toBeVisible();
    await sendAi(page, '[[call web_search {"query":"ocw"}]]');
    await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/);
    const answer = lastAssistant(page);
    await expect(answer).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
    await expect(answer.getByTestId("ai-message-text")).toContainText(
      "Tool web_search said: Fake result for ocw",
    );
    await expect(answer.getByTestId("ai-source-chip")).toHaveText("example.com");

    // The admin turns web search off for AI chats in Settings › Models › AI chats.
    const adminUi = await openAs(browser, ADMIN, project);
    await adminUi.page.goto(`${BASE_URL}/settings/models`);
    const section = adminUi.page.getByTestId("ai-chat-policy-settings");
    await section.scrollIntoViewIfNeeded();
    const toggle = section.getByTestId("ai-policy-webEnabled");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await section.getByTestId("ai-policy-save").click();
    await expect(adminUi.page.getByText("AI chat policy saved")).toBeVisible();
    await adminUi.context.close();

    // Sam's menu now says why Web is off; the chip is gone.
    await page.reload();
    await expect(page.getByTestId("ai-tool-chip-web")).toHaveCount(0);
    const after = await openTools(page);
    const off = after.getByTestId("ai-tool-web");
    await expect(off).toHaveAttribute("data-available", "false");
    await expect(off.getByTestId("ai-tool-reason")).toHaveText("Turned off by your admin");
    await expect(off.getByTestId("ai-tool-web-switch")).toHaveAttribute("data-disabled", "");
    await shot(page, `ai-tools-web-disabled-${w}`);
  } finally {
    const res = await admin.put("/api/v1/ai-chat/policy", { data: { webEnabled: true } });
    expect(res.ok(), "restore webEnabled").toBe(true);
    await admin.dispose();
    await context.close();
  }
});
