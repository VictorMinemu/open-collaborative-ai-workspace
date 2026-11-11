// Phase 07.17.1 (runtime self-update, ADR-0040, D-03, D-04, D-05, D-06, D-09, D-11; hub PD-08, PD-09, PD-10, PD-12):
// when this device updates its own OCW runtime, and how it waits. One job at a time: fetch the manifest the paired
// workspace serves → (same build: `unchanged` for a click, nothing for a check) → the install lock on
// `<OCW_HOME>/runtime` → `started` → prepare the new version beside the running one (outside the gates; sessions keep
// working) → one gate decision across every runtime → the switch (`current` moves) → `exit(SELF_UPDATE_EXIT_CODE)`, and
// the service manager starts the new version. The next daemon reports the run from the marker (07, PD-12).
//
// What this class never does: restart in any other way than `exit(SELF_UPDATE_EXIT_CODE)` (no `systemctl`, `launchctl`
// or `sudo`); read a URL, host, path or version from a command (only `serverUrl` and the fixed routes); resolve the OS
// user's home (the lock directory is a required option, PD-19); cut a running turn (the switch waits for every runtime
// to be idle, D-04); leave a gate it closed shut on any path that does not end in the exit.

import { randomUUID } from "node:crypto";
import {
  RUNTIME_SELF_BLOCK_SENTENCES,
  type RuntimeDistManifest,
  type RuntimeId,
  type RuntimeSelfBlock,
  type RuntimeSelfLastRun,
  RuntimeSelfStatus,
  type RuntimeSelfUpdateState,
  type RuntimeUpdateOutcome,
  RuntimeUpdateRunFrame,
  type RuntimeUpdatesLevel,
  runtimeBuildOf,
  scrubHostPaths,
} from "@ocw/contracts";
import { z } from "zod";
import { runtimeDir } from "../install-info.js";
import { errorMessage, type Logger, silentLogger } from "../logger.js";
import { DEV_RUNTIME_VERSION } from "../version.js";
import type { RuntimeGate } from "./gate.js";
import {
  DRAIN_POLL_MS,
  type InstallLocks,
  runOutputForFrame,
  type TimerHandle,
  type UpdateRequestAnswer,
} from "./maintenance.js";
import { type HeldInstallLock, InstallLock } from "./runner.js";
import {
  fetchServedManifest,
  type PreparedVersion,
  type PrepareVersionOptions,
  prepareVersion,
  SELF_UPDATE_EXIT_CODE,
  SELF_UPDATE_FAILURE_SENTENCES,
  SelfUpdateError,
  type SelfUpdateMarker,
  switchToVersion,
} from "./self-update.js";

/** The answers a request gets when this device will not run it (the ack's error text). */
export const SELF_UPDATE_REFUSALS = {
  busy: "an update of the OCW runtime is already running",
  not_installed: RUNTIME_SELF_BLOCK_SENTENCES.not_installed,
  not_supervised: RUNTIME_SELF_BLOCK_SENTENCES.not_supervised,
  node_too_old: RUNTIME_SELF_BLOCK_SENTENCES.node_too_old,
} as const;

export interface SelfUpdateOptions {
  ocwHome: string;
  /** The daemon's `config.serverUrl`: the only place the new runtime comes from (PD-06). */
  serverUrl: string;
  /** The daemon's environment (`OCW_INSTALL_ALLOW_HTTP`, the base of npm's filtered environment). */
  env: NodeJS.ProcessEnv;
  /** The running build, hashed once at boot (`runningBuild`); null in a checkout or the desktop app. */
  running: { version: string; sha256: string } | null;
  /** `isSupervised` at boot (D-05, D-12). */
  supervision: { supervised: boolean; reason: RuntimeSelfBlock | null };
  /** Every runtime's gate (the daemon admits held commands through the same instances). */
  gates: ReadonlyMap<RuntimeId, RuntimeGate>;
  /** Turns in flight per runtime (the adapter's `activeTurns()`). */
  activeTurns: (runtime: RuntimeId) => number;
  /** A 07.11 CLI job is past `pending` (`RuntimeMaintenance.jobActive`): no gate closes then (PD-09). */
  cliBusy: () => boolean;
  /** The effective 07.11 level (`RuntimeMaintenance.effectiveLevel`), read at each decision (PD-10). */
  level: () => RuntimeUpdatesLevel;
  /** Sends a `runtime.update.run` frame (the daemon queues it while disconnected). */
  sendRun: (frame: RuntimeUpdateRunFrame) => void;
  /** Something in `status()` changed: the daemon sends a fresh `runtime.maintenance` snapshot. */
  publish: () => void;
  /** Hands over to the service manager (the daemon stops cleanly, then exits with `code`). */
  exit: (code: number) => Promise<void>;
  /** PD-19: tests refuse a home inside the OS user's and an npm outside the temp directory. */
  requireScratchHome: boolean;
  /**
   * The install lock directory. Required: the daemon passes `defaultLockDir(scope.userHome)` (the maintenance scope's
   * home: the scratch home in tests and fake-CLI mode). Never derived here (PD-09, PD-19).
   */
  lockDir: string;
  /** The daemon's version when `running` is null (a checkout). */
  version?: string;
  execPath?: string;
  nodeVersion?: string;
  /** How often a waiting update re-checks the gates (default `DRAIN_POLL_MS`). */
  pollMs?: number;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** Test seams: the manifest fetch, the prepare and the switch (default: `self-update.ts`). */
  fetchManifest?: (p: {
    serverUrl: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  }) => Promise<RuntimeDistManifest>;
  prepare?: (p: PrepareVersionOptions) => Promise<PreparedVersion>;
  switchTo?: typeof switchToVersion;
  /** Install locks (default: `InstallLock` on `lockDir`). */
  locks?: InstallLocks;
  log?: Logger;
}

type Trigger = "manual" | "automatic";

interface Job {
  runId: string;
  trigger: Trigger;
  /** A server command id (uuid) ties the run to its "Update" request; anything else is not sent. */
  commandId: string | null;
  startedAt: number;
  manifest: RuntimeDistManifest | null;
  lock: HeldInstallLock | null;
  /** The `started` frame went out (a later `finished` carries the same fields). */
  started: boolean;
  /** Every gate is closed by this job. */
  holding: boolean;
  /** `switchTo` was called: from here on the run belongs to the exit and the next daemon. */
  switching: boolean;
  /** `switchTo` resolved: `current` names the new version. */
  switched: boolean;
  /** The `finished` frame went out (or the job ended silently): nothing else is sent for it. */
  ended: boolean;
  pendingSince: number | null;
  timer: TimerHandle | null;
  abort: AbortController;
}

const isUuid = (id: string | undefined): id is string => !!id && z.uuid().safeParse(id).success;

export class SelfUpdate {
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly locks: InstallLocks;
  private state: RuntimeSelfUpdateState = "idle";
  private job: Job | null = null;
  private lastRun: RuntimeSelfLastRun | null = null;
  private served: { version: string; sha256: string } | null = null;
  private checkedAt: number | null = null;
  private readonly knownCommands = new Set<string>();

  constructor(private readonly opts: SelfUpdateOptions) {
    this.log = opts.log ?? silentLogger;
    this.now = opts.now ?? Date.now;
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      });
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.locks = opts.locks ?? new InstallLock(opts.lockDir);
  }

  /** Every gate is closed by the self-update (also after the switch, into the exit). */
  get holding(): boolean {
    return this.job?.holding ?? false;
  }

  /** A self-update job exists (from the request until it ends or the process exits). */
  get busy(): boolean {
    return this.job !== null;
  }

  /** Whether this process already handled the command `id` (a redelivered one is acked without a second run). */
  isKnownCommand(id: string): boolean {
    return this.knownCommands.has(id);
  }

  stop(): void {
    // Task 2 (cancel before the switch, nothing after it).
  }

  /**
   * An update request: a click (`manual`, with the command's id, at any level, D-09) or the automatic decision. The
   * answer comes before anything is fetched; the run reports itself through `runtime.update.run` frames.
   */
  async request(trigger: Trigger, commandId?: string): Promise<UpdateRequestAnswer> {
    if (this.job) return { accepted: false, reason: SELF_UPDATE_REFUSALS.busy };
    const running = this.opts.running;
    if (!running) return { accepted: false, reason: SELF_UPDATE_REFUSALS.not_installed };
    if (commandId) this.knownCommands.add(commandId);
    const job: Job = {
      runId: randomUUID(),
      trigger,
      commandId: isUuid(commandId) ? commandId : null,
      startedAt: this.now(),
      manifest: null,
      lock: null,
      started: false,
      holding: false,
      switching: false,
      switched: false,
      ended: false,
      pendingSince: null,
      timer: null,
      abort: new AbortController(),
    };
    this.job = job;
    void this.run(job, running);
    return { accepted: true };
  }

  // ---- the job ----

  private async run(job: Job, running: { version: string; sha256: string }): Promise<void> {
    try {
      const manifest = await (this.opts.fetchManifest ?? fetchServedManifest)({
        serverUrl: this.opts.serverUrl,
        env: this.opts.env,
        signal: job.abort.signal,
      });
      if (job.ended) return;
      job.manifest = manifest;
      this.served = { version: manifest.version, sha256: manifest.sha256 };
      this.checkedAt = this.now();

      if (manifest.sha256 === running.sha256) {
        if (job.trigger === "manual") {
          this.sendStarted(job, running);
          this.end(job, "unchanged");
        } else this.end(job, null);
        return;
      }

      const held = await this.locks.acquire(runtimeDir(this.opts.ocwHome));
      if (job.ended) {
        if (held !== "busy") await held.release().catch(() => undefined);
        return;
      }
      if (held === "busy") {
        this.end(job, "failed", SELF_UPDATE_REFUSALS.busy);
        return;
      }
      job.lock = held;

      this.sendStarted(job, running);
      this.setState("downloading");
      const prepared = await (this.opts.prepare ?? prepareVersion)({
        ocwHome: this.opts.ocwHome,
        serverUrl: this.opts.serverUrl,
        env: this.opts.env,
        manifest,
        runId: job.runId,
        execPath: this.opts.execPath ?? process.execPath,
        nodeVersion: this.opts.nodeVersion ?? process.versions.node,
        requireScratchHome: this.opts.requireScratchHome,
        onPhase: (phase) => {
          if (!job.ended) this.setState(phase);
        },
        signal: job.abort.signal,
      });
      if (job.ended) return;

      await this.hold(job);
      if (job.ended) return;

      job.switching = true;
      this.setState("restarting");
      const marker: SelfUpdateMarker = {
        runId: job.runId,
        commandId: job.commandId,
        trigger: job.trigger,
        from: { version: running.version, sha256: running.sha256 },
        to: { version: manifest.version, sha256: manifest.sha256 },
        startedAt: new Date(job.startedAt).toISOString(),
      };
      await (this.opts.switchTo ?? switchToVersion)({
        ocwHome: this.opts.ocwHome,
        prepared,
        marker,
        serverUrl: this.opts.serverUrl,
        now: () => new Date(this.now()),
      });
      job.switched = true;
      await this.opts.exit(SELF_UPDATE_EXIT_CODE);
    } catch (err) {
      if (job.switched) {
        this.log.error("runtime self-update: the exit after the switch failed", {
          error: scrubHostPaths(errorMessage(err)),
        });
        return;
      }
      const sentence =
        err instanceof SelfUpdateError ? err.message : SELF_UPDATE_FAILURE_SENTENCES.switch_failed;
      this.log.warn("runtime self-update failed", {
        error: sentence,
        ...(err instanceof SelfUpdateError && err.detail ? { detail: err.detail } : {}),
        ...(err instanceof SelfUpdateError ? {} : { detail: scrubHostPaths(errorMessage(err)) }),
      });
      this.end(job, "failed", sentence);
    } finally {
      if (!job.switched) {
        if (!job.ended) this.end(job, "failed", SELF_UPDATE_FAILURE_SENTENCES.switch_failed);
        await this.releaseLock(job);
      }
    }
  }

  /** Resolves once every gate is closed on an idle device (D-04, PD-09). */
  private hold(job: Job): Promise<void> {
    return new Promise<void>((resolve) => {
      const step = () => {
        job.timer = null;
        if (job.ended) return resolve();
        if (this.closeAllIfIdle()) {
          job.holding = true;
          return resolve();
        }
        job.pendingSince ??= this.now();
        this.setState("waiting");
        job.timer = this.setTimer(step, this.opts.pollMs ?? DRAIN_POLL_MS);
      };
      step();
    });
  }

  /** One synchronous step: every gate admits nothing and every runtime runs nothing → every gate closes. */
  private closeAllIfIdle(): boolean {
    if (!this.allIdle()) return false;
    for (const gate of this.opts.gates.values()) gate.close();
    return true;
  }

  private allIdle(): boolean {
    for (const [id, gate] of this.opts.gates) {
      if (gate.admitted > 0 || this.opts.activeTurns(id) > 0) return false;
    }
    return true;
  }

  private openAll(): void {
    for (const gate of this.opts.gates.values()) gate.open();
  }

  private async releaseLock(job: Job): Promise<void> {
    const lock = job.lock;
    job.lock = null;
    if (!lock) return;
    await lock
      .release()
      .catch((err: unknown) =>
        this.log.warn("could not release the self-update lock", { error: scrubHostPaths(errorMessage(err)) }),
      );
  }

  /**
   * Ends a job that did not switch: every gate it closed reopens, the `finished` frame (when `outcome` is set) and the
   * last run are recorded, state back to idle. Idempotent; the lock is released by the job's own `finally`.
   */
  private end(job: Job, outcome: RuntimeUpdateOutcome | null, error?: string): void {
    if (job.ended || job.switched) return;
    job.ended = true;
    if (job.timer !== null) this.clearTimer(job.timer);
    job.timer = null;
    job.abort.abort();
    if (job.holding) {
      job.holding = false;
      this.openAll();
    }
    if (outcome !== null) {
      const running = this.opts.running;
      const frame = this.frameBase(job, running);
      const at = new Date(this.now()).toISOString();
      this.lastRun = {
        runId: job.runId,
        outcome,
        at,
        fromVersion: frame.fromVersion,
        toVersion: frame.toVersion,
        fromBuild: frame.fromBuild,
        toBuild: frame.toBuild,
      };
      this.sendRun({
        ...frame,
        phase: "finished",
        outcome,
        ...(error ? { output: runOutputForFrame("", error) } : {}),
        at,
      });
    }
    if (this.job === job) this.job = null;
    this.state = "idle";
    this.safePublish();
  }

  private frameBase(job: Job, running: { version: string; sha256: string } | null) {
    const m = job.manifest;
    return {
      type: "runtime.update.run" as const,
      runId: job.runId,
      runtime: "ocw-runtime" as const,
      trigger: job.trigger,
      ...(job.commandId ? { commandId: job.commandId } : {}),
      fromVersion: running?.version ?? null,
      toVersion: m?.version ?? null,
      candidate: m?.version ?? null,
      method: "ocw_bundle" as const,
      fromBuild: running ? runtimeBuildOf(running.sha256) : null,
      toBuild: m ? runtimeBuildOf(m.sha256) : null,
    };
  }

  private sendStarted(job: Job, running: { version: string; sha256: string }): void {
    job.started = true;
    this.sendRun({
      ...this.frameBase(job, running),
      phase: "started",
      at: new Date(this.now()).toISOString(),
    });
  }

  private sendRun(frame: RuntimeUpdateRunFrame): void {
    const parsed = RuntimeUpdateRunFrame.safeParse(frame);
    if (parsed.success) {
      this.opts.sendRun(parsed.data);
      return;
    }
    // Never drop an audit record for an output detail: resend without the output.
    const { output: _dropped, ...rest } = frame;
    const retry = RuntimeUpdateRunFrame.safeParse(rest);
    if (retry.success) this.opts.sendRun(retry.data);
    else this.log.warn("runtime self-update run frame rejected", { phase: frame.phase });
  }

  private setState(next: RuntimeSelfUpdateState): void {
    if (this.state === next) return;
    this.state = next;
    this.safePublish();
  }

  private safePublish(): void {
    try {
      this.opts.publish();
    } catch (err) {
      this.log.warn("runtime self-update publish failed", { error: scrubHostPaths(errorMessage(err)) });
    }
  }

  // ---- status (PD-25) ----

  /** What the device reports about its own runtime (`runtime.maintenance.self`): strict, no path. */
  status(): RuntimeSelfStatus {
    const { running, supervision } = this.opts;
    const reason: RuntimeSelfBlock | null =
      running === null ? (supervision.reason ?? "not_installed") : supervision.reason;
    const served = this.served;
    const status = {
      version: running?.version ?? this.opts.version ?? DEV_RUNTIME_VERSION,
      build: running ? runtimeBuildOf(running.sha256) : null,
      supervised: supervision.supervised,
      canUpdate: supervision.supervised && reason === null && running !== null,
      reason,
      servedVersion: served?.version ?? null,
      servedBuild: served ? runtimeBuildOf(served.sha256) : null,
      state: this.state,
      pendingSince:
        this.job?.pendingSince !== null && this.job?.pendingSince !== undefined
          ? new Date(this.job.pendingSince).toISOString()
          : null,
      lastRun: this.lastRun,
      checkedAt: this.checkedAt === null ? null : new Date(this.checkedAt).toISOString(),
    };
    const parsed = RuntimeSelfStatus.safeParse(status);
    if (parsed.success) return parsed.data;
    // Only the version comes from outside this class (the build define): never let it break the snapshot.
    this.log.warn("runtime self status rejected", {});
    return RuntimeSelfStatus.parse({ ...status, version: DEV_RUNTIME_VERSION });
  }
}
