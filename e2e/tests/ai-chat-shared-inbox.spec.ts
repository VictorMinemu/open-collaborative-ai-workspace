import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs } from "../support/actors";
import { seedPlan, VICTOR } from "../support/ai-chat";
import { ALEX } from "../support/chat";
import { ADMIN, shot } from "./env";

/**
 * MULTI-01 / MULTI-02 (06-08): shared AI chats live where people look. Víctor shares a chat with Alex by name: Alex's
 * inbox says "Víctor Ruiz shared “<title>” with you" and opens the chat; under "Shared with me" the chat shows an
 * unread badge when Víctor writes, and the badge clears once Alex opened the chat. Everything runs on the isolated
 * harness with the fake ChatGPT plan (P-12).
 */

test.describe.configure({ mode: "serial" });

const FAKE_URL = process.env.OCW_E2E_FAKE_URL ?? "";
const PLAN = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

async function bothThemes(page: Page, name: string) {
  await page.mouse.move(0, 0);
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

let admin: APIRequestContext;
let victorApi: APIRequestContext;
let alexApi: APIRequestContext;
let alexId: string;

test.beforeAll(async () => {
  test.skip(!FAKE_URL, "OCW_E2E_FAKE_URL is not set (the fake model is not running)");
  admin = await apiAs(ADMIN);
  await ensureMember(admin, VICTOR, "admin");
  alexId = await ensureMember(admin, ALEX, "developer");
  victorApi = await apiAs(VICTOR);
  alexApi = await apiAs(ALEX);
  for (const api of [victorApi, alexApi]) {
    await seedPlan(api);
    await api.post("/api/v1/me/model-credentials/chatgpt/welcome-seen", { data: {} });
  }
});

test.afterAll(async () => {
  await alexApi?.dispose();
  await victorApi?.dispose();
  await admin?.dispose();
});

/** Víctor's new chat, answered and auto-titled on his (fake) plan: its id and final title. */
async function victorsChat(first: string): Promise<{ chatId: string; title: string }> {
  const res = await victorApi.post("/api/v1/ai-chats", {
    data: { clientMessageId: randomUUID(), body: first, model: PLAN },
  });
  expect(res.status(), "create chat").toBe(201);
  const chatId = ((await res.json()) as { chat: { id: string } }).chat.id;
  let title = "";
  await expect
    .poll(
      async () => {
        const snap = (await (await victorApi.get(`/api/v1/ai-chats/${chatId}`)).json()) as {
          chat: { title: string; titleSource: string; generating: boolean };
        };
        title = snap.chat.title;
        return `${snap.chat.titleSource}:${snap.chat.generating}`;
      },
      { timeout: 20_000 },
    )
    .toBe("auto:false");
  return { chatId, title };
}

async function victorWrites(chatId: string, body: string) {
  const res = await victorApi.post(`/api/v1/ai-chats/${chatId}/messages`, {
    data: { clientMessageId: randomUUID(), body, model: PLAN, askAi: false },
  });
  expect(res.status(), `send "${body}"`).toBe(202);
}

/** Alex's "Shared with me" row of the chat (inside the navigation sheet at 390). */
async function sharedRow(page: Page, mobile: boolean, chatId: string): Promise<Locator> {
  if (mobile) await page.getByTestId("mobile-nav-trigger").click();
  const shared = page.getByTestId("sidebar-ai-shared").filter({ visible: true }).first();
  const row = shared.locator(`[data-testid="sidebar-ai-shared-chat"][data-chat-id="${chatId}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  return row;
}

test("a direct share reaches Alex's inbox; Shared with me counts Víctor's messages until Alex opens the chat", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const w = widthOf(project);
  // The auto title keeps the first words: unique per project and run, so both projects' items never collide.
  const tag = `${project === "mobile" ? "Mobile" : "Desktop"}-${randomUUID().slice(0, 4)}`;
  const { chatId, title } = await victorsChat(`${tag} ledger review for this quarter`);
  const grant = await victorApi.post(`/api/v1/ai-chats/${chatId}/grants`, {
    data: { subject: { kind: "user", id: alexId }, level: "chat" },
  });
  expect(grant.status(), "grant Alex").toBe(201);

  const alex = await openAs(browser, ALEX, project);
  const page = alex.page;
  try {
    // 1. The inbox (Mentions, the default view) names Víctor and the chat.
    await page.goto(`${BASE_URL}/chat/mentions`);
    const item = page
      .getByTestId("inbox-item")
      .and(page.locator('[data-kind="ai_chat_shared"]'))
      .filter({ hasText: title });
    await expect(item).toHaveCount(1, { timeout: 15_000 });
    await expect(item.getByTestId("inbox-actor")).toHaveText(VICTOR.name);
    await expect(item).toContainText(`${VICTOR.name} shared “${title}” with you`);
    await expect(item).toHaveAttribute("data-unread", "true");
    await bothThemes(page, `shared-inbox-${w}`);

    // 2. Opening it lands in the chat.
    await item.click();
    await expect(page).toHaveURL(new RegExp(`/chat/ai/${chatId}$`, "u"));
    await expect(page.getByTestId("ai-message").first()).toBeVisible();

    // 3. Away from the chat, Víctor writes twice: the Shared with me row counts both, live.
    await page.goto(`${BASE_URL}/chat/mentions`);
    await expect(item).toBeVisible();
    await victorWrites(chatId, "Numbers are in the sheet");
    await victorWrites(chatId, "Can you double-check Q3?");
    let row = await sharedRow(page, mobile, chatId);
    const badge = row.getByTestId("unread-badge");
    await expect(badge).toHaveAttribute("data-count", "2", { timeout: 15_000 });
    await expect(row).toHaveAttribute("data-unread", "true");
    await bothThemes(page, `shared-sidebar-unread-${w}`);

    // 4. Alex opens the chat: the badge clears (the server's cursor too), and stays cleared after leaving it.
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/chat/ai/${chatId}$`, "u"));
    await expect(
      page.getByTestId("ai-message").filter({ hasText: "Can you double-check Q3?" }),
    ).toBeVisible();
    await expect
      .poll(
        async () => {
          const list = (await (await alexApi.get("/api/v1/ai-chats?scope=shared")).json()) as {
            chats: Array<{ id: string; unreadCount?: number }>;
          };
          return list.chats.find((c) => c.id === chatId)?.unreadCount;
        },
        { timeout: 10_000 },
      )
      .toBe(0);
    await page.goto(`${BASE_URL}/chat/mentions`);
    // The read marker also read the share notification (it covers the notice line).
    await expect(item).not.toHaveAttribute("data-unread", "true");
    row = await sharedRow(page, mobile, chatId);
    await expect(row.getByTestId("unread-badge")).toHaveCount(0);
    await expect(row).not.toHaveAttribute("data-unread", "true");
  } finally {
    await alex.context.close();
  }
});
