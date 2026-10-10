import { describe, expect, it } from "vitest";
import { freshKeys, keyBetween, RANK_KEY_MAX } from "./rank";

/** Phase 07.1-03 (D-05): server-minted fractional ranks, ordered by plain JavaScript comparison (= `COLLATE "C"`). */

const sorted = (keys: string[]) => [...keys].sort();

describe("board ranks", () => {
  it("keyBetween(null, null) is a valid key that later keys can follow", () => {
    const k = keyBetween(null, null);
    expect(k).not.toBe("rerank");
    const after = keyBetween(k, null);
    expect(after).not.toBe("rerank");
    expect(k < after).toBe(true);
  });

  it("a key between two neighbours sorts strictly between them", () => {
    const pairs: Array<[string | null, string | null]> = [
      ["a0", "a1"],
      ["a0", "a0V"],
      ["Zz", "a0"],
      [null, "a0"],
      ["a0", null],
      ["a0V", "a1"],
    ];
    for (const [prev, next] of pairs) {
      const k = keyBetween(prev, next);
      expect(k, `${prev} .. ${next}`).not.toBe("rerank");
      if (prev !== null) expect(prev < k, `${prev} < ${k}`).toBe(true);
      if (next !== null) expect(k < next, `${k} < ${next}`).toBe(true);
    }
  });

  it("tied or inverted neighbours ask for a re-rank", () => {
    expect(keyBetween("a1", "a1")).toBe("rerank");
    expect(keyBetween("b", "a")).toBe("rerank");
    expect(keyBetween("a1", "a0")).toBe("rerank");
  });

  it("an invalid (corrupt) neighbour asks for a re-rank instead of throwing", () => {
    expect(keyBetween("A0", null)).toBe("rerank");
    expect(keyBetween(null, "a10")).toBe("rerank");
  });

  it(`a key longer than ${RANK_KEY_MAX} characters asks for a re-rank`, () => {
    const prev = `a0${"V".repeat(RANK_KEY_MAX)}`;
    expect(keyBetween(prev, `${prev}1`)).toBe("rerank");
    // Repeated bisection of one gap grows the key until it reaches the bound, then stops.
    let next = "a1";
    let steps = 0;
    for (;;) {
      const k = keyBetween("a0", next);
      if (k === "rerank") break;
      expect(k.length).toBeLessThanOrEqual(RANK_KEY_MAX);
      expect("a0" < k && k < next).toBe(true);
      next = k;
      steps += 1;
      if (steps > 10_000) throw new Error("bisection never reached the bound");
    }
    expect(steps).toBeGreaterThan(100);
  });

  it("freshKeys(n) is strictly increasing", () => {
    const keys = freshKeys(5);
    expect(keys).toHaveLength(5);
    expect(sorted(keys)).toEqual(keys);
    expect(new Set(keys).size).toBe(5);
    expect(freshKeys(0)).toEqual([]);
  });

  it("200 successive inserts at the head stay valid and ordered", () => {
    const keys: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const k = keyBetween(null, keys[0] ?? null);
      expect(k).not.toBe("rerank");
      keys.unshift(k);
    }
    expect(sorted(keys)).toEqual(keys);
    expect(new Set(keys).size).toBe(200);
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(RANK_KEY_MAX);
  });
});
