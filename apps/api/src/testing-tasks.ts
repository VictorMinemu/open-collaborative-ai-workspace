import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { TestClient } from "./testing";
import { eventually } from "./testing-device";
import { type Json, ok, type Res, type SandboxStack } from "./testing-sandbox";

/**
 * Shared fixtures of the long bot task suites (Phase 07.17.1.1.2-08; later 09, 11, 12): real deliveries on the sandbox
 * stack (`startSandboxStack`), the Agent Channel task routes called with the cell token, and a superuser seam for the
 * task's clock-like fields. Turns are real: a person writes, the mention handler runs `turnPolicy` (the task offer of
 * 07), and the test reads the bot's `agent.mention.v1` event from `cell:<org>`.
 */

/** A person's message mentioning the bot (`@<handle>`), in a conversation or one of its threads. */
export interface TaskTurnInput {
  who: TestClient;
  conversationId: string;
  /** A thread reply under this root message; absent = a new message at the conversation's root. */
  threadRootId?: string;
  /** The bot mentioned (default: the stack's Scout). */
  agentId?: string;
  /** Its handle in the body (default `scout`); `null` writes no mention (a DM delivers every message). */
  handle?: string | null;
  /** Text after the mention (a fresh sentence by default). */
  text?: string;
  /** Organization whose cell stream carries the event (default organization A). */
  organizationId?: string;
}

/**
 * `who` mentions the bot; returns the bot's delivered `agent.mention.v1` payload (exactly one). Today's usage is
 * cleared first: these suites deliver more turns than the bot's daily limit.
 */
export async function deliverTaskTurn(s: SandboxStack, p: TaskTurnInput): Promise<Json> {
  await s.su.query("delete from app.agent_usage_daily");
  const handle = p.handle === undefined ? "scout" : p.handle;
  const text = p.text ?? `please work through the knowledge pack ${randomUUID().slice(0, 6)}`;
  const msg = await ok(
    p.who.request("POST", `/api/v1/conversations/${p.conversationId}/messages`, {
      body: handle ? `@${handle} ${text}` : text,
      ...(p.threadRootId ? { threadRootId: p.threadRootId } : {}),
    }) as Promise<Res>,
  );
  const agentId = p.agentId ?? s.scoutId;
  const rows = (
    await s.su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2 and payload->'agent'->>'id' = $3",
      [`cell:${p.organizationId ?? s.orgA}`, msg.id, agentId],
    )
  ).rows;
  expect(rows, `one delivered turn of ${agentId} for message ${msg.id as string}`).toHaveLength(1);
  return rows[0].payload as Json;
}

/** POST to the Agent Channel as the cell (organization A's token unless `token` is given). */
export function cellCall(s: SandboxStack, path: string, body: unknown, token?: string): Promise<Res> {
  return s.cell(path, body, token);
}

/** The default goal of a started task (distinctive, so the P1 scans can look for it). */
export const TASK_GOAL = "Read the knowledge pack and summarise it";

/**
 * A delivered turn (`deliverTaskTurn`) that starts a task with `goal`: the task id, the turn's event and the start
 * answer. Fails the test unless the start answered `ok: true`.
 */
export async function startTaskFor(
  s: SandboxStack,
  p: TaskTurnInput & { goal?: string },
): Promise<{ taskId: string; event: Json; answer: Json }> {
  const event = await deliverTaskTurn(s, p);
  const res = await cellCall(s, "/tasks/start", {
    eventId: event.eventId,
    agentId: event.agent.id,
    goal: p.goal ?? TASK_GOAL,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body?.ok, JSON.stringify(res.body)).toBe(true);
  return { taskId: res.body?.taskId as string, event, answer: res.body as Json };
}

/** The bot's notes of a continue call (distinctive strings for the P1 scans). */
export const TASK_PROGRESS = "Read the first forty files of the pack";
export const TASK_NEXT_STEP = "Read the next forty files of the pack";

/** `POST /tasks/continue` for `event`'s turn, with default notes; `body` adds or overrides fields. */
export function continueAs(
  s: SandboxStack,
  event: Json,
  body: Record<string, unknown> = {},
  token?: string,
): Promise<Res> {
  return cellCall(
    s,
    "/tasks/continue",
    {
      eventId: event.eventId,
      agentId: event.agent.id,
      progress: TASK_PROGRESS,
      nextStep: TASK_NEXT_STEP,
      ...body,
    },
    token,
  );
}

/** `POST /tasks/finish` for `event`'s turn. */
export function finishAs(
  s: SandboxStack,
  event: Json,
  body: { summary: string; outcome: "done" | "blocked" },
  token?: string,
): Promise<Res> {
  return cellCall(s, "/tasks/finish", { eventId: event.eventId, agentId: event.agent.id, ...body }, token);
}

/** Columns `setTask` may write (snake_case, as stored). */
const SETTABLE = new Set([
  "status",
  "outcome",
  "turns_used",
  "max_turns",
  "started_at",
  "deadline_at",
  "finished_at",
  "current_event_id",
  "wait_kind",
  "wait_ref",
  "wake_at",
  "wait_seq",
  "last_post_turn",
  "last_post_at",
  "nudged",
  "tainted",
  "updated_at",
]);

/** Superuser test seam: writes clock-like and state fields of a task row directly (Dates as ISO strings). */
export async function setTask(
  s: SandboxStack,
  taskId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  for (const k of keys) if (!SETTABLE.has(k)) throw new Error(`setTask: ${k} is not a settable column`);
  const values = keys.map((k) => {
    const v = patch[k];
    return v instanceof Date ? v.toISOString() : v;
  });
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await s.su.query(`update app.bot_tasks set ${sets} where id = $1`, [taskId, ...values]);
}

/** The task row as stored (superuser). */
export async function taskRow(s: SandboxStack, taskId: string): Promise<Json> {
  const rows = (await s.su.query("select * from app.bot_tasks where id = $1", [taskId])).rows;
  expect(rows).toHaveLength(1);
  return rows[0] as Json;
}

/**
 * Runs every queued long-task job now (07.17.1.1.2-09), as if the 5 s gap had passed: the superuser moves `wake_at` of
 * waiting tasks due within that gap to `now()` (a timer or the 30-minute backstop is not moved: `setTask` does that)
 * and `start_after` of the `bot_task.*` jobs to `now()`, then drains the continuation queue. Returns how many jobs ran
 * (the handler decides each under the task's lock). A job that is not due stays queued when only `core.jobs.drain` is
 * called, as in production. (The minute tick is never queued in tests: workers are off, so nothing schedules it.)
 */
export async function drainTaskJobs(s: SandboxStack): Promise<number> {
  await s.su.query(
    "update app.bot_tasks set wake_at = now() where status = 'waiting' and wake_at <= now() + interval '6 seconds'",
  );
  await s.su.query(
    "update pgboss.job set start_after = now() where name like 'bot_task.%' and state in ('created', 'retry')",
  );
  return s.stack.built.core.jobs.drain("bot_task.continue");
}

/** The cell's `POST /turns/:eventId/done` for a delivered turn (the bridge's report at the end of every task turn). */
export function reportTurnDone(
  s: SandboxStack,
  eventId: string,
  outcome: "replied" | "failed" = "replied",
  opts: { agentId?: string; token?: string } = {},
): Promise<Res> {
  return cellCall(s, `/turns/${eventId}/done`, { agentId: opts.agentId ?? s.scoutId, outcome }, opts.token);
}

/** The `agent.task.v1` events of one task on organization A's cell stream (or `organizationId`'s), oldest first. */
export async function taskEvents(s: SandboxStack, taskId: string, organizationId?: string): Promise<Json[]> {
  return (
    await s.su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.task.v1' and payload->'task'->>'taskId' = $2 order by seq",
      [`cell:${organizationId ?? s.orgA}`, taskId],
    )
  ).rows.map((r) => r.payload as Json);
}

/** The bot's plain (card-less) messages in the task's thread (or its DM), oldest first. */
export async function botMessagesOf(s: SandboxStack, taskId: string): Promise<Json[]> {
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

/**
 * The task's end messages once the first has been posted (they are posted after commit), after a short settle so a
 * second one (a duplicate, a generic limit notice) would show too.
 */
export async function endMessagesOf(s: SandboxStack, taskId: string): Promise<Json[]> {
  await eventually(async () => ((await botMessagesOf(s, taskId)).length > 0 ? true : undefined));
  await new Promise((r) => setTimeout(r, 300));
  return botMessagesOf(s, taskId);
}

/** Superuser seam: the turn `eventId` was delivered `minutes` ago (a lost or old turn, PD-06). */
export async function ageTurn(s: SandboxStack, eventId: string, minutes: number): Promise<void> {
  await s.su.query(
    "update app.agent_turns set created_at = now() - make_interval(mins => $2) where event_id = $1",
    [eventId, minutes],
  );
}

/** The task's queued (not yet run) `bot_task.continue` jobs. */
export async function queuedTaskJobs(s: SandboxStack, taskId: string): Promise<Json[]> {
  return (
    await s.su.query(
      "select id, start_after from pgboss.job where name = 'bot_task.continue' and data->>'taskId' = $1 and state in ('created', 'retry')",
      [taskId],
    )
  ).rows as Json[];
}

/** Drops the task's queued jobs (a lost job: only the tick can recover the task). */
export async function dropTaskJobs(s: SandboxStack, taskId: string): Promise<void> {
  await s.su.query(
    "delete from pgboss.job where name = 'bot_task.continue' and data->>'taskId' = $1 and state in ('created', 'retry')",
    [taskId],
  );
}

/**
 * `ocw_sandbox_exec` with `background: true` on `event`'s turn (07.17.1.1.2-11): the fake sandboxd answers `running`
 * with a process id when the command sleeps (`["sleep", "1"]`, `["sh", "-c", "sleep 1; exit 75"]`).
 */
export function backgroundExec(
  s: SandboxStack,
  event: Json,
  argv: string[],
  opts: { timeoutSeconds?: number; token?: string } = {},
): Promise<Res> {
  return cellCall(
    s,
    "/sandbox/exec",
    {
      eventId: event.eventId,
      agentId: event.agent.id,
      argv,
      background: true,
      ...(opts.timeoutSeconds !== undefined ? { timeoutSeconds: opts.timeoutSeconds } : {}),
    },
    opts.token,
  );
}

/** The task's `bot_task_processes` rows as stored (superuser), oldest first. */
export async function processRowsOf(s: SandboxStack, taskId: string): Promise<Json[]> {
  return (
    await s.su.query("select * from app.bot_task_processes where task_id = $1 order by created_at, id", [
      taskId,
    ])
  ).rows as Json[];
}

/** A task continued on its start turn, which then reported done: due once the 5 s gap passes (`drainTaskJobs`). */
export async function continuedTask(
  s: SandboxStack,
  p: TaskTurnInput & { body?: Record<string, unknown> },
): Promise<{ taskId: string; start: Json }> {
  const { taskId, event } = await startTaskFor(s, p);
  const c = await continueAs(s, event, p.body ?? {});
  expect(c.body, JSON.stringify(c.body)).toMatchObject({ ok: true });
  const d = await reportTurnDone(s, event.eventId as string, "replied", {
    agentId: event.agent.id as string,
  });
  expect(d.status, JSON.stringify(d.body)).toBe(200);
  return { taskId, start: event };
}
