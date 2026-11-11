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
import { DEV_RUNTIME_VERSION, RUNTIME_VERSION } from "../version.js";
import type { RuntimeGate } from "./gate.js";
import {
  CANCELLED_OFF,
  CANCELLED_STOPPED,
  CHECK_EVERY_MS,
  CHECK_JITTER_MS,
  DRAIN_AFTER_MS,
  DRAIN_POLL_MS,
  FAILED_BACKOFF_MS,
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
import type { SelfUpdateBoot } from "./self-update-boot.js";

/** The answers a request gets when this device will not run it (the ack's error text). */
export const SELF_UPDATE_REFUSALS = {
  busy: "an update of the OCW runtime is already running",
  not_installed: RUNTIME_SELF_BLOCK_SENTENCES.not_installed,
  not_supervised: RUNTIME_SELF_BLOCK_SENTENCES.not_supervised,
  node_too_old: RUNTIME_SELF_BLOCK_SENTENCES.node_too_old,
  stopping: "the runtime is stopping",
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
  /** The daemon's version when `running` is null (a checkout, the desktop app; default `RUNTIME_VERSION`). */
  version?: string;
  execPath?: string;
  nodeVersion?: string;
  /** An automatic update waits this long for an idle moment with every gate open, then drains (`DRAIN_AFTER_MS`). */
  drainAfterMs?: number;
  /** How often a waiting update re-checks the gates (default `DRAIN_POLL_MS`). */
  pollMs?: number;
  /** The automatic and `notify` check cadence (`CHECK_EVERY_MS` ± `CHECK_JITTER_MS`, the 07.11 one). */
  checkEveryMs?: number;
  /** A failed automatic run of a build is not retried automatically for this long (`FAILED_BACKOFF_MS`). */
  failedBackoffMs?: number;
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
  /** Resolves a pending `hold()` (the job ended while it waited). */
  wake: (() => void) | null;
  abort: AbortController;
}

const isUuid = (id: string | undefined): id is string => !!id && z.uuid().safeParse(id).success;

export class SelfUpdate {
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly locks: InstallLocks;
  private state: RuntimeSelfUpdateState = "idle";
  private job: Job | null = null;
  private lastRun: RuntimeSelfLastRun | null = null;
  private served: { version: string; sha256: string } | null = null;
  private checkedAt: number | null = null;
  private readonly knownCommands = new Set<string>();
  /** Served build (sha256) → no automatic run of it before this time (PD-10). */
  private readonly backoff = new Map<string, number>();
  private started = false;
  private stopped = false;
  private checking = false;
  private checkTimer: TimerHandle | null = null;

  constructor(private readonly opts: SelfUpdateOptions) {
    this.log = opts.log ?? silentLogger;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
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

  /**
   * The daemon stops. Before the switch the job is cancelled: every gate reopens, the lock goes back (once nothing is
   * being prepared under it), and the run is closed `finished failed` "cancelled: the runtime stopped" (an automatic
   * run nothing announced yet ends silently). From the switch on (`restarting`) nothing is sent, reopened or released:
   * the exit hand-over owns the gates and the lock, and the next daemon reports the run from the marker (E29).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.checkTimer !== null) this.clearTimer(this.checkTimer);
    this.checkTimer = null;
    const job = this.job;
    if (!job || job.switching || job.ended) return;
    const preparing = this.state === "downloading" || this.state === "installing";
    this.end(job, job.started || job.trigger === "manual" ? "failed" : null, CANCELLED_STOPPED);
    // A prepare still running under the lock releases it when it settles (the job's own `finally`).
    if (!preparing) await this.releaseLock(job);
  }

  /**
   * An update request: a click (`manual`, with the command's id, at any level, D-09) or the automatic decision. The
   * answer comes before anything is fetched; the run reports itself through `runtime.update.run` frames.
   */
  async request(trigger: Trigger, commandId?: string): Promise<UpdateRequestAnswer> {
    const refuse = (reason: string): UpdateRequestAnswer => ({ accepted: false, reason });
    if (this.stopped) return refuse(SELF_UPDATE_REFUSALS.stopping);
    if (this.job) return refuse(SELF_UPDATE_REFUSALS.busy);
    // The device re-decides what the API decided from its snapshot (PD-11): nothing is fetched when it cannot update.
    const { running, supervision } = this.opts;
    if (!running || supervision.reason === "not_installed") return refuse(SELF_UPDATE_REFUSALS.not_installed);
    if (supervision.reason !== null) return refuse(SELF_UPDATE_REFUSALS[supervision.reason]);
    if (!supervision.supervised) return refuse(SELF_UPDATE_REFUSALS.not_supervised);
    if (commandId) this.knownCommands.add(commandId);
    this.begin(trigger, commandId, running, null);
    return { accepted: true };
  }

  /** The run the restart carried over (`reconcileSelfUpdate`, 07): its last run, and its command is known. */
  adoptBoot(boot: SelfUpdateBoot | null): void {
    if (!boot) return;
    this.lastRun = boot.lastRun;
    if (boot.marker.commandId) this.knownCommands.add(boot.marker.commandId);
    this.safePublish();
  }

  // ---- levels and cadence (D-06, D-09, D-11, PD-10) ----

  /**
   * Schedules the check every `checkEveryMs` ± `CHECK_JITTER_MS`. Each tick reads the level: `off` asks nothing (and
   * keeps the cadence, so a level raised later is followed), `notify` reports, `automatic` may run.
   */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.scheduleCheck();
  }

  /** A `runtime.config` arrived (connect, or the organization's level changed): check now unless the level is `off`. */
  async onConfig(): Promise<void> {
    await this.check();
  }

  private scheduleCheck(): void {
    if (this.stopped) return;
    if (this.checkTimer !== null) this.clearTimer(this.checkTimer);
    const every = this.opts.checkEveryMs ?? CHECK_EVERY_MS;
    const delay = Math.max(0, every + Math.round((this.random() * 2 - 1) * CHECK_JITTER_MS));
    this.checkTimer = this.setTimer(() => {
      this.checkTimer = null;
      void this.check();
      this.scheduleCheck();
    }, delay);
  }

  /** Whether this device asks its workspace anything: a runtime installed by the install command (PD-10). */
  private mayRequest(): boolean {
    return this.opts.running !== null && this.opts.supervision.reason !== "not_installed";
  }

  /** One check of what the workspace serves (never at `off`, never during a job, which fetches its own). */
  private async check(): Promise<void> {
    if (this.stopped || this.checking || this.job) return;
    if (this.opts.level() === "off" || !this.mayRequest()) return;
    this.checking = true;
    try {
      const manifest = await (this.opts.fetchManifest ?? fetchServedManifest)({
        serverUrl: this.opts.serverUrl,
        env: this.opts.env,
      });
      if (this.stopped) return;
      this.served = { version: manifest.version, sha256: manifest.sha256 };
      this.checkedAt = this.now();
      this.safePublish();
      this.decide(manifest);
    } catch (err) {
      this.log.warn("runtime self-update check failed", {
        error: err instanceof SelfUpdateError ? err.message : scrubHostPaths(errorMessage(err)),
      });
    } finally {
      this.checking = false;
    }
  }

  /**
   * `automatic` only: a served build other than the running one (newer or older, D-11) runs, unless it failed
   * automatically within `failedBackoffMs`, the device is not supervised, or a job exists.
   */
  private decide(manifest: RuntimeDistManifest): void {
    if (this.opts.level() !== "automatic" || this.job || this.stopped) return;
    const { running, supervision } = this.opts;
    if (!running || !supervision.supervised || supervision.reason !== null) return;
    if (manifest.sha256 === running.sha256) return;
    if ((this.backoff.get(manifest.sha256) ?? 0) > this.now()) return;
    this.begin("automatic", undefined, running, manifest);
  }

  // ---- the job ----

  private begin(
    trigger: Trigger,
    commandId: string | undefined,
    running: { version: string; sha256: string },
    manifest: RuntimeDistManifest | null,
  ): void {
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
      wake: null,
      abort: new AbortController(),
    };
    this.job = job;
    void this.run(job, running, manifest);
  }

  private async run(
    job: Job,
    running: { version: string; sha256: string },
    checked: RuntimeDistManifest | null,
  ): Promise<void> {
    try {
      // An automatic run uses the manifest its check just read; a click asks the workspace now.
      const manifest =
        checked ??
        (await (this.opts.fetchManifest ?? fetchServedManifest)({
          serverUrl: this.opts.serverUrl,
          env: this.opts.env,
          signal: job.abort.signal,
        }));
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
      // The daemon began stopping during the switch: its own stop ends the process (a `systemctl stop` must not turn
      // into a restart); `current` already names the new version and the next start reports the run from the marker.
      if (this.stopped) {
        this.log.info(
          "runtime self-update switched while the daemon stopped; the next start runs the new version",
        );
        return;
      }
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

  /**
   * The gate decision (D-04, PD-09). Resolves once every gate is closed by this job and every runtime is idle, so the
   * restart cuts nothing. Never closes a gate while a 07.11 CLI job is past `pending` (`cliBusy`). A click drains at
   * once (every gate closes, running turns finish, new turns wait); an automatic update first waits up to
   * `drainAfterMs` for a moment when everything is idle, closing every gate in that same synchronous step, then drains
   * like a click. State `waiting` until then.
   */
  private hold(job: Job): Promise<void> {
    job.pendingSince = this.now();
    return new Promise<void>((resolve) => {
      job.wake = resolve;
      const step = () => {
        job.timer = null;
        if (job.ended) return resolve();
        // The level is read at each decision: an automatic update ends when the level leaves `automatic` (PD-10).
        if (job.trigger === "automatic" && this.opts.level() !== "automatic") {
          this.end(job, "failed", CANCELLED_OFF);
          return resolve();
        }
        if (!job.holding && !this.opts.cliBusy()) {
          if (this.closeAllIfIdle()) job.holding = true;
          else if (job.trigger === "manual" || this.now() >= (job.pendingSince ?? 0) + this.drainAfterMs) {
            for (const gate of this.opts.gates.values()) gate.close();
            job.holding = true;
          }
        }
        if (job.holding && this.allIdle()) {
          job.wake = null;
          return resolve();
        }
        this.setState("waiting");
        job.timer = this.setTimer(step, this.opts.pollMs ?? DRAIN_POLL_MS);
      };
      step();
    });
  }

  private get drainAfterMs(): number {
    return this.opts.drainAfterMs ?? DRAIN_AFTER_MS;
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
    const wake = job.wake;
    job.wake = null;
    wake?.();
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
      // A failed automatic run of a build is not retried automatically for a while; a cancel is not its failure.
      const cancelled = error === CANCELLED_OFF || error === CANCELLED_STOPPED;
      if (outcome === "failed" && job.trigger === "automatic" && job.manifest && !cancelled) {
        this.backoff.set(job.manifest.sha256, this.now() + (this.opts.failedBackoffMs ?? FAILED_BACKOFF_MS));
      }
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
    // `served*` and `checkedAt` are this device's last check: none at `off` (the contract's reading).
    const off = this.opts.level() === "off";
    const served = off ? null : this.served;
    const status = {
      version: running?.version ?? this.opts.version ?? RUNTIME_VERSION,
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
      checkedAt: off || this.checkedAt === null ? null : new Date(this.checkedAt).toISOString(),
    };
    const parsed = RuntimeSelfStatus.safeParse(status);
    if (parsed.success) return parsed.data;
    // Only the version comes from outside this class (the build define): never let it break the snapshot.
    this.log.warn("runtime self status rejected", {});
    return RuntimeSelfStatus.parse({ ...status, version: DEV_RUNTIME_VERSION });
  }
}
