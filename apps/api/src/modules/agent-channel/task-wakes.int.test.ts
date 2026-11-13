import { randomUUID } from "node:crypto";
import { AgentTaskEvent, BUILTIN_TOOLS, taskContinueSentence } from "@ocw/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/crypto";
import { type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import {
  ageTurn,
  continueAs,
  continuedTask,
  deliverTaskTurn,
  drainTaskJobs,
  dropTaskJobs,
  endMessagesOf,
  queuedTaskJobs,
  reportTurnDone,
  setTask,
  startTaskFor,
  taskEvents,
  taskRow,
} from "../../testing-tasks";
import { createPermissionService } from "../organization";
import { continueBotTask, runTaskContinuation, taskEventId, tickBotTasks } from "./task-wakes";

/**
 * Phase 07.17.1.1.2-09 (D-01, D-02, D-07; PD-05, PD-06, PD-11; BTASK-01, BTASK-03, BTASK-06): the phase's API end to end,
 * continuation. A bot's turn calls `ocw_task_continue`; the cell reports the turn done; the `bot_task.continue` job
 * delivers exactly one `agent.task.v1` in the card's thread, for the requester, built like a mention of the bot on its
 * task card: a fixed server sentence as the message, the task's notes in `turn.task`, the continue and finish tools.
 *
 * People: Sam Lee asks (the requester); Alex Kim is another member of #eng. Scout is the team bot.
 */

let s: SandboxStack;
let engId: string;

const CONTINUE = BUILTIN_TOOLS.taskContinue;
const FINISH = BUILTIN_TOOLS.taskFinish;
const START = BUILTIN_TOOLS.taskStart;

beforeAll(async () => {
  s = await startSandboxStack();
  engId = (
    await ok(
      s.victor.request("POST", "/api/v1/channels", { name: "eng", visibility: "public" }) as Promise<Res>,
    )
  ).id as string;
  for (const member of [
    { kind: "agent", id: s.scoutId },
    { kind: "user", id: s.samId },
    { kind: "user", id: s.alexId },
  ]) {
    await ok(s.victor.request("POST", `/api/v1/channels/${engId}/members`, member) as Promise<Res>);
  }
  // This suite leaves many tasks running: the organization's cap (default 10) is raised to its maximum.
  await ok(s.victor.request("PUT", "/api/v1/bot-policy", { tasks: { maxRunning: 100 } }) as Promise<Res>);
}, 240_000);

afterAll(async () => {
  await s?.stop();
});

const auditsOf = async (action: string, resourceId: string) =>
  (
    await s.su.query(
      "select actor_kind, actor_id, agent_id, user_id, resource_type, resource_id, result, metadata from app.audit_events where action = $1 and resource_id = $2 order by occurred_at",
      [action, resourceId],
    )
  ).rows as Json[];

const turnOf = async (eventId: string) =>
  (
    await s.su.query(
      "select event_id, user_id, task_id, done_at, tainted, session_output_read from app.agent_turns where event_id = $1",
      [eventId],
    )
  ).rows[0] as Json | undefined;

const queuedJobs = async (taskId: string) =>
  (
    await s.su.query(
      "select id, start_after from pgboss.job where name = 'bot_task.continue' and data->>'taskId' = $1 and state = 'created'",
      [taskId],
    )
  ).rows as Json[];

const usageTurns = async (agentId: string) =>
  ((
    await s.su.query(
      "select coalesce(sum(turns), 0)::int as n from app.agent_usage_daily where agent_id = $1",
      [agentId],
    )
  ).rows[0]?.n ?? 0) as number;

describe("tracer: continue → done → the job → exactly one agent.task.v1 in the card's thread (D-02, PD-05, PD-06)", () => {
  let taskId: string;
  let start: Json;
  let first: Json;

  it("before the turn reports done, nothing is delivered (the backstop not due; due but the turn still running)", async () => {
    ({ taskId, event: start } = await startTaskFor(s, { who: s.sam, conversationId: engId }));
    const c = await continueAs(s, start);
    expect(c.body).toMatchObject({ ok: true, next: "after_turn" });
    // The backstop job is due in 30 minutes: a plain drain runs nothing.
    expect(await s.stack.built.core.jobs.drain("bot_task.continue")).toBe(0);
    // The wait made due and the job forced: the turn that continued has not reported done (and is younger than
    // 30 min), so nothing is delivered (PD-06).
    await setTask(s, taskId, { wake_at: new Date(Date.now() - 1_000) });
    expect(await drainTaskJobs(s)).toBeGreaterThan(0);
    expect(await taskEvents(s, taskId)).toEqual([]);
    expect(await taskRow(s, taskId)).toMatchObject({ status: "waiting", turns_used: 1, wait_kind: "turn" });
  });

  it("the cell's done marks the turn, keeps the wait within about 5 s and queues one job 5 s later", async () => {
    // Back to the 30-minute backstop, as the continue left it: the done shortens it.
    await setTask(s, taskId, { wake_at: new Date(Date.now() + 30 * 60_000) });
    const before = Date.now();
    const r = await reportTurnDone(s, start.eventId as string);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await turnOf(start.eventId as string))?.done_at).toBeInstanceOf(Date);
    const row = await taskRow(s, taskId);
    const wake = new Date(row.wake_at as Date).getTime();
    expect(wake).toBeGreaterThanOrEqual(before - 1_000);
    expect(wake).toBeLessThanOrEqual(Date.now() + 10_000);
    const jobs = await queuedJobs(taskId);
    expect(jobs).toHaveLength(1);
    expect(new Date(jobs[0]?.start_after as Date).getTime()).toBeGreaterThanOrEqual(before + 4_000);
  });

  it("the drained job delivers one agent.task.v1: the requester, the card, the sentence, the task tools", async () => {
    expect(await drainTaskJobs(s)).toBeGreaterThan(0);
    const events = await taskEvents(s, taskId);
    expect(events).toHaveLength(1);
    first = events[0] as Json;
    const row = await taskRow(s, taskId);
    const eventId = taskEventId(taskId, 1);
    expect(AgentTaskEvent.safeParse({ ...first, seq: 1 }).success).toBe(true);
    expect(first).toMatchObject({
      type: "agent.task.v1",
      eventId,
      agent: { id: s.scoutId },
      conversation: { id: engId },
      thread: { rootMessageId: row.thread_root_id },
      message: {
        id: row.card_message_id,
        text: "Continue your task (turn 2 of 40).",
        author: { kind: "user", id: s.samId },
      },
      task: { taskId, reason: "continue" },
    });
    expect(first.turn.task).toMatchObject({ taskId, turnsUsed: 2, maxTurns: 40, status: "running" });
    const tools = first.turn.tools as string[];
    expect(tools).toContain(CONTINUE);
    expect(tools).toContain(FINISH);
    expect(tools).not.toContain(START);
    // Nobody watches a continuation: no browser tools (D-09).
    expect(tools.filter((t) => t.startsWith("ocw_browser_"))).toEqual([]);

    expect(row).toMatchObject({
      status: "running",
      turns_used: 2,
      current_event_id: eventId,
      wait_kind: null,
    });
    expect(await turnOf(eventId)).toMatchObject({ user_id: s.samId, task_id: taskId });
    const continued = await auditsOf("bot.task_continued", taskId);
    expect(continued).toHaveLength(1);
    expect(continued[0]).toMatchObject({
      actor_kind: "agent",
      actor_id: s.scoutId,
      agent_id: s.scoutId,
      user_id: s.samId,
      resource_type: "bot_task",
      result: "success",
      metadata: { taskId, eventId, turnsUsed: 2, reason: "continue" },
    });
  });

  it("a second drain and a second done deliver nothing more", async () => {
    await drainTaskJobs(s);
    expect((await reportTurnDone(s, start.eventId as string)).status).toBe(200);
    await drainTaskJobs(s);
    expect(await taskEvents(s, taskId)).toHaveLength(1);
  });

  it("the delivered turn continues and reports done: a third turn, turn 3 of 40", async () => {
    const c = await continueAs(s, first);
    expect(c.body).toMatchObject({ ok: true });
    expect((await reportTurnDone(s, first.eventId as string)).status).toBe(200);
    await drainTaskJobs(s);
    const events = await taskEvents(s, taskId);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      eventId: taskEventId(taskId, 3),
      message: { text: "Continue your task (turn 3 of 40)." },
      task: { taskId, reason: "continue" },
    });
    expect(await taskRow(s, taskId)).toMatchObject({ status: "running", turns_used: 3 });
  });
});

describe("a DM task (PD-11)", () => {
  it("the continuation's thread root is the card message itself", async () => {
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: s.samDm, handle: null });
    expect((await continueAs(s, event)).body).toMatchObject({ ok: true });
    expect((await reportTurnDone(s, event.eventId as string)).status).toBe(200);
    await drainTaskJobs(s);
    const row = await taskRow(s, taskId);
    expect(row.thread_root_id).toBeNull();
    const [ev] = await taskEvents(s, taskId);
    expect(ev).toMatchObject({
      conversation: { id: s.samDm },
      thread: { rootMessageId: row.card_message_id },
      message: { id: row.card_message_id, author: { id: s.samId } },
    });
  });
});

describe("who the turn is for and who pays (D-01, D-07, ADR-0019)", () => {
  it("Alex writes in the thread meanwhile: his own turn is a view turn for him; the continuation is Sam's and meters once", async () => {
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    expect((await continueAs(s, event)).body).toMatchObject({ ok: true });
    const row0 = await taskRow(s, taskId);

    // Alex mentions the bot in the task's thread before the continuation is delivered (this clears today's usage).
    const alexTurn = await deliverTaskTurn(s, {
      who: s.alex,
      conversationId: engId,
      threadRootId: row0.thread_root_id as string,
    });
    expect(await turnOf(alexTurn.eventId as string)).toMatchObject({ user_id: s.alexId, task_id: null });
    expect(alexTurn.turn.task).toMatchObject({ taskId });
    expect((alexTurn.turn.tools as string[]).filter((t) => t.startsWith("ocw_task_"))).toEqual([]);
    const meteredBefore = await usageTurns(s.scoutId);
    expect(meteredBefore).toBe(1);

    expect((await reportTurnDone(s, event.eventId as string)).status).toBe(200);
    await drainTaskJobs(s);
    const [ev] = await taskEvents(s, taskId);
    expect(ev?.message.author).toMatchObject({ kind: "user", id: s.samId });
    expect(await turnOf(ev?.eventId as string)).toMatchObject({ user_id: s.samId, task_id: taskId });
    expect(await usageTurns(s.scoutId)).toBe(meteredBefore + 1);
    // Cell turns write no AI usage record; none is attributed to Alex.
    const usage = (
      await s.su.query("select count(*)::int as n from app.ai_usage_records where requester_user_id = $1", [
        s.alexId,
      ])
    ).rows[0] as { n: number };
    expect(usage.n).toBe(0);
  });
});

// ---------------------------------------------------------------- Task 2: single delivery, timers, nudge, tick

const deps = () => ({ perms: createPermissionService(s.stack.built.core) });
const turnsWithId = async (eventId: string) =>
  (
    (await s.su.query("select count(*)::int as n from app.agent_turns where event_id = $1", [eventId]))
      .rows[0] as {
      n: number;
    }
  ).n;

describe("the same wait is delivered once (Pitfall 2, PD-06, E3)", () => {
  it("two handlers at once, the backstop job, the tick and a second done: one turn, one cell event", async () => {
    const { taskId, start } = await continuedTask(s, { who: s.sam, conversationId: engId });
    await setTask(s, taskId, { wake_at: new Date(Date.now() - 1_000) });
    const data = { organizationId: s.orgA, taskId };
    const outs = await Promise.all([
      continueBotTask(s.stack.built.core, deps(), data),
      continueBotTask(s.stack.built.core, deps(), data),
    ]);
    expect(outs.filter((o) => o === "delivered")).toHaveLength(1);
    await drainTaskJobs(s);
    await tickBotTasks(s.stack.built.core, deps());
    expect((await reportTurnDone(s, start.eventId as string)).status).toBe(200);
    await drainTaskJobs(s);
    expect(await turnsWithId(taskEventId(taskId, 1))).toBe(1);
    expect(await taskEvents(s, taskId)).toHaveLength(1);
    expect(await taskRow(s, taskId)).toMatchObject({ status: "running", turns_used: 2 });
  });
});

describe("code review CR-01: a stop that lands between the reservation and the delivery (D-07)", () => {
  const auditCount = async (action: string, taskId: string) =>
    (
      (
        await s.su.query(
          "select count(*)::int as n from app.audit_events where action = $1 and resource_id = $2",
          [action, taskId],
        )
      ).rows[0] as { n: number }
    ).n;

  it("Sam presses Stop after the wait was reserved: no turn, no usage, no bot.task_continued; the reservation's turn is given back", async () => {
    const { taskId } = await continuedTask(s, { who: s.sam, conversationId: engId });
    await setTask(s, taskId, { wake_at: new Date(Date.now() - 1_000) });
    const usedBefore = await usageTurns(s.scoutId);
    const out = await continueBotTask(
      s.stack.built.core,
      deps(),
      { organizationId: s.orgA, taskId },
      {
        afterReserve: async () => {
          // The reservation is committed: the task runs the continuation's turn, which is not delivered yet.
          expect(await taskRow(s, taskId)).toMatchObject({ status: "running", turns_used: 2 });
          const r = (await s.sam.request("POST", `/api/v1/bot-tasks/${taskId}/stop`)) as Res;
          expect(r.status, JSON.stringify(r.body)).toBe(200);
        },
      },
    );
    expect(out).toBe("stopped");
    expect(await taskEvents(s, taskId)).toEqual([]);
    expect(await turnsWithId(taskEventId(taskId, 1))).toBe(0);
    expect(await usageTurns(s.scoutId)).toBe(usedBefore);
    expect(await auditCount("bot.task_continued", taskId)).toBe(0);
    expect(await auditCount("bot.task_stopped", taskId)).toBe(1);
    expect(await taskRow(s, taskId)).toMatchObject({
      status: "stopped",
      outcome: "stopped_by_person",
      turns_used: 1,
    });
    // Nothing is queued or delivered later either.
    await drainTaskJobs(s);
    expect(await taskEvents(s, taskId)).toEqual([]);
  });

  it("a stale continuation never takes control of a newer waiting task of the same requester in the thread", async () => {
    const { taskId: x } = await continuedTask(s, { who: s.sam, conversationId: engId });
    const rowX = await taskRow(s, x);
    await setTask(s, x, { wake_at: new Date(Date.now() - 1_000) });
    let y = "";
    const out = await continueBotTask(
      s.stack.built.core,
      deps(),
      { organizationId: s.orgA, taskId: x },
      {
        afterReserve: async () => {
          expect(((await s.sam.request("POST", `/api/v1/bot-tasks/${x}/stop`)) as Res).status).toBe(200);
          // Sam starts task Y in the same thread; it waits for its next turn.
          const started = await startTaskFor(s, {
            who: s.sam,
            conversationId: engId,
            threadRootId: rowX.thread_root_id as string,
          });
          y = started.taskId;
          expect((await continueAs(s, started.event)).body).toMatchObject({ ok: true });
          expect((await taskRow(s, y)).status).toBe("waiting");
        },
      },
    );
    expect(out).toBe("stopped");
    expect(await turnsWithId(taskEventId(x, 1))).toBe(0);
    // Y is untouched: still waiting, its current turn its own start turn, no turn linked to it but that one.
    const rowY = await taskRow(s, y);
    expect(rowY).toMatchObject({ status: "waiting", turns_used: 1, current_event_id: rowY.started_event_id });
    const linked = (
      await s.su.query("select event_id from app.agent_turns where task_id = $1", [y])
    ).rows.map((r) => r.event_id);
    expect(linked).toEqual([rowY.started_event_id]);
  });
});

describe("code review WR-03: a delivery error that persists stops the task as error, once", () => {
  const cardOf = async (taskId: string) =>
    (
      await s.su.query(
        "select c.version, c.status, c.status_label, c.notices from app.message_cards c join app.bot_tasks t on t.card_message_id = c.message_id where t.id = $1",
        [taskId],
      )
    ).rows[0] as Json;

  it("the continuation's jobs retry a few times with backoff", async () => {
    const { taskId } = await continuedTask(s, { who: s.sam, conversationId: engId });
    const jobs = (
      await s.su.query(
        "select retry_limit, retry_delay, retry_backoff from pgboss.job where name = 'bot_task.continue' and data->>'taskId' = $1",
        [taskId],
      )
    ).rows as Json[];
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job.retry_limit).toBe(2);
      expect(job.retry_delay).toBeGreaterThanOrEqual(10);
      expect(job.retry_backoff).toBe(true);
    }
  });

  it("three failed attempts: the wait is given back twice without touching the card, then the task fails with outcome error and one message", async () => {
    const { taskId } = await continuedTask(s, { who: s.sam, conversationId: engId });
    await dropTaskJobs(s, taskId);
    await setTask(s, taskId, { wake_at: new Date(Date.now() - 1_000) });
    const real = deps();
    const failing = {
      ...real,
      perms: {
        ...real.perms,
        decide: async () => {
          throw new Error("the permission store is down");
        },
      },
    };
    const data = { organizationId: s.orgA, taskId };
    const before = await cardOf(taskId);
    for (const retryCount of [0, 1]) {
      await expect(
        runTaskContinuation(s.stack.built.core, failing, data, { retryCount, retryLimit: 2 }),
      ).rejects.toThrow();
      expect(await taskRow(s, taskId)).toMatchObject({ status: "waiting", turns_used: 1, wait_kind: "turn" });
      expect((await cardOf(taskId)).version).toBe(before.version);
    }
    // The last attempt: the task stops, the job completes (nothing left to retry).
    await runTaskContinuation(s.stack.built.core, failing, data, { retryCount: 2, retryLimit: 2 });
    expect(await taskRow(s, taskId)).toMatchObject({ status: "failed", outcome: "error", turns_used: 1 });
    expect(await taskEvents(s, taskId)).toEqual([]);
    const card = await cardOf(taskId);
    expect(card.version).toBe(before.version + 1);
    expect(card).toMatchObject({
      status: "failed",
      notices: [{ tone: "neutral", text: "Stopped after an error." }],
    });
    const posted = await endMessagesOf(s, taskId);
    expect(posted.map((m) => m.body)).toEqual([
      "@sam I stopped this task: an error kept me from going on. The card shows where it got to.",
    ]);
    // A later job or the tick finds an ended task.
    await setTask(s, taskId, { wake_at: new Date(Date.now() - 2 * 60_000) });
    await tickBotTasks(s.stack.built.core, deps());
    await drainTaskJobs(s);
    expect(await taskEvents(s, taskId)).toEqual([]);
  });

  it("a delivery that fails once and then works is delivered, with the card refreshed once", async () => {
    const { taskId } = await continuedTask(s, { who: s.sam, conversationId: engId });
    await dropTaskJobs(s, taskId);
    await setTask(s, taskId, { wake_at: new Date(Date.now() - 1_000) });
    const real = deps();
    let calls = 0;
    const flaky = {
      ...real,
      perms: {
        ...real.perms,
        decide: ((...args: Parameters<typeof real.perms.decide>) => {
          calls++;
          if (calls === 1) throw new Error("a transient failure");
          return real.perms.decide(...args);
        }) as typeof real.perms.decide,
      },
    };
    const data = { organizationId: s.orgA, taskId };
    const before = await cardOf(taskId);
    await expect(
      runTaskContinuation(s.stack.built.core, flaky, data, { retryCount: 0, retryLimit: 2 }),
    ).rejects.toThrow();
    await runTaskContinuation(s.stack.built.core, flaky, data, { retryCount: 1, retryLimit: 2 });
    expect(await taskEvents(s, taskId)).toHaveLength(1);
    expect(await taskRow(s, taskId)).toMatchObject({ status: "running", turns_used: 2 });
    const card = await cardOf(taskId);
    expect(card.version).toBe(before.version + 1);
    expect(card).toMatchObject({ status: "running", status_label: "Working" });
  });
});

describe("timers, the backstop and lost turns (D-03, E4, E5)", () => {
  it("a 120 s timer: nothing at once, one turn with reason timer once wake_at has passed", async () => {
    const { taskId } = await continuedTask(s, {
      who: s.sam,
      conversationId: engId,
      body: { afterSeconds: 120 },
    });
    expect((await taskRow(s, taskId)).wait_kind).toBe("timer");
    // The jobs are due at wake_at: nothing runs yet, nothing is delivered.
    expect(await s.stack.built.core.jobs.drain("bot_task.continue")).toBe(0);
    expect(await taskEvents(s, taskId)).toEqual([]);
    await setTask(s, taskId, { wake_at: new Date(Date.now() - 1_000) });
    await drainTaskJobs(s);
    const events = await taskEvents(s, taskId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      task: { taskId, reason: "timer" },
      message: { text: "The wait you asked for is over. Continue your task (turn 2 of 40)." },
    });
  });

  it("the cell never reports done: the 30-minute backstop delivers the wait once the turn is taken as lost", async () => {
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    expect((await continueAs(s, event)).body).toMatchObject({ ok: true });
    await ageTurn(s, event.eventId as string, 31);
    await setTask(s, taskId, { wake_at: new Date(Date.now() - 1_000) });
    await drainTaskJobs(s);
    const events = await taskEvents(s, taskId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ task: { taskId, reason: "continue" } });
  });
});

describe("the nudge (D-12, E6)", () => {
  it("a task turn ends without continue or finish: one nudge turn; a second one in a row stops the task", async () => {
    const { taskId } = await continuedTask(s, { who: s.sam, conversationId: engId });
    await drainTaskJobs(s);
    const [second] = await taskEvents(s, taskId);
    // Turn 2 ends without ocw_task_continue or ocw_task_finish.
    expect((await reportTurnDone(s, second?.eventId as string)).status).toBe(200);
    expect(await taskRow(s, taskId)).toMatchObject({ status: "waiting", wait_kind: "nudge", nudged: true });
    await drainTaskJobs(s);
    const events = await taskEvents(s, taskId);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      task: { taskId, reason: "nudge" },
      message: { text: taskContinueSentence("nudge", 3, 40) },
    });
    expect(await taskRow(s, taskId)).toMatchObject({ status: "running", turns_used: 3, nudged: true });

    // The nudge turn ends without them too: the task stops as blocked, with one message mentioning Sam.
    expect((await reportTurnDone(s, events[1]?.eventId as string)).status).toBe(200);
    const row = await taskRow(s, taskId);
    expect(row).toMatchObject({ status: "failed", outcome: "no_progress", wait_kind: null });
    const card = (
      await s.su.query("select status, status_label from app.message_cards where message_id = $1", [
        row.card_message_id,
      ])
    ).rows[0] as Json;
    expect(card).toEqual({ status: "failed", status_label: "Blocked" });
    const posted = await endMessagesOf(s, taskId);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toMatch(/^@sam I stopped this task: two turns in a row ended without progress\./);
    await drainTaskJobs(s);
    expect(await taskEvents(s, taskId)).toHaveLength(2);
  });

  it("a continue in between resets the nudge: the next idle turn is nudged again, not stopped", async () => {
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    // The start turn ends without continue: the nudge.
    expect((await reportTurnDone(s, event.eventId as string)).status).toBe(200);
    expect(await taskRow(s, taskId)).toMatchObject({ status: "waiting", wait_kind: "nudge", nudged: true });
    await drainTaskJobs(s);
    const [nudge] = await taskEvents(s, taskId);
    expect(nudge).toMatchObject({ task: { reason: "nudge" } });
    expect((await continueAs(s, nudge as Json)).body).toMatchObject({ ok: true });
    expect((await taskRow(s, taskId)).nudged).toBe(false);
    expect((await reportTurnDone(s, nudge?.eventId as string)).status).toBe(200);
    await drainTaskJobs(s);
    const [, third] = await taskEvents(s, taskId);
    expect(third).toMatchObject({ task: { reason: "continue" } });
    expect((await reportTurnDone(s, third?.eventId as string)).status).toBe(200);
    expect(await taskRow(s, taskId)).toMatchObject({ status: "waiting", wait_kind: "nudge", nudged: true });
  });
});

describe("the minute tick (PD-06, PD-09, E5, E8, E10)", () => {
  let tokenB: string;
  let wardenId: string;
  let fleetId: string;

  beforeAll(async () => {
    tokenB = `ocw_cell_${randomUUID()}${randomUUID()}`;
    await s.su.query(
      "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
      [s.orgB, sha256Hex(tokenB)],
    );
    wardenId = (
      await ok(
        s.eve.request("POST", "/api/v1/agents", {
          name: "Warden",
          username: "warden",
          instructions: "You are Warden.",
          modelProvider: "mock",
          modelId: "mock-1",
        }) as Promise<Res>,
      )
    ).id as string;
    fleetId = (
      await ok(
        s.eve.request("POST", "/api/v1/channels", { name: "fleet", visibility: "public" }) as Promise<Res>,
      )
    ).id as string;
    await ok(
      s.eve.request("POST", `/api/v1/channels/${fleetId}/members`, {
        kind: "agent",
        id: wardenId,
      }) as Promise<Res>,
    );
  });

  /** Moves a task's eight hours into the past (its hour budget stays 8). */
  const pastDeadline = async (taskId: string) => {
    const row = await taskRow(s, taskId);
    const shift = 9 * 3_600_000;
    await setTask(s, taskId, {
      started_at: new Date(new Date(row.started_at as string).getTime() - shift),
      deadline_at: new Date(new Date(row.deadline_at as string).getTime() - shift),
    });
  };

  it("a waiting task due two minutes ago whose job was lost: the tick queues it and it is delivered", async () => {
    const { taskId } = await continuedTask(s, { who: s.sam, conversationId: engId });
    await dropTaskJobs(s, taskId);
    await setTask(s, taskId, { wake_at: new Date(Date.now() - 2 * 60_000) });
    await tickBotTasks(s.stack.built.core, deps());
    expect((await queuedTaskJobs(s, taskId)).length).toBeGreaterThanOrEqual(1);
    await drainTaskJobs(s);
    expect(await taskEvents(s, taskId)).toHaveLength(1);
  });

  it("code review IN-04: the lister reads the database's clock when the tick passes none", async () => {
    const { taskId } = await continuedTask(s, { who: s.sam, conversationId: engId });
    await setTask(s, taskId, { wake_at: new Date(Date.now() - 2 * 60_000) });
    const listed = (await s.su.query("select id from app.due_bot_tasks(1000, null)")).rows.map((r) => r.id);
    expect(listed).toContain(taskId);
    await dropTaskJobs(s, taskId);
    await tickBotTasks(s.stack.built.core, deps());
    expect((await queuedTaskJobs(s, taskId)).length).toBeGreaterThanOrEqual(1);
  });

  it("a running task whose current turn is 31 minutes old without done: the nudge path", async () => {
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    await ageTurn(s, event.eventId as string, 31);
    await setTask(s, taskId, { updated_at: new Date(Date.now() - 31 * 60_000) });
    await tickBotTasks(s.stack.built.core, deps());
    expect(await taskRow(s, taskId)).toMatchObject({ status: "waiting", wait_kind: "nudge", nudged: true });
    await drainTaskJobs(s);
    const [ev] = await taskEvents(s, taskId);
    expect(ev).toMatchObject({ task: { taskId, reason: "nudge" } });
  });

  it("a task past its deadline is stopped budget_time with one message", async () => {
    const { taskId } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    await pastDeadline(taskId);
    await tickBotTasks(s.stack.built.core, deps());
    expect(await taskRow(s, taskId)).toMatchObject({ status: "stopped", outcome: "budget_time" });
    const posted = await endMessagesOf(s, taskId);
    expect(posted.map((m) => m.body)).toEqual([
      "@sam I stopped this task after 8 h, the limit for one task. The card shows where it got to.",
    ]);
  });

  it("a task of a disabled bot is stopped bot_unavailable without a message", async () => {
    const ranger = await s.newBot("Ranger");
    const { taskId } = await startTaskFor(s, {
      who: s.sam,
      conversationId: ranger.dm,
      agentId: ranger.id,
      handle: null,
    });
    await s.su.query("update app.agents set status = 'disabled' where id = $1", [ranger.id]);
    await tickBotTasks(s.stack.built.core, deps());
    const row = await taskRow(s, taskId);
    expect(row).toMatchObject({ status: "stopped", outcome: "bot_unavailable" });
    const card = (
      await s.su.query("select notices from app.message_cards where message_id = $1", [row.card_message_id])
    ).rows[0] as Json;
    expect(card.notices).toEqual([
      { tone: "neutral", text: "Stopped: the bot is not available here any more." },
    ]);
    await new Promise((r) => setTimeout(r, 300));
    const posted = (
      await s.su.query(
        "select 1 from app.messages m left join app.message_cards c on c.message_id = m.id where m.conversation_id = $1 and m.author_kind = 'agent' and c.message_id is null",
        [ranger.dm],
      )
    ).rows;
    expect(posted).toEqual([]);
  });

  it("tasks of two organizations past their deadline are each stopped in their own organization", async () => {
    const { taskId: a } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    const evB = await deliverTaskTurn(s, {
      who: s.eve,
      conversationId: fleetId,
      agentId: wardenId,
      handle: "warden",
      organizationId: s.orgB,
    });
    const startB = await s.cell(
      "/tasks/start",
      { eventId: evB.eventId, agentId: wardenId, goal: "Count the fleet" },
      tokenB,
    );
    expect(startB.body).toMatchObject({ ok: true });
    const b = startB.body?.taskId as string;
    await pastDeadline(a);
    await pastDeadline(b);
    await tickBotTasks(s.stack.built.core, deps());
    expect(await taskRow(s, a)).toMatchObject({
      organization_id: s.orgA,
      status: "stopped",
      outcome: "budget_time",
    });
    expect(await taskRow(s, b)).toMatchObject({
      organization_id: s.orgB,
      status: "stopped",
      outcome: "budget_time",
    });
    const audits = (
      await s.su.query(
        "select organization_id, resource_id from app.audit_events where action = 'bot.task_stopped' and resource_id::text = any($1::text[])",
        [[a, b]],
      )
    ).rows as Json[];
    expect(audits).toHaveLength(2);
    expect(audits.find((r) => r.resource_id === b)?.organization_id).toBe(s.orgB);
  });
});
