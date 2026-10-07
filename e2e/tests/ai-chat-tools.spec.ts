import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, ensureMember, openAs, SAM } from "../support/actors";
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
