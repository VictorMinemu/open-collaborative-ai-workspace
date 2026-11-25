import { POOL_STRATEGY_TEXT, type PoolAccount } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import {
  accountLocationText,
  accountStatusText,
  lastUsedText,
  moveInOrder,
  poolTime,
  strategyOptions,
  usageBars,
  weightError,
} from "./account-pool-format";

/**
 * Settings › Account pool texts (07.18-15, D-09, D-10, PD-13): status, where an account lives, its usage bars and the
 * strategy options, all pure, from what the API sent.
 */

// Monday 23 November 2026, noon UTC.
const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const T = "2026-11-20T09:00:00.000Z";
const utc = (iso: string) => poolTime(iso, { now: NOW, timeZone: "UTC", locale: "en-GB" });

function account(over: Partial<PoolAccount> = {}): PoolAccount {
  return {
    id: "01a11635-d6e7-7c87-9f17-0000000000c1",
    provider: "claude",
    kind: "token",
    label: "ana@acme",
    enabled: true,
    priority: 0,
    weight: 1,
    status: "ready",
    cooldownUntil: null,
    limitReason: null,
    lastUsedAt: null,
    usage: null,
    planType: null,
    origin: "admin",
    device: null,
    createdAt: T,
    ...over,
  };
}

describe("poolTime", () => {
  it("is the time today, and the weekday with the time on another day", () => {
    expect(utc("2026-11-23T15:40:00.000Z")).toBe("15:40");
    expect(utc("2026-11-24T15:40:00.000Z")).toBe("Tue 15:40");
    expect(utc("2026-11-29T08:05:00.000Z")).toBe("Sun 08:05");
  });
});

describe("accountStatusText", () => {
  it("reads Ready, Cooling until, Needs sign-in and Off", () => {
    expect(accountStatusText(account(), utc)).toBe("Ready");
    expect(
      accountStatusText(account({ status: "cooling", cooldownUntil: "2026-11-23T15:40:00.000Z" }), utc),
    ).toBe("Cooling until 15:40");
    expect(
      accountStatusText(account({ status: "cooling", cooldownUntil: "2026-11-24T15:40:00.000Z" }), utc),
    ).toBe("Cooling until Tue 15:40");
    expect(accountStatusText(account({ status: "cooling", cooldownUntil: null }), utc)).toBe("Cooling");
    expect(accountStatusText(account({ status: "disabled", enabled: false }), utc)).toBe("Off");
  });

  it("asks for a new token on a token account, a sign-in on the others", () => {
    expect(accountStatusText(account({ status: "needs_sign_in" }), utc)).toBe("Paste a new token");
    expect(
      accountStatusText(account({ status: "needs_sign_in", provider: "chatgpt", kind: "cell_profile" }), utc),
    ).toBe("Needs sign-in");
  });
});

describe("accountLocationText", () => {
  const device = { id: "01a11635-d6e7-7c87-9f17-0000000000d1", name: "Build server", online: true };
  it("says where the credential lives", () => {
    expect(accountLocationText(account())).toBe("Sealed on the server");
    expect(accountLocationText(account({ kind: "device_slot", device }))).toBe("On Build server");
    expect(accountLocationText(account({ kind: "device_slot", device: { ...device, online: false } }))).toBe(
      "On Build server · offline",
    );
    expect(accountLocationText(account({ kind: "device_slot", device: null }))).toBe("On a device");
    expect(accountLocationText(account({ kind: "cell_profile" }))).toBe("Bots runtime");
  });
});

describe("usageBars", () => {
  it("has one bar per reported window, with its label and a whole percent", () => {
    const bars = usageBars({
      at: T,
      windows: [
        { kind: "five_hour", usedPercent: 42.4, resetsAt: "2026-11-23T15:40:00.000Z" },
        { kind: "seven_day", usedPercent: 80, resetsAt: null },
        { kind: "weekly_model", usedPercent: 100, resetsAt: null },
        { kind: "primary", usedPercent: 3, resetsAt: null },
        { kind: "secondary", usedPercent: 0, resetsAt: null },
        { kind: "other", usedPercent: null, resetsAt: null },
      ],
    });
    expect(bars.map((b) => [b.label, b.percent])).toEqual([
      ["5 hours", 42],
      ["7 days", 80],
      ["Weekly model", 100],
      ["Primary", 3],
      ["Secondary", 0],
    ]);
    expect(bars[0]?.resetsAt).toBe("2026-11-23T15:40:00.000Z");
  });

  it("is empty without a snapshot", () => {
    expect(usageBars(null)).toEqual([]);
    expect(usageBars({ at: T, windows: [] })).toEqual([]);
  });
});

describe("strategyOptions", () => {
  it("offers the three strategies with the contract's texts, failover first", () => {
    const options = strategyOptions();
    expect(options.map((o) => o.value)).toEqual(["failover", "round_robin", "weighted"]);
    expect(options[0]?.label).toBe("Use one until its limit, then the next");
    expect(options.map((o) => o.description)).toEqual([
      POOL_STRATEGY_TEXT.failover.description,
      POOL_STRATEGY_TEXT.round_robin.description,
      POOL_STRATEGY_TEXT.weighted.description,
    ]);
  });
});

describe("lastUsedText", () => {
  it("says when the account was last used", () => {
    expect(lastUsedText(null, NOW)).toBe("Not used yet");
    expect(lastUsedText(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("Used 5 minutes ago");
  });
});

describe("moveInOrder", () => {
  it("swaps an account with its neighbour, and leaves the ends alone", () => {
    expect(moveInOrder(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveInOrder(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveInOrder(["a", "b", "c"], "a", -1)).toBeNull();
    expect(moveInOrder(["a", "b", "c"], "c", 1)).toBeNull();
    expect(moveInOrder(["a", "b", "c"], "x", 1)).toBeNull();
  });
});

describe("weightError", () => {
  it.each([
    ["1", null],
    ["100", null],
    ["0", "Enter a whole number from 1 to 100"],
    ["101", "Enter a whole number from 1 to 100"],
    ["2.5", "Enter a whole number from 1 to 100"],
    ["", "Enter a whole number from 1 to 100"],
  ])("%s", (value, error) => {
    expect(weightError(value)).toBe(error);
  });
});
