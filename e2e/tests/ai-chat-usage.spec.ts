import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { lastAssistant, openNewAiChat, seedPlan, sendAi, waitForLonger } from "../support/ai-chat";
import { ADMIN, shot } from "./env";

/**
 * Metering in the browser (05-08, AICHAT-07, D-06, P-11): every answer shows its tokens and, on organization keys,
 * its cost ("1.2k in · 340 out · ~$0.004 · Claude Sonnet 5.5 · METERED"); a plan answer ends with "ChatGPT plan" and
 * no cost; a stopped answer is marked estimated ("~"). An admin's daily cap (Settings › Models › AI chats) stops the
 * member's next organization-key answer with the local reset time and offers their own ChatGPT plan. Everything
 * runs against the harness fake.
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
  // The cap test restores the default in its `finally`, but when it times out its request context is already closed
  // and the 1-a-day cap stayed on, failing later specs that use the org model (Work Zone memory summaries, CI p262).
  // Restore it again here with a fresh context.
  if (!FAKE_URL) return;
  const restore = await apiAs(ADMIN);
  try {
    const res = await restore.put("/api/v1/ai-chat/policy", { data: { orgKeyDailyGenerations: 200 } });
    expect(res.ok(), `restore the daily cap: ${res.status()}`).toBe(true);
  } finally {
    await restore.dispose();
  }
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

test("an admin caps organization models at 1 a day: the member sees when it resets and the plan still answers", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const w = widthOf(project);
  // A member with no usage today in this project (the cap counts per member and UTC day).
  const member = {
    name: "Morgan Reyes",
    email: `morgan-${project}@ocw.test`,
    password: "morgan-e2e-password-123",
  };
  await ensureMember(admin, member, "developer");
  const memberApi = await apiAs(member);
  await seedPlan(memberApi);
  await memberApi.dispose();

  try {
    // The admin sets the cap in Settings › Models › AI chats.
    const adminUi = await openAs(browser, ADMIN, project);
    await adminUi.page.goto(`${BASE_URL}/settings/models`);
    const section = adminUi.page.getByTestId("ai-chat-policy-settings");
    await section.scrollIntoViewIfNeeded();
    const cap = section.getByTestId("ai-policy-orgKeyDailyGenerations");
    await expect(cap).toHaveValue("200");
    await expect(section.getByTestId("provider-metered").first()).toBeVisible();
    await cap.fill("0");
    await section.getByTestId("ai-policy-save").click();
    await expect(section.getByText(/Enter a whole number from 1 to 100,000/u)).toBeVisible();
    await cap.fill("1");
    await section.getByTestId("ai-policy-save").click();
    await expect(adminUi.page.getByText("AI chat policy saved")).toBeVisible();
    await expect(section.getByTestId("ai-policy-save")).toBeDisabled();
    await expect(adminUi.page.getByText("AI chat policy saved")).toBeHidden({ timeout: 10_000 });
    await section
      .getByRole("heading", { name: "AI chats" })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    await bothThemes(adminUi.page, `settings-ai-chat-policy-${w}`);
    await section.getByTestId("ai-policy-titleModels").evaluate((el) => el.scrollIntoView({ block: "end" }));
    await expect(section.getByTestId("ai-policy-title-anthropic")).toBeVisible();
    await shot(adminUi.page, `settings-ai-chat-policy-models-${w}`);
    await adminUi.context.close();
    const saved = await (await admin.get("/api/v1/ai-chat/policy")).json();
    expect(saved.orgKeyDailyGenerations).toBe(1);

    // The member's first org-key answer goes through; the second is refused before any model call.
    const { context, page } = await openAs(browser, member, project);
    await openNewAiChat(page);
    await pick(page, SONNET_KEY);
    // Close to the cap, the composer says how many are left.
    await expect(page.getByTestId("ai-org-answers-left")).toHaveText(
      "1 of 1 answer left today on organization models",
    );
    await sendAi(page, "First on the org key");
    await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/);
    const answers = page.locator('[data-testid="ai-message"][data-role="assistant"]');
    await expect(answers.nth(0)).toHaveAttribute("data-status", "completed", { timeout: 15_000 });

    const composer = page.getByTestId("ai-composer");
    await composer.fill("Second on the org key");
    await composer.press("Enter");
    const notice = page.getByTestId("ai-limit-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText(
      /^You've used today's 1 answer on organization models\. Resets at \d{1,2}:\d{2}\s?(AM|PM)( tomorrow)?\.Use your ChatGPT plan$/u,
    );
    // Nothing was sent: the text is kept, no second answer, no error toast.
    await expect(composer).toHaveValue("Second on the org key");
    await expect(answers).toHaveCount(1);
    await expect(page.getByText("Couldn't send your message")).toHaveCount(0);
    await bothThemes(page, `ai-chat-limit-notice-${w}`);

    // The member's own plan is offered and still answers.
    await notice.getByTestId("ai-limit-use-plan").click();
    await expect(page.getByTestId("ai-model-chip")).toContainText("GPT-6 Astra");
    await expect(notice).toHaveCount(0);
    await composer.press("Enter");
    await expect(answers).toHaveCount(2);
    await expect(answers.nth(1)).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
    await expect(answers.nth(1).getByTestId("ai-message-footer")).toHaveText(
      / · GPT-6 Astra · ChatGPT plan$/u,
    );

    // Back on the org model, the notice is there before sending.
    await pick(page, SONNET_KEY);
    await expect(page.getByTestId("ai-limit-notice")).toBeVisible();
    await context.close();
  } finally {
    // Every later spec runs with the default cap.
    const res = await admin.put("/api/v1/ai-chat/policy", { data: { orgKeyDailyGenerations: 200 } });
    expect(res.ok()).toBe(true);
  }
});
