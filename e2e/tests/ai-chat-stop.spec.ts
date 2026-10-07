import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, ensureMember, openAs, SAM } from "../support/actors";
import {
  answerText,
  chatIdOf,
  lastAssistant,
  openNewAiChat,
  persistedAnswer,
  seedPlan,
  sendAi,
  waitForLonger,
} from "../support/ai-chat";
import { ADMIN, shot } from "./env";

/**
 * The generation lifecycle in the browser (05-06, AICHAT-03, D-05): while an answer streams, Send becomes Stop;
 * pressing it keeps the text received so far, marked Stopped, and Send returns. Everything runs against the
 * harness fake (`[[slow]]` = 40 deltas 100 ms apart).
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

test("Stop keeps the text received so far, marked Stopped, and Send returns", async ({ browser }, info) => {
  const project = info.project.name;
  const w = widthOf(project);
  const { context, page } = await openAs(browser, SAM, project);

  await openNewAiChat(page);
  await sendAi(page, "count to forty [[slow]]");
  await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/);
  const answer = lastAssistant(page);
  await waitForLonger(answer, 0);

  // One generation per chat: Stop replaces Send; the textarea still takes text but cannot send it.
  const stopButton = page.getByTestId("ai-stop");
  await expect(stopButton).toBeVisible();
  await expect(page.getByTestId("ai-send")).toHaveCount(0);
  const composer = page.getByTestId("ai-composer");
  await composer.fill("a follow-up typed while it writes");
  await composer.press("Enter");
  await expect(composer).toHaveValue("a follow-up typed while it writes");
  await expect(answer).toHaveAttribute("data-status", "streaming");
  await bothThemes(page, `ai-chat-stop-button-${w}`);

  await waitForLonger(answer, "Echo: count to forty 1 2 3".length);
  await stopButton.click();
  await expect(answer).toHaveAttribute("data-status", "completed", { timeout: 3_000 });
  await expect(answer.getByTestId("ai-generation-state")).toHaveText("Stopped");
  await expect(answer.getByTestId("ai-streaming-caret")).toHaveCount(0);
  const kept = await answerText(answer);
  expect(kept).toMatch(/^Echo: count to forty 1 2 3/);
  expect(kept).not.toMatch(/ 40$/);

  // Send is back (enabled with the text kept in the composer) and Stop is gone.
  await expect(page.getByTestId("ai-stop")).toHaveCount(0);
  await expect(page.getByTestId("ai-send")).toBeEnabled();
  await composer.fill("");
  await bothThemes(page, `ai-chat-stopped-${w}`);

  // The stopped text is what the API kept.
  await page.reload();
  const reloaded = lastAssistant(page);
  await expect(reloaded.getByTestId("ai-generation-state")).toHaveText("Stopped");
  expect(await answerText(reloaded)).toBe(kept);

  await context.close();
});

test("a reload mid-answer shows the partial text at once and streams on to the persisted text", async ({
  browser,
}, info) => {
  const { context, page } = await openAs(browser, SAM, info.project.name);

  await openNewAiChat(page);
  await sendAi(page, "count after a reload [[slow]]");
  await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/);
  const chatId = chatIdOf(page);
  const before = await waitForLonger(lastAssistant(page), "Echo: count after a reload 1 2 3".length);

  await page.reload();
  const resumed = lastAssistant(page);
  // The partial answer is on screen right away (from the snapshot), Stop is offered, and it keeps growing.
  await expect(resumed).toHaveAttribute("data-status", "streaming");
  await expect
    .poll(async () => (await answerText(resumed)).length, { timeout: 2_000, intervals: [50] })
    .toBeGreaterThanOrEqual(before.length);
  await expect(page.getByTestId("ai-stop")).toBeVisible();
  const partial = await answerText(resumed);
  expect(partial.startsWith(before.slice(0, Math.min(before.length, partial.length)))).toBe(true);
  await waitForLonger(resumed, partial.length);

  await expect(resumed).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
  const final = await answerText(resumed);
  expect(final.startsWith(partial), `"${final}" continues "${partial}"`).toBe(true);
  expect(final).toBe(await persistedAnswer(sam, chatId));
  expect(final).toMatch(/^Echo: count after a reload 1 2 3 .* 39 40$/);
  await expect(page.getByTestId("ai-send")).toBeVisible();

  await context.close();
});

/** Opens the answer's Regenerate menu (popover on desktop, bottom sheet on a phone). */
async function openRegenerate(page: Page, project: string) {
  await lastAssistant(page).getByTestId("ai-regenerate").click();
  const menu = page.getByTestId("ai-regenerate-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute("data-surface", project === "mobile" ? "sheet" : "popover");
  return menu;
}

test("the last answer regenerates on the same model, then with another model", async ({ browser }, info) => {
  const project = info.project.name;
  const w = widthOf(project);
  const { context, page } = await openAs(browser, SAM, project);

  await openNewAiChat(page);
  await sendAi(page, "first question");
  await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/);
  await expect(lastAssistant(page)).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
  // A slow answer (about four seconds), so each regenerate is seen streaming before it completes.
  await sendAi(page, "second question [[slow]]");
  const answers = page.locator('[data-testid="ai-message"][data-role="assistant"]');
  await expect(answers).toHaveCount(2);
  const answer = answers.last();
  await expect(answer).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
  const messageId = await answer.getAttribute("data-message-id");
  // Only the last answer offers Regenerate.
  await expect(answers.first().getByTestId("ai-regenerate")).toHaveCount(0);
  await expect(answer.getByTestId("ai-copy-answer")).toBeVisible();

  // Regenerate (same model): the same message streams again and keeps its model.
  let menu = await openRegenerate(page, project);
  await expect(menu.getByTestId("ai-regenerate-same")).toContainText("GPT-6 Astra");
  await bothThemes(page, `ai-chat-regenerate-menu-${w}`);
  await menu.getByTestId("ai-regenerate-same").click();
  await expect(menu).toBeHidden();
  await expect(answer).toHaveAttribute("data-message-id", messageId ?? "");
  await expect(answer).toHaveAttribute("data-status", "streaming");
  await expect(answer).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
  await expect(answer.getByTestId("ai-message-footer")).toHaveText(/ · GPT-6 Astra · ChatGPT plan$/);
  expect(await answerText(answer)).toMatch(/^Echo: second question/);

  // Regenerate with… the mock: the footer follows the new model.
  menu = await openRegenerate(page, project);
  await menu.getByTestId("ai-regenerate-with").click();
  const mock = menu.getByTestId("ai-model-mock:mock/mock-1");
  await expect(mock).toBeVisible();
  await expect(menu.getByTestId("ai-model-group-chatgpt_plan")).toBeVisible();
  await bothThemes(page, `ai-chat-regenerate-with-${w}`);
  await mock.click();
  await expect(menu).toBeHidden();
  await expect(answer).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
  await expect(answer.getByTestId("ai-message-footer")).toHaveText(/ · Mock \(E2E\) · not metered$/);
  await expect(answers).toHaveCount(2);
  await expect(answers.first().getByTestId("ai-regenerate")).toHaveCount(0);

  // Persisted: a reload shows the regenerated answer on the mock.
  await page.reload();
  await expect(lastAssistant(page).getByTestId("ai-message-footer")).toHaveText(
    / · Mock \(E2E\) · not metered$/,
  );

  await context.close();
});
