import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import {
  answerText,
  lastAssistant,
  openNewAiChat,
  seedPlan,
  sendAi,
  waitForLonger,
} from "../support/ai-chat";
import { apiAs, ensureMember, openAs, SAM } from "../support/actors";
import { ADMIN, shot } from "./env";

/**
 * AICHAT-02/03/07 in the browser (05-03): a member's own ChatGPT plan answers in a private AI chat. The answer
 * streams into the page over the realtime WebSocket (offset deltas), ends with the model, "ChatGPT plan" and the
 * token counts, and is still there after a reload. Everything runs against the fake ChatGPT API of the harness.
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

test("a ChatGPT-plan answer streams into the page and is still there after a reload", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const w = widthOf(project);
  const { context, page } = await openAs(browser, SAM, project);

  await openNewAiChat(page);
  await expect(page.getByTestId("ai-model-chip")).toContainText("GPT-6 Astra");
  const usage = page.getByTestId("plan-usage-line");
  await expect(usage).toContainText("Using ChatGPT plan");
  const manage = usage.getByRole("link", { name: "Manage usage" });
  await expect(manage).toHaveAttribute("href", "https://chatgpt.com/settings/usage");
  await expect(manage).toHaveAttribute("target", "_blank");

  await sendAi(page, "Write two short lines [[slow]]");
  await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/);
  await expect(page.locator('[data-testid="ai-message"][data-role="user"]').last()).toContainText(
    "Write two short lines",
  );

  // The answer grows while it streams: at least two increases before it is done.
  const answer = lastAssistant(page);
  const first = await waitForLonger(answer, 0);
  const second = await waitForLonger(answer, first.length);
  await waitForLonger(answer, second.length);
  await expect(answer).toHaveAttribute("data-status", "streaming");
  await expect(answer.getByTestId("ai-streaming-caret")).toBeVisible();
  await bothThemes(page, `ai-chat-streaming-${w}`);

  await expect(answer).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
  await expect(answer.getByTestId("ai-streaming-caret")).toHaveCount(0);
  const footer = answer.getByTestId("ai-message-footer");
  await expect(footer).toHaveText(/GPT-6 Astra · ChatGPT plan · [\d,]+ in · [\d,]+ out/);
  const finalText = await answerText(answer);
  expect(finalText).toMatch(/^Echo: Write two short lines 1 2 3 .* 40$/);
  const footerText = (await footer.textContent()) ?? "";
  await bothThemes(page, `ai-chat-done-${w}`);

  await page.reload();
  const reloaded = lastAssistant(page);
  await expect(reloaded).toHaveAttribute("data-status", "completed");
  expect(await answerText(reloaded)).toBe(finalText);
  await expect(reloaded.getByTestId("ai-message-footer")).toHaveText(footerText);
  await expect(page.getByTestId("plan-usage-line")).toBeVisible();

  await context.close();
});
