// Test-only helper for the "linear time" checks (ReDoS, quadratic diffs). Imported only from *.test.ts files.

export interface ScalingOptions {
  /** Measured rounds after the warm-up. */
  rounds?: number;
  /** A small run faster than this counts as this long, so a tiny baseline cannot inflate the ratio. */
  floorMs?: number;
  /**
   * A single run (warm-up included) slower than this ends the measurement at once: `largeMs` is that run's time and
   * `ratio` is infinite, so the absolute cap fails in seconds instead of after minutes of quadratic work.
   */
  ceilingMs?: number;
}

export interface Scaling {
  /** The smallest large/small ratio of any single round: the value to assert on. */
  ratio: number;
  /** Every round's ratio, for the failure message. */
  ratios: number[];
  /** The fastest large run (or the run that crossed `ceilingMs`), for the absolute cap. */
  largeMs: number;
}

/**
 * Times `small` and `large` in rounds (one small run immediately followed by one large run, after one warm-up call of
 * each) and returns the smallest per-round ratio. A super-linear implementation is slow relative to the small input in
 * every round, so its smallest ratio stays high; host noise (a GC pause, a busy shared CI runner) only fails the check
 * if it inflates every single round. Dividing the best small time by the best large time instead mixes rounds, so one
 * quiet small run plus noisy large runs could fail a linear implementation (pipeline 174: 15.9 against 12).
 */
export function measureScaling(
  small: () => unknown,
  large: () => unknown,
  { rounds = 5, floorMs = 2, ceilingMs = Number.POSITIVE_INFINITY }: ScalingOptions = {},
): Scaling {
  const ratios: number[] = [];
  const time = (fn: () => unknown) => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };
  const tooSlow = (ms: number): Scaling => ({ ratio: Number.POSITIVE_INFINITY, ratios, largeMs: ms });
  for (const fn of [small, large]) {
    const ms = time(fn);
    if (ms > ceilingMs) return tooSlow(ms);
  }
  let largeMs = Number.POSITIVE_INFINITY;
  for (let i = 0; i < rounds; i++) {
    const smallMs = time(small);
    if (smallMs > ceilingMs) return tooSlow(smallMs);
    const roundLargeMs = time(large);
    if (roundLargeMs > ceilingMs) return tooSlow(roundLargeMs);
    ratios.push(roundLargeMs / Math.max(smallMs, floorMs));
    largeMs = Math.min(largeMs, roundLargeMs);
  }
  return { ratio: Math.min(...ratios), ratios, largeMs };
}
