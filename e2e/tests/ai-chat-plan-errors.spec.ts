import { type APIRequestContext, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
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
const STATUS = "/api/v1/me/model-credentials/chatgpt";
const LOOPBACK = "http://127.0.0.1:1455/**";
const SONNET_KEY = "org_key:anthropic/claude-sonnet-5-5";

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

/**
 * Records the http://127.0.0.1:1455 address the browser lands on after the fake authorize page (as in
 * ai-chat-signin.spec: the 302 is replayed client-side because Playwright does not route a redirect's target).
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

/** Opens the composer's model picker (popover on desktop, bottom sheet on a phone). */
async function openPicker(page: Page) {
  await page.getByTestId("ai-model-chip").click();
  const picker = page.getByTestId("ai-model-picker");
  await expect(picker).toBeVisible();
  return picker;
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

test("a member without a connection finds Continue with ChatGPT in the picker and sees the welcome once", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const w = widthOf(project);
  const off = await sam.delete(STATUS);
  expect(off.ok(), `disconnect: ${off.status()}`).toBe(true);
  const { context, page } = await openAs(browser, SAM, project);
  const landed = await captureLoopback(context);

  await openNewAiChat(page);
  // Without a plan, the default is the organization's model, labelled METERED.
  await expect(page.getByTestId("ai-model-chip")).toContainText("Claude Sonnet 5.5");
  const picker = await openPicker(page);
  const entry = picker.getByTestId("ai-model-continue-chatgpt");
  await expect(entry).toContainText("Continue with ChatGPT");
  await bothThemes(page, `ai-picker-continue-chatgpt-${w}`);

  await entry.click();
  await expect(picker).toBeHidden();
  const dialog = page.getByTestId("chatgpt-connect-dialog");
  await expect(dialog).toBeVisible();
  const popupPromise = page.waitForEvent("popup");
  await dialog.getByTestId("chatgpt-dialog-continue").click();
  await (await popupPromise).close().catch(() => {});
  await expect.poll(landed, { timeout: 10_000 }).toMatch(/^http:\/\/127\.0\.0\.1:1455\/auth\/callback\?/u);
  await dialog.getByTestId("chatgpt-redirect-input").fill(landed());
  await dialog.getByTestId("chatgpt-connect-submit").click();
  await expect(dialog).toBeHidden();

  const welcome = page.getByTestId("chatgpt-welcome");
  await expect(welcome).toBeVisible();
  await expect(welcome).toContainText("You're using your ChatGPT plan");
  await expect(welcome).toContainText("not your organization's bill");
  await expect(welcome.getByTestId("chatgpt-welcome-manage-usage")).toHaveAttribute("href", MANAGE_USAGE);
  await bothThemes(page, `chatgpt-welcome-${w}`);
  await welcome.getByTestId("chatgpt-welcome-done").click();
  await expect(welcome).toBeHidden();
  // The new connection is the default again.
  await expect(page.getByTestId("ai-model-chip")).toContainText("GPT-6 Astra");

  // Once: neither a reload nor Settings › AI chat shows it again.
  await page.reload();
  await expect(page.getByTestId("ai-composer")).toBeVisible();
  await page.goto(`${BASE_URL}/settings/ai-chat`);
  await expect(page.getByTestId("chatgpt-plan-card")).toHaveAttribute("data-state", "connected");
  await page.waitForTimeout(500);
  await expect(page.getByTestId("chatgpt-welcome")).toHaveCount(0);
  expect(((await (await sam.get(STATUS)).json()) as { welcomeSeen: boolean }).welcomeSeen).toBe(true);
  await context.close();
});

test("a not-eligible account explains itself and the next New chat starts on an organization model", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const w = widthOf(project);
  await seedPlan(sam);
  const { context, page } = await openAs(browser, SAM, project);
  await openNewAiChat(page);
  await expect(page.getByTestId("ai-model-chip")).toContainText("GPT-6 Astra");
  await sendAi(page, "hi [[plan:not_eligible]]");
  const answer = lastAssistant(page);
  await expect(answer).toHaveAttribute("data-status", "failed", { timeout: 15_000 });
  const card = answer.getByTestId("ai-generation-error-card");
  await expect(card).toHaveAttribute("data-code", "user_not_eligible");
  await expect(card.getByTestId("ai-generation-error")).toHaveText(
    "Your ChatGPT account isn't eligible for plan usage here.",
  );
  await expect(card.getByTestId("ai-error-use-org")).toBeVisible();
  // Not a usage limit: no dialog.
  await expect(page.getByTestId("ai-usage-limit-dialog")).toHaveCount(0);
  await bothThemes(page, `ai-plan-not-eligible-${w}`);

  // The picker says why, and a New chat defaults to the organization's model (METERED), nothing sent.
  await expect(page.getByTestId("ai-model-chip")).toContainText("Claude Sonnet 5.5");
  const picker = await openPicker(page);
  await expect(picker.getByTestId("ai-model-group-chatgpt_plan")).toContainText(
    "Your ChatGPT account isn't eligible here — use an organization model",
  );
  await expect(picker.getByTestId("ai-model-continue-chatgpt")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByTestId("ai-header-new-chat").click();
  await expect(page).toHaveURL(/\/chat\/ai\/new$/u);
  const chip = page.getByTestId("ai-model-chip");
  await expect(chip).toHaveAttribute("data-model", SONNET_KEY);
  await expect(chip.getByTestId("ai-model-metered")).toBeVisible();
  await context.close();
});

test("an invalid sign-in offers Reconnect ChatGPT in the card and the picker, which open the connect dialog", async ({
  browser,
}, info) => {
  const project = info.project.name;
  await seedPlan(sam);
  const { context, page } = await openAs(browser, SAM, project);
  await openNewAiChat(page);
  await sendAi(page, "hi [[plan:invalid_user]]");
  const answer = lastAssistant(page);
  await expect(answer).toHaveAttribute("data-status", "failed", { timeout: 15_000 });
  const card = answer.getByTestId("ai-generation-error-card");
  await expect(card).toHaveAttribute("data-code", "invalid_credential");
  await expect(card.getByTestId("ai-generation-error")).toHaveText(
    "Your ChatGPT sign-in is no longer valid. Reconnect to keep using your plan.",
  );
  await card.getByTestId("ai-error-reconnect").click();
  const dialog = page.getByTestId("chatgpt-connect-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  const picker = await openPicker(page);
  const row = picker.getByTestId("ai-model-reconnect-chatgpt");
  await expect(row).toContainText("Reconnect ChatGPT");
  await row.click();
  await expect(page.getByTestId("chatgpt-connect-dialog")).toBeVisible();
  await context.close();
});

/**
 * The desktop app's preload (05-07), simulated: `window.ocwDesktop` with the three loopback functions. The test's Node
 * side plays the main process: it "opens the system browser" by fetching the authorize URL and hands back the
 * loopback address the fake sends it to, as the real one-shot 127.0.0.1 listener does (apps/desktop chatgpt-loopback).
 * `gate` holds the callback until the test has checked the waiting state.
 */
async function fakeDesktop(page: Page, port: number) {
  const calls = { opened: "", cancelled: 0 };
  let release: (v: { ok: boolean; reason?: string }) => void = () => {};
  const gate = new Promise<{ ok: boolean; reason?: string }>((r) => {
    release = r;
  });
  await page.exposeFunction("__ocwLoopbackAwait", async (authorizeUrl: string) => {
    calls.opened = authorizeUrl;
    const verdict = await gate;
    if (!verdict.ok) return { ok: false, reason: verdict.reason ?? "cancelled" };
    const res = await fetch(authorizeUrl, { redirect: "manual" });
    return { ok: true, redirectUrl: res.headers.get("location") ?? "" };
  });
  await page.exposeFunction("__ocwLoopbackCancel", () => {
    calls.cancelled += 1;
    release({ ok: false, reason: "cancelled" });
  });
  await page.addInitScript((p: number) => {
    const w = window as unknown as Record<string, unknown> & {
      __ocwLoopbackAwait(url: string): Promise<unknown>;
      __ocwLoopbackCancel(): Promise<void>;
    };
    w.ocwDesktop = {
      isDesktop: true,
      platform: "darwin",
      status: async () => ({
        state: "online",
        label: "Runtime online",
        paired: true,
        deviceName: "Mac",
        projects: 0,
      }),
      addProject: async () => ({ ok: false, canceled: true }),
      listProjects: async () => [],
      onStatus: () => () => {},
      chatgptLoopbackPrepare: async () => ({ flowToken: "t".repeat(43), port: p }),
      chatgptLoopbackAwait: (_token: string, url: string) => w.__ocwLoopbackAwait(url),
      chatgptLoopbackCancel: () => w.__ocwLoopbackCancel(),
    };
  }, port);
  return { calls, release: (v: { ok: boolean; reason?: string } = { ok: true }) => release(v) };
}

test("in the desktop app Continue with ChatGPT completes without pasting", async ({ browser }, info) => {
  const project = info.project.name;
  const off = await sam.delete(STATUS);
  expect(off.ok()).toBe(true);
  const { context, page } = await openAs(browser, SAM, project);
  const desktop = await fakeDesktop(page, 1456);

  await page.goto(`${BASE_URL}/settings/ai-chat`);
  await page.getByTestId("chatgpt-continue").click();
  const dialog = page.getByTestId("chatgpt-connect-dialog");
  await expect(dialog).toBeVisible();
  // The paste step is never offered on the desktop path.
  await expect(dialog.getByTestId("chatgpt-redirect-input")).toHaveCount(0);
  await dialog.getByTestId("chatgpt-dialog-continue").click();
  await expect(dialog.getByTestId("chatgpt-desktop-waiting")).toContainText(
    "Waiting for ChatGPT in your browser",
  );
  await expect(dialog.getByTestId("chatgpt-redirect-input")).toHaveCount(0);
  await bothThemes(page, `chatgpt-desktop-waiting-${widthOf(project)}`);
  // The API built the redirect URI on the port the desktop listener bound.
  await expect.poll(() => desktop.calls.opened).toContain("/siwc/api/accounts/authorize?");
  expect(new URL(desktop.calls.opened).searchParams.get("redirect_uri")).toBe(
    "http://127.0.0.1:1456/auth/callback",
  );

  desktop.release();
  await expect(dialog).toBeHidden();
  const welcome = page.getByTestId("chatgpt-welcome");
  await expect(welcome).toBeVisible();
  await welcome.getByTestId("chatgpt-welcome-done").click();
  await expect(page.getByTestId("chatgpt-plan-card")).toHaveAttribute("data-state", "connected");
  expect(desktop.calls.cancelled).toBe(0);
  await context.close();
});

test("in the desktop app, cancelling the browser wait falls back to the paste steps", async ({
  browser,
}, info) => {
  const project = info.project.name;
  await sam.delete(STATUS);
  const { context, page } = await openAs(browser, SAM, project);
  const desktop = await fakeDesktop(page, 1455);
  await page.goto(`${BASE_URL}/settings/ai-chat`);
  await page.getByTestId("chatgpt-continue").click();
  const dialog = page.getByTestId("chatgpt-connect-dialog");
  await dialog.getByTestId("chatgpt-dialog-continue").click();
  await expect(dialog.getByTestId("chatgpt-desktop-waiting")).toBeVisible();
  await expect.poll(() => desktop.calls.opened).toContain("/siwc/api/accounts/authorize?");

  await dialog.getByTestId("chatgpt-desktop-cancel").click();
  expect(desktop.calls.cancelled).toBe(1);
  // The same sign-in can still finish by pasting the address the browser landed on.
  const input = dialog.getByTestId("chatgpt-redirect-input");
  await expect(input).toBeVisible();
  const res = await fetch(desktop.calls.opened, { redirect: "manual" });
  await input.fill(res.headers.get("location") ?? "");
  await dialog.getByTestId("chatgpt-connect-submit").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("chatgpt-welcome")).toBeVisible();
  await page.getByTestId("chatgpt-welcome-done").click();
  await expect(page.getByTestId("chatgpt-plan-card")).toHaveAttribute("data-state", "connected");
  await context.close();
});
