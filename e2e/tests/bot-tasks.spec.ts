import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { BotPolicyView } from "../../packages/contracts/src/bot-capabilities.ts";
import { taskStopNotice, taskStopSentence } from "../../packages/contracts/src/bot-tasks.ts";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs } from "../support/actors";
import { addBot, waitBotReady } from "../support/automations";
import { readNote, readPack, TASK_CARD, taskCardRow, taskCards, taskDirectives } from "../support/bot-tasks";
import { cellToken } from "../support/cell-token";
import { freshChannel, postAs } from "../support/chat";
import {
  type FakeCellEvent,
  FakeCellPlugin,
  type MentionPayload,
  TASK_EVENT,
  type TaskEventPayload,
} from "../support/fake-cell-plugin";
import { captureReview, expectNoSidewaysScroll, expectTouchTargets } from "../support/layout";
import { ADMIN, API_URL } from "./env";

/**
 * 07.17.1.1.2-13 (BTASK-02, BTASK-03, BTASK-07 … BTASK-10; D-02, D-04, D-05, D-11, D-14, PD-20, PD-24): a bot keeps
 * working on a request over several turns by itself, visible on one live card, bounded and stoppable, end to end in the
 * browser with the fake cell (e2e/support/fake-cell-plugin.ts: no model, no provider; the API schedules every turn).
 *
 *   1. Settings › Bot policy (the admin): the "Long tasks" row and its three limits; "Turns per task" set to 4 in the
 *      form, saved, and still 4 after a reload. axe in light and dark.
 *   2. Ana asks the bot for a long job in her thread: the start turn starts the task and continues ("Read 1 of 4"); the
 *      fake cell continues every `agent.task.v1` turn ("Read n of 4"). One task card updates in place, Turn 1 → 2 → 3 →
 *      4 of 4, its progress line changes, the quiet turns 2 and 3 post nothing, and at the budget the card says Stopped
 *      ("Stopped: it used its 4 turns.") with exactly one bot message mentioning Ana. Nobody re-prompts it; Ben writes
 *      in the thread while turn 2 runs (no mention), and the task still reaches its fourth turn by itself (a person's
 *      message never pauses a task, PD-25). The ended card keeps its last progress and hides the next step.
 *   3. A second task waits on a 10-minute timer: Ben, a member, sees the card without Stop; Ana presses Stop, the card
 *      turns Stopped ("Stopped by Ana Gil."), and no further turn arrives.
 *   4. axe on the thread with the card in light and dark, no sideways scroll; on phones Stop is 44 px tall and the card
 *      never overflows sideways.
 * The org's long-task limits are put back afterwards and the spec's bot is removed. Serial: a retry starts fresh threads,
 * so every count below is scoped to this attempt's thread.
 */

test.describe.configure({ mode: "serial" });

/** Fake credentials, built at runtime (never a literal secret in the source). */
const pw = (who: string) => [who, "tasks", "e2e", "pw", String(2026)].join("-");
const ANA: Actor = { name: "Ana Gil", email: "ana-tasks@ocw.test", password: pw("ana") };
const BEN: Actor = { name: "Ben Ortiz", email: "ben-tasks@ocw.test", password: pw("ben") };
/** `userHandle()` of Ana (the email's local part): the platform's stop message mentions her by it. */
const ANA_HANDLE = "ana-tasks";

const GOAL = "Summarise the onboarding pack";
const SLOW_GOAL = "Summarise the handbook";
const PARTS = 4;
const MAX_TURNS = 4;
const THREAD = '[data-testid="thread-panel"]';
/** Four turns with the API's 5 s gap between them, plus job and realtime latency on a loaded CI agent. */
const JOURNEY_MS = 150_000;

let mobile = false;
let w = "1440";
let admin: APIRequestContext;
let anaApi: APIRequestContext;
let benApi: APIRequestContext;
let cell: FakeCellPlugin;
let bot: { id: string; name: string; username: string };
let channel: { id: string; name: string };
let tasksBefore: BotPolicyView["tasks"] | null = null;
const createdBots: string[] = [];
/** Tasks whose every continue waits 10 minutes (the second task: it is stopped while it waits). */
const slowTasks = new Set<string>();

/** A fresh organization bot named `name` (an older one of that name is deleted first), removed after the spec. */
async function freshTeamBot(name: string): Promise<{ id: string; name: string; username: string }> {
  const listed = (await (await admin.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; name: string }>;
  };
  for (const a of listed.agents.filter((x) => x.name === name)) {
    expect((await admin.delete(`/api/v1/agents/${a.id}`)).ok(), `delete ${name}`).toBe(true);
  }
  const res = await admin.post("/api/v1/agents", {
    data: {
      name,
      description: "Reads long documents and summarises them.",
      instructions: "Answer briefly.",
      modelProvider: "mock",
      modelId: "mock-1",
    },
  });
  expect(res.ok(), `create team bot ${name}: ${res.status()}`).toBe(true);
  const created = (await res.json()) as { id: string; name: string; username: string };
  createdBots.push(created.id);
  return created;
}

/** The organization's long-task limits (`GET /api/v1/bot-policy`). */
async function taskLimits(): Promise<BotPolicyView["tasks"]> {
  const res = await admin.get("/api/v1/bot-policy");
  expect(res.ok(), "GET /api/v1/bot-policy").toBe(true);
  return BotPolicyView.parse(await res.json()).tasks;
}

async function putTaskLimits(tasks: Partial<BotPolicyView["tasks"]>): Promise<void> {
  const res = await admin.put("/api/v1/bot-policy", { data: { tasks } });
  expect(res.ok(), `PUT /api/v1/bot-policy tasks: ${res.status()}`).toBe(true);
}

/** Opens the thread of `rootId` directly (on phones the thread covers the channel and its nav). */
async function openThread(page: Page, rootId: string): Promise<Locator> {
  await page.goto(`${BASE_URL}/chat/${channel.id}?thread=${rootId}`);
  const panel = page.locator(THREAD).first();
  await expect(panel).toBeVisible({ timeout: 15_000 });
  return panel;
}

/** Ana's top-level message that roots the task's thread (the card lands in the asker's message thread, PD-11). */
async function newThread(text: string): Promise<string> {
  return (await postAs(anaApi, channel.id, text)).id;
}

/** The task the start turn of Ana's mention `messageId` started (the fake cell's /tasks/start answer). */
async function startedTask(messageId: string): Promise<string> {
  let taskId = "";
  await cell.waitUntil(() => {
    const turn = cell.events.find(
      (e) => e.type === "agent.mention.v1" && turnOf(e).message?.id === messageId,
    );
    const start = turn
      ? cell.taskRequests.find((r) => r.eventId === turnOf(turn).eventId && r.tool === "ocw_task_start")
      : undefined;
    if (start?.body?.ok === true && typeof start.body.taskId === "string") taskId = start.body.taskId;
    return taskId !== "";
  }, 30_000);
  return taskId;
}

/** axe in light and dark on `selector`, no sideways scroll in either theme, 44 px targets under `touch` on phones. */
async function checkScreen(page: Page, name: string, selector: string, touch: Array<string | Locator> = []) {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expectNoSeriousA11y(page, selector);
    await expectNoSidewaysScroll(page, `${name} ${w} (${theme})`);
  }
  await page.emulateMedia({ colorScheme: "light" });
  for (const root of touch) await expectTouchTargets(page, root);
}

/** The card never scrolls sideways inside itself (a long goal or note wraps). */
async function expectCardFits(card: Locator) {
  const { scroll, client } = await card.evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }));
  expect(scroll, "the task card has no horizontal overflow").toBeLessThanOrEqual(client + 1);
}

/** A cell event's payload as a turn (mentions and task turns share the mention's shape; only task turns carry `task`). */
const turnOf = (e: FakeCellEvent) =>
  e.data as unknown as MentionPayload & Partial<Pick<TaskEventPayload, "task">>;

/** The bot's messages in `scope` (the card itself is one of them). */
const botMessages = (scope: Locator) => scope.locator('[data-testid="message"][data-author-kind="agent"]');

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixtures argument before testInfo
test.beforeAll(async ({}, info) => {
  test.setTimeout(120_000);
  mobile = info.project.name === "mobile";
  w = mobile ? "390" : "1440";
  const token = cellToken();
  expect(token, "OCW_CELL_TOKEN is configured").not.toBe("");
  admin = await apiAs(ADMIN);
  await ensureMember(admin, ANA, "developer");
  await ensureMember(admin, BEN, "developer");
  anaApi = await apiAs(ANA);
  benApi = await apiAs(BEN);

  // The org's limits go back in afterAll. Start from the defaults' 40 turns (so the form's 4 is a change) and room for
  // the tasks an earlier, interrupted attempt may have left running.
  tasksBefore = await taskLimits();
  await putTaskLimits({ maxTurns: 40, maxHours: 8, maxRunning: 100 });

  cell = new FakeCellPlugin({
    apiUrl: API_URL,
    token,
    autoAck: true,
    autoReply: true,
    autoDone: true,
    taskCallsFor: (event, ctx) =>
      readPack(slowTasks.has(event.task.taskId) ? { of: PARTS, afterSeconds: 600 } : { of: PARTS })(
        event,
        ctx,
      ),
  });
  await cell.start();

  bot = await freshTeamBot(mobile ? "Reader m" : "Reader");
  await waitBotReady(admin, bot.id);
  channel = await freshChannel(admin, [anaApi, benApi], "tasks");
  await addBot(admin, channel.id, bot.id);
});

test.afterAll(async () => {
  await cell?.stop();
  if (admin) {
    for (const id of createdBots.splice(0)) await admin.delete(`/api/v1/agents/${id}`).catch(() => undefined);
    if (tasksBefore) await putTaskLimits(tasksBefore).catch(() => undefined);
  }
  await anaApi?.dispose();
  await benApi?.dispose();
  await admin?.dispose();
});

// ---------------------------------------------------------------- 1. the limits (D-04, PD-20)

test("Settings › Bot policy: the Long tasks row and its three limits; Turns per task saved as 4", async ({
  browser,
}, info) => {
  test.setTimeout(90_000);
  const s = await openAs(browser, ADMIN, info.project.name);
  try {
    await s.page.goto(`${BASE_URL}/settings/bot-policy`);
    const policy = s.page.getByTestId("bot-policy-settings");
    await expect(policy).toBeVisible({ timeout: 15_000 });
    const row = policy.getByTestId("policy-row-longTasks");
    await expect(row).toContainText("Long tasks");
    await expect(row).toContainText("Bots keep working on long requests by themselves");
    await expect(policy.getByTestId("policy-longTasks-orgWide")).toBeChecked();

    const turns = policy.getByTestId("policy-task-max-turns");
    await expect(turns).toHaveValue("40");
    await expect(policy.getByTestId("policy-task-max-hours")).toHaveValue("8");
    await expect(policy.getByTestId("policy-task-max-running")).toBeVisible();
    await expect(s.page.getByLabel("Turns per task")).toHaveAttribute("data-testid", "policy-task-max-turns");
    await expect(s.page.getByLabel("Hours per task")).toHaveAttribute("data-testid", "policy-task-max-hours");
    await expect(s.page.getByLabel("Tasks running at once")).toHaveAttribute(
      "data-testid",
      "policy-task-max-running",
    );
    if (mobile) {
      const box = await turns.boundingBox();
      expect(box?.height ?? 0, "the limit fields are 44 px tall on phones").toBeGreaterThanOrEqual(43.5);
    }

    // An invalid value says why and turns Save off; 4 is saved.
    await turns.fill("0");
    await expect(policy).toContainText("Enter a whole number from 1 to 200.");
    await expect(policy.getByTestId("bot-policy-save")).toBeDisabled();
    await turns.fill(String(MAX_TURNS));
    await policy.getByTestId("policy-task-max-turns").blur();
    await policy.getByTestId("bot-policy-save").click();
    await expect(s.page.getByText("Bot policy saved")).toBeVisible({ timeout: 15_000 });
    await expect(policy.getByTestId("bot-policy-save")).toBeDisabled();
    await expect.poll(async () => (await taskLimits()).maxTurns, { timeout: 10_000 }).toBe(MAX_TURNS);

    await s.page.reload();
    await expect(s.page.getByTestId("policy-task-max-turns")).toHaveValue(String(MAX_TURNS), {
      timeout: 15_000,
    });
    await s.page.getByTestId("policy-row-longTasks").scrollIntoViewIfNeeded();
    await checkScreen(s.page, "bot-policy-long-tasks", '[data-testid="bot-policy-settings"]');
    await captureReview(s.page, `07171112-policy-${w}`);
  } finally {
    await s.context.close();
  }
});

// ---------------------------------------------------------------- 2. four turns by itself, stopped at its budget

test("Ana's long job: one card goes Turn 1 → 4 of 4 by itself, quiet turns post nothing, Ben's message never pauses it, and the budget stops it with one mention", async ({
  browser,
}, info) => {
  test.setTimeout(JOURNEY_MS + 90_000);
  // The limits test of this attempt saved 4 turns; a run of this test alone sets them here.
  if ((await taskLimits()).maxTurns !== MAX_TURNS) await putTaskLimits({ maxTurns: MAX_TURNS });
  const rootId = await newThread("I need the onboarding pack summarised for the new hires.");
  const ana = await openAs(browser, ANA, info.project.name);
  try {
    const panel = await openThread(ana.page, rootId);
    const ask = await postAs(
      anaApi,
      channel.id,
      `@${bot.username} please summarise the whole pack ${taskDirectives(GOAL, { of: PARTS })}`,
      { threadRootId: rootId },
    );
    const taskId = await startedTask(ask.id);
    const card = taskCards(panel).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId("agent-card-title")).toContainText(GOAL);
    const cardId = await taskCardRow(panel, taskId).getAttribute("data-message-id");
    expect(cardId, "the task card's message").toBeTruthy();

    // Watch the one card update in place until the budget stops it, recording every meter and progress value. Ben
    // writes in the thread (no mention) as soon as the second turn shows.
    const turnsSeen: string[] = [];
    const progressSeen: string[] = [];
    const cardIds = new Set<string>();
    const cardCounts = new Set<number>();
    let benMessageId = "";
    const push = (list: string[], value: string | undefined) => {
      const v = value?.trim();
      if (v && list.at(-1) !== v) list.push(v);
    };
    await expect
      .poll(
        async () => {
          cardCounts.add(await panel.locator(TASK_CARD).count());
          push(turnsSeen, (await card.getByTestId("task-turns").allTextContents())[0]);
          push(progressSeen, (await card.getByTestId("task-progress").allTextContents())[0]);
          const ids = await panel
            .locator(`[data-testid="message"]:has([data-task-id="${taskId}"])`)
            .evaluateAll((els) => els.map((el) => el.getAttribute("data-message-id") ?? ""));
          for (const id of ids) cardIds.add(id);
          if (!benMessageId && turnsSeen.at(-1) === `Turn 2 of ${MAX_TURNS}`) {
            benMessageId = (
              await postAs(benApi, channel.id, "Ben here: I will add the glossary afterwards.", {
                threadRootId: rootId,
              })
            ).id;
          }
          return (await card.getByTestId("agent-card-status").allTextContents())[0]?.trim() ?? "";
        },
        { timeout: JOURNEY_MS, intervals: [400], message: "the task runs its four turns and stops" },
      )
      .toBe("Stopped");

    // One card, updated in place, through every turn; its notes moved with it.
    expect(turnsSeen).toEqual([1, 2, 3, 4].map((n) => `Turn ${n} of ${MAX_TURNS}`));
    expect(progressSeen).toEqual([1, 2, 3].map((n) => readNote(n, PARTS)));
    expect([...cardCounts]).toEqual([1]);
    expect([...cardIds]).toEqual([cardId]);
    await expect(card.getByTestId("task-turns")).toHaveAttribute("aria-valuenow", String(MAX_TURNS));
    await expect(card.getByTestId("agent-card-notice").first()).toHaveText(
      taskStopNotice("budget_turns", { maxTurns: MAX_TURNS, maxHours: 8 }) as string,
    );
    // An ended card keeps its last progress note and has no next step any more; nobody can stop it now.
    await expect(card.getByTestId("task-progress")).toHaveText(readNote(3, PARTS));
    await expect(card.getByTestId("task-next")).toHaveCount(0);
    await expect(card.getByTestId("task-stop")).toHaveCount(0);

    // Ben's message is in the thread, and the task went on past it by itself.
    expect(benMessageId, "Ben wrote while the task ran").not.toBe("");
    await expect(panel.locator(`[data-message-id="${benMessageId}"]`).first()).toBeVisible();

    // The platform scheduled turns 2 to 4; the quiet turns 2 and 3 posted nothing, the fourth said its continue was
    // refused at the budget. No person mentioned the bot again in this thread (Ana never re-prompted it).
    const turns = cell.taskTurns.filter((t) => t.taskId === taskId);
    expect(turns.map((t) => [t.turn, t.posted])).toEqual([
      [2, false],
      [3, false],
      [4, true],
    ]);
    expect(turns.at(-1)?.lines).toEqual(["Tool ocw_task_continue: refused (budget_turns)"]);
    const mentions = cell.events.filter(
      (e) =>
        e.type === "agent.mention.v1" &&
        turnOf(e).agent?.id === bot.id &&
        (turnOf(e).thread?.rootMessageId === rootId || turnOf(e).message?.id === rootId),
    );
    expect(mentions, "one mention of the bot in this thread: Ana's ask").toHaveLength(1);
    expect(
      cell.events.filter((e) => e.type === TASK_EVENT && turnOf(e).task?.taskId === taskId),
      "three platform turns",
    ).toHaveLength(MAX_TURNS - 1);

    // In the browser: one visible continue (the start turn), and exactly one bot message mentioning Ana: the stop.
    const sentence = taskStopSentence("budget_turns", { maxTurns: MAX_TURNS, maxHours: 8 }) as string;
    const bots = botMessages(panel);
    await expect(bots.filter({ hasText: sentence })).toHaveCount(1, { timeout: 15_000 });
    await expect(bots.filter({ hasText: "Tool ocw_task_continue: continued" })).toHaveCount(1);
    const mentioning = bots.filter({
      has: ana.page.getByTestId("mention").filter({ hasText: `@${ANA_HANDLE}` }),
    });
    await expect(mentioning).toHaveCount(1);
    await expect(mentioning.first()).toContainText(sentence);

    await card.scrollIntoViewIfNeeded();
    await expectCardFits(card);
    await checkScreen(ana.page, "task-card-stopped", THREAD);
    await captureReview(ana.page, `07171112-task-budget-${w}`);
  } finally {
    await ana.context.close();
  }
});

// ---------------------------------------------------------------- 3. Stop from the card (D-05, PD-12)

test("a waiting task: Ben sees the card without Stop; Ana stops it from the card and no further turn arrives", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  if ((await taskLimits()).maxTurns !== MAX_TURNS) await putTaskLimits({ maxTurns: MAX_TURNS });
  const rootId = await newThread("And the employee handbook, when you can.");
  const ana = await openAs(browser, ANA, info.project.name);
  const ben = await openAs(browser, BEN, info.project.name);
  try {
    const anaPanel = await openThread(ana.page, rootId);
    const ask = await postAs(
      anaApi,
      channel.id,
      `@${bot.username} summarise the handbook ${taskDirectives(SLOW_GOAL, { of: PARTS, afterSeconds: 600 })}`,
      { threadRootId: rootId },
    );
    const taskId = await startedTask(ask.id);
    slowTasks.add(taskId);
    const card = taskCards(anaPanel).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId("agent-card-title")).toContainText(SLOW_GOAL);
    await expect(card.getByTestId("task-turns")).toHaveText(`Turn 1 of ${MAX_TURNS}`);
    await expect(card.getByTestId("task-waiting")).toContainText("Waiting until", { timeout: 15_000 });
    await expect(card.getByTestId("task-next")).toHaveText(readNote(2, PARTS));
    const stop = card.getByTestId("task-stop");
    await expect(stop).toBeVisible();
    await expect(stop).toHaveAccessibleName(`Stop task: ${SLOW_GOAL}`);
    if (mobile) {
      const box = await stop.boundingBox();
      expect(box?.height ?? 0, "Stop is 44 px tall on phones").toBeGreaterThanOrEqual(43.5);
    }
    await expectCardFits(card);
    await checkScreen(ana.page, "task-card-waiting", THREAD, [card]);
    await captureReview(ana.page, `07171112-task-waiting-${w}`);

    // Ben reads the same thread: the same live card, without Stop (he neither asked nor moderates, PD-12).
    const benPanel = await openThread(ben.page, rootId);
    const benCard = taskCards(benPanel).first();
    await expect(benCard).toBeVisible({ timeout: 15_000 });
    await expect(benCard.getByTestId("task-turns")).toHaveText(`Turn 1 of ${MAX_TURNS}`);
    await expect(benCard.getByTestId("task-stop")).toHaveCount(0);

    // Ana presses Stop: Stopped, by her, for everyone; no next step, no Stop.
    await stop.click();
    const notice = taskStopNotice("stopped_by_person", {
      maxTurns: MAX_TURNS,
      maxHours: 8,
      byName: ANA.name,
    });
    for (const c of [card, benCard]) {
      await expect(c.getByTestId("agent-card-status")).toHaveText("Stopped", { timeout: 15_000 });
      await expect(c.getByTestId("agent-card-notice").first()).toHaveText(notice as string);
      await expect(c.getByTestId("task-next")).toHaveCount(0);
      await expect(c.getByTestId("task-progress")).toHaveText(readNote(1, PARTS));
    }
    await expect(card.getByTestId("task-stop")).toHaveCount(0);

    // No further turn arrives (one wait window past the API's 5 s gap and a job poll).
    await ana.page.waitForTimeout(12_000);
    expect(
      cell.events.filter((e) => e.type === TASK_EVENT && turnOf(e).task?.taskId === taskId),
    ).toHaveLength(0);
    await expect(card.getByTestId("task-turns")).toHaveText(`Turn 1 of ${MAX_TURNS}`);
    await expect(card.getByTestId("agent-card-status")).toHaveText("Stopped");

    await checkScreen(ana.page, "task-card-stopped-by-person", THREAD);
    await captureReview(ana.page, `07171112-task-stopped-${w}`);
  } finally {
    await ben.context.close();
    await ana.context.close();
  }
});
