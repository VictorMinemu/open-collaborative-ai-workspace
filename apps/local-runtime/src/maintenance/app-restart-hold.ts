// Phase 07.13.1 (D-07): the desktop app's restart hold. Before the app quits to install an update it asks its daemon,
// over the local control socket only, to hold every runtime gate (`appUpdateHold`), and quits only once the daemon
// answers `held`: every gate closed while no Work Zone turn runs, decided in one synchronous step (ADR-0040 § 7, the
// shared `all-gates.ts`). So an update never cuts a turn; a prompt that arrives meanwhile waits at its gate and, on the
// daemon's stop, never starts here (sealed gates; the server re-queues it after the restart, ADR-0040 PD-27).
//
// What this class never does: interrupt a turn; close a gate while a 07.11 CLI job or the runtime self-update holds
// (`runtimeUpdateBusy`); keep the gates closed without a bound; carry or log a path.

import type { RuntimeId } from "@ocw/contracts";
import { allIdle, closeAll, closeAllIfIdle, openAll, runningCount } from "./all-gates.js";
import type { RuntimeGate } from "./gate.js";
import type { TimerHandle } from "./maintenance.js";
import { SELF_UPDATE_MAX_HOLD_MS } from "./self-update-job.js";

/** The longest a drain keeps every gate closed waiting for the running turns (as the self-update, ADR-0040 WR-02). */
export const APP_UPDATE_MAX_HOLD_MS = SELF_UPDATE_MAX_HOLD_MS;
/** A `held` state the daemon's stop did not follow within this time reopens by itself (the app died before quitting). */
export const APP_UPDATE_AUTO_RELEASE_MS = 2 * 60_000;
/** How often a drain re-checks that every runtime is idle. */
export const APP_UPDATE_POLL_MS = 1_000;

export type AppUpdateHoldState = "idle" | "draining" | "held";
/** How the last hold ended: the app released it, the drain gave up, or nobody stopped the daemon after `held`. */
export type AppUpdateHoldEnd = "released" | "timed_out" | "auto_released";

/** The answer to `appUpdateHold`: states and counts only, never a path. */
export interface AppUpdateHoldAnswer {
  held: boolean;
  state: AppUpdateHoldState;
  running: number;
  blocked?: "runtime_update";
}

/** `status().appUpdate`. */
export interface AppUpdateHoldStatus {
  state: AppUpdateHoldState;
  running: number;
  lastEnd?: AppUpdateHoldEnd;
}

export interface AppRestartHoldOptions {
  /** Every runtime's gate (the daemon admits held commands through the same instances). */
  gates: ReadonlyMap<RuntimeId, RuntimeGate>;
  /** Turns in flight per runtime (the adapter's `activeTurns()`). */
  activeTurns: (runtime: RuntimeId) => number;
  /** A 07.11 CLI job is past `pending` or the runtime self-update holds: no gate closes for the app then. */
  runtimeUpdateBusy: () => boolean;
  /** The state changed (the daemon tells the sessions it held). */
  onChange: () => void;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  pollMs?: number;
  maxHoldMs?: number;
  autoReleaseMs?: number;
}

export class AppRestartHold {
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private state: AppUpdateHoldState = "idle";
  private lastEnd: AppUpdateHoldEnd | null = null;
  /** Draining: re-checks every `pollMs` whether every runtime is idle. */
  private pollTimer: TimerHandle | null = null;
  /** Draining: gives up after `maxHoldMs` (`timed_out`). */
  private maxTimer: TimerHandle | null = null;
  /** Held: reopens after `autoReleaseMs` unless the daemon stopped (`auto_released`). */
  private autoTimer: TimerHandle | null = null;
  /** The daemon stops: nothing changes from here on (its gates are sealed). */
  private stopped = false;

  constructor(private readonly opts: AppRestartHoldOptions) {
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      });
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** The app's hold is on (draining or held): no CLI job and no self-update hold starts. */
  get active(): boolean {
    return this.state !== "idle";
  }

  /**
   * `appUpdateHold`. Every gate closes now if nothing runs (`held`), in the same synchronous step as the check. Else,
   * without `drain` (the automatic restart) nothing changes and the answer says how much runs; with `drain` (a click)
   * every gate closes at once, the running turns finish (never cut), new commands wait, and the hold moves to `held`
   * by itself once every runtime is idle. While draining or held a repeat answers the current state and starts
   * nothing. While a 07.11 CLI job or the self-update holds, nothing is touched (`blocked`).
   */
  hold(req: { drain: boolean }): AppUpdateHoldAnswer {
    if (this.stopped || this.state !== "idle") return this.answer();
    if (this.opts.runtimeUpdateBusy()) return { ...this.answer(), blocked: "runtime_update" };
    if (closeAllIfIdle(this.opts.gates, this.opts.activeTurns)) {
      this.enterHeld();
      return this.answer();
    }
    if (!req.drain) return this.answer();
    closeAll(this.opts.gates);
    this.state = "draining";
    this.maxTimer = this.setTimer(() => {
      this.maxTimer = null;
      if (this.state === "draining") this.end("timed_out");
    }, this.opts.maxHoldMs ?? APP_UPDATE_MAX_HOLD_MS);
    this.schedulePoll();
    this.changed();
    return this.answer();
  }

  /** The daemon stops (its gates are sealed): every timer goes, nothing reopens, nobody is told. */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
  }

  /** `appUpdateRelease`: a cancelled or failed install reopens every gate at once. */
  release(): { released: boolean } {
    if (this.stopped || this.state === "idle") return { released: false };
    this.end("released");
    return { released: true };
  }

  status(): AppUpdateHoldStatus {
    return {
      state: this.state,
      running: this.running(),
      ...(this.lastEnd ? { lastEnd: this.lastEnd } : {}),
    };
  }

  private answer(): AppUpdateHoldAnswer {
    return { held: this.state === "held", state: this.state, running: this.running() };
  }

  private running(): number {
    return runningCount(this.opts.gates, this.opts.activeTurns);
  }

  private schedulePoll(): void {
    this.pollTimer = this.setTimer(() => {
      this.pollTimer = null;
      if (this.stopped || this.state !== "draining") return;
      if (allIdle(this.opts.gates, this.opts.activeTurns)) this.enterHeld();
      else this.schedulePoll();
    }, this.opts.pollMs ?? APP_UPDATE_POLL_MS);
  }

  /** Every gate is closed and nothing runs: the app may quit. Reopens by itself unless the daemon stops in time. */
  private enterHeld(): void {
    this.clearTimers();
    this.state = "held";
    this.autoTimer = this.setTimer(() => {
      this.autoTimer = null;
      if (this.state === "held") this.end("auto_released");
    }, this.opts.autoReleaseMs ?? APP_UPDATE_AUTO_RELEASE_MS);
    this.changed();
  }

  private clearTimers(): void {
    for (const t of [this.pollTimer, this.maxTimer, this.autoTimer]) if (t !== null) this.clearTimer(t);
    this.pollTimer = null;
    this.maxTimer = null;
    this.autoTimer = null;
  }

  /** Every exit path: every timer goes, every gate reopens (held callers in arrival order). */
  private end(how: AppUpdateHoldEnd): void {
    if (this.stopped) return;
    this.clearTimers();
    this.state = "idle";
    this.lastEnd = how;
    openAll(this.opts.gates);
    this.changed();
  }

  private changed(): void {
    try {
      this.opts.onChange();
    } catch {
      // a failing notification never changes the hold
    }
  }
}
