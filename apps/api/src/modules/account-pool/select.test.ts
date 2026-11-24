import type { PoolStrategy } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { type PoolCandidate, pickAccount } from "./select";

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
