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
  setTask,
  startTaskFor,
  taskEvents,
  taskRow,
} from "../../testing-tasks";
import { createSandboxEventsConsumer, type SandboxdClient } from "../sandbox";
import { linkTaskProcess, onProcessEvent } from "./task-process-wakes";

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

  it("an API restart replays the same boot from its start: the durable cursor applies nothing twice (E19)", async () => {
    const before = await processRowsOf(s, taskId);
    // A fresh process: no memory of the app's consumer (another lock key; the cursor is in the database).
    const fresh = createSandboxEventsConsumer(s.stack.built.core, {
      client: s.stack.built.sandbox.client as SandboxdClient,
      lockKey: 0x0b07_1100 + Math.floor(Math.random() * 1000),
      waitMs: 0,
    });
    fresh.onEvent("process", (tx, e) => onProcessEvent(tx, s.stack.built.core, e));
    try {
      const replay = await fresh.runOnce({ waitMs: 0 });
      expect(replay.applied).toBe(0);
      expect(replay.skipped).toBeGreaterThan(0);
    } finally {
      await fresh.stop();
    }
    expect(await processRowsOf(s, taskId)).toEqual(before);
    expect(await queuedTaskJobs(s, taskId)).toEqual([]);
    await drainTaskJobs(s);
    expect(await taskEvents(s, taskId)).toHaveLength(1);
  });
});

describe("a command that ends while its task waits on something else (E19)", () => {
  it("is only recorded (no early wake), then listed once in the next task turn's finishedProcesses", async () => {
    const { taskId, event: start } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    const r = await backgroundExec(s, start, ["sh", "-c", "sleep 0.3; exit 75"]);
    const processId = r.body?.processId as string;
    expect(r.body).toMatchObject({ status: "running" });
    // The bot waits ten minutes instead of on the command.
    const c = await continueAs(s, start, { afterSeconds: 600 });
    expect(c.body, JSON.stringify(c.body)).toMatchObject({ ok: true, next: "at" });
    expect((await reportTurnDone(s, start.eventId as string)).status).toBe(200);
    const wakeBefore = (await taskRow(s, taskId)).wake_at as Date;
    const jobsBefore = (await queuedTaskJobs(s, taskId)).length;
    await pause(400);
    await pumpSandboxEvents(s);
    expect((await processRowsOf(s, taskId))[0]).toMatchObject({
      status: "exited",
      exit_code: 75,
      reported_at: null,
    });
    const row = await taskRow(s, taskId);
    expect(row).toMatchObject({ status: "waiting", wait_kind: "timer" });
    expect(new Date(row.wake_at as Date).getTime()).toBe(new Date(wakeBefore).getTime());
    expect(await queuedTaskJobs(s, taskId)).toHaveLength(jobsBefore);

    // The timer comes: the turn lists the command once (with the exit code ocw-extract's batch gives it).
    await setTask(s, taskId, { wake_at: new Date(Date.now() - 1_000) });
    await drainTaskJobs(s);
    const [next] = await taskEvents(s, taskId);
    expect(next?.task).toEqual({ taskId, reason: "timer" });
    expect(next?.turn.task.finishedProcesses).toEqual([
      { processId, status: "exited", exitCode: 75, durationMs: expect.any(Number) },
    ]);
    expect((await processRowsOf(s, taskId))[0]?.reported_at).toBeInstanceOf(Date);

    // The turn after it does not list it again.
    expect((await continueAs(s, next as Json)).body).toMatchObject({ ok: true });
    expect((await reportTurnDone(s, next?.eventId as string)).status).toBe(200);
    await drainTaskJobs(s);
    const events = await taskEvents(s, taskId);
    expect(events).toHaveLength(2);
    expect(events[1]?.turn.task.finishedProcesses).toEqual([]);
  });
});

describe("tenant isolation of process events (E22, T-07.17.1.1.2-11-05)", () => {
  it("organization B's event naming A's bot and process, or A's event naming another bot, changes nothing", async () => {
    const { taskId, event: start } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    const r = await backgroundExec(s, start, ["sleep", "60"]);
    const processId = r.body?.processId as string;
    expect((await continueAs(s, start, { waitFor: { processId } })).body).toMatchObject({
      next: "on_process",
    });
    expect((await reportTurnDone(s, start.eventId as string)).status).toBe(200);
    await drainTaskJobs(s);
    const other = await s.newBot("Other Bot");
    const ended = { type: "process", processId, status: "exited", exitCode: 0, durationMs: 5 };
    s.sandboxd.fake.emit({ ...ended, target: { orgId: s.orgB, agentId: s.scoutId } });
    s.sandboxd.fake.emit({ ...ended, target: { orgId: s.orgA, agentId: other.id } });
    await pumpSandboxEvents(s);
    expect((await processRowsOf(s, taskId))[0]).toMatchObject({ status: "running", ended_at: null });
    expect(await taskRow(s, taskId)).toMatchObject({
      status: "waiting",
      wait_kind: "process",
      wait_ref: processId,
    });
    expect(await queuedTaskJobs(s, taskId)).toEqual([]);
    expect(await taskEvents(s, taskId)).toEqual([]);
    // Nothing of organization B was written for the event (its tenant holds no such row).
    expect(
      (
        await s.su.query("select count(*)::int as n from app.bot_task_processes where organization_id = $1", [
          s.orgB,
        ])
      ).rows[0]?.n,
    ).toBe(0);
  });
});

describe("a lost command: sandboxd restarted, no event before the deadline (E20)", () => {
  it("wakes the waiting task at the row's deadline with status lost; a late event changes nothing", async () => {
    const { taskId, event: start } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    const r = await backgroundExec(s, start, ["sleep", "60"]);
    const processId = r.body?.processId as string;
    expect((await continueAs(s, start, { waitFor: { processId } })).body).toMatchObject({
      next: "on_process",
    });
    expect((await reportTurnDone(s, start.eventId as string)).status).toBe(200);
    // sandboxd restarts (a new boot id, its processes forgotten): no event will ever come.
    s.sandboxd.fake.reboot();
    await pumpSandboxEvents(s);
    // The continue and the done queued the wait's jobs at the row's deadline: not due yet, so a plain drain runs none.
    const queued = (await queuedTaskJobs(s, taskId)).length;
    expect(queued).toBeGreaterThan(0);
    await s.stack.built.core.jobs.drain("bot_task.continue");
    expect(await queuedTaskJobs(s, taskId)).toHaveLength(queued);
    expect(await taskEvents(s, taskId)).toEqual([]);
    expect((await processRowsOf(s, taskId))[0]).toMatchObject({ status: "running" });

    // The row's deadline (the run's timeout + 60 s) passes; the wait was set to it.
    const past = new Date(Date.now() - 1_000);
    await s.su.query("update app.bot_task_processes set deadline_at = $2 where task_id = $1", [taskId, past]);
    await setTask(s, taskId, { wake_at: past });
    await drainTaskJobs(s);
    const events = await taskEvents(s, taskId);
    expect(events).toHaveLength(1);
    expect(events[0]?.task).toEqual({
      taskId,
      reason: "process",
      process: { processId, status: "lost", exitCode: null, durationMs: null },
    });
    expect((await processRowsOf(s, taskId))[0]).toMatchObject({ status: "lost" });
    expect(events[0]?.turn.task.finishedProcesses).toEqual([]);

    // A late event for it (an old boot's command after all) finds the row ended: nothing more.
    s.sandboxd.fake.emit({
      type: "process",
      target: { orgId: s.orgA, agentId: s.scoutId },
      processId,
      status: "exited",
      exitCode: 0,
      durationMs: 61_000,
    });
    await pumpSandboxEvents(s);
    expect((await processRowsOf(s, taskId))[0]).toMatchObject({ status: "lost" });
    await drainTaskJobs(s);
    expect(await taskEvents(s, taskId)).toHaveLength(1);
  });
});

describe("code review WR-02: a command that ends before its link commits", () => {
  const core = () => s.stack.built.core;
  const ended = (processId: string, agentId = s.scoutId) => ({
    seq: 1,
    at: new Date().toISOString(),
    type: "process" as const,
    target: { orgId: s.orgA, agentId },
    processId,
    status: "exited" as const,
    exitCode: 75,
    durationMs: 40,
  });

  it("the early event is kept and the link takes it: the bot learns the real exit code on its next turn", async () => {
    const { taskId, event: start } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    const processId = `early-${Date.now()}`;
    // sandboxd's event is applied before the exec's outcome transaction wrote the link.
    await core().db.withTenant({ organizationId: s.orgA, userId: null }, (tx) =>
      onProcessEvent(tx, core(), ended(processId)),
    );
    await core().db.withTenant({ organizationId: s.orgA, userId: s.samId }, (tx) =>
      linkTaskProcess(tx, {
        turn: { eventId: start.eventId as string, agentId: s.scoutId, taskId },
        processId,
        timeoutSeconds: 300,
      }),
    );
    const rows = await processRowsOf(s, taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      task_id: taskId,
      event_id: start.eventId,
      process_id: processId,
      status: "exited",
      exit_code: 75,
      duration_ms: 40,
    });
    // Waiting on it now goes on after the turn, and the next turn lists its end once.
    expect((await continueAs(s, start, { waitFor: { processId } })).body).toMatchObject({
      ok: true,
      next: "after_turn",
    });
    expect((await reportTurnDone(s, start.eventId as string)).status).toBe(200);
    await drainTaskJobs(s);
    const [next] = await taskEvents(s, taskId);
    expect(next?.turn.task.finishedProcesses).toEqual([
      { processId, status: "exited", exitCode: 75, durationMs: 40 },
    ]);
  });

  it("the event lands while the link's transaction is still open: it waits for the link, then ends it", async () => {
    const { taskId, event: start } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    const processId = `race-${Date.now()}`;
    let commitLink: () => void = () => {};
    const linked = new Promise<void>((r) => {
      commitLink = r;
    });
    let written: () => void = () => {};
    const inserted = new Promise<void>((r) => {
      written = r;
    });
    const link = core().db.withTenant({ organizationId: s.orgA, userId: s.samId }, async (tx) => {
      await linkTaskProcess(tx, {
        turn: { eventId: start.eventId as string, agentId: s.scoutId, taskId },
        processId,
        timeoutSeconds: 300,
      });
      written();
      await linked;
    });
    await inserted;
    const applied = core().db.withTenant({ organizationId: s.orgA, userId: null }, (tx) =>
      onProcessEvent(tx, core(), ended(processId)),
    );
    await pause(150);
    commitLink();
    await Promise.all([link, applied]);
    const rows = await processRowsOf(s, taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      process_id: processId,
      task_id: taskId,
      status: "exited",
      exit_code: 75,
    });
  });

  it("a link written first still gets its end as before; an unclaimed early end of a bot without a task is not kept", async () => {
    const { taskId, event: start } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    const processId = `late-${Date.now()}`;
    await core().db.withTenant({ organizationId: s.orgA, userId: s.samId }, (tx) =>
      linkTaskProcess(tx, {
        turn: { eventId: start.eventId as string, agentId: s.scoutId, taskId },
        processId,
        timeoutSeconds: 300,
      }),
    );
    await core().db.withTenant({ organizationId: s.orgA, userId: null }, (tx) =>
      onProcessEvent(tx, core(), ended(processId)),
    );
    expect((await processRowsOf(s, taskId))[0]).toMatchObject({ status: "exited", exit_code: 75 });

    const idle = await s.newBot("Idle Bot");
    await core().db.withTenant({ organizationId: s.orgA, userId: null }, (tx) =>
      onProcessEvent(tx, core(), ended(`idle-${Date.now()}`, idle.id)),
    );
    expect(
      (
        await s.su.query("select count(*)::int as n from app.bot_task_processes where agent_id = $1", [
          idle.id,
        ])
      ).rows[0]?.n,
    ).toBe(0);
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
