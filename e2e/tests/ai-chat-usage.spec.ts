import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, ensureMember, openAs, SAM } from "../support/actors";
import { lastAssistant, openNewAiChat, seedPlan, sendAi, waitForLonger } from "../support/ai-chat";
import { ADMIN, shot } from "./env";

/**
 * Metering in the browser (05-08, AICHAT-07, D-06, P-11): every answer shows its tokens and, on organization keys,
 * its cost ("1.2k in · 340 out · ~$0.004 · Claude Sonnet 5.5 · METERED"); a plan answer ends with "ChatGPT plan" and
 * no cost; a stopped answer is marked estimated ("~"). Everything runs against the harness fake.
 */

test.describe.configure({ mode: "serial" });

const FAKE_URL = process.env.OCW_E2E_FAKE_URL ?? "";
const FAKE_ANTHROPIC_KEY = "sk-ant-e2e-fake-key-not-real-0000";
const SONNET_KEY = "org_key:anthropic/claude-sonnet-5-5";
const PLAN_KEY = "chatgpt_plan:openai/gpt-6-astra";
const USAGE = /^~?\d[\d.,k]* in · ~?\d[\d.,k]* out · ~?\$\d/u;

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

let admin: APIRequestContext;
let sam: APIRequestContext;

async function configureAnthropic() {
  const res = await admin.post("/api/v1/model-providers", {
    data: {
      provider: "anthropic",
      apiKey: FAKE_ANTHROPIC_KEY,
      baseUrl: FAKE_URL,
      allowedModels: ["claude-sonnet-5-5", "claude-haiku-4-5"],
      enabled: true,
    },
  });
  expect(res.ok(), `configure Anthropic: ${res.status()} ${await res.text()}`).toBe(true);
}

/** Picks a model in the composer's picker (popover on desktop, bottom sheet on a phone). */
async function pick(page: Page, key: string) {
  await page.getByTestId("ai-model-chip").click();
  const picker = page.getByTestId("ai-model-picker");
  await expect(picker).toBeVisible();
  await picker.getByTestId(`ai-model-${key}`).click();
  await expect(picker).toBeHidden();
}

test.beforeAll(async () => {
  test.skip(!FAKE_URL, "OCW_E2E_FAKE_URL is not set (the fake model is not running)");
  admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  sam = await apiAs(SAM);
  await seedPlan(sam);
  await configureAnthropic();
});

test.afterAll(async () => {
  await sam?.dispose();
  await admin?.dispose();
});

test("every answer shows its tokens and cost: METERED with ~$ on the org key, ChatGPT plan without cost", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const w = widthOf(project);
  const { context, page } = await openAs(browser, SAM, project);

  await openNewAiChat(page);
  await pick(page, SONNET_KEY);
  await sendAi(page, "Summarise the offsite plan");
  await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/);
  const answers = page.locator('[data-testid="ai-message"][data-role="assistant"]');
  const claude = answers.nth(0);
  await expect(claude).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
  const claudeFooter = claude.getByTestId("ai-message-footer");
  await expect(claudeFooter).toHaveText(USAGE);
  await expect(claudeFooter).toHaveText(/ · Claude Sonnet 5\.5 · METERED$/u);
  await expect(claudeFooter).not.toContainText("~");
  await expect(claudeFooter).toHaveAttribute(
    "title",
    /^[\d,]+ input tokens · [\d,]+ output tokens · estimated \$/u,
  );

  // The member's own plan: tokens, no cost.
  await pick(page, PLAN_KEY);
  await sendAi(page, "And on my plan?");
  const plan = answers.nth(1);
  await expect(plan).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
  const planFooter = plan.getByTestId("ai-message-footer");
  await expect(planFooter).toHaveText(/^\d[\d.,k]* in · \d[\d.,k]* out · GPT-6 Astra · ChatGPT plan$/u);
  await expect(planFooter).not.toContainText("$");

  // A stopped answer on the org key: estimated counts and cost carry "~".
  await pick(page, SONNET_KEY);
  await sendAi(page, "count to forty [[slow]]");
  const stopped = answers.nth(2);
  await waitForLonger(stopped, 0);
  await page.getByTestId("ai-stop").click();
  await expect(stopped).toHaveAttribute("data-status", "completed", { timeout: 5_000 });
  await expect(stopped.getByTestId("ai-generation-state")).toHaveText("Stopped");
  const stoppedFooter = stopped.getByTestId("ai-message-footer");
  await expect(stoppedFooter).toHaveText(/^~\d[\d.,k]* in · ~\d[\d.,k]* out · ~\$\d/u);
  await expect(stoppedFooter).toHaveAttribute("title", /estimated counts$/u);
  await bothThemes(page, `ai-chat-usage-footer-${w}`);

  // Persisted: the same footers after a reload.
  const before = await Promise.all([claudeFooter, planFooter, stoppedFooter].map((f) => f.textContent()));
  await page.reload();
  await expect(answers).toHaveCount(3);
  for (const [i, text] of before.entries()) {
    await expect(answers.nth(i).getByTestId("ai-message-footer")).toHaveText(text ?? "");
  }
  await expect(lastAssistant(page)).toHaveAttribute("data-status", "completed");

  await context.close();
});
