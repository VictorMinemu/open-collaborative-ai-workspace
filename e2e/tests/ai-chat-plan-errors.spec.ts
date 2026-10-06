import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, ensureMember, openAs, SAM } from "../support/actors";
import { answerText, lastAssistant, openNewAiChat, seedPlan, sendAi } from "../support/ai-chat";
import { ADMIN, shot } from "./env";

/**
 * D-02 in the browser (05-07): every ChatGPT-plan failure reads clearly and leads to the right action. A usage limit
 * mid-answer keeps the partial text, opens a dialog that leads with "Manage usage" and only switches the composer to
 * an organization model (METERED) when the member chooses it; nothing is resent. Only the harness's fake plan,
 * SIWC and Anthropic endpoints are involved.
 */

test.describe.configure({ mode: "serial" });

const FAKE_URL = process.env.OCW_E2E_FAKE_URL ?? "";
/** A fake key: the harness fake accepts anything and never forwards it. */
const FAKE_ANTHROPIC_KEY = "sk-ant-e2e-fake-key-not-real-0000";
const MANAGE_USAGE = "https://chatgpt.com/settings/usage";

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

test.beforeAll(async () => {
  test.skip(!FAKE_URL, "OCW_E2E_FAKE_URL is not set (the fake model is not running)");
  admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  sam = await apiAs(SAM);
  await configureAnthropic();
});

test.afterAll(async () => {
  await sam?.dispose();
  await admin?.dispose();
});

test("a usage limit mid-answer keeps the text, leads with Manage usage and switches only on an explicit choice", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const w = widthOf(project);
  await seedPlan(sam);
  const { context, page } = await openAs(browser, SAM, project);

  await openNewAiChat(page);
  await expect(page.getByTestId("ai-model-chip")).toContainText("GPT-6 Astra");
  await sendAi(page, "hello [[plan:usage_limit]]");
  await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/);
  const answer = lastAssistant(page);
  await expect(answer).toHaveAttribute("data-status", "failed", { timeout: 15_000 });
  // The text received before the limit stays.
  expect(await answerText(answer)).toBe("Echo: hello");

  const dialog = page.getByTestId("ai-usage-limit-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("You've reached your ChatGPT usage limit");
  const manage = dialog.getByTestId("ai-usage-limit-manage");
  await expect(manage).toHaveText(/Manage usage/u);
  await expect(manage).toHaveAttribute("href", MANAGE_USAGE);
  await expect(manage).toHaveAttribute("target", "_blank");
  await expect(manage).toHaveAttribute("data-primary", "true");
  const useOrg = dialog.getByTestId("ai-usage-limit-use-org");
  await expect(useOrg).toHaveText("Use an organization model");
  await expect(useOrg).not.toHaveAttribute("data-primary", "true");
  // Nothing says the organization pays for the member's plan.
  await expect(dialog).not.toContainText(/organization (pays|is billed) for (your )?ChatGPT/iu);
  await bothThemes(page, `ai-plan-usage-limit-${w}`);

  // The quiet card under the answer repeats both actions.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const card = answer.getByTestId("ai-generation-error-card");
  await expect(card).toHaveAttribute("data-code", "usage_limit_exceeded");
  await expect(card.getByTestId("ai-generation-error")).toHaveText("You've reached your ChatGPT usage limit");
  await expect(card.getByTestId("ai-error-manage-usage")).toHaveAttribute("href", MANAGE_USAGE);
  await expect(card.getByTestId("ai-error-use-org")).toHaveText("Use an organization model");
  // Still on the plan: nothing switched by itself.
  await expect(page.getByTestId("ai-model-chip")).toContainText("GPT-6 Astra");
  await expect(page.getByTestId("ai-model-chip").getByTestId("ai-model-metered")).toHaveCount(0);

  // The dialog opens once, when the failure arrives; a reload shows the card only.
  await page.reload();
  await expect(lastAssistant(page)).toHaveAttribute("data-status", "failed");
  await expect(lastAssistant(page).getByTestId("ai-generation-error-card")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("ai-usage-limit-dialog")).toHaveCount(0);

  // The member chooses the organization model from the card: the composer switches, METERED, nothing is resent.
  const turns = await page.getByTestId("ai-message").count();
  await lastAssistant(page).getByTestId("ai-error-use-org").click();
  const chip = page.getByTestId("ai-model-chip");
  await expect(chip).toContainText("Claude Sonnet 5.5");
  await expect(chip.getByTestId("ai-model-metered")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("ai-message")).toHaveCount(turns);
  await context.close();
});

test("choosing Use an organization model in the dialog closes it and switches the composer only", async ({
  browser,
}, info) => {
  const project = info.project.name;
  await seedPlan(sam);
  const { context, page } = await openAs(browser, SAM, project);
  await openNewAiChat(page);
  await sendAi(page, "again [[plan:usage_limit]]");
  await expect(lastAssistant(page)).toHaveAttribute("data-status", "failed", { timeout: 15_000 });
  const dialog = page.getByTestId("ai-usage-limit-dialog");
  await expect(dialog).toBeVisible();
  const turns = await page.getByTestId("ai-message").count();
  await dialog.getByTestId("ai-usage-limit-use-org").click();
  await expect(dialog).toBeHidden();
  const chip = page.getByTestId("ai-model-chip");
  await expect(chip).toContainText("Claude Sonnet 5.5");
  await expect(chip.getByTestId("ai-model-metered")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("ai-message")).toHaveCount(turns);

  // The next message the member sends goes to the organization model they chose.
  await sendAi(page, "Carry on");
  const next = lastAssistant(page);
  await expect(next).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
  await expect(next.getByTestId("ai-message-footer")).toContainText(/^Claude Sonnet 5\.5 · METERED · /u);
  await context.close();
});
