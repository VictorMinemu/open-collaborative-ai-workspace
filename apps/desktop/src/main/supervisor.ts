// Supervises the Local Runtime daemon child process (ADR-0005): start, restart with exponential
// backoff on crash, stop the whole process group on quit. No Electron imports, so it is unit
// tested with a fake child.

import { EventEmitter } from "node:events";

export interface ChildLike {
  readonly pid?: number | undefined;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

export interface SupervisorDeps {
  spawn: () => ChildLike;
  /** Signal the child's whole process group (negative pid on POSIX). */
  killGroup: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onSpawned?: (pid: number) => void;
  onExited?: (pid: number | undefined) => void;
}

export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  factor: number;
  /** A child that stayed up this long resets the backoff. */
  stableMs: number;
  /** Grace period between SIGTERM and SIGKILL on stop. */
  killTimeoutMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialMs: 1000,
  maxMs: 30_000,
  factor: 2,
  stableMs: 30_000,
  killTimeoutMs: 5000,
};

export type SupervisorState = "stopped" | "starting" | "running" | "restarting";

export function backoffDelay(
  attempt: number,
  o: Pick<BackoffOptions, "initialMs" | "maxMs" | "factor">,
): number {
  return Math.min(o.maxMs, Math.round(o.initialMs * o.factor ** Math.max(0, attempt)));
}

export class DaemonSupervisor extends EventEmitter {
  private child: ChildLike | null = null;
  private wanted = false;
  private attempt = 0;
  private startedAt = 0;
  private restartTimer: unknown = null;
  private stopping: Promise<void> | null = null;
  private _state: SupervisorState = "stopped";
  restarts = 0;
  readonly opts: BackoffOptions;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly deps: SupervisorDeps,
    opts: Partial<BackoffOptions> = {},
  ) {
    super();
    this.opts = { ...DEFAULT_BACKOFF, ...opts };
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  get state(): SupervisorState {
    return this._state;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Delay before the next restart, for display/tests. */
  get nextDelayMs(): number {
    return backoffDelay(this.attempt, this.opts);
  }

  private setState(s: SupervisorState): void {
    if (s === this._state) return;
    this._state = s;
    this.emit("state", s);
  }

  start(): void {
    this.wanted = true;
    if (this.child || this.restartTimer !== null) return;
    this.launch();
  }

  private launch(): void {
    this.restartTimer = null;
    if (!this.wanted) return;
    this.setState("starting");
    let child: ChildLike;
    try {
      child = this.deps.spawn();
    } catch (err) {
      this.emit("spawn-error", err);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.startedAt = this.now();
    let exited = false;
    const onGone = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited) return;
      exited = true;
      if (this.child === child) this.child = null;
      this.deps.onExited?.(child.pid);
      this.emit("exit", { code, signal });
      if (!this.wanted) {
        this.setState("stopped");
        return;
      }
      if (this.now() - this.startedAt >= this.opts.stableMs) this.attempt = 0;
      this.scheduleRestart();
    };
    child.on("exit", onGone);
    child.on("error", (err) => {
      this.emit("spawn-error", err);
      // A child that failed to spawn never emits "exit".
      if (child.pid === undefined) onGone(null, null);
    });
    if (child.pid !== undefined) {
      this.deps.onSpawned?.(child.pid);
      this.setState("running");
    }
  }

  private scheduleRestart(): void {
    if (!this.wanted) return;
    const delay = backoffDelay(this.attempt, this.opts);
    this.attempt += 1;
    this.restarts += 1;
    this.setState("restarting");
    this.emit("restart-scheduled", delay);
    this.restartTimer = this.setTimer(() => this.launch(), delay);
  }

  /** Stop and do not restart. SIGTERM the process group, SIGKILL after the grace period. */
  stop(): Promise<void> {
    this.wanted = false;
    if (this.restartTimer !== null) {
      this.clearTimer(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child || child.pid === undefined) {
      this.child = null;
      this.setState("stopped");
      return Promise.resolve();
    }
    if (this.stopping) return this.stopping;
    const pid = child.pid;
    this.stopping = new Promise<void>((resolve) => {
      let done = false;
      let killTimer: unknown = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (killTimer !== null) this.clearTimer(killTimer);
        this.stopping = null;
        resolve();
      };
      child.on("exit", finish);
      try {
        this.deps.killGroup(pid, "SIGTERM");
      } catch {
        // already gone
      }
      killTimer = this.setTimer(() => {
        try {
          this.deps.killGroup(pid, "SIGKILL");
        } catch {
          // already gone
        }
        // Do not hang quit forever if the exit event never comes.
        this.setTimer(finish, 500);
      }, this.opts.killTimeoutMs);
    });
    return this.stopping;
  }

  /** Stop then start again (e.g. after pairing, to hand the daemon its new token). */
  async restart(): Promise<void> {
    await this.stop();
    this.attempt = 0;
    this.start();
  }
}
