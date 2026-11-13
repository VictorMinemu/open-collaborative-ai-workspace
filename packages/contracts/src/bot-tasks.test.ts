import { describe, expect, it } from "vitest";
import {
  AgentCard,
  AgentCardInput,
  AgentCardKind,
  AgentCardStatus,
  AgentCardTaskLink,
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
  BotTaskStopResponse,
  BotTaskWaitKind,
  BotTaskWakeReason,
  TASK_CARD_FIELD_LABELS,
  TASK_STATUS_LABELS,
  TaskGoal,
  TaskNote,
  TaskProcessFact,
  TaskSummary,
  TaskWaitFor,
  TurnTask,
  taskCardStatus,
  taskContinueSentence,
  taskQuiet,
  taskStatusLabel,
  taskStopNotice,
  taskStopSentence,
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
      taskCallsPerTurnMax: 6,
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

    it(`${name}: code review IN-07: refuses C1 controls and U+061C; U+2028 and U+2029 only where lines may break`, () => {
      for (const cp of [0x80, 0x85, 0x9b, 0x9f, 0x061c]) {
        const bad = `Read ${String.fromCodePoint(cp)}the pack`;
        expect(schema.safeParse(bad).success, `U+${cp.toString(16)}`).toBe(false);
      }
      for (const cp of [0x2028, 0x2029]) {
        const line = `Read the pack${String.fromCodePoint(cp)}then summarise it`;
        expect(schema.safeParse(line).success, `U+${cp.toString(16)}`).toBe(newlines);
      }
      // Ordinary non-ASCII text stays accepted.
      expect(schema.safeParse("Leí el paquete: 3 030 ficheros").success).toBe(true);
    });
  }
});

describe("07.17.1.1.2 tasks: the three bodies are strict (D-02, D-03, P6, T-07.17.1.1.2-01-01)", () => {
  const start = { eventId: EVENT, agentId: AGENT, goal: "Read the knowledge pack and summarise it" };
  const cont = {
    eventId: EVENT,
    agentId: AGENT,
    progress: "Read 400 of 3030 files",
    nextStep: "Read the next 400",
  };
  const finish = {
    eventId: EVENT,
    agentId: AGENT,
    summary: "Read every file.\nThe summary is below.",
    outcome: "done",
  };

  it("ocw_task_start: the event, the bot and a one-line goal; nothing else", () => {
    expect(AgentChannelTaskStart.parse(start)).toEqual(start);
    for (const goal of ["", "   ", "g".repeat(201), "Read\nthe pack", `Read${String.fromCodePoint(0)}`]) {
      expect(AgentChannelTaskStart.safeParse({ ...start, goal }).success, JSON.stringify(goal)).toBe(false);
    }
    expect(
      AgentChannelTaskStart.safeParse({ ...start, goal: `Read ${String.fromCodePoint(0x202e)}kcap` }).success,
    ).toBe(false);
    for (const key of ["userId", "conversationId", "taskId", "maxTurns"]) {
      expect(
        AgentChannelTaskStart.safeParse({ ...start, [key]: key === "maxTurns" ? 40 : TASK }).success,
        key,
      ).toBe(false);
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
      expect(
        AgentChannelTaskContinue.safeParse({ ...cont, afterSeconds }).success,
        String(afterSeconds),
      ).toBe(false);
    }
    for (const waitFor of [
      {},
      { processId: "a1B2_c3-d4", workSessionId: SESSION },
      { processId: "has space" },
      { processId: "p".repeat(65) },
      { workSessionId: "not-a-uuid" },
      { sessionId: SESSION },
    ]) {
      expect(AgentChannelTaskContinue.safeParse({ ...cont, waitFor }).success, JSON.stringify(waitFor)).toBe(
        false,
      );
    }
    expect(AgentChannelTaskContinue.safeParse({ ...cont, progress: "p".repeat(501) }).success).toBe(false);
    expect(AgentChannelTaskContinue.safeParse({ ...cont, nextStep: "n".repeat(501) }).success).toBe(false);
    expect(AgentChannelTaskContinue.safeParse({ ...cont, nextStep: "a\nb" }).success).toBe(false);
    expect(AgentChannelTaskContinue.safeParse({ ...cont, progress: undefined }).success).toBe(false);
    for (const key of ["at", "userId", "conversationId", "taskId", "maxTurns"]) {
      expect(
        AgentChannelTaskContinue.safeParse({ ...cont, [key]: key === "at" ? AT : TASK }).success,
        key,
      ).toBe(false);
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
    task_stopped:
      "This task was stopped or has ended. Do not continue it; tell the person briefly where you got to.",
    budget_turns:
      "This task used all its turns, so it stopped. Tell the person what is done and what is left.",
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
      for (const answer of [
        AgentChannelTaskStartResponse,
        AgentChannelTaskContinueResponse,
        AgentChannelTaskFinishResponse,
      ]) {
        expect(answer.parse(refused)).toEqual(refused);
      }
    }
    const unknown = { ok: false, code: "task_exploded", sentence: "No." };
    for (const answer of [
      AgentChannelTaskStartResponse,
      AgentChannelTaskContinueResponse,
      AgentChannelTaskFinishResponse,
    ]) {
      expect(answer.safeParse(unknown).success).toBe(false);
      expect(answer.safeParse({ ok: false, code: "no_task", sentence: "s".repeat(301) }).success).toBe(false);
    }
    expect(
      AgentChannelTaskContinueResponse.safeParse({
        ok: true,
        next: "later",
        at: null,
        turnsLeft: 1,
        quiet: false,
      }).success,
    ).toBe(false);
    expect(
      AgentChannelTaskContinueResponse.safeParse({
        ok: true,
        next: "at",
        at: null,
        turnsLeft: -1,
        quiet: false,
      }).success,
    ).toBe(false);
    expect(AgentChannelTaskFinishResponse.safeParse({ ok: true, status: "stopped" }).success).toBe(false);
    expect(
      AgentChannelTaskStartResponse.safeParse({ ok: true, taskId: TASK, maxTurns: 0, deadlineAt: LATER })
        .success,
    ).toBe(false);
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
    const fresh = {
      ...task,
      status: "running",
      progress: null,
      nextStep: null,
      turnsUsed: 1,
      waiting: null,
      finishedProcesses: [],
    };
    expect(TurnTask.parse(fresh)).toEqual(fresh);
    expect(TurnTask.safeParse({ ...task, status: "done" }).success).toBe(false);
    expect(TurnTask.safeParse({ ...task, maxTurns: 0 }).success).toBe(false);
    expect(TurnTask.safeParse({ ...task, turnsUsed: -1 }).success).toBe(false);
    expect(TurnTask.safeParse({ ...task, finishedProcesses: Array(11).fill(exited) }).success).toBe(false);
    expect(
      TurnTask.parse({ ...task, finishedProcesses: Array(10).fill(exited) }).finishedProcesses,
    ).toHaveLength(10);
    expect(
      TurnTask.safeParse({ ...task, waiting: { kind: "forever", ref: null, until: null } }).success,
    ).toBe(false);
    expect(
      TurnTask.safeParse({ ...task, waiting: { kind: "timer", ref: "r".repeat(65), until: null } }).success,
    ).toBe(false);
    expect(TurnTask.safeParse({ ...task, goal: "a\nb" }).success).toBe(false);
  });
});

describe("07.17.1.1.2 tasks: the platform task card (D-05, PD-11, PD-12, T-07.17.1.1.2-01-05)", () => {
  const link = {
    taskId: TASK,
    status: "waiting",
    outcome: null,
    turnsUsed: 7,
    maxTurns: 40,
    startedAt: AT,
    deadlineAt: LATER,
    finishedAt: null,
    requesterId: ANA,
    requesterName: "Ana",
    waiting: "process",
  };
  const card = {
    kind: "task",
    title: "Read the knowledge pack and summarise it",
    fields: [
      { label: "Progress", value: "Read 400 of 3030 files" },
      { label: "Next step", value: "Read the next 400" },
    ],
    status: "running",
    actions: [{ kind: "follow", label: "Follow" }],
    version: 3,
    decision: null,
    updatedAt: AT,
    viewerCan: ["follow", "stop"],
    platformOwned: true,
    statusLabel: "Waiting",
    task: link,
  };

  it("AgentCard parses a task card with its link and Stop; an older card without task parses unchanged", () => {
    expect(AgentCardKind.options).toContain("task");
    expect(AgentCard.parse(card)).toEqual(card);
    const { task: _task, viewerCan: _viewerCan, ...older } = card;
    const report = { ...older, kind: "report", platformOwned: undefined, statusLabel: undefined };
    const parsed = AgentCard.parse(report);
    expect(parsed).toEqual(report);
    expect("task" in parsed).toBe(false);
    expect(AgentCard.parse({ ...card, task: null }).task).toBeNull();
    expect(AgentCard.safeParse({ ...card, viewerCan: ["cancel"] }).success).toBe(false);
  });

  it("AgentCardTaskLink: the platform's numbers and the requester, no viewer field", () => {
    expect(AgentCardTaskLink.parse(link)).toEqual(link);
    const done = { ...link, status: "stopped", outcome: "budget_turns", finishedAt: LATER, waiting: null };
    expect(AgentCardTaskLink.parse(done)).toEqual(done);
    expect(AgentCardTaskLink.safeParse({ ...link, status: "paused" }).success).toBe(false);
    expect(AgentCardTaskLink.safeParse({ ...link, outcome: "exploded" }).success).toBe(false);
    expect(AgentCardTaskLink.safeParse({ ...link, requesterName: "n".repeat(201) }).success).toBe(false);
    expect(AgentCardTaskLink.safeParse({ ...link, waiting: "forever" }).success).toBe(false);
    // A viewer field never travels in the link (realtime events may carry it to every reader).
    expect("canStop" in AgentCardTaskLink.parse({ ...link, canStop: true })).toBe(false);
    // 07.17.1.1.2-10: the timer's due time is additive (an older link without it still parses).
    const timer = { ...link, status: "waiting", waiting: "timer", wakeAt: LATER };
    expect(AgentCardTaskLink.parse(timer)).toEqual(timer);
    expect(AgentCardTaskLink.parse({ ...link, wakeAt: null }).wakeAt).toBeNull();
    expect("wakeAt" in AgentCardTaskLink.parse(link)).toBe(false);
    expect(AgentCardTaskLink.safeParse({ ...link, wakeAt: "soon" }).success).toBe(false);
  });

  it("AgentCardInput refuses the platform-owned kinds (task, browser) and still accepts report", () => {
    const input = {
      kind: "report",
      title: "Weekly report",
      fields: [],
      status: "info",
      actions: [],
      summary: "The weekly report.",
    };
    expect(AgentCardInput.parse(input).kind).toBe("report");
    expect(AgentCardInput.safeParse({ ...input, kind: "task" }).success).toBe(false);
    expect(AgentCardInput.safeParse({ ...input, kind: "browser" }).success).toBe(false);
  });

  it("BotTaskStopResponse: ok and the task's status", () => {
    expect(BotTaskStopResponse.parse({ ok: true, status: "stopped" })).toEqual({
      ok: true,
      status: "stopped",
    });
    expect(BotTaskStopResponse.parse({ ok: true, status: "done" })).toEqual({ ok: true, status: "done" });
    expect(BotTaskStopResponse.safeParse({ ok: false, status: "stopped" }).success).toBe(false);
  });
});

describe("07.17.1.1.2 tasks: labels, cadence and sentences (D-05, D-11, D-12, PD-10, PD-18)", () => {
  it("taskStatusLabel maps every status and outcome to the card's word, at most 24 characters", () => {
    expect(taskStatusLabel("running", null)).toBe("Working");
    expect(taskStatusLabel("waiting", null)).toBe("Waiting");
    expect(taskStatusLabel("done", "done")).toBe("Done");
    expect(taskStatusLabel("failed", "blocked")).toBe("Blocked");
    expect(taskStatusLabel("failed", "no_progress")).toBe("Blocked");
    expect(taskStatusLabel("failed", "error")).toBe("Failed");
    expect(taskStatusLabel("failed", null)).toBe("Failed");
    expect(taskStatusLabel("stopped", "budget_turns")).toBe("Stopped");
    expect(taskStatusLabel("stopped", "stopped_by_person")).toBe("Stopped");
    for (const status of BotTaskStatus.options) {
      for (const outcome of [null, ...BotTaskOutcome.options]) {
        expect(taskStatusLabel(status, outcome).length).toBeLessThanOrEqual(24);
      }
    }
    expect(Object.values(TASK_STATUS_LABELS).sort()).toEqual(
      ["Blocked", "Done", "Failed", "Stopped", "Waiting", "Working"].sort(),
    );
  });

  it("taskCardStatus never flaps between turns: running and waiting are both running", () => {
    expect(taskCardStatus("running")).toBe("running");
    expect(taskCardStatus("waiting")).toBe("running");
    expect(taskCardStatus("done")).toBe("succeeded");
    expect(taskCardStatus("failed")).toBe("failed");
    expect(taskCardStatus("stopped")).toBe("cancelled");
    for (const status of BotTaskStatus.options) {
      expect(AgentCardStatus.options).toContain(taskCardStatus(status));
    }
  });

  it("the card's field labels", () => {
    expect(TASK_CARD_FIELD_LABELS).toEqual({ progress: "Progress", next: "Next step" });
  });

  it("taskQuiet: at most one visible post every 5 turns or 10 minutes", () => {
    const lastPostAt = new Date("2026-11-12T10:00:00.000Z");
    const at = (minutes: number) => new Date(lastPostAt.getTime() + minutes * 60_000);
    expect(taskQuiet({ turnsUsed: 2, lastPostTurn: 1, lastPostAt, now: at(2) })).toBe(true);
    expect(taskQuiet({ turnsUsed: 5, lastPostTurn: 1, lastPostAt, now: at(2) })).toBe(true);
    expect(taskQuiet({ turnsUsed: 6, lastPostTurn: 1, lastPostAt, now: at(2) })).toBe(false);
    expect(taskQuiet({ turnsUsed: 2, lastPostTurn: 1, lastPostAt, now: at(11) })).toBe(false);
    expect(taskQuiet({ turnsUsed: 2, lastPostTurn: 1, lastPostAt, now: at(10) })).toBe(false);
    expect(taskQuiet({ turnsUsed: 2, lastPostTurn: 1, lastPostAt, now: at(9.99) })).toBe(true);
  });

  it("taskContinueSentence: the verbatim server sentence per wake reason", () => {
    expect(taskContinueSentence("continue", 2, 40)).toBe("Continue your task (turn 2 of 40).");
    expect(taskContinueSentence("timer", 7, 40)).toBe(
      "The wait you asked for is over. Continue your task (turn 7 of 40).",
    );
    expect(taskContinueSentence("process", 3, 40)).toBe(
      "A background command of your task ended. Continue your task (turn 3 of 40).",
    );
    expect(taskContinueSentence("nudge", 4, 40)).toBe(
      "Your last turn ended without ocw_task_continue or ocw_task_finish. Continue the task or finish it (turn 4 of 40).",
    );
    for (const reason of BotTaskWakeReason.options) {
      expect(taskContinueSentence(reason, 200, 200).length).toBeLessThanOrEqual(300);
    }
  });

  it("taskStopSentence: the message the platform posts as the bot, or none", () => {
    const p = { maxTurns: 40, maxHours: 8 };
    expect(taskStopSentence("budget_turns", p)).toBe(
      "I stopped this task after 40 turns, the limit for one task. The card shows where it got to.",
    );
    expect(taskStopSentence("budget_time", p)).toBe(
      "I stopped this task after 8 h, the limit for one task. The card shows where it got to.",
    );
    expect(taskStopSentence("daily_limit", p)).toBe(
      "I stopped this task: I reached my turn limit for today. The card shows where it got to.",
    );
    expect(taskStopSentence("policy_off", p)).toBe("I stopped this task: long tasks were turned off for me.");
    expect(taskStopSentence("no_progress", p)).toBe(
      "I stopped this task: two turns in a row ended without progress. The card shows where it got to.",
    );
    expect(taskStopSentence("blocked", p)).toBe(
      "I need you to go on with this task. See my reply in this conversation.",
    );
    // Code review WR-03: a delivery error that persisted tells the person once.
    expect(taskStopSentence("error", p)).toBe(
      "I stopped this task: an error kept me from going on. The card shows where it got to.",
    );
    for (const outcome of ["done", "access_lost", "bot_unavailable", "stopped_by_person"] as const) {
      expect(taskStopSentence(outcome, p), outcome).toBeNull();
    }
    for (const outcome of BotTaskOutcome.options) {
      expect((taskStopSentence(outcome, { maxTurns: 200, maxHours: 24 }) ?? "").length).toBeLessThanOrEqual(
        300,
      );
    }
  });

  it("taskStopNotice: the card's notice per outcome, at most 200 characters", () => {
    const p = { maxTurns: 40, maxHours: 8 };
    expect(taskStopNotice("budget_turns", p)).toBe("Stopped: it used its 40 turns.");
    expect(taskStopNotice("budget_time", p)).toBe("Stopped: it ran for 8 h.");
    expect(taskStopNotice("daily_limit", p)).toBe("Stopped: the bot's daily limit was reached.");
    expect(taskStopNotice("policy_off", p)).toBe("Stopped: long tasks were turned off.");
    expect(taskStopNotice("access_lost", p)).toBe(
      "Stopped: the person it runs for can no longer read this conversation.",
    );
    expect(taskStopNotice("bot_unavailable", p)).toBe("Stopped: the bot is not available here any more.");
    expect(taskStopNotice("stopped_by_person", { ...p, byName: "Ana" })).toBe("Stopped by Ana.");
    expect(taskStopNotice("stopped_by_person", { ...p, byName: null })).toBe("Stopped.");
    expect(taskStopNotice("stopped_by_person", p)).toBe("Stopped.");
    expect(taskStopNotice("stopped_by_person", { ...p, byName: "   " })).toBe("Stopped.");
    expect(taskStopNotice("no_progress", p)).toBe("Stopped: two turns in a row ended without progress.");
    expect(taskStopNotice("error", p)).toBe("Stopped after an error.");
    expect(taskStopNotice("done", p)).toBeNull();
    expect(taskStopNotice("blocked", p)).toBeNull();
    const long = taskStopNotice("stopped_by_person", { ...p, byName: "N".repeat(200) }) ?? "";
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.startsWith("Stopped by NNN")).toBe(true);
    expect(long.endsWith(".")).toBe(true);
    for (const outcome of BotTaskOutcome.options) {
      expect((taskStopNotice(outcome, { maxTurns: 200, maxHours: 24 }) ?? "").length).toBeLessThanOrEqual(
        200,
      );
    }
  });
});
