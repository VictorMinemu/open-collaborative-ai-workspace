import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { seedPlan, VICTOR } from "../support/ai-chat";
import { cellToken } from "../support/cell-token";
import { ALEX, freshChannel, messageRow } from "../support/chat";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import { ADMIN, API_URL, shot } from "./env";

/**
 * 06-15 (AGENT-04, D-07, D-08, P-11, P-13): people see and use Agent Cards. The fake OpenClaw cell posts real cards
 * through the Agent Channel API (cell token); every open page renders the one card renderer, sees the agent's update
 * in place (no new message, no reload), follows it, and one person approves it after a confirmation that names it;
 * everyone sees the decision and the agent receives `agent.card_action.v1`. The same card renders identically in an
 * AI chat where @deploy is a persona; a "Can view" grantee there is never offered Approve (security fix). No model is
 * called for the cards (the AI chat's first turn runs on the fake ChatGPT plan).
 */

test.describe.configure({ mode: "serial" });

const FAKE_URL = process.env.OCW_E2E_FAKE_URL ?? "";
const BOT_NAME = "Deploy";
const PLAN = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

async function bothThemes(page: Page, name: string) {
  await page.mouse.move(0, 0);
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** The team bot @deploy on the never-metered mock model (created once; both projects share it). */
async function ensureDeployBot(admin: APIRequestContext): Promise<string> {
  const listed = (await (await admin.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; name: string; scope?: string }>;
  };
  const found = listed.agents.find((a) => a.name === BOT_NAME);
  if (found) return found.id;
  const res = await admin.post("/api/v1/agents", {
    data: {
      name: BOT_NAME,
      username: "deploy",
      description: "Ships releases and reports on them.",
      instructions: "Report deployments briefly.",
      modelProvider: "mock",
      modelId: "mock-1",
    },
  });
  expect(res.ok(), `create @deploy: ${res.status()}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

async function addBot(admin: APIRequestContext, channelId: string, agentId: string) {
  const res = await admin.post(`/api/v1/channels/${channelId}/members`, {
    data: { kind: "agent", id: agentId },
  });
  expect(res.ok(), `add @deploy: ${res.status()}`).toBe(true);
}

const deployCard = (over: Record<string, unknown> = {}) => ({
  kind: "deployment",
  title: "Deploy api v2.3",
  fields: [
    { label: "Environment", value: "production" },
    { label: "Commit", value: "abc123" },
    { label: "Requested by", value: "Víctor Ruiz" },
    { label: "Region", value: "eu-central" },
  ],
  status: "running",
  actions: [
    { kind: "open", label: "Open", target: "/work-zone" },
    { kind: "follow", label: "Follow" },
  ],
  summary: "Deploying api v2.3 to production",
  ...over,
});

const approvalCard = (over: Record<string, unknown> = {}) =>
  deployCard({
    kind: "approval",
    status: "pending",
    fields: [
      { label: "Environment", value: "production" },
      { label: "Change", value: "api v2.3 (12 commits)" },
    ],
    actions: [
      { kind: "open", label: "Open", target: "/work-zone" },
      { kind: "follow", label: "Follow" },
      { kind: "approve", label: "Approve", denyLabel: "Deny" },
    ],
    summary: "Approve the production deploy of api v2.3?",
    ...over,
  });

/**
 * Opens `pages` on the channel and waits until every page's socket is subscribed to it: each sees the others present
 * (the server only reports presence to subscribed sockets), so a card posted next arrives live on all of them.
 */
async function openChannel(pages: Array<{ page: Page; userId: string }>, channelId: string) {
  for (const { page } of pages) {
    await page.goto(`${BASE_URL}/chat/${channelId}`);
    await expect(page.getByTestId("composer")).toBeVisible();
  }
  for (const { page, userId: me } of pages) {
    for (const { userId } of pages) {
      if (userId === me) continue;
      await expect(
        page.getByTestId("channel-view").locator(`[data-testid="presence-avatar"][data-user-id="${userId}"]`),
      ).toHaveAttribute("data-state", "online", { timeout: 10_000 });
    }
  }
}

/** The Agent Card inside one conversation row (channel/DM message, or an AI chat persona turn). */
const cardIn = (row: Locator) => row.getByTestId("agent-card");
const aiRow = (page: Page, messageId: string) =>
  page.locator(`[data-testid="ai-message"][data-message-id="${messageId}"]`).first();

/** Waits until the AI chat's latest answer is done (the fake ChatGPT plan). */
async function settled(api: APIRequestContext, chatId: string) {
  await expect
    .poll(
      async () => {
        const snap = (await (await api.get(`/api/v1/ai-chats/${chatId}`)).json()) as {
          messages: Array<{ authorKind: string; authorId: string | null; status: string }>;
        };
        return snap.messages.filter((m) => m.authorKind === "agent" && m.authorId === null).at(-1)?.status;
      },
      { timeout: 15_000 },
    )
    .toBe("completed");
}

/** Víctor's AI chat with @deploy as a persona (06-10), Alex on "Can chat" and Sam on "Can view". */
async function aiChatWithDeploy(
  victor: APIRequestContext,
  agentId: string,
  people: { alexId: string; samId: string },
): Promise<string> {
  const created = await victor.post("/api/v1/ai-chats", {
    data: { clientMessageId: `cm-${randomUUID()}`, body: "Track the api release", model: PLAN },
  });
  expect(created.ok(), `create AI chat: ${created.status()}`).toBe(true);
  const chatId = ((await created.json()) as { chat: { id: string } }).chat.id;
  await settled(victor, chatId);
  const added = await victor.post(`/api/v1/ai-chats/${chatId}/agents`, { data: { agentId } });
  expect(added.ok(), `add persona: ${added.status()}`).toBe(true);
  for (const [userId, level] of [
    [people.alexId, "chat"],
    [people.samId, "view"],
  ] as const) {
    const res = await victor.post(`/api/v1/ai-chats/${chatId}/grants`, {
      data: { subject: { kind: "user", id: userId }, level },
    });
    expect(res.ok(), `grant ${level}: ${res.status()}`).toBe(true);
  }
  return chatId;
}

/** The visible content of a card, normalised (kind, status, title, fields): equal in a channel and an AI chat. */
async function contentOf(card: Locator): Promise<string> {
  const parts = await Promise.all([
    card.getByTestId("agent-card-kind").innerText(),
    card.getByTestId("agent-card-status").innerText(),
    card.getByTestId("agent-card-title").innerText(),
    card.getByTestId("agent-card-fields").innerText(),
  ]);
  return parts.map((p) => p.replace(/\s+/g, " ").trim()).join(" | ");
}

let admin: APIRequestContext;
let plugin: FakeCellPlugin;
let deployId: string;
let victorId: string;
let alexId: string;
let samId: string;

test.beforeAll(async () => {
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");
  test.skip(!FAKE_URL, "OCW_E2E_FAKE_URL is not set (the fake model is not running)");
  admin = await apiAs(ADMIN);
  victorId = await ensureMember(admin, VICTOR, "admin");
  alexId = await ensureMember(admin, ALEX, "developer");
  samId = await ensureMember(admin, SAM, "developer");
  const victor = await apiAs(VICTOR);
  await seedPlan(victor);
  await victor.post("/api/v1/me/model-credentials/chatgpt/welcome-seen", { data: {} });
  await victor.dispose();
  deployId = await ensureDeployBot(admin);
  plugin = new FakeCellPlugin({ apiUrl: API_URL, token, autoAck: true });
  await plugin.start();
});

test.afterAll(async () => {
  await plugin?.stop();
  await admin?.dispose();
});

test("@deploy's card appears in a channel and goes from Running to Succeeded in place on every open page; the same card renders identically in an AI chat", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const w = widthOf(project);
  const victorApi = await apiAs(VICTOR);
  const alexApi = await apiAs(ALEX);
  const channel = await freshChannel(victorApi, [alexApi], "backend");
  await addBot(victorApi, channel.id, deployId);

  const v = await openAs(browser, VICTOR, project);
  const a = await openAs(browser, ALEX, project);
  try {
    await openChannel(
      [
        { page: v.page, userId: victorId },
        { page: a.page, userId: alexId },
      ],
      channel.id,
    );

    // ---- the fake cell posts a running deployment card: both pages show it under @deploy's name
    const posted = await plugin.postCard({
      agentId: deployId,
      conversationId: channel.id,
      threadRootId: null,
      idempotencyKey: `e2e-card-${randomUUID()}`,
      card: deployCard(),
    });
    expect(posted.version).toBe(1);
    for (const p of [v.page, a.page]) {
      const row = messageRow(p, posted.messageId);
      await expect(row).toBeVisible({ timeout: 10_000 });
      await expect(row).toHaveAttribute("data-author-kind", "agent");
      await expect(row.getByTestId("message-author")).toHaveText(BOT_NAME);
      await expect(row.getByTestId("bot-badge")).toBeVisible();
      const card = cardIn(row);
      await expect(card).toHaveAttribute("data-kind", "deployment");
      await expect(card.getByTestId("agent-card-kind")).toHaveText("Deployment");
      await expect(card.getByTestId("agent-card-title")).toHaveText("Deploy api v2.3");
      await expect(card.getByRole("status", { name: "Status: Running" })).toBeVisible();
      await expect(card.getByTestId("agent-card-fields")).toContainText("Environment");
      await expect(card.getByTestId("agent-card-fields")).toContainText("production");
      await expect(card.getByTestId("agent-card-open")).toHaveAttribute("href", "/work-zone");
      // Arrived live (no viewer fields on realtime): the page reads them, so Follow appears.
      await expect(card.getByTestId("agent-card-follow")).toHaveText("Follow");
      await expect(card.getByTestId("agent-card-approve")).toHaveCount(0);
      // The summary is the card's description for screen readers, not a second visible body.
      await expect(row.getByText("Deploying api v2.3 to production")).toHaveCount(1);
      await expect(row.getByText("Deploying api v2.3 to production")).toHaveClass(/sr-only/);
    }
    await bothThemes(v.page, `agent-card-running-${w}`);

    // ---- the agent patches it to succeeded: the same card changes in place, no new message, no reload
    const counts = await Promise.all([v.page, a.page].map((p) => p.getByTestId("message").count()));
    for (const p of [v.page, a.page]) await p.evaluate(() => Object.assign(window, { __sameDocument: true }));
    const patched = await plugin.patchCard(posted.messageId, {
      agentId: deployId,
      patch: { expectedVersion: 1, status: "succeeded" },
    });
    expect(patched.version).toBe(2);
    for (const [i, p] of [v.page, a.page].entries()) {
      const card = cardIn(messageRow(p, posted.messageId));
      await expect(card.getByRole("status", { name: "Status: Succeeded" })).toBeVisible({ timeout: 5_000 });
      await expect(card).toHaveAttribute("data-version", "2");
      await expect(p.getByTestId("message")).toHaveCount(counts[i] as number);
      await expect(p.getByTestId("agent-card")).toHaveCount(1);
      expect(await p.evaluate(() => (window as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
    }
    await shot(v.page, `agent-card-succeeded-${w}`);
    const inChannel = await contentOf(cardIn(messageRow(v.page, posted.messageId)));

    // ---- the same card posted by @deploy as a persona of Víctor's AI chat renders identically
    const chatId = await aiChatWithDeploy(victorApi, deployId, { alexId, samId });
    await v.page.goto(`${BASE_URL}/chat/ai/${chatId}`);
    await expect(v.page.getByTestId("ai-composer")).toBeVisible();
    const inAi = await plugin.postCard({
      agentId: deployId,
      conversationId: chatId,
      threadRootId: null,
      idempotencyKey: `e2e-card-${randomUUID()}`,
      card: deployCard({ status: "succeeded" }),
    });
    const turn = aiRow(v.page, inAi.messageId);
    await expect(turn).toBeVisible({ timeout: 10_000 });
    await expect(turn).toHaveAttribute("data-role", "persona");
    await expect(turn.getByTestId("ai-message-author")).toHaveText(BOT_NAME);
    const aiCard = cardIn(turn);
    await expect(aiCard.getByTestId("agent-card-follow")).toBeVisible();
    expect(await contentOf(aiCard)).toBe(inChannel);
    await expect(aiCard.getByTestId("agent-card-open")).toHaveAttribute("href", "/work-zone");
    await expect(turn.getByText("Deploying api v2.3 to production")).toHaveClass(/sr-only/);
    await bothThemes(v.page, `agent-card-ai-chat-${w}`);
  } finally {
    await v.context.close();
    await a.context.close();
    await victorApi.dispose();
    await alexApi.dispose();
  }
});
