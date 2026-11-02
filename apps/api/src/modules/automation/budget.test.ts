import { AUTOMATION_LIMITS } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { breakerStep, localDayStart, outcomeOf } from "./budget";

/**
 * 07.6-09 (D-07, P-09, Pitfall 1): the pure parts of the budget. "Today" is the automation's own day in its zone, and
 * the breaker pauses an automation at its third failure in a row and forgets the streak on a success.
 */

const iso = (d: Date) => d.toISOString();

describe("localDayStart: today in the automation's zone", () => {
  it("a run at 23:30 in Madrid counts for that local day, not the next UTC day", () => {
    // 2026-10-09 23:30 CEST = 21:30Z: the Madrid day began at 2026-10-08T22:00Z.
    expect(iso(localDayStart(new Date("2026-10-09T21:30:00Z"), "Europe/Madrid"))).toBe(
      "2026-10-08T22:00:00.000Z",
    );
    // 00:30 the next local day (22:30Z, still Oct 9 in UTC) starts a new Madrid day.
    expect(iso(localDayStart(new Date("2026-10-09T22:30:00Z"), "Europe/Madrid"))).toBe(
      "2026-10-09T22:00:00.000Z",
    );
  });

  it("follows the zone's offset on each side of a DST change", () => {
    // Madrid, winter (CET, +01:00).
    expect(iso(localDayStart(new Date("2026-12-01T10:00:00Z"), "Europe/Madrid"))).toBe(
      "2026-11-30T23:00:00.000Z",
    );
    // The fall-back day (2026-10-25): midnight was still CEST (+02:00), noon is CET.
    expect(iso(localDayStart(new Date("2026-10-25T12:00:00Z"), "Europe/Madrid"))).toBe(
      "2026-10-24T22:00:00.000Z",
    );
    // Sydney (+11:00 in October, AEDT).
    expect(iso(localDayStart(new Date("2026-10-09T15:00:00Z"), "Australia/Sydney"))).toBe(
      "2026-10-09T13:00:00.000Z",
    );
  });

  it("UTC (webhook and mail automations have no zone) is the plain UTC day", () => {
    expect(iso(localDayStart(new Date("2026-10-09T23:59:59Z"), "UTC"))).toBe("2026-10-09T00:00:00.000Z");
  });
});

describe("the breaker (three failed or unanswered runs in a row → needs attention)", () => {
  it("trips at the third consecutive failure", () => {
    let consecutive = 0;
    const trips: boolean[] = [];
    for (let i = 0; i < AUTOMATION_LIMITS.breakerFailures; i++) {
      const step = breakerStep(consecutive, "failure");
      consecutive = step.consecutive;
      trips.push(step.trip);
    }
    expect(trips).toEqual([false, false, true]);
    expect(consecutive).toBe(3);
  });

  it("a success resets the streak; a budget skip leaves it as it is", () => {
    expect(breakerStep(2, "success")).toEqual({ consecutive: 0, trip: false });
    expect(breakerStep(2, "neutral")).toEqual({ consecutive: 2, trip: false });
    expect(breakerStep(breakerStep(2, "success").consecutive, "failure")).toEqual({
      consecutive: 1,
      trip: false,
    });
  });

  it("failed and unanswered runs and lost access count; budgets, missed and paused runs do not", () => {
    expect(outcomeOf("failed", "agent_daily_limit")).toBe("failure");
    expect(outcomeOf("no_reply", "no_reply")).toBe("failure");
    expect(outcomeOf("skipped", "agent_not_member")).toBe("failure");
    expect(outcomeOf("skipped", "target_not_postable")).toBe("failure");
    expect(outcomeOf("skipped", "run_as_not_allowed")).toBe("failure");
    expect(outcomeOf("skipped", "agent_disabled")).toBe("failure");
    expect(outcomeOf("skipped", "bot_not_readable")).toBe("failure");
    expect(outcomeOf("skipped", "runs_per_day")).toBe("neutral");
    expect(outcomeOf("skipped", "missed")).toBe("neutral");
    expect(outcomeOf("skipped", "paused")).toBe("neutral");
    expect(outcomeOf("skipped", "hourly_cap")).toBe("neutral");
    expect(outcomeOf("answered", null)).toBe("success");
  });
});
