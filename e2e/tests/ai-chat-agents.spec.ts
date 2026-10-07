import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, userIdOf } from "../support/actors";
import { chatIdOf, lastAssistant, openNewAiChat, seedPlan, sendAi, VICTOR } from "../support/ai-chat";
import {
  cellToken,
  clearPlugins,
  ECHO,
  ensurePluginInstalled,
  FAKE_URL,
  PLUGIN_TOOLS,
} from "../support/bot-tools";
import { ALEX } from "../support/chat";
import {
  FakeCellPlugin,
  identityReply,
  type MentionPayload,
  parseCallDirectives,
  turnToolsSuffix,
} from "../support/fake-cell-plugin";
import { ADMIN, API_URL, shot } from "./env";

/**
 * AGENT-02 in AI chats, in the browser (06-12, D-07, P-10, P-13): Víctor adds the team persona @backend to his shared AI
 * chat from the participants list; Alex @mentions it from the composer's suggestions (Ask AI turns off), sees it typing,
 * and its reply arrives flat in the chat, with its name and Bot badge, on both pages; the chat's model never answers.
 * The persona holds a plugin tool Alex may not use (an explicit deny rule): asked by Alex, the tool is withheld, the
 * persona says it is not available for him and no tool call reaches the gate (agent ∩ triggering human, MULTI-05/06,
 * checker W3). Víctor removes @backend; Alex never sees owner controls. A fake OpenClaw cell speaks the Agent Channel
 * API; no OpenClaw container and no real provider (P-12).
 */

test.describe.configure({ mode: "serial" });
// A missing control fails in seconds, not at the test timeout.
test.use({ actionTimeout: 20_000 });

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

async function bothThemes(page: Page, name: string) {
  await page.mouse.move(0, 0);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** The team persona `@backend` on the never-metered mock model, recreated so it carries no state from earlier runs. */
async function freshBackend(admin: APIRequestContext): Promise<string> {
  const listed = (await (await admin.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; username: string }>;
  };
  for (const a of listed.agents.filter((x) => x.username === "backend")) {
    expect((await admin.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
  const res = await admin.post("/api/v1/agents", {
    data: {
      name: "Backend",
      username: "backend",
      description: "Knows the service schemas.",
      instructions: "Answer schema questions briefly.",
      modelProvider: "mock",
      modelId: "mock-1",
    },
  });
  expect(res.ok(), "create @backend").toBe(true);
  return ((await res.json()) as { id: string }).id;
}

/** Gives the persona the echo plugin's tool (from its own catalog). */
async function grantEcho(admin: APIRequestContext, agentId: string) {
  const view = (await (await admin.get(`/api/v1/agents/${agentId}/capabilities`)).json()) as {
    tools: Array<{ sourceKind: string; sourceId: string; tool: string }>;
  };
  const echo = view.tools.find((t) => t.tool === "ocw_echo");
  expect(echo, "ocw_echo in @backend's catalog").toBeTruthy();
  const res = await admin.patch(`/api/v1/agents/${agentId}/capabilities`, {
    data: { tools: [{ sourceKind: echo?.sourceKind, sourceId: echo?.sourceId, tool: "ocw_echo" }] },
  });
  expect(res.ok(), "grant ocw_echo").toBe(true);
}

/** The persona's turns in the open AI chat. */
const personaTurns = (page: Page): Locator => page.locator('[data-testid="ai-message"][data-role="persona"]');

async function openParticipants(page: Page): Promise<Locator> {
  await page.getByTestId("ai-chat-header").getByTestId("ai-chat-audience").click();
  const list = page.getByTestId("ai-chat-participants-list").filter({ visible: true });
  await expect(list).toBeVisible();
  return list;
}

test("Víctor adds @backend from the participants list; Alex's @mention gets its reply; a tool Alex lacks is refused", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");
  test.skip(!FAKE_URL, "OCW_E2E_FAKE_URL is not set (the fake model and ClawHub are not running)");
  const project = info.project.name;
  const w = widthOf(project);

  const admin = await apiAs(ADMIN);
  await ensureMember(admin, VICTOR, "admin");
  const alexId = await ensureMember(admin, ALEX, "developer");
  for (const actor of [VICTOR, ALEX]) {
    const api = await apiAs(actor);
    await seedPlan(api);
    await api.post("/api/v1/me/model-credentials/chatgpt/welcome-seen", { data: {} });
    await api.dispose();
  }
  // The cell answers by hand below (typing first, then the reply), and simulates the plugin installs.
  const cell = new FakeCellPlugin({
    apiUrl: API_URL,
    token,
    autoAck: true,
    pluginTools: PLUGIN_TOOLS,
    stepMs: 200,
  });
  await cell.start();
  const victorApi = await apiAs(VICTOR);
  let denyRule: string | null = null;
  let backendId: string | null = null;
  const owner = await openAs(browser, VICTOR, project);
  const guest = await openAs(browser, ALEX, project);
  try {
    // A clean plugin state first (an earlier run may have been cut mid-uninstall), as marketplace.spec does.
    await clearPlugins(admin, cell);
    await ensurePluginInstalled(admin, ECHO);
    backendId = await freshBackend(admin);
    await grantEcho(admin, backendId);
    // Victor's personal bot exists: it is never offered for an AI chat (Phase 3.1 D-01).
    const mine = (await (await victorApi.get("/api/v1/agents")).json()) as {
      agents: Array<{ name: string; scope: string; ownerUserId: string | null }>;
    };
    const victorId = await userIdOf(victorApi);
    let personalName = mine.agents.find((a) => a.scope === "personal" && a.ownerUserId === victorId)?.name;
    if (!personalName) {
      const res = await victorApi.post("/api/v1/agents/personal", { data: {} });
      expect(res.ok(), "Víctor's personal bot").toBe(true);
      personalName = ((await res.json()) as { agent: { name: string } }).agent.name;
    }

    // ---- Víctor's chat, shared with Alex (06-03); Alex has it open.
    const page = owner.page;
    await openNewAiChat(page);
    await sendAi(page, "Plan the invoices schema migration");
    await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/);
    await expect(lastAssistant(page)).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
    const chatId = chatIdOf(page);
    const shared = await victorApi.post(`/api/v1/ai-chats/${chatId}/grants`, {
      data: { subject: { kind: "user", id: alexId }, level: "chat" },
    });
    expect(shared.status(), "share with Alex").toBe(201);
    const alex = guest.page;
    await alex.goto(`${BASE_URL}/chat/ai/${chatId}`);
    await expect(alex.getByTestId("ai-composer")).toBeVisible();

    // ---- participants list → Add an agent → @backend (never a personal bot).
    let list = await openParticipants(page);
    await list.getByTestId("ai-chat-add-agent").click();
    const dialog = page.getByTestId("ai-add-agent-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("ai-add-agent-option").filter({ hasText: personalName })).toHaveCount(0);
    await dialog.getByTestId("ai-add-agent-search").fill("back");
    const option = dialog.getByTestId("ai-add-agent-option").filter({ hasText: "@backend" });
    await expect(option).toHaveCount(1);
    await option.click();
    await page.mouse.move(0, 0);
    await shot(page, `ai-chat-agent-add-${w}`);
    await dialog.getByTestId("ai-add-agent-submit").click();
    await expect(dialog).toBeHidden();
    const notice = "Víctor Ruiz added @backend to this chat";
    await expect(page.getByTestId("ai-notice").filter({ hasText: notice })).toBeVisible({ timeout: 15_000 });
    await expect(alex.getByTestId("ai-notice").filter({ hasText: notice })).toBeVisible({ timeout: 15_000 });
    list = await openParticipants(page);
    const agentRow = list.locator(
      `[data-testid="ai-chat-participant"][data-kind="agent"][data-id="${backendId}"]`,
    );
    await expect(agentRow).toContainText("@backend");
    await expect(agentRow.getByTestId("bot-badge")).toBeVisible();
    await page.keyboard.press("Escape");

    // Alex is not the owner: no add or remove controls.
    const alexList = await openParticipants(alex);
    await expect(
      alexList.locator(`[data-testid="ai-chat-participant"][data-id="${backendId}"]`),
    ).toBeVisible();
    await expect(alexList.getByTestId("ai-chat-add-agent")).toHaveCount(0);
    await expect(alexList.getByTestId("ai-chat-remove-agent")).toHaveCount(0);
    await alex.keyboard.press("Escape");

    // ---- Alex mentions @backend from the suggestions: Ask AI turns off; it types, then replies flat on both pages.
    const answersBefore = await page.locator('[data-testid="ai-message"][data-role="assistant"]').count();
    const composer = alex.getByTestId("ai-composer");
    await composer.click();
    await composer.pressSequentially("@back");
    const suggestion = alex.getByTestId("ai-mention-option").filter({ hasText: "@backend" });
    await expect(suggestion).toBeVisible();
    await expect(suggestion.getByTestId("bot-badge")).toBeVisible();
    await suggestion.click();
    await composer.pressSequentially("check the schema");
    await expect(alex.getByTestId("ai-ask-toggle")).toHaveAttribute("aria-pressed", "false");
    await composer.press("Enter");
    await expect(composer).toHaveValue("");

    const asked = (
      await cell.waitFor(
        (e) =>
          e.type === "agent.mention.v1" &&
          (e.data as unknown as MentionPayload).conversation.id === chatId &&
          (e.data as unknown as MentionPayload).message.text.includes("check the schema"),
        15_000,
      )
    ).data as unknown as MentionPayload;
    expect(asked.conversation.kind).toBe("ai_chat");
    expect(asked.message.author.displayName).toBe(ALEX.name);
    await cell.request("POST", "/typing", {
      agentId: backendId,
      conversationId: chatId,
      threadRootMessageId: null,
    });
    await expect(page.getByTestId("typing-indicator")).toContainText("Backend", { timeout: 10_000 });
    await expect(alex.getByTestId("typing-indicator")).toContainText("Backend", { timeout: 10_000 });
    await cell.reply(asked, `Schema looks fine. ${identityReply(asked)}${turnToolsSuffix(asked)}`);
    for (const p of [page, alex]) {
      const reply = personaTurns(p).filter({ hasText: "Schema looks fine." });
      await expect(reply).toHaveCount(1, { timeout: 15_000 });
      await expect(reply.getByTestId("ai-message-author")).toHaveText("Backend");
      await expect(reply.getByTestId("bot-badge")).toBeVisible();
      await expect(reply).toContainText(`Asked by ${ALEX.name}`);
    }
    // The chat's model never answered a message that only addressed a persona.
    await expect(page.locator('[data-testid="ai-message"][data-role="assistant"]')).toHaveCount(
      answersBefore,
    );
    await bothThemes(page, `ai-chat-agent-${w}`);
    await bothThemes(alex, `ai-chat-agent-${w}-alex`);

    // ---- W3: a tool @backend has but Alex may not use (deny rule) is withheld from Alex's turn and refused.
    const rule = await admin.post("/api/v1/permission-rules", {
      data: { subjectKind: "user", subjectId: alexId, permission: "bot.tool.use", effect: "deny" },
    });
    expect(rule.ok(), "deny bot.tool.use for Alex").toBe(true);
    denyRule = ((await rule.json()) as { id: string }).id;
    const toolAsk = alex.getByTestId("ai-composer");
    await toolAsk.fill('@backend echo it [[call ocw_echo {"text":"x"}]]');
    if (await alex.getByTestId("ai-mention-suggestions").isVisible()) await toolAsk.press("Escape");
    await toolAsk.press("Enter");
    const toolEv = (
      await cell.waitFor(
        (e) =>
          e.type === "agent.mention.v1" &&
          (e.data as unknown as MentionPayload).message.text.includes("[[call ocw_echo"),
        15_000,
      )
    ).data as unknown as MentionPayload;
    expect(toolEv.turn?.tools ?? []).not.toContain("ocw_echo");
    expect(toolEv.turn?.withheld).toEqual([{ tool: "ocw_echo", reason: "denied_for_you" }]);
    const lines = await cell.simulateToolCalls(toolEv, parseCallDirectives(toolEv.message.text));
    await cell.reply(toolEv, lines.join("\n") + turnToolsSuffix(toolEv));
    expect(cell.toolCallRequests.filter((c) => c.eventId === toolEv.eventId)).toHaveLength(0);
    const refused = `Tool ocw_echo: not available for ${ALEX.name} (denied_for_you)`;
    for (const p of [page, alex]) {
      await expect(personaTurns(p).filter({ hasText: refused })).toHaveCount(1, { timeout: 15_000 });
    }
    await expect(page.locator('[data-testid="ai-message"][data-role="assistant"]')).toHaveCount(
      answersBefore,
    );

    // ---- Víctor removes @backend from the list: gone for both.
    list = await openParticipants(page);
    await list.getByTestId("ai-chat-remove-agent").click();
    await list.getByTestId("ai-chat-remove-agent-confirm").click();
    await expect(list.locator(`[data-testid="ai-chat-participant"][data-id="${backendId}"]`)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(
      alex.getByTestId("ai-notice").filter({ hasText: "Víctor Ruiz removed @backend from this chat" }),
    ).toBeVisible({ timeout: 15_000 });
    const after = (await (await victorApi.get(`/api/v1/ai-chats/${chatId}/participants`)).json()) as {
      participants: Array<{ id: string }>;
    };
    expect(after.participants.some((p) => p.id === backendId)).toBe(false);
  } finally {
    if (denyRule) await admin.delete(`/api/v1/permission-rules/${denyRule}`);
    // Leave no persona behind (the plugin specs clear plugins themselves before they start).
    if (backendId) await admin.delete(`/api/v1/agents/${backendId}`);
    await cell.stop();
    await victorApi.dispose();
    await admin.dispose();
    await owner.context.close();
    await guest.context.close();
  }
});
