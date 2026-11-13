import { BUILTIN_TOOLS } from "@ocw/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import { deliverTaskTurn, startTaskFor, TASK_GOAL, taskRow } from "../../testing-tasks";

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
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    // The same turn starting twice (the plugin's once-per-turn bypassed): one task, the second refused.
    const twice = await s.cell("/tasks/start", { eventId: event.eventId, agentId: s.scoutId, goal: "Again" });
    expect(twice.status).toBe(200);
    expect(twice.body).toMatchObject({ ok: false, code: "task_active" });
    expect(
      (
        await s.su.query("select count(*)::int as n from app.bot_tasks where thread_root_id = $1", [
          event.message.id,
        ])
      ).rows[0].n,
    ).toBe(1);
    const refused = await s.su.query(
      "select result, metadata from app.audit_events where action = 'bot.task_refused' and metadata->>'eventId' = $1",
      [event.eventId],
    );
    expect(refused.rows).toEqual([
      {
        result: "denied",
        metadata: {
          taskId,
          conversationId: engId,
          eventId: event.eventId,
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
