import { z } from "zod";
import { Id, IsoDateTime } from "./common";
import { SandboxProcessId } from "./sandbox";

/**
 * Long-running bot tasks (Phase 07.17.1.1.2, D-01 … D-04, D-11 … D-13; ADR-0042). A task is a platform entity
 * (`app.bot_tasks`): the bot starts it with `ocw_task_start`, schedules its own next turn with `ocw_task_continue` and
 * ends it with `ocw_task_finish`; the API is the only scheduler (no OpenClaw cron, heartbeat or plugin timer) and
 * decides every turn again as the person the task runs for.
 *
 * The bodies name the delivered turn and the bot only, never a person, a conversation, a task id, a budget or a time:
 * the API reads those from the stored turn and the task row (P6). Goals, progress notes, next steps and summaries are
 * the bot's own untrusted text: bounded, one line (the summary may break lines), without control or bidi characters,
 * and they never reach an audit row, a tool-call record, a job payload or a log line (P1).
 *
 * Imports `zod`, `./common` and `./sandbox` only; `bot-capabilities.ts`, `agent-channel.ts` and `agent-cards.ts`
 * import this file, never the reverse.
 */

// ---------------------------------------------------------------- limits (D-04, D-11, PD-28)

/**
 * The phase's numbers. Characters are UTF-16 code units. Budgets: `maxTurns*`, `maxHours*` per task and
 * `maxRunning*` per organization (default and cap). Waits: `afterSecondsMax` (a timer), `minGapSeconds` (the shortest
 * gap between two task turns), `backstopMinutes` (a `turn` wait's safety net), `turnLostMinutes` (a turn that never
 * reported done), `sessionWaitMinutes` (a Work Zone wait without a timer), `processGraceSeconds` (added to a background
 * command's own timeout). `finishedProcessesMax`: processes listed on one turn. Visible progress: one post every
 * `progressEveryTurns` turns or `progressEveryMinutes` minutes. `tickBatch`: tasks the minute tick looks at.
 */
export const BOT_TASK_LIMITS = {
  goalChars: 200,
  noteChars: 500,
  summaryChars: 1000,
  maxTurnsDefault: 40,
  maxTurnsCap: 200,
  maxHoursDefault: 8,
  maxHoursCap: 24,
  maxRunningDefault: 10,
  maxRunningCap: 100,
  afterSecondsMax: 3600,
  minGapSeconds: 5,
  backstopMinutes: 30,
  turnLostMinutes: 30,
  sessionWaitMinutes: 60,
  processGraceSeconds: 60,
  finishedProcessesMax: 10,
  progressEveryTurns: 5,
  progressEveryMinutes: 10,
  tickBatch: 100,
} as const;

// ---------------------------------------------------------------- vocabulary (D-01, D-03, D-12)

/** `running` (a turn of the task is in flight), `waiting` (for its next turn), then one of the three ends. */
export const BotTaskStatus = z.enum(["running", "waiting", "done", "failed", "stopped"]);
export type BotTaskStatus = z.infer<typeof BotTaskStatus>;

/** The statuses of an active task (at most one per bot per thread). */
export const BOT_TASK_ACTIVE = ["running", "waiting"] as const;

/**
 * Why a task ended: `done` / `blocked` (the bot finished it), a budget (`budget_turns`, `budget_time`, `daily_limit`),
 * `access_lost` (the person it runs for can no longer read the conversation), `bot_unavailable`, `policy_off` ("Allow
 * long tasks" off), `stopped_by_person` (Stop on the card), `no_progress` (two task turns in a row without continue or
 * finish, D-12) or `error`.
 */
export const BotTaskOutcome = z.enum([
  "done",
  "blocked",
  "budget_turns",
  "budget_time",
  "daily_limit",
  "access_lost",
  "bot_unavailable",
  "policy_off",
  "stopped_by_person",
  "no_progress",
  "error",
]);
export type BotTaskOutcome = z.infer<typeof BotTaskOutcome>;

/** What a waiting task waits for: its current turn to end, a timer, a background command, a Work Zone session or a nudge. */
export const BotTaskWaitKind = z.enum(["turn", "timer", "process", "session", "nudge"]);
export type BotTaskWaitKind = z.infer<typeof BotTaskWaitKind>;

/** Why a continuation turn was delivered (`agent.task.v1`). Work Zone wakes keep their own event (07.16). */
export const BotTaskWakeReason = z.enum(["continue", "timer", "process", "nudge"]);
export type BotTaskWakeReason = z.infer<typeof BotTaskWakeReason>;

// ---------------------------------------------------------------- text rules (D-01, D-07)

/** U+200E, U+200F, U+202A–U+202E, U+2066–U+2069: the bidi controls a note must not carry (Trojan Source). */
function isBidiControl(c: number): boolean {
  return c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
}

/** True when `s` holds U+0000–U+001F (a `\n` too unless `newlines`), U+007F or a bidi control. */
export function hasForbiddenTaskChar(s: string, newlines: boolean): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0a && newlines) continue;
    if (c <= 0x1f || c === 0x7f || isBidiControl(c)) return true;
  }
  return false;
}

/** Checked before the trim, so a leading or trailing control character is refused too. */
function taskText(max: number, newlines: boolean) {
  return z
    .string()
    .refine((s) => !hasForbiddenTaskChar(s, newlines), {
      message: newlines ? "no control or bidi characters" : "one line, no control or bidi characters",
    })
    .trim()
    .min(1)
    .max(max);
}

/** The task's one-line goal, written by the bot at start (the card's title). */
export const TaskGoal = taskText(BOT_TASK_LIMITS.goalChars, false);
export type TaskGoal = z.infer<typeof TaskGoal>;

/** A one-line progress note or next step, written by the bot at each continue. */
export const TaskNote = taskText(BOT_TASK_LIMITS.noteChars, false);
export type TaskNote = z.infer<typeof TaskNote>;

/** The bot's closing summary; the only task text that may break lines. */
export const TaskSummary = taskText(BOT_TASK_LIMITS.summaryChars, true);
export type TaskSummary = z.infer<typeof TaskSummary>;

// ---------------------------------------------------------------- the three bodies (D-02, D-03, PD-04)

/**
 * What a continue waits for, exactly one of: a background sandbox command this task started (`ocw_sandbox_exec` that
 * answered `running`) or a Work Zone session this task started. Anything else is `wait_unknown`.
 */
export const TaskWaitFor = z.union([
  z.strictObject({ processId: SandboxProcessId }),
  z.strictObject({ workSessionId: Id }),
]);
export type TaskWaitFor = z.infer<typeof TaskWaitFor>;

/** `POST /agent-channel/v1/tasks/start` (`ocw_task_start`): the turn, the bot and the goal. One active task per thread. */
export const AgentChannelTaskStart = z.strictObject({
  eventId: Id,
  agentId: Id,
  goal: TaskGoal,
});
export type AgentChannelTaskStart = z.infer<typeof AgentChannelTaskStart>;

/**
 * `POST /agent-channel/v1/tasks/continue` (`ocw_task_continue`): this turn's progress and the next step; the next turn
 * starts by itself after this one ends, after `afterSeconds` (0 … 3600, the API keeps a 5 s gap and caps it at the
 * task's deadline) or when `waitFor` ends. Never a time, a turn budget or a person: the API decides them.
 */
export const AgentChannelTaskContinue = z.strictObject({
  eventId: Id,
  agentId: Id,
  progress: TaskNote,
  nextStep: TaskNote,
  afterSeconds: z.number().int().min(0).max(BOT_TASK_LIMITS.afterSecondsMax).optional(),
  waitFor: TaskWaitFor.optional(),
});
export type AgentChannelTaskContinue = z.infer<typeof AgentChannelTaskContinue>;

/**
 * `POST /agent-channel/v1/tasks/finish` (`ocw_task_finish`): `done` ends the task, `blocked` ends it needing the person
 * (the platform mentions them). The platform's own stops are never the bot's to claim.
 */
export const AgentChannelTaskFinish = z.strictObject({
  eventId: Id,
  agentId: Id,
  summary: TaskSummary,
  outcome: z.enum(["done", "blocked"]),
});
export type AgentChannelTaskFinish = z.infer<typeof AgentChannelTaskFinish>;

// ---------------------------------------------------------------- refusals and answers (PD-08)

/**
 * Why a task call was refused. `once_per_turn` is the plugin's local refusal (a second call of one task tool in a
 * turn); the API never answers it.
 */
export const BotTaskRefusal = z.enum([
  "not_in_turn",
  "task_active",
  "no_task",
  "not_requester",
  "task_busy",
  "task_stopped",
  "budget_turns",
  "budget_time",
  "policy_off",
  "org_cap",
  "wait_unknown",
  "once_per_turn",
]);
export type BotTaskRefusal = z.infer<typeof BotTaskRefusal>;

/** The one fixed sentence per refusal the model reads (never the API's own text). */
export const BOT_TASK_SENTENCES: Readonly<Record<BotTaskRefusal, string>> = {
  not_in_turn: "Long tasks are not available on this turn.",
  task_active:
    "You already have a task running in this thread. Continue it with ocw_task_continue or end it with ocw_task_finish.",
  no_task: "There is no task of yours in this thread. Start one with ocw_task_start first.",
  not_requester: "This task runs for another person. Only their turns can continue or finish it.",
  task_busy: "Another turn of this task is running. Answer the person; the task goes on by itself.",
  task_stopped:
    "This task was stopped or has ended. Do not continue it; tell the person briefly where you got to.",
  budget_turns: "This task used all its turns, so it stopped. Tell the person what is done and what is left.",
  budget_time: "This task ran out of time, so it stopped. Tell the person what is done and what is left.",
  policy_off: "Long tasks are turned off for this bot. Do what you can in this turn and tell the person.",
  org_cap:
    "Too many tasks are running in this organization right now. Do what you can in this turn, or ask the person to try again later.",
  wait_unknown:
    "That is not a background command or a Work Zone session of this task. Wait on one this task started, or continue without waitFor.",
  once_per_turn: "That task tool was already called in this turn.",
};

/** A refused task call (the 07.17 `ok`-discriminated answer shape). */
export const BotTaskRefused = z.object({
  ok: z.literal(false),
  code: BotTaskRefusal,
  sentence: z.string().max(300),
});
export type BotTaskRefused = z.infer<typeof BotTaskRefused>;

/** The task started: its id, its turn budget and its deadline (snapshotted from the policy at start). */
export const AgentChannelTaskStartResponse = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    taskId: Id,
    maxTurns: z.number().int().positive(),
    deadlineAt: IsoDateTime,
  }),
  BotTaskRefused,
]);
export type AgentChannelTaskStartResponse = z.infer<typeof AgentChannelTaskStartResponse>;

/**
 * The next turn is scheduled: `after_turn` (as soon as this turn ends), `at` (a timer), `on_process` / `on_session`
 * (when the awaited command or session ends, at the latest `at`). `quiet`: this turn's text is not posted (the card
 * shows the progress; one visible post every 5 turns or 10 minutes, D-11).
 */
export const AgentChannelTaskContinueResponse = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    next: z.enum(["after_turn", "at", "on_process", "on_session"]),
    at: IsoDateTime.nullable(),
    turnsLeft: z.number().int().nonnegative(),
    quiet: z.boolean(),
  }),
  BotTaskRefused,
]);
export type AgentChannelTaskContinueResponse = z.infer<typeof AgentChannelTaskContinueResponse>;

/** The task ended: `done`, or `failed` when the bot finished it `blocked`. */
export const AgentChannelTaskFinishResponse = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), status: z.enum(["done", "failed"]) }),
  BotTaskRefused,
]);
export type AgentChannelTaskFinishResponse = z.infer<typeof AgentChannelTaskFinishResponse>;

// ---------------------------------------------------------------- the turn's task block (D-03, PD-13, PD-16)

/**
 * A background command of the task that ended (or was lost: a sandboxd restart, a killed shell). Ids and numbers only,
 * never argv, a path or output.
 */
export const TaskProcessFact = z.object({
  processId: SandboxProcessId,
  status: z.enum(["exited", "killed", "timed_out", "lost"]),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
});
export type TaskProcessFact = z.infer<typeof TaskProcessFact>;

/**
 * `TurnContext.task`: the bot's active task in this thread, read from the task row at delivery. The goal and notes are
 * the bot's own earlier text (the plugin labels them "your own notes"); the numbers and times are the platform's.
 * `waiting.ref` is a process id or a Work Zone session id; `finishedProcesses` lists commands that ended since the last
 * task turn.
 */
export const TurnTask = z.object({
  taskId: Id,
  status: z.enum(BOT_TASK_ACTIVE),
  goal: TaskGoal,
  progress: TaskNote.nullable(),
  nextStep: TaskNote.nullable(),
  turnsUsed: z.number().int().nonnegative(),
  maxTurns: z.number().int().positive(),
  startedAt: IsoDateTime,
  deadlineAt: IsoDateTime,
  requesterId: Id,
  waiting: z
    .object({
      kind: BotTaskWaitKind,
      ref: z.string().max(64).nullable(),
      until: IsoDateTime.nullable(),
    })
    .nullable(),
  finishedProcesses: z.array(TaskProcessFact).max(BOT_TASK_LIMITS.finishedProcessesMax),
});
export type TurnTask = z.infer<typeof TurnTask>;
