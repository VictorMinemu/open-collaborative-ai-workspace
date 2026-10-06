import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { lastAssistant, openNewAiChat, seedPlan, sendAi } from "../support/ai-chat";
import { ADMIN, shot } from "./env";

/**
 * AICHAT-01/02 model choice in the browser (05-04): an admin's Anthropic key (pointed at the harness fake) shows up
 * in a member's model picker as "Organization models · METERED"; the member picks Claude Sonnet 5.5 and the answer
 * streams from the fake Anthropic endpoint. No real provider is ever called.
 */

test.describe.configure({ mode: "serial" });

const FAKE_URL = process.env.OCW_E2E_FAKE_URL ?? "";
/** A fake key: the harness fake accepts anything and never forwards it. */
const FAKE_ANTHROPIC_KEY = "sk-ant-e2e-fake-key-not-real-0000";
const SONNET_KEY = "org_key:anthropic/claude-sonnet-5-5";
const HAIKU_KEY = "org_key:anthropic/claude-haiku-4-5";

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

let admin: APIRequestContext;
let sam: APIRequestContext;

/** Anthropic on the fake with Sonnet + Haiku allowed (idempotent: every test starts from here). */
async function configureAnthropic(allowedModels = ["claude-sonnet-5-5", "claude-haiku-4-5"]) {
  const res = await admin.post("/api/v1/model-providers", {
    data: {
      provider: "anthropic",
      apiKey: FAKE_ANTHROPIC_KEY,
      baseUrl: FAKE_URL,
      allowedModels,
      enabled: true,
    },
  });
  expect(res.ok(), `configure Anthropic: ${res.status()} ${await res.text()}`).toBe(true);
}

/** Opens the composer's model picker (popover on desktop, bottom sheet on a phone). */
async function openPicker(page: Page, project: string) {
  await page.getByTestId("ai-model-chip").click();
  const picker = page.getByTestId("ai-model-picker");
  await expect(picker).toBeVisible();
  await expect(picker).toHaveAttribute("data-surface", project === "mobile" ? "sheet" : "popover");
  return picker;
}

test.beforeAll(async () => {
  test.skip(!FAKE_URL, "OCW_E2E_FAKE_URL is not set (the fake model is not running)");
  admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  sam = await apiAs(SAM);
  await seedPlan(sam);
});

test.afterAll(async () => {
  await sam?.dispose();
  await admin?.dispose();
});

test("a member picks an organization model labelled METERED and the answer streams from it", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const w = widthOf(project);
  await configureAnthropic();
  const { context, page } = await openAs(browser, SAM, project);

  await openNewAiChat(page);
  await expect(page.getByTestId("ai-model-chip")).toContainText("GPT-6 Astra");
  await expect(page.getByTestId("ai-model-chip").getByTestId("ai-model-metered")).toHaveCount(0);

  const picker = await openPicker(page, project);
  await expect(picker.getByText("Your ChatGPT plan")).toBeVisible();
  await expect(picker.getByText("Organization models")).toBeVisible();
  await expect(picker.getByText("METERED · billed to your organization")).toBeVisible();
  const sonnet = picker.getByTestId(`ai-model-${SONNET_KEY}`);
  const haiku = picker.getByTestId(`ai-model-${HAIKU_KEY}`);
  await expect(sonnet).toContainText("Claude Sonnet 5.5");
  await expect(haiku).toContainText("Claude Haiku 4.5");
  await expect(sonnet.getByTestId("ai-model-metered")).toBeVisible();
  await expect(haiku.getByTestId("ai-model-metered")).toBeVisible();
  await expect(
    picker.getByTestId("ai-model-chatgpt_plan:openai/gpt-6-astra").getByTestId("ai-model-metered"),
  ).toHaveCount(0);
  await bothThemes(page, `ai-model-picker-${w}`);

  await sonnet.click();
  await expect(picker).toBeHidden();
  const chip = page.getByTestId("ai-model-chip");
  await expect(chip).toContainText("Claude Sonnet 5.5");
  await expect(chip.getByTestId("ai-model-metered")).toBeVisible();
  // The plan usage line is for plan models only.
  await expect(page.getByTestId("plan-usage-line")).toHaveCount(0);

  await sendAi(page, "Summarise our offsite plan");
  await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/);
  const answer = lastAssistant(page);
  await expect(answer).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
  await expect(answer.getByTestId("ai-message-text")).not.toBeEmpty();
  await expect(answer.getByTestId("ai-message-footer")).toContainText(/^Claude Sonnet 5\.5 · METERED · /);
  await expect(page.getByTestId("ai-model-chip")).toContainText("Claude Sonnet 5.5");
  await expect(page.getByText(FAKE_ANTHROPIC_KEY)).toHaveCount(0);
  await bothThemes(page, `ai-chat-metered-${w}`);

  await context.close();
});

test("a member who opens the picker for the AI chat route of a new chat keeps the selection after a send", async ({
  browser,
}, info) => {
  // Guard for the per-chat store: picking on /chat/ai/new carries over to the created chat.
  const project = info.project.name;
  await configureAnthropic();
  const { context, page } = await openAs(browser, SAM, project);
  await page.goto(`${BASE_URL}/chat/ai/new`);
  await expect(page.getByTestId("ai-model-chip")).toContainText("GPT-6 Astra");
  const picker = await openPicker(page, project);
  await picker.getByTestId(`ai-model-${SONNET_KEY}`).click();
  await sendAi(page, "First question");
  await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/);
  await expect(lastAssistant(page)).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
  await expect(page.getByTestId("ai-model-chip")).toContainText("Claude Sonnet 5.5");
  await context.close();
});
