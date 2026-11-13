import {
  BOT_TASK_ACTIVE,
  type BotTaskOutcome,
  type BotTaskRefusal,
  type BotTaskWaitKind,
} from "@ocw/contracts";
import { agents, agentTurns, botTasks, messageCardFollows, messages, type Tx, tenantOf } from "@ocw/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { loadTaskPolicy } from "../bot-capabilities";
import type { AgentTurnRow } from "./claim";
import { postTaskCard } from "./task-card";
import { taskThreadKey } from "./task-offer";

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
