import { describe, expect, it } from "vitest";
import { relativeTime, shortAge } from "./utils";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("shortAge (07.2 UI-SPEC: 'Version 4 · Ana Pérez · 3h ago')", () => {
  it("reads short: just now, minutes, hours, days", () => {
    expect(shortAge(ago(10_000), NOW)).toBe("just now");
    expect(shortAge(ago(2 * MIN), NOW)).toBe("2m ago");
    expect(shortAge(ago(3 * HOUR), NOW)).toBe("3h ago");
    expect(shortAge(ago(3 * HOUR + 59 * MIN), NOW)).toBe("3h ago");
    expect(shortAge(ago(3 * DAY), NOW)).toBe("3d ago");
  });

  it("older dates keep a short unit: weeks, months, years", () => {
    expect(shortAge(ago(10 * DAY), NOW)).toBe("1w ago");
    expect(shortAge(ago(45 * DAY), NOW)).toBe("1mo ago");
    expect(shortAge(ago(400 * DAY), NOW)).toBe("1y ago");
  });

  it("a date slightly in the future (clock skew) is just now", () => {
    expect(shortAge(new Date(NOW + 5_000).toISOString(), NOW)).toBe("just now");
  });
});

describe("relativeTime (unchanged: accessible names keep the long form)", () => {
  it("still says 2 minutes ago", () => {
    expect(relativeTime(ago(2 * MIN), NOW)).toBe("2 minutes ago");
  });
});
