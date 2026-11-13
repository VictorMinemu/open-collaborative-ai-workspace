import { randomUUID } from "node:crypto";
import { BUILTIN_TOOLS } from "@ocw/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/crypto";
import {
  type Json,
  ok,
  type Res,
  SANDBOX_CELL_TOKEN,
  type SandboxStack,
  startSandboxStack,
} from "../../testing-sandbox";
import {
  cellCall,
  continueAs,
  deliverTaskTurn,
  finishAs,
  setTask,
  startTaskFor,
  TASK_GOAL,
  TASK_NEXT_STEP,
  TASK_PROGRESS,
  taskRow,
} from "../../testing-tasks";

/**
 * Phase 07.17.1.1.2-08 (D-01, D-04, D-05, D-07, D-10; PD-08, PD-09, PD-19; E1, E2, E14, E15, E22, E24, E26, P1;
 * BTASK-01, BTASK-07, BTASK-11): what the task routes never allow. One task per bot and thread and the organization's
 * running cap hold under concurrent starts; another organization's cell finds nothing; a turn without the tool (another
 * member's view turn, an AI chat) is refused; the bot cannot rewrite its task card; and no audit row, tool-call record,
 * job payload or log line carries the bot's goal, notes or summary.
 *
 * People: Sam Lee asks (the requester); Alex Kim is another member of #eng; Víctor is the admin. Eve is organization B's
 * admin, with her own bot Warden. Scout is organization A's team bot.
 */

let s: SandboxStack;
let engId: string;
/** Organization B's cell credential (a real row, another organization). */
let tokenB: string;

const START = BUILTIN_TOOLS.taskStart;
const SUMMARY = "Summarised the knowledge pack into three distinctive findings";

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
  tokenB = `ocw_cell_${randomUUID()}${randomUUID()}`;
  await s.su.query(
    "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
    [s.orgB, sha256Hex(tokenB)],
  );
}, 240_000);

afterAll(async () => {
  await s?.stop();
});

const setMaxRunning = async (n: number) =>
  ok(s.victor.request("PUT", "/api/v1/bot-policy", { tasks: { maxRunning: n } }) as Promise<Res>);

/** Ends every active task of organization A (a clean count for the cap cases). */
const endAll = () =>
  s.su.query(
    `update app.bot_tasks set status = 'done', outcome = 'done', finished_at = now(), wait_kind = null, wait_ref = null,
       wake_at = null where organization_id = $1 and status in ('running', 'waiting')`,
    [s.orgA],
  );

const startBody = (ev: Json, goal = TASK_GOAL) => ({ eventId: ev.eventId, agentId: ev.agent.id, goal });

describe("one task per thread and the organization's cap, under concurrency (PD-09, E1, E2)", () => {
  it("two concurrent starts from two turns in one thread: one task_active, one row", async () => {
    await setMaxRunning(100);
    const root = await deliverTaskTurn(s, { who: s.sam, conversationId: engId });
    const reply = await deliverTaskTurn(s, {
      who: s.sam,
      conversationId: engId,
      threadRootId: root.message.id,
    });
    expect(reply.turn.tools).toContain(START);
    const answers = await Promise.all([
      cellCall(s, "/tasks/start", startBody(root)),
      cellCall(s, "/tasks/start", startBody(reply)),
    ]);
    expect(answers.map((a) => a.status)).toEqual([200, 200]);
    expect(answers.filter((a) => a.body?.ok === true)).toHaveLength(1);
    expect(answers.filter((a) => a.body?.code === "task_active")).toHaveLength(1);
    const rows = (
      await s.su.query("select id from app.bot_tasks where conversation_id = $1 and thread_root_id = $2", [
        engId,
        root.message.id,
      ])
    ).rows;
    expect(rows).toHaveLength(1);
  });

  it("one running slot left: two concurrent starts in two threads, one ok and one org_cap; a cap of 0 refuses any", async () => {
    await endAll();
    await setMaxRunning(1);
    try {
      const a = await deliverTaskTurn(s, { who: s.sam, conversationId: engId });
      const b = await deliverTaskTurn(s, { who: s.alex, conversationId: engId });
      const answers = await Promise.all([
        cellCall(s, "/tasks/start", startBody(a)),
        cellCall(s, "/tasks/start", startBody(b)),
      ]);
      expect(answers.filter((r) => r.body?.ok === true)).toHaveLength(1);
      expect(answers.filter((r) => r.body?.code === "org_cap")).toHaveLength(1);
      expect(
        (
          await s.su.query(
            "select count(*)::int as n from app.bot_tasks where organization_id = $1 and status in ('running', 'waiting')",
            [s.orgA],
          )
        ).rows[0].n,
      ).toBe(1);

      await endAll();
      // A turn delivered before the cap went to 0 still carries the start: the route's cap refuses it.
      const c = await deliverTaskTurn(s, { who: s.sam, conversationId: engId });
      await setMaxRunning(0);
      const refused = await cellCall(s, "/tasks/start", startBody(c));
      expect(refused.body).toMatchObject({ ok: false, code: "org_cap" });
      // Code review IN-02: a turn delivered at 0 is not offered the start at all.
      const d = await deliverTaskTurn(s, { who: s.sam, conversationId: engId });
      expect(d.turn.tools).not.toContain("ocw_task_start");
      const unoffered = await cellCall(s, "/tasks/start", startBody(d));
      expect(unoffered.body).toMatchObject({ ok: false, code: "not_in_turn" });
    } finally {
      await setMaxRunning(100);
    }
  });
});

describe("tenants (E22)", () => {
  it("organization B's cell with A's event: 404 unknown_turn, audited in B only, A's task untouched", async () => {
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    const before = await taskRow(s, taskId);
    for (const [path, body] of [
      ["/tasks/continue", { eventId: event.eventId, agentId: s.scoutId, progress: "x", nextStep: "y" }],
      ["/tasks/finish", { eventId: event.eventId, agentId: s.scoutId, summary: "x", outcome: "done" }],
      ["/tasks/start", startBody(event)],
    ] as const) {
      const res = await cellCall(s, path, body, tokenB);
      expect(res.status, path).toBe(404);
      expect((res.body?.error as Json | undefined)?.code).toBe("unknown_turn");
    }
    expect(await taskRow(s, taskId)).toEqual(before);
    const audits = (
      await s.su.query(
        "select organization_id from app.audit_events where action = 'bot.tool_call' and metadata->>'eventId' = $1 and metadata->>'reason' = 'unknown_turn'",
        [event.eventId],
      )
    ).rows;
    expect(audits).toHaveLength(3);
    expect(new Set(audits.map((r) => r.organization_id))).toEqual(new Set([s.orgB]));
  });

  it("organization B's own bot starts its own task in B; A's task is never touched", async () => {
    const { taskId } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    const before = await taskRow(s, taskId);
    const wardenId = (
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
    const fleet = (
      await ok(
        s.eve.request("POST", "/api/v1/channels", { name: "fleet", visibility: "public" }) as Promise<Res>,
      )
    ).id as string;
    await ok(
      s.eve.request("POST", `/api/v1/channels/${fleet}/members`, {
        kind: "agent",
        id: wardenId,
      }) as Promise<Res>,
    );
    const evB = await deliverTaskTurn(s, {
      who: s.eve,
      conversationId: fleet,
      agentId: wardenId,
      handle: "warden",
      organizationId: s.orgB,
    });
    const res = await cellCall(s, "/tasks/start", startBody(evB), tokenB);
    expect(res.body).toMatchObject({ ok: true });
    const rowB = await taskRow(s, res.body?.taskId as string);
    expect(rowB).toMatchObject({ organization_id: s.orgB, agent_id: wardenId, requester_user_id: s.eveId });
    expect(await taskRow(s, taskId)).toEqual(before);
    // A's token cannot reach B's turn either.
    const cross = await continueAs(s, evB, {}, SANDBOX_CELL_TOKEN);
    expect(cross.status).toBe(404);
  });
});

describe("turns without the tool (E14, E15)", () => {
  it("Alex's turn in Sam's task thread only sees the task: a forged continue or finish is not_in_turn", async () => {
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    const alex = await deliverTaskTurn(s, {
      who: s.alex,
      conversationId: engId,
      threadRootId: event.message.id,
    });
    expect(alex.turn.tools).not.toContain(BUILTIN_TOOLS.taskContinue);
    const before = await taskRow(s, taskId);
    expect((await continueAs(s, alex)).body).toMatchObject({ ok: false, code: "not_in_turn" });
    expect((await finishAs(s, alex, { summary: "Mine now", outcome: "done" })).body).toMatchObject({
      ok: false,
      code: "not_in_turn",
    });
    expect(await taskRow(s, taskId)).toEqual(before);
  });

  it("an AI chat turn never starts a task, even with the tool on its ledger (D-10)", async () => {
    const ev = await deliverTaskTurn(s, { who: s.sam, conversationId: engId });
    await s.su.query("update app.agent_turns set conversation_kind = 'ai_chat' where event_id = $1", [
      ev.eventId,
    ]);
    const res = await cellCall(s, "/tasks/start", startBody(ev));
    expect(res.body).toMatchObject({ ok: false, code: "not_in_turn" });
    expect(
      (
        await s.su.query("select count(*)::int as n from app.bot_tasks where started_event_id = $1", [
          ev.eventId,
        ])
      ).rows[0].n,
    ).toBe(0);
  });

  it("a turn that used its 8 tool calls still continues its task (D-13: outside the cap)", async () => {
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    await s.su.query("update app.agent_turns set tool_calls = 8 where event_id = $1", [event.eventId]);
    expect((await continueAs(s, event)).body).toMatchObject({ ok: true });
    expect((await taskRow(s, taskId)).status).toBe("waiting");
    expect(
      (await s.su.query("select tool_calls from app.agent_turns where event_id = $1", [event.eventId]))
        .rows[0],
    ).toEqual({ tool_calls: 8 });
  });
});

describe("the card is the platform's (E26)", () => {
  it("the bot's own PATCH of its task card is card_platform_owned", async () => {
    const { taskId } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    const card = (await taskRow(s, taskId)).card_message_id as string;
    const res = await fetch(`${s.stack.baseUrl}/agent-channel/v1/cards/${card}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${SANDBOX_CELL_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ agentId: s.scoutId, patch: { expectedVersion: 1, status: "succeeded" } }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Json).error.code).toBe("card_platform_owned");
    expect(
      (await s.su.query("select status, version from app.message_cards where message_id = $1", [card]))
        .rows[0],
    ).toEqual({ status: "running", version: 1 });
  });
});

describe("no goal, note or summary in any record (P1, PD-19, E24)", () => {
  it("a full task (start, continue, finish, a budget stop, refusals) leaves its text out of audit, tool calls, jobs and logs", async () => {
    const one = await startTaskFor(s, { who: s.sam, conversationId: engId });
    expect((await continueAs(s, one.event, { afterSeconds: 60 })).body).toMatchObject({ ok: true });
    const control = await deliverTaskTurn(s, {
      who: s.sam,
      conversationId: engId,
      threadRootId: one.event.message.id,
    });
    expect((await finishAs(s, control, { summary: SUMMARY, outcome: "blocked" })).body).toMatchObject({
      ok: true,
    });
    const two = await startTaskFor(s, { who: s.sam, conversationId: engId });
    await setTask(s, two.taskId, { turns_used: 40 });
    expect((await continueAs(s, two.event)).body).toMatchObject({ ok: false, code: "budget_turns" });
    // A refusal with the bot's text in its body.
    expect((await continueAs(s, two.event)).body).toMatchObject({ ok: false, code: "task_stopped" });
    // The after-commit messages have been posted (their logs and audits are part of the scan).
    await new Promise((r) => setTimeout(r, 500));

    const texts = [TASK_GOAL, TASK_PROGRESS, TASK_NEXT_STEP, SUMMARY];
    for (const text of texts) {
      for (const [table, query] of [
        [
          "audit_events",
          "select count(*)::int as n from app.audit_events t where strpos(row_to_json(t)::text, $1) > 0",
        ],
        [
          "agent_tool_calls",
          "select count(*)::int as n from app.agent_tool_calls t where strpos(row_to_json(t)::text, $1) > 0",
        ],
        [
          "pgboss.job",
          "select count(*)::int as n from pgboss.job t where strpos(row_to_json(t)::text, $1) > 0",
        ],
      ] as const) {
        expect((await s.su.query(query, [text])).rows[0].n, `${table} carries "${text}"`).toBe(0);
      }
      expect(
        s.logs.filter((line) => line.includes(text)),
        `a log line carries "${text}"`,
      ).toEqual([]);
    }
    // The texts are where they belong: the task row (and the card, for people).
    expect((await taskRow(s, one.taskId)).summary).toBe(SUMMARY);
  });
});
