import { createHash } from "node:crypto";
import {
  AgentChannelEventTypes,
  type AgentTaskEvent,
  BOT_TASK_LIMITS,
  type BotTaskWaitKind,
  type BotTaskWakeReason,
  BUILTIN_TOOLS,
  cellTopic,
  type ModelRef,
  type TaskProcessFact,
  taskContinueSentence,
} from "@ocw/contracts";
import {
  agents,
  agentToolCalls,
  agentTurns,
  botTasks,
  conversationMembers,
  conversations,
  messages,
  orgMembers,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Core } from "../../core";
import type { AgentMention } from "../../lib/chat-agent-bridge";
import { type JobContext, type JobData, lastAttempt } from "../../lib/jobs";
import { findAgent } from "../agent";
import { loadTaskPolicy } from "../bot-capabilities";
import { createConversationAccess } from "../chat";
import type { MemoryService } from "../memory";
import type { PermissionService } from "../organization";
import { buildMentionEvents } from "./mentions";
import { refreshTaskCard } from "./task-card";
import { processWakeOf } from "./task-process-wakes";
import {
  auditTask,
  type BotTaskRow,
  consumeWait,
  isActiveTask,
  lockTask,
  stopTask,
  type TaskStopOutcome,
} from "./tasks";

/**
 * Phase 07.17.1.1.2 (D-02, D-03, D-04, D-07, D-08, D-12; PD-05, PD-06, PD-09, PD-11, PD-15, PD-18; ADR-0042): the
 * platform delivers a long task's next turn by itself. A structural copy of 07.16's `work-session-wakes.ts`: a derived
 * event id, then decide → deliver as the requester → release. The API is the only scheduler (P2): `ocw_task_continue`
 * queues one ids-only `bot_task.continue` job at the wait's `wake_at`; the cell's `POST /turns/:eventId/done` shortens
 * a "after this turn" wait to about 5 s and queues another (`taskTurnDone`). Extra jobs are harmless: everything is
 * decided again under the task's row lock with the wait's own event id.
 *
 * 1. decide, user-less (`withTenant(org, null)`, RLS, the task re-read by id `FOR UPDATE`): only a `waiting` task whose
 *    `wake_at` has come and whose current turn reported done (or is older than 30 minutes, lost) is delivered (PD-06).
 *    The turn's id is `taskEventId(task, wait_seq)`, so the same wait never produces two turns (`agent_turns.event_id`
 *    is the turn's key). Before the reservation, under the lock: every turn used, the deadline, long tasks off, the bot
 *    archived and the requester deactivated stop the task (D-04, D-07); the taint of every earlier task turn is carried
 *    (D-08, PD-15). The wait is then reserved (`consumeWait`: `running`, one more turn, the id as the current turn).
 * 2. deliver, as the requester (D-07, ADR-0019: they pay and their rights are re-decided): they still read the
 *    conversation, the bot is live and a member, the card is there; built like a mention of the bot on its task card,
 *    `trigger: "task"`, the fixed server sentence as the message (never the bot's notes, P4), `turnPolicy` decides tools
 *    and meters the bot's daily limit; `agent.task.v1` on `cell:<org>`, `bot.task_continued`.
 * 3. release, user-less, only when nothing was delivered: the reserved fields are restored exactly. A failure throws
 *    (pg-boss retries with backoff and decides again; the job's last attempt stops the task as `error`, code review
 *    WR-03); a refusal stops the task (`daily_limit` with its message; `access_lost` and `bot_unavailable` with a card
 *    notice only). The card shows the continuation once it is delivered.
 *
 * Audits and logs carry ids, counts and reasons only (P1); jobs carry `{ organizationId, taskId }` only (P7).
 */

export interface TaskWakesDeps {
  perms: PermissionService;
  modelLabel?: ((ref: ModelRef) => string) | undefined;
  memory?: MemoryService | undefined;
}

/** What one `bot_task.continue` run did (for tests and the log). */
export type TaskContinueOutcome = "delivered" | "stopped" | "none";

/** Direct conversations are flat: the continuation names the card message itself (PD-11). */
const DIRECT_KINDS = new Set(["dm", "group"]);
/** The kinds a task may live in (D-10: never an AI chat); a thread is judged through its parent. */
const READABLE_KINDS = ["channel", "dm", "group"] as const;

/** Why a wait ended, from what it waited for (a session wait past its hour is a timer). */
const REASON_OF: Readonly<Record<BotTaskWaitKind, BotTaskWakeReason>> = {
  turn: "continue",
  timer: "timer",
  process: "process",
  nudge: "nudge",
  session: "timer",
};

const orgOf = (tx: Tx) => tenantOf(tx).organizationId;

/**
 * A continuation's event id, derived from the task and the wait it ends (`wait_seq` before the wait is consumed), so a
 * retry, a duplicate job, the tick or a second done can never deliver the same wait twice. A UUID of version 8 (RFC
 * 9562, custom) from SHA-256, `wakeEventId`'s recipe under its own domain prefix.
 */
export function taskEventId(taskId: string, waitSeq: number): string {
  const h = createHash("sha256").update(`ocw.bot_task.turn\u0000${taskId}\u0000${waitSeq}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x80;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** Whether the turn `eventId` exists (it is written in the delivery's transaction, with its cell event). */
async function delivered(tx: Tx, eventId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: agentTurns.eventId })
    .from(agentTurns)
    .where(and(eq(agentTurns.organizationId, orgOf(tx)), eq(agentTurns.eventId, eventId)))
    .limit(1);
  return row !== undefined;
}

/** The fields the reservation changes, as they were, so `release` restores them exactly. */
type Reserved = Pick<
  BotTaskRow,
  "turnsUsed" | "currentEventId" | "waitSeq" | "waitKind" | "waitRef" | "wakeAt" | "updatedAt"
>;

interface ContinuePlan {
  /** The task after the reservation (`running`, the new turn counted, the id as its current turn). */
  task: BotTaskRow;
  eventId: string;
  reason: BotTaskWakeReason;
  /** The ended (or lost) command a `process` wait was woken by (PD-13), carried as `task.process`. */
  process: TaskProcessFact | null;
  tainted: boolean;
  previous: Reserved;
}

type Decision = { kind: "none" } | { kind: "stopped" } | { kind: "deliver"; plan: ContinuePlan };

/** The clock facts of a decision, from the database's `now()` (never the API's clock, Pitfall 7). */
async function clockOf(
  tx: Tx,
  task: BotTaskRow,
): Promise<{ due: boolean; pastDeadline: boolean; currentDone: boolean }> {
  const lost = BOT_TASK_LIMITS.turnLostMinutes;
  const res = await tx.execute(sql`
    select
      (${task.wakeAt}::timestamptz is null or ${task.wakeAt}::timestamptz <= now()) as due,
      (${task.deadlineAt}::timestamptz <= now()) as past_deadline,
      coalesce((
        select t.done_at is not null or t.created_at <= now() - make_interval(mins => ${lost})
          from app.agent_turns t
         where t.organization_id = ${orgOf(tx)} and t.event_id = ${task.currentEventId}::uuid
      ), true) as current_done`);
  const row = res.rows[0] as { due: boolean; past_deadline: boolean; current_done: boolean };
  return { due: row.due, pastDeadline: row.past_deadline, currentDone: row.current_done };
}

/** decide (tx1, user-less): whether the task's wait is delivered now, and its reservation. */
async function decide(tx: Tx, core: Core, taskId: string): Promise<Decision> {
  // RLS and an explicit filter: another organization's id finds nothing (E22).
  const task = await lockTask(tx, taskId);
  if (task?.status !== "waiting") return { kind: "none" };
  const clock = await clockOf(tx, task);
  // PD-06: not yet (an early job: the done or the timer queues another), or the turn that continued still runs.
  if (!clock.due || !clock.currentDone) return { kind: "none" };
  const eventId = taskEventId(task.id, task.waitSeq);
  let reason = REASON_OF[task.waitKind ?? "turn"];
  // A run whose outcome was lost delivered this very wait: the reservation is confirmed, nothing is sent again.
  if (await delivered(tx, eventId)) {
    await consumeWait(tx, task, { eventId, reason });
    return { kind: "none" };
  }

  // D-04, PD-09 (Pitfall 1): every budget and the policy, under the row lock, before the turn is metered. Each ends the
  // task with its card notice and one message mentioning the requester (PD-18).
  const [agent] = await tx
    .select({ scope: agents.scope, capabilities: agents.capabilities })
    .from(agents)
    .where(and(eq(agents.id, task.agentId), isNull(agents.deletedAt)))
    .limit(1);
  const stop = async (outcome: TaskStopOutcome, notify = true): Promise<Decision> => {
    await stopTask(tx, core, task, outcome, { notify });
    return { kind: "stopped" };
  };
  if (!agent) return stop("bot_unavailable", false);
  if (task.turnsUsed >= task.maxTurns) return stop("budget_turns");
  if (clock.pastDeadline) return stop("budget_time");
  if (!(await loadTaskPolicy(tx, agent)).enabled) return stop("policy_off");
  // D-07: a person who left the organization (deactivated) is never acted for; the card says why, no message.
  const [requester] = await tx
    .select({ deactivatedAt: orgMembers.deactivatedAt })
    .from(orgMembers)
    .where(eq(orgMembers.userId, task.requesterUserId))
    .limit(1);
  if (!requester || requester.deactivatedAt) return stop("access_lost", false);

  // D-08, PD-15 (Pitfall 6): taint is sticky. A turn of this task that read outside content (even after it called
  // continue) taints every later turn, and the task itself from then on.
  let tainted = task.tainted;
  if (!tainted) {
    const [taintedTurn] = await tx
      .select({ id: agentTurns.eventId })
      .from(agentTurns)
      .where(
        and(
          eq(agentTurns.organizationId, orgOf(tx)),
          eq(agentTurns.taskId, task.id),
          eq(agentTurns.tainted, true),
        ),
      )
      .limit(1);
    if (taintedTurn) {
      tainted = true;
      await tx
        .update(botTasks)
        .set({ tainted: true })
        .where(and(eq(botTasks.organizationId, orgOf(tx)), eq(botTasks.id, task.id)));
    }
  }

  // PD-13: a process wait carries the command's end, or `lost` once its deadline passed with no event (E20); a wait
  // that came by the bot's own `afterSeconds` while the command still runs is a timer.
  let process: TaskProcessFact | null = null;
  if (task.waitKind === "process") ({ reason, process } = await processWakeOf(tx, task));

  const previous: Reserved = {
    turnsUsed: task.turnsUsed,
    currentEventId: task.currentEventId,
    waitSeq: task.waitSeq,
    waitKind: task.waitKind,
    waitRef: task.waitRef,
    wakeAt: task.wakeAt,
    updatedAt: task.updatedAt,
  };
  if (!(await consumeWait(tx, task, { eventId, reason }))) return { kind: "none" };
  const reserved = await lockTask(tx, task.id);
  if (!reserved) return { kind: "none" };
  // Code review WR-03: the card says "Working" only once the turn is delivered (`cardAfterDelivery`), so a delivery
  // that fails and is given back never touches it.
  return { kind: "deliver", plan: { task: reserved, eventId, reason, process, tainted, previous } };
}

type DeliverResult =
  | { delivered: true }
  | { delivered: false; reason: "access_lost" | "bot_unavailable" | "daily_limit" }
  /** Code review CR-01: the task no longer holds this reservation (a Stop, a budget or policy stop landed first). */
  | { delivered: false; reason: "superseded" };

/**
 * deliver (tx2, as the requester): the continuation itself (D-07). Code review CR-01: the task row is locked first and
 * must still hold tx1's reservation (`running`, this delivery's id as its current turn, the reserved `wait_seq`); a stop
 * that committed in between (the Stop route, the tick, a policy stop) wins, and nothing is built, metered, appended or
 * audited. Holding the lock to the end, a later stop waits for this delivery (the in-flight turn finishes, D-07).
 */
async function deliver(tx: Tx, core: Core, deps: TaskWakesDeps, plan: ContinuePlan): Promise<DeliverResult> {
  const { task, eventId, reason } = plan;
  const taskFacts = { taskId: task.id, reason, ...(plan.process ? { process: plan.process } : {}) };
  const current = await lockTask(tx, task.id);
  // A concurrent run delivered this very wait since tx1 (its turn is keyed by the wait's own id).
  if (await delivered(tx, eventId)) return { delivered: true };
  if (!holdsReservation(current, plan)) return { delivered: false, reason: "superseded" };
  const [conv] = await tx
    .select({
      id: conversations.id,
      kind: conversations.kind,
      parentId: conversations.parentConversationId,
      archivedAt: conversations.archivedAt,
    })
    .from(conversations)
    .where(eq(conversations.id, task.conversationId))
    .limit(1);
  // The confused-deputy rule: the bot acts for a person who still reads the conversation (a thread through its parent).
  const judged = conv?.kind === "thread" ? conv.parentId : (conv?.id ?? null);
  if (
    !conv ||
    !judged ||
    !(await createConversationAccess(core).isReadable(tx, task.requesterUserId, judged, {
      kinds: READABLE_KINDS,
    }))
  ) {
    return { delivered: false, reason: "access_lost" };
  }
  const agent = await findAgent(tx, task.agentId);
  if (!agent || agent.status === "disabled" || conv.archivedAt) {
    return { delivered: false, reason: "bot_unavailable" };
  }
  const [membership] = await tx
    .select({ id: conversationMembers.memberId })
    .from(conversationMembers)
    .where(
      and(
        inArray(conversationMembers.conversationId, [conv.id, ...(conv.parentId ? [conv.parentId] : [])]),
        eq(conversationMembers.memberKind, "agent"),
        eq(conversationMembers.memberId, agent.id),
      ),
    )
    .limit(1);
  if (!membership) return { delivered: false, reason: "bot_unavailable" };
  const [card] = task.cardMessageId
    ? await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.id, task.cardMessageId), isNull(messages.deletedAt)))
        .limit(1)
    : [];
  if (!card) return { delivered: false, reason: "access_lost" };

  const direct = DIRECT_KINDS.has(conv.kind);
  const organizationId = task.organizationId;
  const mention: AgentMention = {
    organizationId,
    conversationId: conv.id,
    // PD-11: a direct conversation is flat (the event names the card itself); elsewhere the task's thread.
    threadRootId: direct ? card.id : (task.threadRootId ?? card.id),
    messageId: card.id,
    agentIds: [agent.id],
    author: { kind: "user", id: task.requesterUserId, displayName: "" },
    // P4: a fixed server sentence; the bot's notes travel in `turn.task` only.
    body: taskContinueSentence(reason, task.turnsUsed, task.maxTurns),
    createdAt: new Date().toISOString(),
    delivery: direct ? "dm" : "thread",
    trigger: "task",
    task: taskFacts,
    taintedAtStart: plan.tainted,
    // The wait's own id: delivered at most once whatever retries or runs concurrently.
    eventId,
  };
  let limited = false;
  const events = await buildMentionEvents(tx, mention, {
    core,
    perms: deps.perms,
    modelLabel: deps.modelLabel,
    memory: deps.memory,
    // PD-09: at the daily limit no generic notice; the task stops with its own message (release).
    onLimitReached: () => {
      limited = true;
    },
  });
  const [ev] = events;
  if (!ev) return { delivered: false, reason: limited ? "daily_limit" : "bot_unavailable" };
  // PD-15 (the wake's rule, D-20): a turn of this task already read a Work Zone session's output, which is now in the
  // thread's OpenClaw context, so the continuation starts with the mark (set before the append, like the taint).
  const [readHere] = await tx
    .select({ id: agentToolCalls.id })
    .from(agentToolCalls)
    .innerJoin(agentTurns, eq(agentTurns.eventId, agentToolCalls.eventId))
    .where(
      and(
        eq(agentToolCalls.agentId, agent.id),
        eq(agentToolCalls.tool, BUILTIN_TOOLS.workSessionRead),
        eq(agentToolCalls.decision, "allowed"),
        eq(agentTurns.taskId, task.id),
      ),
    )
    .limit(1);
  if (readHere) {
    await tx.update(agentTurns).set({ sessionOutputRead: true }).where(eq(agentTurns.eventId, ev.eventId));
  }

  const payload: Omit<AgentTaskEvent, "seq"> = {
    ...ev,
    type: AgentChannelEventTypes.task,
    task: taskFacts,
  };
  await core.realtime.appendEvent(tx, cellTopic(organizationId), AgentChannelEventTypes.task, payload, {
    actorUserId: task.requesterUserId,
  });
  // Ids, counts and the reason only (P1).
  await auditTask(tx, core, "bot.task_continued", task, {
    eventId: ev.eventId,
    turnsUsed: task.turnsUsed,
    maxTurns: task.maxTurns,
    reason,
    ...(plan.process ? { processId: plan.process.processId } : {}),
  });
  return { delivered: true };
}

/** Whether `row` still holds `plan`'s reservation (tx1's `consumeWait`), nothing having moved it since. */
function holdsReservation(row: BotTaskRow | null, plan: ContinuePlan): boolean {
  return (
    row !== null &&
    row.status === "running" &&
    row.currentEventId === plan.eventId &&
    row.waitSeq === plan.previous.waitSeq + 1
  );
}

/**
 * Code review CR-01 (tx3, user-less): a reservation a stop overtook. The task ended while it held this undelivered
 * turn, so the turn it counted is given back (`turns_used` as before tx1; the card shows no turn count, its link reads
 * the row). A task that moved on otherwise is left as it is.
 */
async function forgetReservation(tx: Tx, plan: ContinuePlan): Promise<void> {
  await tx
    .update(botTasks)
    .set({ turnsUsed: plan.previous.turnsUsed })
    .where(
      and(
        eq(botTasks.organizationId, orgOf(tx)),
        eq(botTasks.id, plan.task.id),
        inArray(botTasks.status, ["done", "failed", "stopped"]),
        eq(botTasks.currentEventId, plan.eventId),
        eq(botTasks.turnsUsed, plan.previous.turnsUsed + 1),
      ),
    );
}

/**
 * release (tx3, user-less): gives the reserved wait back, only while the row still holds what tx1 wrote (`running` on
 * this turn's id), so the next run decides again. Returns the restored row, or null when something else moved it. The
 * card is not touched: the reservation never changed it (code review WR-03).
 */
async function release(tx: Tx, plan: ContinuePlan): Promise<BotTaskRow | null> {
  const p = plan.previous;
  const [row] = await tx
    .update(botTasks)
    .set({
      status: "waiting",
      turnsUsed: p.turnsUsed,
      currentEventId: p.currentEventId,
      waitSeq: p.waitSeq,
      waitKind: p.waitKind,
      waitRef: p.waitRef,
      wakeAt: p.wakeAt,
      updatedAt: p.updatedAt,
    })
    .where(
      and(
        eq(botTasks.organizationId, orgOf(tx)),
        eq(botTasks.id, plan.task.id),
        eq(botTasks.status, "running"),
        eq(botTasks.currentEventId, plan.eventId),
        eq(botTasks.waitSeq, p.waitSeq + 1),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Code review WR-03: the card follows a delivered continuation ("Working"), from the row as it is now under its lock
 * (the delivered turn may already have continued). A failure is logged with ids only: the next change refreshes it.
 */
async function cardAfterDelivery(core: Core, plan: ContinuePlan): Promise<void> {
  try {
    await core.db.withTenant({ organizationId: plan.task.organizationId, userId: null }, async (tx) => {
      const row = await lockTask(tx, plan.task.id);
      if (row) await refreshTaskCard(tx, core, row);
    });
  } catch (err) {
    core.log.warn(
      { taskId: plan.task.id, organizationId: plan.task.organizationId, err: { name: (err as Error)?.name } },
      "bot task card not refreshed after its continuation",
    );
  }
}

/**
 * One `bot_task.continue` job (module doc): decide, deliver as the requester, release when nothing was delivered. A
 * failure of the delivery gives the reservation back and throws, so pg-boss retries the job (`runTaskContinuation`).
 */
export async function continueBotTask(
  core: Core,
  deps: TaskWakesDeps,
  data: JobData<"bot_task.continue">,
  /** Test seam only (code review CR-01): runs after tx1 committed the reservation, before tx2 delivers it. */
  hooks: { afterReserve?: () => Promise<void> } = {},
): Promise<TaskContinueOutcome> {
  const { organizationId, taskId } = data;
  const decision = await core.db.withTenant({ organizationId, userId: null }, (tx) =>
    decide(tx, core, taskId),
  );
  if (decision.kind !== "deliver") return decision.kind;
  const { plan } = decision;
  await hooks.afterReserve?.();
  let out: DeliverResult;
  try {
    out = await core.db.withTenant({ organizationId, userId: plan.task.requesterUserId }, (tx) =>
      deliver(tx, core, deps, plan),
    );
  } catch (err) {
    await core.db.withTenant({ organizationId, userId: null }, (tx) => release(tx, plan));
    throw err;
  }
  if (out.delivered) {
    await cardAfterDelivery(core, plan);
    return "delivered";
  }
  const reason = out.reason;
  if (reason === "superseded") {
    // The stop already wrote its card, audit and message: nothing is released and nothing is stopped again.
    await core.db.withTenant({ organizationId, userId: null }, (tx) => forgetReservation(tx, plan));
    return "stopped";
  }
  return core.db.withTenant({ organizationId, userId: null }, async (tx): Promise<TaskContinueOutcome> => {
    // The turn that was not delivered is not counted: the wait is given back first, then the task stops.
    await release(tx, plan);
    const task = await lockTask(tx, plan.task.id);
    if (!task || !isActiveTask(task)) return "none";
    // PD-09 (Pitfall 5): the daily limit is not a transient skip (the task would retry every minute until midnight):
    // the task stops with its one message; the generic limit notice was skipped (`onLimitReached`). D-07, E10, E26:
    // the requester lost access, the bot or the card is gone: the card's notice says why and no message is posted
    // (nobody may be posted for, or nothing is left to post with).
    await stopTask(tx, core, task, reason, { notify: reason === "daily_limit" });
    return "stopped";
  });
}

/**
 * D-12: the task's current turn ended without `ocw_task_continue` or `ocw_task_finish` (its done, or the tick for a turn
 * lost for 30 minutes), on `task` locked by the caller and `running`. The first time the task gets one nudge turn
 * (`waiting`, kind `nudge`, about 5 s, `nudged`); the second time in a row (no continue in between resets `nudged`) it
 * stops `no_progress` (failed, "Blocked") with one message mentioning the requester.
 */
async function nudgeOrStop(tx: Tx, core: Core, task: BotTaskRow): Promise<"nudged" | "stopped"> {
  if (task.nudged) {
    await stopTask(tx, core, task, "no_progress");
    return "stopped";
  }
  const [row] = await tx
    .update(botTasks)
    .set({
      status: "waiting",
      waitKind: "nudge",
      waitRef: null,
      wakeAt: sql`least(now() + make_interval(secs => ${BOT_TASK_LIMITS.minGapSeconds}), ${botTasks.deadlineAt})`,
      waitSeq: sql`${botTasks.waitSeq} + 1`,
      nudged: true,
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(botTasks.organizationId, orgOf(tx)), eq(botTasks.id, task.id), eq(botTasks.status, "running")),
    )
    .returning();
  if (!row) return "nudged";
  await refreshTaskCard(tx, core, row);
  await core.jobs.sendInTx(
    tx,
    "bot_task.continue",
    { organizationId: row.organizationId, taskId: row.id },
    { startAfter: new Date(Date.now() + GAP_MS) },
  );
  return "nudged";
}

/** The minimum gap before a released wait is delivered (PD-28). */
const GAP_MS = BOT_TASK_LIMITS.minGapSeconds * 1_000;

/**
 * The cell's turn-done signal for a task's turn (PD-06), called by `POST /turns/:eventId/done` after it bound the event
 * to this cell's bot and before the chain branch. User-less: the turn of this bot with a `task_id`; `done_at` on the
 * first report; a waiting task's "after this turn" (and nudge) wait is shortened to about 5 s and one
 * `bot_task.continue` job is queued at `greatest(wake_at, now + 5 s)`. Anything else (another organization's event, a
 * turn outside any task, an ended task) changes nothing. Idempotent: every write is conditional and extra jobs are
 * harmless.
 */
export async function taskTurnDone(
  core: Core,
  p: { organizationId: string; eventId: string; agentId: string; outcome: "replied" | "failed" },
): Promise<void> {
  await core.db.withTenant({ organizationId: p.organizationId, userId: null }, async (tx) => {
    const [turn] = await tx
      .select({ eventId: agentTurns.eventId, taskId: agentTurns.taskId })
      .from(agentTurns)
      .where(
        and(
          eq(agentTurns.organizationId, orgOf(tx)),
          eq(agentTurns.eventId, p.eventId),
          eq(agentTurns.agentId, p.agentId),
          isNotNull(agentTurns.taskId),
        ),
      )
      .limit(1);
    if (!turn?.taskId) return;
    await tx
      .update(agentTurns)
      .set({ doneAt: sql`now()` })
      .where(
        and(
          eq(agentTurns.organizationId, orgOf(tx)),
          eq(agentTurns.eventId, turn.eventId),
          isNull(agentTurns.doneAt),
        ),
      );
    const task = await lockTask(tx, turn.taskId);
    if (!task || !isActiveTask(task)) return;
    if (task.status === "waiting") {
      let wakeAt = task.wakeAt;
      if (task.waitKind === "turn" || task.waitKind === "nudge") {
        const [row] = await tx
          .update(botTasks)
          .set({
            wakeAt: sql`least(${botTasks.wakeAt}, now() + make_interval(secs => ${BOT_TASK_LIMITS.minGapSeconds}))`,
          })
          .where(and(eq(botTasks.organizationId, orgOf(tx)), eq(botTasks.id, task.id)))
          .returning({ wakeAt: botTasks.wakeAt });
        wakeAt = row?.wakeAt ?? wakeAt;
      }
      const at = Math.max(wakeAt ? new Date(wakeAt).getTime() : 0, Date.now() + GAP_MS);
      await core.jobs.sendInTx(
        tx,
        "bot_task.continue",
        { organizationId: task.organizationId, taskId: task.id },
        { startAfter: new Date(at) },
      );
      return;
    }
    // D-12: the task's own current turn ended and left it running (no continue, no finish).
    if (task.currentEventId === turn.eventId) await nudgeOrStop(tx, core, task);
  });
}

/** What one tick did (counts only, for the log and tests). */
export interface TaskTickResult {
  queued: number;
  nudged: number;
  stopped: number;
}

/**
 * One task of the tick, in its organization's own user-less transaction, re-read by id under its row lock (the listing
 * is never trusted): the bot disabled or archived → `bot_unavailable` without a message (the card says so); past its
 * deadline → `budget_time` with one message; a waiting task whose wait has come (its job was lost) → one
 * `bot_task.continue` job now; a running task whose current turn ended or was lost for 30 minutes → D-12.
 */
async function tickTask(tx: Tx, core: Core, taskId: string): Promise<keyof TaskTickResult | null> {
  const task = await lockTask(tx, taskId);
  if (!task || !isActiveTask(task)) return null;
  const agent = await findAgent(tx, task.agentId);
  if (!agent || agent.status === "disabled") {
    await stopTask(tx, core, task, "bot_unavailable", { notify: false });
    return "stopped";
  }
  const clock = await clockOf(tx, task);
  if (clock.pastDeadline) {
    await stopTask(tx, core, task, "budget_time");
    return "stopped";
  }
  if (task.status === "waiting") {
    if (!clock.due) return null;
    await core.jobs.sendInTx(tx, "bot_task.continue", {
      organizationId: task.organizationId,
      taskId: task.id,
    });
    return "queued";
  }
  if (!clock.currentDone) return null;
  return nudgeOrStop(tx, core, task);
}

/**
 * The minute tick (PD-06, Pitfall 7): the ids-only `app.due_bot_tasks` lists, across organizations, waiting tasks due
 * for a minute, running tasks untouched for 30 minutes, tasks past their deadline and tasks of disabled or archived
 * bots (at most `tickBatch`); each is decided in its own organization's transaction (`tickTask`). One task's failure
 * is logged with ids and never stops the others.
 */
export async function tickBotTasks(
  core: Core,
  _deps: TaskWakesDeps,
  now: Date = new Date(),
): Promise<TaskTickResult> {
  const due = await core.db.pool.query<{ id: string; organization_id: string }>(
    "select id, organization_id from app.due_bot_tasks($1, $2)",
    [BOT_TASK_LIMITS.tickBatch, now.toISOString()],
  );
  const out: TaskTickResult = { queued: 0, nudged: 0, stopped: 0 };
  for (const row of due.rows) {
    try {
      const done = await core.db.withTenant({ organizationId: row.organization_id, userId: null }, (tx) =>
        tickTask(tx, core, row.id),
      );
      if (done) out[done]++;
    } catch (err) {
      core.log.error(
        { taskId: row.id, organizationId: row.organization_id, err: { name: (err as Error)?.name } },
        "bot task tick failed",
      );
    }
  }
  return out;
}

/**
 * Wires the workers once (from the module factory, before `core.jobs` starts): the continuation, and the one-minute UTC
 * `bot_task.tick` (evaluated once across replicas, an empty payload). Workers run only with `OCW_JOBS_WORKER=on`;
 * tests drive `core.jobs.drain("bot_task.continue")` and `tickBotTasks`. Logs carry ids, counts and error names only.
 */
export function registerTaskWakes(core: Core, deps: TaskWakesDeps): void {
  core.jobs.schedule("bot_task.tick", "* * * * *");
  core.jobs.work("bot_task.tick", async () => {
    const out = await tickBotTasks(core, deps);
    if (out.queued + out.nudged + out.stopped > 0) core.log.info({ ...out }, "bot task tick");
  });
  core.jobs.work("bot_task.continue", (data, ctx) => runTaskContinuation(core, deps, data, ctx));
}

/**
 * One attempt of a `bot_task.continue` job (the worker's body). A failure throws, so pg-boss retries it with backoff
 * (`QUEUE_RETRY` in jobs.ts); code review WR-03: on the job's last attempt a delivery error that persists stops the
 * task instead (`failed`, outcome `error`, the card's notice, one message to the requester), so it is never retried
 * every minute until its deadline. Logs carry ids and error names only.
 */
export async function runTaskContinuation(
  core: Core,
  deps: TaskWakesDeps,
  data: JobData<"bot_task.continue">,
  ctx: Pick<JobContext, "retryCount" | "retryLimit">,
): Promise<void> {
  try {
    await continueBotTask(core, deps, data);
  } catch (err) {
    const last = lastAttempt(ctx);
    core.log.warn(
      {
        taskId: data.taskId,
        organizationId: data.organizationId,
        attempt: ctx.retryCount,
        last,
        err: { name: (err as Error)?.name, code: (err as { code?: unknown })?.code },
      },
      "bot task continuation failed",
    );
    if (!last) throw err;
    const stopped = await core.db.withTenant(
      { organizationId: data.organizationId, userId: null },
      async (tx) => {
        const task = await lockTask(tx, data.taskId);
        if (!task || !isActiveTask(task)) return false;
        return (await stopTask(tx, core, task, "error")) !== null;
      },
    );
    if (!stopped) throw err;
  }
}
