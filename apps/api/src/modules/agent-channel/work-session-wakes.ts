import { createHash } from "node:crypto";
import {
  type AgentCardNotice,
  AgentChannelEventTypes,
  type AgentWorkSessionEvent,
  BOT_WORK_ZONE_LIMITS,
  BUILTIN_TOOLS,
  cellTopic,
  type ModelRef,
  redactSecrets,
  WORK_SESSION_CARD_LABELS,
  WorkSessionChanges,
  type WorkSessionDecider,
  type WorkSessionStatus,
  type WorkSessionTransition,
} from "@ocw/contracts";
import {
  agents,
  agentToolCalls,
  agentTurns,
  botTasks,
  botWorkSessions,
  botWorkZoneProfiles,
  conversationMembers,
  conversations,
  messageCards,
  orgMembers,
  streamEvents,
  type Tx,
  workApprovals,
  workPrompts,
  workSessions,
} from "@ocw/db";
import { and, asc, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Core } from "../../core";
import type { AgentMention } from "../../lib/chat-agent-bridge";
import type { JobData } from "../../lib/jobs";
import { findAgent } from "../agent";
import { loadTaskPolicy } from "../bot-capabilities";
import { createConversationAccess } from "../chat";
import type { MemoryService } from "../memory";
import type { PermissionService } from "../organization";
import { composeWorkSessionCard, sessionDeciders, wsTopic } from "../work-session";
import { requeueAfterSession } from "./automation-items";
import { updatePlatformCardNotified } from "./card-followers";
import { buildMentionEvents } from "./mentions";
import { refreshTaskCard } from "./task-card";
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
 * Phase 07.16-20 (D-09, D-10, D-12, D-17; PD-12, PD-16, PD-22; ADR-0028): the bot orchestrates its Work Zone session
 * without polling. `setStatus` flips `bot_work_sessions.wake_pending` on every transition of a bot-started session and
 * enqueues one `work_session.bot_sync` job (ids only, about 3 s later). This handler:
 *
 * 1. tx1, user-less (the session's audience backstop hides it from people outside it, Pitfall 2): locks the bot row,
 *    clears `wake_pending`, reads the session as it is NOW, refreshes the live card when its fields changed (the only
 *    writer of the card after the start, bounded by transitions) and decides the wake (PD-16's table). The pair
 *    (state key, last finished prompt) already woken never wakes again (E8, retries included; the key is the status,
 *    or the newest pending approval while waiting, `wakeStateKey`); the daily budget is reserved here (E7); a
 *    requester who left the organization is skipped here.
 * 2. tx2, as the requester (D-17): they must still read the conversation, the bot must be live and a member; the wake is
 *    a mention of the bot on its card message with `trigger: "work_session"` (unattended, tainted from the start when
 *    the session is, offered the four Work Zone tools when the profile is active), then `agent.work_session.v1` on
 *    `cell:<org>` and `bot.work_session_woken`.
 * 3. tx3, user-less, only when tx2 delivered nothing (or failed): the budget is given back, the card says why when the
 *    person can no longer be posted for, and `bot.work_session_wake_skipped` names the reason. A failure also restores
 *    the woken pair, so the job's retry decides again.
 *
 * Phase 07.17.1.1.2-12 (D-03, D-04, D-07; PD-14): a session a task turn started (`bot_work_sessions.task_id`) belongs to
 * that task. In tx2, after the checks above and before the turn is built, the task row is locked (after the session's
 * row in tx1: the session, then the task), and only when it is this bot's task, in the session's conversation, for the
 * session's requester: a waiting task within its budgets has its wait consumed with the wake's own event id
 * (`consumeWait`), so 07's offer makes the wake the task's own control turn (`turn.task`, continue and finish,
 * `agent_turns.task_id`), tainted when any turn of the task was; past a budget (or with long tasks off) the task stops
 * with its one message and the wake goes out plain; a running task makes the wake a view turn. A delivery given back
 * (no event) restores the consumed wait exactly, in the same transaction; a failure rolls it back with the rest.
 *
 * The summary is composed from structured facts only (transition, repository name, turn number, counts), never runtime
 * text (no branch, no tool name: code review WR-01), so a wake turn does not start as a read of the session's output. No job row, audit row or log line carries a prompt or an output (P1). The bot never approves anything: the
 * wake names who can (P3).
 */

export const WAKE_LIMIT_NOTICE = "Wake-up limit reached for today.";
export const WAKE_CANNOT_POST_NOTICE = "The bot can't post here any more.";
const APPROVAL_SENTENCE = "The bot can't approve it; mention one of the people listed.";

/** Why a decided wake was not delivered (`bot.work_session_wake_skipped`). */
export type WakeSkipReason =
  | "budget"
  | "requester_cannot_read"
  | "agent_unavailable"
  | "daily_limit"
  | "card_missing";

export interface WorkSessionWakesDeps {
  perms: PermissionService;
  modelLabel?: ((ref: ModelRef) => string) | undefined;
  memory?: MemoryService | undefined;
}

const NAME_MAX = 200;
/** Flat conversations: the wake names the card message itself (an AI chat is flat too, as in `emitCardAction`). */
const DIRECT_KINDS = new Set(["dm", "group", "ai_chat"]);
/** The kinds a start may come from (the start route's `READABLE_KINDS`); a thread is judged through its parent. */
const READABLE_KINDS = ["channel", "dm", "group", "ai_chat"] as const;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * One or two plain sentences about a transition, from structured facts only (PD-16): fixed sentences, the repository
 * name and counts. Never a string the runtime chose (code review WR-01): the branch and the tool names of pending
 * approvals are runtime-reported, and the body reads as the person's own words on a turn that starts without
 * `session_output_read`, so the bot learns them only through `ocw_work_session_read` (which sets it, D-20). The result
 * is at most `BOT_WORK_ZONE_LIMITS.summaryChars` characters.
 */
export function wakeSummary(p: {
  transition: WorkSessionTransition;
  projectName: string;
  turn: number;
  queued: number;
  changedFiles: number;
  pendingApprovals: number;
}): string {
  const where = `Work Zone session in ${redactSecrets(p.projectName).slice(0, NAME_MAX) || "the repository"}`;
  const changes = p.changedFiles > 0 ? ` ${plural(p.changedFiles, "file", "files")} changed.` : "";
  let text: string;
  switch (p.transition) {
    case "turn_done":
      text = `${where} finished turn ${p.turn}; ${p.queued > 0 ? `${plural(p.queued, "prompt is", "prompts are")} queued` : "nothing is queued"}.${changes}`;
      break;
    case "waiting_approval":
      text = `${where} is waiting for ${plural(p.pendingApprovals, "approval", "approvals")}. ${APPROVAL_SENTENCE}`;
      break;
    case "failed":
      text = `${where} failed${p.turn > 0 ? ` during turn ${p.turn}` : ""}.${changes}`;
      break;
    case "ended":
      text = `${where} has ended after ${plural(p.turn, "turn", "turns")}.${changes}`;
      break;
    case "offline":
      text = `${where} is paused: its device went offline.`;
      break;
  }
  return text.slice(0, BOT_WORK_ZONE_LIMITS.summaryChars);
}

/**
 * PD-16's table on the state the handler reads now: `idle` with nothing queued and a finished prompt not yet woken for
 * (`turn_done`), `waiting_approval`, `failed`, `completed` and `archived` by a person (`ended`), `host_offline`
 * (`offline`). `running`, `provisioning` (an idle that flipped back in the same dispatch, E6) and the bot's own stop
 * refresh the card only.
 */
export function wakeTransition(p: {
  status: WorkSessionStatus;
  queued: number;
  lastDonePromptId: string | null;
  lastWokenPromptId: string | null;
  stoppedByAgent: boolean;
}): WorkSessionTransition | null {
  switch (p.status) {
    case "idle":
      return p.queued === 0 && p.lastDonePromptId !== null && p.lastDonePromptId !== p.lastWokenPromptId
        ? "turn_done"
        : null;
    case "waiting_approval":
      return "waiting_approval";
    case "failed":
      return "failed";
    case "completed":
      return "ended";
    case "archived":
      return p.stoppedByAgent ? null : "ended";
    case "host_offline":
      return "offline";
    case "provisioning":
    case "running":
      return null;
  }
}

/**
 * What `bot_work_sessions.last_woken_status` records for a woken state: the session status, except while approvals are
 * pending, where it is `waiting_approval:<newest pending approval id>`. A later approval inside the same prompt (approve,
 * running, ask again) is a new state and wakes the bot again so it can name who decides; the same approval never does.
 * Every other transition stays keyed on (status, last finished prompt), PD-16's column pair.
 */
export function wakeStateKey(status: WorkSessionStatus, newestPendingApprovalId: string | null): string {
  return status === "waiting_approval" && newestPendingApprovalId
    ? `waiting_approval:${newestPendingApprovalId}`
    : status;
}

/**
 * The card's notices with `text` added (neutral, once): an outside-content warning stays first (UI-SPEC), then the
 * newest neutral notices, at most three in all (the card contract's bound).
 */
function withNotice(notices: AgentCardNotice[], text: string): AgentCardNotice[] {
  if (notices.some((n) => n.text === text)) return notices;
  const warnings = notices.filter((n) => n.tone === "warning").slice(0, 2);
  const others = [...notices.filter((n) => n.tone !== "warning"), { tone: "neutral" as const, text }];
  return [...warnings, ...others.slice(-(3 - warnings.length))];
}

/** Adds a neutral notice to a platform card (no-op when it is already there or the card is gone). */
async function addCardNotice(tx: Tx, core: Core, messageId: string | null, text: string): Promise<void> {
  if (!messageId) return;
  const [card] = await tx
    .select({ notices: messageCards.notices, platformOwned: messageCards.platformOwned })
    .from(messageCards)
    .where(eq(messageCards.messageId, messageId))
    .limit(1);
  if (!card?.platformOwned) return;
  const before = (card.notices ?? []) as AgentCardNotice[];
  const next = withNotice(before, text);
  if (next === before) return;
  await updatePlatformCardNotified(tx, core, { messageId, notices: next });
}

type BotRow = typeof botWorkSessions.$inferSelect;

interface WakePlan {
  bot: BotRow;
  session: { id: string; status: WorkSessionStatus; deviceId: string; tainted: boolean };
  transition: WorkSessionTransition;
  summary: string;
  pendingApprovals: number;
  deciders: WorkSessionDecider[];
  cardMessageId: string;
  /** The state key this wake is for (`wakeStateKey`), and the wake turn's own id (`wakeEventId`, WR-09). */
  wakeKey: string;
  eventId: string;
  /** What tx1 reserved (`pending:<key>`), so tx3 can confirm it or give it back exactly. */
  reserved: { day: string; used: number; status: string; promptId: string | null };
  previous: { day: string | null; used: number; status: string | null; promptId: string | null };
}

/**
 * Code review WR-09: `last_woken_status` holds `pending:<key>` from the reservation (tx1) until the delivery is
 * confirmed (tx3 writes `<key>`). A retry that finds its own state still pending looks for the wake turn: delivered →
 * confirmed, nothing sent again; not delivered (the worker died in between) → delivered now, on the budget already
 * reserved. A skip writes `<key>` directly.
 */
const PENDING = "pending:";

/**
 * The wake turn's event id, derived from what makes a wake unique (the session, the state key and the last finished
 * prompt), so a retry or a concurrent run can never deliver the same wake twice (`agent_turns.event_id` is the turn's
 * key). A UUID of version 8 (RFC 9562, custom) from SHA-256.
 */
export function wakeEventId(workSessionId: string, wakeKey: string, promptId: string | null): string {
  const h = createHash("sha256")
    .update(`ocw.work_session.wake\u0000${workSessionId}\u0000${wakeKey}\u0000${promptId ?? ""}`)
    .digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x80;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** Whether the wake turn `eventId` exists (it is written in the delivery's transaction, with its cell event). */
async function delivered(tx: Tx, eventId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: agentTurns.eventId })
    .from(agentTurns)
    .where(eq(agentTurns.eventId, eventId))
    .limit(1);
  return row !== undefined;
}

async function auditSkip(
  tx: Tx,
  core: Core,
  bot: BotRow,
  p: { deviceId: string; transition: WorkSessionTransition; reason: WakeSkipReason },
): Promise<void> {
  await core.audit.record(tx, {
    action: "bot.work_session_wake_skipped",
    resourceType: "work_session",
    resourceId: bot.workSessionId,
    result: "denied",
    actorKind: "system",
    agentId: bot.agentId,
    userId: bot.requesterUserId,
    deviceId: p.deviceId,
    sessionId: bot.workSessionId,
    metadata: {
      workSessionId: bot.workSessionId,
      transition: p.transition,
      reason: p.reason,
      sponsorUserId: bot.sponsorUserId,
      requesterUserId: bot.requesterUserId,
    },
  });
}

/** tx1: the card refresh and the wake decision, user-less. Null = nothing to deliver. */
async function decide(
  tx: Tx,
  core: Core,
  deps: WorkSessionWakesDeps,
  workSessionId: string,
): Promise<WakePlan | null> {
  const [bot] = await tx
    .select()
    .from(botWorkSessions)
    .where(eq(botWorkSessions.workSessionId, workSessionId))
    .limit(1)
    .for("update");
  // Another organization's id under this tenant, or a person's session: nothing (T-07.16-20-03).
  if (!bot) return null;
  await tx
    .update(botWorkSessions)
    .set({ wakePending: false })
    .where(eq(botWorkSessions.workSessionId, workSessionId));
  const [s] = await tx.select().from(workSessions).where(eq(workSessions.id, workSessionId)).limit(1);
  if (!s) return null;

  const counts = await tx
    .select({ status: workPrompts.status, n: count() })
    .from(workPrompts)
    .where(eq(workPrompts.workSessionId, s.id))
    .groupBy(workPrompts.status);
  const queued = counts.filter((c) => c.status === "queued").reduce((t, c) => t + Number(c.n), 0);
  const [ran] = await tx
    .select({ n: count() })
    .from(workPrompts)
    .where(and(eq(workPrompts.workSessionId, s.id), isNotNull(workPrompts.dispatchedAt)));
  const turn = Number(ran?.n ?? 0);
  const [lastDone] = await tx
    .select({ id: workPrompts.id })
    .from(workPrompts)
    .where(and(eq(workPrompts.workSessionId, s.id), inArray(workPrompts.status, ["completed", "failed"])))
    .orderBy(desc(workPrompts.position), desc(workPrompts.completedAt))
    .limit(1);
  const approvals = await tx
    .select({ id: workApprovals.id })
    .from(workApprovals)
    .where(and(eq(workApprovals.workSessionId, s.id), eq(workApprovals.status, "pending")))
    .orderBy(asc(workApprovals.createdAt), asc(workApprovals.id));

  // The live card follows the session (PD-12): only when one of its fields (Updated aside) or its pill changed.
  const card = await composeWorkSessionCard(
    tx,
    {
      id: s.id,
      status: s.status,
      runtime: s.runtime,
      model: s.model,
      permissionMode: s.permissionMode,
      projectId: s.projectId,
      deviceId: s.deviceId,
    },
    { turn, pendingApprovals: approvals.length },
  );
  let notices: AgentCardNotice[] | null = null;
  if (bot.cardMessageId) {
    const [current] = await tx
      .select({
        status: messageCards.status,
        statusLabel: messageCards.statusLabel,
        fields: messageCards.fields,
        notices: messageCards.notices,
        platformOwned: messageCards.platformOwned,
      })
      .from(messageCards)
      .where(eq(messageCards.messageId, bot.cardMessageId))
      .limit(1);
    if (current?.platformOwned) {
      notices = (current.notices ?? []) as AgentCardNotice[];
      const shown = (fields: Array<{ label: string; value: string }>) =>
        JSON.stringify(fields.filter((f) => f.label !== WORK_SESSION_CARD_LABELS.updated));
      const changed =
        current.status !== card.status ||
        (current.statusLabel ?? null) !== (card.statusLabel ?? null) ||
        shown(current.fields) !== shown(card.fields);
      if (changed) {
        await updatePlatformCardNotified(tx, core, {
          messageId: bot.cardMessageId,
          status: card.status,
          statusLabel: card.statusLabel ?? null,
          fields: card.fields,
        });
      }
    }
  }

  const lastDonePromptId = lastDone?.id ?? null;
  const transition = wakeTransition({
    status: s.status,
    queued,
    lastDonePromptId,
    // A reservation still pending (WR-09) names a wake that may not have happened: it does not hide a finished turn.
    lastWokenPromptId: bot.lastWokenStatus?.startsWith(PENDING) ? null : bot.lastWokenPromptId,
    stoppedByAgent: bot.stoppedByAgent,
  });
  if (!transition) return null;
  const wakeKey = wakeStateKey(s.status, approvals.at(-1)?.id ?? null);
  const eventId = wakeEventId(s.id, wakeKey, lastDonePromptId);
  const samePrompt = bot.lastWokenPromptId === lastDonePromptId;
  // Idempotent across retries and repeated jobs (E8): the same (state key, last finished prompt) wakes once.
  if (samePrompt && bot.lastWokenStatus === wakeKey) return null;
  // WR-09: this wake was reserved by an attempt whose outcome is unknown. Delivered → confirm it; else deliver it now.
  const recovering = samePrompt && bot.lastWokenStatus === `${PENDING}${wakeKey}`;
  if (recovering && (await delivered(tx, eventId))) {
    await tx
      .update(botWorkSessions)
      .set({ lastWokenStatus: wakeKey })
      .where(eq(botWorkSessions.workSessionId, s.id));
    return null;
  }

  const previous = {
    day: bot.wakesDay,
    used: bot.wakesUsed,
    status: bot.lastWokenStatus,
    promptId: bot.lastWokenPromptId,
  };
  const today = ((await tx.execute(sql`select current_date::text as d`)).rows[0] as { d: string }).d;
  // The day's wakes without this one: a recovered reservation was already counted (once).
  const usedToday = bot.wakesDay === today ? Math.max(0, bot.wakesUsed - (recovering ? 1 : 0)) : 0;
  /** A decided skip: the state is woken for good (`<key>`), the budget as given. */
  const markWoken = (used: number) =>
    tx
      .update(botWorkSessions)
      .set({
        wakesDay: today,
        wakesUsed: used,
        lastWokenStatus: wakeKey,
        lastWokenPromptId: lastDonePromptId,
      })
      .where(eq(botWorkSessions.workSessionId, s.id));

  // The daily budget (PD-22, E7): the profile's, or the default once the profile is gone.
  const [prof] = bot.profileId
    ? await tx
        .select({ wakes: botWorkZoneProfiles.wakesPerSessionDay })
        .from(botWorkZoneProfiles)
        .where(eq(botWorkZoneProfiles.id, bot.profileId))
        .limit(1)
    : [];
  const limit = prof?.wakes ?? BOT_WORK_ZONE_LIMITS.wakesPerSessionDayDefault;
  if (usedToday >= limit) {
    await markWoken(usedToday);
    await addCardNotice(tx, core, bot.cardMessageId, WAKE_LIMIT_NOTICE);
    await auditSkip(tx, core, bot, { deviceId: s.deviceId, transition, reason: "budget" });
    return null;
  }
  // D-17: the wake runs as the person who asked; one who left the organization is never posted for.
  const [requester] = await tx
    .select({ deactivatedAt: orgMembers.deactivatedAt })
    .from(orgMembers)
    .where(eq(orgMembers.userId, bot.requesterUserId))
    .limit(1);
  if (!requester || requester.deactivatedAt) {
    await markWoken(usedToday);
    await addCardNotice(tx, core, bot.cardMessageId, WAKE_CANNOT_POST_NOTICE);
    await auditSkip(tx, core, bot, { deviceId: s.deviceId, transition, reason: "requester_cannot_read" });
    return null;
  }
  if (!bot.cardMessageId) {
    await markWoken(usedToday);
    await auditSkip(tx, core, bot, { deviceId: s.deviceId, transition, reason: "card_missing" });
    return null;
  }
  // The reservation (WR-09): counted on the budget, pending until the delivery is confirmed.
  const reserved = {
    day: today,
    used: usedToday + 1,
    status: `${PENDING}${wakeKey}`,
    promptId: lastDonePromptId,
  };
  await tx
    .update(botWorkSessions)
    .set({
      wakesDay: reserved.day,
      wakesUsed: reserved.used,
      lastWokenStatus: reserved.status,
      lastWokenPromptId: reserved.promptId,
    })
    .where(eq(botWorkSessions.workSessionId, s.id));
  // A delivered wake lifts yesterday's budget notice.
  if (notices?.some((n) => n.text === WAKE_LIMIT_NOTICE)) {
    await updatePlatformCardNotified(tx, core, {
      messageId: bot.cardMessageId,
      notices: notices.filter((n) => n.text !== WAKE_LIMIT_NOTICE),
    });
  }

  // The facts of the summary: the latest working-tree summary (its file count only, WR-01).
  const [changesRow] = await tx
    .select({ payload: streamEvents.payload })
    .from(streamEvents)
    .where(and(eq(streamEvents.streamId, wsTopic(s.id)), eq(streamEvents.type, "work_session.changes")))
    .orderBy(desc(streamEvents.seq))
    .limit(1);
  const changes = changesRow ? WorkSessionChanges.safeParse(changesRow.payload) : null;
  const summary = wakeSummary({
    transition,
    projectName: card.projectName,
    turn,
    queued,
    changedFiles: changes?.success ? changes.data.files.length : 0,
    pendingApprovals: approvals.length,
  });
  // D-10: who can decide the pending approvals (sponsor first, then the device's owner); the bot never can.
  const deciders =
    approvals.length > 0
      ? await sessionDeciders(tx, deps.perms, { session: s, sponsorUserId: bot.sponsorUserId })
      : [];
  return {
    bot,
    session: { id: s.id, status: s.status, deviceId: s.deviceId, tainted: s.taintedAt !== null },
    transition,
    summary,
    pendingApprovals: approvals.length,
    deciders,
    cardMessageId: bot.cardMessageId,
    wakeKey,
    eventId,
    reserved,
    previous,
  };
}

type DeliverResult = { delivered: true; eventId: string } | { delivered: false; reason: WakeSkipReason };

/** The task fields `consumeWait` changes, as they were, so a delivery given back restores them exactly. */
type TaskWaitBefore = Pick<
  BotTaskRow,
  "turnsUsed" | "currentEventId" | "waitSeq" | "waitKind" | "waitRef" | "wakeAt" | "updatedAt"
>;

/** What the session's task makes of this wake (PD-14). */
interface TaskWake {
  /** Set when the session belongs to the bot's task for this requester: the offer is then keyed on that task. */
  task: { taskId: string } | null;
  /** The wait this wake consumed (it is the task's own turn), or null. */
  consumed: { task: BotTaskRow; before: TaskWaitBefore } | null;
  /** A turn of the task read outside content (D-08, PD-15): the wake's turn starts tainted. */
  tainted: boolean;
}

const NO_TASK: TaskWake = { task: null, consumed: null, tainted: false };

/**
 * tx2, PD-14: the session's task under its row lock. Another bot's, another conversation's or another person's task
 * (T-07.17.1.1.2-12-03) changes nothing: the wake is the 07.16 wake of a session without a task. An ended task: a plain
 * wake that starts nothing; a running one: a view turn. A waiting one is re-decided first (D-04, PD-09: long tasks off,
 * every turn used, past its deadline by the database's clock), then consumed with the wake's event id.
 */
async function taskWakeOf(tx: Tx, core: Core, bot: BotRow, eventId: string): Promise<TaskWake> {
  if (!bot.taskId) return NO_TASK;
  const task = await lockTask(tx, bot.taskId);
  if (
    !task ||
    task.agentId !== bot.agentId ||
    task.conversationId !== bot.originConversationId ||
    task.requesterUserId !== bot.requesterUserId
  ) {
    return NO_TASK;
  }
  const bound = { task: { taskId: task.id }, consumed: null, tainted: false };
  if (!isActiveTask(task) || task.status !== "waiting") return bound;

  const stop = async (outcome: TaskStopOutcome): Promise<TaskWake> => {
    await stopTask(tx, core, task, outcome, { eventId });
    return bound;
  };
  const [agent] = await tx
    .select({ scope: agents.scope, capabilities: agents.capabilities })
    .from(agents)
    .where(eq(agents.id, task.agentId))
    .limit(1);
  if (!agent || !(await loadTaskPolicy(tx, agent)).enabled) return stop("policy_off");
  if (task.turnsUsed >= task.maxTurns) return stop("budget_turns");
  const clock = await tx.execute(sql`select (${task.deadlineAt}::timestamptz <= now()) as past`);
  if ((clock.rows[0] as { past: boolean }).past) return stop("budget_time");

  // D-08, PD-15: taint is sticky across the task's turns, a wake's included.
  let tainted = task.tainted;
  if (!tainted) {
    const [taintedTurn] = await tx
      .select({ id: agentTurns.eventId })
      .from(agentTurns)
      .where(
        and(
          eq(agentTurns.organizationId, task.organizationId),
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
        .where(and(eq(botTasks.organizationId, task.organizationId), eq(botTasks.id, task.id)));
    }
  }
  const before: TaskWaitBefore = {
    turnsUsed: task.turnsUsed,
    currentEventId: task.currentEventId,
    waitSeq: task.waitSeq,
    waitKind: task.waitKind,
    waitRef: task.waitRef,
    wakeAt: task.wakeAt,
    updatedAt: task.updatedAt,
  };
  if (!(await consumeWait(tx, task, { eventId, reason: "continue" }))) return bound;
  const reserved = await lockTask(tx, task.id);
  if (!reserved) return bound;
  await refreshTaskCard(tx, core, reserved);
  return { task: bound.task, consumed: { task: reserved, before }, tainted };
}

/** A consumed wait whose wake was not delivered as the task's turn: restored exactly while the row still holds it. */
async function giveBackTaskWait(
  tx: Tx,
  core: Core,
  consumed: NonNullable<TaskWake["consumed"]>,
): Promise<void> {
  const { task, before } = consumed;
  const [row] = await tx
    .update(botTasks)
    .set({ status: "waiting", ...before })
    .where(
      and(
        eq(botTasks.organizationId, task.organizationId),
        eq(botTasks.id, task.id),
        eq(botTasks.status, "running"),
        eq(botTasks.currentEventId, task.currentEventId),
        eq(botTasks.waitSeq, before.waitSeq + 1),
      ),
    )
    .returning();
  if (row) await refreshTaskCard(tx, core, row);
}

/** tx2: the wake itself, as the requester (D-17). */
async function deliver(tx: Tx, core: Core, deps: WorkSessionWakesDeps, w: WakePlan): Promise<DeliverResult> {
  const { bot } = w;
  // WR-09: a concurrent run delivered this very wake since tx1 (its turn is keyed by the wake's own id).
  if (await delivered(tx, w.eventId)) return { delivered: true, eventId: w.eventId };
  const [conv] = await tx
    .select({
      id: conversations.id,
      kind: conversations.kind,
      parentId: conversations.parentConversationId,
      archivedAt: conversations.archivedAt,
    })
    .from(conversations)
    .where(eq(conversations.id, bot.originConversationId))
    .limit(1);
  // The confused-deputy rule (T-07.16-20-02): the bot acts for a person who still reads the conversation, judged as
  // the start judged it (`liveTurn`): a thread through its channel or DM, an AI chat as an AI chat (CR-01).
  const judged = conv?.kind === "thread" ? conv.parentId : (conv?.id ?? null);
  if (
    !judged ||
    !(await createConversationAccess(core).isReadable(tx, bot.requesterUserId, judged, {
      kinds: READABLE_KINDS,
    }))
  ) {
    return { delivered: false, reason: "requester_cannot_read" };
  }
  const agent = await findAgent(tx, bot.agentId);
  if (!agent || agent.status === "disabled" || !conv || conv.archivedAt) {
    return { delivered: false, reason: "agent_unavailable" };
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
  if (!membership) return { delivered: false, reason: "agent_unavailable" };
  // PD-14: the session's task, locked after the session's row (tx1) and before anything the turn writes.
  const taskWake = await taskWakeOf(tx, core, bot, w.eventId);

  const direct = DIRECT_KINDS.has(conv.kind);
  const organizationId = bot.organizationId;
  const mention: AgentMention = {
    organizationId,
    conversationId: conv.id,
    // A direct conversation is flat (the event names the message itself); elsewhere the card's thread.
    threadRootId: direct ? w.cardMessageId : (bot.originThreadRootId ?? bot.originMessageId),
    messageId: w.cardMessageId,
    agentIds: [agent.id],
    author: { kind: "user", id: bot.requesterUserId, displayName: "" },
    body: w.summary,
    createdAt: new Date().toISOString(),
    delivery: direct ? "dm" : "thread",
    trigger: "work_session",
    // T-07.16-20-06: a session that took outside content keeps its taint across every wake; PD-15: so does its task.
    taintedAtStart: w.session.tainted || taskWake.tainted,
    // WR-09: the wake's own id, so it is delivered at most once whatever retries or runs concurrently.
    eventId: w.eventId,
    // PD-14: the session's task keys the offer (control only through the consumed wait; never a new start).
    ...(taskWake.task ? { task: taskWake.task } : {}),
  };
  const events = await buildMentionEvents(tx, mention, {
    core,
    perms: deps.perms,
    modelLabel: deps.modelLabel,
    memory: deps.memory,
  });
  const [ev] = events;
  // The bot is live, a member, and the person reads here: no event means the bot's daily limit (its notice follows).
  if (!ev) {
    // PD-14: the wake is given back (transient), and so is the task's wait it consumed.
    if (taskWake.consumed) await giveBackTaskWait(tx, core, taskWake.consumed);
    return { delivered: false, reason: "daily_limit" };
  }
  if (taskWake.consumed) {
    const [linked] = await tx
      .select({ taskId: agentTurns.taskId })
      .from(agentTurns)
      .where(eq(agentTurns.eventId, ev.eventId))
      .limit(1);
    if (linked?.taskId === taskWake.consumed.task.id) {
      // Ids, counts and the reason only (P1), as for every delivered continuation (PD-04).
      await auditTask(tx, core, "bot.task_continued", taskWake.consumed.task, {
        eventId: ev.eventId,
        turnsUsed: taskWake.consumed.task.turnsUsed,
        maxTurns: taskWake.consumed.task.maxTurns,
        reason: "work_session",
      });
    } else {
      // Delivered, but not as the task's turn (the offer withheld the task): the task keeps waiting, nothing counted.
      await giveBackTaskWait(tx, core, taskWake.consumed);
    }
  }
  // D-20 (code review WR-02): the wake resumes the conversation's OpenClaw context. When the bot already read this
  // session's output from a turn here, that output is in it, so the wake starts with the mark (set before the append,
  // like a re-run's taint): it can read, prompt the session it read and stop, nothing else side-effecting.
  const [readHere] = await tx
    .select({ id: agentToolCalls.id })
    .from(agentToolCalls)
    .innerJoin(agentTurns, eq(agentTurns.eventId, agentToolCalls.eventId))
    .where(
      and(
        eq(agentToolCalls.agentId, agent.id),
        eq(agentToolCalls.tool, BUILTIN_TOOLS.workSessionRead),
        eq(agentToolCalls.target, w.session.id),
        eq(agentToolCalls.decision, "allowed"),
        eq(agentTurns.conversationId, conv.id),
      ),
    )
    .limit(1);
  if (readHere) {
    await tx.update(agentTurns).set({ sessionOutputRead: true }).where(eq(agentTurns.eventId, ev.eventId));
  }

  const payload: Omit<AgentWorkSessionEvent, "seq"> = {
    ...ev,
    type: AgentChannelEventTypes.workSession,
    workSession: {
      workSessionId: w.session.id,
      transition: w.transition,
      status: w.session.status,
      summary: w.summary,
      pendingApprovals: w.pendingApprovals,
      deciders: w.deciders,
    },
  };
  await core.realtime.appendEvent(
    tx,
    cellTopic(organizationId),
    AgentChannelEventTypes.workSession,
    payload,
    {
      actorUserId: bot.requesterUserId,
    },
  );
  // Ids and counts only (P1).
  await core.audit.record(tx, {
    action: "bot.work_session_woken",
    resourceType: "work_session",
    resourceId: w.session.id,
    actorKind: "system",
    agentId: agent.id,
    userId: bot.requesterUserId,
    deviceId: w.session.deviceId,
    sessionId: w.session.id,
    metadata: {
      eventId: ev.eventId,
      workSessionId: w.session.id,
      transition: w.transition,
      sponsorUserId: bot.sponsorUserId,
      requesterUserId: bot.requesterUserId,
      wakesUsed: w.reserved.used,
    },
  });
  return { delivered: true, eventId: ev.eventId };
}

/**
 * tx3: gives the reserved wake back (only while the row still holds what tx1 wrote). `restore` un-marks the pair too, so
 * the same state is decided again by the next run (a failure, or a transient skip: WR-09); otherwise the state is
 * woken for good (`<key>`) without spending the budget.
 */
async function release(tx: Tx, w: WakePlan, restore: boolean): Promise<void> {
  const still = and(
    eq(botWorkSessions.workSessionId, w.session.id),
    eq(botWorkSessions.wakesDay, w.reserved.day),
    eq(botWorkSessions.wakesUsed, w.reserved.used),
    eq(botWorkSessions.lastWokenStatus, w.reserved.status),
  );
  await tx
    .update(botWorkSessions)
    .set(
      restore
        ? {
            wakesDay: w.previous.day,
            wakesUsed: w.previous.used,
            lastWokenStatus: w.previous.status,
            lastWokenPromptId: w.previous.promptId,
          }
        : { wakesUsed: w.reserved.used - 1, lastWokenStatus: w.wakeKey },
    )
    .where(still);
}

/** tx3 after a delivery (WR-09): the reservation is confirmed, `pending:<key>` → `<key>` (a no-op once done). */
async function confirm(tx: Tx, w: WakePlan): Promise<void> {
  await tx
    .update(botWorkSessions)
    .set({ lastWokenStatus: w.wakeKey })
    .where(
      and(
        eq(botWorkSessions.workSessionId, w.session.id),
        eq(botWorkSessions.lastWokenStatus, w.reserved.status),
        sql`${botWorkSessions.lastWokenPromptId} is not distinct from ${w.reserved.promptId}::uuid`,
      ),
    );
}

/** Skips that may pass by themselves (the bot's daily turn limit, a bot disabled or removed for a while). */
const TRANSIENT: ReadonlySet<WakeSkipReason> = new Set(["daily_limit", "agent_unavailable"]);

/**
 * One `work_session.bot_sync` job: the card refresh, the wake decision and its delivery (module doc). Returns what
 * happened, for tests; a failure of the delivery gives the reservation back and throws, so pg-boss retries the job.
 */
export async function syncBotWorkSession(
  core: Core,
  deps: WorkSessionWakesDeps,
  data: JobData<"work_session.bot_sync">,
): Promise<"woken" | "skipped" | "none"> {
  const { organizationId, workSessionId } = data;
  // 07.17 code review WR-02: a session of the bot that ended frees a slot for the items that waited for one.
  await core.db.withTenant({ organizationId, userId: null }, (tx) =>
    requeueAfterSession(tx, core, workSessionId),
  );
  const plan = await core.db.withTenant({ organizationId, userId: null }, (tx) =>
    decide(tx, core, deps, workSessionId),
  );
  if (!plan) return "none";
  let out: DeliverResult;
  try {
    out = await core.db.withTenant({ organizationId, userId: plan.bot.requesterUserId }, (tx) =>
      deliver(tx, core, deps, plan),
    );
  } catch (err) {
    await core.db.withTenant({ organizationId, userId: null }, (tx) => release(tx, plan, true));
    throw err;
  }
  if (out.delivered) {
    await core.db.withTenant({ organizationId, userId: null }, (tx) => confirm(tx, plan));
    return "woken";
  }
  const reason = out.reason;
  await core.db.withTenant({ organizationId, userId: null }, async (tx) => {
    // WR-09: a transient skip gives the state back, so a later run (a retry, the next transition) wakes for it.
    await release(tx, plan, TRANSIENT.has(reason));
    if (reason === "requester_cannot_read") {
      await addCardNotice(tx, core, plan.cardMessageId, WAKE_CANNOT_POST_NOTICE);
    }
    await auditSkip(tx, core, plan.bot, {
      deviceId: plan.session.deviceId,
      transition: plan.transition,
      reason,
    });
  });
  return "skipped";
}

/**
 * Wires the handler once (from the module factory, before `core.jobs` starts). Workers run only with
 * `OCW_JOBS_WORKER=on`; tests drive `core.jobs.drain("work_session.bot_sync")`. Logs carry ids and error names only.
 */
export function registerWorkSessionWakes(core: Core, deps: WorkSessionWakesDeps): void {
  core.jobs.work("work_session.bot_sync", async (data) => {
    try {
      await syncBotWorkSession(core, deps, data);
    } catch (err) {
      core.log.warn(
        {
          workSessionId: data.workSessionId,
          err: { name: (err as Error)?.name, code: (err as { code?: unknown })?.code },
        },
        "work session wake failed",
      );
      throw err;
    }
  });
}
