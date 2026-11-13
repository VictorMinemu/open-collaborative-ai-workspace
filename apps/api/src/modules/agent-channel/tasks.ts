import {
  BOT_TASK_ACTIVE,
  BOT_TASK_LIMITS,
  type BotTaskOutcome,
  type BotTaskRefusal,
  type BotTaskStatus,
  type BotTaskWaitKind,
  type BotTaskWakeReason,
  type TaskWaitFor,
  taskQuiet,
  taskStopSentence,
} from "@ocw/contracts";
import {
  agents,
  agentTurns,
  botTaskProcesses,
  botTasks,
  botWorkSessions,
  conversations,
  messageCardFollows,
  messages,
  type Tx,
  tenantOf,
  workSessions,
} from "@ocw/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { agentFacts, findAgent, loadAgentUnit } from "../agent";
import { loadTaskPolicy } from "../bot-capabilities";
import { channelFacts, createConversationAccess, loadDirectory } from "../chat";
import { agentResource, channelResource, type PermissionService } from "../organization";
import type { AgentTurnRow } from "./claim";
import { postTaskCard, refreshTaskCard, taskMaxHours } from "./task-card";
import { taskThreadKey } from "./task-offer";
import { judgedConversationId } from "./work-session-calls";

/**
 * Phase 07.17.1.1.2 (D-01, D-02, D-04, D-05, D-07, D-12; PD-05, PD-08 … PD-12, PD-18, PD-19; ADR-0042): the long task's
 * state machine. The platform owns the task: its row, budgets, waits, card and audit live here, and every route and
 * delivery re-decides from the stored turn and the row under its lock, never from a body. The bot's goal, notes and
 * summary are its own untrusted text: they are stored on the row and shown on the card as text, and never reach an
 * audit row, a tool-call record, a job payload or a log line (P1: ids, counts, reasons and codes only).
 *
 * Lock order: the organization's advisory lock (`bot_tasks:<org>`, starts only) before any task row lock; a task row
 * before its card row.
 */

export type BotTaskRow = typeof botTasks.$inferSelect;

/** What a cell call's audit rows carry (`cellAuditBase`); absent for a person's request (the transaction's context). */
export interface TaskAuditBase {
  clientKind: string;
  sessionId: string;
}

/** The only keys a task audit carries besides `taskId` and `conversationId` (PD-19): ids, counts, reasons, codes. */
export interface TaskAuditMetadata {
  eventId?: string;
  turnsUsed?: number;
  maxTurns?: number;
  waitKind?: BotTaskWaitKind;
  reason?: string;
  outcome?: BotTaskOutcome;
  byUserId?: string;
  processId?: string;
}

export const isActiveTask = (t: Pick<BotTaskRow, "status">): boolean =>
  (BOT_TASK_ACTIVE as readonly string[]).includes(t.status);

const orgOf = (tx: Tx) => tenantOf(tx).organizationId;

/** The task row under `FOR UPDATE` (this organization's only, RLS and an explicit filter), or null. */
export async function lockTask(tx: Tx, id: string): Promise<BotTaskRow | null> {
  const [row] = await tx
    .select()
    .from(botTasks)
    .where(and(eq(botTasks.organizationId, orgOf(tx)), eq(botTasks.id, id)))
    .limit(1)
    .for("update");
  return row ?? null;
}

/**
 * PD-06's readiness rule, by the database's clock: the task's current turn reported done, or is older than 30 minutes
 * (lost), or is no turn at all. A waiting task's next turn is delivered only then (the continuation, and code review
 * WR-05 the Work Zone wake), so two turns of one task never overlap.
 */
export async function currentTurnDone(
  tx: Tx,
  task: Pick<BotTaskRow, "organizationId" | "currentEventId">,
): Promise<boolean> {
  const res = await tx.execute(sql`
    select coalesce((
      select t.done_at is not null or t.created_at <= now() - make_interval(mins => ${BOT_TASK_LIMITS.turnLostMinutes})
        from app.agent_turns t
       where t.organization_id = ${task.organizationId} and t.event_id = ${task.currentEventId}::uuid
    ), true) as done`);
  return (res.rows[0] as { done: boolean }).done;
}

/** The task a delivered turn belongs to (`agent_turns.task_id`: its start turn, a continuation or a control turn). */
export async function taskOfTurn(tx: Tx, eventId: string): Promise<BotTaskRow | null> {
  const [turn] = await tx
    .select({ taskId: agentTurns.taskId })
    .from(agentTurns)
    .where(and(eq(agentTurns.organizationId, orgOf(tx)), eq(agentTurns.eventId, eventId)))
    .limit(1);
  if (!turn?.taskId) return null;
  const [row] = await tx
    .select()
    .from(botTasks)
    .where(and(eq(botTasks.organizationId, orgOf(tx)), eq(botTasks.id, turn.taskId)))
    .limit(1);
  return row ?? null;
}

/** One task audit row (PD-19): actor and agent the bot (or the person who acted), user the requester. */
export async function auditTask(
  tx: Tx,
  core: Core,
  action: "bot.task_started" | "bot.task_finished" | "bot.task_stopped" | "bot.task_continued",
  task: Pick<BotTaskRow, "id" | "agentId" | "requesterUserId" | "conversationId">,
  metadata: TaskAuditMetadata,
  opts: { auditBase?: TaskAuditBase; actorUserId?: string | null } = {},
): Promise<void> {
  await core.audit.record(tx, {
    ...(opts.auditBase ?? {}),
    action,
    actorKind: opts.actorUserId ? "user" : "agent",
    actorId: opts.actorUserId ?? task.agentId,
    agentId: task.agentId,
    userId: task.requesterUserId,
    resourceType: "bot_task",
    resourceId: task.id,
    result: "success",
    metadata: { taskId: task.id, conversationId: task.conversationId, ...metadata },
  });
}

/** `bot.task_refused` (PD-08): the turn, the tool and the code; the task's id when there is one. */
export async function auditTaskRefused(
  tx: Tx,
  core: Core,
  p: {
    auditBase: TaskAuditBase;
    turn: Pick<AgentTurnRow, "eventId" | "agentId" | "userId" | "conversationId">;
    tool: string;
    code: BotTaskRefusal;
    task: Pick<BotTaskRow, "id"> | null;
  },
): Promise<void> {
  await core.audit.record(tx, {
    ...p.auditBase,
    action: "bot.task_refused",
    actorKind: "agent",
    actorId: p.turn.agentId,
    agentId: p.turn.agentId,
    userId: p.turn.userId,
    resourceType: "bot_task",
    resourceId: p.task?.id ?? null,
    result: "denied",
    metadata: {
      taskId: p.task?.id ?? null,
      conversationId: p.turn.conversationId,
      eventId: p.turn.eventId,
      tool: p.tool,
      code: p.code,
    },
  });
}

/** PD-09: the organization's task lock, taken before anything a start reads (two starts cannot both pass the cap). */
async function lockOrganizationTasks(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`bot_tasks:${orgOf(tx)}`}, 0))`);
}

/** The bot's active task in one thread (the key of `bot_tasks_one_active_idx`), or null. */
async function activeTaskIn(
  tx: Tx,
  p: { agentId: string; conversationId: string; threadRootId: string | null },
): Promise<BotTaskRow | null> {
  const [row] = await tx
    .select()
    .from(botTasks)
    .where(
      and(
        eq(botTasks.organizationId, orgOf(tx)),
        eq(botTasks.agentId, p.agentId),
        eq(botTasks.conversationId, p.conversationId),
        p.threadRootId === null ? isNull(botTasks.threadRootId) : eq(botTasks.threadRootId, p.threadRootId),
        inArray(botTasks.status, [...BOT_TASK_ACTIVE]),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type StartTaskResult =
  | { ok: true; task: BotTaskRow }
  | { ok: false; code: "task_active" | "policy_off" | "org_cap"; task: BotTaskRow | null };

/**
 * Starts a task for a delivered turn (PD-05, PD-08, PD-09, PD-11), in the turn's tenant transaction: under the
 * organization's lock, no active task of this bot in the turn's thread (`task_active`), the re-decided policy
 * (`policy_off`) and the organization's running cap (`org_cap`, `maxRunning` 0 = none may run); then the row (`running`,
 * one turn used, the turn as its start and current turn, the budget snapshotted from the policy), the turn's ledger
 * link, the live card in the asker's thread, the requester's follow and `bot.task_started`.
 */
export async function startTask(
  tx: Tx,
  core: Core,
  p: { turn: AgentTurnRow; goal: string; auditBase: TaskAuditBase },
): Promise<StartTaskResult> {
  const { turn } = p;
  await lockOrganizationTasks(tx);
  const [asked] = await tx
    .select({ threadId: messages.threadId })
    .from(messages)
    .where(eq(messages.id, turn.messageId))
    .limit(1);
  const threadRootId = taskThreadKey(turn.conversationKind, asked?.threadId ?? turn.messageId);
  const where = { agentId: turn.agentId, conversationId: turn.conversationId, threadRootId };
  const active = await activeTaskIn(tx, where);
  if (active) return { ok: false, code: "task_active", task: active };

  const [agent] = await tx
    .select({ scope: agents.scope, capabilities: agents.capabilities })
    .from(agents)
    .where(eq(agents.id, turn.agentId))
    .limit(1);
  const policy = agent ? await loadTaskPolicy(tx, agent) : null;
  if (!policy?.enabled) return { ok: false, code: "policy_off", task: null };
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(botTasks)
    .where(and(eq(botTasks.organizationId, orgOf(tx)), inArray(botTasks.status, [...BOT_TASK_ACTIVE])));
  if ((count?.n ?? 0) >= policy.maxRunning) return { ok: false, code: "org_cap", task: null };

  const now = new Date();
  const deadline = new Date(now.getTime() + policy.maxHours * 3_600_000);
  const [inserted] = await tx
    .insert(botTasks)
    .values({
      organizationId: turn.organizationId,
      agentId: turn.agentId,
      conversationId: turn.conversationId,
      threadRootId,
      requesterUserId: turn.userId,
      startedEventId: turn.eventId,
      currentEventId: turn.eventId,
      status: "running",
      goal: p.goal,
      turnsUsed: 1,
      maxTurns: policy.maxTurns,
      startedAt: now.toISOString(),
      deadlineAt: deadline.toISOString(),
      updatedAt: now.toISOString(),
      lastPostTurn: 1,
      lastPostAt: now.toISOString(),
    })
    // The partial unique index is the backstop of the check above (one active task per bot and thread).
    .onConflictDoNothing()
    .returning();
  if (!inserted) return { ok: false, code: "task_active", task: await activeTaskIn(tx, where) };

  await tx
    .update(agentTurns)
    .set({ taskId: inserted.id })
    .where(and(eq(agentTurns.organizationId, orgOf(tx)), eq(agentTurns.eventId, turn.eventId)));
  const cardMessageId = await postTaskCard(tx, core, inserted, turn);
  const [task] = await tx
    .update(botTasks)
    .set({ cardMessageId })
    .where(and(eq(botTasks.organizationId, orgOf(tx)), eq(botTasks.id, inserted.id)))
    .returning();
  if (!task) throw new Error("bot task vanished during its start");
  await tx
    .insert(messageCardFollows)
    .values({ organizationId: task.organizationId, messageId: cardMessageId, userId: task.requesterUserId })
    .onConflictDoNothing();
  await auditTask(
    tx,
    core,
    "bot.task_started",
    task,
    { eventId: turn.eventId, turnsUsed: task.turnsUsed, maxTurns: task.maxTurns },
    { auditBase: p.auditBase },
  );
  return { ok: true, task };
}

// ---------------------------------------------------------------- continue (PD-05, PD-08 … PD-10)

/** The awaited Work Zone session as the user-less read of tx0 saw it (the person may not see the session row). */
export interface TaskSessionFact {
  taskId: string | null;
  ended: boolean;
}

/** Ended Work Zone session statuses (nothing more will wake a task). */
const SESSION_ENDED = ["completed", "failed", "archived"] as const;

/**
 * The bot Work Zone session `workSessionId` of this organization: the task that started it and whether it ended. Read
 * user-less (the session's audience backstop judges people, and the requester need not be in it).
 */
export async function taskSessionOf(tx: Tx, workSessionId: string): Promise<TaskSessionFact | null> {
  const [row] = await tx
    .select({ taskId: botWorkSessions.taskId, status: workSessions.status })
    .from(botWorkSessions)
    .innerJoin(
      workSessions,
      and(
        eq(workSessions.organizationId, botWorkSessions.organizationId),
        eq(workSessions.id, botWorkSessions.workSessionId),
      ),
    )
    .where(
      and(eq(botWorkSessions.organizationId, orgOf(tx)), eq(botWorkSessions.workSessionId, workSessionId)),
    )
    .limit(1);
  if (!row) return null;
  return { taskId: row.taskId, ended: (SESSION_ENDED as readonly string[]).includes(row.status) };
}

export type TaskNext = "after_turn" | "at" | "on_process" | "on_session";

export type ContinueTaskResult =
  | { ok: true; task: BotTaskRow; next: TaskNext; at: string | null; turnsLeft: number; quiet: boolean }
  | { ok: false; code: "policy_off" | "budget_turns" | "budget_time" | "wait_unknown" };

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/**
 * The bot schedules its own next turn (PD-05, PD-08 … PD-10), on `task` locked by the caller (the busy, terminal and
 * requester checks done). Re-decided first: long tasks off since the start (`policy_off`), every turn used
 * (`budget_turns`) or the deadline passed (`budget_time`) stop the task with one message; a `waitFor` that is not this
 * task's running process or live Work Zone session is `wait_unknown` (nothing changes). Then the wait (`turn`: the
 * 30-minute backstop, the turn-done hook of 09 shortens it; `timer`: at least 5 s; `process`: its deadline or the
 * timer; `session`: an hour or the timer; an already ended process: after the turn, listed on the next turn), every
 * `wake_at` capped at the deadline, the row `waiting` with `wait_seq + 1`, the card refreshed and one ids-only
 * `bot_task.continue` job at `wake_at` (no singleton key: extra jobs are harmless, 09 decides under the lock).
 *
 * `quiet` (D-11, PD-10): true only on a platform-delivered task turn (the task's current turn, not its start turn)
 * inside the cadence; when false the visible post is recorded (`last_post_turn`, `last_post_at`).
 */
export async function continueTask(
  tx: Tx,
  core: Core,
  task: BotTaskRow,
  p: {
    turn: Pick<AgentTurnRow, "eventId">;
    progress: string;
    nextStep: string;
    afterSeconds?: number | undefined;
    waitFor?: TaskWaitFor | undefined;
    /** `waitFor.workSessionId`'s session as tx0 read it (null: no such session). */
    session?: TaskSessionFact | null;
    auditBase?: TaskAuditBase;
  },
): Promise<ContinueTaskResult> {
  const now = new Date();
  const stop = async (outcome: "policy_off" | "budget_turns" | "budget_time") => {
    await stopTask(tx, core, task, outcome, {
      eventId: p.turn.eventId,
      ...(p.auditBase ? { auditBase: p.auditBase } : {}),
    });
    return { ok: false as const, code: outcome };
  };
  const [agent] = await tx
    .select({ scope: agents.scope, capabilities: agents.capabilities })
    .from(agents)
    .where(eq(agents.id, task.agentId))
    .limit(1);
  const policy = agent ? await loadTaskPolicy(tx, agent) : null;
  if (!policy?.enabled) return stop("policy_off");
  if (task.turnsUsed >= task.maxTurns) return stop("budget_turns");
  const deadline = new Date(task.deadlineAt);
  if (now.getTime() >= deadline.getTime()) return stop("budget_time");

  const after =
    p.afterSeconds && p.afterSeconds > 0 ? Math.max(p.afterSeconds, BOT_TASK_LIMITS.minGapSeconds) : 0;
  const timer = after > 0 ? new Date(now.getTime() + after * SECOND) : null;
  const backstop = new Date(now.getTime() + BOT_TASK_LIMITS.backstopMinutes * MINUTE);
  let kind: BotTaskWaitKind = "turn";
  let ref: string | null = null;
  let wake = backstop;
  let next: TaskNext = "after_turn";
  if (p.waitFor && "processId" in p.waitFor) {
    const [proc] = await tx
      .select({ status: botTaskProcesses.status, deadlineAt: botTaskProcesses.deadlineAt })
      .from(botTaskProcesses)
      .where(
        and(
          eq(botTaskProcesses.organizationId, orgOf(tx)),
          eq(botTaskProcesses.taskId, task.id),
          eq(botTaskProcesses.agentId, task.agentId),
          eq(botTaskProcesses.processId, p.waitFor.processId),
        ),
      )
      .limit(1);
    if (!proc) return { ok: false, code: "wait_unknown" };
    if (proc.status === "running") {
      kind = "process";
      ref = p.waitFor.processId;
      wake = timer ?? new Date(proc.deadlineAt);
      next = "on_process";
    }
    // An ended process: the next turn comes after this one and lists it (`finishedProcesses`).
  } else if (p.waitFor && "workSessionId" in p.waitFor) {
    if (!p.session || p.session.taskId !== task.id || p.session.ended)
      return { ok: false, code: "wait_unknown" };
    kind = "session";
    ref = p.waitFor.workSessionId;
    wake = timer ?? new Date(now.getTime() + BOT_TASK_LIMITS.sessionWaitMinutes * MINUTE);
    next = "on_session";
  } else if (timer) {
    kind = "timer";
    wake = timer;
    next = "at";
  }
  if (wake.getTime() > deadline.getTime()) wake = deadline;

  const platformTurn = p.turn.eventId === task.currentEventId && p.turn.eventId !== task.startedEventId;
  const quiet =
    platformTurn &&
    taskQuiet({
      turnsUsed: task.turnsUsed,
      lastPostTurn: task.lastPostTurn,
      lastPostAt: new Date(task.lastPostAt ?? task.startedAt),
      now,
    });
  const [row] = await tx
    .update(botTasks)
    .set({
      status: "waiting",
      progress: p.progress,
      nextStep: p.nextStep,
      waitKind: kind,
      waitRef: ref,
      wakeAt: wake.toISOString(),
      waitSeq: sql`${botTasks.waitSeq} + 1`,
      nudged: false,
      updatedAt: now.toISOString(),
      ...(quiet ? {} : { lastPostTurn: task.turnsUsed, lastPostAt: now.toISOString() }),
    })
    .where(and(eq(botTasks.organizationId, orgOf(tx)), eq(botTasks.id, task.id)))
    .returning();
  if (!row) throw new Error("bot task vanished during its continue");
  await refreshTaskCard(tx, core, row);
  await core.jobs.sendInTx(
    tx,
    "bot_task.continue",
    { organizationId: row.organizationId, taskId: row.id },
    { startAfter: wake },
  );
  return {
    ok: true,
    task: row,
    next,
    at: next === "after_turn" ? null : wake.toISOString(),
    turnsLeft: Math.max(0, row.maxTurns - row.turnsUsed),
    quiet,
  };
}

/**
 * A wait ends and the task's next turn is delivered (09's continuation, 12's Work Zone wake): `running`, one more turn,
 * `eventId` as its current turn, `wait_seq + 1` and the wait cleared, on `task` locked by the caller. False when the task
 * is not waiting (already delivered, ended or stopped): nothing changes. `reason` is why the wait ended; the caller's
 * own audit carries it.
 */
export async function consumeWait(
  tx: Tx,
  task: Pick<BotTaskRow, "id">,
  p: { eventId: string; reason: BotTaskWakeReason },
): Promise<boolean> {
  const [row] = await tx
    .update(botTasks)
    .set({
      status: "running",
      turnsUsed: sql`${botTasks.turnsUsed} + 1`,
      currentEventId: p.eventId,
      waitSeq: sql`${botTasks.waitSeq} + 1`,
      waitKind: null,
      waitRef: null,
      wakeAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(eq(botTasks.organizationId, orgOf(tx)), eq(botTasks.id, task.id), eq(botTasks.status, "waiting")),
    )
    .returning({ id: botTasks.id });
  return row !== undefined;
}

// ---------------------------------------------------------------- finish and stop (PD-05, PD-18)

/** The platform's stops: `failed` for a task that made no progress or hit an error, `stopped` for the rest. */
export type TaskStopOutcome = Exclude<BotTaskOutcome, "done" | "blocked">;

const FAILED_STOPS: ReadonlySet<TaskStopOutcome> = new Set<TaskStopOutcome>(["no_progress", "error"]);

/**
 * The bot ends its task (D-02): `done` → `done`; `blocked` → `failed` with outcome `blocked` and one message mentioning
 * the requester. `bot.task_finished`; the card says so and its followers hear it.
 */
export async function finishTask(
  tx: Tx,
  core: Core,
  task: BotTaskRow,
  p: {
    turn: Pick<AgentTurnRow, "eventId">;
    summary: string;
    outcome: "done" | "blocked";
    auditBase?: TaskAuditBase;
  },
): Promise<BotTaskRow | null> {
  return endTask(tx, core, task, {
    status: p.outcome === "done" ? "done" : "failed",
    outcome: p.outcome,
    summary: p.summary,
    action: "bot.task_finished",
    notify: true,
    eventId: p.turn.eventId,
    ...(p.auditBase ? { auditBase: p.auditBase } : {}),
  });
}

/**
 * The platform stops a task (budgets, the policy, the daily limit, lost access, the bot gone, no progress, an error, a
 * person's Stop), on `task` locked by the caller: the terminal status, `finished_at`, the wait cleared and `wait_seq + 1`
 * (a queued job finds nothing to deliver), `stopped_by_user_id`, the card with its notice and one `bot.task_stopped`.
 * After commit, one message `@<requester> <taskStopSentence>` in the task's thread, only when the outcome has a
 * sentence, `notify` is not false and the requester still reads the conversation (PD-18). Null when the task had already
 * ended (idempotent: nothing written).
 */
export async function stopTask(
  tx: Tx,
  core: Core,
  task: BotTaskRow,
  outcome: TaskStopOutcome,
  opts: { byUserId?: string | null; notify?: boolean; eventId?: string; auditBase?: TaskAuditBase } = {},
): Promise<BotTaskRow | null> {
  return endTask(tx, core, task, {
    status: FAILED_STOPS.has(outcome) ? "failed" : "stopped",
    outcome,
    action: "bot.task_stopped",
    notify: opts.notify !== false,
    byUserId: opts.byUserId ?? null,
    ...(opts.eventId ? { eventId: opts.eventId } : {}),
    ...(opts.auditBase ? { auditBase: opts.auditBase } : {}),
  });
}

async function endTask(
  tx: Tx,
  core: Core,
  task: BotTaskRow,
  p: {
    status: Exclude<BotTaskStatus, "running" | "waiting">;
    outcome: BotTaskOutcome;
    summary?: string;
    action: "bot.task_finished" | "bot.task_stopped";
    notify: boolean;
    byUserId?: string | null;
    eventId?: string;
    auditBase?: TaskAuditBase;
  },
): Promise<BotTaskRow | null> {
  const now = new Date().toISOString();
  const [row] = await tx
    .update(botTasks)
    .set({
      status: p.status,
      outcome: p.outcome,
      ...(p.summary !== undefined ? { summary: p.summary } : {}),
      finishedAt: now,
      updatedAt: now,
      waitKind: null,
      waitRef: null,
      wakeAt: null,
      waitSeq: sql`${botTasks.waitSeq} + 1`,
      stoppedByUserId: p.byUserId ?? null,
    })
    .where(
      and(
        eq(botTasks.organizationId, orgOf(tx)),
        eq(botTasks.id, task.id),
        inArray(botTasks.status, [...BOT_TASK_ACTIVE]),
      ),
    )
    .returning();
  if (!row) return null;
  const dir = await loadDirectory(tx);
  const stoppedByName = p.byUserId ? (dir.users.get(p.byUserId)?.displayName ?? null) : null;
  await refreshTaskCard(tx, core, row, { stoppedByName });
  const sentence = taskStopSentence(p.outcome, { maxTurns: row.maxTurns, maxHours: taskMaxHours(row) });
  const handle = dir.users.get(row.requesterUserId)?.handle;
  if (sentence && p.notify && handle && (await requesterReads(tx, core, row))) {
    postTaskMessage(tx, core, row, `@${handle} ${sentence}`);
  }
  await auditTask(
    tx,
    core,
    p.action,
    row,
    {
      ...(p.eventId ? { eventId: p.eventId } : {}),
      outcome: p.outcome,
      turnsUsed: row.turnsUsed,
      maxTurns: row.maxTurns,
      ...(p.byUserId ? { byUserId: p.byUserId } : {}),
    },
    { ...(p.auditBase ? { auditBase: p.auditBase } : {}), actorUserId: p.byUserId ?? null },
  );
  return row;
}

/** Whether the person a task runs for still reads its conversation (a thread through its channel). */
async function requesterReads(tx: Tx, core: Core, task: BotTaskRow): Promise<boolean> {
  const judged = await judgedConversationId(tx, task.conversationId);
  return createConversationAccess(core).isReadable(tx, task.requesterUserId, judged, {
    kinds: ["channel", "dm", "group"],
  });
}

/**
 * PD-18: the task's one end message, posted as the bot after commit through the limit notice's path (its own
 * transaction: inside this one it would wait on the conversation's stream lock), for the requester, idempotent on
 * `task:<id>:end`. A refused post (the person or the bot lost access in between) is logged with ids only.
 */
function postTaskMessage(tx: Tx, core: Core, task: BotTaskRow, body: string): void {
  const { organizationId, afterCommit } = tenantOf(tx);
  afterCommit(async () => {
    try {
      await core.chatAgent.postAgentMessage(
        { organizationId, userId: null },
        {
          agentId: task.agentId,
          conversationId: task.conversationId,
          threadRootId: task.threadRootId,
          body,
          idempotencyKey: `task:${task.id}:end`,
          onBehalfOfUserId: task.requesterUserId,
        },
      );
    } catch (err) {
      core.log.warn(
        {
          taskId: task.id,
          agentId: task.agentId,
          conversationId: task.conversationId,
          code: (err as { code?: unknown } | null)?.code ?? (err instanceof Error ? err.name : "unknown"),
        },
        "task end message could not be posted",
      );
    }
  });
}

// ---------------------------------------------------------------- who may stop (PD-12)

/**
 * The one rule of who may stop a task (PD-12), used by the Stop route and by the card's `viewerCan.stop` (10): the person
 * it runs for; a moderator of its channel (`message.delete_any` on the channel's facts, the chain Stop's rule: admins,
 * never in a direct conversation); or the bot's manager on its bot resource (`bot.configure` for a personal bot's
 * owner, `bot.manage` or, for a unit persona, `bot.manage_unit` for a team bot), the decisions the agent module makes.
 * Reading the conversation is the caller's check (a reader who may not stop is 403, a non-reader 404).
 */
export async function mayStopTask(
  tx: Tx,
  _core: Core,
  perms: PermissionService,
  task: Pick<BotTaskRow, "requesterUserId" | "conversationId" | "agentId">,
  userId: string,
): Promise<boolean> {
  if (task.requesterUserId === userId) return true;
  const principal = { kind: "user", userId } as const;
  const judgedId = await judgedConversationId(tx, task.conversationId);
  const [conv] = await tx.select().from(conversations).where(eq(conversations.id, judgedId)).limit(1);
  if (conv?.kind === "channel") {
    const channel = channelResource(await channelFacts(tx, conv, { kind: "user", id: userId }));
    if ((await perms.decide(tx, principal, "message.delete_any", channel)).allowed) return true;
  }
  const agent = await findAgent(tx, task.agentId);
  if (!agent) return false;
  const unit = await loadAgentUnit(tx, agent.unitId);
  const bot = agentResource(agentFacts(agent, unit?.path ?? []), userId);
  if (agent.scope === "personal") return (await perms.decide(tx, principal, "bot.configure", bot)).allowed;
  if ((await perms.decide(tx, principal, "bot.manage", bot)).allowed) return true;
  return unit !== null && (await perms.decide(tx, principal, "bot.manage_unit", bot)).allowed;
}
