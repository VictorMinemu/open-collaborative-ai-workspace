import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, ensureMember, openAs } from "../support/actors";
import {
  answerText,
  chatIdOf,
  humanTurn,
  lastAssistant,
  openNewAiChat,
  sendAi,
  shareWith,
  VICTOR,
} from "../support/ai-chat";
import { ALEX } from "../support/chat";
import { ADMIN, shot } from "../tests/env";

/**
 * Acceptance Scenario B, steps 1–4 (PRD §110; step 5, the Work Zone, is MVP 2), on the compose stack an operator runs
 * (SELF-07, D-09, D-18): production images (NODE_ENV=production), behind Caddy on one HTTPS origin, realtime over
 * wss through the proxy. Víctor creates a private AI chat, shares it with Alex, both write in real time and the model
 * answers each of them by name. The model is the organization's mock (OCW_MODEL_PROVIDER=mock, the fake model in
 * compose.e2e.yaml): no ChatGPT plan seeding, no test-only API route (neither exists on a production image) and no
 * real provider. Members come from the admin through the public API (invite + accept).
 */

test.describe.configure({ mode: "serial" });

/** What people given access will see (P-13), checked in the share dialog before sharing. */
const DISCLOSURE = [
  "the whole conversation, including earlier messages and answers",
  "every attached file and artifact",
  "this chat's instructions (context)",
  "the model behind each answer",
  "who has access and at which level (permissions)",
  "the other participants",
];
const MOCK_LABEL = "Mock (E2E)";
/** The fake model's reply to a solo chat-completions prompt (infra/fake-model/server.mjs; the org mock's backend). */
const SOLO_REPLY = "Hi there! [tools: 0]";
const PARTICIPANTS = `(participants: ${ALEX.name}, ${VICTOR.name})`;

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

let admin: APIRequestContext;

test.beforeAll(async () => {
  admin = await apiAs(ADMIN);
  await ensureMember(admin, VICTOR, "admin");
  await ensureMember(admin, ALEX, "developer");
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

/** The answer once `turns` assistant turns exist and the latest one completed. */
async function answerAt(page: Page, turns: number): Promise<string> {
  await expect(page.locator('[data-testid="ai-message"][data-role="assistant"]')).toHaveCount(turns, {
    timeout: 30_000,
  });
  const answer = lastAssistant(page);
  await expect(answer).toHaveAttribute("data-status", "completed", { timeout: 30_000 });
  return answerText(answer);
}

/** Marks the document; `stillSameDocument` proves later updates arrived without a reload or navigation. */
async function markDocument(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __scenarioB?: boolean }).__scenarioB = true;
  });
}
async function stillSameDocument(page: Page) {
  return page.evaluate(() => (window as unknown as { __scenarioB?: boolean }).__scenarioB === true);
}

test("Scenario B 1–4 through Caddy: Víctor shares a private AI chat with Alex, both write live, the model tells them apart", async ({
  browser,
  baseURL,
}, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const w = widthOf(project);
  expect(baseURL, "the gate runs the stack behind the HTTPS proxy").toMatch(/^https:\/\//);
  const owner = await openAs(browser, VICTOR, project);
  const grantee = await openAs(browser, ALEX, project);
  try {
    // 1. Víctor's private chat on the organization's mock model, answered to him alone.
    const page = owner.page;
    await openNewAiChat(page);
    await expect(page.getByTestId("ai-model-chip")).toContainText(MOCK_LABEL);
    await sendAi(page, "Propose an architecture");
    await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/);
    expect(await answerAt(page, 1)).toBe(SOLO_REPLY);
    await expect(lastAssistant(page).getByTestId("ai-message-footer")).toContainText(MOCK_LABEL);
    const chatId = chatIdOf(page);
    await shot(page, `scenario-b-1-private-chat-${w}`);

    // 2. Share → what becomes visible, then Alex with Can chat. Read-only links are never public.
    const dialog = await openShareDialog(page);
    const people = dialog.getByTestId("ai-share-people");
    const disclosure = people.getByTestId("ai-share-disclosure");
    for (const item of DISCLOSURE) await expect(disclosure).toContainText(item);
    await expect(dialog.getByTestId("ai-share-audience")).toContainText("It is never public.");
    await shareWith(page, ALEX.name, "Can chat");
    await shot(page, `scenario-b-2-share-dialog-${w}`);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // 3. Alex finds it under "Shared with me" (the sidebar sheet at 390), with the owner's name, and opens it.
    const alex = grantee.page;
    if (mobile) await alex.getByTestId("mobile-nav-trigger").click();
    const shared = alex.getByTestId("sidebar-ai-shared").filter({ visible: true }).first();
    const row = shared.locator(`[data-testid="sidebar-ai-shared-chat"][data-chat-id="${chatId}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(VICTOR.name);
    await shot(alex, `scenario-b-3-shared-with-me-${w}`);
    await row.click();
    await expect(alex).toHaveURL(new RegExp(`/chat/ai/${chatId}$`, "u"));
    await expect(humanTurn(alex, VICTOR.name)).toContainText("Propose an architecture");

    // 4a. Both pages open on the chat: Alex writes and Víctor's page shows it live (WebSocket through Caddy, no
    // reload), then the model answers Alex by name, with both participants, on both pages.
    await markDocument(page);
    await sendAi(alex, "But we need multi-tenancy");
    await expect(humanTurn(page, ALEX.name)).toContainText("But we need multi-tenancy", { timeout: 30_000 });
    const toAlex = `Hi ${ALEX.name}! ${PARTICIPANTS} Echo: But we need multi-tenancy`;
    expect(await answerAt(alex, 2)).toBe(toAlex);
    expect(await answerAt(page, 2)).toBe(toAlex);
    expect(await stillSameDocument(page), "Víctor's page was updated in place").toBe(true);
    await shot(page, `scenario-b-4-alex-live-on-victors-page-${w}`);

    // 4b. Víctor writes: the answer is addressed to him, and Alex sees it live.
    await markDocument(alex);
    await sendAi(page, "What about cost?");
    const toVictor = `Hi ${VICTOR.name}! ${PARTICIPANTS} Echo: What about cost?`;
    expect(await answerAt(page, 3)).toBe(toVictor);
    expect(await answerAt(alex, 3)).toBe(toVictor);
    expect(await stillSameDocument(alex), "Alex's page was updated in place").toBe(true);
    await expect(humanTurn(alex, VICTOR.name)).toHaveCount(2);
    await expect(humanTurn(alex, ALEX.name)).toHaveCount(1);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
    await page.mouse.move(0, 0);
    await alex.mouse.move(0, 0);
    await shot(page, `scenario-b-5-answers-victor-${w}`);
    await shot(alex, `scenario-b-5-answers-alex-${w}`);
  } finally {
    await owner.context.close();
    await grantee.context.close();
  }
});
