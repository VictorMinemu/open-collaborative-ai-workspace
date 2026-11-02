import { describe, expect, it } from "vitest";
import { firstRunAt, missedPolicy, nextRunAfter, nextRuns, validateSchedule } from "./schedule";

/**
 * 07.6-05 Task 3 (D-07, P-07, Pitfall 5, A4): the schedule semantics of automations, pinned against cron-parser 5.10.2.
 * The DST cases define the behaviour (they are not a hand-rolled correction): a wall time inside a spring-forward gap
 * runs one hour later that same day; a wall time inside a fall-back overlap runs once, at its first occurrence.
 */

const iso = (dates: Date[]) => dates.map((d) => d.toISOString());
const madrid = (cron: string) => ({ cron, timeZone: "Europe/Madrid" });
const sydney = (cron: string) => ({ cron, timeZone: "Australia/Sydney" });

describe("Europe/Madrid across both 2026 transitions", () => {
  it("2026-03-29 (spring forward, 02:30 does not exist): runs at 03:30 CEST that day, then 02:30 CEST daily", () => {
    expect(iso(nextRuns(madrid("30 2 * * *"), new Date("2026-03-28T12:00:00Z"), 4))).toEqual([
      // 03:30 CEST (+02:00) on 2026-03-29: the gap shifts the run forward one hour, the day is not skipped.
      "2026-03-29T01:30:00.000Z",
      "2026-03-30T00:30:00.000Z",
      "2026-03-31T00:30:00.000Z",
      "2026-04-01T00:30:00.000Z",
    ]);
  });

  it("2026-10-25 (fall back, 02:30 happens twice): exactly one run that day, at the first 02:30 (CEST)", () => {
    const runs = nextRuns(madrid("30 2 * * *"), new Date("2026-10-24T12:00:00Z"), 4);
    expect(iso(runs)).toEqual([
      "2026-10-25T00:30:00.000Z", // 02:30 CEST (+02:00)
      "2026-10-26T01:30:00.000Z", // 02:30 CET (+01:00) from here on
      "2026-10-27T01:30:00.000Z",
      "2026-10-28T01:30:00.000Z",
    ]);
    const onThe25th = runs.filter((d) => d.toISOString().startsWith("2026-10-25"));
    expect(onThe25th).toHaveLength(1);
    // Chained from the scheduled instant, the repeated hour never produces a second run.
    expect(nextRunAfter(madrid("30 2 * * *"), new Date("2026-10-25T00:30:00Z")).toISOString()).toBe(
      "2026-10-26T01:30:00.000Z",
    );
  });

  it("Fridays at 17:00 switch from 15:00Z (CEST) to 16:00Z (CET) after 2026-10-25", () => {
    expect(iso(nextRuns(madrid("0 17 * * 5"), new Date("2026-10-20T00:00:00Z"), 3))).toEqual([
      "2026-10-23T15:00:00.000Z",
      "2026-10-30T16:00:00.000Z",
      "2026-11-06T16:00:00.000Z",
    ]);
  });
});

describe("Australia/Sydney (southern hemisphere)", () => {
  it("2026-04-05 (DST ends): weekdays at 09:00 local, the offset moving from +11 to +10", () => {
    expect(iso(nextRuns(sydney("0 9 * * 1-5"), new Date("2026-04-01T00:00:00Z"), 4))).toEqual([
      "2026-04-01T22:00:00.000Z", // Thu 2 Apr 09:00 AEDT (+11)
      "2026-04-02T22:00:00.000Z", // Fri 3 Apr 09:00 AEDT
      "2026-04-05T23:00:00.000Z", // Mon 6 Apr 09:00 AEST (+10)
      "2026-04-06T23:00:00.000Z",
    ]);
  });

  it("2026-10-04 (DST starts): weekdays at 09:00 local, the offset moving from +10 to +11", () => {
    expect(iso(nextRuns(sydney("0 9 * * 1-5"), new Date("2026-10-01T00:00:00Z"), 4))).toEqual([
      "2026-10-01T23:00:00.000Z", // Fri 2 Oct 09:00 AEST (+10)
      "2026-10-04T22:00:00.000Z", // Mon 5 Oct 09:00 AEDT (+11)
      "2026-10-05T22:00:00.000Z",
      "2026-10-06T22:00:00.000Z",
    ]);
  });
});

describe("nextRunAfter: no double fire, no drift", () => {
  it("never returns the instant it is computed from", () => {
    const at = new Date("2026-11-06T16:00:00Z");
    expect(nextRunAfter(madrid("0 17 * * 5"), at).toISOString()).toBe("2026-11-13T16:00:00.000Z");
    const hourly = { cron: "0 * * * *", timeZone: "UTC" };
    expect(nextRunAfter(hourly, new Date("2026-01-01T10:00:00Z")).toISOString()).toBe(
      "2026-01-01T11:00:00.000Z",
    );
  });

  it("chained from the scheduled instant, a late tick keeps the grid (computed from the instant, not from now)", () => {
    const daily = madrid("0 9 * * *");
    const scheduled = new Date("2026-11-02T08:00:00Z"); // 09:00 CET
    const lateNow = new Date("2026-11-02T08:47:13Z"); // the tick ran 47 minutes late
    const fromInstant = nextRunAfter(daily, scheduled);
    expect(fromInstant.toISOString()).toBe("2026-11-03T08:00:00.000Z");
    expect(fromInstant.getUTCMinutes()).toBe(0);
    expect(nextRunAfter(daily, lateNow).toISOString()).toBe("2026-11-03T08:00:00.000Z");
  });

  it("the first run of a new automation is the next instant after now", () => {
    expect(firstRunAt(madrid("0 17 * * 5"), new Date("2026-10-30T12:00:00Z")).toISOString()).toBe(
      "2026-10-30T16:00:00.000Z",
    );
  });
});

describe("validateSchedule (the save and the preview share it)", () => {
  const now = new Date("2026-10-30T12:00:00Z");
  it.each([
    ["0 17 * * 5", "Europe/Madrid", 15, { ok: true }],
    ["*/10 * * * *", "Europe/Madrid", 15, { ok: false, code: "schedule_too_frequent" }],
    ["0 * * * *", "Europe/Madrid", 15, { ok: true }],
    ["*/15 * * * *", "UTC", 15, { ok: true }],
    ["0,5 9 * * *", "UTC", 15, { ok: false, code: "schedule_too_frequent" }],
    ["61 * * * *", "Europe/Madrid", 15, { ok: false, code: "invalid_cron" }],
    ["0 30 * * *", "Europe/Madrid", 15, { ok: false, code: "invalid_cron" }],
    ["0 9 * *", "Europe/Madrid", 15, { ok: false, code: "invalid_cron" }],
    ["0 17 * * 5", "Europe/Madird", 15, { ok: false, code: "invalid_time_zone" }],
  ])("%s in %s (min %i) → %o", (cron, timeZone, min, expected) => {
    expect(validateSchedule({ cron, timeZone }, min, now)).toEqual(expected);
  });

  it("the UI presets are all valid at the default 15-minute minimum", () => {
    for (const cron of ["15 * * * *", "0 9 * * *", "0 9 * * 1-5", "0 17 * * 5", "0 9 1 * *", "0 9 28 * *", "45 23 L * *"]) {
      expect(validateSchedule({ cron, timeZone: "Europe/Madrid" }, 15, now), cron).toEqual({ ok: true });
    }
  });

  it("Every month · Last day (07.6-15) runs on each month's last day in the zone", () => {
    expect(iso(nextRuns(madrid("45 23 L * *"), new Date("2026-10-30T12:00:00Z"), 3))).toEqual([
      "2026-10-31T22:45:00.000Z", // 23:45 CET on Oct 31
      "2026-11-30T22:45:00.000Z",
      "2026-12-31T22:45:00.000Z",
    ]);
  });
});

describe("missedPolicy (P-07: fire once when at most 6 hours late, otherwise skip as missed)", () => {
  const scheduled = new Date("2026-11-02T08:00:00Z");
  it("fires 5 hours late and exactly at 6 hours", () => {
    expect(missedPolicy(scheduled, new Date("2026-11-02T13:00:00Z"))).toBe("fire");
    expect(missedPolicy(scheduled, new Date("2026-11-02T14:00:00Z"))).toBe("fire");
  });
  it("skips 7 hours late", () => {
    expect(missedPolicy(scheduled, new Date("2026-11-02T15:00:00Z"))).toBe("skip");
  });
});
