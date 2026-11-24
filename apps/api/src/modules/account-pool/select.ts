import { POOL_LIMITS, type PoolStrategy } from "@ocw/contracts";

/**
 * Which pool account a Work Zone session gets (PURE, Phase 07.18, D-04, D-05, PD-07).
 *
 * An account is chosen only when a session starts or when its account must change (D-05); never per request. The
 * caller filters usability (enabled, not cooling, a slot of the same device) before `pickAccount`, locks the
 * provider's policy row `FOR UPDATE`, and persists `last_used_at` (every strategy) and the returned `wrr` state
 * (weighted) in the same transaction (PD-07). This file never reads the database.
 *
 * Ties are deterministic everywhere: priority asc, then `createdAt` asc, then id asc.
 */

/** One usable account as the selector sees it; times are epoch milliseconds so the functions stay pure. */
export interface PoolCandidate {
  id: string;
  priority: number;
  weight: number;
  lastUsedAt: number | null;
  wrrCurrent: number;
  createdAt: number;
}

export interface PoolPick {
  id: string;
  /** The weighted round-robin state of every candidate after this pick (unchanged by the other strategies). */
  wrr: ReadonlyMap<string, number>;
}

/** The admin's order: priority asc, then the older account, then the smaller id. */
function byOrder(a: PoolCandidate, b: PoolCandidate): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function currentState(candidates: readonly PoolCandidate[]): Map<string, number> {
  return new Map(candidates.map((c) => [c.id, c.wrrCurrent]));
}

/** The first candidate under `better` (a strict "a wins over b"), scanning in the admin's order. */
function best(
  candidates: readonly PoolCandidate[],
  better: (a: PoolCandidate, b: PoolCandidate) => boolean,
): PoolCandidate {
  const ordered = [...candidates].sort(byOrder);
  let winner = ordered[0] as PoolCandidate;
  for (const c of ordered.slice(1)) if (better(c, winner)) winner = c;
  return winner;
}

/** Never used first, then the least recently used; the admin's order breaks ties. */
function usedEarlier(a: PoolCandidate, b: PoolCandidate): boolean {
  if (a.lastUsedAt === null) return b.lastUsedAt !== null;
  return b.lastUsedAt !== null && a.lastUsedAt < b.lastUsedAt;
}

function clampWeight(weight: number): number {
  return Math.min(POOL_LIMITS.weightMax, Math.max(POOL_LIMITS.weightMin, Math.trunc(weight)));
}

/**
 * Smooth weighted round-robin (the nginx algorithm): every candidate's current value grows by its weight, the largest
 * current wins (ties by the admin's order), and the winner gives back the total weight. A candidate the caller has no
 * state for passes `wrrCurrent: 0` (a newly added account).
 */
function pickWeighted(candidates: readonly PoolCandidate[]): PoolPick {
  const next = new Map<string, number>();
  let total = 0;
  for (const c of candidates) {
    const weight = clampWeight(c.weight);
    total += weight;
    next.set(c.id, c.wrrCurrent + weight);
  }
  const current = (c: PoolCandidate) => next.get(c.id) ?? 0;
  const winner = best(candidates, (a, b) => current(a) > current(b));
  next.set(winner.id, current(winner) - total);
  return { id: winner.id, wrr: next };
}

export function pickAccount(strategy: PoolStrategy, candidates: readonly PoolCandidate[]): PoolPick | null {
  if (candidates.length === 0) return null;
  switch (strategy) {
    case "failover":
      return { id: best(candidates, () => false).id, wrr: currentState(candidates) };
    case "round_robin":
      return { id: best(candidates, usedEarlier).id, wrr: currentState(candidates) };
    case "weighted":
      return pickWeighted(candidates);
  }
}

// ---- cooldowns (D-06, D-08, PD-08, PD-16) ----

/**
 * How long a limited account cools. The reset comes from a device frame, so it is bounded: a missing, past or present
 * reset cools `POOL_LIMITS.defaultCooldownMs` (a device cannot skip the cooldown), and one further out than
 * `POOL_LIMITS.maxCooldownMs` is cut there (a device cannot disable an account for years). Keeping the later of two
 * limits on an already cooling account is the caller's job.
 */
export function cooldownUntil(resetsAt: Date | null, now: Date): Date {
  const nowMs = now.getTime();
  if (resetsAt === null || resetsAt.getTime() <= nowMs) {
    return new Date(nowMs + POOL_LIMITS.defaultCooldownMs);
  }
  return new Date(Math.min(resetsAt.getTime(), nowMs + POOL_LIMITS.maxCooldownMs));
}

/** An account cools only while its cooldown lies in the future; the end instant itself is ready again. */
export function isCooling(cooldownUntil: Date | null, now: Date): boolean {
  return cooldownUntil !== null && cooldownUntil.getTime() > now.getTime();
}

/** The soonest future cooldown end among the rows ("The earliest resets at …"), or null when none cools. */
export function earliestReset(rows: readonly { cooldownUntil: Date | null }[], now: Date): Date | null {
  let soonest: number | null = null;
  for (const row of rows) {
    const until = row.cooldownUntil;
    if (until === null || !isCooling(until, now)) continue;
    if (soonest === null || until.getTime() < soonest) soonest = until.getTime();
  }
  return soonest === null ? null : new Date(soonest);
}
