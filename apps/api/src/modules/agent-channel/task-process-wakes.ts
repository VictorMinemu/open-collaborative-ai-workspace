import { BOT_TASK_LIMITS, type SandboxdEvent, type TaskProcessFact } from "@ocw/contracts";
import { botTaskProcesses, botTasks, type Tx, tenantOf } from "@ocw/db";
import { and, eq, sql } from "drizzle-orm";
import type { Core } from "../../core";
import type { AgentTurnRow } from "./claim";
import { type BotTaskRow, lockTask } from "./tasks";

/**
 * Phase 07.17.1.1.2 (D-03, PD-13; ADR-0042): a background sandbox command wakes the task that waits on it. sandboxd
 * never calls the API (P7): it emits one `process` event when a command it answered `running` for ends, and the API's
 * events consumer, which long-polls the feed, calls `onProcessEvent` inside the event's organization transaction after
 * its durable cursor check (exactly once per (boot, seq)).
 *
 * - `linkTaskProcess`: a task turn's `ocw_sandbox_exec` that answered `running` records the command on its task
 *   (`bot_task_processes`: the task, the bot, the process id, the turn's event, `running`, deadline = now + the run's
 *   timeout + 60 s). A turn without a task records nothing (P5).
 * - `onProcessEvent`: the bot's own `running` row by (organization, bot, process id) gets its end; a task waiting on
 *   exactly that process is due now and gets one ids-only `bot_task.continue` job. A process that ends while its task
 *   waits on something else is only recorded: the next task turn lists it once (`finishedProcesses`).
 * - `processWakeOf`: what the continuation of a `process` wait says (the ended command's facts, or `lost` when the row
 *   is still `running` past its deadline: sandboxd restarted with a new boot id, or the shell was killed).
 *
 * Rows and events carry ids and numbers only, never argv, a path or output (P1).
 */

const orgOf = (tx: Tx) => tenantOf(tx).organizationId;
/** `duration_ms` is an `integer` column; a command never runs that long (the exec timeout is at most an hour). */
const MAX_DURATION_MS = 2_147_483_647;

/**
 * A task turn's background command (`/sandbox/exec` answered `running`): one row on the turn's task, in the outcome
 * transaction of the call. `timeoutSeconds` is the run's effective timeout. Returns whether a row was written.
 */
export async function linkTaskProcess(
  tx: Tx,
  p: {
    turn: Pick<AgentTurnRow, "eventId" | "agentId" | "taskId">;
    processId: string;
    timeoutSeconds: number;
  },
): Promise<boolean> {
  if (!p.turn.taskId) return false;
  const seconds = p.timeoutSeconds + BOT_TASK_LIMITS.processGraceSeconds;
  const rows = await tx
    .insert(botTaskProcesses)
    .values({
      organizationId: orgOf(tx),
      taskId: p.turn.taskId,
      agentId: p.turn.agentId,
      processId: p.processId,
      eventId: p.turn.eventId,
      deadlineAt: sql`now() + make_interval(secs => ${seconds})`,
    })
    .onConflictDoNothing()
    .returning({ id: botTaskProcesses.id });
  return rows.length > 0;
}

type ProcessEvent = Extract<SandboxdEvent, { type: "process" }>;

/**
 * sandboxd's `process` event (the consumer's handler, in the event's organization transaction, user-less): records the
 * end on the bot's own `running` row and wakes the task waiting on that very process (T-07.17.1.1.2-11-01). Another
 * organization's event finds nothing here (RLS and an explicit filter, E22); a replay finds the row already ended.
 */
export async function onProcessEvent(tx: Tx, core: Core, event: ProcessEvent): Promise<void> {
  const [row] = await tx
    .update(botTaskProcesses)
    .set({
      status: event.status,
      exitCode: event.exitCode,
      durationMs: Math.min(event.durationMs, MAX_DURATION_MS),
      endedAt: sql`now()`,
    })
    .where(
      and(
        eq(botTaskProcesses.organizationId, orgOf(tx)),
        eq(botTaskProcesses.agentId, event.target.agentId),
        eq(botTaskProcesses.processId, event.processId),
        eq(botTaskProcesses.status, "running"),
      ),
    )
    .returning({ taskId: botTaskProcesses.taskId });
  if (!row) return;
  const task = await lockTask(tx, row.taskId);
  if (task?.status !== "waiting" || task.waitKind !== "process" || task.waitRef !== event.processId) return;
  const [woken] = await tx
    .update(botTasks)
    .set({ wakeAt: sql`now()` })
    .where(
      and(
        eq(botTasks.organizationId, orgOf(tx)),
        eq(botTasks.id, task.id),
        eq(botTasks.status, "waiting"),
        eq(botTasks.waitSeq, task.waitSeq),
      ),
    )
    .returning({ id: botTasks.id });
  if (!woken) return;
  await core.jobs.sendInTx(tx, "bot_task.continue", { organizationId: task.organizationId, taskId: task.id });
}

/**
 * What a due `process` wait of `task` (locked by the caller) is delivered with (09's decide, user-less): the ended
 * command's facts with reason `process`; a row still `running` past its deadline becomes `lost` (E20); a row still
 * running before it (the bot also asked for `afterSeconds`) is a plain timer, with no facts. The facts are marked
 * reported, so the command is not listed again in `finishedProcesses`.
 */
export async function processWakeOf(
  tx: Tx,
  task: Pick<BotTaskRow, "id" | "agentId" | "waitRef">,
): Promise<{ reason: "process" | "timer"; process: TaskProcessFact | null }> {
  if (!task.waitRef) return { reason: "timer", process: null };
  const where = and(
    eq(botTaskProcesses.organizationId, orgOf(tx)),
    eq(botTaskProcesses.taskId, task.id),
    eq(botTaskProcesses.agentId, task.agentId),
    eq(botTaskProcesses.processId, task.waitRef),
  );
  // A command sandboxd never reported by its deadline is taken as lost (its boot ended, or its shell was killed).
  await tx
    .update(botTaskProcesses)
    .set({ status: "lost", endedAt: sql`now()` })
    .where(and(where, eq(botTaskProcesses.status, "running"), sql`${botTaskProcesses.deadlineAt} <= now()`));
  const [row] = await tx
    .update(botTaskProcesses)
    .set({ reportedAt: sql`coalesce(${botTaskProcesses.reportedAt}, now())` })
    .where(and(where, sql`${botTaskProcesses.status} <> 'running'`))
    .returning({
      processId: botTaskProcesses.processId,
      status: botTaskProcesses.status,
      exitCode: botTaskProcesses.exitCode,
      durationMs: botTaskProcesses.durationMs,
    });
  if (!row || row.status === "running") return { reason: "timer", process: null };
  return {
    reason: "process",
    process: {
      processId: row.processId,
      status: row.status,
      exitCode: row.exitCode,
      durationMs: row.durationMs,
    },
  };
}
