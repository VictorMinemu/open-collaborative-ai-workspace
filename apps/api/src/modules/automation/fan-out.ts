import { createHash, createHmac, hkdfSync } from "node:crypto";
import {
  AGENT_CARD_TITLE_MAX,
  type AgentChannelConversationOpenItem,
  type AgentChannelConversationOpenResponse,
  type ConversationOpenItemResult,
  fanOutLabel,
} from "@ocw/contracts";
import {
  automationConversations,
  automations,
  conversations,
  messageCards,
  messages,
  type Tx,
} from "@ocw/db";
import { and, count, eq, gte } from "drizzle-orm";
import { decodeKey } from "../../config/env";
import type { Core } from "../../core";
import { type JobContext, type JobData, lastAttempt } from "../../lib/jobs";
import {
  deliverAutomationItem,
  lockRunAndAutomation,
  markRunAnswered,
  requeueAutomationItem,
  skipAutomationItem,
  updatePlatformCardNotified,
} from "../agent-channel";
import { createBoardCard } from "../chat";
import type { PermissionService } from "../organization";
import type { AutomationSeamDeps } from "./actions";
import { localDayStart } from "./budget";
import { escalationFor } from "./escalation";
import { boardDescription, defuseMentions, inertMarkdown, textFence } from "./inbound-card";
import { isRefusal, refusalReason } from "./targets";

/**
 * Phase 07.17 (D-02, D-03, D-05, D-15; PD-07, PD-08, PD-17): a fan-out run opens one conversation per new item in its
 * own target. The Agent Channel route (`agent-channel/conversations-open.ts`) finds the run turn, decides the refusals
 * and claims the call as the run-as person; `open` then, in that same transaction:
 *
 * 1. locks the run, then the automation (the runner's order), and re-reads the automation;
 * 2. counts this run's opened rows and the automation's rows since its local midnight (`localDayStart`), the caps;
 * 3. per item, in request order: a key the automation already opened (also earlier in this request, also by a
 *    concurrent run that committed first) answers `opened: false` with its ids and posts nothing (D-03); past a cap the
 *    item is `refused` (`day_cap` before `run_cap`); else one row is inserted first (`ON CONFLICT (automation_id,
 *    external_key_hash) DO NOTHING`), the root is posted as the bot for the run-as person (a board card in the
 *    automation's column, or a top-level channel message), its id stored, and one ids-only `automation.item` job sent;
 * 4. marks the run answered (an empty list too), labels its card (`fanOutLabel`) and audits
 *    `automation.conversation_opened` with ids and counts.
 *
 * Bot-written text never mentions anyone (P2): titles and bodies are defused, bodies fenced, the channel title inert
 * Markdown, and the board card is posted with `mentionAll: null`. Ids and counts only (P1): the external key is hashed
 * (a keyed HMAC-SHA256, hex: code review WR-06) and never stored in clear, logged, audited or put in a job; titles and
 * bodies live only in the posts.
 * The route takes the target, the column, the run and the person from the stored turn and automation (P6).
 */

export interface FanOutOpenInput {
  /** `cellAuditBase(cell)`: the client kind and session of the cell's audit rows. */
  auditBase: { clientKind: string; sessionId: string };
  turn: { eventId: string; agentId: string; tainted: boolean };
  run: { id: string; automationId: string; anchorMessageId: string | null };
  items: readonly AgentChannelConversationOpenItem[];
}

export interface AutomationFanOut {
  open(tx: Tx, p: FanOutOpenInput): Promise<AgentChannelConversationOpenResponse>;
  /**
   * True when `err`, thrown by `open`, is the target's refusal of a post (chat's `HttpError` or `AuthzDeniedError`): the
   * caller rolls the transaction back and answers `target_not_postable`.
   */
  isPostRefusal(err: unknown): boolean;
}

/** HKDF `info` of the dedupe key: a key of its own, derived from the server secret, never reused for anything else. */
const ITEM_KEY_INFO = "ocw/automation-item-key/v1";

/**
 * 07.17 code review WR-06: the server key the dedupe hashes are keyed with, derived (HKDF-SHA256) from
 * `OCW_ENCRYPTION_KEY`, the operator secret the API already resolves through the `SecretStore` (`env`, `_FILE` or an
 * `openbao://` reference; principle 8): never stored in the database or a config file. Rotating that secret re-keys
 * every hash, so items already opened would open again: rotate it only with a rehash.
 */
export function itemKeySecret(encryptionKey: string): Buffer {
  const master = decodeKey(encryptionKey);
  if (!master) throw new Error("OCW_ENCRYPTION_KEY is invalid");
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), ITEM_KEY_INFO, 32));
}

/**
 * The dedupe key of an external item (D-03, P1; code review WR-06): HMAC-SHA256 under `itemKeySecret`, hex, over the
 * organization, the automation and the NFC-normalised, trimmed key, NUL-separated. Never stored in clear and not
 * reversible from a database or backup read (order numbers and plates are low-entropy), and scoped per automation (the
 * same order in two automations stores two unrelated hashes). Keeps the 64-hex format and the unique index.
 */
export function externalKeyHash(
  secret: Buffer,
  p: { organizationId: string; automationId: string; key: string },
): string {
  return createHmac("sha256", secret)
    .update(`${p.organizationId}\u0000${p.automationId}\u0000${p.key.normalize("NFC").trim()}`, "utf8")
    .digest("hex");
}

/** One line of plain text: control characters and runs of whitespace become one space. */
function oneLine(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is removed here.
  return text.replace(/[\u0000-\u001f\u007f\s]+/gu, " ").trim();
}

/** A channel item's body: the title in bold (inert Markdown, defused) and, when there is one, the fenced body. */
export function channelItemBody(item: Pick<AgentChannelConversationOpenItem, "title" | "body">): string {
  const title = `**${inertMarkdown(defuseMentions(oneLine(item.title)))}**`;
  return item.body.trim() === "" ? title : `${title}\n\n${textFence(defuseMentions(item.body))}`;
}

export function createAutomationFanOut(core: Core, deps: { perms: PermissionService }): AutomationFanOut {
  const keySecret = itemKeySecret(core.env.OCW_ENCRYPTION_KEY);
  /** The root an earlier row opened, or null once it is gone or deleted (E10). */
  async function liveRoot(tx: Tx, rootMessageId: string | null): Promise<string | null> {
    if (!rootMessageId) return null;
    const [m] = await tx
      .select({ id: messages.id, deletedAt: messages.deletedAt })
      .from(messages)
      .where(eq(messages.id, rootMessageId))
      .limit(1);
    return m && !m.deletedAt ? m.id : null;
  }

  async function existingRow(
    tx: Tx,
    automationId: string,
    hash: string,
  ): Promise<{ conversationId: string; rootMessageId: string | null } | null> {
    const [row] = await tx
      .select({
        conversationId: automationConversations.conversationId,
        rootMessageId: automationConversations.rootMessageId,
      })
      .from(automationConversations)
      .where(
        and(
          eq(automationConversations.automationId, automationId),
          eq(automationConversations.externalKeyHash, hash),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  return {
    isPostRefusal: isRefusal,

    async open(tx, p) {
      await lockRunAndAutomation(tx, p.run.id);
      const [a] = await tx.select().from(automations).where(eq(automations.id, p.run.automationId)).limit(1);
      if (!a?.conversationId) throw new Error("fan-out: the automation or its target is gone");
      const conversationId = a.conversationId;

      const since = localDayStart(new Date(), a.timeZone ?? "UTC").toISOString();
      const [day] = await tx
        .select({ n: count() })
        .from(automationConversations)
        .where(
          and(eq(automationConversations.automationId, a.id), gte(automationConversations.createdAt, since)),
        );
      const [ofRun] = await tx
        .select({ n: count() })
        .from(automationConversations)
        .where(eq(automationConversations.runId, p.run.id));
      let dayCount = Number(day?.n ?? 0);
      let runCount = Number(ofRun?.n ?? 0);

      const [conv] =
        a.targetKind === "board"
          ? await tx.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1)
          : [];

      /** Posts the root of item `itemId` where the automation delivers; returns its message id. */
      const post = async (itemId: string, item: AgentChannelConversationOpenItem): Promise<string> => {
        if (a.targetKind === "board") {
          if (!conv) throw new Error("fan-out: the board conversation is gone");
          const made = await createBoardCard(
            tx,
            { audit: core.audit, realtime: core.realtime },
            {
              conv,
              author: { kind: "agent", id: a.agentId, onBehalfOfUserId: a.runAsUserId },
              input: {
                // D-15: a typed title (the board's number prefix applies); defused, so it mentions nobody.
                title: defuseMentions(oneLine(item.title)).slice(0, AGENT_CARD_TITLE_MAX),
                description: boardDescription(defuseMentions(item.body)).description,
                ...(a.boardColumnId ? { columnId: a.boardColumnId } : {}),
                clientMessageId: `board:item:${itemId}`,
              },
              clientKind: "agent",
              perms: deps.perms,
            },
          );
          if (made.created) {
            // Observers (notifications) as for any agent post; never `@channel`, never a bot wake.
            await core.chatEvents.messagePosted(tx, {
              conv: { id: conversationId, kind: "channel", organizationId: a.organizationId },
              message: made.result.message,
              author: { kind: "agent", id: a.agentId },
              mentions: made.result.row.mentions,
              mentionAll: null,
              threadRootId: null,
            });
          }
          return made.result.row.id;
        }
        if (a.targetKind !== "channel") throw new Error("fan-out: only channel and board targets open items");
        const posted = await core.chatAgent.postAgentMessageIn(tx, {
          agentId: a.agentId,
          conversationId,
          threadRootId: null,
          body: channelItemBody(item),
          idempotencyKey: `item:${itemId}`,
          onBehalfOfUserId: a.runAsUserId,
        });
        return posted.messageId;
      };

      const results: ConversationOpenItemResult[] = [];
      let opened = 0;
      let existing = 0;
      let refused = 0;
      for (const item of p.items) {
        const hash = externalKeyHash(keySecret, {
          organizationId: a.organizationId,
          automationId: a.id,
          key: item.externalKey,
        });
        const known = await existingRow(tx, a.id, hash);
        if (known) {
          existing += 1;
          results.push({
            externalKey: item.externalKey,
            opened: false,
            conversationId: known.conversationId,
            threadRootMessageId: await liveRoot(tx, known.rootMessageId),
            refused: null,
          });
          continue;
        }
        const cap = dayCount >= a.fanOutPerDay ? "day_cap" : runCount >= a.fanOutPerRun ? "run_cap" : null;
        if (cap) {
          refused += 1;
          results.push({
            externalKey: item.externalKey,
            opened: false,
            conversationId: null,
            threadRootMessageId: null,
            refused: cap,
          });
          continue;
        }
        // Insert first: the unique key decides, even against a writer this lock did not order.
        const [row] = await tx
          .insert(automationConversations)
          .values({
            organizationId: a.organizationId,
            automationId: a.id,
            runId: p.run.id,
            externalKeyHash: hash,
            conversationId,
          })
          .onConflictDoNothing({
            target: [automationConversations.automationId, automationConversations.externalKeyHash],
          })
          .returning({ id: automationConversations.id });
        if (!row) {
          const raced = await existingRow(tx, a.id, hash);
          existing += 1;
          results.push({
            externalKey: item.externalKey,
            opened: false,
            conversationId: raced?.conversationId ?? conversationId,
            threadRootMessageId: await liveRoot(tx, raced?.rootMessageId ?? null),
            refused: null,
          });
          continue;
        }
        const rootMessageId = await post(row.id, item);
        await tx
          .update(automationConversations)
          .set({ rootMessageId })
          .where(eq(automationConversations.id, row.id));
        // Ids only (P1): the item's own turn reads its text from the root (07.17-17).
        await core.jobs.sendInTx(tx, "automation.item", { organizationId: a.organizationId, itemId: row.id });
        dayCount += 1;
        runCount += 1;
        opened += 1;
        results.push({
          externalKey: item.externalKey,
          opened: true,
          conversationId,
          threadRootMessageId: rootMessageId,
          refused: null,
        });
      }

      // The run is answered by its call (E5: an empty list too), and its card says what it opened.
      await markRunAnswered(tx, { core }, p.run.id);
      if (p.run.anchorMessageId) {
        const [card] = await tx
          .select({ platformOwned: messageCards.platformOwned })
          .from(messageCards)
          .where(eq(messageCards.messageId, p.run.anchorMessageId))
          .limit(1);
        if (card?.platformOwned) {
          await updatePlatformCardNotified(tx, core, {
            messageId: p.run.anchorMessageId,
            status: "succeeded",
            statusLabel: fanOutLabel(runCount),
          });
        }
      }
      await core.audit.record(tx, {
        ...p.auditBase,
        action: "automation.conversation_opened",
        resourceType: "automation_run",
        resourceId: p.run.id,
        actorKind: "agent",
        actorId: p.turn.agentId,
        agentId: p.turn.agentId,
        userId: a.runAsUserId,
        // Ids and counts only (PD-17): never a key (clear or hashed), a title or a body.
        metadata: {
          automationId: a.id,
          runId: p.run.id,
          eventId: p.turn.eventId,
          opened,
          existing,
          refused,
          outsideContent: p.turn.tainted,
        },
      });

      return {
        ok: true,
        results,
        remainingRun: Math.max(0, Math.min(a.fanOutPerRun - runCount, a.fanOutPerDay - dayCount)),
        remainingDay: Math.max(0, a.fanOutPerDay - dayCount),
      };
    },
  };
}

/** Items delivered at once per API process (PD-09): each is one bot turn, so a burst of opens is spread out. */
const ITEM_CONCURRENCY = 3;

/**
 * Phase 07.17 (D-04, PD-09; E11): the event id of an opened item's own turn, derived from the item (a UUID of version 8,
 * RFC 9562 custom, from SHA-256: the 07.16 wake construction), so a retried or concurrent job can never deliver a second
 * turn (`agent_turns.event_id` is the turn's key). 07.17 code review WR-02: an item queued again after waiting is a new
 * turn, so each later attempt has its own id (`attempt` 0 keeps the first construction).
 */
export function itemEventId(itemId: string, attempt = 0): string {
  const h = createHash("sha256")
    .update(attempt === 0 ? `automation_item:${itemId}` : `automation_item:${itemId}:${attempt}`)
    .digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x80;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/**
 * One `automation.item` job (D-04, PD-09): ids only. The item's automation is found with no user (RLS keeps it to the
 * job's organization, so a forged job naming another organization's item, or a deleted one, finds nothing, E8), then
 * the item is delivered in one transaction as the automation's run-as person (`deliverAutomationItem`: the checks, the
 * skips and the turn). A refusal thrown by chat or the resolver is the item's real outcome and becomes a skip with its
 * reason; anything else (a deadlock, a dropped connection) is retried by pg-boss, and the derived event id keeps the
 * retry from making a second turn. The last attempt (07.17 code review WR-01) marks the item `failed` with
 * `delivery_failed` and audits `automation.item_skipped` (result `error`, ids only), so an item never stays queued
 * forever with no trace.
 */
export async function deliverItemJob(
  core: Core,
  deps: Pick<AutomationSeamDeps, "perms" | "modelGateway" | "memory">,
  data: JobData<"automation.item">,
  attempt?: Pick<JobContext, "retryCount" | "retryLimit">,
): Promise<void> {
  const { organizationId, itemId } = data;
  const head = await core.db.withTenant({ organizationId }, async (tx) => {
    const [r] = await tx
      .select({
        status: automationConversations.status,
        attempt: automationConversations.attempt,
        runAs: automations.runAsUserId,
      })
      .from(automationConversations)
      .innerJoin(automations, eq(automations.id, automationConversations.automationId))
      .where(eq(automationConversations.id, itemId))
      .limit(1);
    return r ?? null;
  });
  if (head?.status !== "queued") return;
  try {
    await core.db.withTenant({ organizationId, userId: head.runAs }, (tx) =>
      deliverAutomationItem(
        tx,
        {
          core,
          perms: deps.perms,
          modelLabel: (ref) => deps.modelGateway.labelOf(ref),
          memory: deps.memory,
          // D-08, PD-15: whom the bot names when done or stuck, re-validated at this delivery.
          escalationFor: (t, a) => escalationFor(t, { core, perms: deps.perms }, a),
        },
        { itemId, eventId: itemEventId(itemId, head.attempt), attempt: head.attempt },
      ),
    );
  } catch (err) {
    // Ids and error names only (P1).
    core.log.warn(
      { itemId, err: { name: (err as Error)?.name, code: (err as { code?: unknown })?.code } },
      "automation item delivery failed",
    );
    if (!isRefusal(err)) {
      if (!lastAttempt(attempt)) throw err;
      await core.db.withTenant({ organizationId, userId: head.runAs }, (tx) =>
        skipAutomationItem(tx, core, itemId, "delivery_failed", "failed"),
      );
      return;
    }
    await core.db.withTenant({ organizationId, userId: head.runAs }, (tx) =>
      skipAutomationItem(tx, core, itemId, refusalReason(err)),
    );
  }
}

/**
 * 07.17 code review WR-02, from the scheduler tick: an item that waited for the bot's daily limit (`agent_daily_limit`)
 * is queued again once its automation's local day has changed (`app.day_waiting_automation_items` gives ids only,
 * bounded per automation by `fan_out_per_day`). Re-checked under the row's lock in the item's organization, of an
 * active automation only. Returns whether it was queued again.
 */
export async function requeueDayWaitingItem(
  core: Core,
  organizationId: string,
  itemId: string,
  now: Date,
): Promise<boolean> {
  return core.db.withTenant({ organizationId, userId: null }, async (tx) => {
    const [row] = await tx
      .select({
        status: automationConversations.status,
        reason: automationConversations.reason,
        updatedAt: automationConversations.updatedAt,
        automationStatus: automations.status,
        timeZone: automations.timeZone,
      })
      .from(automationConversations)
      .innerJoin(automations, eq(automations.id, automationConversations.automationId))
      .where(eq(automationConversations.id, itemId))
      .limit(1)
      .for("update", { of: automationConversations });
    if (
      row?.status !== "waiting" ||
      row.reason !== "agent_daily_limit" ||
      row.automationStatus !== "active"
    ) {
      return false;
    }
    if (new Date(row.updatedAt).getTime() >= localDayStart(now, row.timeZone ?? "UTC").getTime())
      return false;
    return requeueAutomationItem(tx, core, itemId);
  });
}

/**
 * Wires the `automation.item` worker once (from the module index, before `core.jobs` starts). Workers run only with
 * `OCW_JOBS_WORKER=on`; tests drive `core.jobs.drain("automation.item")`.
 */
export function registerFanOutWorker(core: Core, deps: AutomationSeamDeps): void {
  core.jobs.work("automation.item", (data, ctx) => deliverItemJob(core, deps, data, ctx), {
    localConcurrency: ITEM_CONCURRENCY,
  });
}
