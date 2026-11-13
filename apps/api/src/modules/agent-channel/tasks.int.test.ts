import { createHash, randomUUID } from "node:crypto";
import { BUILTIN_TOOLS } from "@ocw/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventually } from "../../testing-device";
import { type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import {
  continueAs,
  deliverTaskTurn,
  drainTaskJobs,
  finishAs,
  reportTurnDone,
  setTask,
  startTaskFor,
  TASK_GOAL,
  TASK_NEXT_STEP,
  TASK_PROGRESS,
  taskEvents,
  taskRow,
} from "../../testing-tasks";

/**
 * Phase 07.17.1.1.2-08 (D-01, D-02, D-05, D-13; PD-05, PD-08, PD-11, PD-19; BTASK-01, BTASK-02, BTASK-09): a bot's long
 * task through the Agent Channel API, end to end on real PostgreSQL and Redis. A delivered turn starts a task: one row
 * in the turn's thread, the turn's ledger linked to it, one platform-owned `task` card the requester follows, one
 * `bot.task_started` audit and one uncounted tool call.
 *
 * People: Sam Lee asks (the requester); Alex Kim is another member of #eng; Víctor is the admin. Scout is the team bot.
 */

let s: SandboxStack;
let engId: string;

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

const turnRow = async (eventId: string) =>
  (await s.su.query("select task_id, tool_calls from app.agent_turns where event_id = $1", [eventId]))
    .rows[0] as { task_id: string | null; tool_calls: number };

const cardOf = async (messageId: string) =>
  (
    await s.su.query(
      `select m.conversation_id, m.thread_id, m.author_kind, m.author_id, m.body, c.kind, c.title, c.status,
              c.status_label, c.fields, c.notices, c.platform_owned, c.version
         from app.messages m join app.message_cards c on c.message_id = m.id where m.id = $1`,
      [messageId],
    )
  ).rows[0] as Json | undefined;

describe("tracer: a delivered turn starts a task (PD-08, PD-11)", () => {
  it("a mention in #eng starts a task: the row, the ledger link, the live card Sam follows, the audit", async () => {
    const before = Date.now();
    const { taskId, event, answer } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    expect(answer).toMatchObject({ ok: true, taskId, maxTurns: 40 });
    const deadline = Date.parse(answer.deadlineAt as string);
    expect(deadline).toBeGreaterThanOrEqual(before + 8 * 3_600_000 - 5_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 8 * 3_600_000 + 5_000);

    const row = await taskRow(s, taskId);
    expect(row).toMatchObject({
      organization_id: s.orgA,
      agent_id: s.scoutId,
      conversation_id: engId,
      requester_user_id: s.samId,
      status: "running",
      turns_used: 1,
      max_turns: 40,
      started_event_id: event.eventId,
      current_event_id: event.eventId,
      goal: TASK_GOAL,
      wait_seq: 0,
      outcome: null,
      finished_at: null,
    });
    // The mention is at the channel's root: its thread is the message itself.
    expect(row.thread_root_id).toBe(event.message.id);
    expect(row.card_message_id).toEqual(expect.any(String));

    const turn = await turnRow(event.eventId as string);
    expect(turn.task_id).toBe(taskId);
    // D-13: the start is outside the cap of 8.
    expect(turn.tool_calls).toBe(0);

    const card = await cardOf(row.card_message_id as string);
    expect(card).toMatchObject({
      conversation_id: engId,
      thread_id: event.message.id,
      author_kind: "agent",
      author_id: s.scoutId,
      kind: "task",
      title: TASK_GOAL,
      status: "running",
      status_label: "Working",
      platform_owned: true,
    });
    const follows = (
      await s.su.query("select user_id from app.message_card_follows where message_id = $1", [
        row.card_message_id,
      ])
    ).rows;
    expect(follows).toEqual([{ user_id: s.samId }]);
    const created = (
      await s.su.query(
        "select 1 from app.stream_events where stream_id = $1 and type = 'message.created' and payload->'message'->>'id' = $2",
        [`conv:${engId}`, row.card_message_id],
      )
    ).rows;
    expect(created).toHaveLength(1);

    const started = await auditsOf("bot.task_started", taskId);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      actor_kind: "agent",
      actor_id: s.scoutId,
      agent_id: s.scoutId,
      user_id: s.samId,
      resource_type: "bot_task",
      resource_id: taskId,
      result: "success",
    });
    expect(started[0]?.metadata).toEqual({
      taskId,
      conversationId: engId,
      eventId: event.eventId,
      turnsUsed: 1,
      maxTurns: 40,
    });

    const calls = (
      await s.su.query(
        "select tool, decision, reason, target from app.agent_tool_calls where event_id = $1 and tool = $2",
        [event.eventId, START],
      )
    ).rows;
    expect(calls).toEqual([{ tool: START, decision: "allowed", reason: null, target: taskId }]);
  });

  it("a mention in Sam's DM starts a task with no thread, and its card is posted flat in the DM", async () => {
    const { taskId } = await startTaskFor(s, { who: s.sam, conversationId: s.samDm, handle: null });
    const row = await taskRow(s, taskId);
    expect(row.thread_root_id).toBeNull();
    expect(row.conversation_id).toBe(s.samDm);
    const card = await cardOf(row.card_message_id as string);
    expect(card).toMatchObject({
      conversation_id: s.samDm,
      thread_id: null,
      kind: "task",
      platform_owned: true,
    });
  });

  it("a second start in the same thread is task_active; another thread starts its own task", async () => {
    const event = await deliverTaskTurn(s, { who: s.sam, conversationId: engId });
    // Sam replies in the thread before the bot starts: that turn is offered the start too.
    const second = await deliverTaskTurn(s, {
      who: s.sam,
      conversationId: engId,
      threadRootId: event.message.id,
    });
    expect(second.turn.tools).toContain(START);
    const first = await s.cell("/tasks/start", {
      eventId: event.eventId,
      agentId: s.scoutId,
      goal: TASK_GOAL,
    });
    expect(first.body, JSON.stringify(first.body)).toMatchObject({ ok: true });
    const taskId = first.body?.taskId as string;
    const late = await s.cell("/tasks/start", { eventId: second.eventId, agentId: s.scoutId, goal: "Again" });
    expect(late.status).toBe(200);
    expect(late.body).toMatchObject({ ok: false, code: "task_active" });
    // The same turn starting twice (the plugin's once-per-turn bypassed): the API's own bound (code review WR-06).
    const twice = await s.cell("/tasks/start", { eventId: event.eventId, agentId: s.scoutId, goal: "Again" });
    expect(twice.body).toMatchObject({ ok: false, code: "once_per_turn" });
    expect(
      (
        await s.su.query("select count(*)::int as n from app.bot_tasks where thread_root_id = $1", [
          event.message.id,
        ])
      ).rows[0].n,
    ).toBe(1);
    const refused = await s.su.query(
      "select result, metadata from app.audit_events where action = 'bot.task_refused' and metadata->>'eventId' = $1",
      [second.eventId],
    );
    expect(refused.rows).toEqual([
      {
        result: "denied",
        metadata: {
          taskId,
          conversationId: engId,
          eventId: second.eventId,
          tool: START,
          code: "task_active",
        },
      },
    ]);
    // Sam asks again in the same thread: that turn is a view of the running task (no start tool) …
    const again = await deliverTaskTurn(s, {
      who: s.sam,
      conversationId: engId,
      threadRootId: event.message.id,
    });
    expect(again.turn.tools).not.toContain(START);
    // … and a new message at the channel's root is another thread.
    const other = await startTaskFor(s, { who: s.alex, conversationId: engId });
    expect((await taskRow(s, other.taskId)).requester_user_id).toBe(s.alexId);
  });
});

// ---------------------------------------------------------------- continue and finish (Task 2)

const CONTINUE = BUILTIN_TOOLS.taskContinue;
const MIN = 60_000;

/** `at` within `slackMs` of `expected` (both epoch ms). */
function near(at: unknown, expected: number, slackMs = 5_000) {
  const ms = new Date(at as string).getTime();
  expect(
    Math.abs(ms - expected),
    `${new Date(ms).toISOString()} vs ${new Date(expected).toISOString()}`,
  ).toBeLessThan(slackMs);
}

const jobsOf = async (taskId: string) =>
  (
    await s.su.query(
      "select data, start_after from pgboss.job where name = 'bot_task.continue' and data->>'taskId' = $1 order by created_on",
      [taskId],
    )
  ).rows as Array<{ data: Json; start_after: string }>;

/** The bot's plain (card-less) messages in the task's thread (or its DM). */
async function botMessagesOf(taskId: string): Promise<Json[]> {
  const row = await taskRow(s, taskId);
  return (
    await s.su.query(
      `select m.body from app.messages m left join app.message_cards c on c.message_id = m.id
        where m.conversation_id = $1 and m.author_kind = 'agent' and c.message_id is null
          and m.thread_id is not distinct from $2 order by m.created_at`,
      [row.conversation_id, row.thread_root_id],
    )
  ).rows as Json[];
}

/** A task started in a new #eng thread, then continued on its start turn: it waits, so Sam's next turn controls it. */
async function waitingTask(): Promise<{ taskId: string; start: Json }> {
  const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
  const res = await continueAs(s, event);
  expect(res.body, JSON.stringify(res.body)).toMatchObject({ ok: true });
  return { taskId, start: event };
}

/** Sam's own message in the task's thread while it waits: a control turn (continue and finish, the ledger link). */
async function controlTurn(start: Json): Promise<Json> {
  const ev = await deliverTaskTurn(s, { who: s.sam, conversationId: engId, threadRootId: start.message.id });
  expect(ev.turn.tools).toContain(CONTINUE);
  return ev;
}

/** A bot Work Zone session in organization A (device, project, conversation, session), linked to `taskId`. */
async function seedSession(taskId: string | null): Promise<string> {
  const dev = randomUUID();
  const proj = randomUUID();
  const conv = randomUUID();
  const ws = randomUUID();
  await s.su.query(
    "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash, shared, status, runtime_info) values ($1, $2, $3, 'mac', 'darwin', $4, true, 'online', '[]')",
    [dev, s.orgA, s.victorId, createHash("sha256").update(randomUUID()).digest("hex")],
  );
  await s.su.query(
    "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, $4, 'pack')",
    [proj, s.orgA, dev, `l-${proj.slice(0, 8)}`],
  );
  await s.su.query(
    "insert into app.conversations (id, organization_id, kind, name) values ($1, $2, 'work_session', 'pack')",
    [conv, s.orgA],
  );
  await s.su.query(
    "insert into app.work_sessions (id, organization_id, conversation_id, project_id, device_id, title, created_by, status, started_by_agent_id) values ($1, $2, $3, $4, $5, 'Pack', $6, 'running', $7)",
    [ws, s.orgA, conv, proj, dev, s.victorId, s.scoutId],
  );
  await s.su.query(
    "insert into app.bot_work_sessions (work_session_id, organization_id, agent_id, sponsor_user_id, requester_user_id, origin_conversation_id, origin_message_id, origin_event_id, task_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [ws, s.orgA, s.scoutId, s.victorId, s.samId, engId, randomUUID(), randomUUID(), taskId],
  );
  return ws;
}

describe("continue: the waits (PD-05)", () => {
  it("on the start turn without a wait: after_turn, the 30-minute backstop, one ids-only job, the card Waiting", async () => {
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    const before = Date.now();
    const res = await continueAs(s, event);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, next: "after_turn", at: null, turnsLeft: 39, quiet: false });
    const row = await taskRow(s, taskId);
    expect(row).toMatchObject({
      status: "waiting",
      wait_kind: "turn",
      wait_ref: null,
      wait_seq: 1,
      nudged: false,
      progress: TASK_PROGRESS,
      next_step: TASK_NEXT_STEP,
      turns_used: 1,
    });
    near(row.wake_at, before + 30 * MIN);
    const jobs = await jobsOf(taskId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({ organizationId: s.orgA, taskId });
    near(jobs[0]?.start_after, new Date(row.wake_at as string).getTime(), 1_000);
    const card = (
      await s.su.query("select status, status_label, fields from app.message_cards where message_id = $1", [
        row.card_message_id,
      ])
    ).rows[0] as Json;
    expect(card).toEqual({
      status: "running",
      status_label: "Waiting",
      fields: [
        { label: "Progress", value: TASK_PROGRESS },
        { label: "Next step", value: TASK_NEXT_STEP },
      ],
    });
    // D-13: neither the start nor the continue counted on the turn.
    expect(
      (await s.su.query("select tool_calls from app.agent_turns where event_id = $1", [event.eventId]))
        .rows[0],
    ).toEqual({ tool_calls: 0 });
  });

  it("timers: 120 s, capped at the deadline, at least the 5-second gap", async () => {
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    let before = Date.now();
    const timer = await continueAs(s, event, { afterSeconds: 120 });
    expect(timer.body).toMatchObject({ ok: true, next: "at", turnsLeft: 39 });
    let row = await taskRow(s, taskId);
    expect(row.wait_kind).toBe("timer");
    near(row.wake_at, before + 120_000);
    near(timer.body?.at, new Date(row.wake_at as string).getTime(), 1);

    // Each later continue comes from Sam's next turn in the thread (one continue per turn, code review WR-06).
    const deadline = new Date(Date.now() + 60_000);
    await setTask(s, taskId, { deadline_at: deadline });
    const capped = await continueAs(s, await controlTurn(event), { afterSeconds: 120 });
    expect(capped.body).toMatchObject({ ok: true, next: "at" });
    row = await taskRow(s, taskId);
    expect(new Date(row.wake_at as string).getTime()).toBe(deadline.getTime());

    await setTask(s, taskId, { deadline_at: new Date(Date.now() + 8 * 60 * MIN) });
    before = Date.now();
    await continueAs(s, await controlTurn(event), { afterSeconds: 3 });
    row = await taskRow(s, taskId);
    near(row.wake_at, before + 5_000, 2_000);
    expect(row.wait_seq).toBe(3);
  });

  it("waitFor a process of this task: running waits for it, ended goes on after the turn, others are unknown", async () => {
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    const other = await startTaskFor(s, { who: s.alex, conversationId: engId });
    const processDeadline = new Date(Date.now() + 15 * MIN);
    const seed = (task: string, processId: string, status: string) =>
      s.su.query(
        `insert into app.bot_task_processes (organization_id, task_id, agent_id, process_id, event_id, status, deadline_at, ended_at)
         values ($1, $2, $3, $4, $5, $6::text, $7, case when $6::text = 'running' then null else now() end)`,
        [s.orgA, task, s.scoutId, processId, randomUUID(), status, processDeadline.toISOString()],
      );
    await seed(taskId, "p-running-1", "running");
    await seed(taskId, "p-ended-1", "exited");
    await seed(other.taskId, "p-other-1", "running");

    const running = await continueAs(s, event, { waitFor: { processId: "p-running-1" } });
    expect(running.body).toMatchObject({ ok: true, next: "on_process" });
    let row = await taskRow(s, taskId);
    expect(row).toMatchObject({ wait_kind: "process", wait_ref: "p-running-1" });
    expect(new Date(row.wake_at as string).getTime()).toBe(processDeadline.getTime());

    // Sam's next turns in the thread (one continue per turn, code review WR-06).
    const ended = await continueAs(s, await controlTurn(event), { waitFor: { processId: "p-ended-1" } });
    expect(ended.body).toMatchObject({ ok: true, next: "after_turn" });
    expect((await taskRow(s, taskId)).wait_kind).toBe("turn");

    const seqBefore = (await taskRow(s, taskId)).wait_seq;
    const next = await controlTurn(event);
    for (const processId of ["p-other-1", "p-missing-1"]) {
      const unknown = await continueAs(s, next, { waitFor: { processId } });
      expect(unknown.body).toMatchObject({ ok: false, code: "wait_unknown" });
    }
    row = await taskRow(s, taskId);
    expect(row.wait_seq).toBe(seqBefore);
  });

  it("waitFor a Work Zone session this task started: on_session for an hour; another session is unknown", async () => {
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    const mine = await seedSession(taskId);
    const theirs = await seedSession(null);
    const before = Date.now();
    const res = await continueAs(s, event, { waitFor: { workSessionId: mine } });
    expect(res.body).toMatchObject({ ok: true, next: "on_session" });
    const row = await taskRow(s, taskId);
    expect(row).toMatchObject({ wait_kind: "session", wait_ref: mine });
    near(row.wake_at, before + 60 * MIN);
    const unknown = await continueAs(s, await controlTurn(event), { waitFor: { workSessionId: theirs } });
    expect(unknown.body).toMatchObject({ ok: false, code: "wait_unknown" });
  });
});

describe("continue: the cadence, the busy rule, no task (D-11, PD-10, E16, E23)", () => {
  it("a platform-delivered task turn is quiet inside the cadence and posts at the fifth turn or after 10 minutes", async () => {
    const { taskId, start } = await waitingTask();
    // The platform delivers each next turn (an `agent.task.v1` continuation, one continue per turn, code review WR-06;
    // only such a turn may be quiet, IN-09); the cadence fields are then set as the case needs.
    let previous = start;
    const delivered = async (patch: Record<string, unknown>) => {
      expect((await reportTurnDone(s, previous.eventId as string)).status).toBe(200);
      await drainTaskJobs(s);
      const turn = (await taskEvents(s, taskId)).at(-1) as Json;
      expect(turn.eventId).not.toBe(previous.eventId);
      previous = turn;
      await setTask(s, taskId, patch);
      return turn;
    };
    // Three turns in, last post two minutes ago.
    let turn = await delivered({
      turns_used: 3,
      last_post_turn: 1,
      last_post_at: new Date(Date.now() - 2 * MIN),
    });
    const quiet = await continueAs(s, turn);
    expect(quiet.body).toMatchObject({ ok: true, quiet: true, turnsLeft: 37 });
    let row = await taskRow(s, taskId);
    expect(row.last_post_turn).toBe(1);

    turn = await delivered({
      turns_used: 6,
      last_post_turn: 1,
      last_post_at: new Date(Date.now() - 2 * MIN),
    });
    const fifth = await continueAs(s, turn);
    expect(fifth.body).toMatchObject({ ok: true, quiet: false });
    row = await taskRow(s, taskId);
    expect(row.last_post_turn).toBe(6);
    near(row.last_post_at, Date.now());

    turn = await delivered({
      turns_used: 7,
      last_post_turn: 6,
      last_post_at: new Date(Date.now() - 11 * MIN),
    });
    expect((await continueAs(s, turn)).body).toMatchObject({ ok: true, quiet: false });
  });

  it("Sam's own control turn while the task waits is never quiet", async () => {
    const { taskId, start } = await waitingTask();
    await setTask(s, taskId, { turns_used: 3, last_post_turn: 1, last_post_at: new Date() });
    const turn = await controlTurn(start);
    expect((await continueAs(s, turn)).body).toMatchObject({ ok: true, quiet: false });
    expect((await taskRow(s, taskId)).last_post_turn).toBe(3);
  });

  it("busy: while another turn of the task runs, Sam's control turn is refused and the row is unchanged", async () => {
    const { taskId, start } = await waitingTask();
    const turn = await controlTurn(start);
    await setTask(s, taskId, {
      status: "running",
      wait_kind: null,
      wake_at: null,
      current_event_id: randomUUID(),
    });
    const before = await taskRow(s, taskId);
    const res = await continueAs(s, turn);
    expect(res.body).toMatchObject({ ok: false, code: "task_busy" });
    expect(await taskRow(s, taskId)).toEqual(before);
  });

  it("continue or finish on a turn without a task: no_task", async () => {
    const event = await deliverTaskTurn(s, { who: s.sam, conversationId: engId });
    expect((await continueAs(s, event)).body).toMatchObject({ ok: false, code: "no_task" });
    expect((await finishAs(s, event, { summary: "Nothing", outcome: "done" })).body).toMatchObject({
      ok: false,
      code: "no_task",
    });
  });
});

describe("code review WR-06: the API bounds one turn's task calls", () => {
  const callsOf = async (eventId: string) =>
    (
      await s.su.query(
        "select tool, decision, reason from app.agent_tool_calls where event_id = $1 and tool like 'ocw_task_%' order by created_at",
        [eventId],
      )
    ).rows as Json[];

  it("a second continue of the turn that continued is refused once_per_turn: the wait, the job and the card are unchanged", async () => {
    const { taskId, start } = await waitingTask();
    const before = await taskRow(s, taskId);
    const card = await cardOf(before.card_message_id as string);
    const jobs = async () =>
      (
        (
          await s.su.query(
            "select count(*)::int as n from pgboss.job where name = 'bot_task.continue' and data->>'taskId' = $1",
            [taskId],
          )
        ).rows[0] as { n: number }
      ).n;
    const queued = await jobs();
    const again = await continueAs(s, start, { afterSeconds: 60 });
    expect(again.body).toMatchObject({ ok: false, code: "once_per_turn" });
    expect(await taskRow(s, taskId)).toEqual(before);
    expect((await cardOf(before.card_message_id as string))?.version).toBe(card?.version);
    expect(await jobs()).toBe(queued);
    // The other tool of the turn still works: the turn finishes its task.
    expect((await finishAs(s, start, { summary: "Read it all", outcome: "done" })).body).toMatchObject({
      ok: true,
    });
    expect((await finishAs(s, start, { summary: "Again", outcome: "done" })).body).toMatchObject({
      ok: false,
      code: "once_per_turn",
    });
  });

  it("refusals count: after six task calls of one turn every further call is refused once_per_turn", async () => {
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    for (let i = 0; i < 5; i++) {
      const r = await continueAs(s, event, { waitFor: { workSessionId: randomUUID() } });
      expect(r.body, `call ${i + 2}`).toMatchObject({ ok: false, code: "wait_unknown" });
    }
    const capped = await continueAs(s, event);
    expect(capped.body).toMatchObject({ ok: false, code: "once_per_turn" });
    expect(await taskRow(s, taskId)).toMatchObject({ status: "running", wait_kind: null });
    const calls = await callsOf(event.eventId as string);
    expect(calls).toHaveLength(7);
    expect(calls.at(-1)).toMatchObject({ tool: CONTINUE, decision: "denied", reason: "once_per_turn" });
  });
});

describe("continue: the budgets and the policy stop the task with one message (D-04, PD-09, PD-18, E7, E8, E11)", () => {
  async function expectStopped(taskId: string, outcome: string, notice: string, sentence: string) {
    const row = await taskRow(s, taskId);
    expect(row).toMatchObject({ status: "stopped", outcome, wait_kind: null, wake_at: null });
    expect(row.finished_at).not.toBeNull();
    const card = (
      await s.su.query("select status, status_label, notices from app.message_cards where message_id = $1", [
        row.card_message_id,
      ])
    ).rows[0] as Json;
    expect(card).toEqual({
      status: "cancelled",
      status_label: "Stopped",
      notices: [{ tone: "neutral", text: notice }],
    });
    const posted = await eventually(async () => {
      const m = await botMessagesOf(taskId);
      return m.length > 0 ? m : undefined;
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toBe(`@sam ${sentence}`);
    const stops = await auditsOf("bot.task_stopped", taskId);
    expect(stops).toHaveLength(1);
    expect(stops[0]?.metadata).toMatchObject({ taskId, outcome, turnsUsed: row.turns_used });
    expect(await jobsOf(taskId)).toEqual([]);
  }

  it("all its turns used: budget_turns, stopped, the card's notice and @sam once", async () => {
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    await setTask(s, taskId, { turns_used: 40 });
    const seq = (await taskRow(s, taskId)).wait_seq as number;
    const res = await continueAs(s, event);
    expect(res.body).toMatchObject({ ok: false, code: "budget_turns" });
    await expectStopped(
      taskId,
      "budget_turns",
      "Stopped: it used its 40 turns.",
      "I stopped this task after 40 turns, the limit for one task. The card shows where it got to.",
    );
    expect((await taskRow(s, taskId)).wait_seq).toBe(seq + 1);
  });

  it("past its deadline: budget_time", async () => {
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    const row = await taskRow(s, taskId);
    // Eight hours from start, moved into the past together (the task's hour budget stays 8).
    const shift = 9 * 60 * MIN;
    await setTask(s, taskId, {
      started_at: new Date(new Date(row.started_at as string).getTime() - shift),
      deadline_at: new Date(new Date(row.deadline_at as string).getTime() - shift),
    });
    const res = await continueAs(s, event);
    expect(res.body).toMatchObject({ ok: false, code: "budget_time" });
    await expectStopped(
      taskId,
      "budget_time",
      "Stopped: it ran for 8 h.",
      "I stopped this task after 8 h, the limit for one task. The card shows where it got to.",
    );
  });

  it("long tasks turned off for the bot since the start: policy_off", async () => {
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    await s.su.query(
      "update app.agents set capabilities = capabilities || jsonb_build_object('longTasks', false) where id = $1",
      [s.scoutId],
    );
    try {
      const res = await continueAs(s, event);
      expect(res.body).toMatchObject({ ok: false, code: "policy_off" });
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
});

describe("finish (D-02, PD-18)", () => {
  it("done: the card Done and succeeded, Sam notified as a follower, no message; then a continue is task_stopped", async () => {
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    const card = (await taskRow(s, taskId)).card_message_id as string;
    await s.su.query("delete from app.notifications where user_id = $1 and message_id = $2", [s.samId, card]);
    const summary = "Summarised the pack:\nthree findings";
    const res = await finishAs(s, event, { summary, outcome: "done" });
    expect(res.body).toEqual({ ok: true, status: "done" });
    const row = await taskRow(s, taskId);
    expect(row).toMatchObject({ status: "done", outcome: "done", summary, wait_kind: null });
    expect(row.finished_at).not.toBeNull();
    expect(
      (await s.su.query("select status, status_label from app.message_cards where message_id = $1", [card]))
        .rows[0],
    ).toEqual({ status: "succeeded", status_label: "Done" });
    expect(
      (
        await s.su.query("select kind from app.notifications where user_id = $1 and message_id = $2", [
          s.samId,
          card,
        ])
      ).rows,
    ).toEqual([{ kind: "card_updated" }]);
    expect(await auditsOf("bot.task_finished", taskId)).toHaveLength(1);

    // The turn's finish already succeeded (code review WR-06: the API refuses it again on that turn).
    const again = await finishAs(s, event, { summary: "Again", outcome: "done" });
    expect(again.body).toMatchObject({ ok: false, code: "once_per_turn" });
    expect((await continueAs(s, event)).body).toMatchObject({ ok: false, code: "task_stopped" });
    // A finish done posts nothing besides the card.
    await new Promise((r) => setTimeout(r, 300));
    expect(await botMessagesOf(taskId)).toEqual([]);
  });

  it("blocked: failed, the card Blocked, one message mentioning Sam", async () => {
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    const res = await finishAs(s, event, { summary: "I need the export password", outcome: "blocked" });
    expect(res.body).toEqual({ ok: true, status: "failed" });
    const row = await taskRow(s, taskId);
    expect(row).toMatchObject({ status: "failed", outcome: "blocked" });
    expect(
      (
        await s.su.query("select status, status_label from app.message_cards where message_id = $1", [
          row.card_message_id,
        ])
      ).rows[0],
    ).toEqual({ status: "failed", status_label: "Blocked" });
    const posted = await eventually(async () => {
      const m = await botMessagesOf(taskId);
      return m.length > 0 ? m : undefined;
    });
    expect(posted.map((m) => m.body)).toEqual([
      "@sam I need you to go on with this task. See my reply in this conversation.",
    ]);
    const finished = await auditsOf("bot.task_finished", taskId);
    expect(finished).toHaveLength(1);
    expect(finished[0]?.metadata).toMatchObject({ taskId, outcome: "blocked" });
  });
});

describe("no goal, note or summary in any record of this suite (P1, PD-19, E24)", () => {
  it("after every case above: audit rows, tool calls, jobs and log lines carry none of the bot's text", async () => {
    // The after-commit messages of the cases above have been posted (their logs and audits are part of the scan).
    await new Promise((r) => setTimeout(r, 300));
    for (const text of [
      TASK_GOAL,
      TASK_PROGRESS,
      TASK_NEXT_STEP,
      "three findings",
      "I need the export password",
    ]) {
      for (const table of ["app.audit_events", "app.agent_tool_calls", "pgboss.job"]) {
        const n = (
          await s.su.query(
            `select count(*)::int as n from ${table} t where strpos(row_to_json(t)::text, $1) > 0`,
            [text],
          )
        ).rows[0].n;
        expect(n, `${table} carries "${text}"`).toBe(0);
      }
      expect(
        s.logs.filter((line) => line.includes(text)),
        `a log line carries "${text}"`,
      ).toEqual([]);
    }
  });
});
