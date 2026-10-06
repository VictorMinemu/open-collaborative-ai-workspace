import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
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

  await page.goto(`${BASE_URL}/chat/ai`);
  await expect(page.getByTestId("ai-new-chat")).toBeVisible();
  await bothThemes(page, `ai-chats-${w}`);
  await openNewAiChat(page);
  await expect(page.getByTestId("ai-model-chip")).toContainText("GPT-6 Astra");
  await bothThemes(page, `ai-chat-new-${w}`);
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

test("a reload or a dropped connection mid-answer resumes the exact text", async ({ browser }, info) => {
  const project = info.project.name;
  const { context, page } = await openAs(browser, SAM, project);

  // Reload mid-stream: the partial text is there at once and the stream continues to the persisted text.
  await openNewAiChat(page);
  await sendAi(page, "count to forty [[slow]]");
  await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/);
  const chatId = chatIdOf(page);
  await waitForLonger(lastAssistant(page), "Echo: count to forty 1 2".length);
  await page.reload();
  const resumed = lastAssistant(page);
  await expect(resumed).toHaveAttribute("data-status", "streaming");
  const partial = await waitForLonger(resumed, 0, 3_000);
  await expect(resumed).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
  const afterReload = await answerText(resumed);
  expect(afterReload.startsWith(partial), `"${afterReload}" continues "${partial}"`).toBe(true);
  expect(afterReload).toBe(await persistedAnswer(sam, chatId));
  expect(afterReload).toMatch(/^Echo: count to forty 1 2 3 .* 39 40$/);

  // Offline for 2 s mid-stream: back online, the answer ends with exactly the persisted text.
  await sendAi(page, "count again [[slow]]");
  const second = lastAssistant(page);
  await expect(second).not.toHaveAttribute(
    "data-message-id",
    (await resumed.getAttribute("data-message-id")) ?? "",
  );
  await waitForLonger(second, "Echo: count again 1".length);
  await context.setOffline(true);
  await page.waitForTimeout(2_000);
  await context.setOffline(false);
  await expect(second).toHaveAttribute("data-status", "completed", { timeout: 30_000 });
  const afterOffline = await answerText(second);
  expect(afterOffline).toBe(await persistedAnswer(sam, chatId));
  expect(afterOffline).toMatch(/^Echo: count again 1 2 3 .* 39 40$/);

  await context.close();
});

test("a failed answer ends with a calm card instead of spinning", async ({ browser }, info) => {
  const project = info.project.name;
  const w = widthOf(project);
  const { context, page } = await openAs(browser, SAM, project);

  await openNewAiChat(page);
  await sendAi(page, "hello [[plan:unavailable]]");
  await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/);
  const answer = lastAssistant(page);
  await expect(answer).toHaveAttribute("data-status", "failed", { timeout: 15_000 });
  const card = answer.getByTestId("ai-generation-error");
  await expect(card).toHaveText("This answer failed — ChatGPT is temporarily unavailable");
  await expect(page.getByTestId("ai-streaming-caret")).toHaveCount(0);
  await expect(answer.getByTestId("ai-message-footer")).toContainText("GPT-6 Astra · ChatGPT plan");
  // The composer is ready for the next message.
  await expect(page.getByTestId("ai-composer")).toBeEnabled();
  await bothThemes(page, `ai-chat-failed-${w}`);

  await page.reload();
  await expect(lastAssistant(page).getByTestId("ai-generation-error")).toBeVisible();

  await context.close();
});
