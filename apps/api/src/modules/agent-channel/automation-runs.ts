import {
  AGENT_CARD_TITLE_MAX,
  type AgentAutomationRunEvent,
  type AgentAutomationRunInbound,
  AgentChannelEventTypes,
  AUTOMATION_LIMITS,
  type AutomationRunReason,
  type AutomationRunTrigger,
  type AutomationRunUpdatedEvent,
  cellTopic,
  EventTypes,
  type ModelRef,
} from "@ocw/contracts";
import {
  type AfterCommit,
  agentTurns,
  automationRuns,
  automations,
  conversationMembers,
  conversations,
  messageCards,
  messages,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Core } from "../../core";
import type { AgentMention } from "../../lib/chat-agent-bridge";
import { HttpError } from "../../lib/errors";
import { findAgent } from "../agent";
import { createConversationAccess, updatePlatformCard } from "../chat";
import type { MemoryService } from "../memory";
import { memberDirectory, type PermissionService } from "../organization";
import { buildMentionEvents } from "./mentions";

export { inboundRooted } from "./inbound-origin";

/**
 * Phase 07.6 (AUTO-01, AUTO-02; D-02, D-03, D-07, D-08, D-12, C-01): the proactive-delivery primitive. An automation run
 * becomes a cell turn bound to its anchor message (the platform-owned run card) and to its run-as person, who is the
 * structural author and pays (agent ∩ human, the bot's daily limit). The model reads a server sentence as the message,
 * the standing order in `automationRun.instructions` and outside content only in `automationRun.inbound`. A webhook or
 * mail run is tainted from its first call; the turn is unattended (sandbox tools under 07.8's rules, never a browser).
 * The cell answers the anchor like any turn; the reply rule adds only the anchor (`runAnchorTrigger`).
 */

/** Stored payload; `seq` is injected by the gateway when the frame is sent. */
type StoredAutomationRun = Omit<AgentAutomationRunEvent, "seq">;

/** 409 `automation_inactive`: the run's automation was deleted, so nothing may be posted for it any more. */
export const automationInactive = () =>
  new HttpError(409, "automation_inactive", "This automation no longer exists");

/** The kinds a run may be delivered in: a channel (its thread, a board card's thread) or a DM; never an AI chat. */
const RUN_KINDS = ["channel", "dm"] as const;

/**
 * The server's sentence for a run (the message the bot reads, and the run card's summary): who it is for and what
 * started it. Never model text, never the standing order.
 */
export function runSentence(trigger: AutomationRunTrigger, name: string, person: string): string {
  switch (trigger) {
    case "schedule":
      return `Scheduled task “${name}” for ${person}.`;
    case "manual":
      return `Task “${name}” run now by ${person}.`;
    case "webhook":
      return `Task “${name}” for ${person}, started by a webhook.`;
    case "mail":
      return `Task “${name}” for ${person}, started by a mail.`;
  }
}

export interface DeliverAutomationRunInput {
  runId: string;
  agentId: string;
  runAsUserId: string;
  /** The platform-owned run card the turn is bound to (the message the bot answers). */
  anchorMessageId: string;
  conversationId: string;
  /** The thread the reply goes to: the anchor itself at channel level, the thread root (or board card) otherwise. */
  threadRootId: string;
  delivery: "thread" | "dm";
  automation: { id: string; name: string; instructions: string };
  trigger: AutomationRunTrigger;
  inbound: AgentAutomationRunInbound | null;
  /** Webhook and mail runs (D-02): the turn is tainted from its first call. */
  taintedAtStart: boolean;
  /** The automation's IANA zone: the turn's local time (falls back to UTC). */
  timeZone: string | null;
}

export type DeliverAutomationRunResult =
  | { delivered: true; eventId: string }
  | { delivered: false; reason: AutomationRunReason };

/**
 * Delivers one queued run to the cell, inside the caller's transaction: the run row is locked and must still be `queued`
 * (a retry of a delivered run returns its event id and appends nothing, Pitfall 6). The bot must be live and a member
 * where the anchor is, and the run-as person must still read the conversation (agent ∩ human is re-checked again on the
 * reply). The event is built like a mention of the bot on the anchor (`buildMentionEvents`: attributed history, roster,
 * `turnPolicy` for the run-as person with `taintedAtStart`, `unattended` and the automation's zone, so the daily limit
 * and every tool decision are theirs), then the run becomes `delivered` with its event id, the person hears
 * `automation_run.updated` on `user:<id>`, the event is appended to `cell:<org>` and `automation.run_delivered` is
 * audited with ids only. When nothing is delivered the run stays `queued` and the reason is returned: the caller records
 * it (skipped or failed) and updates the card.
 */
export async function deliverAutomationRun(
  tx: Tx,
  deps: {
    core: Core;
    perms: PermissionService;
    after?: AfterCommit;
    modelLabel?: ((ref: ModelRef) => string) | undefined;
    memory?: MemoryService | undefined;
  },
  p: DeliverAutomationRunInput,
): Promise<DeliverAutomationRunResult> {
  const { core } = deps;
  const [run] = await tx
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.id, p.runId))
    .limit(1)
    .for("update");
  if (!run || run.automationId !== p.automation.id) return { delivered: false, reason: "delivery_failed" };
  if (run.status !== "queued") {
    // Idempotent: a retried delivery of a delivered run is the same delivery; anything else never ran.
    if (run.agentEventId && ["delivered", "answered", "no_reply"].includes(run.status)) {
      return { delivered: true, eventId: run.agentEventId };
    }
    return { delivered: false, reason: (run.reason as AutomationRunReason | null) ?? "delivery_failed" };
  }

  const bot = await findAgent(tx, p.agentId);
  if (!bot || bot.status === "disabled") return { delivered: false, reason: "agent_disabled" };
  const [conv] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, p.conversationId), inArray(conversations.kind, [...RUN_KINDS])))
    .limit(1);
  if (!conv || conv.archivedAt) return { delivered: false, reason: "target_not_postable" };
  const [anchor] = await tx
    .select({ id: messages.id, conversationId: messages.conversationId, deletedAt: messages.deletedAt })
    .from(messages)
    .where(eq(messages.id, p.anchorMessageId))
    .limit(1);
  if (!anchor || anchor.deletedAt || anchor.conversationId !== conv.id) {
    return { delivered: false, reason: "target_not_postable" };
  }
  const scope = [conv.id, ...(conv.parentConversationId ? [conv.parentConversationId] : [])];
  const [membership] = await tx
    .select({ id: conversationMembers.memberId })
    .from(conversationMembers)
    .where(
      and(
        inArray(conversationMembers.conversationId, scope),
        eq(conversationMembers.memberKind, "agent"),
        eq(conversationMembers.memberId, bot.id),
      ),
    )
    .limit(1);
  if (!membership) return { delivered: false, reason: "agent_not_member" };
  // The confused-deputy rule at delivery (the reply re-checks it): the bot acts for a person who reads the conversation.
  const directory = await memberDirectory(tx);
  const person = directory.get(p.runAsUserId);
  if (
    !person ||
    !(await createConversationAccess(core).isReadable(tx, p.runAsUserId, conv.id, { kinds: [...RUN_KINDS] }))
  ) {
    return { delivered: false, reason: "run_as_not_allowed" };
  }

  const mention: AgentMention = {
    organizationId: tenantOf(tx).organizationId,
    conversationId: conv.id,
    threadRootId: p.delivery === "dm" ? p.anchorMessageId : p.threadRootId,
    messageId: p.anchorMessageId,
    agentIds: [bot.id],
    author: { kind: "user", id: p.runAsUserId, displayName: person.displayName },
    body: runSentence(p.trigger, p.automation.name, person.displayName),
    createdAt: new Date().toISOString(),
    delivery: p.delivery,
    trigger: "automation",
    taintedAtStart: p.taintedAtStart,
    clientTimeZone: p.timeZone,
  };
  const events = await buildMentionEvents(tx, mention, {
    core,
    perms: deps.perms,
    ...(deps.after ? { after: deps.after } : {}),
    modelLabel: deps.modelLabel,
    memory: deps.memory,
  });
  const [ev] = events;
  // The bot is live and a member and the person reads here (checked above), so no event means the daily limit
  // (turnPolicy refused to meter, D-11; the limit notice follows like for a mention).
  if (!ev) return { delivered: false, reason: "agent_daily_limit" };

  const [turn] = await tx
    .select({ tainted: agentTurns.tainted })
    .from(agentTurns)
    .where(eq(agentTurns.eventId, ev.eventId));
  const tainted = turn?.tainted === true;
  const [updated] = await tx
    .update(automationRuns)
    .set({
      status: "delivered",
      agentEventId: ev.eventId,
      deliveredAt: sql`now()`,
      anchorMessageId: sql`coalesce(${automationRuns.anchorMessageId}, ${p.anchorMessageId}::uuid)`,
      tainted: sql`${automationRuns.tainted} or ${tainted}`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(automationRuns.id, run.id), eq(automationRuns.status, "queued")))
    .returning({ id: automationRuns.id });
  // The row is locked above, so this cannot lose a race; a miss is a bug, and rolls the turn back with it.
  if (!updated) throw new Error("automation run left the queued state under its lock");

  // Streams in the order a post locks them (conversation, `user:`, cell), so no two writers wait on each other.
  const runUpdated: AutomationRunUpdatedEvent = { automationId: p.automation.id, runId: run.id };
  await core.realtime.appendEvent(tx, `user:${p.runAsUserId}`, EventTypes.automationRunUpdated, runUpdated);
  const payload: StoredAutomationRun = {
    ...ev,
    type: AgentChannelEventTypes.automationRun,
    automationRun: {
      automationId: p.automation.id,
      runId: run.id,
      name: p.automation.name.slice(0, AUTOMATION_LIMITS.nameMax),
      trigger: p.trigger,
      instructions: p.automation.instructions.slice(0, AUTOMATION_LIMITS.instructionsMax),
      // Outside content only here (D-02, Pitfall 3): never in the message text, the history or the instructions.
      inbound: p.inbound
        ? {
            source: p.inbound.source,
            title: p.inbound.title.slice(0, AGENT_CARD_TITLE_MAX),
            text: p.inbound.text.slice(0, AUTOMATION_LIMITS.mailTextMaxChars),
            from: p.inbound.from ? p.inbound.from.slice(0, 320) : null,
            receivedAt: p.inbound.receivedAt,
          }
        : null,
    },
  };
  await core.realtime.appendEvent(
    tx,
    cellTopic(tenantOf(tx).organizationId),
    AgentChannelEventTypes.automationRun,
    payload,
    { actorUserId: p.runAsUserId },
  );
  // Ids and flags only: never the instructions, the inbound text or the sentence.
  await core.audit.record(tx, {
    action: "automation.run_delivered",
    resourceType: "automation_run",
    resourceId: run.id,
    actorKind: "system",
    agentId: bot.id,
    userId: p.runAsUserId,
    metadata: {
      runId: run.id,
      automationId: p.automation.id,
      agentId: bot.id,
      conversationId: conv.id,
      anchorMessageId: p.anchorMessageId,
      eventId: ev.eventId,
      trigger: p.trigger,
      tainted,
    },
  });
  return { delivered: true, eventId: ev.eventId };
}

/** A run anchor's idempotency key as chat stores it (`run:<runId>`, a card's in the `card:` namespace). */
const ANCHOR_KEY = /^(?:card:)?run:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * The run a message anchors (D-08, P-03): the only trigger 07.6 adds to the reply rule. A live run → its run-as person
 * (the human the reply is posted for, whom chat re-checks) with `automationActive: true`. An agent's message posted
 * under a run key whose run is gone (the automation was deleted, its runs with it) → `automationActive: false`: the
 * reply is refused 409. Any other message → null (the ordinary rule applies). Server-set only: a forged key can only
 * make a reply be refused.
 */
export async function runAnchorTrigger(
  tx: Tx,
  messageId: string,
): Promise<{ runId: string; runAsUserId: string | null; automationActive: boolean } | null> {
  const [live] = await tx
    .select({ runId: automationRuns.id, runAsUserId: automations.runAsUserId })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(eq(automationRuns.anchorMessageId, messageId))
    .limit(1);
  if (live) return { runId: live.runId, runAsUserId: live.runAsUserId, automationActive: true };
  const [m] = await tx
    .select({ authorKind: messages.authorKind, key: messages.clientMessageId })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  const match = m?.authorKind === "agent" && m.key ? ANCHOR_KEY.exec(m.key) : null;
  return match?.[1] ? { runId: match[1], runAsUserId: null, automationActive: false } : null;
}

/**
 * The first accepted reply to a run's anchor (P-03), in the reply's transaction: `queued | delivered → answered` (once:
 * any other state is left as it is), the automation's failure streak reset (the breaker counts only failures in a
 * row), the run card set to `succeeded` / "Done", `automation_run.updated` to the run-as person and
 * `automation.run_answered` audited with ids only.
 */
export async function markRunAnswered(tx: Tx, deps: { core: Core }, runId: string): Promise<void> {
  const [run] = await tx
    .update(automationRuns)
    .set({ status: "answered", answeredAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(automationRuns.id, runId), inArray(automationRuns.status, ["queued", "delivered"])))
    .returning({
      id: automationRuns.id,
      automationId: automationRuns.automationId,
      anchorMessageId: automationRuns.anchorMessageId,
    });
  if (!run) return;
  const [automation] = await tx
    .update(automations)
    .set({ consecutiveFailures: 0 })
    .where(eq(automations.id, run.automationId))
    .returning({ runAsUserId: automations.runAsUserId, agentId: automations.agentId });
  if (!automation) return;
  if (run.anchorMessageId) {
    const [card] = await tx
      .select({ platformOwned: messageCards.platformOwned })
      .from(messageCards)
      .where(eq(messageCards.messageId, run.anchorMessageId))
      .limit(1);
    if (card?.platformOwned) {
      await updatePlatformCard(tx, deps.core, {
        messageId: run.anchorMessageId,
        status: "succeeded",
        statusLabel: "Done",
      });
    }
  }
  const runUpdated: AutomationRunUpdatedEvent = { automationId: run.automationId, runId: run.id };
  await deps.core.realtime.appendEvent(
    tx,
    `user:${automation.runAsUserId}`,
    EventTypes.automationRunUpdated,
    runUpdated,
  );
  await deps.core.audit.record(tx, {
    action: "automation.run_answered",
    resourceType: "automation_run",
    resourceId: run.id,
    actorKind: "agent",
    actorId: automation.agentId,
    agentId: automation.agentId,
    userId: automation.runAsUserId,
    metadata: { runId: run.id, automationId: run.automationId, agentId: automation.agentId },
  });
}
