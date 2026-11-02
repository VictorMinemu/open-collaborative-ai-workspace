import {
  AUTOMATION_LIMITS,
  type AutomationRunReason,
  type AutomationRunStatus,
  EventTypes,
} from "@ocw/contracts";
import { agents, automations, type Tx } from "@ocw/db";
import { and, eq, sql } from "drizzle-orm";
import type { Core } from "../../core";
import type { PermissionService } from "../organization";
import type { AutomationRow, RunRow } from "./actions";

/**
 * The fire-time decision and the budgets of an automation run (07.6-09; D-07, P-09, Pitfall 1). Nothing decided when the
 * automation was saved is trusted at fire: every run re-decides, in its own transaction as the run-as person and under
 * the automation's row lock, that it may still run (`decideFire`), and every run's outcome feeds the breaker
 * (`recordOutcome`): three failed or unanswered runs in a row pause the automation as `needs_attention`.
 */

/** The breaker's view of one run: a failure counts, a success resets, a budget or timing skip leaves the streak. */
export type RunOutcome = "success" | "failure" | "neutral";

/**
 * Skips that mean the automation cannot run as it is set up (lost access, a bot turned off): they never heal on their
 * own, so they count like a failed run. Budget and timing skips (`runs_per_day`, `hourly_cap`, `missed`, `paused`) do
 * not: the automation is working, it was only held back.
 */
const ACCESS_REASONS: ReadonlySet<AutomationRunReason> = new Set<AutomationRunReason>([
  "agent_not_member",
  "target_not_postable",
  "agent_disabled",
  "run_as_not_allowed",
  "bot_not_readable",
  "delivery_failed",
]);

export function outcomeOf(status: AutomationRunStatus, reason: AutomationRunReason | null): RunOutcome {
  if (status === "answered") return "success";
  if (status === "failed" || status === "no_reply") return "failure";
  if (status === "skipped" && reason && ACCESS_REASONS.has(reason)) return "failure";
  return "neutral";
}

/** One step of the breaker: the new streak and whether this step pauses the automation. */
export function breakerStep(
  consecutive: number,
  outcome: RunOutcome,
): { consecutive: number; trip: boolean } {
  if (outcome === "success") return { consecutive: 0, trip: false };
  if (outcome === "neutral") return { consecutive, trip: false };
  const next = consecutive + 1;
  return { consecutive: next, trip: next === AUTOMATION_LIMITS.breakerFailures };
}

export type FireDecision = { ok: true } | { ok: false; reason: AutomationRunReason };

/** Whether `run` of `a` may fire now (07.6-09 Task 1: the automation is active and its bot is live). */
export async function decideFire(
  tx: Tx,
  _perms: PermissionService,
  a: AutomationRow,
  _run: RunRow,
  _now: Date,
): Promise<FireDecision> {
  if (a.status !== "active") return { ok: false, reason: "paused" };
  const [bot] = await tx
    .select({ status: agents.status, deletedAt: agents.deletedAt })
    .from(agents)
    .where(eq(agents.id, a.agentId))
    .limit(1);
  if (!bot || bot.deletedAt || bot.status === "disabled") return { ok: false, reason: "agent_disabled" };
  return { ok: true };
}

/**
 * Feeds one run's outcome to the breaker, in the transaction that settled the run. A failure adds one to the streak; at
 * `AUTOMATION_LIMITS.breakerFailures` an active automation becomes `needs_attention` (paused, `paused_reason` = the
 * last run's reason code, which the UI words), stops being due, is audited `automation.needs_attention` (ids and the
 * code only) and its person hears `automation.updated`. A success resets the streak (`markRunAnswered` does it for an
 * answered run); a neutral skip changes nothing. Resuming (05) resets the streak.
 */
export async function recordOutcome(
  tx: Tx,
  deps: { core: Core },
  a: Pick<AutomationRow, "id" | "runAsUserId" | "agentId">,
  outcome: RunOutcome,
  reason: AutomationRunReason | null = null,
): Promise<{ tripped: boolean }> {
  if (outcome === "neutral") return { tripped: false };
  if (outcome === "success") {
    await tx.update(automations).set({ consecutiveFailures: 0 }).where(eq(automations.id, a.id));
    return { tripped: false };
  }
  const [after] = await tx
    .update(automations)
    .set({ consecutiveFailures: sql`${automations.consecutiveFailures} + 1` })
    .where(eq(automations.id, a.id))
    .returning({ consecutiveFailures: automations.consecutiveFailures, status: automations.status });
  if (after?.status !== "active") return { tripped: false };
  if (after.consecutiveFailures < AUTOMATION_LIMITS.breakerFailures) return { tripped: false };
  const [paused] = await tx
    .update(automations)
    .set({
      status: "needs_attention",
      pausedBy: null,
      pausedAt: sql`now()`,
      pausedReason: reason,
      version: sql`${automations.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(automations.id, a.id), eq(automations.status, "active")))
    .returning({ id: automations.id });
  if (!paused) return { tripped: false };
  await deps.core.audit.record(tx, {
    action: "automation.needs_attention",
    resourceType: "automation",
    resourceId: a.id,
    actorKind: "system",
    userId: a.runAsUserId,
    agentId: a.agentId,
    metadata: {
      automationId: a.id,
      runAsUserId: a.runAsUserId,
      failures: after.consecutiveFailures,
      reason,
    },
  });
  await deps.core.realtime.appendEvent(tx, `user:${a.runAsUserId}`, EventTypes.automationUpdated, {
    automationId: a.id,
  });
  return { tripped: true };
}
