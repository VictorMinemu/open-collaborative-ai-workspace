import { crc32, deflateSync } from "node:zlib";
import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { apiAs, ensureMember, openAs, SAM } from "../support/actors";
import { chatIdOf, lastAssistant, openNewAiChat, seedPlan } from "../support/ai-chat";
import { ALEX } from "../support/chat";
import { ADMIN, shot } from "./env";

/**
 * AICHAT-08 (05-12): files in AI chats through the Phase 4 upload pipeline. The member attaches an image with the
 * paperclip on New chat (the first file creates a draft chat to upload into), sends it, and the fake vision model
 * answers "… [images:1]": the API read the image's bytes from the harness Garage (:4292) and sent them inline.
 * The user bubble shows the thumbnail and opens the lightbox; nobody else can download the file. No real provider
 * is ever called.
 */

test.describe.configure({ mode: "serial" });

const FAKE_URL = process.env.OCW_E2E_FAKE_URL ?? "";

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** An RGB PNG drawn by `pixel` (no image library needed). */
function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]) {
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
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A soft gradient "chart" with bars, so the bubble's thumbnail and the lightbox look like a real screenshot. */
function chart(width = 960, height = 600): Buffer {
  const bars = [0.35, 0.55, 0.42, 0.7, 0.62, 0.82];
  return png(width, height, (x, y) => {
    const t = (x / width + y / height) / 2;
    const bg: [number, number, number] = [
      Math.round(244 - 20 * t),
      Math.round(246 - 16 * t),
      Math.round(252 - 8 * t),
    ];
    const left = width * 0.12;
    const slot = (width * 0.76) / bars.length;
    const i = Math.floor((x - left) / slot);
    const h = bars[i];
    if (h !== undefined && x - left - i * slot > slot * 0.2 && x - left - i * slot < slot * 0.8) {
      const top = height * 0.85 - h * height * 0.6;
      if (y > top && y < height * 0.85) return [79 + i * 10, 70, 229 - i * 12];
    }
    return bg;
  });
}

async function expectLoaded(img: Locator) {
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10_000 })
    .toBeGreaterThan(0);
}

/** Picks files through the composer's paperclip (the file chooser it opens). */
async function attachWithPaperclip(page: Page, files: Array<{ name: string; type: string; bytes: Buffer }>) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("ai-attach-button").click();
  await (await chooser).setFiles(files.map((f) => ({ name: f.name, mimeType: f.type, buffer: f.bytes })));
}

/** The attachment id in an API attachment URL. */
const idOf = (url: string | null) => /\/api\/v1\/attachments\/([0-9a-f-]{36})\//.exec(url ?? "")?.[1] ?? "";

let admin: APIRequestContext;
let sam: APIRequestContext;
let alex: APIRequestContext;

test.beforeAll(async () => {
  test.skip(!FAKE_URL, "OCW_E2E_FAKE_URL is not set (the fake model is not running)");
  admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  await ensureMember(admin, ALEX, "developer");
  sam = await apiAs(SAM);
  alex = await apiAs(ALEX);
  await seedPlan(sam);
  // The one-time ChatGPT welcome (05-07) would cover the chat after seeding.
  await sam.post("/api/v1/me/model-credentials/chatgpt/welcome-seen", { data: {} });
});

/**
 * Later specs share Sam and the organization: archive the chats made here (the AI chat list pages at 30, and
 * ai-chat-list expects its own "older" chat on the first page) and drop the text-only provider added for gating.
 */
const created: string[] = [];
test.afterAll(async () => {
  for (const id of created) await sam?.patch(`/api/v1/ai-chats/${id}`, { data: { archived: true } });
  await admin?.delete("/api/v1/model-providers/openai-compatible");
  await alex?.dispose();
  await sam?.dispose();
  await admin?.dispose();
});

test("an image attached with the paperclip reaches the vision model and shows in the bubble; it stays private", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const w = widthOf(info.project.name);
  const { context, page } = await openAs(browser, SAM, info.project.name);
  try {
    await openNewAiChat(page);
    await expect(page.getByTestId("ai-model-chip")).toContainText("GPT-6 Astra");

    await attachWithPaperclip(page, [{ name: "q3-signups.png", type: "image/png", bytes: chart() }]);
    const tray = page.getByTestId("attachment-tray");
    await expect(tray).toBeVisible();
    const item = tray.getByTestId("attachment-item");
    await expect(item).toHaveCount(1);
    await expectLoaded(item.getByTestId("attachment-thumb"));
    await expect(item).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
    await page.getByTestId("ai-composer").fill("what is this?");
    await page.mouse.move(0, 0);
    await bothThemes(page, `ai-chat-image-tray-${w}`);

    await page.getByTestId("ai-send").click();
    await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/u);
    created.push(chatIdOf(page));
    const answer = lastAssistant(page);
    await expect(answer).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
    await expect(answer.getByTestId("ai-message-text")).toHaveText(/\[images:1\]$/u);
    await expect(page.getByTestId("attachment-tray")).toHaveCount(0);

    const user = page.locator('[data-testid="ai-message"][data-role="user"]').last();
    await expect(user).toContainText("what is this?");
    const preview = user.getByTestId("attachment-image");
    await expect(preview).toBeVisible();
    await expectLoaded(preview);
    const id = idOf(await preview.getAttribute("src"));
    expect(id).not.toBe("");
    await page.mouse.move(0, 0);
    await bothThemes(page, `ai-chat-image-${w}`);

    await user.getByTestId("attachment-tile").first().click();
    const lightbox = page.getByTestId("lightbox");
    await expect(lightbox).toBeVisible();
    await expectLoaded(lightbox.getByTestId("lightbox-image"));
    await page.keyboard.press("Escape");
    await expect(lightbox).toBeHidden();

    // Owner only: Sam downloads (302); Alex and the admin get 404 (P-03).
    expect((await sam.get(`/api/v1/attachments/${id}/download`, { maxRedirects: 0 })).status()).toBe(302);
    expect((await alex.get(`/api/v1/attachments/${id}/download`, { maxRedirects: 0 })).status()).toBe(404);
    expect((await admin.get(`/api/v1/attachments/${id}/download`, { maxRedirects: 0 })).status()).toBe(404);
    expect((await alex.get(`/api/v1/attachments/${id}/preview`, { maxRedirects: 0 })).status()).toBe(404);
  } finally {
    await context.close();
  }
});

/** A minimal PDF (enough for magic-byte sniffing: the API keeps application/pdf). */
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\n" +
    "trailer<</Root 1 0 R>>\n%%EOF\n",
);
const SONNET_KEY = "org_key:anthropic/claude-sonnet-5-5";
const LLAMA_KEY = "org_key:openai-compatible/llama-4-70b";

/** Opens the composer's model picker and picks `key` (popover on desktop, bottom sheet on a phone). */
async function pickModel(page: Page, key: string) {
  await page.getByTestId("ai-model-chip").click();
  const picker = page.getByTestId("ai-model-picker");
  await expect(picker).toBeVisible();
  await picker.getByTestId(`ai-model-${key}`).click();
  await expect(picker).toBeHidden();
}

test("the composer only takes what the selected model reads: a PDF is refused on a text model and sends on Claude", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const w = widthOf(info.project.name);
  // An admin's Anthropic key and an OpenAI-compatible server whose model reads text only, both on the fake.
  for (const data of [
    {
      provider: "anthropic",
      apiKey: "sk-ant-e2e-fake-key-not-real-0512",
      baseUrl: FAKE_URL,
      // The same allowed set ai-chat-models uses: later specs expect Haiku to be the org-key title model.
      allowedModels: ["claude-sonnet-5-5", "claude-haiku-4-5"],
      enabled: true,
    },
    {
      provider: "openai-compatible",
      apiKey: "sk-compat-e2e-fake-0512",
      baseUrl: `${FAKE_URL}/v1`,
      allowedModels: ["llama-4-70b"],
      enabled: true,
    },
  ]) {
    const res = await admin.post("/api/v1/model-providers", { data });
    expect(res.ok(), `configure ${data.provider}: ${res.status()} ${await res.text()}`).toBe(true);
  }
  const { context, page } = await openAs(browser, SAM, info.project.name);
  try {
    await openNewAiChat(page);
    await pickModel(page, LLAMA_KEY);
    await expect(page.getByTestId("ai-model-chip")).toContainText("llama-4-70b");
    await expect(page.getByTestId("ai-attach-button")).toHaveAttribute(
      "title",
      "llama-4-70b reads text files only",
    );

    await attachWithPaperclip(page, [{ name: "offsite-plan.pdf", type: "application/pdf", bytes: PDF }]);
    const item = page.getByTestId("attachment-tray").getByTestId("attachment-item");
    await expect(item).toHaveCount(1);
    await expect(item).toHaveAttribute("data-refused", "true");
    await expect(item.getByTestId("attachment-error")).toHaveText("llama-4-70b can't read PDFs");
    await page.getByTestId("ai-composer").fill("Summarise the plan");
    await expect(page.getByTestId("ai-send")).toBeDisabled();
    await page.mouse.move(0, 0);
    await bothThemes(page, `ai-chat-attach-refused-${w}`);

    // A file already in the tray is checked again when the model changes.
    await pickModel(page, SONNET_KEY);
    await expect(item).not.toHaveAttribute("data-refused", "true");
    await expect(item).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
    await expect(item.getByTestId("attachment-error")).toHaveCount(0);
    await expect(page.getByTestId("ai-attach-button")).toHaveAttribute(
      "title",
      "Claude Sonnet 5.5 reads images, PDFs and text files",
    );
    await expect(page.getByTestId("ai-send")).toBeEnabled();
    await page.getByTestId("ai-send").click();
    await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/u);
    created.push(chatIdOf(page));
    const answer = lastAssistant(page);
    await expect(answer).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
    await expect(answer.getByTestId("ai-message-text")).toHaveText(/\[files:1\]$/u);
    const user = page.locator('[data-testid="ai-message"][data-role="user"]').last();
    await expect(user.getByTestId("file-card")).toContainText("offsite-plan.pdf");
    await page.mouse.move(0, 0);
    await bothThemes(page, `ai-chat-pdf-sent-${w}`);
  } finally {
    await context.close();
  }
});
