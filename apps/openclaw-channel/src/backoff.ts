/** Exponential backoff with full jitter, capped. attempt is 0-based. */
export function backoffDelayMs(
  attempt: number,
  opts: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const base = opts.baseMs ?? 500;
  const max = opts.maxMs ?? 30_000;
  const random = opts.random ?? Math.random;
  const ceiling = Math.min(max, base * 2 ** Math.min(attempt, 20));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

/** Resolves after `ms`, or rejects with the abort reason when `signal` aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
