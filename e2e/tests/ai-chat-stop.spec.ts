import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, ensureMember, openAs, SAM } from "../support/actors";
import { answerText, lastAssistant, openNewAiChat, seedPlan, sendAi, waitForLonger } from "../support/ai-chat";
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
