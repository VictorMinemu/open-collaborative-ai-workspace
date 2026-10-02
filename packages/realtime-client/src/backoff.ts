/** Full-jitter exponential backoff: random in [0, min(max, base * 2^attempt)]. */
export function backoffDelay(
  attempt: number,
  baseMs = 1000,
  maxMs = 30_000,
  random: () => number = Math.random,
) {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(random() * cap);
}
