import { describe, expect, it } from "vitest";
import {
  AgentChannelTaskContinue,
  AgentChannelTaskContinueResponse,
  AgentChannelTaskFinish,
  AgentChannelTaskFinishResponse,
  AgentChannelTaskStart,
  AgentChannelTaskStartResponse,
  BOT_TASK_ACTIVE,
  BOT_TASK_LIMITS,
  BOT_TASK_SENTENCES,
  BotTaskOutcome,
  BotTaskRefusal,
  BotTaskRefused,
  BotTaskStatus,
  BotTaskWaitKind,
  BotTaskWakeReason,
  TaskGoal,
  TaskNote,
  TaskProcessFact,
  TaskSummary,
  TaskWaitFor,
  TurnTask,
} from "./index";

const EVENT = "0199b1c2-d3e4-7f5a-8b9c-000000000001";
const AGENT = "0199b1c2-d3e4-7f5a-8b9c-000000000002";
const TASK = "0199b1c2-d3e4-7f5a-8b9c-000000000003";
const SESSION = "0199b1c2-d3e4-7f5a-8b9c-000000000004";
const ANA = "0199b1c2-d3e4-7f5a-8b9c-000000000005";
const AT = "2026-11-12T10:00:00.000Z";
const LATER = "2026-11-12T18:00:00.000Z";

/** Every bidi control the text rules refuse, built from code points (no bidi character in this file). */
const BIDI = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f].map(
  (cp) => String.fromCodePoint(cp),
);

describe("07.17.1.1.2 tasks: limits and vocabulary (D-01, D-03, D-04, D-11, PD-28)", () => {
  it("the limits are the phase's numbers", () => {
    expect(BOT_TASK_LIMITS).toEqual({
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
    });
  });

  it("statuses, outcomes, waits and wake reasons are the hub's lists", () => {
    expect(BotTaskStatus.options).toEqual(["running", "waiting", "done", "failed", "stopped"]);
    expect([...BOT_TASK_ACTIVE]).toEqual(["running", "waiting"]);
    expect(BotTaskOutcome.options).toEqual([
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
    expect(BotTaskWaitKind.options).toEqual(["turn", "timer", "process", "session", "nudge"]);
    expect(BotTaskWakeReason.options).toEqual(["continue", "timer", "process", "nudge"]);
  });
});

describe("07.17.1.1.2 tasks: text rules (D-01, D-07, T-07.17.1.1.2-01-02)", () => {
  const rules = [
    { name: "TaskGoal", schema: TaskGoal, max: 200, newlines: false },
    { name: "TaskNote", schema: TaskNote, max: 500, newlines: false },
    { name: "TaskSummary", schema: TaskSummary, max: 1000, newlines: true },
  ] as const;

  for (const { name, schema, max, newlines } of rules) {
    it(`${name}: 1 … ${max} characters, trimmed, never blank`, () => {
      expect(schema.parse("Read the pack")).toBe("Read the pack");
      expect(schema.parse("  Read the pack  ")).toBe("Read the pack");
      expect(schema.parse("x".repeat(max))).toBe("x".repeat(max));
      expect(schema.safeParse("x".repeat(max + 1)).success).toBe(false);
      expect(schema.safeParse("").success).toBe(false);
      expect(schema.safeParse("   ").success).toBe(false);
    });

    it(`${name}: refuses a NUL, any other control character, DEL and every bidi control`, () => {
      for (const cp of [0x00, 0x01, 0x07, 0x08, 0x09, 0x0b, 0x0d, 0x1b, 0x1f, 0x7f]) {
        const bad = `Read ${String.fromCodePoint(cp)} the pack`;
        expect(schema.safeParse(bad).success, `U+${cp.toString(16)}`).toBe(false);
      }
      for (const b of BIDI) {
        expect(schema.safeParse(`Read ${b}the pack`).success, b.codePointAt(0)?.toString(16)).toBe(false);
      }
      // Leading or trailing controls are refused too: the check runs before the trim.
      expect(schema.safeParse(`\tRead the pack`).success).toBe(false);
      expect(schema.safeParse(`Read the pack${String.fromCodePoint(0x200f)}`).success).toBe(false);
    });

    it(`${name}: a newline is ${newlines ? "allowed" : "refused"}`, () => {
      expect(schema.safeParse("Read the pack\nthen summarise it").success).toBe(newlines);
    });
  }
});

describe("07.17.1.1.2 tasks: the three bodies are strict (D-02, D-03, P6, T-07.17.1.1.2-01-01)", () => {
  const start = { eventId: EVENT, agentId: AGENT, goal: "Read the knowledge pack and summarise it" };
  const cont = { eventId: EVENT, agentId: AGENT, progress: "Read 400 of 3030 files", nextStep: "Read the next 400" };
  const finish = { eventId: EVENT, agentId: AGENT, summary: "Read every file.\nThe summary is below.", outcome: "done" };

  it("ocw_task_start: the event, the bot and a one-line goal; nothing else", () => {
    expect(AgentChannelTaskStart.parse(start)).toEqual(start);
    for (const goal of ["", "   ", "g".repeat(201), "Read\nthe pack", `Read${String.fromCodePoint(0)}`]) {
      expect(AgentChannelTaskStart.safeParse({ ...start, goal }).success, JSON.stringify(goal)).toBe(false);
    }
    expect(AgentChannelTaskStart.safeParse({ ...start, goal: `Read ${String.fromCodePoint(0x202e)}kcap` }).success).toBe(
      false,
    );
    for (const key of ["userId", "conversationId", "taskId", "maxTurns"]) {
      expect(AgentChannelTaskStart.safeParse({ ...start, [key]: key === "maxTurns" ? 40 : TASK }).success, key).toBe(
        false,
      );
    }
    expect(AgentChannelTaskStart.safeParse({ ...start, eventId: "not-a-uuid" }).success).toBe(false);
  });

  it("ocw_task_continue: progress and next step, an optional bounded timer and one optional wait", () => {
    expect(AgentChannelTaskContinue.parse(cont)).toEqual(cont);
    for (const afterSeconds of [0, 1, 3600]) {
      expect(AgentChannelTaskContinue.parse({ ...cont, afterSeconds })).toEqual({ ...cont, afterSeconds });
    }
    const process = { ...cont, waitFor: { processId: "a1B2_c3-d4" } };
    expect(AgentChannelTaskContinue.parse(process)).toEqual(process);
    const session = { ...cont, waitFor: { workSessionId: SESSION }, afterSeconds: 600 };
    expect(AgentChannelTaskContinue.parse(session)).toEqual(session);
    for (const afterSeconds of [-1, 3601, 1.5, 99999, "60"]) {
      expect(AgentChannelTaskContinue.safeParse({ ...cont, afterSeconds }).success, String(afterSeconds)).toBe(false);
    }
    for (const waitFor of [
      {},
      { processId: "a1B2_c3-d4", workSessionId: SESSION },
      { processId: "has space" },
      { processId: "p".repeat(65) },
      { workSessionId: "not-a-uuid" },
      { sessionId: SESSION },
    ]) {
      expect(AgentChannelTaskContinue.safeParse({ ...cont, waitFor }).success, JSON.stringify(waitFor)).toBe(false);
    }
    expect(AgentChannelTaskContinue.safeParse({ ...cont, progress: "p".repeat(501) }).success).toBe(false);
    expect(AgentChannelTaskContinue.safeParse({ ...cont, nextStep: "n".repeat(501) }).success).toBe(false);
    expect(AgentChannelTaskContinue.safeParse({ ...cont, nextStep: "a\nb" }).success).toBe(false);
    expect(AgentChannelTaskContinue.safeParse({ ...cont, progress: undefined }).success).toBe(false);
    for (const key of ["at", "userId", "conversationId", "taskId", "maxTurns"]) {
      expect(AgentChannelTaskContinue.safeParse({ ...cont, [key]: key === "at" ? AT : TASK }).success, key).toBe(false);
    }
  });

  it("ocw_task_finish: a multi-line summary and done or blocked only", () => {
    expect(AgentChannelTaskFinish.parse(finish)).toEqual(finish);
    expect(AgentChannelTaskFinish.parse({ ...finish, outcome: "blocked" }).outcome).toBe("blocked");
    for (const outcome of ["stopped", "failed", "error", ""]) {
      expect(AgentChannelTaskFinish.safeParse({ ...finish, outcome }).success, outcome).toBe(false);
    }
    expect(AgentChannelTaskFinish.safeParse({ ...finish, summary: "s".repeat(1001) }).success).toBe(false);
    expect(AgentChannelTaskFinish.parse({ ...finish, summary: "s".repeat(1000) }).summary).toHaveLength(1000);
    expect(AgentChannelTaskFinish.safeParse({ ...finish, userId: ANA }).success).toBe(false);
  });

  it("TaskWaitFor is exactly one of a process id or a Work Zone session id", () => {
    expect(TaskWaitFor.parse({ processId: "p1" })).toEqual({ processId: "p1" });
    expect(TaskWaitFor.parse({ workSessionId: SESSION })).toEqual({ workSessionId: SESSION });
    expect(TaskWaitFor.safeParse({}).success).toBe(false);
    expect(TaskWaitFor.safeParse({ processId: "p1", workSessionId: SESSION }).success).toBe(false);
  });
});

describe("07.17.1.1.2 tasks: answers and refusals (D-02, PD-08)", () => {
  const SENTENCES: Record<string, string> = {
    not_in_turn: "Long tasks are not available on this turn.",
    task_active:
      "You already have a task running in this thread. Continue it with ocw_task_continue or end it with ocw_task_finish.",
    no_task: "There is no task of yours in this thread. Start one with ocw_task_start first.",
    not_requester: "This task runs for another person. Only their turns can continue or finish it.",
    task_busy: "Another turn of this task is running. Answer the person; the task goes on by itself.",
    task_stopped: "This task was stopped or has ended. Do not continue it; tell the person briefly where you got to.",
    budget_turns: "This task used all its turns, so it stopped. Tell the person what is done and what is left.",
    budget_time: "This task ran out of time, so it stopped. Tell the person what is done and what is left.",
    policy_off: "Long tasks are turned off for this bot. Do what you can in this turn and tell the person.",
    org_cap:
      "Too many tasks are running in this organization right now. Do what you can in this turn, or ask the person to try again later.",
    wait_unknown:
      "That is not a background command or a Work Zone session of this task. Wait on one this task started, or continue without waitFor.",
    once_per_turn: "That task tool was already called in this turn.",
  };

  it("the refusal codes are the hub's, each with its verbatim sentence of at most 300 characters", () => {
    expect(BotTaskRefusal.options).toEqual(Object.keys(SENTENCES));
    expect({ ...BOT_TASK_SENTENCES }).toEqual(SENTENCES);
    for (const s of Object.values(BOT_TASK_SENTENCES)) expect(s.length).toBeLessThanOrEqual(300);
  });

  it("every answer parses its ok shape and every refusal; an unknown code is refused", () => {
    const started = { ok: true, taskId: TASK, maxTurns: 40, deadlineAt: LATER };
    expect(AgentChannelTaskStartResponse.parse(started)).toEqual(started);
    for (const next of ["after_turn", "at", "on_process", "on_session"]) {
      const continued = { ok: true, next, at: next === "at" ? LATER : null, turnsLeft: 38, quiet: true };
      expect(AgentChannelTaskContinueResponse.parse(continued)).toEqual(continued);
    }
    for (const status of ["done", "failed"]) {
      expect(AgentChannelTaskFinishResponse.parse({ ok: true, status })).toEqual({ ok: true, status });
    }
    for (const [code, sentence] of Object.entries(BOT_TASK_SENTENCES)) {
      const refused = { ok: false, code, sentence };
      expect(BotTaskRefused.parse(refused)).toEqual(refused);
      for (const answer of [AgentChannelTaskStartResponse, AgentChannelTaskContinueResponse, AgentChannelTaskFinishResponse]) {
        expect(answer.parse(refused)).toEqual(refused);
      }
    }
    const unknown = { ok: false, code: "task_exploded", sentence: "No." };
    for (const answer of [AgentChannelTaskStartResponse, AgentChannelTaskContinueResponse, AgentChannelTaskFinishResponse]) {
      expect(answer.safeParse(unknown).success).toBe(false);
      expect(answer.safeParse({ ok: false, code: "no_task", sentence: "s".repeat(301) }).success).toBe(false);
    }
    expect(
      AgentChannelTaskContinueResponse.safeParse({ ok: true, next: "later", at: null, turnsLeft: 1, quiet: false }).success,
    ).toBe(false);
    expect(
      AgentChannelTaskContinueResponse.safeParse({ ok: true, next: "at", at: null, turnsLeft: -1, quiet: false }).success,
    ).toBe(false);
    expect(AgentChannelTaskFinishResponse.safeParse({ ok: true, status: "stopped" }).success).toBe(false);
    expect(AgentChannelTaskStartResponse.safeParse({ ok: true, taskId: TASK, maxTurns: 0, deadlineAt: LATER }).success).toBe(
      false,
    );
  });
});

describe("07.17.1.1.2 tasks: the turn's task block and process facts (D-03, PD-13, PD-16)", () => {
  const exited = { processId: "p1", status: "exited", exitCode: 0, durationMs: 1200 };
  const lost = { processId: "p2", status: "lost", exitCode: null, durationMs: null };
  const task = {
    taskId: TASK,
    status: "waiting",
    goal: "Read the knowledge pack and summarise it",
    progress: "Read 400 of 3030 files",
    nextStep: "Read the next 400",
    turnsUsed: 7,
    maxTurns: 40,
    startedAt: AT,
    deadlineAt: LATER,
    requesterId: ANA,
    waiting: { kind: "process", ref: "p1", until: LATER },
    finishedProcesses: [exited, lost],
  };

  it("TaskProcessFact: ids and numbers only, the four end states", () => {
    expect(TaskProcessFact.parse(exited)).toEqual(exited);
    expect(TaskProcessFact.parse(lost)).toEqual(lost);
    expect(TaskProcessFact.safeParse({ ...exited, status: "running" }).success).toBe(false);
    expect(TaskProcessFact.safeParse({ ...exited, durationMs: -1 }).success).toBe(false);
    expect(TaskProcessFact.safeParse({ ...exited, exitCode: 1.5 }).success).toBe(false);
  });

  it("TurnTask: a running or waiting task, at most ten finished processes", () => {
    expect(TurnTask.parse(task)).toEqual(task);
    const fresh = { ...task, status: "running", progress: null, nextStep: null, turnsUsed: 1, waiting: null, finishedProcesses: [] };
    expect(TurnTask.parse(fresh)).toEqual(fresh);
    expect(TurnTask.safeParse({ ...task, status: "done" }).success).toBe(false);
    expect(TurnTask.safeParse({ ...task, maxTurns: 0 }).success).toBe(false);
    expect(TurnTask.safeParse({ ...task, turnsUsed: -1 }).success).toBe(false);
    expect(TurnTask.safeParse({ ...task, finishedProcesses: Array(11).fill(exited) }).success).toBe(false);
    expect(TurnTask.parse({ ...task, finishedProcesses: Array(10).fill(exited) }).finishedProcesses).toHaveLength(10);
    expect(TurnTask.safeParse({ ...task, waiting: { kind: "forever", ref: null, until: null } }).success).toBe(false);
    expect(TurnTask.safeParse({ ...task, waiting: { kind: "timer", ref: "r".repeat(65), until: null } }).success).toBe(
      false,
    );
    expect(TurnTask.safeParse({ ...task, goal: "a\nb" }).success).toBe(false);
  });
});
