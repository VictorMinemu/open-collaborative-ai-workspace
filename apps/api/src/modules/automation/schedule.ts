import { AUTOMATION_LIMITS, type AutomationSchedule, isKnownTimeZone } from "@ocw/contracts";
import { CronExpressionParser } from "cron-parser";

/**
 * Schedule math of automations (P-07, Pitfall 5, A4). One code path for save, preview and the runner: cron-parser in the
 * automation's IANA zone, every next instant computed from the previous *scheduled* instant (never from "now" when a
 * run was late), so a late tick never drifts and never fires the same instant twice.
 *
 * DST semantics (pinned by schedule.test.ts against cron-parser 5.10.2, not hand-corrected):
 * - a local time inside a spring-forward gap (02:30 on 2026-03-29 in Europe/Madrid) runs once, one hour later in wall
 *   time (03:30 CEST, the same absolute offset from midnight); the day is not skipped;
 * - a local time inside a fall-back overlap (02:30 on 2026-10-25 in Europe/Madrid) runs once, at its first occurrence
 *   (CEST).
 */

export type ScheduleCode = "invalid_cron" | "invalid_time_zone" | "schedule_too_frequent";
export type ScheduleCheck = { ok: true } | { ok: false; code: ScheduleCode };

/** How many upcoming instants the minimum-interval check looks at (two of them closer than the minimum = too often). */
const FREQUENCY_WINDOW = 10;

/** When a scheduled instant was missed (the server was down), it still fires up to this long after it. */
const MISSED_MAX_MS = AUTOMATION_LIMITS.missedMaxHours * 3_600_000;

function parse(s: AutomationSchedule, currentDate: Date) {
  return CronExpressionParser.parse(s.cron, { tz: s.timeZone, currentDate, strict: false });
}

/**
 * Whether the schedule is a valid five-field cron in a known zone that fires no more often than every `minMinutes`
 * (any two of its next instants closer than that = `schedule_too_frequent`).
 */
export function validateSchedule(
  s: AutomationSchedule,
  minMinutes: number,
  now: Date = new Date(),
): ScheduleCheck {
  if (!isKnownTimeZone(s.timeZone)) return { ok: false, code: "invalid_time_zone" };
  if (s.cron.trim().split(/\s+/).length !== 5) return { ok: false, code: "invalid_cron" };
  let instants: Date[];
  try {
    instants = nextRuns(s, now, FREQUENCY_WINDOW);
  } catch {
    return { ok: false, code: "invalid_cron" };
  }
  if (instants.length === 0) return { ok: false, code: "invalid_cron" };
  const minMs = minMinutes * 60_000;
  for (let i = 1; i < instants.length; i++) {
    if (instants[i]!.getTime() - instants[i - 1]!.getTime() < minMs) {
      return { ok: false, code: "schedule_too_frequent" };
    }
  }
  return { ok: true };
}

/** The first instant strictly after `after`, in the schedule's zone. */
export function nextRunAfter(s: AutomationSchedule, after: Date): Date {
  return parse(s, after).next().toDate();
}

/** The next `n` instants strictly after `from`. */
export function nextRuns(s: AutomationSchedule, from: Date, n = 3): Date[] {
  const it = parse(s, from);
  const out: Date[] = [];
  for (let i = 0; i < n; i++) {
    if (!it.hasNext()) break;
    out.push(it.next().toDate());
  }
  return out;
}

/** The first run of a new (or resumed, or rescheduled) automation: the next instant after now. */
export function firstRunAt(s: AutomationSchedule, now: Date = new Date()): Date {
  return nextRunAfter(s, now);
}

/** A due instant fires when it is at most 6 hours old; an older one is recorded as `skipped` (`missed`). */
export function missedPolicy(scheduledFor: Date, now: Date): "fire" | "skip" {
  return now.getTime() - scheduledFor.getTime() <= MISSED_MAX_MS ? "fire" : "skip";
}
