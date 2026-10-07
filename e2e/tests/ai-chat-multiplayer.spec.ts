import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import {
  answerText,
  chatIdOf,
  humanTurn,
  lastAssistant,
  openNewAiChat,
  seedPlan,
  sendAi,
  shareWith,
  VICTOR,
} from "../support/ai-chat";
import { ALEX } from "../support/chat";
import { ADMIN, shot } from "./env";

/**
 * MULTI-01 / MULTI-08 in the browser (06-03): Acceptance Scenario B steps 1–4. Víctor creates a private AI chat,
 * shares it in place with Alex from the share dialog (which states exactly what becomes visible), Alex finds it under
 * "Shared with me", both write and the mock model answers each of them by name with the participant list. Every turn
 * runs on the asker's own (fake) ChatGPT plan; no real provider is ever called (P-12).
 */

test.describe.configure({ mode: "serial" });

const FAKE_URL = process.env.OCW_E2E_FAKE_URL ?? "";

/** P-13, verbatim: what people given access will see. */
const DISCLOSURE = [
  "the whole conversation, including earlier messages and answers",
  "every attached file and artifact",
  "this chat's instructions (context)",
  "the model behind each answer",
  "tool settings (Web search on or off)",
  "who has access and at which level (permissions)",
  "the other participants",
];
const PERSONAL_NOTE =
  "Your personal instructions stop being used in this chat from now on. Earlier answers may reflect them.";
const BILLING_NOTE =
  "Each person's messages are answered on their own ChatGPT plan or an organization model they pick — never on yours.";

const PARTICIPANTS = `(participants: ${ALEX.name}, ${VICTOR.name})`;

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

async function bothThemes(page: Page, name: string) {
  await page.mouse.move(0, 0);
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

let admin: APIRequestContext;

test.beforeAll(async () => {
  test.skip(!FAKE_URL, "OCW_E2E_FAKE_URL is not set (the fake model is not running)");
  admin = await apiAs(ADMIN);
  await ensureMember(admin, VICTOR, "admin");
  await ensureMember(admin, ALEX, "developer");
  for (const actor of [VICTOR, ALEX]) {
    const api = await apiAs(actor);
    await seedPlan(api);
    await api.post("/api/v1/me/model-credentials/chatgpt/welcome-seen", { data: {} });
    await api.dispose();
  }
});

test.afterAll(async () => {
  await admin?.dispose();
});

/** Opens the chat header menu and the share dialog. */
async function openShareDialog(page: Page) {
  await page.getByTestId("ai-chat-menu-button").click();
  await page.getByTestId("ai-chat-menu-share").filter({ visible: true }).click();
  const dialog = page.getByTestId("ai-share-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The answer after `turns` assistant turns exist, once it completed. */
async function answerAt(page: Page, turns: number): Promise<string> {
  await expect(page.locator('[data-testid="ai-message"][data-role="assistant"]')).toHaveCount(turns, {
    timeout: 15_000,
  });
  const answer = lastAssistant(page);
  await expect(answer).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
  return answerText(answer);
}

test("Scenario B 1–4: Víctor shares a private chat with Alex, both write and the model answers each by name", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const w = widthOf(project);
  const owner = await openAs(browser, VICTOR, project);
  const grantee = await openAs(browser, ALEX, project);
  try {
    // 1. Víctor's private chat, answered on his plan.
    const page = owner.page;
    await openNewAiChat(page);
    await sendAi(page, "Propose an architecture");
    await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/);
    expect(await answerAt(page, 1)).toBe("Echo: Propose an architecture");
    const chatId = chatIdOf(page);

    // 2. Share → People and teams: what becomes visible, then Alex, Can chat.
    const dialog = await openShareDialog(page);
    const people = dialog.getByTestId("ai-share-people");
    await expect(people.getByRole("heading", { name: "People and teams" })).toBeVisible();
    const disclosure = people.getByTestId("ai-share-disclosure");
    for (const item of DISCLOSURE) await expect(disclosure).toContainText(item);
    await expect(disclosure).toContainText(PERSONAL_NOTE);
    await expect(disclosure).toContainText(BILLING_NOTE);
    await expect(dialog.getByRole("heading", { name: "Read-only link (frozen copy)" })).toBeVisible();
    await expect(dialog.getByTestId("ai-share-audience")).toContainText("It is never public.");
    await shareWith(page, ALEX.name, "Can chat");
    await bothThemes(page, `multiplayer-share-dialog-${w}`);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // 3. Alex finds it under "Shared with me" (the sidebar sheet at 390), with the owner's name.
    const alex = grantee.page;
    if (mobile) await alex.getByTestId("mobile-nav-trigger").click();
    const shared = alex.getByTestId("sidebar-ai-shared").filter({ visible: true }).first();
    const row = shared.locator(`[data-testid="sidebar-ai-shared-chat"][data-chat-id="${chatId}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText(VICTOR.name);
    await shot(alex, `multiplayer-shared-with-me-${w}`);
    await row.click();
    await expect(alex).toHaveURL(new RegExp(`/chat/ai/${chatId}$`, "u"));
    const victorsTurn = humanTurn(alex, VICTOR.name);
    await expect(victorsTurn).toHaveCount(1);
    await expect(victorsTurn).toContainText("Propose an architecture");
    await expect(victorsTurn.getByTestId("ai-message-avatar")).toBeVisible();
    // Owner-only actions are not offered to a grantee (the server's viewerCan).
    await expect(alex.getByTestId("ai-chat-menu-button")).toHaveCount(0);
    await expect(alex.getByTestId("ai-chat-menu-rename")).toHaveCount(0);

    // 4. Both write; the model answers each of them by name, live on both pages.
    await sendAi(alex, "But we need multi-tenancy");
    const toAlex = `Hi ${ALEX.name}! ${PARTICIPANTS} Echo: But we need multi-tenancy`;
    expect(await answerAt(alex, 2)).toBe(toAlex);
    await expect(humanTurn(page, ALEX.name)).toContainText("But we need multi-tenancy");
    expect(await answerAt(page, 2)).toBe(toAlex);

    await sendAi(page, "What about cost?");
    const toVictor = `Hi ${VICTOR.name}! ${PARTICIPANTS} Echo: What about cost?`;
    expect(await answerAt(page, 3)).toBe(toVictor);
    expect(await answerAt(alex, 3)).toBe(toVictor);
    await expect(humanTurn(alex, VICTOR.name)).toHaveCount(2);
    await expect(humanTurn(alex, ALEX.name)).toHaveCount(1);

    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
    await bothThemes(page, `multiplayer-two-people-${w}`);
    await bothThemes(alex, `multiplayer-two-people-${w}-alex`);
  } finally {
    await owner.context.close();
    await grantee.context.close();
  }
});

const PLAN = (modelId: string) => ({ backend: "chatgpt_plan", provider: "openai", modelId }) as const;
const MOCK_KEY = "mock:mock/mock-1";

/** Waits until the chat's latest answer is no longer streaming. */
async function settled(api: APIRequestContext, chatId: string) {
  await expect
    .poll(
      async () => {
        const snap = (await (await api.get(`/api/v1/ai-chats/${chatId}`)).json()) as {
          messages: Array<{ authorKind: string; status: string }>;
        };
        return snap.messages.filter((m) => m.authorKind === "agent").at(-1)?.status;
      },
      { timeout: 15_000 },
    )
    .toBe("completed");
}

async function grant(api: APIRequestContext, chatId: string, userId: string, level: "chat" | "view") {
  const res = await api.post(`/api/v1/ai-chats/${chatId}/grants`, {
    data: { subject: { kind: "user", id: userId }, level },
  });
  expect(res.ok(), `grant ${level}: ${res.status()}`).toBe(true);
}

test("grantees get safe defaults: their own model, read-only for Can view, no owner-only actions", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const w = widthOf(project);
  const alexId = await ensureMember(admin, ALEX, "developer");
  const samId = await ensureMember(admin, SAM, "developer");
  // Víctor's chat last ran on his plan's GPT-5.6 Luna; Alex can chat, Sam can view.
  const victor = await apiAs(VICTOR);
  const created = await victor.post("/api/v1/ai-chats", {
    data: { clientMessageId: `cm-${randomUUID()}`, body: "Plan the data model", model: PLAN("gpt-5.6-luna") },
  });
  expect(created.ok(), `create chat: ${created.status()}`).toBe(true);
  const chatId = ((await created.json()) as { chat: { id: string } }).chat.id;
  await settled(victor, chatId);
  await grant(victor, chatId, alexId, "chat");
  await grant(victor, chatId, samId, "view");

  const viewer = await openAs(browser, SAM, project);
  const grantee = await openAs(browser, ALEX, project);
  const owner = await openAs(browser, VICTOR, project);
  try {
    // Sam (Can view) reads the chat: no composer, a notice saying whom to ask, no owner-only actions.
    const sam = viewer.page;
    await sam.goto(`${BASE_URL}/chat/ai/${chatId}`);
    await expect(humanTurn(sam, VICTOR.name)).toContainText("Plan the data model");
    await expect(lastAssistant(sam)).toHaveAttribute("data-status", "completed");
    await expect(sam.getByTestId("ai-composer")).toHaveCount(0);
    await expect(sam.getByTestId("ai-view-only-notice")).toHaveText(
      `You can view this chat. Ask ${VICTOR.name} for chat access to write.`,
    );
    await expect(sam.getByTestId("ai-chat-shared-by")).toHaveText(`Shared by ${VICTOR.name}`);
    await expect(sam.getByTestId("ai-chat-menu-button")).toHaveCount(0);
    await expect(sam.getByTestId("ai-regenerate-menu")).toHaveCount(0);
    await bothThemes(sam, `multiplayer-view-only-${w}`);

    // Alex (Can chat) starts on his own default model (his plan's GPT-6 Astra), never Víctor's last one.
    const alex = grantee.page;
    await alex.goto(`${BASE_URL}/chat/ai/${chatId}`);
    const chip = alex.getByTestId("ai-model-chip");
    await expect(chip).toContainText("GPT-6 Astra");
    await expect(chip).not.toContainText("Luna");
    await expect(alex.getByTestId("ai-chat-shared-by")).toHaveText(`Shared by ${VICTOR.name}`);
    // He picks the harness mock model for this chat; it answers him by name and the chip keeps it.
    await chip.click();
    const picker = alex.getByTestId("ai-model-picker");
    await expect(picker).toBeVisible();
    await picker.getByTestId(`ai-model-${MOCK_KEY}`).click();
    await expect(picker).toBeHidden();
    await expect(chip).toContainText("Mock (E2E)");
    await sendAi(alex, "Is the mock fine?");
    expect(await answerAt(alex, 2)).toBe(
      `Hi ${ALEX.name}! (participants: ${ALEX.name}, ${SAM.name}, ${VICTOR.name}) Echo: Is the mock fine?`,
    );
    await expect(lastAssistant(alex).getByTestId("ai-message-footer")).toContainText("Mock (E2E)");
    await expect(chip).toContainText("Mock (E2E)");

    // The owner's dialog on a phone: a bottom sheet that scrolls to the whole disclosure, Share within reach.
    const page = owner.page;
    await page.goto(`${BASE_URL}/chat/ai/${chatId}`);
    await expect(page.getByTestId("ai-chat-shared-by")).toHaveCount(0);
    const dialog = await openShareDialog(page);
    const people = dialog.getByTestId("ai-share-people");
    await expect(people.getByTestId("ai-share-grant")).toHaveCount(2);
    await expect(people.getByTestId("ai-share-grant").filter({ hasText: SAM.name })).toContainText(
      "Can view",
    );
    if (mobile) {
      const box = await dialog.boundingBox();
      expect(box, "dialog box").toBeTruthy();
      const viewport = page.viewportSize();
      expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(viewport?.height);
    }
    await expect(people.getByTestId("ai-share-submit")).toBeInViewport();
    await people.getByTestId("ai-share-billing").scrollIntoViewIfNeeded();
    await expect(people.getByTestId("ai-share-disclosure")).toBeInViewport({ ratio: 1 });
    await bothThemes(page, `multiplayer-share-dialog-disclosure-${w}`);
  } finally {
    await viewer.context.close();
    await grantee.context.close();
    await owner.context.close();
    await victor.dispose();
  }
});
