// Test-only helper for the "linear time" checks (ReDoS, quadratic diffs). Imported only from *.test.ts files.

export interface ScalingOptions {
  /** Measured rounds after the warm-up. */
  rounds?: number;
  /** A small run faster than this counts as this long, so a tiny baseline cannot inflate the ratio. */
  floorMs?: number;
}

export interface Scaling {
  /** The smallest large/small ratio of any single round: the value to assert on. */
  ratio: number;
  /** Every round's ratio, for the failure message. */
  ratios: number[];
  /** The fastest large run, for the absolute cap on a rule that is slow at every size. */
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
  { rounds = 5, floorMs = 2 }: ScalingOptions = {},
): Scaling {
  small();
  large();
  const ratios: number[] = [];
  let largeMs = Number.POSITIVE_INFINITY;
  for (let i = 0; i < rounds; i++) {
    let t0 = performance.now();
    small();
    const smallMs = performance.now() - t0;
    t0 = performance.now();
    large();
    const roundLargeMs = performance.now() - t0;
    ratios.push(roundLargeMs / Math.max(smallMs, floorMs));
    largeMs = Math.min(largeMs, roundLargeMs);
  }
  return { ratio: Math.min(...ratios), ratios, largeMs };
}
