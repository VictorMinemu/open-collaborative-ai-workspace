import {
  type AgentCardNotice,
  AgentChannelEventTypes,
  type AgentWorkSessionEvent,
  BOT_WORK_ZONE_LIMITS,
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
import { createConversationAccess } from "../chat";
import type { MemoryService } from "../memory";
import type { PermissionService } from "../organization";
import { composeWorkSessionCard, sessionDeciders, wsTopic } from "../work-session";
import { updatePlatformCardNotified } from "./card-followers";
import { buildMentionEvents } from "./mentions";

/**
 * Phase 07.16-20 (D-09, D-10, D-12, D-17; PD-12, PD-16, PD-22; ADR-0028): the bot orchestrates its Work Zone session
 * without polling. `setStatus` flips `bot_work_sessions.wake_pending` on every transition of a bot-started session and
 * enqueues one `work_session.bot_sync` job (ids only, about 3 s later). This handler:
 *
 * 1. tx1, user-less (the session's audience backstop hides it from people outside it, Pitfall 2): locks the bot row,
 *    clears `wake_pending`, reads the session as it is NOW, refreshes the live card when its fields changed (the only
 *    writer of the card after the start, bounded by transitions) and decides the wake (PD-16's table). The pair
 *    (status, last finished prompt) already woken never wakes again (E8, retries included); the daily budget is
 *    reserved here (E7); a requester who left the organization is skipped here.
 * 2. tx2, as the requester (D-17): they must still read the conversation, the bot must be live and a member; the wake is
 *    a mention of the bot on its card message with `trigger: "work_session"` (unattended, tainted from the start when
 *    the session is, offered the four Work Zone tools when the profile is active), then `agent.work_session.v1` on
 *    `cell:<org>` and `bot.work_session_woken`.
 * 3. tx3, user-less, only when tx2 delivered nothing (or failed): the budget is given back, the card says why when the
 *    person can no longer be posted for, and `bot.work_session_wake_skipped` names the reason. A failure also restores
 *    the woken pair, so the job's retry decides again.
 *
 * The summary is composed from structured facts only (transition, repository name, turn number, counts, the branch, the
 * tool names of pending approvals), never runtime text, so a wake turn does not start as a read of the session's
 * output. No job row, audit row or log line carries a prompt or an output (P1). The bot never approves anything: the
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
const APPROVAL_TOOLS_MAX = 3;
const DIRECT_KINDS = new Set(["dm", "group"]);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * One or two plain sentences about a transition, from structured facts only (PD-16): never runtime text. The branch
 * passes `redactSecrets`; the result is at most `BOT_WORK_ZONE_LIMITS.summaryChars` characters.
 */
export function wakeSummary(p: {
  transition: WorkSessionTransition;
  projectName: string;
  turn: number;
  queued: number;
  changedFiles: number;
  branch: string | null;
  pendingApprovals: number;
  approvalTools: string[];
}): string {
  const where = `Work Zone session in ${p.projectName.slice(0, NAME_MAX) || "the repository"}`;
  const branch = p.branch ? redactSecrets(p.branch).slice(0, NAME_MAX) : null;
  const changes =
    p.changedFiles > 0
      ? ` ${plural(p.changedFiles, "file", "files")} changed${branch ? ` on ${branch}` : ""}.`
      : "";
  let text: string;
  switch (p.transition) {
    case "turn_done":
      text = `${where} finished turn ${p.turn}; ${p.queued > 0 ? `${plural(p.queued, "prompt is", "prompts are")} queued` : "nothing is queued"}.${changes}`;
      break;
    case "waiting_approval": {
      const tools = p.approvalTools
        .slice(0, APPROVAL_TOOLS_MAX)
        .map((t) => redactSecrets(t).slice(0, 100))
        .join(", ");
      text = `${where} is waiting for ${plural(p.pendingApprovals, "approval", "approvals")}${tools ? ` (${tools})` : ""}. ${APPROVAL_SENTENCE}`;
      break;
    }
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
  if (text.length <= BOT_WORK_ZONE_LIMITS.summaryChars) return text;
  // Only a long branch or tool list can get here; the approval sentence is never cut.
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
  /** What tx1 reserved, so tx3 can give it back exactly. */
  reserved: { day: string; used: number; status: string; promptId: string | null };
  previous: { day: string | null; used: number; status: string | null; promptId: string | null };
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
    .select({ tool: sql<string>`${workApprovals.request}->>'tool'` })
    .from(workApprovals)
    .where(and(eq(workApprovals.workSessionId, s.id), eq(workApprovals.status, "pending")))
    .orderBy(asc(workApprovals.createdAt));

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
    lastWokenPromptId: bot.lastWokenPromptId,
    stoppedByAgent: bot.stoppedByAgent,
  });
  if (!transition) return null;
  // Idempotent across retries and repeated jobs (E8): the same (status, last finished prompt) wakes once.
  if (bot.lastWokenStatus === s.status && bot.lastWokenPromptId === lastDonePromptId) return null;

  const previous = {
    day: bot.wakesDay,
    used: bot.wakesUsed,
    status: bot.lastWokenStatus,
    promptId: bot.lastWokenPromptId,
  };
  const today = ((await tx.execute(sql`select current_date::text as d`)).rows[0] as { d: string }).d;
  const usedToday = bot.wakesDay === today ? bot.wakesUsed : 0;
  const markWoken = (used: number) =>
    tx
      .update(botWorkSessions)
      .set({
        wakesDay: today,
        wakesUsed: used,
        lastWokenStatus: s.status,
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
  await markWoken(usedToday + 1);
  // A delivered wake lifts yesterday's budget notice.
  if (notices?.some((n) => n.text === WAKE_LIMIT_NOTICE)) {
    await updatePlatformCardNotified(tx, core, {
      messageId: bot.cardMessageId,
      notices: notices.filter((n) => n.text !== WAKE_LIMIT_NOTICE),
    });
  }

  // The facts of the summary: the latest working-tree summary (counts and the branch only) and the pending tools.
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
    branch: changes?.success ? changes.data.branch : null,
    pendingApprovals: approvals.length,
    approvalTools: [...new Set(approvals.map((a) => a.tool))],
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
    reserved: { day: today, used: usedToday + 1, status: s.status, promptId: lastDonePromptId },
    previous,
  };
}

type DeliverResult = { delivered: true; eventId: string } | { delivered: false; reason: WakeSkipReason };

/** tx2: the wake itself, as the requester (D-17). */
async function deliver(tx: Tx, core: Core, deps: WorkSessionWakesDeps, w: WakePlan): Promise<DeliverResult> {
  const { bot } = w;
  // The confused-deputy rule (T-07.16-20-02): the bot acts for a person who still reads the conversation.
  if (!(await createConversationAccess(core).isReadable(tx, bot.requesterUserId, bot.originConversationId))) {
    return { delivered: false, reason: "requester_cannot_read" };
  }
  const agent = await findAgent(tx, bot.agentId);
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
    // T-07.16-20-06: a session that took outside content keeps its taint across every wake.
    taintedAtStart: w.session.tainted,
  };
  const events = await buildMentionEvents(tx, mention, {
    core,
    perms: deps.perms,
    modelLabel: deps.modelLabel,
    memory: deps.memory,
  });
  const [ev] = events;
  // The bot is live, a member, and the person reads here: no event means the bot's daily limit (its notice follows).
  if (!ev) return { delivered: false, reason: "daily_limit" };

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

/** tx3: gives the reserved wake back (only while the row still holds what tx1 wrote); `restore` also un-marks the pair. */
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
        : { wakesUsed: w.reserved.used - 1 },
    )
    .where(still);
}

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
  if (out.delivered) return "woken";
  const reason = out.reason;
  await core.db.withTenant({ organizationId, userId: null }, async (tx) => {
    await release(tx, plan, false);
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
