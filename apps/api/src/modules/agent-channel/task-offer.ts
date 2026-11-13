import { BOT_TASK_ACTIVE, BOT_TASK_LIMITS, type TaskProcessFact, type TurnTask } from "@ocw/contracts";
import { botTaskProcesses, botTasks, type Tx, tenantOf } from "@ocw/db";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { AgentMention } from "../../lib/chat-agent-bridge";
import type { TurnTaskOffer } from "../bot-capabilities";

/**
 * Phase 07.17.1.1.2 (D-02, D-09, D-10; PD-05, PD-07, PD-13; ADR-0042): decides which task tools and which task facts one
 * delivered turn of a bot gets. Computed by the caller per bot, like `workZoneOfferFor` (bot-capabilities never imports
 * agent-channel), then gated by `computeTurn`'s `longTasks` inside `turnPolicy`; the task routes re-decide every call
 * (the stored turn, its tools, its `task_id`, the row under lock). Reads only rows of the turn's organization, through
 * the caller's tenant transaction (RLS).
 *
 * - An AI chat: nothing (D-10).
 * - The bot's active task in this thread (a direct conversation is one thread): `control` when the turn's event is the
 *   task's `current_event_id` (a continuation, or a Work Zone wake that consumed the task's wait) or when the asker is
 *   the requester and the task waits; `view` for every other turn there (another member, or the requester's own message
 *   while another turn of the task runs: one execution authority).
 * - No active task: `start` on a person's turn (`mention`, `reply_mode`) and on the bot's Work Zone wakes and opened
 *   items (`work_session`, `automation_item`); never on automation run turns or consult hops (A4).
 */

/** The turn's task offer, plus the ended processes it lists (marked reported only once the turn is delivered). */
export type TaskOffer = TurnTaskOffer & {
  /** `bot_task_processes.id` of the processes listed in `task.finishedProcesses` (control turns only). */
  reportedProcessIds: string[];
};

type Trigger = NonNullable<AgentMention["trigger"]>;

/** Triggers on which a turn may start a task (A4). */
const START_TRIGGERS: ReadonlySet<Trigger> = new Set<Trigger>([
  "mention",
  "reply_mode",
  "work_session",
  "automation_item",
]);

/** The thread a task lives in: none in a direct conversation (`dm`, `group`), else the thread's root message. */
export function taskThreadKey(conversationKind: string, threadRootId: string | null): string | null {
  return conversationKind === "dm" || conversationKind === "group" ? null : threadRootId;
}

type TaskRow = typeof botTasks.$inferSelect;

const iso = (v: string) => new Date(v).toISOString();

/**
 * The `TurnTask` a turn carries for `row`: the task's goal, notes, budget, times and what it waits for; on the task's
 * own (control) turns also the background processes that ended since its last turn (`listProcesses`).
 */
export async function turnTaskOf(
  tx: Tx,
  row: TaskRow,
  opts: { listProcesses: boolean },
): Promise<{ task: TurnTask; reportedProcessIds: string[] }> {
  const finishedProcesses: TaskProcessFact[] = [];
  const reportedProcessIds: string[] = [];
  if (opts.listProcesses) {
    // PD-13: the ended processes no turn of the task heard about yet, oldest first, at most 10 per turn.
    const ended = await tx
      .select({
        id: botTaskProcesses.id,
        processId: botTaskProcesses.processId,
        status: botTaskProcesses.status,
        exitCode: botTaskProcesses.exitCode,
        durationMs: botTaskProcesses.durationMs,
      })
      .from(botTaskProcesses)
      .where(
        and(
          eq(botTaskProcesses.organizationId, row.organizationId),
          eq(botTaskProcesses.taskId, row.id),
          ne(botTaskProcesses.status, "running"),
          isNull(botTaskProcesses.reportedAt),
        ),
      )
      .orderBy(sql`${botTaskProcesses.endedAt} asc nulls last`, asc(botTaskProcesses.id))
      .limit(BOT_TASK_LIMITS.finishedProcessesMax);
    for (const p of ended) {
      if (p.status === "running") continue;
      finishedProcesses.push({
        processId: p.processId,
        status: p.status,
        exitCode: p.exitCode,
        durationMs: p.durationMs,
      });
      reportedProcessIds.push(p.id);
    }
  }
  const task: TurnTask = {
    taskId: row.id,
    status: row.status === "waiting" ? "waiting" : "running",
    goal: row.goal,
    progress: row.progress,
    nextStep: row.nextStep,
    turnsUsed: row.turnsUsed,
    maxTurns: row.maxTurns,
    startedAt: iso(row.startedAt),
    deadlineAt: iso(row.deadlineAt),
    requesterId: row.requesterUserId,
    waiting:
      row.status === "waiting" && row.waitKind
        ? { kind: row.waitKind, ref: row.waitRef, until: row.wakeAt ? iso(row.wakeAt) : null }
        : null,
    finishedProcesses,
  };
  return { task, reportedProcessIds };
}

/**
 * PD-13: marks the processes a delivered control turn listed as reported (`reported_at`), in the delivery transaction,
 * so each ended process reaches exactly one turn of its task. Called only once the turn carries `turn.task` (delivered,
 * long tasks on); a turn that was not delivered leaves them for the next one.
 */
export async function markProcessesReported(tx: Tx, processRowIds: readonly string[]): Promise<void> {
  if (processRowIds.length === 0) return;
  await tx
    .update(botTaskProcesses)
    .set({ reportedAt: sql`now()` })
    .where(
      and(
        eq(botTaskProcesses.organizationId, tenantOf(tx).organizationId),
        inArray(botTaskProcesses.id, [...processRowIds]),
        isNull(botTaskProcesses.reportedAt),
      ),
    );
}

/**
 * The task offer of one turn of `agentId` (PD-07). `threadRootId` is the delivery's thread root (the message itself at a
 * channel's root, ignored in a direct conversation); `eventId` the turn's event id; `mentionTaskId` the task a
 * `trigger: "task"` delivery continues (it alone may take control through the event id), or the task a `work_session`
 * wake's session belongs to (07.17.1.1.2-12).
 */
export async function taskOfferFor(
  tx: Tx,
  p: {
    agentId: string;
    conversationId: string;
    conversationKind: string;
    threadRootId: string | null;
    askerUserId: string;
    trigger: Trigger;
    eventId: string;
    mentionTaskId?: string | null;
  },
): Promise<TaskOffer | null> {
  if (p.conversationKind === "ai_chat") return null;
  const key = taskThreadKey(p.conversationKind, p.threadRootId);
  const [row] = await tx
    .select()
    .from(botTasks)
    .where(
      and(
        eq(botTasks.organizationId, tenantOf(tx).organizationId),
        eq(botTasks.agentId, p.agentId),
        eq(botTasks.conversationId, p.conversationId),
        key === null ? isNull(botTasks.threadRootId) : eq(botTasks.threadRootId, key),
        inArray(botTasks.status, [...BOT_TASK_ACTIVE]),
      ),
    )
    .limit(1);
  const wake = p.trigger === "work_session";
  if (row) {
    const current =
      row.currentEventId === p.eventId && (p.mentionTaskId == null || p.mentionTaskId === row.id);
    // 07.17.1.1.2-12 (PD-14): a Work Zone wake controls the task only as its own turn (the wake consumed the wait, so
    // its event is the current turn); otherwise it only sees the task, so an uncounted wake never drives it.
    const control = current || (!wake && row.requesterUserId === p.askerUserId && row.status === "waiting");
    const { task, reportedProcessIds } = await turnTaskOf(tx, row, { listProcesses: control });
    return { offer: control ? "control" : "view", task, taskId: row.id, reportedProcessIds };
  }
  // 07.17.1.1.2-12 (D-04, PD-14): the wake of a session a task started never starts another task once that one ended
  // (a budget it ran out of stays spent).
  if (wake && p.mentionTaskId) return null;
  return START_TRIGGERS.has(p.trigger)
    ? { offer: "start", task: null, taskId: null, reportedProcessIds: [] }
    : null;
}
