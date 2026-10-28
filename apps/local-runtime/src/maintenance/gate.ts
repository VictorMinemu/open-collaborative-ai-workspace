// RuntimeGate: holds the new turns of ONE runtime while its CLI updates (07.11 D-03, D-03b, PD-07).
//
// Why the admission is synchronous: the update may start only at a moment when the adapter reports no turn in flight
// (`activeTurns() === 0`) AND no command sits between admission and the adapter call (`admitted === 0`). A caller
// re-checks `isOpen` and increments `admitted` in the same synchronous step, and `closeIfIdle` checks both counts and
// closes in one synchronous step, so no turn can start between the idle check and the update: whichever runs first
// wins, never both.
//
// The gate never interrupts anything: closing only holds NEW commands; turns already admitted or running finish.
// Callers pass only the commands PD-07 holds (session.start, prompt/steer, session.configure, session.title, catalog
// collection for this runtime); interrupts, approvals, stops and diffs never go through it.

export class RuntimeGate {
  private openState = true;
  private inFlight = 0;
  /** Held callers, in arrival order; `open()` releases them first in, first out. */
  private readonly waiters: Array<() => void> = [];

  get isOpen(): boolean {
    return this.openState;
  }

  /** Commands between admission and the end of their adapter call. */
  get admitted(): number {
    return this.inFlight;
  }

  /** Callers waiting for the gate to open. */
  get heldCount(): number {
    return this.waiters.length;
  }

  /**
   * Runs `fn` now if the gate is open; otherwise holds it until `open()` (telling the caller once, through
   * `onHeld`). The open check and the count happen in one synchronous step after every wait.
   */
  async admit<T>(fn: () => Promise<T>, onHeld?: () => void): Promise<T> {
    let told = false;
    while (!this.openState) {
      if (!told) {
        told = true;
        try {
          onHeld?.();
        } catch {
          // a failing notification never blocks the command
        }
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inFlight++;
    try {
      return await fn();
    } finally {
      this.inFlight--;
    }
  }

  /**
   * Closes the gate if, right now, the adapter reports no turn in flight and nothing is admitted; returns whether the
   * gate is closed on an idle runtime. Synchronous by design (see the header).
   */
  closeIfIdle(activeTurns: () => number): boolean {
    if (this.inFlight > 0 || activeTurns() > 0) return false;
    this.openState = false;
    return true;
  }

  /** Drain: closes whatever runs. New commands wait; admitted ones and running turns finish (never interrupted). */
  close(): void {
    this.openState = false;
  }

  /** Resolves once the adapter reports no turn in flight and nothing is admitted (checked every `pollMs`). */
  waitIdle(activeTurns: () => number, pollMs = 1000): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = () => {
        if (this.inFlight === 0 && activeTurns() === 0) resolve();
        else setTimeout(check, pollMs).unref?.();
      };
      check();
    });
  }

  /** Opens the gate and releases the held callers in arrival order. */
  open(): void {
    this.openState = true;
    for (const release of this.waiters.splice(0)) release();
  }
}
