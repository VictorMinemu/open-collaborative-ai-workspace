import {
  AgentChannelEventTypes,
  AgentChannelWorkSessionStartResponse,
  AgentWorkSessionEvent,
  type BotWorkZoneProfileInput,
  BUILTIN_TOOLS,
  TASK_TOOL_NAMES,
} from "@ocw/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventually, FakeDevice } from "../../testing-device";
import { type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import {
  continueAs,
  deliverTaskTurn,
  drainTaskJobs,
  endMessagesOf,
  reportTurnDone,
  setTask,
  startTaskFor,
  taskEvents,
  taskRow,
} from "../../testing-tasks";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  createBotProfile,
  grantBotConsent,
  pairDevice,
} from "../../testing-workzone";
import { createPermissionService } from "../organization";
import { syncBotWorkSession } from "./work-session-wakes";

/**
 * Phase 07.17.1.1.2-12 (D-03, D-04, D-07; PD-05, PD-09, PD-14; BTASK-05, BTASK-07, BTASK-11): a Work Zone session a task
 * started wakes the task. `ocw_work_session_start` from a task turn stores `bot_work_sessions.task_id`; the session's
 * 07.16 wake (`work_session.bot_sync`), when that task waits and has budget, consumes the wait and is delivered as the
 * task's own next turn (`agent.work_session.v1` with `turn.task` and the control tools, `agent_turns.task_id`). Over
 * budget: the task stops and the wake goes out plain; while another task turn runs: a view turn; a delivery given back
 * restores the wait. The wake's own dedupe and daily budget are 07.16's (`work-session-wakes.int.test.ts`, untouched).
 * Real PostgreSQL, Redis and pg-boss; the device is a FakeDevice; workers are off (jobs run through `drain`).
 *
 * People: Sam Lee asks (the requester, the plan's Ana); Alex Kim is another member of #eng (the plan's Ben). Builder is a
 * team bot with a Work Zone profile on Víctor's build server.
 */

const QUEUE = "work_session.bot_sync";
const FIRST = "fix the failing invoice test";
const CONTINUE = BUILTIN_TOOLS.taskContinue;
const FINISH = BUILTIN_TOOLS.taskFinish;

type Cmd = { id: string; payload: Record<string, unknown>; sessionId: string };

let s: SandboxStack;
let engId: string;
let builderId: string;
let billingId: string;
let device: FakeDevice;

const core = () => s.stack.built.core;
const deps = () => ({ perms: createPermissionService(core()) });
const rowsOf = async (q: string, args: unknown[] = []) => (await s.su.query(q, args)).rows as Json[];

const profile = (deviceId: string): BotWorkZoneProfileInput => ({
  deviceId,
  runtime: "claude-code",
  projectIds: [billingId],
  defaultModel: "opus",
  allowedModels: ["opus"],
  defaultEffort: null,
  allowedEfforts: [],
  defaultContextWindow: null,
  allowedContextWindows: [],
  fastMode: "off",
  defaultMode: "default",
  maxMode: "fullAccess",
  worktree: true,
  maxConcurrent: 10,
  promptsPerHour: 120,
  wakesPerSessionDay: 20,
  actOnOutsideContent: false,
});

beforeAll(async () => {
  s = await startSandboxStack();
  engId = (
    await ok(
      s.victor.request("POST", "/api/v1/channels", { name: "eng", visibility: "public" }) as Promise<Res>,
    )
  ).id as string;
  builderId = (await s.newBot("Builder")).id;
  for (const member of [
    { kind: "agent", id: builderId },
    { kind: "user", id: s.samId },
    { kind: "user", id: s.alexId },
  ]) {
    await ok(s.victor.request("POST", `/api/v1/channels/${engId}/members`, member) as Promise<Res>);
  }
  // Developers pass the Work Zone module gate (a standard member is offered no session tools).
  for (const userId of [s.samId, s.alexId]) {
    await ok(
      s.victor.request("PATCH", `/api/v1/members/${userId}/role`, { role: "developer" }) as Promise<Res>,
    );
  }
  await ok(s.victor.request("PUT", "/api/v1/bot-policy", { tasks: { maxRunning: 100 } }) as Promise<Res>);
  await ok(s.victor.request("PUT", "/api/v1/work-zone-policy", { allowFullAccess: true }) as Promise<Res>);
  const paired = await pairDevice(s.stack, s.victor, "billing-server");
  device = await FakeDevice.connect(s.stack.baseUrl, paired.token, undefined, {
    host: "service",
    isolatedServer: true,
  });
  device.send({
    type: "projects.sync",
    projects: [{ localId: "lp_billing-api", name: "billing-api", gitRemote: null, defaultBranch: "main" }],
  });
  await device.next((f) => f.type === "projects.ack");
  device.capabilities([CLAUDE_CATALOG, CODEX_CATALOG], true, true);
  await eventually(async () => {
    const r = await s.su.query("select runtime_catalog from app.devices where id = $1", [paired.deviceId]);
    return (r.rows[0].runtime_catalog as unknown[]).length === 2;
  });
  const list = (await ok(s.victor.request("GET", "/api/v1/projects") as Promise<Res>)).projects as Json[];
  billingId = list.find((p) => p.name === "billing-api")?.id as string;
  await createBotProfile(s.victor, builderId, profile(paired.deviceId));
  await grantBotConsent(s.victor, paired.deviceId, builderId, { allowFullAccess: true });
}, 240_000);

afterAll(async () => {
  await device?.close().catch(() => {});
  await s?.stop();
});

/** Every session of an earlier case ends (archived directly, no wake follows) and no wake job is left queued. */
async function quiesce() {
  await s.su.query(
    "update app.work_sessions set status = 'archived' where organization_id = $1 and status <> 'archived'",
    [s.orgA],
  );
  await s.su.query("update app.work_prompts set created_at = now() - interval '2 hours'");
  await s.su.query("delete from pgboss.job where name = $1", [QUEUE]);
}

const statusOf = async (workSessionId: string) =>
  (await rowsOf("select status from app.work_sessions where id = $1", [workSessionId]))[0]?.status as string;

interface Session {
  workSessionId: string;
  first: Cmd;
  cardMessageId: string;
}

/** Builder starts a session on billing-api from `event`'s turn; the device takes it and its first prompt runs. */
async function sessionFrom(event: Json): Promise<Session> {
  const r = await s.cell("/work-sessions/start", {
    eventId: event.eventId,
    agentId: builderId,
    projectId: billingId,
    prompt: FIRST,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const body = AgentChannelWorkSessionStartResponse.parse(r.body);
  if (body.kind !== "started") throw new Error(`not started: ${JSON.stringify(body)}`);
  const id = body.workSessionId;
  const start = await device.command("session.start", id);
  device.ack(start.id as string);
  device.event(id, {
    type: "session.started",
    runtime: "claude-code",
    runtimeSessionId: `rt-${id}`,
    model: "opus",
    permissionMode: "default",
  });
  device.event(id, { type: "session.state", status: "idle" });
  const first = (await device.command("prompt", id)) as Cmd;
  device.ack(first.id);
  await eventually(async () => (await statusOf(id)) === "running");
  // The start's own transitions wake nothing (running).
  await drainWakes();
  return { workSessionId: id, first, cardMessageId: body.cardMessageId as string };
}

/** The runtime finishes the session's turn of `cmd`: the prompt completes and the session goes idle. */
async function finishTurn(session: Session) {
  device.emitTurn(session.workSessionId, {
    promptId: session.first.payload.promptId as string,
    text: "done",
  });
  await eventually(async () => {
    const [p] = await rowsOf("select status from app.work_prompts where id = $1", [
      session.first.payload.promptId,
    ]);
    return p?.status === "completed";
  });
  await eventually(async () => (await statusOf(session.workSessionId)) === "idle");
}

/** Runs every wake job now (the 3 s debounce is the job's `startAfter`). */
async function drainWakes(): Promise<number> {
  await s.su.query(
    "update pgboss.job set start_after = now() where name = $1 and state in ('created', 'retry')",
    [QUEUE],
  );
  return core().jobs.drain(QUEUE);
}

/** The session's `agent.work_session.v1` events on organization A's cell stream, oldest first. */
const wakesOf = async (workSessionId: string) =>
  (
    await rowsOf(
      `select payload from app.stream_events
        where stream_id = $1 and type = $2 and payload->'workSession'->>'workSessionId' = $3 order by seq`,
      [`cell:${s.orgA}`, AgentChannelEventTypes.workSession, workSessionId],
    )
  ).map((r) => r.payload as Json);

const turnOf = async (eventId: string) =>
  (
    await rowsOf("select event_id, user_id, task_id, tainted from app.agent_turns where event_id = $1", [
      eventId,
    ])
  )[0];

const botRowOf = async (workSessionId: string) =>
  (
    await rowsOf(
      "select task_id, requester_user_id, wakes_used, last_woken_status from app.bot_work_sessions where work_session_id = $1",
      [workSessionId],
    )
  )[0]!;

const usageTurns = async (agentId: string) =>
  ((
    await rowsOf("select coalesce(sum(turns), 0)::int as n from app.agent_usage_daily where agent_id = $1", [
      agentId,
    ])
  )[0]?.n ?? 0) as number;

const taskTools = (ev: Json) => (ev.turn.tools as string[]).filter((t) => t.startsWith("ocw_task_"));

/** Sam's task in a fresh #eng thread, started on a turn that also starts a session (the same turn). */
async function taskWithSession(): Promise<{ taskId: string; start: Json; session: Session }> {
  await quiesce();
  const { taskId, event: start } = await startTaskFor(s, {
    who: s.sam,
    conversationId: engId,
    agentId: builderId,
    handle: "builder",
  });
  for (const name of TASK_TOOL_NAMES) expect(start.turn.tools).toContain(name);
  expect(start.turn.tools).toContain(BUILTIN_TOOLS.workSessionStart);
  const session = await sessionFrom(start);
  return { taskId, start, session };
}

/** The task continues on `event`'s turn waiting for the session, and that turn reports done. */
async function waitOnSession(event: Json, session: Session) {
  const c = await continueAs(s, event, { waitFor: { workSessionId: session.workSessionId } });
  expect(c.body, JSON.stringify(c.body)).toMatchObject({ ok: true, next: "on_session" });
  expect((await reportTurnDone(s, event.eventId as string, "replied", { agentId: builderId })).status).toBe(
    200,
  );
}

// ---------------------------------------------------------------- Task 1: the session wakes the task (tracer)

describe("tracer: a session a task turn started wakes the task as its own control turn (D-03, PD-14)", () => {
  let taskId: string;
  let start: Json;
  let session: Session;
  let wake: Json;
  let waitSeq: number;

  it("the task turn's ocw_work_session_start stores the task on the bot's session", async () => {
    ({ taskId, start, session } = await taskWithSession());
    expect(await botRowOf(session.workSessionId)).toMatchObject({
      task_id: taskId,
      requester_user_id: s.samId,
    });
  });

  it("the task waits on the session; its own continuation job delivers nothing while the session runs", async () => {
    await waitOnSession(start, session);
    await drainTaskJobs(s);
    expect(await taskEvents(s, taskId)).toEqual([]);
    const row = await taskRow(s, taskId);
    expect(row).toMatchObject({ status: "waiting", wait_kind: "session", wait_ref: session.workSessionId });
    waitSeq = row.wait_seq as number;
  });

  it("the session finishes its turn: one agent.work_session.v1 that is the task's next turn", async () => {
    await finishTurn(session);
    expect(await drainWakes()).toBeGreaterThan(0);
    const wakes = await wakesOf(session.workSessionId);
    expect(wakes).toHaveLength(1);
    wake = wakes[0] as Json;
    expect(AgentWorkSessionEvent.safeParse({ ...wake, seq: 1 }).success).toBe(true);
    expect(wake).toMatchObject({
      type: "agent.work_session.v1",
      agent: { id: builderId },
      message: { id: session.cardMessageId, author: { kind: "user", id: s.samId } },
      workSession: { workSessionId: session.workSessionId, transition: "turn_done" },
    });
    expect(wake.turn.task).toMatchObject({ taskId, status: "running", turnsUsed: 2, requesterId: s.samId });
    expect(taskTools(wake).sort()).toEqual([CONTINUE, FINISH].sort());
    expect(await turnOf(wake.eventId as string)).toMatchObject({ user_id: s.samId, task_id: taskId });
    expect(await taskRow(s, taskId)).toMatchObject({
      status: "running",
      turns_used: 2,
      current_event_id: wake.eventId,
      wait_seq: waitSeq + 1,
      wait_kind: null,
      wait_ref: null,
      wake_at: null,
    });
    const continued = await rowsOf(
      "select actor_kind, agent_id, user_id, metadata from app.audit_events where action = 'bot.task_continued' and resource_id::text = $1",
      [taskId],
    );
    expect(continued).toHaveLength(1);
    expect(continued[0]).toMatchObject({
      actor_kind: "agent",
      agent_id: builderId,
      user_id: s.samId,
      metadata: { taskId, eventId: wake.eventId, turnsUsed: 2, reason: "work_session" },
    });
  });

  it("the same state again, a re-run of the job and the task's own job: nothing more is delivered", async () => {
    await core().db.withTenant({ organizationId: s.orgA, userId: null }, (tx) =>
      core().jobs.sendInTx(tx, QUEUE, { organizationId: s.orgA, workSessionId: session.workSessionId }),
    );
    await drainWakes();
    expect(
      await syncBotWorkSession(core(), deps(), {
        organizationId: s.orgA,
        workSessionId: session.workSessionId,
      }),
    ).toBe("none");
    await drainTaskJobs(s);
    expect(await wakesOf(session.workSessionId)).toHaveLength(1);
    expect(await taskEvents(s, taskId)).toEqual([]);
    expect(await taskRow(s, taskId)).toMatchObject({ status: "running", turns_used: 2 });
  });

  it("the wake turn continues the task like any task turn of its own", async () => {
    const c = await continueAs(s, wake);
    expect(c.body, JSON.stringify(c.body)).toMatchObject({ ok: true, next: "after_turn" });
    expect(await taskRow(s, taskId)).toMatchObject({ status: "waiting", turns_used: 2 });
  });
});

describe("a session started by a turn without a task (PD-14)", () => {
  it("leaves bot_work_sessions.task_id null, and its wake is a plain 07.16 wake", async () => {
    await quiesce();
    const event = await deliverTaskTurn(s, {
      who: s.sam,
      conversationId: engId,
      agentId: builderId,
      handle: "builder",
    });
    expect(event.turn.task).toBeUndefined();
    const session = await sessionFrom(event);
    expect((await botRowOf(session.workSessionId)).task_id).toBeNull();
    await finishTurn(session);
    await drainWakes();
    const [wake] = await wakesOf(session.workSessionId);
    expect(wake?.turn.task).toBeUndefined();
    expect((await turnOf(wake?.eventId as string))?.task_id).toBeNull();
  });
});

describe("the task waits on its turn (no waitFor): the session's wake is its next turn, once", () => {
  it("one turn, not two: the queued continuation then finds the task running and delivers nothing", async () => {
    const { taskId, start, session } = await taskWithSession();
    expect((await continueAs(s, start)).body).toMatchObject({ ok: true, next: "after_turn" });
    expect((await reportTurnDone(s, start.eventId as string, "replied", { agentId: builderId })).status).toBe(
      200,
    );
    const before = await taskRow(s, taskId);
    expect(before).toMatchObject({ status: "waiting", wait_kind: "turn" });

    await finishTurn(session);
    await drainWakes();
    const [wake] = await wakesOf(session.workSessionId);
    expect(wake?.turn.task).toMatchObject({ taskId, turnsUsed: 2 });
    expect(taskTools(wake as Json).sort()).toEqual([CONTINUE, FINISH].sort());
    expect(await taskRow(s, taskId)).toMatchObject({
      status: "running",
      turns_used: 2,
      current_event_id: wake?.eventId,
      wait_seq: (before.wait_seq as number) + 1,
    });
    // The continuation job the done queued runs now: the task is running, nothing is delivered.
    await drainTaskJobs(s);
    expect(await taskEvents(s, taskId)).toEqual([]);
    expect(await taskRow(s, taskId)).toMatchObject({ status: "running", turns_used: 2 });
  });
});

describe("who the wake runs for and who pays (D-07, ADR-0019)", () => {
  it("Alex writes in the thread first: the wake's task turn is Sam's, authored by Sam, and meters the bot once", async () => {
    const { taskId, start, session } = await taskWithSession();
    await waitOnSession(start, session);
    const row = await taskRow(s, taskId);
    // Alex mentions the bot in the task's thread (this clears today's usage): his turn only sees the task.
    const alexTurn = await deliverTaskTurn(s, {
      who: s.alex,
      conversationId: engId,
      threadRootId: row.thread_root_id as string,
      agentId: builderId,
      handle: "builder",
    });
    expect(alexTurn.turn.task).toMatchObject({ taskId });
    expect(taskTools(alexTurn)).toEqual([]);
    expect(await turnOf(alexTurn.eventId as string)).toMatchObject({ user_id: s.alexId, task_id: null });
    const metered = await usageTurns(builderId);
    expect(metered).toBe(1);

    await finishTurn(session);
    await drainWakes();
    const [wake] = await wakesOf(session.workSessionId);
    expect(wake?.message.author).toMatchObject({ kind: "user", id: s.samId });
    expect(await turnOf(wake?.eventId as string)).toMatchObject({ user_id: s.samId, task_id: taskId });
    expect(await usageTurns(builderId)).toBe(metered + 1);
    const usage = (
      await rowsOf("select count(*)::int as n from app.ai_usage_records where requester_user_id = $1", [
        s.alexId,
      ])
    )[0] as { n: number };
    expect(usage.n).toBe(0);
  });
});

// ---------------------------------------------------------------- Task 2: budgets, busy, given back, mismatch

/** Stopped with `outcome` and one `@sam` message with `sentence`. */
async function expectStopped(taskId: string, outcome: string, sentence: string) {
  expect(await taskRow(s, taskId)).toMatchObject({
    status: "stopped",
    outcome,
    wait_kind: null,
    wake_at: null,
  });
  const posted = await endMessagesOf(s, taskId);
  expect(posted.map((m) => m.body)).toEqual([`@sam ${sentence}`]);
  const stops = await rowsOf(
    "select metadata from app.audit_events where action = 'bot.task_stopped' and resource_id::text = $1",
    [taskId],
  );
  expect(stops).toHaveLength(1);
  expect(stops[0]?.metadata).toMatchObject({ taskId, outcome });
}

/**
 * A plain wake of a session whose task ended: no task facts and no task tool (a wake of a session a task started never
 * starts another task: the budget it ran out of stays spent), a turn linked to no task.
 */
async function expectPlainWake(session: Session): Promise<Json> {
  const wakes = await wakesOf(session.workSessionId);
  expect(wakes).toHaveLength(1);
  const wake = wakes[0] as Json;
  expect(wake.turn.task).toBeUndefined();
  expect(taskTools(wake)).toEqual([]);
  expect((await turnOf(wake.eventId as string))?.task_id).toBeNull();
  return wake;
}

describe("over budget when the wake comes (D-04, PD-09)", () => {
  it("every turn used: the task stops budget_turns with one message, the wake goes out plain", async () => {
    const { taskId, start, session } = await taskWithSession();
    await waitOnSession(start, session);
    await setTask(s, taskId, { max_turns: 3, turns_used: 3 });
    await finishTurn(session);
    await drainWakes();
    await expectPlainWake(session);
    await expectStopped(
      taskId,
      "budget_turns",
      "I stopped this task after 3 turns, the limit for one task. The card shows where it got to.",
    );
    expect((await taskRow(s, taskId)).turns_used).toBe(3);
  });

  it("past its deadline: the task stops budget_time with one message, the wake goes out plain", async () => {
    const { taskId, start, session } = await taskWithSession();
    await waitOnSession(start, session);
    const row = await taskRow(s, taskId);
    const shift = 9 * 3_600_000;
    await setTask(s, taskId, {
      started_at: new Date(new Date(row.started_at as string).getTime() - shift),
      deadline_at: new Date(new Date(row.deadline_at as string).getTime() - shift),
    });
    await finishTurn(session);
    await drainWakes();
    await expectPlainWake(session);
    await expectStopped(
      taskId,
      "budget_time",
      "I stopped this task after 8 h, the limit for one task. The card shows where it got to.",
    );
  });
});

describe("a wake while another turn of the task runs: a view turn (PD-07, PD-14)", () => {
  it("turn.task without the task tools; the task unchanged", async () => {
    const { taskId, start, session } = await taskWithSession();
    // The start turn is still the task's running turn (no continue yet).
    const before = await taskRow(s, taskId);
    expect(before).toMatchObject({ status: "running", current_event_id: start.eventId });
    await finishTurn(session);
    await drainWakes();
    const [wake] = await wakesOf(session.workSessionId);
    expect(wake?.turn.task).toMatchObject({ taskId, status: "running", turnsUsed: 1 });
    expect(taskTools(wake as Json)).toEqual([]);
    expect((await turnOf(wake?.eventId as string))?.task_id).toBeNull();
    const after = await taskRow(s, taskId);
    expect(after).toMatchObject({
      status: "running",
      turns_used: before.turns_used,
      current_event_id: before.current_event_id,
      wait_seq: before.wait_seq,
    });
  });
});

describe("a session without a task in the thread of a waiting task (PD-07, PD-14)", () => {
  it("started before ocw_task_start on the same turn: its wake only sees the task, which keeps waiting uncounted", async () => {
    await quiesce();
    const start = await deliverTaskTurn(s, {
      who: s.sam,
      conversationId: engId,
      agentId: builderId,
      handle: "builder",
    });
    const session = await sessionFrom(start);
    expect((await botRowOf(session.workSessionId)).task_id).toBeNull();
    const res = await s.cell("/tasks/start", {
      eventId: start.eventId,
      agentId: builderId,
      goal: "Fix the totals",
    });
    expect(res.body, JSON.stringify(res.body)).toMatchObject({ ok: true });
    const taskId = res.body?.taskId as string;
    expect((await continueAs(s, start)).body).toMatchObject({ ok: true, next: "after_turn" });
    const before = await taskRow(s, taskId);
    expect(before).toMatchObject({ status: "waiting", wait_kind: "turn" });

    await finishTurn(session);
    await drainWakes();
    const [wake] = await wakesOf(session.workSessionId);
    // Same requester, same thread, the task waiting: still not the task's turn (its wait was not consumed).
    expect(wake?.message.author).toMatchObject({ id: s.samId });
    expect(wake?.turn.task).toMatchObject({ taskId, status: "waiting" });
    expect(taskTools(wake as Json)).toEqual([]);
    expect((await turnOf(wake?.eventId as string))?.task_id).toBeNull();
    expect(await taskRow(s, taskId)).toMatchObject({
      status: "waiting",
      turns_used: before.turns_used,
      current_event_id: before.current_event_id,
      wait_seq: before.wait_seq,
    });
  });
});

describe("a wake whose delivery is given back (the bot's daily turn limit) restores the task's wait", () => {
  it("the task waits again with its previous wait_seq, turns_used and current_event_id; once the limit lifts it wakes", async () => {
    const { taskId, start, session } = await taskWithSession();
    await waitOnSession(start, session);
    const before = await taskRow(s, taskId);
    await s.su.query("update app.agent_usage_daily set turns = 1000000 where agent_id = $1", [builderId]);
    try {
      await finishTurn(session);
      await drainWakes();
      expect(await wakesOf(session.workSessionId)).toEqual([]);
      const after = await taskRow(s, taskId);
      expect(after).toMatchObject({
        status: "waiting",
        turns_used: before.turns_used,
        current_event_id: before.current_event_id,
        wait_seq: before.wait_seq,
        wait_kind: "session",
        wait_ref: session.workSessionId,
      });
      expect(new Date(after.wake_at as string).getTime()).toBe(new Date(before.wake_at as string).getTime());
      expect((await botRowOf(session.workSessionId)).wakes_used).toBe(0);
    } finally {
      await s.su.query("delete from app.agent_usage_daily");
    }
    // The next run of the session's job wakes the task as its own turn (07.16 WR-09: the skip was transient).
    await core().db.withTenant({ organizationId: s.orgA, userId: null }, (tx) =>
      core().jobs.sendInTx(tx, QUEUE, { organizationId: s.orgA, workSessionId: session.workSessionId }),
    );
    await drainWakes();
    const [wake] = await wakesOf(session.workSessionId);
    expect(wake?.turn.task).toMatchObject({ taskId, turnsUsed: 2 });
    expect(await taskRow(s, taskId)).toMatchObject({
      status: "running",
      turns_used: 2,
      current_event_id: wake?.eventId,
      wait_seq: (before.wait_seq as number) + 1,
    });
  });
});

describe("a session of another person bound to the task (a forged task_id, T-07.17.1.1.2-12-03)", () => {
  it("Alex's session wakes plain and Sam's waiting task is unchanged", async () => {
    const { taskId, start, session: own } = await taskWithSession();
    await waitOnSession(start, own);
    const before = await taskRow(s, taskId);
    // Alex asks the bot in his own thread; that turn starts a session, then the test binds it to Sam's task.
    const alexTurn = await deliverTaskTurn(s, {
      who: s.alex,
      conversationId: engId,
      agentId: builderId,
      handle: "builder",
    });
    const forged = await sessionFrom(alexTurn);
    await s.su.query("update app.bot_work_sessions set task_id = $2 where work_session_id = $1", [
      forged.workSessionId,
      taskId,
    ]);
    await finishTurn(forged);
    await drainWakes();
    const [wake] = await wakesOf(forged.workSessionId);
    expect(wake?.message.author).toMatchObject({ id: s.alexId });
    expect(wake?.turn.task).toBeUndefined();
    expect((await turnOf(wake?.eventId as string))?.task_id).toBeNull();
    // Alex's own wake in his own thread, as any plain wake of a bot that may run long tasks: offered a start of its own.
    expect(taskTools(wake as Json).sort()).toEqual([...TASK_TOOL_NAMES].sort());
    expect(await taskRow(s, taskId)).toMatchObject({
      status: "waiting",
      turns_used: before.turns_used,
      current_event_id: before.current_event_id,
      wait_seq: before.wait_seq,
      wait_kind: "session",
    });
  });
});
