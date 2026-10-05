import { describe, expect, it } from "vitest";
import { effectiveDailyLimit, limitNotice, nextResetAt, utcDay } from "./usage";

/** 03.1-05 (BOT-07, D-11): the UTC day a turn counts in, the reset time and the notice text. */

describe("utcDay", () => {
  it("is the UTC date, whatever the local zone", () => {
    expect(utcDay(new Date("2026-10-04T23:59:59.999Z"))).toBe("2026-10-04");
    expect(utcDay(new Date("2026-10-05T00:00:00.000Z"))).toBe("2026-10-05");
    expect(utcDay(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-31");
  });
});

describe("nextResetAt", () => {
  it("is the next 00:00Z, strictly after now", () => {
    expect(nextResetAt(new Date("2026-10-04T23:59:59Z"))).toBe("2026-10-05T00:00:00.000Z");
    expect(nextResetAt(new Date("2026-10-05T00:00:00Z"))).toBe("2026-10-06T00:00:00.000Z");
    expect(nextResetAt(new Date("2026-12-31T12:00:00Z"))).toBe("2027-01-01T00:00:00.000Z");
    expect(nextResetAt(new Date("2028-02-28T08:00:00Z"))).toBe("2028-02-29T00:00:00.000Z");
  });
});

describe("limitNotice", () => {
  it("names the limit and the reset, in the bot's own voice", () => {
    expect(limitNotice({ botName: "Sam's assistant", limit: 30 })).toBe(
      "I've reached my daily limit of 30 replies, so I can't answer right now. I'll be back after 00:00 UTC.",
    );
  });

  it("uses the singular for a limit of one", () => {
    expect(limitNotice({ botName: "Archie", limit: 1 })).toBe(
      "I've reached my daily limit of 1 reply, so I can't answer right now. I'll be back after 00:00 UTC.",
    );
  });
});

describe("effectiveDailyLimit", () => {
  it("caps personal bots by the organization's maximum; team bots keep their own limit", () => {
    expect(effectiveDailyLimit("personal", { dailyLimit: 500 }, { personalDailyLimitMax: 100 })).toBe(100);
    expect(effectiveDailyLimit("personal", { dailyLimit: 30 }, { personalDailyLimitMax: 100 })).toBe(30);
    expect(effectiveDailyLimit("team", { dailyLimit: 500 }, { personalDailyLimitMax: 100 })).toBe(500);
  });
});
