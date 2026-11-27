// The all-gates step (ADR-0040 § 7), shared by the OCW runtime's self-update (07.17.1) and the desktop app's restart
// hold (07.13.1 D-07). One decision across every runtime of this daemon: no gate admits a command (`admitted === 0`)
// and no runtime runs a turn (`activeTurns(id) === 0`). `closeAllIfIdle` checks and closes in the same synchronous
// step, so no turn can start between the idle check and the close; nothing here ever interrupts a turn.

import type { RuntimeId } from "@ocw/contracts";
import type { RuntimeGate } from "./gate.js";

export type Gates = ReadonlyMap<RuntimeId, RuntimeGate>;
/** Turns in flight per runtime (the adapter's `activeTurns()`). */
export type ActiveTurns = (runtime: RuntimeId) => number;

/** Every gate admits nothing and every runtime runs nothing. */
export function allIdle(gates: Gates, activeTurns: ActiveTurns): boolean {
  for (const [id, gate] of gates) {
    if (gate.admitted > 0 || activeTurns(id) > 0) return false;
  }
  return true;
}

/** One synchronous step: every gate admits nothing and every runtime runs nothing → every gate closes. */
export function closeAllIfIdle(gates: Gates, activeTurns: ActiveTurns): boolean {
  if (!allIdle(gates, activeTurns)) return false;
  closeAll(gates);
  return true;
}

/** Drain: every gate closes whatever runs. New commands wait; admitted ones and running turns finish. */
export function closeAll(gates: Gates): void {
  for (const gate of gates.values()) gate.close();
}

/** Every gate opens and releases its held callers in arrival order; a sealed gate stays closed. */
export function openAll(gates: Gates): void {
  for (const gate of gates.values()) gate.open();
}

/** What still runs: per runtime, its turns in flight plus the commands its gate admitted, summed. */
export function runningCount(gates: Gates, activeTurns: ActiveTurns): number {
  let n = 0;
  for (const [id, gate] of gates) n += activeTurns(id) + gate.admitted;
  return n;
}
