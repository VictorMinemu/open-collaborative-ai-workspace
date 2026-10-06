/**
 * Exactly one account loop per process. OpenClaw can start a fresh plugin instance (possibly a new
 * module instance) before the previous one has stopped; two live loops would both answer every
 * mention and the stale one fails with "Async work scope is closed". A new start aborts the old one.
 * The registry lives on `globalThis` under a `Symbol.for` key so every module instance shares it.
 */
const ACTIVE_KEY = Symbol.for("ocw.openclaw-channel.active-account");
type ActiveRegistry = { [ACTIVE_KEY]?: AbortController };

export function claimActiveAccount(hostSignal: AbortSignal): AbortController {
  const registry = globalThis as ActiveRegistry;
  registry[ACTIVE_KEY]?.abort();
  const local = new AbortController();
  if (hostSignal.aborted) local.abort();
  else hostSignal.addEventListener("abort", () => local.abort(), { once: true });
  registry[ACTIVE_KEY] = local;
  return local;
}

export function releaseActiveAccount(local: AbortController): void {
  const registry = globalThis as ActiveRegistry;
  if (registry[ACTIVE_KEY] === local) delete registry[ACTIVE_KEY];
}

/** True while an `ocw` account loop runs in this process (whoever started it). */
export function isOcwAccountActive(): boolean {
  const active = (globalThis as ActiveRegistry)[ACTIVE_KEY];
  return active !== undefined && !active.signal.aborted;
}
