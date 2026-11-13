import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { TestClient } from "./testing";
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
