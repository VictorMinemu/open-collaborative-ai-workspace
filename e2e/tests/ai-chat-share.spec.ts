import { randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { seedPlan } from "../support/ai-chat";
import { ALEX } from "../support/chat";
import { ADMIN, shot } from "./env";

/**
 * AICHAT-09 (05-13): read-only snapshot share links. Sam shares his AI chat from the header menu; the dialog says who
 * can read it ("Anyone signed in to <org> with the link … never public") and creates a link he copies. Alex, signed
 * in to the same organization, opens it and reads the transcript as it was, with who shared it and when; messages
 * Sam sends later never appear. A signed-out browser lands on sign-in. No real provider is ever called.
 */

test.describe.configure({ mode: "serial" });

const FAKE_URL = process.env.OCW_E2E_FAKE_URL ?? "";
const PLAN_MODEL = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const ORG = ADMIN.orgName;

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

let admin: APIRequestContext;
let sam: APIRequestContext;
const created: string[] = [];

type Snap = { messages: Array<{ authorKind: string; status: string }> };

/** Waits until the chat's latest answer is no longer streaming. */
async function settled(chatId: string) {
  await expect
    .poll(
      async () => {
        const snap = (await (await sam.get(`/api/v1/ai-chats/${chatId}`)).json()) as Snap;
        return snap.messages.filter((m) => m.authorKind === "agent").at(-1)?.status;
      },
      { timeout: 15_000 },
    )
    .toBe("completed");
}

async function sendAs(chatId: string, body: string, attachmentIds: string[] = []) {
  const res = await sam.post(`/api/v1/ai-chats/${chatId}/messages`, {
    data: {
      clientMessageId: `cm-${randomUUID()}`,
      body,
      model: PLAN_MODEL,
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    },
  });
  expect(res.ok(), `send: ${res.status()}`).toBe(true);
  await settled(chatId);
}

/** A chat of Sam's with two finished exchanges and a typed title (the auto title never replaces it). */
async function chatWithTwoExchanges(title: string): Promise<string> {
  const res = await sam.post("/api/v1/ai-chats", {
    data: {
      clientMessageId: `cm-${randomUUID()}`,
      body: "Plan a two-day team offsite in Lisbon",
      model: PLAN_MODEL,
    },
  });
  expect(res.ok(), `create chat: ${res.status()}`).toBe(true);
  const chatId = ((await res.json()) as { chat: { id: string } }).chat.id;
  created.push(chatId);
  await settled(chatId);
  await sendAs(chatId, "Add a rough **budget** for twelve people");
  const renamed = await sam.patch(`/api/v1/ai-chats/${chatId}`, { data: { title } });
  expect(renamed.ok(), "rename").toBe(true);
  return chatId;
}

/** Opens the chat header menu and the Share dialog. */
async function openShareDialog(page: Page) {
  await page.getByTestId("ai-chat-menu-button").click();
  await page.getByTestId("ai-chat-menu-share").click();
  const dialog = page.getByTestId("ai-share-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test.beforeAll(async () => {
  test.skip(!FAKE_URL, "OCW_E2E_FAKE_URL is not set (the fake model is not running)");
  admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  await ensureMember(admin, ALEX, "developer");
  sam = await apiAs(SAM);
  await seedPlan(sam);
  await sam.post("/api/v1/me/model-credentials/chatgpt/welcome-seen", { data: {} });
});

/** Later specs share Sam's chat list (it pages at 30): archive what this spec made. */
test.afterAll(async () => {
  for (const id of created) await sam?.patch(`/api/v1/ai-chats/${id}`, { data: { archived: true } });
  await sam?.dispose();
  await admin?.dispose();
});

test("Sam shares a snapshot from the header; Alex in the same organization reads it as it was", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const w = widthOf(info.project.name);
  const chatId = await chatWithTwoExchanges("Lisbon offsite plan");
  const owner = await openAs(browser, SAM, info.project.name);
  await owner.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE_URL });
  const reader = await openAs(browser, ALEX, info.project.name);
  try {
    const page = owner.page;
    await page.goto(`${BASE_URL}/chat/ai/${chatId}`);
    await expect(page.locator('[data-testid="ai-message"][data-role="assistant"]')).toHaveCount(2);

    const dialog = await openShareDialog(page);
    await expect(dialog.getByTestId("ai-share-audience")).toHaveText(
      `Anyone signed in to ${ORG} with the link can read this snapshot. It is never public.`,
    );
    await dialog.getByTestId("ai-share-create").click();
    const link = dialog.getByTestId("ai-share-link").first();
    const url = await link.getByTestId("ai-share-url").inputValue();
    // The id is the whole link: no token, no query string.
    expect(url).toMatch(new RegExp(`^${BASE_URL}/share/ai/[0-9a-f-]{36}$`, "u"));
    await link.getByTestId("ai-share-copy").click();
    await expect(link.getByTestId("ai-share-copy")).toHaveText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    await page.mouse.move(0, 0);
    await bothThemes(page, `ai-share-dialog-${w}`);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // Alex reads the snapshot: the transcript, who shared it and when, and no way to write.
    await reader.page.goto(url);
    const view = reader.page.getByTestId("ai-share-view");
    await expect(view).toBeVisible();
    await expect(reader.page.getByTestId("ai-share-title")).toHaveText("Lisbon offsite plan");
    await expect(view.getByTestId("ai-share-byline")).toHaveText(
      new RegExp(`^Shared by ${SAM.name} · [A-Z][a-z]{2} \\d{1,2}, \\d{4}$`, "u"),
    );
    await expect(view.getByTestId("ai-share-banner")).toContainText(
      "Snapshot — later messages are not included",
    );
    const turns = view.getByTestId("ai-share-message");
    await expect(turns).toHaveCount(4);
    await expect(turns.nth(0)).toHaveAttribute("data-role", "user");
    await expect(turns.nth(0)).toContainText("Plan a two-day team offsite in Lisbon");
    await expect(turns.nth(1)).toHaveAttribute("data-role", "assistant");
    await expect(turns.nth(1)).toContainText("GPT-6 Astra");
    await expect(reader.page.getByTestId("ai-composer")).toHaveCount(0);
    await reader.page.mouse.move(0, 0);
    await bothThemes(reader.page, `ai-share-view-${w}`);

    // Sam keeps chatting; the snapshot does not move.
    await sendAs(chatId, "And a rainy-day plan?");
    await reader.page.reload();
    await expect(reader.page.getByTestId("ai-share-view")).toBeVisible();
    await expect(reader.page.getByTestId("ai-share-message")).toHaveCount(4);
    await expect(reader.page.getByTestId("ai-share-view")).not.toContainText("rainy-day");
  } finally {
    await owner.context.close();
    await reader.context.close();
  }
});

test("a signed-out browser opening a share link lands on the sign-in page", async ({ browser }, info) => {
  const chatId = created[0] ?? (await chatWithTwoExchanges("Signed-out probe"));
  const res = await sam.post(`/api/v1/ai-chats/${chatId}/shares`, { data: {} });
  expect(res.status()).toBe(201);
  const { path } = (await res.json()) as { path: string };
  const mobile = info.project.name === "mobile";
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto(`${BASE_URL}${path}`);
    await expect(page).toHaveURL(/\/login/u);
    await expect(page.getByTestId("ai-share-view")).toHaveCount(0);
    await expect(page.getByTestId("login-form")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("Sam revokes a link from the dialog and Alex's next load says it isn't available", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const w = widthOf(info.project.name);
  const chatId = await chatWithTwoExchanges("Revocable plan");
  const res = await sam.post(`/api/v1/ai-chats/${chatId}/shares`, { data: {} });
  expect(res.status()).toBe(201);
  const { id, path } = (await res.json()) as { id: string; path: string };
  const owner = await openAs(browser, SAM, info.project.name);
  const reader = await openAs(browser, ALEX, info.project.name);
  try {
    await reader.page.goto(`${BASE_URL}${path}`);
    await expect(reader.page.getByTestId("ai-share-view")).toBeVisible();

    const page = owner.page;
    await page.goto(`${BASE_URL}/chat/ai/${chatId}`);
    const dialog = await openShareDialog(page);
    const link = dialog.locator(`[data-testid="ai-share-link"][data-share-id="${id}"]`);
    await expect(link).toBeVisible();
    await link.getByTestId("ai-share-revoke").click();
    // A confirm step: nothing is revoked until Sam confirms.
    await expect(link).not.toHaveAttribute("data-revoked", "true");
    await link.getByTestId("ai-share-revoke-confirm").click();
    await expect(link).toHaveAttribute("data-revoked", "true");
    await expect(link.getByTestId("ai-share-revoked")).toHaveText("Revoked");
    await expect(link.getByTestId("ai-share-copy")).toHaveCount(0);

    await reader.page.reload();
    await expect(reader.page.getByText("This link isn't available")).toBeVisible();
    await expect(reader.page.getByTestId("ai-share-view")).toHaveCount(0);
    await reader.page.mouse.move(0, 0);
    await shot(reader.page, `ai-share-revoked-${w}`);
  } finally {
    await owner.context.close();
    await reader.context.close();
  }
});

/** A small RGB PNG (a soft gradient with a bar), enough for sniffing and real renditions. */
function png(width = 640, height = 400): Buffer {
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
      const bar = x > width * 0.3 && x < width * 0.7 && y > height * 0.35 && y < height * 0.75;
      const t = (x / width + y / height) / 2;
      raw[row + 1 + x * 3] = bar ? 79 : Math.round(240 - 30 * t);
      raw[row + 2 + x * 3] = bar ? 70 : Math.round(244 - 20 * t);
      raw[row + 3 + x * 3] = bar ? 229 : 252;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("Alex sees the shared image through the share and opens it in the lightbox", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const w = widthOf(info.project.name);
  // Sam's chat with an image: a draft to upload into, presign → PUT to the harness Garage → complete → send.
  const draft = await sam.post("/api/v1/ai-chats/drafts", { data: {} });
  expect(draft.status()).toBe(201);
  const chatId = ((await draft.json()) as { id: string }).id;
  created.push(chatId);
  const bytes = png();
  const presign = await sam.post(`/api/v1/conversations/${chatId}/attachments`, {
    data: { filename: "venue-floorplan.png", contentType: "image/png", size: bytes.length },
  });
  expect(presign.ok(), `presign: ${presign.status()}`).toBe(true);
  const p = (await presign.json()) as {
    attachment: { id: string };
    upload: { url: string; headers: Record<string, string> };
  };
  const put = await fetch(p.upload.url, {
    method: "PUT",
    headers: p.upload.headers,
    body: new Uint8Array(bytes),
  });
  expect(put.status).toBe(200);
  expect((await sam.post(`/api/v1/attachments/${p.attachment.id}/complete`)).ok()).toBe(true);
  await sendAs(chatId, "Which room fits twelve people?", [p.attachment.id]);
  const res = await sam.post(`/api/v1/ai-chats/${chatId}/shares`, { data: {} });
  expect(res.status()).toBe(201);
  const { path, id } = (await res.json()) as { path: string; id: string };

  const reader = await openAs(browser, ALEX, info.project.name);
  try {
    const page = reader.page;
    await page.goto(`${BASE_URL}${path}`);
    const view = page.getByTestId("ai-share-view");
    await expect(view).toBeVisible();
    const preview = view.getByTestId("attachment-image");
    await expect(preview).toBeVisible();
    // Share-scoped: the image comes through this share, never the chat's own attachment route.
    expect(await preview.getAttribute("src")).toContain(
      `/api/v1/ai-shares/${id}/attachments/${p.attachment.id}/preview`,
    );
    await expect
      .poll(() => preview.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10_000 })
      .toBeGreaterThan(0);
    await page.mouse.move(0, 0);
    await shot(page, `ai-share-image-${w}`);

    await view.getByTestId("attachment-tile").first().click();
    const lightbox = page.getByTestId("lightbox");
    await expect(lightbox).toBeVisible();
    const large = lightbox.getByTestId("lightbox-image");
    await expect
      .poll(() => large.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10_000 })
      .toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await expect(lightbox).toBeHidden();
  } finally {
    await reader.context.close();
  }
});
