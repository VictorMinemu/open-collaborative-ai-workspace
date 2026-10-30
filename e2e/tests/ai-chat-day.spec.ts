import { crc32, deflateSync } from "node:zlib";
import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs } from "../support/actors";
import { answerText, chatIdOf, openNewAiChat, sendAi, waitForLonger } from "../support/ai-chat";
import { ALEX } from "../support/chat";
import { ADMIN, shot } from "./env";

/**
 * Phase 5 gate (05-15): a whole AI chat session on one fresh isolated stack, crossing every Phase 5 slice (ROADMAP
 * Phase 5 success criteria 1–5). The admin configures Anthropic (fake key, fake base URL) and caps organization models
 * at 5 answers a day in Settings › Models › AI chats. A member connects their own ChatGPT plan through the paste flow
 * (fake "Sign in with ChatGPT") and dismisses the welcome; on New chat they turn Web on and ask on GPT-6 Astra (a
 * source chip), the chat gets its title, a slow answer is stopped (Stopped, partial kept) and regenerated with Claude
 * Sonnet 5.5 (METERED in the picker and the footer, with a cost); they attach a PNG and ask about it ("[images:1]"),
 * rename the chat, find it with ⌘K by a word from the answer, share it and copy the link. Alex opens the link and
 * reads the snapshot; the member's Settings › AI chat shows today's usage against the cap, the admin's Usage report
 * lists the member, and Alex's ⌘K never shows the member's chat. Captures `ai-chat-day-<step>-<1440|390>`. Only the
 * harness fakes (Responses API, SIWC, Anthropic, SearXNG) and the harness Garage are involved.
 */

test.describe.configure({ mode: "serial" });

const FAKE_URL = process.env.OCW_E2E_FAKE_URL ?? "";
const FAKE_ANTHROPIC_KEY = "sk-ant-e2e-fake-key-not-real-0000";
const SONNET_KEY = "org_key:anthropic/claude-sonnet-5-5";
const PLAN_KEY = "chatgpt_plan:openai/gpt-6-astra";
const USAGE = /^\d[\d.,k]* in · \d[\d.,k]* out · ~?\$\d/u;
const COST = /^~?\$\d/u;
const LOOPBACK = "http://127.0.0.1:1455/**";

/**
 * The day's member: a colleague of their own per project. The organization cap of 5 then counts only this session's
 * answers, whatever other specs (which share Sam) did earlier today on the same stack.
 */
const memberFor = (project: string): Actor =>
  project === "mobile"
    ? { name: "Robin Park", email: "robin-day@ocw.test", password: "robin-e2e-password-123" }
    : { name: "Riley Park", email: "riley-day@ocw.test", password: "riley-e2e-password-123" };

/** A lowercase, letters-only token unique to this run (full-text search splits digits off words). */
const uniqueWord = () =>
  `zq${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.replace(/[0-9]/g, (d) =>
    String.fromCharCode(97 + Number(d)),
  );

/** An RGB PNG "chart" (a soft gradient with bars), no image library needed. */
function chart(width = 960, height = 600): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const bars = [0.4, 0.55, 0.48, 0.72, 0.66, 0.85];
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      let px: [number, number, number] = [
        Math.round(244 - 20 * t),
        Math.round(246 - 16 * t),
        Math.round(252 - 8 * t),
      ];
      const left = width * 0.12;
      const slot = (width * 0.76) / bars.length;
      const i = Math.floor((x - left) / slot);
      const h = bars[i];
      if (h !== undefined && x - left - i * slot > slot * 0.2 && x - left - i * slot < slot * 0.8) {
        if (y > height * 0.85 - h * height * 0.6 && y < height * 0.85) px = [16 + i * 8, 150 + i * 12, 129];
      }
      raw[row + 1 + x * 3] = px[0];
      raw[row + 2 + x * 3] = px[1];
      raw[row + 3 + x * 3] = px[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Records the http://127.0.0.1:1455 address the browser lands on after the (fake) authorize page, answering it like
 * an unreachable page, as for a real member. Playwright does not route an HTTP redirect's target, so the fake
 * authorize 302 is replayed as `location.replace` (what a real login page does once the member approves).
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

/** Opens the composer's model picker and picks `key` (popover on desktop, bottom sheet on a phone). */
async function pick(page: Page, key: string) {
  await page.getByTestId("ai-model-chip").click();
  const picker = page.getByTestId("ai-model-picker");
  await expect(picker).toBeVisible();
  await picker.getByTestId(`ai-model-${key}`).click();
  await expect(picker).toBeHidden();
}

async function openPalette(page: Page, mobile: boolean): Promise<Locator> {
  const palette = page.getByTestId("search-palette");
  // Right after a navigation the shortcut can land before the page listens for it: press again until it opens.
  await expect(async () => {
    if (mobile) await page.getByTestId("open-search").click();
    else await page.keyboard.press("ControlOrMeta+K");
    await expect(palette).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 10_000 });
  await expect(palette.getByTestId("search-input")).toBeFocused();
  return palette;
}

/** A calm capture: no hover state, no focused trigger. */
async function calm(page: Page) {
  const viewport = page.viewportSize();
  if (viewport) await page.mouse.move(viewport.width - 4, Math.round(viewport.height / 2));
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

let admin: APIRequestContext;

test.beforeAll(async () => {
  test.skip(!FAKE_URL, "OCW_E2E_FAKE_URL is not set (the fake model is not running)");
  admin = await apiAs(ADMIN);
  await ensureMember(admin, ALEX, "developer");
});

test.afterAll(async () => {
  await admin?.dispose();
  if (!FAKE_URL) return;
  // Later specs run with the default cap even when the test timed out, when its own contexts are already closed
  // (an interrupted run here left the cap at 5 and refused every later organization-model answer).
  const fresh = await apiAs(ADMIN);
  try {
    const restored = await fresh.put("/api/v1/ai-chat/policy", { data: { orgKeyDailyGenerations: 200 } });
    expect(restored.ok(), "restore the organization cap").toBe(true);
  } finally {
    await fresh.dispose();
  }
});

test("an AI chat day: own ChatGPT plan, Web, title, stop, regenerate on a METERED model, image, rename, search, share, usage", async ({
  browser,
}, info) => {
  // The longest spec in the suite; a loaded CI agent took more than 5 minutes on mobile (pipelines 67, 89, 96).
  test.setTimeout(480_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const size = mobile ? "390" : "1440";
  const step = (name: string) => `ai-chat-day-${name}-${size}`;
  const member = memberFor(project);
  const word = uniqueWord();

  // ---- the admin: an organization Anthropic key on the fake (the Settings form has no base URL for Anthropic)
  const configured = await admin.post("/api/v1/model-providers", {
    data: {
      provider: "anthropic",
      apiKey: FAKE_ANTHROPIC_KEY,
      baseUrl: FAKE_URL,
      allowedModels: ["claude-sonnet-5-5", "claude-haiku-4-5"],
      enabled: true,
    },
  });
  expect(configured.ok(), `configure Anthropic: ${configured.status()}`).toBe(true);
  await ensureMember(admin, member, "developer");
  const memberApi = await apiAs(member);
  // A re-run on a kept database starts from "not connected" too.
  expect((await memberApi.delete("/api/v1/me/model-credentials/chatgpt")).ok()).toBe(true);

  const adminUi = await openAs(browser, ADMIN, project);
  const day = await openAs(browser, member, project);
  await day.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE_URL });
  const reader = await openAs(browser, ALEX, project);
  try {
    // ---- the admin caps organization models at 5 answers per member per day (Settings › Models › AI chats)
    await adminUi.page.goto(`${BASE_URL}/settings/models`);
    await expect(adminUi.page.getByTestId("provider-anthropic").getByText("Connected")).toBeVisible();
    await expect(adminUi.page.getByText(FAKE_ANTHROPIC_KEY)).toHaveCount(0);
    const policy = adminUi.page.getByTestId("ai-chat-policy-settings");
    await policy.scrollIntoViewIfNeeded();
    const cap = policy.getByTestId("ai-policy-orgKeyDailyGenerations");
    await cap.fill("5");
    await policy.getByTestId("ai-policy-save").click();
    await expect(adminUi.page.getByText("AI chat policy saved")).toBeVisible();
    expect(((await (await admin.get("/api/v1/ai-chat/policy")).json()) as Json).orgKeyDailyGenerations).toBe(
      5,
    );

    // ---- the member connects their own ChatGPT plan by pasting the loopback address
    const page = day.page;
    const landed = await captureLoopback(day.context);
    await page.goto(`${BASE_URL}/settings/ai-chat`);
    const card = page.getByTestId("chatgpt-plan-card");
    await expect(card).toHaveAttribute("data-state", "not_connected");
    await card.getByTestId("chatgpt-continue").click();
    const dialog = page.getByTestId("chatgpt-connect-dialog");
    await expect(dialog).toBeVisible();
    const popupPromise = page.waitForEvent("popup");
    await dialog.getByTestId("chatgpt-dialog-continue").click();
    const popup = await popupPromise;
    await expect.poll(landed, { timeout: 10_000 }).toMatch(/^http:\/\/127\.0\.0\.1:1455\/auth\/callback\?/u);
    await popup.close();
    await dialog.getByTestId("chatgpt-redirect-input").fill(landed());
    await dialog.getByTestId("chatgpt-connect-submit").click();
    await expect(dialog).toBeHidden();
    const welcome = page.getByTestId("chatgpt-welcome");
    await expect(welcome).toBeVisible();
    await expect(welcome).toContainText("not your organization's bill");
    await welcome.getByTestId("chatgpt-welcome-done").click();
    await expect(welcome).toBeHidden();
    await expect(card).toHaveAttribute("data-state", "connected");
    await expect(card.getByTestId("chatgpt-plan-type")).toHaveText("Plus");
    await calm(page);
    await shot(page, step("connected"));

    // ---- New chat with Web on, on GPT-6 Astra: a sourced answer, then the generated title
    await openNewAiChat(page);
    await expect(page.getByTestId("ai-model-chip")).toContainText("GPT-6 Astra");
    await expect(page.getByTestId("plan-usage-line")).toContainText("Using ChatGPT plan");
    await page.getByTestId("ai-tools-button").click();
    const tools = page.getByTestId("ai-tools-menu");
    await expect(tools).toBeVisible();
    await tools.getByTestId("ai-tool-web").getByTestId("ai-tool-web-switch").click();
    await expect(tools.getByTestId("ai-tool-web-switch")).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(tools).toBeHidden();
    await expect(page.getByTestId("ai-tool-chip-web")).toHaveText("Web");
    await sendAi(page, `What changed in the ${word} release? [[web ocw release]] [[title:Release digest]]`);
    await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/u);
    const chatId = chatIdOf(page);
    const answers = page.locator('[data-testid="ai-message"][data-role="assistant"]');
    const first = answers.nth(0);
    await expect(first).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
    expect(await answerText(first)).toContain(word);
    await expect(first.getByTestId("ai-source-chip")).toHaveText("example.com");
    await expect(first.getByTestId("ai-message-footer")).toHaveText(/ · GPT-6 Astra · ChatGPT plan$/u);
    await expect(page.getByTestId("ai-chat-title")).toHaveText("Release digest", { timeout: 10_000 });
    await calm(page);
    await shot(page, step("web"));

    // ---- a slow answer, stopped: the partial text is kept and marked Stopped
    await sendAi(page, "[[slow]] write a long list");
    const slow = answers.nth(1);
    await waitForLonger(slow, "Echo: write a long list 1 2".length);
    await expect(slow).toHaveAttribute("data-status", "streaming");
    await page.getByTestId("ai-stop").click();
    await expect(slow).toHaveAttribute("data-status", "completed", { timeout: 5_000 });
    await expect(slow.getByTestId("ai-generation-state")).toHaveText("Stopped");
    const kept = await answerText(slow);
    expect(kept).toMatch(/^Echo: write a long list 1 2/u);
    expect(kept).not.toMatch(/ 40$/u);
    await expect(page.getByTestId("ai-send")).toBeVisible();
    await calm(page);
    await shot(page, step("stopped"));

    // ---- regenerated with Claude Sonnet 5.5: METERED in the picker and in the footer, with a cost
    await slow.getByTestId("ai-regenerate").click();
    const regen = page.getByTestId("ai-regenerate-menu");
    await expect(regen).toBeVisible();
    await regen.getByTestId("ai-regenerate-with").click();
    const sonnet = regen.getByTestId(`ai-model-${SONNET_KEY}`);
    await expect(sonnet).toContainText("Claude Sonnet 5.5");
    await expect(sonnet.getByTestId("ai-model-metered")).toBeVisible();
    await expect(regen.getByTestId(`ai-model-${PLAN_KEY}`).getByTestId("ai-model-metered")).toHaveCount(0);
    await sonnet.click();
    await expect(regen).toBeHidden();
    // The same message streams again (about four seconds: the prompt is slow on every backend), then finishes.
    const metered = slow.getByTestId("ai-message-footer");
    await expect(metered).toHaveText(/ · Claude Sonnet 5\.5 · METERED$/u, { timeout: 20_000 });
    await expect(slow).toHaveAttribute("data-status", "completed");
    await expect(slow.getByTestId("ai-generation-state")).toHaveCount(0);
    await expect(metered).toHaveText(USAGE);
    await expect(answers).toHaveCount(2);
    await calm(page);
    await shot(page, step("regenerated"));

    // ---- a PNG attached with the paperclip, asked about on the member's plan: the model sees one image
    await pick(page, PLAN_KEY);
    await expect(page.getByTestId("ai-model-chip")).toContainText("GPT-6 Astra");
    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("ai-attach-button").click();
    await (await chooser).setFiles([{ name: "q3-signups.png", mimeType: "image/png", buffer: chart() }]);
    const item = page.getByTestId("attachment-tray").getByTestId("attachment-item");
    await expect(item).toHaveCount(1);
    await expect(item).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
    await sendAi(page, "what does this chart show?");
    const third = answers.nth(2);
    await expect(third).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
    await expect(third.getByTestId("ai-message-text")).toContainText("[images:1]");
    const bubble = page.locator('[data-testid="ai-message"][data-role="user"]').last();
    const preview = bubble.getByTestId("attachment-image");
    await expect(preview).toBeVisible();
    await expect
      .poll(() => preview.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10_000 })
      .toBeGreaterThan(0);
    await calm(page);
    await shot(page, step("image"));

    // ---- rename from the header
    const title = `Release review ${word.slice(-4)}`;
    await page.getByTestId("ai-chat-title").click();
    const input = page.getByTestId("ai-chat-title-input");
    await expect(input).toBeFocused();
    await input.fill(title);
    await input.press("Enter");
    await expect(page.getByTestId("ai-chat-title")).toHaveText(title);

    // ---- ⌘K finds the chat by a word from the answer (a hit authored by the model) and opens it
    await page.goto(`${BASE_URL}/chat/ai`);
    const palette = await openPalette(page, mobile);
    await palette.getByTestId("search-input").pressSequentially(word, { delay: 30 });
    const hit = palette.locator('[data-kind="message"]').filter({ hasText: "GPT-6 Astra" }).first();
    await expect(hit).toBeVisible();
    await expect(hit).toContainText(word);
    await expect(hit).toContainText(title);
    await shot(page, step("search"));
    await hit.click();
    await expect(page).toHaveURL(new RegExp(`/chat/ai/${chatId}$`, "u"));
    await expect(page.getByTestId("ai-chat-title")).toHaveText(title);

    // ---- share a snapshot and copy the link
    await page.getByTestId("ai-chat-menu-button").click();
    await page.getByTestId("ai-chat-menu-share").click();
    const share = page.getByTestId("ai-share-dialog");
    await expect(share).toBeVisible();
    await expect(share.getByTestId("ai-share-audience")).toContainText("It is never public.");
    await share.getByTestId("ai-share-create").click();
    const link = share.getByTestId("ai-share-link").first();
    const url = await link.getByTestId("ai-share-url").inputValue();
    expect(url).toMatch(new RegExp(`^${BASE_URL}/share/ai/[0-9a-f-]{36}$`, "u"));
    await link.getByTestId("ai-share-copy").click();
    await expect(link.getByTestId("ai-share-copy")).toHaveText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    await calm(page);
    await shot(page, step("share"));
    await page.keyboard.press("Escape");
    await expect(share).toBeHidden();

    // ---- Alex opens the link and reads the snapshot (three questions, three answers, the image, no composer)
    await reader.page.goto(url);
    const view = reader.page.getByTestId("ai-share-view");
    await expect(view).toBeVisible();
    await expect(reader.page.getByTestId("ai-share-title")).toHaveText(title);
    await expect(view.getByTestId("ai-share-byline")).toContainText(`Shared by ${member.name}`);
    const turns = view.getByTestId("ai-share-message");
    await expect(turns).toHaveCount(6);
    await expect(turns.nth(3)).toContainText("Claude Sonnet 5.5");
    await expect(view.getByTestId("attachment-image")).toBeVisible();
    await expect(reader.page.getByTestId("ai-composer")).toHaveCount(0);
    await calm(reader.page);
    await shot(reader.page, step("snapshot"));

    // ---- the member's Settings › AI chat: today's usage against the cap, the plan counted and not billed
    await page.goto(`${BASE_URL}/settings/ai-chat`);
    const usage = page.getByTestId("usage-card");
    await expect(usage.getByRole("heading", { name: "Usage" })).toBeVisible();
    await expect(usage.getByTestId("usage-today-org").getByTestId("usage-today-org-answers")).toHaveText(
      "1 of 5 answers",
    );
    await expect(usage.getByTestId("usage-today-org").getByTestId("provider-metered")).toBeVisible();
    await expect(usage.getByTestId("usage-today-plan-answers")).toHaveText(/^[1-9]\d* answers?$/u);
    await expect(usage.getByTestId("usage-today-plan")).toContainText(
      "Counted against your plan, not billed to your organization",
    );
    await usage.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await calm(page);
    await shot(page, step("usage"));

    // ---- the admin's Usage report lists the member with a cost
    await adminUi.page.goto(`${BASE_URL}/settings/models`);
    const report = adminUi.page.getByTestId("ai-usage-report");
    await expect(report.getByRole("heading", { name: "Usage" })).toBeVisible();
    await report
      .getByRole("heading", { name: "Usage" })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    const row = report
      .locator(`[data-testid="ai-usage-row"][data-label="${member.name}"]`)
      .filter({ visible: true });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("ai-usage-answers")).toHaveText(/^[1-9]\d*( answers?)?$/u);
    await expect(row.getByTestId("ai-usage-cost")).toHaveText(COST);
    await calm(adminUi.page);
    await shot(adminUi.page, step("report"));

    // ---- Alex's ⌘K never shows the member's chat, by the answer's word or by its title
    for (const query of [word, title]) {
      await reader.page.goto(`${BASE_URL}/chat/ai`);
      const theirs = await openPalette(reader.page, mobile);
      await theirs.getByTestId("search-input").pressSequentially(query, { delay: 30 });
      // Wait for the answer to the query (results or "No results"), then look for anything of the member's chat.
      await expect(
        theirs.getByTestId("search-empty").or(theirs.getByTestId("search-result").first()),
      ).toBeVisible();
      await expect(theirs.locator('[data-kind="ai_chat"]')).toHaveCount(0);
      await expect(theirs.getByTestId("search-result").filter({ hasText: word })).toHaveCount(0);
      await expect(theirs.getByTestId("search-result").filter({ hasText: title })).toHaveCount(0);
      await reader.page.keyboard.press("Escape");
    }
  } finally {
    // The organization cap goes back to its default in afterAll (also after a timeout).
    await memberApi.dispose();
    await adminUi.context.close();
    await day.context.close();
    await reader.context.close();
  }
});

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
