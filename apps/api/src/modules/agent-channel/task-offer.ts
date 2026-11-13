import { BOT_TASK_ACTIVE, type TaskProcessFact, type TurnTask } from "@ocw/contracts";
import { botTasks, type Tx, tenantOf } from "@ocw/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
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
  _tx: Tx,
  row: TaskRow,
  _opts: { listProcesses: boolean },
): Promise<{ task: TurnTask; reportedProcessIds: string[] }> {
  const finishedProcesses: TaskProcessFact[] = [];
  const reportedProcessIds: string[] = [];
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
 * The task offer of one turn of `agentId` (PD-07). `threadRootId` is the delivery's thread root (the message itself at a
 * channel's root, ignored in a direct conversation); `eventId` the turn's event id; `mentionTaskId` the task a
 * `trigger: "task"` delivery continues (it alone may take control through the event id).
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
  if (row) {
    const current =
      row.currentEventId === p.eventId && (p.mentionTaskId == null || p.mentionTaskId === row.id);
    const control = current || (row.requesterUserId === p.askerUserId && row.status === "waiting");
    const { task, reportedProcessIds } = await turnTaskOf(tx, row, { listProcesses: control });
    return { offer: control ? "control" : "view", task, taskId: row.id, reportedProcessIds };
  }
  return START_TRIGGERS.has(p.trigger)
    ? { offer: "start", task: null, taskId: null, reportedProcessIds: [] }
    : null;
}
