import { type APIRequestContext, expect, type Locator, type Page } from "@playwright/test";
import { BASE_URL } from "./actors";

/**
 * Helpers shared by the Phase 5 AI chat specs (05-03 onwards). Later plans import these and keep anything else
 * local to their spec. Everything runs on the isolated harness: the API talks to the fake ChatGPT plan only.
 */

/** Connects the signed-in member's own ChatGPT plan with fake tokens (test-only route, P-12). */
export async function seedPlan(api: APIRequestContext): Promise<void> {
  const res = await api.post("/api/v1/test/ai/chatgpt-plan", { data: {} });
  expect(res.ok(), `seed ChatGPT plan: ${res.status()}`).toBe(true);
  expect(((await res.json()) as { state: string }).state).toBe("connected");
}

/** Opens `/chat/ai`, clicks New chat and waits for the empty AI chat with its composer and model. */
export async function openNewAiChat(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/chat/ai`);
  await page.getByTestId("ai-new-chat").click();
  await expect(page).toHaveURL(/\/chat\/ai\/new$/);
  await expect(page.getByTestId("ai-composer")).toBeVisible();
  await expect(page.getByTestId("ai-model-chip")).toBeVisible();
}

/** Types `text` into the AI composer and sends it with Enter. */
export async function sendAi(page: Page, text: string): Promise<void> {
  const composer = page.getByTestId("ai-composer");
  await composer.fill(text);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
}

/** The latest assistant turn of the open AI chat. */
export function lastAssistant(page: Page): Locator {
  return page.locator('[data-testid="ai-message"][data-role="assistant"]').last();
}

/** The rendered answer text of an assistant turn (the Markdown body, without the footer). */
export async function answerText(turn: Locator): Promise<string> {
  return ((await turn.getByTestId("ai-message-text").textContent()) ?? "").trim();
}

/** The id in `/chat/ai/<id>`. */
export function chatIdOf(page: Page): string {
  const m = /\/chat\/ai\/([0-9a-f-]{36})/u.exec(page.url());
  expect(m, `AI chat URL: ${page.url()}`).toBeTruthy();
  return (m as RegExpExecArray)[1] as string;
}

/** The persisted body of the latest assistant message, straight from the API snapshot. */
export async function persistedAnswer(api: APIRequestContext, chatId: string): Promise<string> {
  const res = await api.get(`/api/v1/ai-chats/${chatId}`);
  expect(res.ok(), `GET /ai-chats/${chatId}: ${res.status()}`).toBe(true);
  const snap = (await res.json()) as { messages: Array<{ authorKind: string; body: string }> };
  const last = snap.messages.filter((m) => m.authorKind === "agent").at(-1);
  expect(last, "an assistant message").toBeTruthy();
  return (last as { body: string }).body.trim();
}

/** Waits until the visible answer is longer than `than` characters and returns it. */
export async function waitForLonger(turn: Locator, than: number, timeout = 10_000): Promise<string> {
  let text = "";
  await expect
    .poll(
      async () => {
        text = await answerText(turn);
        return text.length;
      },
      { timeout, intervals: [50] },
    )
    .toBeGreaterThan(than);
  return text;
}
