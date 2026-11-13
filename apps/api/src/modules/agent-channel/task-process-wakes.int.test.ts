import { AgentTaskEvent, taskContinueSentence } from "@ocw/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Json,
  ok,
  pumpSandboxEvents,
  type Res,
  type SandboxStack,
  startSandboxStack,
} from "../../testing-sandbox";
import {
  backgroundExec,
  continueAs,
  drainTaskJobs,
  processRowsOf,
  queuedTaskJobs,
  reportTurnDone,
  startTaskFor,
  taskEvents,
  taskRow,
} from "../../testing-tasks";

/**
 * Phase 07.17.1.1.2-11 (D-03, PD-13; BTASK-04, BTASK-11): a background sandbox command a task waits on wakes the task
 * when it ends. A task turn's `ocw_sandbox_exec` that answers `running` is linked to its task (`bot_task_processes`);
 * the fake sandboxd emits one `process` event when the command ends; the app's own sandbox events consumer applies it
 * in the event's organization transaction (`onProcessEvent`), which wakes the task waiting on that process; the
 * continuation carries the process facts. Through the fake sandboxd and the real consumer, end to end.
 *
 * People: Sam Lee asks (the requester). Scout is the team bot, its sandbox on.
 */

let s: SandboxStack;
let engId: string;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  s = await startSandboxStack();
  await s.setPolicy({ enabled: true });
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
  await ok(s.victor.request("PUT", "/api/v1/bot-policy", { tasks: { maxRunning: 100 } }) as Promise<Res>);
}, 240_000);

afterAll(async () => {
  await s?.stop();
});

describe("tracer: a background command of a waiting task ends, and the task gets its turn (D-03, PD-13)", () => {
  let taskId: string;
  let start: Json;
  let processId: string;
  let execAt: number;

  it("the task turn's background exec answers running and is linked to its task (deadline = timeout + 60 s)", async () => {
    ({ taskId, event: start } = await startTaskFor(s, { who: s.sam, conversationId: engId }));
    execAt = Date.now();
    const r = await backgroundExec(s, start, ["sleep", "1"], { timeoutSeconds: 300 });
    expect(r.body, JSON.stringify(r.body)).toMatchObject({ status: "running" });
    processId = r.body?.processId as string;
    const rows = await processRowsOf(s, taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organization_id: s.orgA,
      task_id: taskId,
      agent_id: s.scoutId,
      process_id: processId,
      event_id: start.eventId,
      status: "running",
      exit_code: null,
      duration_ms: null,
      ended_at: null,
    });
    const deadline = new Date(rows[0]?.deadline_at as Date).getTime();
    expect(deadline).toBeGreaterThanOrEqual(execAt + 360_000 - 2_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 360_000 + 2_000);
  });

  it("the turn waits for it (on_process) and reports done: nothing is delivered yet", async () => {
    const c = await continueAs(s, start, { waitFor: { processId } });
    expect(c.body, JSON.stringify(c.body)).toMatchObject({ ok: true, next: "on_process" });
    expect((await reportTurnDone(s, start.eventId as string)).status).toBe(200);
    await drainTaskJobs(s);
    expect(await taskEvents(s, taskId)).toEqual([]);
    expect(await taskRow(s, taskId)).toMatchObject({
      status: "waiting",
      wait_kind: "process",
      wait_ref: processId,
    });
  });

  it("the command ends; one pass of the consumer records it and wakes the task with one job", async () => {
    await pause(Math.max(0, execAt + 1_100 - Date.now()));
    const pass = await pumpSandboxEvents(s);
    expect(pass.applied).toBeGreaterThanOrEqual(1);
    const [row] = await processRowsOf(s, taskId);
    expect(row).toMatchObject({ status: "exited", exit_code: 0 });
    expect(row?.duration_ms).toBeGreaterThanOrEqual(900);
    expect(row?.ended_at).toBeInstanceOf(Date);
    const task = await taskRow(s, taskId);
    expect(task.status).toBe("waiting");
    expect(new Date(task.wake_at as Date).getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(await queuedTaskJobs(s, taskId)).toHaveLength(1);
  });

  it("the drained job delivers exactly one agent.task.v1 with reason process and the process facts", async () => {
    await drainTaskJobs(s);
    const events = await taskEvents(s, taskId);
    expect(events).toHaveLength(1);
    const ev = events[0] as Json;
    expect(AgentTaskEvent.safeParse({ ...ev, seq: 1 }).success).toBe(true);
    expect(ev).toMatchObject({
      type: "agent.task.v1",
      message: { text: taskContinueSentence("process", 2, 40) },
      task: { taskId, reason: "process", process: { processId, status: "exited", exitCode: 0 } },
    });
    expect(ev.message.text).toBe(
      "A background command of your task ended. Continue your task (turn 2 of 40).",
    );
    expect(ev.task.process.durationMs).toBeGreaterThanOrEqual(900);
    // The waited process travels in `task.process`, not a second time in `finishedProcesses`.
    expect(ev.turn.task).toMatchObject({ taskId, status: "running", waiting: null, finishedProcesses: [] });
    expect((await processRowsOf(s, taskId))[0]?.reported_at).toBeInstanceOf(Date);
  });

  it("another pass and another drain deliver nothing more", async () => {
    await pumpSandboxEvents(s);
    await drainTaskJobs(s);
    expect(await taskEvents(s, taskId)).toHaveLength(1);
  });
});

describe("a background run on a turn without a task (P5)", () => {
  it("inserts no row, and its event is applied without effect", async () => {
    const bot = await s.newBot("Plain Bot");
    const turn = await s.turnOf(s.sam, bot.dm, bot.id);
    const r = await backgroundExec(s, turn, ["sleep", "0.3"]);
    expect(r.body, JSON.stringify(r.body)).toMatchObject({ status: "running" });
    expect(
      (
        await s.su.query("select count(*)::int as n from app.bot_task_processes where agent_id = $1", [
          bot.id,
        ])
      ).rows[0]?.n,
    ).toBe(0);
    await pause(400);
    const jobsBefore = (
      await s.su.query("select count(*)::int as n from pgboss.job where name = 'bot_task.continue'")
    ).rows[0]?.n;
    const pass = await pumpSandboxEvents(s);
    expect(pass.applied).toBeGreaterThanOrEqual(1);
    expect(
      (await s.su.query("select count(*)::int as n from pgboss.job where name = 'bot_task.continue'")).rows[0]
        ?.n,
    ).toBe(jobsBefore);
  });
});
