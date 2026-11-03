import {
  AUTOMATION_LIMITS,
  type AutomationRunReason,
  type AutomationRunStatus,
  EventTypes,
} from "@ocw/contracts";
import { automationRuns, automations, orgMembers, type Tx } from "@ocw/db";
import { and, count, eq, gte, ne, sql } from "drizzle-orm";
import type { Core } from "../../core";
import type { PermissionService } from "../organization";
import { canCreate, canWebhook, decideTarget, type TargetCode } from "./access";
import type { AutomationRow, RunRow } from "./actions";
import { targetOf } from "./service";

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

const PARTS = (timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/** The zone's offset from UTC at `at`, in milliseconds (positive east of Greenwich). */
function offsetMs(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    PARTS(timeZone)
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant the local day of `now` began in `timeZone` (the automation's day: a run at 23:30 in Madrid counts for
 * that Madrid day). The offset at midnight is used, so a DST change later that day does not move the start.
 */
export function localDayStart(now: Date, timeZone: string): Date {
  const off = offsetMs(now, timeZone);
  const local = new Date(now.getTime() + off);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const atMidnight = offsetMs(new Date(midnight - off), timeZone);
  return new Date(midnight - atMidnight);
}

/** Runs of `a` that count against its daily budget today (in its zone): every run but skipped ones and `exceptRunId`. */
export async function runsToday(tx: Tx, a: AutomationRow, now: Date, exceptRunId?: string): Promise<number> {
  const since = localDayStart(now, a.timeZone ?? "UTC").toISOString();
  const [r] = await tx
    .select({ n: count() })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.automationId, a.id),
        ne(automationRuns.status, "skipped"),
        gte(automationRuns.createdAt, since),
        exceptRunId ? ne(automationRuns.id, exceptRunId) : undefined,
      ),
    );
  return Number(r?.n ?? 0);
}

const TARGET_REASONS: Record<TargetCode, AutomationRunReason> = {
  agent_not_member: "agent_not_member",
  target_not_postable: "target_not_postable",
  // A personal bot's automation may only reach its owner's DM; anything else cannot be posted.
  personal_bot_target: "target_not_postable",
  bot_not_readable: "bot_not_readable",
  // Disabled or deleted: the bot is off either way.
  agent_unavailable: "agent_disabled",
};

export type FireDecision = { ok: true } | { ok: false; reason: AutomationRunReason };

/**
 * Whether `run` of `a` may fire now, decided again at every fire (D-07, P-09; T-07.6-09-01, -02). Called inside the
 * fire transaction, opened as the run-as person, with the run and the automation rows locked. In order:
 * 1. the automation is still active (a paused or needs-attention automation skips its queued runs: `paused`);
 * 2. the run-as person is still an active member and still holds `automation.create`, and `automation.webhook` for a
 *    webhook automation (`run_as_not_allowed`);
 * 3. the target, for the person and the bot together (`decideTarget`, the save-time decision run again): the bot is
 *    live (`agent_disabled`) and the person may see it (`bot_not_readable`); a personal bot only to its owner's DM; the
 *    conversation is a live channel the person reads and may post in, the bot is a member (`agent_not_member`) and may
 *    post there, the bot acting for the person may read it; the board column and the thread root still exist
 *    (`target_not_postable` otherwise);
 * 4. the automation's own daily budget in its zone (`runs_per_day`), counted under its row lock.
 * The bot's daily limit is decided by the delivery itself (`turnPolicy` meters the turn: `agent_daily_limit`).
 */
export async function decideFire(
  tx: Tx,
  perms: PermissionService,
  a: AutomationRow,
  run: RunRow,
  now: Date,
): Promise<FireDecision> {
  const access = await decideAccess(tx, perms, a);
  if (!access.ok) return access;
  if ((await runsToday(tx, a, now, run.id)) >= a.maxRunsPerDay) return { ok: false, reason: "runs_per_day" };
  return { ok: true };
}

/**
 * Steps 1 to 3 of `decideFire` (active, run-as person, target), without the daily run budget: what an inbound item
 * needs before the platform posts it (07.6-21; its own budget is the hourly inbound cap, and the bot's turn after it
 * goes through `decideFire` like any run).
 */
export async function decideAccess(
  tx: Tx,
  perms: PermissionService,
  a: AutomationRow,
): Promise<FireDecision> {
  if (a.status !== "active") return { ok: false, reason: "paused" };
  const [member] = await tx
    .select({ deactivatedAt: orgMembers.deactivatedAt })
    .from(orgMembers)
    .where(eq(orgMembers.userId, a.runAsUserId))
    .limit(1);
  if (!member || member.deactivatedAt) return { ok: false, reason: "run_as_not_allowed" };
  if (!(await canCreate(perms, tx, { userId: a.runAsUserId })))
    return { ok: false, reason: "run_as_not_allowed" };
  // D-07: only leads and admins hold webhook endpoints, and that is decided again for every delivery and run, so a
  // person who lost the right (demoted, or a unit rule) has no live public URL posting as the bot (07.6 review A MD-05).
  if (a.triggerKind === "webhook" && !(await canWebhook(perms, tx, { userId: a.runAsUserId })))
    return { ok: false, reason: "run_as_not_allowed" };
  const target = await decideTarget(tx, perms, {
    agentId: a.agentId,
    userId: a.runAsUserId,
    target: targetOf(a),
  });
  if (!target.ok) return { ok: false, reason: TARGET_REASONS[target.code] };
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
