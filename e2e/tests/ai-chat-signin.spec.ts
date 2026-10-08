import { type APIRequestContext, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { answerText, lastAssistant, openNewAiChat, sendAi } from "../support/ai-chat";
import { ADMIN, shot } from "./env";

/**
 * AICHAT-02 / D-02 in the browser (05-05): Sam connects his OWN ChatGPT plan from Settings › AI chat. "Continue with
 * ChatGPT" opens the (fake) OpenAI authorize page in a new tab, which sends the browser to an http://127.0.0.1:1455
 * address; the context routes that address (nothing listens there, exactly like a real browser) so the test can
 * read it, then Sam pastes it into the dialog. The API exchanges the code and keeps the tokens; the card shows the
 * account and plan, and a New chat answers on GPT-6 Astra. Then Sam disconnects. Only the harness's fake SIWC and
 * Responses API are involved.
 */

test.describe.configure({ mode: "serial" });

const STATUS = "/api/v1/me/model-credentials/chatgpt";
const LOOPBACK = "http://127.0.0.1:1455/**";
const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/**
 * Records the http://127.0.0.1:1455 address the browser lands on after authorize, answering it like an unreachable
 * page (nothing listens there, exactly as for a member). Playwright does not intercept the target of an HTTP redirect,
 * so the fake authorize page's 302 is turned into a client-side `location.replace` (what a real login page does once
 * the member approves); the loopback navigation is then routed here.
 */
async function captureLoopback(context: BrowserContext): Promise<() => string> {
  let landed = "";
  await context.route(/\/siwc\/api\/accounts\/authorize\?/u, async (route) => {
    const res = await route.fetch({ maxRedirects: 0 });
    const location = res.headers().location;
    if (res.status() !== 302 || !location) return route.fulfill({ response: res });
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><title>ChatGPT</title><script>location.replace(${JSON.stringify(location)})</script>`,
    });
  });
  await context.route(LOOPBACK, (route) => {
    landed = route.request().url();
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>127.0.0.1</title><p>This site can't be reached</p>",
    });
  });
  return () => landed;
}

/** A new connection shows the one-time welcome (05-07); these tests dismiss it and move on. */
async function dismissWelcome(page: Page) {
  const welcome = page.getByTestId("chatgpt-welcome");
  await expect(welcome).toBeVisible();
  await welcome.getByTestId("chatgpt-welcome-done").click();
  await expect(welcome).toBeHidden();
}

let sam: APIRequestContext;

test.beforeAll(async () => {
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  await admin.dispose();
  sam = await apiAs(SAM);
  // Other specs seed Sam's plan; this one starts from "not connected" in every project.
  const res = await sam.delete(STATUS);
  expect(res.ok(), `disconnect: ${res.status()}`).toBe(true);
});

test.afterAll(async () => {
  await sam?.dispose();
});

test("Sam connects his own ChatGPT plan by pasting the loopback address and his next AI chat answers on it", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const w = widthOf(project);
  const { context, page } = await openAs(browser, SAM, project);
  const landed = await captureLoopback(context);

  await page.goto(`${BASE_URL}/settings/ai-chat`);
  const card = page.getByTestId("chatgpt-plan-card");
  await expect(card).toHaveAttribute("data-state", "not_connected");
  await expect(card).toContainText(
    "Use your own ChatGPT Plus or Pro plan in AI chats. Usage counts against your plan; your organization is not billed.",
  );
  await bothThemes(page, `settings-ai-chat-not-connected-${w}`);

  await card.getByTestId("chatgpt-continue").click();
  const dialog = page.getByTestId("chatgpt-connect-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("chatgpt-connect-submit")).toBeDisabled();

  const popupPromise = page.waitForEvent("popup");
  await dialog.getByTestId("chatgpt-dialog-continue").click();
  const popup = await popupPromise;
  await expect.poll(landed, { timeout: 10_000 }).toMatch(/^http:\/\/127\.0\.0\.1:1455\/auth\/callback\?/u);
  expect(new URL(landed()).searchParams.get("code")).toBeTruthy();
  await popup.close();

  await expect(dialog).toContainText("ChatGPT opened in a new tab.");
  await dialog.getByTestId("chatgpt-redirect-input").fill(landed());
  await bothThemes(page, `chatgpt-connect-dialog-${w}`);
  await dialog.getByTestId("chatgpt-connect-submit").click();
  await expect(dialog).toBeHidden();
  await dismissWelcome(page);

  await expect(card).toHaveAttribute("data-state", "connected");
  await expect(card.getByTestId("chatgpt-plan-connected")).toHaveText("Connected");
  await expect(card.getByTestId("chatgpt-plan-account")).toContainText("member@fake-chatgpt.test");
  await expect(card.getByTestId("chatgpt-plan-type")).toHaveText("Plus");
  const manage = card.getByTestId("chatgpt-manage-usage");
  await expect(manage).toHaveText(/Manage usage/u);
  await expect(manage).toHaveAttribute("href", "https://chatgpt.com/settings/usage");
  await expect(manage).toHaveAttribute("target", "_blank");
  await bothThemes(page, `settings-ai-chat-connected-${w}`);

  // The next AI chat runs on the plan Sam just connected.
  await openNewAiChat(page);
  await expect(page.getByTestId("ai-model-chip")).toContainText("GPT-6 Astra");
  await expect(page.getByTestId("plan-usage-line")).toContainText("Using ChatGPT plan");
  await sendAi(page, "Hello from my own plan");
  const answer = lastAssistant(page);
  await expect(answer).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
  expect(await answerText(answer)).toContain("Hello from my own plan");
  await context.close();
});

test("a wrong paste is explained in place and the right one still connects", async ({ browser }, info) => {
  const project = info.project.name;
  await sam.delete(STATUS);
  const { context, page } = await openAs(browser, SAM, project);
  const landed = await captureLoopback(context);
  await page.goto(`${BASE_URL}/settings/ai-chat`);
  await page.getByTestId("chatgpt-continue").click();
  const dialog = page.getByTestId("chatgpt-connect-dialog");
  const popupPromise = page.waitForEvent("popup");
  await dialog.getByTestId("chatgpt-dialog-continue").click();
  const popup = await popupPromise;
  // Close the tab only once it has landed: closing it earlier aborts the authorize -> loopback navigation.
  await expect.poll(landed, { timeout: 10_000 }).toMatch(/^http:\/\/127\.0\.0\.1:1455\//u);
  await popup.close();

  const input = dialog.getByTestId("chatgpt-redirect-input");
  await input.fill(landed().replace("127.0.0.1", "localhost"));
  await dialog.getByTestId("chatgpt-connect-submit").click();
  await expect(dialog.getByTestId("chatgpt-connect-error")).toContainText(
    "Paste the full address that starts with http://127.0.0.1.",
  );
  await input.fill(landed());
  await dialog.getByTestId("chatgpt-connect-submit").click();
  await expect(dialog).toBeHidden();
  await dismissWelcome(page);
  await expect(page.getByTestId("chatgpt-plan-card")).toHaveAttribute("data-state", "connected");
  await context.close();
});

test("Sam disconnects: the card offers Continue with ChatGPT again and his plan models are unavailable", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const w = widthOf(project);
  const { context, page } = await openAs(browser, SAM, project);
  await page.goto(`${BASE_URL}/settings/ai-chat`);
  const card = page.getByTestId("chatgpt-plan-card");
  await expect(card).toHaveAttribute("data-state", "connected");

  await card.getByTestId("chatgpt-disconnect").click();
  const confirm = page.getByTestId("chatgpt-disconnect-dialog");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("Your AI chats on ChatGPT models will switch to organization models");
  await bothThemes(page, `settings-ai-chat-disconnect-${w}`);
  await confirm.getByTestId("chatgpt-disconnect-confirm").click();
  await expect(confirm).toBeHidden();
  await expect(card).toHaveAttribute("data-state", "not_connected");
  await expect(card.getByTestId("chatgpt-continue")).toHaveText("Continue with ChatGPT");

  // The plan rows of the model list are unavailable (not connected); a New chat no longer runs on the plan.
  const models = (await (await sam.get("/api/v1/ai-chat/models")).json()) as {
    models: Array<{ group: string; available: boolean; reason: string | null }>;
  };
  const plan = models.models.filter((m) => m.group === "chatgpt_plan");
  expect(plan.length).toBeGreaterThan(0);
  expect(plan.every((m) => !m.available && m.reason === "not_connected")).toBe(true);
  await page.goto(`${BASE_URL}/chat/ai`);
  await page.getByTestId("ai-new-chat").click();
  await expect(
    page.getByTestId("ai-model-chip").or(page.getByPlaceholder("No model is available to you yet")),
  ).toBeVisible();
  await expect(page.getByTestId("plan-usage-line")).toHaveCount(0);
  await context.close();
});
