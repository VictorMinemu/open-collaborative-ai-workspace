import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs } from "../support/actors";
import {
  answerText,
  chatIdOf,
  humanTurn,
  lastAssistant,
  openNewAiChat,
  seedPlan,
  sendAi,
  sendAiAs,
  shareWith,
  VICTOR,
} from "../support/ai-chat";
import { cellToken } from "../support/cell-token";
import { FakeCellPlugin, identityReply, type MentionPayload } from "../support/fake-cell-plugin";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Phase 6 gate (06-16, MULTI-08, P-12, P-13): one working day of a multiplayer AI chat on a fresh isolated stack,
 * crossing every Phase 6 slice. Víctor (personal instructions on) writes in a private chat and gets an answer; shares
 * it with Alex from the dialog (what becomes visible is stated first); Alex writes and the model answers "Hi Alex …"
 * with the participant list (Acceptance Scenario B 1–4). Víctor shares it with the Backend team at Can view: Riley
 * reads, never writes. While Víctor's slow answer streams, Alex and Víctor both ask: both wait in the visible queue,
 * then one coalesced answer names both and is billed to Alex (the first waiting). Víctor adds the persona @backend;
 * Alex @mentions it; the fake OpenClaw cell replies and posts an approval card; Alex approves it after a confirmation;
 * every page sees each step live, and Riley (Can view) is never offered Approve. Fresh colleagues per project (the
 * day's queue, roster and card are theirs alone). Only the harness fakes; no real provider (P-12).
 */

test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 20_000 });

const FAKE_URL = process.env.OCW_E2E_FAKE_URL ?? "";

/** The day's colleagues, one pair per project. */
const castFor = (project: string): { alex: Actor; riley: Actor } =>
  project === "mobile"
    ? {
        alex: { name: "Alex Navarro", email: "alex-day-m@ocw.test", password: "alex-day-password-123" },
        riley: { name: "Riley Ortega", email: "riley-team-m@ocw.test", password: "riley-day-password-123" },
      }
    : {
        alex: { name: "Alex Moreno", email: "alex-day@ocw.test", password: "alex-day-password-123" },
        riley: { name: "Riley Santos", email: "riley-team@ocw.test", password: "riley-day-password-123" },
      };

const PERSONAL_NOTE =
  "Your personal instructions stop being used in this chat from now on. Earlier answers may reflect them.";
const DISCLOSURE_FIRST = "the whole conversation, including earlier messages and answers";

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

async function bothThemes(page: Page, name: string) {
  await page.mouse.move(0, 0);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

async function ensureUnit(admin: APIRequestContext, kind: string, name: string, parentId: string | null) {
  const list = (await (await admin.get("/api/v1/units")).json()) as {
    units: Array<{ id: string; name: string; parentId: string | null }>;
  };
  const found = list.units.find((u) => u.name === name && u.parentId === parentId);
  if (found) return found.id;
  const res = await admin.post("/api/v1/units", { data: { kind, name, parentId } });
  expect(res.ok(), `create unit ${name}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
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

async function openShareDialog(page: Page): Promise<Locator> {
  await page.getByTestId("ai-chat-menu-button").click();
  await page.getByTestId("ai-chat-menu-share").filter({ visible: true }).click();
  const dialog = page.getByTestId("ai-share-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openParticipants(page: Page): Promise<Locator> {
  await page.getByTestId("ai-chat-header").getByTestId("ai-chat-audience").click();
  const list = page.getByTestId("ai-chat-participants-list").filter({ visible: true });
  await expect(list).toBeVisible();
  return list;
}

const assistants = (page: Page) => page.locator('[data-testid="ai-message"][data-role="assistant"]');
const personaTurns = (page: Page) => page.locator('[data-testid="ai-message"][data-role="persona"]');
const cardOf = (page: Page, messageId: string) =>
  page
    .locator(`[data-testid="ai-message"][data-message-id="${messageId}"]`)
    .first()
    .getByTestId("agent-card");

/** The answer after `turns` assistant turns exist, once it completed. */
async function answerAt(page: Page, turns: number, timeout = 20_000): Promise<string> {
  await expect(assistants(page)).toHaveCount(turns, { timeout });
  const answer = lastAssistant(page);
  await expect(answer).toHaveAttribute("data-status", "completed", { timeout });
  return answerText(answer);
}

const approvalCard = {
  kind: "approval",
  title: "Publish the launch checklist",
  fields: [
    { label: "Owner", value: "Platform team" },
    { label: "Items", value: "12 checks" },
  ],
  status: "pending",
  actions: [
    { kind: "open", label: "Open", target: "/chat/ai" },
    { kind: "follow", label: "Follow" },
    { kind: "approve", label: "Approve", denyLabel: "Deny" },
  ],
  summary: "Approve publishing the launch checklist?",
};

test("a Phase 6 day: private → shared with Alex → the Backend team reads → queue and coalesced answer → persona card approved", async ({
  browser,
}, info) => {
  test.setTimeout(420_000);
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");
  test.skip(!FAKE_URL, "OCW_E2E_FAKE_URL is not set (the fake model is not running)");
  const project = info.project.name;
  const mobile = project === "mobile";
  const w = widthOf(project);
  const { alex: ALEX, riley: RILEY } = castFor(project);
  const alexFirst = ALEX.name.split(" ")[0];

  // ---- the organization: fresh colleagues, the Backend team, plans connected (fake), Víctor's instructions on
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, VICTOR, "admin");
  await ensureMember(admin, ALEX, "developer");
  const rileyId = await ensureMember(admin, RILEY, "developer");
  const engineering = await ensureUnit(admin, "department", "Engineering", null);
  const backendUnit = await ensureUnit(admin, "team", "Backend", engineering);
  const joined = await admin.post(`/api/v1/units/${backendUnit}/members`, {
    data: { userId: rileyId, role: "member" },
  });
  expect(joined.ok() || joined.status() === 409, "Riley in Backend").toBe(true);
  for (const actor of [VICTOR, ALEX, RILEY]) {
    const api = await apiAs(actor);
    await seedPlan(api);
    await api.post("/api/v1/me/model-credentials/chatgpt/welcome-seen", { data: {} });
    await api.dispose();
  }
  const victorApi = await apiAs(VICTOR);
  const alexApi = await apiAs(ALEX);
  const rileyApi = await apiAs(RILEY);
  const prefs = (await (await victorApi.get("/api/v1/me/ai-preferences")).json()) as { instructions: string };
  const instructions = await victorApi.put("/api/v1/me/ai-preferences", {
    data: { instructions: "Sign every answer as the platform lead." },
  });
  expect(instructions.ok(), "Víctor's personal instructions").toBe(true);

  const cell = new FakeCellPlugin({ apiUrl: API_URL, token, autoAck: true });
  await cell.start();
  let backendId: string | null = null;
  const owner = await openAs(browser, VICTOR, project);
  const guest = await openAs(browser, ALEX, project);
  const reader = await openAs(browser, RILEY, project);
  try {
    backendId = await freshBackend(admin);
    const page = owner.page;
    const alex = guest.page;
    const riley = reader.page;
    const topic = randomUUID().slice(0, 6);

    // ---- 1. Víctor's private chat, answered on his own plan (solo: Phase 5 behaviour)
    await openNewAiChat(page);
    await sendAi(page, `Plan the Q4 launch ${topic}`);
    await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/);
    expect(await answerAt(page, 1)).toBe(`Echo: Plan the Q4 launch ${topic}`);
    const chatId = chatIdOf(page);
    await expect(page.getByTestId("ai-ask-toggle")).toHaveCount(0);
    await shot(page, `day-private-${w}`);

    // ---- 2. Share with Alex: the dialog says what becomes visible, and that his own instructions stop
    let dialog = await openShareDialog(page);
    let people = dialog.getByTestId("ai-share-people");
    const disclosure = people.getByTestId("ai-share-disclosure");
    await expect(disclosure).toContainText(DISCLOSURE_FIRST);
    await expect(disclosure).toContainText(PERSONAL_NOTE);
    await shareWith(page, ALEX.name, "Can chat");
    await bothThemes(page, `day-share-${w}`);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // ---- 3–4. Alex opens it and writes; the model answers him by name, live on both pages (Scenario B 1–4)
    await alex.goto(`${BASE_URL}/chat/ai/${chatId}`);
    await expect(humanTurn(alex, VICTOR.name)).toContainText(`Plan the Q4 launch ${topic}`);
    await expect(alex.getByTestId("ai-chat-shared-by")).toHaveText(`Shared by ${VICTOR.name}`);
    await sendAi(alex, "We need multi-tenancy from day one");
    const toAlex = `Hi ${ALEX.name}! (participants: ${[ALEX.name, VICTOR.name].sort((a, b) => a.localeCompare(b)).join(", ")}) Echo: We need multi-tenancy from day one`;
    expect(await answerAt(alex, 2)).toBe(toAlex);
    await expect(humanTurn(page, ALEX.name)).toContainText("We need multi-tenancy from day one");
    expect(await answerAt(page, 2)).toBe(toAlex);
    await bothThemes(page, `day-two-people-${w}`);

    // ---- 5. Víctor shares it with the Backend team at Can view: Riley reads, never writes
    dialog = await openShareDialog(page);
    people = dialog.getByTestId("ai-share-people");
    await people.getByTestId("ai-share-person-input").fill("Backend");
    await people
      .getByTestId("ai-share-person-option")
      .filter({ hasText: "Backend" })
      .and(page.locator('[data-subject-kind="unit"]'))
      .first()
      .click();
    await people.getByRole("radio", { name: "Can view" }).click();
    await people.getByTestId("ai-share-submit").click();
    await expect(people.getByTestId("ai-share-grant").filter({ hasText: "Backend" })).toContainText(
      "Can view",
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("ai-chat-header").getByTestId("ai-chat-audience")).toBeVisible();

    await riley.goto(`${BASE_URL}/chat/ai/${chatId}`);
    await expect(humanTurn(riley, ALEX.name)).toContainText("We need multi-tenancy from day one");
    await expect(riley.getByTestId("ai-view-only-notice")).toHaveText(
      `You can view this chat. Ask ${VICTOR.name} for chat access to write.`,
    );
    await expect(riley.getByTestId("ai-composer")).toHaveCount(0);
    await expect(riley.getByTestId("ai-chat-menu-button")).toHaveCount(0);
    // Riley's presence reaches Víctor's header: every page is subscribed before the queue starts.
    await expect(
      page
        .getByTestId("ai-chat-header")
        .locator(`[data-testid="presence-avatar"][data-user-id="${rileyId}"]`),
    ).toBeVisible({ timeout: 15_000 });
    await bothThemes(riley, `day-team-view-${w}-riley`);

    // ---- 6. Víctor's slow answer streams; Alex and Víctor both ask; both wait in the visible queue
    await sendAiAs(page, "Kick off the launch [[slow:12]]", { askAi: true });
    await expect(assistants(page)).toHaveCount(3, { timeout: 15_000 });
    await expect(lastAssistant(page)).toHaveAttribute("data-status", "streaming");
    for (const p of [page, alex, riley]) {
      await expect(p.getByTestId("ai-queue-text")).toContainText(`AI is answering ${VICTOR.name}`);
    }
    await sendAi(alex, "And security?");
    await expect(humanTurn(page, ALEX.name).last().getByTestId("ai-addressing")).toHaveText("Queued");
    await sendAi(page, "And the budget?");
    const next = `AI is answering ${VICTOR.name} · ${ALEX.name} and ${VICTOR.name} are next`;
    for (const p of [page, alex, riley]) await expect(p.getByTestId("ai-queue-text")).toHaveText(next);
    await bothThemes(alex, `day-queue-${w}-alex`);

    // ---- 7. One coalesced answer names both and is billed to Alex, the first waiting author (D-01)
    const coalesced = new RegExp(
      `^Hi ${ALEX.name} and ${VICTOR.name}! \\(participants: [^)]*\\) Echo: And the budget\\?$`,
      "u",
    );
    for (const p of [page, alex, riley]) {
      await expect(assistants(p)).toHaveCount(4, { timeout: 40_000 });
      await expect(lastAssistant(p)).toHaveAttribute("data-status", "completed", { timeout: 20_000 });
      expect(await answerText(lastAssistant(p))).toMatch(coalesced);
      await expect(p.getByTestId("ai-queue-chip")).toHaveCount(0);
    }
    const footer = (p: Page) => lastAssistant(p).getByTestId("ai-message-footer");
    await expect(footer(page)).toContainText(`for ${ALEX.name} · ${alexFirst}'s ChatGPT plan`);
    await expect(footer(riley)).toContainText(`for ${ALEX.name} · ${alexFirst}'s ChatGPT plan`);
    await expect(footer(alex)).toContainText("for you · your ChatGPT plan");
    await bothThemes(page, `day-coalesced-${w}`);

    // ---- 8. Víctor adds the persona @backend from the participants list
    let list = await openParticipants(page);
    await list.getByTestId("ai-chat-add-agent").click();
    const addDialog = page.getByTestId("ai-add-agent-dialog");
    await expect(addDialog).toBeVisible();
    await addDialog.getByTestId("ai-add-agent-search").fill("back");
    await addDialog.getByTestId("ai-add-agent-option").filter({ hasText: "@backend" }).click();
    await addDialog.getByTestId("ai-add-agent-submit").click();
    await expect(addDialog).toBeHidden();
    const added = "Víctor Ruiz added @backend to this chat";
    for (const p of [page, alex, riley]) {
      await expect(p.getByTestId("ai-notice").filter({ hasText: added })).toBeVisible({ timeout: 15_000 });
    }
    list = await openParticipants(page);
    await expect(
      list.locator(`[data-testid="ai-chat-participant"][data-kind="agent"][data-id="${backendId}"]`),
    ).toContainText("@backend");
    await page.keyboard.press("Escape");

    // ---- 9. Alex @mentions it; the cell replies and posts an approval card, live on every page
    const composer = alex.getByTestId("ai-composer");
    await composer.click();
    await composer.pressSequentially("@back");
    await alex
      .locator('[data-testid="ai-mention-option"][data-kind="agent"]')
      .filter({ hasText: "backend" })
      .click();
    await composer.pressSequentially("prepare the launch checklist");
    await expect(alex.getByTestId("ai-ask-toggle")).toHaveAttribute("aria-pressed", "false");
    await composer.press("Enter");
    await expect(composer).toHaveValue("");
    const asked = (
      await cell.waitFor(
        (e) =>
          e.type === "agent.mention.v1" &&
          (e.data as unknown as MentionPayload).conversation.id === chatId &&
          (e.data as unknown as MentionPayload).message.text.includes("prepare the launch checklist"),
        15_000,
      )
    ).data as unknown as MentionPayload;
    expect(asked.conversation.kind).toBe("ai_chat");
    expect(asked.message.author.displayName).toBe(ALEX.name);
    expect(asked.turn?.memory ?? []).toEqual([]);
    await cell.reply(asked, `Checklist drafted. ${identityReply(asked)}`);
    const card = await cell.postCard({
      agentId: backendId,
      conversationId: chatId,
      threadRootId: null,
      idempotencyKey: `day-card-${randomUUID()}`,
      card: approvalCard,
    });
    for (const p of [page, alex, riley]) {
      await expect(personaTurns(p).filter({ hasText: "Checklist drafted." })).toHaveCount(1, {
        timeout: 15_000,
      });
      await expect(cardOf(p, card.messageId).getByTestId("agent-card-title")).toHaveText(
        "Publish the launch checklist",
        { timeout: 15_000 },
      );
    }
    // The chat model never answered a message that only addressed the persona.
    await expect(assistants(page)).toHaveCount(4);
    // Can view: Riley may follow, never decide.
    await expect(cardOf(riley, card.messageId).getByTestId("agent-card-follow")).toBeVisible({
      timeout: 10_000,
    });
    await expect(cardOf(riley, card.messageId).getByTestId("agent-card-approve")).toHaveCount(0);
    const forced = await rileyApi.post(`/api/v1/cards/${card.messageId}/decision`, {
      data: { outcome: "approved" },
    });
    expect(forced.status()).toBe(403);
    expect(((await forced.json()) as { error: { code: string } }).error.code).toBe("ai_chat_view_only");
    const alexCard = cardOf(alex, card.messageId);
    await expect(alexCard.getByTestId("agent-card-approve")).toHaveText("Approve", { timeout: 10_000 });
    await bothThemes(alex, `day-card-${w}-alex`);

    // ---- 10. Alex approves after a confirmation that names the card; everyone sees it; the persona hears it once
    await alexCard.getByTestId("agent-card-approve").click();
    const confirm = alex.getByTestId("agent-card-confirm");
    await expect(confirm.getByRole("heading")).toHaveText("Approve “Publish the launch checklist”?");
    await confirm.getByTestId("agent-card-confirm-submit").click();
    await expect(confirm).toBeHidden();
    for (const p of [alex, page, riley]) {
      const c = cardOf(p, card.messageId);
      await expect(c.getByTestId("agent-card-decision")).toHaveText(
        new RegExp(`Approved by ${ALEX.name}`, "u"),
        {
          timeout: 10_000,
        },
      );
      await expect(c.getByTestId("agent-card-approve")).toHaveCount(0);
    }
    const decided = await cell.waitFor(
      (e) =>
        e.type === "agent.card_action.v1" &&
        (e.data as { cardAction?: { messageId?: string } }).cardAction?.messageId === card.messageId,
    );
    expect((decided.data as unknown as { cardAction: { outcome: string } }).cardAction.outcome).toBe(
      "approved",
    );
    await bothThemes(page, `day-approved-${w}`);
    if (mobile) await shot(riley, `day-approved-${w}-riley`);

    // The whole day reads the same from the API: one owner, Alex on chat, the team on view, the persona.
    const participants = (await (await alexApi.get(`/api/v1/ai-chats/${chatId}/participants`)).json()) as {
      participants: Array<{ id: string; access: string }>;
      audience: string;
    };
    expect(participants.audience).toBe("units");
    expect(participants.participants.find((p) => p.id === backendId)?.access).toBe("agent");
    expect(participants.participants.find((p) => p.id === rileyId)?.access).toBe("view");
  } finally {
    await victorApi.put("/api/v1/me/ai-preferences", { data: { instructions: prefs.instructions } });
    if (backendId) await admin.delete(`/api/v1/agents/${backendId}`);
    await cell.stop();
    await owner.context.close();
    await guest.context.close();
    await reader.context.close();
    await victorApi.dispose();
    await alexApi.dispose();
    await rileyApi.dispose();
    await admin.dispose();
  }
});
