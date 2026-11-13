import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import {
  continueAs,
  continuedTask,
  drainTaskJobs,
  endMessagesOf,
  reportTurnDone,
  setTask,
  taskEvents,
  taskRow,
} from "../../testing-tasks";

/**
 * Phase 07.17.1.1.2-09 (D-04, PD-09, PD-18; BTASK-07; E7, E8, E9, E11): every budget is re-checked under the task's row
 * lock at each delivery, before the turn is metered. A task over its turns, past its deadline, with long tasks turned
 * off for its bot, or whose bot reached its daily turn limit gets no further turn: it stops with its card notice and one
 * message mentioning the person it runs for (never the generic daily-limit notice, Pitfall 5).
 *
 * People: Sam Lee asks (the requester). Scout is the team bot.
 */

let s: SandboxStack;
let engId: string;

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
  ]) {
    await ok(s.victor.request("POST", `/api/v1/channels/${engId}/members`, member) as Promise<Res>);
  }
  await ok(s.victor.request("PUT", "/api/v1/bot-policy", { tasks: { maxRunning: 100 } }) as Promise<Res>);
}, 240_000);

afterAll(async () => {
  await s?.stop();
});

const cardOf = async (messageId: string) =>
  (
    await s.su.query("select status, status_label, notices from app.message_cards where message_id = $1", [
      messageId,
    ])
  ).rows[0] as Json;

/** Stopped with `outcome`, its card notice, one `@sam` message, one `bot.task_stopped` and no new turn. */
async function expectStopped(taskId: string, outcome: string, notice: string, sentence: string) {
  const row = await taskRow(s, taskId);
  expect(row).toMatchObject({ status: "stopped", outcome, wait_kind: null, wake_at: null });
  expect(await cardOf(row.card_message_id as string)).toEqual({
    status: "cancelled",
    status_label: "Stopped",
    notices: [{ tone: "neutral", text: notice }],
  });
  const posted = await endMessagesOf(s, taskId);
  expect(posted.map((m) => m.body)).toEqual([`@sam ${sentence}`]);
  const stops = (
    await s.su.query(
      "select metadata from app.audit_events where action = 'bot.task_stopped' and resource_id::text = $1",
      [taskId],
    )
  ).rows as Json[];
  expect(stops).toHaveLength(1);
  expect(stops[0]?.metadata).toMatchObject({ taskId, outcome });
  return row;
}

describe("turns (E7)", () => {
  it("max_turns 3: turns 2 and 3 are delivered, turn 3's continue is budget_turns, no fourth turn", async () => {
    const { taskId } = await continuedTask(s, { who: s.sam, conversationId: engId });
    await setTask(s, taskId, { max_turns: 3 });
    await drainTaskJobs(s);
    const [second] = await taskEvents(s, taskId);
    expect(second).toMatchObject({ message: { text: "Continue your task (turn 2 of 3)." } });
    expect((await continueAs(s, second as Json)).body).toMatchObject({ ok: true });
    expect((await reportTurnDone(s, second?.eventId as string)).status).toBe(200);
    await drainTaskJobs(s);
    const events = await taskEvents(s, taskId);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ message: { text: "Continue your task (turn 3 of 3)." } });
    expect((await continueAs(s, events[1] as Json)).body).toMatchObject({ ok: false, code: "budget_turns" });
    await expectStopped(
      taskId,
      "budget_turns",
      "Stopped: it used its 3 turns.",
      "I stopped this task after 3 turns, the limit for one task. The card shows where it got to.",
    );
    await drainTaskJobs(s);
    expect(await taskEvents(s, taskId)).toHaveLength(2);
  });

  it("every turn used when the wait comes: no turn, budget_turns with one message", async () => {
    const { taskId } = await continuedTask(s, { who: s.sam, conversationId: engId });
    await setTask(s, taskId, { turns_used: 40 });
    await drainTaskJobs(s);
    expect(await taskEvents(s, taskId)).toEqual([]);
    await expectStopped(
      taskId,
      "budget_turns",
      "Stopped: it used its 40 turns.",
      "I stopped this task after 40 turns, the limit for one task. The card shows where it got to.",
    );
  });
});

describe("time, the policy and the daily limit at delivery (E8, E9, E11)", () => {
  it("past its deadline when the wait comes: budget_time with one message", async () => {
    const { taskId } = await continuedTask(s, { who: s.sam, conversationId: engId });
    const row = await taskRow(s, taskId);
    const shift = 9 * 3_600_000;
    await setTask(s, taskId, {
      started_at: new Date(new Date(row.started_at as string).getTime() - shift),
      deadline_at: new Date(new Date(row.deadline_at as string).getTime() - shift),
    });
    await drainTaskJobs(s);
    expect(await taskEvents(s, taskId)).toEqual([]);
    await expectStopped(
      taskId,
      "budget_time",
      "Stopped: it ran for 8 h.",
      "I stopped this task after 8 h, the limit for one task. The card shows where it got to.",
    );
  });

  it("long tasks turned off for the bot while it waits: policy_off with one message", async () => {
    const { taskId } = await continuedTask(s, { who: s.sam, conversationId: engId });
    await s.su.query(
      "update app.agents set capabilities = capabilities || jsonb_build_object('longTasks', false) where id = $1",
      [s.scoutId],
    );
    try {
      await drainTaskJobs(s);
      expect(await taskEvents(s, taskId)).toEqual([]);
      await expectStopped(
        taskId,
        "policy_off",
        "Stopped: long tasks were turned off.",
        "I stopped this task: long tasks were turned off for me.",
      );
    } finally {
      await s.su.query(
        "update app.agents set capabilities = capabilities || jsonb_build_object('longTasks', true) where id = $1",
        [s.scoutId],
      );
    }
  });

  it("the bot at its daily limit: no event, no generic notice, daily_limit with one task message", async () => {
    const { taskId } = await continuedTask(s, { who: s.sam, conversationId: engId });
    await s.su.query("update app.agent_usage_daily set turns = 1000000 where agent_id = $1", [s.scoutId]);
    await drainTaskJobs(s);
    expect(await taskEvents(s, taskId)).toEqual([]);
    const row = await expectStopped(
      taskId,
      "daily_limit",
      "Stopped: the bot's daily limit was reached.",
      "I stopped this task: I reached my turn limit for today. The card shows where it got to.",
    );
    // The turn that was not delivered is not counted on the task.
    expect(row.turns_used).toBe(1);
    // Never retried until midnight (Pitfall 5): a later job finds the task ended.
    await drainTaskJobs(s);
    expect(await taskEvents(s, taskId)).toEqual([]);
  });
});
