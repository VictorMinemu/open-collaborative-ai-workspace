import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs } from "../support/actors";
import { addBot, waitBotReady } from "../support/automations";
import { cellToken } from "../support/cell-token";
import { ALEX, freshChannel, messageRow, postAs } from "../support/chat";
import {
  type ConsultReplyPayload,
  FakeCellPlugin,
  identityReply,
  type MentionPayload,
} from "../support/fake-cell-plugin";
import { ADMIN, API_URL } from "./env";

/**
 * 07.7-10 (A2A-01, A2A-03, D-01, D-04, P-14, C-03): a two-bot consult in the browser, against the real API with the fake
 * cell. Víctor asks Archie in #ops to check with Bea; the fake cell runs Archie's `ocw_consult_agent` (self-validated by
 * `POST /agent-channel/v1/consultations`), so Archie's question appears in the thread with the chip "Asked @bea for
 * Víctor" and a live status; Bea's answer carries "Answer to @archie"; Archie's final reply (its consult-reply turn)
 * follows in the same thread. Every turn reports done like the real bridge (`autoDone`). Setup turns the organization
 * switch "Bots may consult each other" on and restores it off; the bots it creates are deleted after.
 */

test.describe.configure({ mode: "serial" });

const BEA_ANSWER = "Yes, the pump order is confirmed. It ships Thursday.";
const FINAL = "Bea confirms the pump order: it ships Thursday.";

interface Bot {
  id: string;
  username: string;
}

let admin: APIRequestContext;
let alex: APIRequestContext;
let plugin: FakeCellPlugin;
let archie: Bot;
let bea: Bot;
let ops: { id: string; name: string };
const created: string[] = [];
/** Bots whose turns the fake cell leaves open (the spec answers them itself, or never: Stop). */
const held = new Set<string>();

async function setSwitch(enabled: boolean) {
  const res = await admin.put("/api/v1/agent-messaging", { data: { enabled } });
  expect(res.ok(), `PUT /agent-messaging ${enabled}: ${res.status()}`).toBe(true);
}

/** A fresh organization bot named `name` (an older one of the same name is deleted first), removed after the spec. */
async function freshBot(name: string): Promise<Bot> {
  const listed = (await (await admin.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; name: string }>;
  };
  for (const a of listed.agents.filter((x) => x.name === name)) {
    expect((await admin.delete(`/api/v1/agents/${a.id}`)).ok(), `delete ${name}`).toBe(true);
  }
  const res = await admin.post("/api/v1/agents", {
    data: {
      name,
      description: "Answers questions for the team.",
      instructions: "Answer briefly.",
      modelProvider: "mock",
      modelId: "mock-1",
    },
  });
  expect(res.ok(), `create team bot ${name}: ${res.status()}`).toBe(true);
  const bot = (await res.json()) as Bot;
  created.push(bot.id);
  return bot;
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  expect(cellToken(), "OCW_CELL_TOKEN is configured").not.toBe("");
  admin = await apiAs(ADMIN);
  await ensureMember(admin, ALEX, "developer");
  alex = await apiAs(ALEX);
  await setSwitch(true);
  plugin = new FakeCellPlugin({
    apiUrl: API_URL,
    token: cellToken(),
    autoAck: true,
    autoReply: true,
    autoDone: true,
    holdAgents: held,
    // Archie's return turn says what Bea answered; anything else answers with the identity reply.
    replyText: (m) => ((m as ConsultReplyPayload).consultReply ? FINAL : identityReply(m)),
  });
  await plugin.start();
  archie = await freshBot("Archie");
  bea = await freshBot("Bea");
  await waitBotReady(admin, archie.id);
  await waitBotReady(admin, bea.id);
  ops = await freshChannel(admin, [alex], "ops");
  await addBot(admin, ops.id, archie.id);
  await addBot(admin, ops.id, bea.id);
});

test.afterAll(async () => {
  await plugin?.stop();
  if (admin) {
    await setSwitch(false);
    for (const id of created.splice(0)) await admin.delete(`/api/v1/agents/${id}`);
    await admin.dispose();
  }
  await alex?.dispose();
});

/** Víctor asks Archie (a structured mention) to consult Bea; the root message's id. */
async function askArchie(question: string): Promise<string> {
  const body = `@${archie.username} check with Bea [[call ocw_consult_agent {"target":"@${bea.username}","question":"${question}"}]]`;
  const root = await postAs(admin, ops.id, body, { mentions: [{ kind: "agent", id: archie.id }] });
  return root.id;
}

/** Bea's turn for the question Archie asked under `rootId` (delivered with `origin`). */
async function beaTurn(rootId: string): Promise<MentionPayload> {
  const ev = await plugin.waitFor((e) => {
    if (e.type !== "agent.mention.v1") return false;
    const m = e.data as unknown as MentionPayload;
    return m.agent.id === bea.id && m.thread.rootMessageId === rootId && m.origin !== undefined;
  }, 20_000);
  return ev.data as unknown as MentionPayload;
}

/** The question Archie posted for the root's turn (the consult route's answer). */
async function questionOf(rootId: string): Promise<string> {
  const turn = await plugin.waitFor(
    (e) =>
      e.type === "agent.mention.v1" &&
      (e.data as unknown as MentionPayload).agent.id === archie.id &&
      (e.data as unknown as MentionPayload).message.id === rootId,
    20_000,
  );
  const eventId = (turn.data as unknown as MentionPayload).eventId;
  await plugin.waitUntil(() => plugin.consultRequests.some((r) => r.eventId === eventId), 20_000);
  const sent = plugin.consultRequests.find((r) => r.eventId === eventId);
  const body = sent?.body as { ok?: boolean; questionMessageId?: string } | undefined;
  expect(sent?.status, JSON.stringify(sent?.body)).toBe(200);
  expect(body?.ok).toBe(true);
  return body?.questionMessageId as string;
}

async function openThread(page: Page, rootId: string): Promise<Locator> {
  await page.goto(`${BASE_URL}/chat/${ops.id}?thread=${rootId}`);
  const panel = page.getByTestId("thread-panel");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  return panel;
}

const chipOf = (panel: Locator, messageId: string) =>
  messageRow(panel, messageId).getByTestId("consult-chip");

test("a two-bot consult in one thread: Archie's question with its live chip, Bea's answer, Archie's final reply", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  test.skip(
    info.project.name !== "desktop",
    "the tracer runs on desktop; 390 is covered with the review below",
  );
  held.add(bea.id);
  const rootId = await askArchie("Is the pump order confirmed?");
  const questionId = await questionOf(rootId);
  const bTurn = await beaTurn(rootId);

  const { context, page } = await openAs(browser, ADMIN, info.project.name);
  try {
    const panel = await openThread(page, rootId);
    // The question: Archie's message `@bea Is the pump order confirmed?`, its chip under the author line.
    const question = messageRow(panel, questionId);
    await expect(question).toContainText(`@${bea.username} Is the pump order confirmed?`);
    const chip = chipOf(panel, questionId);
    await expect(chip).toHaveAttribute("data-role", "question");
    await expect(chip).toContainText(`Asked @${bea.username} for ${ADMIN.name}`);
    await expect(chip.getByTestId("consult-status")).toHaveText("Waiting…");

    // Bea answers (in reply to the question, for her turn) and reports done: the status turns Answered, live.
    held.delete(bea.id);
    const answer = await plugin.reply(bTurn, BEA_ANSWER);
    await plugin.turnDone(bTurn, "replied");
    await expect(chip.getByTestId("consult-status")).toHaveText("Answered", { timeout: 20_000 });
    await expect(chip).toHaveAttribute("data-status", "answered");
    const answerChip = chipOf(panel, answer.messageId);
    await expect(answerChip).toHaveAttribute("data-role", "answer");
    await expect(answerChip).toHaveText(`Answer to @${archie.username}`);
    await expect(answerChip.getByTestId("consult-status")).toHaveCount(0);

    // Archie's final reply (its consult-reply turn) follows Bea's answer in the same thread, without a chip.
    const final = panel.getByTestId("message").filter({ hasText: FINAL });
    await expect(final).toHaveCount(1, { timeout: 20_000 });
    await expect(final.getByTestId("consult-chip")).toHaveCount(0);
    const ids = await panel
      .getByTestId("message")
      .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-message-id")));
    const finalId = await final.getAttribute("data-message-id");
    expect(ids.indexOf(questionId)).toBeGreaterThan(ids.indexOf(rootId));
    expect(ids.indexOf(answer.messageId)).toBeGreaterThan(ids.indexOf(questionId));
    expect(ids.indexOf(finalId)).toBeGreaterThan(ids.indexOf(answer.messageId));
    // Every chain turn reported done, like the real bridge: Archie's two turns and Bea's one.
    const doneBy = (id: string) =>
      plugin.doneReports.filter((d) => d.status === 200 && d.agentId === id).length;
    await expect.poll(() => [doneBy(archie.id), doneBy(bea.id)]).toEqual([2, 1]);
  } finally {
    await context.close();
  }
});
