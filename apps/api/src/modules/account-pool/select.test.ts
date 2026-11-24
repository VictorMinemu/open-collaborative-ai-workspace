import type { PoolStrategy } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { cooldownUntil, earliestReset, isCooling, type PoolCandidate, pickAccount } from "./select";

/** Account selection as exact sequences (PURE, 07.18 Plan 04, D-04, PD-07). */

const T0 = Date.UTC(2026, 10, 1);

function cand(id: string, over: Partial<Omit<PoolCandidate, "id">> = {}): PoolCandidate {
  return { id, priority: 0, weight: 1, lastUsedAt: null, wrrCurrent: 0, createdAt: T0, ...over };
}

const STRATEGIES: readonly PoolStrategy[] = ["failover", "round_robin", "weighted"];

describe("pickAccount: empty", () => {
  it.each(STRATEGIES)("%s over no candidates returns null", (strategy) => {
    expect(pickAccount(strategy, [])).toBeNull();
  });
});

describe("pickAccount: failover (the admin's order)", () => {
  it("returns the lowest priority", () => {
    const picked = pickAccount("failover", [
      cand("a", { priority: 2 }),
      cand("b", { priority: 0 }),
      cand("c", { priority: 1 }),
    ]);
    expect(picked?.id).toBe("b");
  });

  it("breaks a priority tie by the older createdAt", () => {
    const picked = pickAccount("failover", [
      cand("a", { priority: 0, createdAt: T0 + 1000 }),
      cand("z", { priority: 0, createdAt: T0 }),
      cand("m", { priority: 1, createdAt: T0 - 1000 }),
    ]);
    expect(picked?.id).toBe("z");
  });

  it("breaks a priority and age tie by the smaller id", () => {
    const picked = pickAccount("failover", [cand("c"), cand("a"), cand("b")]);
    expect(picked?.id).toBe("a");
  });

  it("ignores lastUsedAt", () => {
    const picked = pickAccount("failover", [cand("a", { lastUsedAt: T0 + 10 }), cand("b", { priority: 1 })]);
    expect(picked?.id).toBe("a");
  });

  it("returns the weighted state unchanged", () => {
    const picked = pickAccount("failover", [cand("a", { wrrCurrent: 3 }), cand("b", { wrrCurrent: -2 })]);
    expect(picked?.wrr).toEqual(
      new Map([
        ["a", 3],
        ["b", -2],
      ]),
    );
  });
});

describe("pickAccount: round_robin (least recently used)", () => {
  it("prefers a never-used candidate over used ones", () => {
    const picked = pickAccount("round_robin", [cand("a", { lastUsedAt: T0 }), cand("b", { priority: 3 })]);
    expect(picked?.id).toBe("b");
  });

  it("breaks a tie between never-used candidates by the admin's order", () => {
    const picked = pickAccount("round_robin", [
      cand("a", { lastUsedAt: T0 }),
      cand("c", { priority: 2 }),
      cand("b", { priority: 1 }),
    ]);
    expect(picked?.id).toBe("b");
  });

  it("otherwise returns the smallest lastUsedAt", () => {
    const picked = pickAccount("round_robin", [
      cand("a", { lastUsedAt: T0 + 5 }),
      cand("b", { lastUsedAt: T0 + 2, priority: 4 }),
      cand("c", { lastUsedAt: T0 + 9 }),
    ]);
    expect(picked?.id).toBe("b");
  });

  it("breaks an equal lastUsedAt by priority", () => {
    const picked = pickAccount("round_robin", [
      cand("a", { lastUsedAt: T0, priority: 2 }),
      cand("b", { lastUsedAt: T0, priority: 1 }),
    ]);
    expect(picked?.id).toBe("b");
  });

  it("returns the weighted state unchanged", () => {
    const picked = pickAccount("round_robin", [cand("a", { wrrCurrent: 4 }), cand("b", { wrrCurrent: -4 })]);
    expect(picked?.wrr).toEqual(
      new Map([
        ["a", 4],
        ["b", -4],
      ]),
    );
  });
});

/** Runs `n` weighted picks, feeding each pick's `wrr` back as the next call's state (as the store persists it). */
function weightedRun(
  start: readonly PoolCandidate[],
  n: number,
): { ids: string[]; state: Map<string, number> } {
  let candidates = [...start];
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const picked = pickAccount("weighted", candidates);
    if (picked === null) throw new Error("no pick");
    ids.push(picked.id);
    candidates = candidates.map((c) => ({ ...c, wrrCurrent: picked.wrr.get(c.id) ?? 0 }));
  }
  return { ids, state: new Map(candidates.map((c) => [c.id, c.wrrCurrent])) };
}

describe("pickAccount: weighted (smooth weighted round-robin)", () => {
  it("weights 5/1/1 give A A B A C A A and return to zero state", () => {
    // B before C in the admin's order, so the step-3 tie goes to B.
    const { ids, state } = weightedRun(
      [
        cand("A", { weight: 5, priority: 0 }),
        cand("B", { weight: 1, priority: 1 }),
        cand("C", { weight: 1, priority: 2 }),
      ],
      7,
    );
    expect(ids).toEqual(["A", "A", "B", "A", "C", "A", "A"]);
    expect(state).toEqual(
      new Map([
        ["A", 0],
        ["B", 0],
        ["C", 0],
      ]),
    );
  });

  it("weights 2/1 over six picks give A B A A B A", () => {
    const { ids } = weightedRun([cand("A", { weight: 2 }), cand("B", { weight: 1, priority: 1 })], 6);
    expect(ids).toEqual(["A", "B", "A", "A", "B", "A"]);
  });

  it("one candidate is always picked", () => {
    const { ids } = weightedRun([cand("only", { weight: 7 })], 4);
    expect(ids).toEqual(["only", "only", "only", "only"]);
  });

  it("returns the new state for every candidate, a newly added one starting at 0", () => {
    const picked = pickAccount("weighted", [
      cand("A", { weight: 3 }),
      cand("B", { weight: 1, priority: 1 }),
      cand("new", { weight: 2, priority: 2 }),
    ]);
    expect(picked?.id).toBe("A");
    expect(picked?.wrr).toEqual(
      new Map([
        ["A", -3],
        ["B", 1],
        ["new", 2],
      ]),
    );
  });

  it("ignores lastUsedAt", () => {
    const picked = pickAccount("weighted", [
      cand("a", { lastUsedAt: T0 + 100 }),
      cand("b", { lastUsedAt: null, priority: 1 }),
    ]);
    expect(picked?.id).toBe("a");
  });

  it("clamps a weight below the minimum up to it", () => {
    // Unclamped, weights 0 and -3 never accumulate and C would win the first pick.
    const { ids } = weightedRun(
      [
        cand("A", { weight: 0 }),
        cand("B", { weight: -3, priority: 1 }),
        cand("C", { weight: 1, priority: 2 }),
      ],
      3,
    );
    expect(ids).toEqual(["A", "B", "C"]);
  });

  it("clamps a weight above the maximum down to it", () => {
    // Unclamped, A (1000) would win far more often than every other pick against B (100).
    const { ids } = weightedRun([cand("A", { weight: 1000 }), cand("B", { weight: 100, priority: 1 })], 4);
    expect(ids).toEqual(["A", "B", "A", "B"]);
  });
});

const NOW = new Date(Date.UTC(2026, 10, 24, 12, 0, 0));
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe("cooldownUntil (D-08, PD-08)", () => {
  it("a missing reset cools 5 minutes", () => {
    expect(cooldownUntil(null, NOW)).toEqual(at(5 * MINUTE));
  });

  it("a reset equal to now cools 5 minutes", () => {
    expect(cooldownUntil(new Date(NOW), NOW)).toEqual(at(5 * MINUTE));
  });

  it("a past reset cools 5 minutes", () => {
    expect(cooldownUntil(at(-1000), NOW)).toEqual(at(5 * MINUTE));
  });

  it("a reset 2 hours out cools until that reset", () => {
    expect(cooldownUntil(at(2 * HOUR), NOW)).toEqual(at(2 * HOUR));
  });

  it("a reset 30 days out cools at most 7 days", () => {
    expect(cooldownUntil(at(30 * DAY), NOW)).toEqual(at(7 * DAY));
  });

  it("returns a new Date, never the caller's", () => {
    const reset = at(HOUR);
    const until = cooldownUntil(reset, NOW);
    expect(until).toEqual(reset);
    expect(until).not.toBe(reset);
  });
});

describe("isCooling (D-06)", () => {
  it("is false without a cooldown", () => {
    expect(isCooling(null, NOW)).toBe(false);
  });

  it("is false at the cooldown's end", () => {
    expect(isCooling(new Date(NOW), NOW)).toBe(false);
  });

  it("is true for a future instant", () => {
    expect(isCooling(at(1), NOW)).toBe(true);
  });

  it("is false for a past instant", () => {
    expect(isCooling(at(-1), NOW)).toBe(false);
  });
});

describe("earliestReset (D-06, PD-16)", () => {
  it("returns the soonest future cooldown", () => {
    const rows = [
      { cooldownUntil: at(-HOUR) },
      { cooldownUntil: at(3 * HOUR) },
      { cooldownUntil: at(HOUR) },
      { cooldownUntil: null },
    ];
    expect(earliestReset(rows, NOW)).toEqual(at(HOUR));
  });

  it("is null when nothing cools in the future", () => {
    expect(earliestReset([{ cooldownUntil: at(-HOUR) }, { cooldownUntil: null }], NOW)).toBeNull();
  });

  it("is null for no rows", () => {
    expect(earliestReset([], NOW)).toBeNull();
  });
});
