import { type APIRequestContext, type Browser, expect, type Page, request, test } from "@playwright/test";
import { expectChannelLanding } from "../support/actors";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Chat (B1): two people in one channel see each other live, thread replies, @mention autocomplete and — when
 * the API runs with NODE_ENV=test — a simulated bot reply through the chat ↔ agent-channel bridge.
 */

const BASE_URL = process.env.OCW_E2E_BASE_URL ?? "http://localhost:3000";
const ALEX = { name: "Alex Kim", email: "alex@ocw.test", password: "alex-e2e-password-123" };

async function apiAs(user: { email: string; password: string }): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL: API_URL, extraHTTPHeaders: { origin: BASE_URL } });
  const res = await ctx.post("/api/auth/sign-in/email", {
    data: { email: user.email, password: user.password },
  });
  expect(res.ok(), `sign in ${user.email}`).toBe(true);
  return ctx;
}

/** Alex exists after the first run (invite + accept through the API). */
async function ensureAlex(admin: APIRequestContext) {
  const members = (await (await admin.get("/api/v1/members")).json()).members as Array<{ email: string }>;
  if (members.some((m) => m.email === ALEX.email)) return;
  const inv = await (
    await admin.post("/api/v1/invitations", { data: { email: ALEX.email, role: "developer" } })
  ).json();
  const anon = await request.newContext({ baseURL: API_URL, extraHTTPHeaders: { origin: BASE_URL } });
  const res = await anon.post(`/api/v1/invitations/${inv.id}/accept`, {
    data: { name: ALEX.name, password: ALEX.password },
  });
  expect(res.ok(), "accept invitation").toBe(true);
  await anon.dispose();
}

async function signIn(browser: Browser, user: { email: string; password: string }, project: string) {
  const mobile = project === "mobile";
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/login`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page
    .getByTestId("login-form")
    .getByRole("button", { name: /sign in|log in/i })
    .click();
  await expectChannelLanding(page);
  return page;
}

async function send(page: Page, text: string, testId = "composer") {
  const box = page.getByTestId(testId);
  await box.click();
  await box.fill(text);
  await box.press("Enter");
}

async function openThreadOf(page: Page, project: string, text: string) {
  const msg = page.getByTestId("message").filter({ hasText: text }).first();
  if (project === "mobile") {
    await msg.getByTestId("thread-summary").or(msg.locator("p").first()).first().click();
  } else {
    await msg.hover();
    await msg.getByTestId("reply-in-thread").click();
  }
  await expect(page.getByTestId("thread-panel")).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("chat: live messages, threads, mentions and a bot reply", async ({ browser }, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const tag = project === "mobile" ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  await ensureAlex(admin);
  const testRoutes = (await admin.get("/api/v1/test/chat/mentions")).status() === 200;
  const archie = testRoutes
    ? ((
        await (
          await admin.post("/api/v1/test/chat/agents", {
            data: { name: "Archie", username: "archie", avatarUrl: "🦉" },
          })
        ).json()
      ).id as string)
    : null;

  const a = await signIn(browser, ADMIN, project);
  const b = await signIn(browser, ALEX, project);

  // ---- A creates a channel through the UI
  const name = `launch-${project}-${Date.now().toString(36)}`;
  if (project === "mobile") {
    await a.getByTestId("mobile-nav-trigger").click();
  }
  await a.getByTestId("create-channel").filter({ visible: true }).first().click();
  await a.getByLabel("Name").fill(name);
  await a.getByLabel(/Topic/).fill("Investor demo prep");
  await a.getByTestId("create-channel-submit").click();
  await expect(a.getByTestId("channel-title")).toHaveText(name);
  const channelId = a.url().match(/\/chat\/([0-9a-f-]{36})/)?.[1];
  expect(channelId).toBeTruthy();

  // Bots are added to channels by members (the bots page does this once B2 ships /agents).
  if (archie) {
    const added = await admin.post(`/api/v1/channels/${channelId}/members`, {
      data: { kind: "agent", id: archie },
    });
    expect(added.ok()).toBe(true);
  }

  // ---- B joins from the preview banner
  await b.goto(`${BASE_URL}/chat/${channelId}`);
  await expect(b.getByTestId("join-banner")).toBeVisible();
  await b.getByTestId("join-channel").click();
  await expect(b.getByTestId("composer")).toBeVisible();

  // ---- live both ways
  await send(a, "Morning team! Demo is **tomorrow 9:00**. Checklist in this channel.");
  await expect(b.getByTestId("message").filter({ hasText: "Demo is tomorrow 9:00" })).toBeVisible();
  await send(b, "On it. I'll own the `#architecture` walkthrough.");
  await expect(a.getByTestId("message").filter({ hasText: "architecture walkthrough" })).toBeVisible();

  // ---- thread reply (B), live reply count + content for A
  await openThreadOf(b, project, "Demo is tomorrow 9:00");
  await send(b, "Can we rehearse at 8:30?", "thread-composer");
  await expect(
    b.getByTestId("thread-panel").getByTestId("message").filter({ hasText: "rehearse at 8:30" }),
  ).toBeVisible();
  const rootOnA = a.getByTestId("message").filter({ hasText: "Demo is tomorrow 9:00" });
  await expect(rootOnA.getByTestId("thread-summary")).toContainText("1 reply");
  await openThreadOf(a, project, "Demo is tomorrow 9:00");
  await expect(
    a.getByTestId("thread-panel").getByTestId("message").filter({ hasText: "rehearse at 8:30" }),
  ).toBeVisible();
  await expect(a.getByTestId("thread-reply-count")).toContainText("1 reply");

  // ---- mention autocomplete (bot when the test routes exist, otherwise a person)
  const handle = archie ? "archie" : "alex";
  const composer = a.getByTestId("thread-composer");
  await composer.click();
  await composer.pressSequentially(`@${handle.slice(0, 3)}`);
  const option = a
    .getByTestId("mention-option")
    .filter({ hasText: archie ? "Archie" : ALEX.name })
    .first();
  await expect(option).toBeVisible();
  if (archie) await expect(option.getByTestId("bot-badge")).toBeVisible();
  await shot(a, `chat-mention-${tag}`);
  await composer.press("Enter");
  await expect(composer).toHaveValue(`@${handle} `);
  await composer.pressSequentially("can you draft the run of show?");
  await composer.press("Enter");
  const mentionMsg = a
    .getByTestId("thread-panel")
    .getByTestId("message")
    .filter({ hasText: "draft the run of show" });
  await expect(mentionMsg.getByTestId("mention")).toHaveText(`@${handle}`);

  // ---- bot reply through the bridge (test-only routes; B2 adds the real OpenClaw E2E)
  if (archie) {
    const mentions = (await (await admin.get("/api/v1/test/chat/mentions")).json()).mentions as Array<{
      conversationId: string;
      threadRootId: string;
      messageId: string;
      agentIds: string[];
    }>;
    const mention = mentions.filter((m) => m.conversationId === channelId).at(-1);
    expect(mention?.agentIds).toEqual([archie]);
    await admin.post("/api/v1/test/chat/agent-typing", {
      data: { agentId: archie, conversationId: channelId, threadRootId: mention?.threadRootId },
    });
    await expect(b.getByTestId("thread-panel").getByTestId("typing-indicator")).toContainText(
      "Archie is typing",
    );
    await admin.post("/api/v1/test/chat/agent-reply", {
      data: {
        agentId: archie,
        conversationId: channelId,
        threadRootId: mention?.threadRootId,
        idempotencyKey: `e2e-${mention?.messageId}`,
        body: "Run of show, asked by **Víctor Ruiz**:\n\n1. Chat + bots (5 min)\n2. Work Zone live edit (10 min)\n3. Q&A\n\n```bash\npnpm dev\n```",
      },
    });
    for (const page of [a, b]) {
      const reply = page
        .getByTestId("thread-panel")
        .locator('[data-testid="message"][data-author-kind="agent"]');
      await expect(reply).toContainText("Run of show");
      await expect(reply.getByTestId("bot-badge")).toBeVisible();
    }
    await expect(rootOnA.getByTestId("thread-summary")).toContainText("3 replies");
  }

  // ---- screenshots: thread + channel, light + dark
  await a.waitForTimeout(300);
  await shot(a, `chat-thread-${tag}-light`);
  await a.emulateMedia({ colorScheme: "dark" });
  await shot(a, `chat-thread-${tag}-dark`);
  await a.getByTestId("close-thread").click();
  await expect(a.getByTestId("thread-panel")).toHaveCount(0);
  await shot(a, `chat-channel-${tag}-dark`);
  await a.emulateMedia({ colorScheme: "light" });
  await shot(a, `chat-channel-${tag}-light`);

  // ---- persistence: reload keeps order and the thread summary
  await b.reload();
  await expect(
    b.getByTestId("message").filter({ hasText: "Demo is tomorrow 9:00" }).getByTestId("thread-summary"),
  ).toBeVisible();

  await a.context().close();
  await b.context().close();
  await admin.dispose();
});
