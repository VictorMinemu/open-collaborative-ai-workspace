import { randomUUID } from "node:crypto";
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

async function sendAs(chatId: string, body: string) {
  const res = await sam.post(`/api/v1/ai-chats/${chatId}/messages`, {
    data: { clientMessageId: `cm-${randomUUID()}`, body, model: PLAN_MODEL },
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
