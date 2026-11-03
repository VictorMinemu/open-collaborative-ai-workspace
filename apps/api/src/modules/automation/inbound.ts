import {
  AGENT_CARD_TITLE_MAX,
  type AgentAutomationRunInbound,
  AUTOMATION_LIMITS,
  type AutomationRunReason,
  EventTypes,
  InboundConfig,
} from "@ocw/contracts";
import {
  automationEvents,
  automationRuns,
  automations,
  boardCards,
  conversations,
  mailboxes,
  messages,
  type Tx,
  webhookEndpoints,
} from "@ocw/db";
import { and, asc, count, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { type JobContext, type JobData, lastAttempt } from "../../lib/jobs";
import { createBoardCard, ensureAgentDm } from "../chat";
import type { AutomationRow, AutomationSeamDeps, RunRow } from "./actions";
import { decideAccess } from "./budget";
import {
  boardDescription,
  defuseMentions,
  fullTextReply,
  type InboundItem,
  inboundCard,
  inboundText,
  inboundTitle,
  threadKeyOf,
} from "./inbound-card";
import { isRefusal, refusalReason } from "./targets";

/**
 * Inbound items (07.6-21; AUTO-02, D-02, D-07, P-09, P-11; research Pattern 6, Pitfalls 2 and 3). A webhook delivery or
 * a mail message stored by 10/11 as an `automation_events` row becomes, in the `automation.inbound` job:
 *
 * 1. Gates, in the run-as person's transaction under the event's and the automation's row locks: the automation still
 *    exists and is active (`paused`), the automation's hourly inbound cap (`bot_policies.max_inbound_per_hour`,
 *    `hourly_cap`), then the fire-time access decision without the daily run budget (`decideAccess`: run-as person,
 *    bot, target). A refused item is recorded `not_run` with its reason and nothing is posted.
 * 2. A deterministic post by the platform, never by a model: a platform-owned `automation` card (`Received`, the amber
 *    outside-content notice first) posted as the bot for the run-as person: a thread root in the channel, a reply in
 *    the chosen thread, a flat DM message, or the first reply of a 07.1 board card filed in the chosen column (its
 *    description the fenced text, `external_ref` the thread key). Text beyond the card's 500 characters follows as a
 *    fenced plain-text reply. An item whose thread key matches an earlier posted item of the same automation is a
 *    `Follow-up: …` in that thread (or card).
 * 3. With "Ask {bot} to read it" on: one run (trigger = the source, `inbound_event_id`, anchor = the inbound card,
 *    `tainted`) and its `automation.fire` job in the same transaction. The runner re-decides it like any run and
 *    `agentTurnAction` delivers it through `inboundDelivery`: tainted from the first call, the item only in
 *    `automationRun.inbound`. Off: no run, no cell event.
 *
 * Idempotent: an event that already has a post (or a `not_run` result) is left as it is, and every post has a stable
 * key per event. Ids only in the job, in the audit and in the logs; content never leaves the event row and the posts.
 * `maintenance.daily` clears the content of items older than 30 days (`purgeInbound`).
 */

type EventRow = typeof automationEvents.$inferSelect;

const PURGE_BATCH = 500;
const PURGE_ROUNDS = 20;
const HOUR_MS = 3_600_000;

const processed = (e: EventRow) =>
  e.result === "not_run" || e.messageId !== null || e.boardCardMessageId !== null;

function itemOf(e: EventRow): InboundItem {
  return {
    source: e.source,
    externalId: e.externalId,
    threadKey: e.threadKey,
    subject: e.subject,
    sender: e.sender,
    bodyText: e.bodyText,
    bodyJson: e.bodyJson,
    receivedAt: e.receivedAt,
  };
}

/** The stored inbound rule's mapping (anything unreadable maps nothing). */
function configOf(a: AutomationRow): InboundConfig {
  const parsed = InboundConfig.safeParse(a.inboundConfig ?? {});
  return parsed.success ? parsed.data : {};
}

/** The automation an event belongs to, through its endpoint or its mailbox (null when unlinked or deleted). */
async function automationIdOf(tx: Tx, e: EventRow): Promise<string | null> {
  if (e.webhookEndpointId) {
    const [w] = await tx
      .select({ automationId: webhookEndpoints.automationId })
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, e.webhookEndpointId), isNull(webhookEndpoints.deletedAt)))
      .limit(1);
    return w?.automationId ?? null;
  }
  if (e.mailboxId) {
    const [m] = await tx
      .select({ automationId: mailboxes.automationId })
      .from(mailboxes)
      .where(eq(mailboxes.id, e.mailboxId))
      .limit(1);
    return m?.automationId ?? null;
  }
  return null;
}

/** Events of the same endpoint or mailbox as `e` (one automation each, R3). */
const sameSource = (e: EventRow) =>
  e.webhookEndpointId
    ? eq(automationEvents.webhookEndpointId, e.webhookEndpointId)
    : eq(automationEvents.mailboxId, e.mailboxId as string);

async function markNotRun(tx: Tx, eventId: string, reason: string) {
  await tx
    .update(automationEvents)
    .set({ result: "not_run", reason: reason.slice(0, 64) })
    .where(
      and(
        eq(automationEvents.id, eventId),
        isNull(automationEvents.messageId),
        isNull(automationEvents.boardCardMessageId),
      ),
    );
}

/** Items of this source the platform posted in the last hour (the hourly cap, P-09, Pitfall 2). */
async function postedLastHour(tx: Tx, e: EventRow, now: Date): Promise<number> {
  const [r] = await tx
    .select({ n: count() })
    .from(automationEvents)
    .where(
      and(
        sameSource(e),
        ne(automationEvents.id, e.id),
        eq(automationEvents.result, "accepted"),
        or(isNotNull(automationEvents.messageId), isNotNull(automationEvents.boardCardMessageId)),
        gte(automationEvents.receivedAt, new Date(now.getTime() - HOUR_MS).toISOString()),
      ),
    );
  return Number(r?.n ?? 0);
}

/** Where an earlier item with the same thread key lives (the oldest posted one), if it is still there. */
async function earlierThread(
  tx: Tx,
  e: EventRow,
  a: AutomationRow,
  key: string,
): Promise<{ rootId: string } | null> {
  const [prev] = await tx
    .select({
      messageId: automationEvents.messageId,
      boardCardMessageId: automationEvents.boardCardMessageId,
    })
    .from(automationEvents)
    .where(
      and(
        sameSource(e),
        ne(automationEvents.id, e.id),
        eq(automationEvents.threadKey, key),
        eq(automationEvents.result, "accepted"),
        or(isNotNull(automationEvents.messageId), isNotNull(automationEvents.boardCardMessageId)),
      ),
    )
    .orderBy(asc(automationEvents.receivedAt), asc(automationEvents.id))
    .limit(1);
  if (!prev) return null;
  if (a.targetKind === "board") {
    if (!prev.boardCardMessageId) return null;
    const [card] = await tx
      .select({ id: boardCards.messageId })
      .from(boardCards)
      .innerJoin(messages, eq(messages.id, boardCards.messageId))
      .where(
        and(
          eq(boardCards.messageId, prev.boardCardMessageId),
          eq(boardCards.conversationId, a.conversationId as string),
          isNull(messages.deletedAt),
        ),
      )
      .limit(1);
    return card ? { rootId: card.id } : null;
  }
  if (!prev.messageId) return null;
  const [m] = await tx
    .select({ id: messages.id, threadId: messages.threadId, conversationId: messages.conversationId })
    .from(messages)
    .where(and(eq(messages.id, prev.messageId), isNull(messages.deletedAt)))
    .limit(1);
  if (!m) return null;
  if (a.targetKind === "channel" && m.conversationId !== a.conversationId) return null;
  return { rootId: m.threadId ?? m.id };
}

interface Posted {
  /** The inbound card. */
  messageId: string;
  /** The board card the item was filed as (or followed up in). */
  boardCardMessageId: string | null;
  /** The full-text reply after the card, when the card's field cut the text (outside content too, LO-05). */
  fullMessageId: string | null;
}

/** Posts the item where the automation delivers (the platform's post, as the bot for the run-as person). */
async function postItem(
  core: Core,
  deps: AutomationSeamDeps,
  tx: Tx,
  a: AutomationRow,
  e: EventRow,
  key: string,
): Promise<Posted> {
  const config = configOf(a);
  const item = itemOf(e);
  const previous = await earlierThread(tx, e, a, key);
  const followUp = previous !== null;
  const card = inboundCard(item, { id: a.id, name: a.name, config }, followUp);
  const text = inboundText(item, config);
  const post = (conversationId: string, threadRootId: string | null, body: string, withCard: boolean) =>
    core.chatAgent.postAgentMessageIn(tx, {
      agentId: a.agentId,
      conversationId,
      threadRootId,
      body,
      idempotencyKey: withCard ? `inbound:${e.id}` : `inbound:${e.id}:full`,
      onBehalfOfUserId: a.runAsUserId,
      ...(withCard ? { cardPlatformOwned: true, card } : {}),
    });

  /** The card, then (when the card's field cut it) the full text, in `threadRootId`'s thread. */
  const cardAndText = async (
    conversationId: string,
    threadRootId: string | null,
    fullText: boolean,
  ): Promise<{ messageId: string; fullMessageId: string | null }> => {
    const posted = await post(conversationId, threadRootId, card.summary, true);
    const reply = fullText ? fullTextReply(text) : null;
    const full = reply ? await post(conversationId, threadRootId ?? posted.messageId, reply, false) : null;
    return { messageId: posted.messageId, fullMessageId: full?.messageId ?? null };
  };

  switch (a.targetKind) {
    case "dm": {
      const dm = await ensureAgentDm(
        tx,
        { audit: core.audit, realtime: core.realtime, perms: deps.perms },
        { agentId: a.agentId, userId: a.runAsUserId },
      );
      // DMs are flat: the card is a message, the full text the next one.
      return { ...(await cardAndText(dm.conversationId, null, true)), boardCardMessageId: null };
    }
    case "thread":
      return {
        ...(await cardAndText(a.conversationId as string, a.threadRootMessageId as string, true)),
        boardCardMessageId: null,
      };
    case "board": {
      const conversationId = a.conversationId as string;
      if (previous) {
        return {
          ...(await cardAndText(conversationId, previous.rootId, true)),
          boardCardMessageId: previous.rootId,
        };
      }
      const [conv] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      if (!conv) throw new Error("board target conversation is gone");
      const { description, cut } = boardDescription(text);
      const made = await createBoardCard(
        tx,
        { audit: core.audit, realtime: core.realtime },
        {
          conv,
          author: { kind: "agent", id: a.agentId, onBehalfOfUserId: a.runAsUserId },
          input: {
            title: defuseMentions(inboundTitle(item, { name: a.name, config })).slice(
              0,
              AGENT_CARD_TITLE_MAX,
            ),
            description,
            columnId: a.boardColumnId as string,
            clientMessageId: `board:inbound:${e.id}`,
          },
          clientKind: "agent",
          perms: deps.perms,
        },
      );
      const boardCardMessageId = made.result.row.id;
      if (made.created) {
        // Observers (notifications) as for any agent post; an agent never wakes other agents.
        await core.chatEvents.messagePosted(tx, {
          conv: { id: conv.id, kind: "channel", organizationId: conv.organizationId },
          message: made.result.message,
          author: { kind: "agent", id: a.agentId },
          mentions: made.result.row.mentions,
          mentionAll: null,
          threadRootId: null,
        });
        // 07.1 reserved `external_ref` for this: the key follow-ups find the card by.
        await tx
          .update(boardCards)
          .set({ externalRef: key.slice(0, 200) })
          .where(eq(boardCards.messageId, boardCardMessageId));
      }
      // The inbound card is the card's first reply; the description already holds the text unless it was cut.
      return { ...(await cardAndText(conversationId, boardCardMessageId, cut)), boardCardMessageId };
    }
    default: {
      const conversationId = a.conversationId as string;
      return {
        ...(await cardAndText(conversationId, previous?.rootId ?? null, true)),
        boardCardMessageId: null,
      };
    }
  }
}

/**
 * Handles one inbound event in the run-as person's transaction. Returns without a post when the event is gone, already
 * handled, purged, or refused by a gate (then recorded `not_run`).
 */
async function handleInbound(
  core: Core,
  deps: AutomationSeamDeps,
  tx: Tx,
  eventId: string,
  now: Date,
): Promise<void> {
  // The event first, then its automation: one item at a time per automation (the hourly count is exact).
  const [e] = await tx.select().from(automationEvents).where(eq(automationEvents.id, eventId)).for("update");
  if (!e || processed(e) || e.contentPurgedAt) return;
  const automationId = await automationIdOf(tx, e);
  const [a] = automationId
    ? await tx.select().from(automations).where(eq(automations.id, automationId)).for("update")
    : [];
  if (!a) {
    await markNotRun(tx, e.id, "automation_inactive");
    return;
  }
  if (a.status !== "active") {
    await markNotRun(tx, e.id, "paused");
    return;
  }
  const caps = await deps.service.caps(tx);
  if ((await postedLastHour(tx, e, now)) >= caps.maxInboundPerHour) {
    await markNotRun(tx, e.id, "hourly_cap" satisfies AutomationRunReason);
    return;
  }
  const access = await decideAccess(tx, deps.perms, a);
  if (!access.ok) {
    await markNotRun(tx, e.id, access.reason);
    return;
  }

  const key = threadKeyOf(itemOf(e), configOf(a));
  const posted = await postItem(core, deps, tx, a, e, key);
  await tx
    .update(automationEvents)
    .set({
      result: "accepted",
      reason: null,
      threadKey: key,
      messageId: posted.messageId,
      boardCardMessageId: posted.boardCardMessageId,
      fullMessageId: posted.fullMessageId,
    })
    .where(eq(automationEvents.id, e.id));
  if (!a.inboundAskBot) return;

  // "Ask {bot} to read it": one tainted run anchored on the inbound card; the runner fires it like any run.
  const [run] = await tx
    .insert(automationRuns)
    .values({
      organizationId: a.organizationId,
      automationId: a.id,
      trigger: e.source,
      inboundEventId: e.id,
      anchorMessageId: posted.messageId,
      boardCardMessageId: posted.boardCardMessageId,
      tainted: true,
      status: "queued",
    })
    .onConflictDoNothing()
    .returning({ id: automationRuns.id });
  if (!run) return;
  await core.jobs.sendInTx(tx, "automation.fire", { organizationId: a.organizationId, runId: run.id });
  await core.audit.record(tx, {
    action: "automation.run_started",
    resourceType: "automation_run",
    resourceId: run.id,
    actorKind: "system",
    userId: a.runAsUserId,
    agentId: a.agentId,
    metadata: { automationId: a.id, runId: run.id, trigger: e.source, inboundEventId: e.id },
  });
  await core.realtime.appendEvent(tx, `user:${a.runAsUserId}`, EventTypes.automationRunUpdated, {
    automationId: a.id,
    runId: run.id,
  });
}

/**
 * The `automation.inbound` job: one stored item becomes its post (and maybe its run). Only ids come in; every read is
 * the job organization's (`withTenant`), so a forged cross-tenant id finds nothing. A post refused by chat's own checks
 * (decided again in the post) is recorded `not_run` with the reason in a fresh transaction; any other failure is
 * thrown, so the job is retried and handles the item only while it is still unhandled, and only the last attempt
 * records it `not_run` (`delivery_failed`).
 */
export async function processInbound(
  core: Core,
  deps: AutomationSeamDeps,
  data: JobData<"automation.inbound">,
  now: Date = new Date(),
  attempt?: Pick<JobContext, "retryCount" | "retryLimit">,
): Promise<void> {
  const { organizationId, eventId } = data;
  const runAs = await core.db.withTenant({ organizationId }, async (tx) => {
    const [e] = await tx.select().from(automationEvents).where(eq(automationEvents.id, eventId)).limit(1);
    if (!e || processed(e) || e.contentPurgedAt) return null;
    const automationId = await automationIdOf(tx, e);
    const [a] = automationId
      ? await tx
          .select({ runAs: automations.runAsUserId })
          .from(automations)
          .where(eq(automations.id, automationId))
          .limit(1)
      : [];
    if (!a) {
      await markNotRun(tx, e.id, "automation_inactive");
      return null;
    }
    return a.runAs;
  });
  if (!runAs) return;

  try {
    await core.db.withTenant({ organizationId, userId: runAs }, (tx) =>
      handleInbound(core, deps, tx, eventId, now),
    );
  } catch (err) {
    core.log.warn(
      { eventId, err: { name: (err as Error)?.name, code: (err as { code?: unknown })?.code } },
      "automation inbound failed",
    );
    // A transient failure (deadlock, serialization, connection) is retried; the item is dropped as `not_run` only for
    // a refusal or on the job's last attempt (07.6 review A MD-02).
    if (!isRefusal(err) && !lastAttempt(attempt)) throw err;
    await core.db.withTenant({ organizationId, userId: runAs }, async (tx) => {
      const [e] = await tx
        .select()
        .from(automationEvents)
        .where(eq(automationEvents.id, eventId))
        .for("update");
      if (!e || processed(e)) return;
      await markNotRun(tx, e.id, refusalReason(err));
    });
  }
}

/** What `agentTurnAction` delivers for a webhook or mail run: the inbound card as the anchor, tainted, the item. */
export interface InboundDelivery {
  anchor: {
    anchorMessageId: string;
    conversationId: string;
    threadRootId: string;
    delivery: "thread" | "dm";
  };
  inbound: AgentAutomationRunInbound;
  taintedAtStart: true;
}

/**
 * The delivery of an inbound run (D-02, Pitfall 3): anchored on the inbound card the platform posted, tainted from the
 * first call (`taintedAtStart: true`, so the bot can read and answer but every side-effecting call needs an approval),
 * the item only in `automationRun.inbound`. Null when the item, its content or its card is gone: the run then fails.
 */
export async function inboundDelivery(
  tx: Tx,
  a: AutomationRow,
  run: RunRow,
): Promise<InboundDelivery | null> {
  if (!run.inboundEventId || !run.anchorMessageId) return null;
  const [e] = await tx
    .select()
    .from(automationEvents)
    .where(eq(automationEvents.id, run.inboundEventId))
    .limit(1);
  if (!e || e.contentPurgedAt) return null;
  const [m] = await tx
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      threadId: messages.threadId,
      deletedAt: messages.deletedAt,
      kind: conversations.kind,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.id, run.anchorMessageId))
    .limit(1);
  if (!m || m.deletedAt) return null;
  const item = itemOf(e);
  const config = configOf(a);
  const dm = m.kind === "dm";
  return {
    anchor: {
      anchorMessageId: m.id,
      conversationId: m.conversationId,
      threadRootId: dm ? m.id : (m.threadId ?? m.id),
      delivery: dm ? "dm" : "thread",
    },
    inbound: {
      source: e.source,
      title: inboundTitle(item, { name: a.name, config }),
      text: inboundText(item, config).slice(0, AUTOMATION_LIMITS.mailTextMaxChars),
      from: e.source === "mail" && e.sender ? e.sender.slice(0, 320) : null,
      receivedAt: new Date(e.receivedAt).toISOString(),
    },
    taintedAtStart: true,
  };
}

/**
 * The 30-day retention (Pitfall 3, `AUTOMATION_LIMITS.eventRetentionDays`): the subject, sender, bodies and thread key
 * of older items are cleared and `content_purged_at` set; ids, results, reasons and links stay (a later item can no
 * longer follow up on a purged one: it starts its own thread). Ids come from the definer
 * function `app.expired_automation_events`; each organization's batch is cleared in its own `withTenant`.
 */
export async function purgeInbound(core: Core, now: Date = new Date()): Promise<number> {
  const before = new Date(now.getTime() - AUTOMATION_LIMITS.eventRetentionDays * 24 * HOUR_MS).toISOString();
  let purged = 0;
  for (let round = 0; round < PURGE_ROUNDS; round++) {
    const due = await core.db.pool.query<{ id: string; organization_id: string }>(
      "select id, organization_id from app.expired_automation_events($1, $2)",
      [PURGE_BATCH, before],
    );
    const byOrg = new Map<string, string[]>();
    for (const row of due.rows)
      byOrg.set(row.organization_id, [...(byOrg.get(row.organization_id) ?? []), row.id]);
    for (const [organizationId, ids] of byOrg) {
      try {
        purged += await core.db.withTenant({ organizationId }, async (tx) => {
          const cleared = await tx
            .update(automationEvents)
            .set({
              subject: null,
              sender: null,
              bodyText: null,
              bodyJson: sql`null`,
              // Payload-derived (an e-mail address, a customer id): outside content like the rest (LO-01).
              threadKey: null,
              contentPurgedAt: now.toISOString(),
            })
            .where(and(inArray(automationEvents.id, ids), isNull(automationEvents.contentPurgedAt)))
            .returning({ id: automationEvents.id });
          return cleared.length;
        });
      } catch (err) {
        core.log.warn(
          { organizationId, err: { name: (err as Error)?.name, message: (err as Error)?.message } },
          "inbound content purge failed",
        );
      }
    }
    if (due.rows.length < PURGE_BATCH) break;
  }
  return purged;
}

/**
 * Wires inbound processing once (from the module index, before `core.jobs` starts): the `automation.inbound` worker and
 * the daily content purge (03:17 UTC, once across replicas). Tests drain `automation.inbound` and call `purgeInbound`.
 */
export function registerInbound(core: Core, deps: AutomationSeamDeps): void {
  // Two items at a time per worker (MD-06): items of one automation still go one by one under its row lock.
  core.jobs.work("automation.inbound", (data, ctx) => processInbound(core, deps, data, new Date(), ctx), {
    localConcurrency: 2,
  });
  core.jobs.schedule("maintenance.daily", "17 3 * * *");
  core.jobs.work("maintenance.daily", async () => {
    const purged = await purgeInbound(core);
    if (purged > 0) core.log.info({ purged }, "inbound content purged");
  });
}
