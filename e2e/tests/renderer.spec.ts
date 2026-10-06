import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, createChannel, ensureMember, openAs, SAM } from "../support/actors";
import { cellToken } from "../support/cell-token";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { ADMIN, API_URL, shot } from "./env";

/**
 * The shared Markdown renderer (04-02, D-05, CHAT-05): one component renders a channel message, a thread
 * reply, a bot's DM answer and a Work Zone answer. Every surface shows a fenced code block; the chat surfaces
 * also show the @mention chip (the DM and Work Zone views provide no mention directory today). Captures `renderer-<surface>-<1440|390>[-dark]` for the before/after review.
 */

const FENCE = "```";

const CHANNEL_BODY = [
  "Release checklist for @sam, please review:",
  "",
  `${FENCE}ts`,
  "export function greet(name: string): string {",
  '  const greeting = "Hello, " + name + "!";',
  "  return greeting.trim();",
  "}",
  FENCE,
  "",
  "| Step | Owner | Status |",
  "| --- | --- | --- |",
  "| Build | CI | done |",
  "| Ship | @sam | pending |",
  "",
  "- Tag the release",
  "- Publish the notes",
  "",
  "> Ship only after the smoke test passes.",
  "",
  "Docs: [release guide](https://example.com/release)",
].join("\n");

const THREAD_BODY = [
  "@sam the smoke test is green. Run it locally with:",
  "",
  `${FENCE}bash`,
  "pnpm install --frozen-lockfile",
  "pnpm verify",
  FENCE,
].join("\n");

const BOT_BODY = [
  "Here is the **status** you asked for:",
  "",
  "1. API deployed",
  "2. Web deployed",
  "",
  `${FENCE}json`,
  '{ "api": "ok", "web": "ok", "latencyMs": 42 }',
  FENCE,
  "",
  "| Service | State |",
  "| --- | --- |",
  "| api | ok |",
  "",
  "Anything else?",
].join("\n");

const WZ_PROMPT = [
  "Show the helper as a snippet",
  "",
  `${FENCE}ts`,
  "export function sum(values: number[]): number {",
  "  return values.reduce((total, value) => total + value, 0);",
  "}",
  "",
  "export function average(values: number[]): number {",
  "  if (values.length === 0) return 0;",
  "  return sum(values) / values.length;",
  "}",
  "",
  "export function clamp(value: number, min: number, max: number): number {",
  "  return Math.min(Math.max(value, min), max);",
  "}",
  FENCE,
].join("\n");

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

async function post(api: APIRequestContext, conversationId: string, body: string, threadRootId?: string) {
  const res = await api.post(`/api/v1/conversations/${conversationId}/messages`, {
    data: { body, ...(threadRootId ? { threadRootId } : {}) },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

/** A fenced block is visible and shiki has coloured at least one token (an inline --sdm-c colour). */
async function expectCode(scope: Locator) {
  await expect(scope.locator("pre code").first()).toBeVisible();
  await expect
    .poll(
      () =>
        scope
          .locator("pre code span[style]")
          .evaluateAll((els) => els.some((e) => /--sdm-c:\s*#/i.test(e.getAttribute("style") ?? ""))),
      { message: "shiki-highlighted tokens", timeout: 15_000 },
    )
    .toBe(true);
}

test.describe.configure({ mode: "serial" });

test("renderer: a channel message and a thread reply render through the shared Markdown", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const tag = mobile ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  const channelId = await createChannel(admin, `renderer-${project}-${Date.now().toString(36)}`);
  const rootId = await post(admin, channelId, CHANNEL_BODY);
  await post(admin, channelId, THREAD_BODY, rootId);

  const { context, page } = await openAs(browser, ADMIN, project);
  try {
    // ---- channel
    await page.goto(`${BASE_URL}/chat/${channelId}`);
    const root = page.getByTestId("message").filter({ hasText: "Release checklist for" });
    await expect(root).toBeVisible();
    await expectCode(root);
    await expect(root.locator("table")).toBeVisible();
    await expect(root.getByTestId("mention").first()).toHaveText("@sam");
    await expect(root.locator('a[href="https://example.com/release"]')).toHaveAttribute("rel", /nofollow/);
    await root.scrollIntoViewIfNeeded();
    await bothThemes(page, `renderer-chat-${tag}`);

    // ---- thread reply
    if (mobile) await root.getByTestId("thread-summary").click();
    else {
      await root.hover();
      await root.getByTestId("reply-in-thread").click();
    }
    const panel = page.getByTestId("thread-panel");
    await expect(panel).toBeVisible();
    const reply = panel.getByTestId("message").filter({ hasText: "smoke test is green" });
    await expect(reply).toBeVisible();
    await expectCode(reply);
    await expect(reply.getByTestId("mention").first()).toHaveText("@sam");
    await reply.scrollIntoViewIfNeeded();
    await bothThemes(page, `renderer-thread-${tag}`);
  } finally {
    await context.close();
    await admin.dispose();
  }
});

test("renderer: a bot's answer in its DM (agent output) renders through the shared Markdown", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const tag = project === "mobile" ? "390" : "1440";
  const token = cellToken();
  expect(token, "OCW_CELL_TOKEN is configured (the fake cell answers as the bot)").not.toBe("");
  const admin = await apiAs(ADMIN);
  const botName = `Renderer ${tag}`;
  const listed = (await (await admin.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; name: string }>;
  };
  for (const a of listed.agents.filter((x) => x.name === botName)) {
    expect((await admin.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
  const created = await admin.post("/api/v1/agents", {
    data: {
      name: botName,
      description: "Answers release status questions.",
      instructions: "Answer briefly.",
      modelProvider: "mock",
      modelId: "mock-1",
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const botId = ((await created.json()) as { id: string }).id;

  const plugin = new FakeCellPlugin({
    apiUrl: API_URL,
    token,
    autoAck: true,
    autoReply: true,
    replyText: () => BOT_BODY,
  });
  await plugin.start();
  const { context, page } = await openAs(browser, ADMIN, project);
  try {
    await expect
      .poll(
        async () =>
          ((await (await admin.get(`/api/v1/agents/${botId}`)).json()) as { status: string }).status,
      )
      .toBe("ready");
    const dm = await admin.post(`/api/v1/agents/${botId}/dm`, { data: {} });
    expect(dm.ok(), await dm.text()).toBe(true);
    const dmId = ((await dm.json()) as { dmId: string }).dmId;
    await post(admin, dmId, "status of the release?");
    await page.goto(`${BASE_URL}/chat/dm/${dmId}`);
    await expect(page.getByTestId("dm-view")).toBeVisible();
    const botMsg = page
      .locator('[data-testid="message"][data-author-kind="agent"]')
      .filter({ hasText: "you asked for" })
      .last();
    await expect(botMsg).toBeVisible({ timeout: 15_000 });
    await expectCode(botMsg);
    await expect(botMsg.locator("table")).toBeVisible();
    await botMsg.scrollIntoViewIfNeeded();
    await bothThemes(page, `renderer-dm-${tag}`);
  } finally {
    await plugin.stop();
    await context.close();
    await admin.delete(`/api/v1/agents/${botId}`);
    await admin.dispose();
  }
});

test("renderer: a Work Zone answer with a fenced block renders through the shared Markdown", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const tag = project === "mobile" ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  let device: FakeDeviceHandle | null = null;
  let sessionId: string | null = null;
  const { context, page } = await openAs(browser, ADMIN, project);
  try {
    device = await startFakeDevice(admin, {
      name: `E2E Renderer ${tag}`,
      projectName: `renderer-${tag}`,
      // Slow enough that the open fence stays on screen for a few seconds while the answer streams.
      env: { OCW_RUNTIME_FAKE_ECHO: "1", OCW_RUNTIME_FAKE_DELAY_MS: "600" },
    });
    // Plan mode: the fake never asks for approval; with ECHO it repeats the prompt (a fenced block) in its answer.
    const created = await admin.post("/api/v1/work-sessions", {
      data: {
        projectId: device.projectId,
        runtime: "claude-code",
        permissionMode: "plan",
        title: `Renderer ${tag}`,
        prompt: WZ_PROMPT,
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    sessionId = ((await created.json()) as { id: string }).id;

    await page.goto(`${BASE_URL}/work-zone/${sessionId}`);
    // While it streams, the unterminated fence already renders as a code block (never literal backticks).
    const live = page
      .locator('[data-testid="assistant-message"]:has([data-testid="streaming-caret"])')
      .last();
    await expect(live.locator('[data-streamdown="code-block"][data-incomplete="true"]')).toBeVisible({
      timeout: 30_000,
    });
    await expect(live).not.toContainText(FENCE);
    await shot(page, `renderer-workzone-streaming-${tag}`);
    await expect(page.getByTestId("session-view")).toHaveAttribute("data-status", "idle", {
      timeout: 30_000,
    });
    const answer = page.getByTestId("assistant-message").filter({ hasText: "Here is my plan" }).last();
    await expect(answer).toBeVisible();
    await expectCode(answer);
    await expect(answer.locator("pre")).toContainText("values.reduce");
    await answer.locator("pre").scrollIntoViewIfNeeded();
    await bothThemes(page, `renderer-workzone-${tag}`);
  } finally {
    if (sessionId) await admin.post(`/api/v1/work-sessions/${sessionId}/archive`, { data: {} });
    await device?.stop();
    await context.close();
    await admin.dispose();
  }
});
