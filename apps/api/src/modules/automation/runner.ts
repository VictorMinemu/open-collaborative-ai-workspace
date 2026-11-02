import { AUTOMATION_LIMITS, type AutomationRunReason, EventTypes } from "@ocw/contracts";
import { automationRuns, automations, messageCards, type Tx } from "@ocw/db";
import { and, eq, sql } from "drizzle-orm";
import type { Core } from "../../core";
import type { JobData } from "../../lib/jobs";
import { deliverAutomationRun, updatePlatformCardNotified } from "../agent-channel";
import type { ActionKindHandler, AutomationRow, AutomationSeamDeps, FireResult, RunRow } from "./actions";
import { decideFire, outcomeOf, recordOutcome } from "./budget";
import { inboundDelivery } from "./inbound";
import { missedPolicy, nextRunAfter } from "./schedule";
import { postAnchor, reasonSentence, refusalReason, runCardFields, runPeople } from "./targets";

/**
 * The runner (07.6-09; AUTO-01, D-01, D-03, D-07, D-12, P-07, P-09; Pitfalls 1 and 6). Scheduled automations run
 * outside the cell, on `core.jobs`:
 *
 * - `automation.tick` (every minute, once across replicas): `app.due_automations` gives ids only; each due automation is
 *   handled in its own organization's transaction under its row lock: re-checked (still active, still due), a missed
 *   instant older than 6 hours is recorded `skipped`/`missed`, a newer one becomes one `queued` run (unique per
 *   scheduled instant), `next_run_at` advances in the automation's zone past now (no catch-up burst), and one ids-only
 *   `automation.fire` job is enqueued in that same transaction. The same tick turns runs still unanswered after 15
 *   minutes (`app.stale_automation_runs`) into `no_reply`.
 * - `automation.fire` (one job per run, scheduled or Run now): opens the run-as person's transaction, locks the run
 *   (a run that is no longer `queued` is a no-op, so a retried job never posts twice), re-decides everything
 *   (`decideFire`), then runs the action kind (`agent_turn`: the run card, then 06's `deliverAutomationRun`, whose turn
 *   is unattended: sandbox under 07.8's limits, never a browser). A skip posts nothing.
 *
 * Every settled run is audited with ids and codes only, its person hears `automation_run.updated`, and its outcome feeds
 * the breaker.
 */

/** How many due automations and stale runs one tick handles (the rest wait for the next minute). */
const TICK_BATCH = 500;
const NO_REPLY_MS = AUTOMATION_LIMITS.noReplyMinutes * 60_000;

export interface TickResult {
  /** Runs queued (fire jobs enqueued). */
  fired: number;
  /** Missed instants recorded as skipped. */
  skipped: number;
  /** Delivered runs turned `no_reply`. */
  noReply: number;
}

async function announceRun(core: Core, tx: Tx, a: Pick<AutomationRow, "id" | "runAsUserId">, runId: string) {
  await core.realtime.appendEvent(tx, `user:${a.runAsUserId}`, EventTypes.automationRunUpdated, {
    automationId: a.id,
    runId,
  });
}

/**
 * One due automation, in its organization's transaction (no person: the tick acts for nobody, and reads nothing but
 * this row and its runs). Returns what it did.
 */
async function tickAutomation(
  core: Core,
  organizationId: string,
  automationId: string,
  now: Date,
): Promise<"fired" | "skipped" | null> {
  return core.db.withTenant({ organizationId }, async (tx) => {
    // Serialises with a concurrent tick (another replica), a save, a pause and Run now on the same automation.
    const [a] = await tx.select().from(automations).where(eq(automations.id, automationId)).for("update");
    if (a?.status !== "active" || a.triggerKind !== "schedule" || !a.nextRunAt) return null;
    const scheduledFor = new Date(a.nextRunAt);
    if (scheduledFor.getTime() > now.getTime()) return null; // Another tick already advanced it.
    const schedule = { cron: a.scheduleCron as string, timeZone: a.timeZone as string };
    // The grid is kept (next from the scheduled instant, never from now); a late tick jumps past now once.
    let next = nextRunAfter(schedule, scheduledFor);
    if (next.getTime() <= now.getTime()) next = nextRunAfter(schedule, now);
    await tx
      .update(automations)
      .set({ nextRunAt: next.toISOString(), updatedAt: sql`now()` })
      .where(eq(automations.id, a.id));

    const missed = missedPolicy(scheduledFor, now) === "skip";
    const [run] = await tx
      .insert(automationRuns)
      .values({
        organizationId,
        automationId: a.id,
        trigger: "schedule",
        scheduledFor: scheduledFor.toISOString(),
        status: missed ? "skipped" : "queued",
        reason: missed ? "missed" : null,
      })
      .onConflictDoNothing()
      .returning({ id: automationRuns.id });
    if (!run) return null; // This instant already has its run (unique per scheduled instant).

    const meta = {
      automationId: a.id,
      runId: run.id,
      trigger: "schedule",
      scheduledFor: scheduledFor.toISOString(),
    };
    if (missed) {
      await core.audit.record(tx, {
        action: "automation.run_skipped",
        resourceType: "automation_run",
        resourceId: run.id,
        actorKind: "system",
        userId: a.runAsUserId,
        agentId: a.agentId,
        metadata: { ...meta, reason: "missed" },
      });
    } else {
      // Ids only (Pitfall 7); the job exists only if this transaction commits.
      await core.jobs.sendInTx(tx, "automation.fire", { organizationId, runId: run.id });
      await core.audit.record(tx, {
        action: "automation.run_started",
        resourceType: "automation_run",
        resourceId: run.id,
        actorKind: "system",
        userId: a.runAsUserId,
        agentId: a.agentId,
        metadata: meta,
      });
    }
    await announceRun(core, tx, a, run.id);
    return missed ? "skipped" : "fired";
  });
}

/**
 * A delivered run nobody answered within 15 minutes: `no_reply`, its card says so (neutral notice), its person hears
 * it, it is audited, and it counts toward the breaker. Re-checked under the run's lock (an answer may have just landed).
 */
async function markNoReply(
  core: Core,
  organizationId: string,
  runId: string,
  before: Date,
): Promise<boolean> {
  return core.db.withTenant({ organizationId }, async (tx) => {
    const [run] = await tx.select().from(automationRuns).where(eq(automationRuns.id, runId)).for("update");
    if (run?.status !== "delivered" || !run.deliveredAt) return false;
    if (new Date(run.deliveredAt).getTime() >= before.getTime()) return false;
    const [a] = await tx.select().from(automations).where(eq(automations.id, run.automationId)).limit(1);
    if (!a) return false;
    await tx
      .update(automationRuns)
      .set({ status: "no_reply", reason: "no_reply", updatedAt: sql`now()` })
      .where(eq(automationRuns.id, run.id));
    if (run.anchorMessageId) {
      const people = await runPeople(tx, a);
      await settleCard(
        core,
        tx,
        run.anchorMessageId,
        "No reply",
        "no_reply",
        people.bot,
        people.conversation,
        a,
      );
    }
    await core.audit.record(tx, {
      action: "automation.run_no_reply",
      resourceType: "automation_run",
      resourceId: run.id,
      actorKind: "system",
      userId: a.runAsUserId,
      agentId: a.agentId,
      metadata: { automationId: a.id, runId: run.id, agentId: a.agentId, reason: "no_reply" },
    });
    await announceRun(core, tx, a, run.id);
    await recordOutcome(tx, { core }, a, "failure", "no_reply");
    return true;
  });
}

/** The run card's closing state: `failed` with its label and the reason sentence as a neutral notice. */
async function settleCard(
  core: Core,
  tx: Tx,
  anchorMessageId: string,
  label: string,
  reason: AutomationRunReason,
  bot: string,
  conversation: string | null,
  a: Pick<AutomationRow, "maxRunsPerDay">,
) {
  const [card] = await tx
    .select({ platformOwned: messageCards.platformOwned, notices: messageCards.notices })
    .from(messageCards)
    .where(eq(messageCards.messageId, anchorMessageId))
    .limit(1);
  if (!card?.platformOwned) return;
  const notice = {
    tone: "neutral" as const,
    text: reasonSentence(reason, { bot, conversation, maxRunsPerDay: a.maxRunsPerDay }),
  };
  // An outside-content warning stays first (UI-SPEC: the amber notice is always first).
  const kept = ((card.notices ?? []) as Array<{ tone: "warning" | "neutral"; text: string }>).filter(
    (n) => n.tone === "warning",
  );
  await updatePlatformCardNotified(tx, core, {
    messageId: anchorMessageId,
    status: "failed",
    statusLabel: label,
    notices: [...kept, notice].slice(0, 3),
  });
}

/**
 * One minute of the scheduler: every due automation (ids only, `app.due_automations`), then the no-reply sweep
 * (`app.stale_automation_runs`). Safe to run on several replicas at once and twice in the same minute: the row lock and
 * the re-check leave one run per scheduled instant. A failure on one automation is logged and never stops the others.
 */
export async function tickOnce(core: Core, now: Date = new Date()): Promise<TickResult> {
  const out: TickResult = { fired: 0, skipped: 0, noReply: 0 };
  const due = await core.db.pool.query<{ id: string; organization_id: string }>(
    "select id, organization_id from app.due_automations($1, $2)",
    [TICK_BATCH, now.toISOString()],
  );
  for (const row of due.rows) {
    try {
      const did = await tickAutomation(core, row.organization_id, row.id, now);
      if (did === "fired") out.fired++;
      else if (did === "skipped") out.skipped++;
    } catch (err) {
      core.log.warn(
        { automationId: row.id, err: { name: (err as Error)?.name, message: (err as Error)?.message } },
        "automation tick failed",
      );
    }
  }
  const before = new Date(now.getTime() - NO_REPLY_MS);
  const stale = await core.db.pool.query<{ id: string; organization_id: string }>(
    "select id, organization_id from app.stale_automation_runs($1, $2)",
    [TICK_BATCH, before.toISOString()],
  );
  for (const row of stale.rows) {
    try {
      if (await markNoReply(core, row.organization_id, row.id, before)) out.noReply++;
    } catch (err) {
      core.log.warn(
        { runId: row.id, err: { name: (err as Error)?.name, message: (err as Error)?.message } },
        "automation no-reply sweep failed",
      );
    }
  }
  return out;
}

/**
 * Settles a run that did not reach the cell: `skipped` (decided before anything was posted: no card) or `failed` (the
 * card was posted; it now says Failed with the reason). Audited with ids and the code, announced, fed to the breaker.
 */
async function settleRun(
  core: Core,
  tx: Tx,
  a: AutomationRow,
  run: RunRow,
  result: { status: "skipped" | "failed"; reason: AutomationRunReason; anchorMessageId?: string },
) {
  await tx
    .update(automationRuns)
    .set({
      status: result.status,
      reason: result.reason,
      ...(result.anchorMessageId
        ? {
            anchorMessageId: sql`coalesce(${automationRuns.anchorMessageId}, ${result.anchorMessageId}::uuid)`,
          }
        : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(automationRuns.id, run.id), eq(automationRuns.status, "queued")));
  if (result.status === "failed" && result.anchorMessageId) {
    const people = await runPeople(tx, a);
    await settleCard(
      core,
      tx,
      result.anchorMessageId,
      "Failed",
      result.reason,
      people.bot,
      people.conversation,
      a,
    );
  }
  await core.audit.record(tx, {
    action: result.status === "skipped" ? "automation.run_skipped" : "automation.run_failed",
    resourceType: "automation_run",
    resourceId: run.id,
    actorKind: "system",
    userId: a.runAsUserId,
    agentId: a.agentId,
    metadata: { automationId: a.id, runId: run.id, trigger: run.trigger, reason: result.reason },
  });
  await announceRun(core, tx, a, run.id);
  await recordOutcome(tx, { core }, a, outcomeOf(result.status, result.reason), result.reason);
}

/**
 * Fires one run (the `automation.fire` job): re-decides it as its person, then runs its action kind. Idempotent: a run
 * that is not `queued` any more (already fired, skipped, or gone with its automation) is left as it is. Only ids come
 * in, and every read is the job organization's (`withTenant`): a forged cross-tenant id finds nothing.
 */
export async function fireRun(
  core: Core,
  deps: AutomationSeamDeps,
  data: JobData<"automation.fire">,
  now: Date = new Date(),
): Promise<void> {
  const { organizationId, runId } = data;
  const head = await core.db.withTenant({ organizationId }, async (tx) => {
    const [r] = await tx
      .select({ status: automationRuns.status, runAs: automations.runAsUserId })
      .from(automationRuns)
      .innerJoin(automations, eq(automations.id, automationRuns.automationId))
      .where(eq(automationRuns.id, runId))
      .limit(1);
    return r ?? null;
  });
  if (head?.status !== "queued") return;

  try {
    await core.db.withTenant({ organizationId, userId: head.runAs }, async (tx) => {
      // Run first, then its automation: the order of every other writer of both rows (the reply, the no-reply sweep).
      const [run] = await tx.select().from(automationRuns).where(eq(automationRuns.id, runId)).for("update");
      if (run?.status !== "queued") return;
      const [a] = await tx
        .select()
        .from(automations)
        .where(eq(automations.id, run.automationId))
        .for("update");
      if (!a) return;
      const decision = await decideFire(tx, deps.perms, a, run, now);
      if (!decision.ok) {
        await settleRun(core, tx, a, run, { status: "skipped", reason: decision.reason });
        return;
      }
      await tx.update(automations).set({ lastRunAt: sql`now()` }).where(eq(automations.id, a.id));
      const handler = deps.service.actionKind(a.actionKind);
      const result: FireResult = handler
        ? await handler.fire(tx, { run, automation: a })
        : { status: "failed", reason: "delivery_failed" };
      if (result.status === "skipped" || result.status === "failed") {
        await settleRun(core, tx, a, run, result);
      }
    });
  } catch (err) {
    // The post itself was refused (chat's own checks, decided again in the post) or failed: nothing of that transaction
    // stays. The run is settled as failed in a fresh transaction so it does not wait forever; if even that fails (the
    // database is down) the job is retried, and fires only while the run is still queued.
    core.log.warn(
      { runId, err: { name: (err as Error)?.name, code: (err as { code?: unknown })?.code } },
      "automation fire failed",
    );
    await core.db.withTenant({ organizationId, userId: head.runAs }, async (tx) => {
      const [run] = await tx.select().from(automationRuns).where(eq(automationRuns.id, runId)).for("update");
      if (run?.status !== "queued") return;
      const [a] = await tx
        .select()
        .from(automations)
        .where(eq(automations.id, run.automationId))
        .for("update");
      if (!a) return;
      await settleRun(core, tx, a, run, { status: "failed", reason: refusalReason(err) });
    });
  }
}

/**
 * The built-in `agent_turn` action (D-01, D-03, D-12): the run card at the target, then the run delivered to the cell as
 * the bot's turn for the person (06's primitive: unattended, so the turn has the sandbox under 07.8's decision and
 * 40-call cap and never a browser; the person pays, the bot's daily limit applies). The runner never builds a turn or a
 * tool list itself. A delivery refused after the card was posted fails the run, and the card says why.
 */
export function agentTurnAction(core: Core, deps: AutomationSeamDeps): ActionKindHandler {
  return {
    async fire(tx, { run, automation: a }) {
      // A webhook or mail run (07.6-21): its anchor is the inbound card the platform already posted, and its turn is
      // tainted from the first call with the item only in `automationRun.inbound`. Without its item it never runs.
      const inbound =
        run.trigger === "webhook" || run.trigger === "mail" ? await inboundDelivery(tx, a, run) : null;
      if ((run.trigger === "webhook" || run.trigger === "mail") && !inbound) {
        return { status: "failed", reason: "target_not_postable" };
      }
      const anchor =
        inbound?.anchor ??
        (await postAnchor(
          tx,
          { core, perms: deps.perms },
          a,
          run,
          runCardFields(a, run, await runPeople(tx, a)),
        ));
      const out = await deliverAutomationRun(
        tx,
        {
          core,
          perms: deps.perms,
          modelLabel: (ref) => deps.modelGateway.labelOf(ref),
          memory: deps.memory,
        },
        {
          runId: run.id,
          agentId: a.agentId,
          runAsUserId: a.runAsUserId,
          anchorMessageId: anchor.anchorMessageId,
          conversationId: anchor.conversationId,
          threadRootId: anchor.threadRootId,
          delivery: anchor.delivery,
          automation: { id: a.id, name: a.name, instructions: a.instructions },
          trigger: run.trigger,
          inbound: inbound?.inbound ?? null,
          taintedAtStart: inbound?.taintedAtStart ?? false,
          timeZone: a.timeZone,
        },
      );
      if (!out.delivered)
        return { status: "failed", reason: out.reason, anchorMessageId: anchor.anchorMessageId };
      return { status: "delivered", anchorMessageId: anchor.anchorMessageId };
    },
  };
}

/**
 * Wires the runner once (from the module index, before `core.jobs` starts): the `agent_turn` action kind, the
 * one-minute tick (UTC cron, evaluated once across replicas) and the two workers. Workers run only with
 * `OCW_JOBS_WORKER=on`; tests drive `tickOnce` and `core.jobs.drain("automation.fire")`.
 */
export function registerRunner(core: Core, deps: AutomationSeamDeps): void {
  deps.service.registerActionKind("agent_turn", agentTurnAction(core, deps));
  core.jobs.schedule("automation.tick", "* * * * *");
  core.jobs.work("automation.tick", async () => {
    const out = await tickOnce(core);
    if (out.fired + out.skipped + out.noReply > 0) core.log.info(out, "automation tick");
  });
  core.jobs.work("automation.fire", (data) => fireRun(core, deps, data));
}
