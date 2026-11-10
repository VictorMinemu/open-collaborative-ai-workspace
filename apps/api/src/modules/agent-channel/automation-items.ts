import {
  type AgentAutomationItemEvent,
  AgentChannelEventTypes,
  AUTOMATION_LIMITS,
  type AutomationItemWaitReason,
  type AutomationRunReason,
  automationItemSentence,
  cellTopic,
  type EscalationTargetView,
  FAN_OUT_LIMITS,
  type ModelRef,
} from "@ocw/contracts";
import {
  type AfterCommit,
  automationConversations,
  automations,
  boardCards,
  botWorkSessions,
  conversationMembers,
  conversations,
  messages,
  type Tx,
  tenantOf,
  workSessions,
} from "@ocw/db";
import { and, count, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Core } from "../../core";
import type { AgentMention } from "../../lib/chat-agent-bridge";
import { findAgent } from "../agent";
import { createConversationAccess } from "../chat";
import type { MemoryService } from "../memory";
import { memberDirectory, type PermissionService } from "../organization";
import { ACTIVE_STATES, loadBotProfile } from "../work-session";
import { buildMentionEvents } from "./mentions";

/**
 * Phase 07.17 (D-04, D-09, PD-09, PD-10, PD-17; ADR-0039): every item a fan-out run opened gets its own bot turn in its
 * own thread. The `automation.item` worker (automation's `registerFanOutWorker`) calls `deliverAutomationItem` in one
 * transaction as the automation's run-as person; it mirrors `deliverAutomationRun`:
 *
 * 1. locks the item row (`automation_conversations`); no row (RLS hides another organization's, or it was deleted) or
 *    a row that is not `queued` any more → nothing happens (a retry never makes a second turn, E11);
 * 2. the checks in order, each a skip with its reason (`skipped`, `automation.item_skipped`, E12): the automation is not
 *    `active` → `paused`; the bot is gone or disabled → `agent_disabled`; it is no longer a member where the item is →
 *    `agent_not_member`; the run-as person cannot read the conversation → `bot_not_readable`; the root is gone →
 *    `target_not_postable`;
 * 3. the event is built like a mention of the bot on the root (`buildMentionEvents`): the run-as person is the
 *    structural author and pays, the message is the server's sentence (`automationItemSentence`), the turn is tainted
 *    from its first call (the item is outside content, PD-10) and unattended (no browser tools, no attachment listing),
 *    offered what `turnPolicy` gives the run-as person in that thread plus the 07.16 Work Zone tools
 *    (`workZoneOfferFor`, tainted), never `ocw_conversation_open` (only run turns) and never a consult (tainted). The
 *    event id is derived from the item (`eventId`, the 07.16 WR-09 construction); no event means the bot's daily limit
 *    (`agent_daily_limit`, its usual notice in the thread);
 * 4. the item travels only in `automationItem.item`, read from the root (a board card's title and description, a
 *    channel message's body), bounded; the row becomes `delivered` with the event id, the event is appended to
 *    `cell:<org>` and `automation.item_delivered` audited with ids only (P1: never the title or the text).
 */

/** Stored payload; `seq` is injected by the gateway when the frame is sent. */
type StoredAutomationItem = Omit<AgentAutomationItemEvent, "seq">;

/** Opened items live in channels and boards (a board is a `channel` with `layout = 'board'`). */
const ITEM_KINDS = ["channel"] as const;

type AutomationRow = typeof automations.$inferSelect;

export interface DeliverAutomationItemDeps {
  core: Core;
  perms: PermissionService;
  after?: AfterCommit;
  modelLabel?: ((ref: ModelRef) => string) | undefined;
  memory?: MemoryService | undefined;
  /**
   * The automation's escalation targets as they resolve at this delivery (automation's `escalationFor`: gone or no
   * longer valid targets dropped). The automation module passes it in (agent-channel never imports it). Absent = none.
   */
  escalationFor?: ((tx: Tx, a: AutomationRow) => Promise<EscalationTargetView[]>) | undefined;
}

export interface DeliverAutomationItemInput {
  itemId: string;
  /**
   * The item turn's event id (`itemEventId(itemId, attempt)`, derived, so a retry can never make a second turn; a new
   * attempt after waiting gets a new one, WR-02).
   */
  eventId: string;
  /** WR-02: the attempt the job was sent for; a row at another attempt (a newer job exists) is left as it is. */
  attempt?: number;
}

export type DeliverAutomationItemResult =
  | { delivered: true; eventId: string }
  | { delivered: false; reason?: AutomationRunReason };

/** One line of plain text (a channel item's title is its first line, the bold markers taken off). */
function firstLine(body: string): string {
  const line = body.split("\n", 1)[0] ?? "";
  return line
    .replace(/^\*\*(.*)\*\*$/u, "$1")
    .trim()
    .slice(0, FAN_OUT_LIMITS.titleMax);
}

/**
 * Records a skip on a still-queued item (in the caller's transaction): `skipped` with its reason, and one
 * `automation.item_skipped` audit with ids and the reason only. A row that left `queued` meanwhile is left as it is.
 */
export async function skipAutomationItem(
  tx: Tx,
  core: Core,
  itemId: string,
  reason: AutomationRunReason | AutomationItemWaitReason,
  /**
   * 07.17 code review WR-01: `failed` when the delivery's last attempt failed for a reason that is not a refusal (a
   * deadlock, a dropped connection), audited with result `error`; `skipped` (result `denied`) otherwise.
   */
  outcome: "skipped" | "failed" = "skipped",
): Promise<void> {
  const [row] = await tx
    .update(automationConversations)
    .set({ status: outcome, reason, updatedAt: sql`now()` })
    .where(and(eq(automationConversations.id, itemId), eq(automationConversations.status, "queued")))
    .returning({
      id: automationConversations.id,
      automationId: automationConversations.automationId,
      runId: automationConversations.runId,
    });
  if (!row) return;
  const [a] = await tx
    .select({ agentId: automations.agentId, runAsUserId: automations.runAsUserId })
    .from(automations)
    .where(eq(automations.id, row.automationId))
    .limit(1);
  await core.audit.record(tx, {
    action: "automation.item_skipped",
    resourceType: "automation_item",
    resourceId: row.id,
    result: outcome === "failed" ? "error" : "denied",
    actorKind: "system",
    ...(a ? { agentId: a.agentId, userId: a.runAsUserId } : {}),
    metadata: { automationId: row.automationId, runId: row.runId, itemId: row.id, reason },
  });
}

/**
 * 07.17 code review WR-02: an item whose turn found no free Work Zone session (`session_capacity`, from `delivered`) or
 * the bot at its daily limit (`agent_daily_limit`, from `queued`) waits, in the caller's transaction: `waiting` with
 * its reason and one `automation.item_waiting` audit (ids, the reason and the attempt only). An item already queued
 * again `FAN_OUT_LIMITS.itemAttemptsMax` times is skipped with that reason instead (`automation.item_skipped`, the
 * same ids, the reason and the attempt). A row
 * that is not in `from` any more is left as it is. Returns what it became.
 */
export async function waitAutomationItem(
  tx: Tx,
  core: Core,
  p: { itemId: string; reason: AutomationItemWaitReason; from: "queued" | "delivered" },
): Promise<"waiting" | "skipped" | null> {
  const [row] = await tx
    .select({ id: automationConversations.id, attempt: automationConversations.attempt })
    .from(automationConversations)
    .where(and(eq(automationConversations.id, p.itemId), eq(automationConversations.status, p.from)))
    .limit(1)
    .for("update");
  if (!row) return null;
  const exhausted = row.attempt >= FAN_OUT_LIMITS.itemAttemptsMax;
  const [updated] = await tx
    .update(automationConversations)
    .set({ status: exhausted ? "skipped" : "waiting", reason: p.reason, updatedAt: sql`now()` })
    .where(eq(automationConversations.id, row.id))
    .returning({
      id: automationConversations.id,
      automationId: automationConversations.automationId,
      runId: automationConversations.runId,
    });
  if (!updated) return null;
  await auditItem(tx, core, exhausted ? "automation.item_skipped" : "automation.item_waiting", updated, {
    reason: p.reason,
    attempt: row.attempt,
  });
  return exhausted ? "skipped" : "waiting";
}

/** Ids, the reason and the attempt only (P1): never a title, a text or a key. */
async function auditItem(
  tx: Tx,
  core: Core,
  action: "automation.item_waiting" | "automation.item_requeued" | "automation.item_skipped",
  row: { id: string; automationId: string; runId: string },
  extra: { reason: AutomationItemWaitReason; attempt: number },
): Promise<void> {
  const [a] = await tx
    .select({ agentId: automations.agentId, runAsUserId: automations.runAsUserId })
    .from(automations)
    .where(eq(automations.id, row.automationId))
    .limit(1);
  await core.audit.record(tx, {
    action,
    resourceType: "automation_item",
    resourceId: row.id,
    actorKind: "system",
    ...(a ? { agentId: a.agentId, userId: a.runAsUserId } : {}),
    metadata: { automationId: row.automationId, runId: row.runId, itemId: row.id, ...extra },
  });
}

/**
 * WR-02: the Work Zone start of an item's own turn answered `too_many_sessions`, so the item waits for a free session
 * (in the start's transaction). Any other turn (a run, a wake, a person's mention, an earlier attempt) is not an item
 * turn and changes nothing.
 */
export async function waitItemForTurn(tx: Tx, core: Core, eventId: string): Promise<void> {
  const [row] = await tx
    .select({ id: automationConversations.id })
    .from(automationConversations)
    .where(
      and(eq(automationConversations.agentEventId, eventId), eq(automationConversations.status, "delivered")),
    )
    .limit(1);
  if (row)
    await waitAutomationItem(tx, core, { itemId: row.id, reason: "session_capacity", from: "delivered" });
}

/**
 * WR-02: one waiting item back to `queued` (already locked by the caller), with `attempt + 1`, so its job derives a new
 * event id and delivers a new turn; one ids-only `automation.item` job and one `automation.item_requeued` audit.
 */
export async function requeueAutomationItem(tx: Tx, core: Core, itemId: string): Promise<boolean> {
  const [waiting] = await tx
    .select({ reason: automationConversations.reason })
    .from(automationConversations)
    .where(and(eq(automationConversations.id, itemId), eq(automationConversations.status, "waiting")))
    .limit(1);
  if (!waiting) return false;
  const [row] = await tx
    .update(automationConversations)
    .set({
      status: "queued",
      reason: null,
      attempt: sql`${automationConversations.attempt} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(automationConversations.id, itemId), eq(automationConversations.status, "waiting")))
    .returning({
      id: automationConversations.id,
      automationId: automationConversations.automationId,
      runId: automationConversations.runId,
      organizationId: automationConversations.organizationId,
      attempt: automationConversations.attempt,
    });
  if (!row) return false;
  await auditItem(tx, core, "automation.item_requeued", row, {
    reason: waiting.reason === "agent_daily_limit" ? "agent_daily_limit" : "session_capacity",
    attempt: row.attempt,
  });
  // Ids only (P1), as when it was opened.
  await core.jobs.sendInTx(tx, "automation.item", { organizationId: row.organizationId, itemId: row.id });
  return true;
}

/**
 * WR-02, from the `work_session.bot_sync` handler (user-less): one of the bot's sessions left the active states, so as
 * many of its `session_capacity` items as it now has free sessions (`maxConcurrent` of its profile minus its active
 * sessions) go back to the queue, oldest first, of active automations only (`FOR UPDATE SKIP LOCKED`: two endings at
 * once queue two different items). A bot without a profile queues nothing (its item turns could not start one).
 * Returns how many were queued again.
 */
export async function requeueAfterSession(tx: Tx, core: Core, workSessionId: string): Promise<number> {
  const [bot] = await tx
    .select({ agentId: botWorkSessions.agentId, status: workSessions.status })
    .from(botWorkSessions)
    .innerJoin(workSessions, eq(workSessions.id, botWorkSessions.workSessionId))
    .where(eq(botWorkSessions.workSessionId, workSessionId))
    .limit(1);
  if (!bot || ACTIVE_STATES.includes(bot.status)) return 0;
  const profile = await loadBotProfile(tx, bot.agentId);
  if (!profile) return 0;
  const [active] = await tx
    .select({ n: count() })
    .from(workSessions)
    .where(
      and(
        isNotNull(workSessions.startedByAgentId),
        eq(workSessions.startedByAgentId, bot.agentId),
        inArray(workSessions.status, ACTIVE_STATES),
      ),
    );
  const free = profile.maxConcurrent - Number(active?.n ?? 0);
  if (free <= 0) return 0;
  const res = await tx.execute(sql`
    select c.id from app.automation_conversations c
    join app.automations a on a.organization_id = c.organization_id and a.id = c.automation_id
    where c.status = 'waiting' and c.reason = 'session_capacity' and a.agent_id = ${bot.agentId}::uuid
      and a.status = 'active'
    order by c.updated_at, c.id
    limit ${free}
    for update of c skip locked`);
  let queued = 0;
  for (const r of res.rows as Array<{ id: string }>) {
    if (await requeueAutomationItem(tx, core, r.id)) queued += 1;
  }
  return queued;
}

/**
 * Delivers one queued item to the cell, inside the caller's transaction as the automation's run-as person (module
 * doc). Returns what happened, for the worker and the tests; a skip is already recorded when it returns.
 */
export async function deliverAutomationItem(
  tx: Tx,
  deps: DeliverAutomationItemDeps,
  p: DeliverAutomationItemInput,
): Promise<DeliverAutomationItemResult> {
  const { core } = deps;
  const [item] = await tx
    .select()
    .from(automationConversations)
    .where(eq(automationConversations.id, p.itemId))
    .limit(1)
    .for("update");
  if (!item) return { delivered: false };
  if (item.status !== "queued") {
    // Idempotent (E11): a retried delivery of a delivered item is the same delivery; anything else never ran.
    return item.status === "delivered" && item.agentEventId
      ? { delivered: true, eventId: item.agentEventId }
      : { delivered: false };
  }
  // WR-02: a job of an earlier attempt (the item waited and was queued again since) leaves it to the newer job.
  if (p.attempt !== undefined && item.attempt !== p.attempt) return { delivered: false };
  const skip = async (reason: AutomationRunReason): Promise<DeliverAutomationItemResult> => {
    await skipAutomationItem(tx, core, item.id, reason);
    return { delivered: false, reason };
  };

  const [a] = await tx.select().from(automations).where(eq(automations.id, item.automationId)).limit(1);
  if (!a) return { delivered: false };
  if (a.status !== "active") return skip("paused");

  const bot = await findAgent(tx, a.agentId);
  if (!bot || bot.status === "disabled") return skip("agent_disabled");
  const [conv] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, item.conversationId), inArray(conversations.kind, [...ITEM_KINDS])))
    .limit(1);
  if (!conv || conv.archivedAt) return skip("target_not_postable");
  const [membership] = await tx
    .select({ id: conversationMembers.memberId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conv.id),
        eq(conversationMembers.memberKind, "agent"),
        eq(conversationMembers.memberId, bot.id),
      ),
    )
    .limit(1);
  if (!membership) return skip("agent_not_member");
  // The confused-deputy rule at delivery (every reply re-checks it): the bot acts for a person who reads here.
  const person = (await memberDirectory(tx)).get(a.runAsUserId);
  if (
    !person ||
    !(await createConversationAccess(core).isReadable(tx, a.runAsUserId, conv.id, { kinds: [...ITEM_KINDS] }))
  ) {
    return skip("bot_not_readable");
  }
  const [root] = item.rootMessageId
    ? await tx
        .select({
          id: messages.id,
          conversationId: messages.conversationId,
          body: messages.body,
          deletedAt: messages.deletedAt,
        })
        .from(messages)
        .where(eq(messages.id, item.rootMessageId))
        .limit(1)
    : [];
  if (!root || root.deletedAt || root.conversationId !== conv.id) return skip("target_not_postable");

  // The item as the platform posted it (bot-written, defused at open time): a card's title and description, or the
  // channel message's body (its bold first line as the title).
  const [card] = await tx
    .select({ title: boardCards.title, description: boardCards.description })
    .from(boardCards)
    .where(eq(boardCards.messageId, root.id))
    .limit(1);
  const itemView = card
    ? { title: card.title.slice(0, FAN_OUT_LIMITS.titleMax), text: card.description }
    : { title: firstLine(root.body), text: root.body };

  const mention: AgentMention = {
    organizationId: tenantOf(tx).organizationId,
    conversationId: conv.id,
    threadRootId: root.id,
    messageId: root.id,
    agentIds: [bot.id],
    author: { kind: "user", id: a.runAsUserId, displayName: person.displayName },
    body: automationItemSentence(a.name),
    createdAt: new Date().toISOString(),
    delivery: "thread",
    trigger: "automation_item",
    // PD-10: the item is outside content, so its turn is tainted from its first call.
    taintedAtStart: true,
    clientTimeZone: a.timeZone,
    // WR-09's construction: one item, one turn, whatever retries.
    eventId: p.eventId,
  };
  const events = await buildMentionEvents(tx, mention, {
    core,
    perms: deps.perms,
    ...(deps.after ? { after: deps.after } : {}),
    modelLabel: deps.modelLabel,
    memory: deps.memory,
  });
  const [ev] = events;
  // The bot is live and a member and the person reads here (checked above): no event means the daily limit (turnPolicy
  // refused to meter, D-11; the limit notice follows in the item's thread like for a mention). WR-02: the item waits
  // for the automation's next local day (the scheduler tick queues it again), bounded by its attempts.
  if (!ev) {
    await waitAutomationItem(tx, core, { itemId: item.id, reason: "agent_daily_limit", from: "queued" });
    return { delivered: false, reason: "agent_daily_limit" };
  }

  const escalation = deps.escalationFor ? await deps.escalationFor(tx, a) : [];
  const [updated] = await tx
    .update(automationConversations)
    .set({ status: "delivered", reason: null, agentEventId: ev.eventId, updatedAt: sql`now()` })
    .where(and(eq(automationConversations.id, item.id), eq(automationConversations.status, "queued")))
    .returning({ id: automationConversations.id });
  // The row is locked above, so this cannot lose a race; a miss is a bug, and rolls the turn back with it.
  if (!updated) throw new Error("automation item left the queued state under its lock");

  const payload: StoredAutomationItem = {
    ...ev,
    type: AgentChannelEventTypes.automationItem,
    automationItem: {
      automationId: a.id,
      runId: item.runId,
      itemId: item.id,
      name: a.name.slice(0, AUTOMATION_LIMITS.nameMax),
      instructions: a.instructions.slice(0, AUTOMATION_LIMITS.instructionsMax),
      // Outside content only here (PD-09): never in the message text, the history or the instructions.
      item: {
        title: itemView.title,
        text: itemView.text.slice(0, FAN_OUT_LIMITS.bodyMax),
        openedAt: new Date(item.createdAt).toISOString(),
      },
      escalation: escalation.slice(0, FAN_OUT_LIMITS.escalationMax),
    },
  };
  await core.realtime.appendEvent(
    tx,
    cellTopic(tenantOf(tx).organizationId),
    AgentChannelEventTypes.automationItem,
    payload,
    { actorUserId: a.runAsUserId },
  );
  // Ids only (P1, PD-17): never the item's title or text, the instructions or the sentence.
  await core.audit.record(tx, {
    action: "automation.item_delivered",
    resourceType: "automation_item",
    resourceId: item.id,
    actorKind: "system",
    agentId: bot.id,
    userId: a.runAsUserId,
    metadata: { automationId: a.id, runId: item.runId, itemId: item.id, eventId: ev.eventId },
  });
  return { delivered: true, eventId: ev.eventId };
}
