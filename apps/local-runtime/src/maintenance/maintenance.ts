// Phase 07.11 (runtime CLI auto-updates, D-02, D-03, D-04, D-07, D-09, D-10, PD-07, PD-08, PD-10, PD-11): the
// orchestrator that keeps the Claude Code and Codex CLIs this daemon drives up to date, by itself.
//
// Per runtime it resolves how the CLI is installed (fresh on every check, Pitfall 11), asks the npm registry for the
// channel's latest unless the effective level is `off` (no request at all then), compares with the compatibility
// manifest (the newer of the bundled copy and the Control Plane's), and with the effective level `automatic` (the
// lower of the org's and this device's; `notify` until a `runtime.config` arrived, D-10) installs a newer, not broken
// candidate when the runtime is idle: gate closed in the same tick as the idle check → idle CLI processes retired →
// the one command from the fixed table (`runUpdate`) → install re-read → gate opened → `runtime.update.run` finished
// and a fresh `runtime.maintenance` snapshot. Nothing here ever interrupts a turn (D-03).
//
// PD-19: with `requireScratchHome` (fake-CLI mode and tests) an install whose real path is outside the scratch user
// home is never run: the run ends `failed` ("refused outside a scratch home").
//
// No host path leaves the device: statuses carry only `publicInstallFields` and are validated with the contract
// before they are sent; run output is already sanitised by the runner and is scrubbed and cut again here.

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { sep } from "node:path";
import {
  compareRuntimeVersions,
  compatibilityOf,
  effectiveRuntimeUpdatesLevel,
  newerManifest,
  RUNTIME_COMPATIBILITY_MANIFEST,
  type RuntimeCompatibilityManifest,
  type RuntimeId,
  type RuntimeInfo,
  type RuntimeLastRun,
  type RuntimeMaintenanceFrame,
  type RuntimeMaintenanceState,
  RuntimeMaintenanceStatus,
  type RuntimeUpdateOutcome,
  RuntimeUpdateRunFrame,
  type RuntimeUpdatesLevel,
  type RuntimeUpdatesLevelSource,
  type RuntimeUpdateTrigger,
  scrubHostPaths,
  type UpdateAdvisory,
  type UpdateChannel,
} from "@ocw/contracts";
import { errorMessage, type Logger, silentLogger } from "../logger.js";
import type { AgentRuntime } from "../runtime.js";
import type { RuntimeGate } from "./gate.js";
import { type InstallResolution, resolveInstall } from "./install-method.js";
import { RegistryClient } from "./registry.js";
import {
  defaultLockDir,
  probeVersion,
  type RunProgress,
  type RunResult,
  type RunUpdateOptions,
  runUpdate,
} from "./runner.js";

/** A registry check every 6 h (± 30 min of jitter so a fleet does not ask at once). */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
export const CHECK_JITTER_MS = 30 * 60 * 1000;
/** An automatic update waits this long for an idle moment with the gate open, then drains (PD-07). */
export const DRAIN_AFTER_MS = 60 * 60 * 1000;
/** A pending update that has found no idle moment for this long is reported `stale` (PD-07). */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** After an `unchanged` run the same (runtime, candidate) is not retried automatically for this long (PD-08). */
export const UNCHANGED_BACKOFF_MS = 24 * 60 * 60 * 1000;
/** After a `failed` automatic run the same candidate waits for the next scheduled check. */
export const FAILED_BACKOFF_MS = CHECK_EVERY_MS;
/** How often a pending update looks for an idle moment besides the runtime's own activity. */
export const PENDING_POLL_MS = 5_000;
/**
 * A paired daemon waits this long for the server's `runtime.config` before its first registry request, so an
 * organization at `off` never sees one (D-02); an unpaired daemon checks at once (`notify`, D-10).
 */
export const ORG_LEVEL_GRACE_MS = 30_000;
/** What a run frame may carry of the installer's output (PD-11). */
export const MAX_RUN_OUTPUT_CHARS = 4096;

export const REFUSED_OUTSIDE_SCRATCH_HOME = "refused outside a scratch home";

/** The adapter surface the orchestrator uses: it never prompts, interrupts or stops anything. */
export type MaintainedRuntime = Pick<AgentRuntime, "id" | "activeTurns" | "retireIdle" | "refreshInstall">;

/** Where the channel's latest version comes from (the registry client, or a test double). */
export interface LatestVersionSource {
  latest(runtime: RuntimeId, tag: UpdateChannel): Promise<string | null>;
}

export type TimerHandle = unknown;

export interface RuntimeMaintenanceOptions {
  runtimes: readonly MaintainedRuntime[];
  /** One gate per runtime (05); the daemon admits held commands through the same instances. */
  gates: ReadonlyMap<RuntimeId, RuntimeGate>;
  /** The daemon user's home (`os.homedir()`; the scratch `HOME` in fake-CLI mode and tests). */
  userHome: string;
  /** The daemon's environment (PATH for the lookup, `OCW_RUNTIME_REGISTRY_URL`, the installer's base env). */
  env: NodeJS.ProcessEnv;
  /** `config.<runtime>.path` when the owner pinned one. */
  configuredPaths?: Partial<Record<RuntimeId, string>>;
  /** PATH lookup override (tests scope it to a scratch directory). */
  which?: (name: string) => string | null;
  /** Cached latest-version lookups (default: `RegistryClient` on the daemon's env). */
  registry?: LatestVersionSource;
  /** Uncached lookups for "Update now" (default: `RegistryClient` with no cache). */
  freshRegistry?: LatestVersionSource;
  /** The install lock directory (default `defaultLockDir(userHome)`). */
  lockDir?: string;
  /** PD-19: refuse any install whose real path is outside `userHome` (fake-CLI mode and tests). */
  requireScratchHome?: boolean;
  localLevel?: RuntimeUpdatesLevel;
  localLevelSource?: RuntimeUpdatesLevelSource;
  /** How long a paired daemon waits for `runtime.config` before its first registry request. */
  orgLevelGraceMs?: number;
  drainAfterMs?: number;
  staleAfterMs?: number;
  pollMs?: number;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  log?: Logger;
  /** Test seams: install resolution, version probe and the runner. */
  resolve?: (runtime: RuntimeId) => InstallResolution;
  probe?: (binPath: string) => Promise<string | null>;
  run?: (opts: RunUpdateOptions) => Promise<RunResult>;
  /** The daemon's detected runtimes for the snapshot (`fresh` drops its cache first). */
  runtimeInfo?: (opts: { fresh: boolean }) => Promise<RuntimeInfo[]>;
  /** Sends a `runtime.maintenance` snapshot (the daemon sends it only while connected). */
  sendSnapshot?: (frame: RuntimeMaintenanceFrame) => void;
  /** Sends a `runtime.update.run` frame (the daemon queues it in the offline log when disconnected). */
  sendRun?: (frame: RuntimeUpdateRunFrame) => void;
  /** Tells the sessions held by this update how it ended (D-03). */
  notifySession?: (runtime: RuntimeId, phase: "done" | "failed", version?: string) => void;
  /** After a run: the daemon drops its caches and sends fresh `capabilities`. */
  afterRun?: (runtime: RuntimeId) => Promise<void> | void;
}

interface Job {
  trigger: RuntimeUpdateTrigger;
  candidate: string;
  commandId?: string;
  /** "Update now" drains at once; an automatic update first waits for an idle moment (PD-07). */
  drainNow: boolean;
}

interface RuntimeState {
  resolution: InstallResolution | null;
  installedVersion: string | null;
  latestVersion: string | null;
  checkedAt: number | null;
  state: RuntimeMaintenanceState;
  pendingSince: number | null;
  stale: boolean;
  lastRun: RuntimeLastRun | null;
  job: Job | null;
  /** candidate → no automatic retry before this time. */
  backoff: Map<string, number>;
  /** Broken candidates already reported once (D-04). */
  skippedBroken: Set<string>;
  pollTimer: TimerHandle | null;
}

const RUNTIME_ORDER: readonly RuntimeId[] = ["claude-code", "codex"];

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** At most `MAX_RUN_OUTPUT_CHARS`, cut from the start, scrubbed again so a cut can never leave a path behind. */
export function runOutputForFrame(output: string): string {
  return scrubHostPaths(output.slice(0, MAX_RUN_OUTPUT_CHARS)).slice(0, MAX_RUN_OUTPUT_CHARS);
}

export class RuntimeMaintenance {
  private readonly runtimes: MaintainedRuntime[];
  private readonly states = new Map<RuntimeId, RuntimeState>();
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly registry: LatestVersionSource;
  private readonly lockDir: string;
  private manifest: RuntimeCompatibilityManifest = RUNTIME_COMPATIBILITY_MANIFEST;
  private orgLevel: RuntimeUpdatesLevel | null = null;
  private local: { level: RuntimeUpdatesLevel; source: RuntimeUpdatesLevelSource };
  /** False until `runtime.config` arrived or the grace period passed (paired daemons). */
  private registryAllowed = false;
  private started = false;
  private stopped = false;
  private checking: Promise<void> | null = null;
  private checkAgain = false;
  private checkTimer: TimerHandle | null = null;
  private graceTimer: TimerHandle | null = null;
  private lastPublished = "";

  constructor(private readonly opts: RuntimeMaintenanceOptions) {
    this.runtimes = [...opts.runtimes].sort(
      (a, b) => RUNTIME_ORDER.indexOf(a.id) - RUNTIME_ORDER.indexOf(b.id),
    );
    for (const r of this.runtimes) {
      this.states.set(r.id, {
        resolution: null,
        installedVersion: null,
        latestVersion: null,
        checkedAt: null,
        state: "idle",
        pendingSince: null,
        stale: false,
        lastRun: null,
        job: null,
        backoff: new Map(),
        skippedBroken: new Set(),
        pollTimer: null,
      });
    }
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
    this.registry = opts.registry ?? new RegistryClient({ env: opts.env });
    this.lockDir = opts.lockDir ?? defaultLockDir(opts.userHome);
    this.local = { level: opts.localLevel ?? "automatic", source: opts.localLevelSource ?? "config" };
  }

  // ---- levels (D-02, D-10) ----

  get localLevel(): RuntimeUpdatesLevel {
    return this.local.level;
  }

  get localLevelSource(): RuntimeUpdatesLevelSource {
    return this.local.source;
  }

  get orgLevelReceived(): boolean {
    return this.orgLevel !== null;
  }

  get effectiveLevel(): RuntimeUpdatesLevel {
    return effectiveRuntimeUpdatesLevel(this.orgLevel, this.local.level);
  }

  /** The server's `runtime.config` (PD-03): its level, and the newer of our manifest and its. */
  setOrgPolicy(level: RuntimeUpdatesLevel, manifest: RuntimeCompatibilityManifest): void {
    this.orgLevel = level;
    this.manifest = newerManifest(this.manifest, manifest);
    this.allowRegistry();
    if (this.started) void this.check();
  }

  /** This device's own level (runtime.json or `OCW_RUNTIME_UPDATES`, D-02). */
  setLocalLevel(level: RuntimeUpdatesLevel, source: RuntimeUpdatesLevelSource): void {
    const changed = level !== this.local.level || source !== this.local.source;
    this.local = { level, source };
    if (changed && this.started) void this.check();
  }

  // ---- lifecycle ----

  /**
   * Checks now (install and version only until the registry is allowed), then every `CHECK_EVERY_MS ±
   * CHECK_JITTER_MS`. A paired daemon waits up to `orgLevelGraceMs` for `runtime.config` before asking the registry.
   */
  start(opts: { paired: boolean }): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    if (!opts.paired) this.registryAllowed = true;
    else if (!this.registryAllowed) {
      this.graceTimer = this.setTimer(() => {
        this.graceTimer = null;
        this.allowRegistry();
        void this.check();
      }, this.opts.orgLevelGraceMs ?? ORG_LEVEL_GRACE_MS);
    }
    void this.check();
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    for (const h of [this.checkTimer, this.graceTimer]) if (h !== null) this.clearTimer(h);
    this.checkTimer = null;
    this.graceTimer = null;
    for (const st of this.states.values()) this.clearPoll(st);
  }

  private allowRegistry(): void {
    this.registryAllowed = true;
    if (this.graceTimer !== null) {
      this.clearTimer(this.graceTimer);
      this.graceTimer = null;
    }
  }

  private scheduleNextCheck(): void {
    if (this.stopped) return;
    if (this.checkTimer !== null) this.clearTimer(this.checkTimer);
    const delay = CHECK_EVERY_MS + Math.round((this.random() * 2 - 1) * CHECK_JITTER_MS);
    this.checkTimer = this.setTimer(() => {
      this.checkTimer = null;
      void this.check();
    }, delay);
  }

  // ---- checks ----

  /** One check of every runtime (serialised: a check asked for while one runs runs once more after it). */
  check(): Promise<void> {
    if (this.checking) {
      this.checkAgain = true;
      return this.checking;
    }
    const run = (async () => {
      try {
        do {
          this.checkAgain = false;
          await this.checkOnce();
        } while (this.checkAgain && !this.stopped);
      } finally {
        this.checking = null;
      }
    })();
    this.checking = run;
    return run;
  }

  private resolve(runtime: RuntimeId): InstallResolution {
    if (this.opts.resolve) return this.opts.resolve(runtime);
    const configuredPath = this.opts.configuredPaths?.[runtime];
    return resolveInstall(runtime, {
      home: this.opts.userHome,
      env: this.opts.env,
      ...(configuredPath ? { configuredPath } : {}),
      ...(this.opts.which ? { which: this.opts.which } : {}),
    });
  }

  private probe(binPath: string): Promise<string | null> {
    return (this.opts.probe ?? ((p: string) => probeVersion(p)))(binPath).catch(() => null);
  }

  private async checkOnce(): Promise<void> {
    const level = this.effectiveLevel;
    const askRegistry = level !== "off" && this.registryAllowed;
    for (const r of this.runtimes) {
      const st = this.stateOf(r.id);
      // A run in progress owns its resolution; the next check after it re-reads everything.
      if (st.state !== "idle" && st.state !== "pending") continue;
      try {
        const resolution = this.resolve(r.id);
        st.resolution = resolution;
        st.installedVersion = resolution.binPath ? await this.probe(resolution.binPath) : null;
        if (level === "off") {
          st.latestVersion = null;
          st.checkedAt = null;
        } else if (askRegistry && st.installedVersion !== null) {
          st.latestVersion = await this.registry.latest(r.id, resolution.channel);
          st.checkedAt = this.now();
        }
      } catch (err) {
        this.log.warn("runtime update check failed", { runtime: r.id, error: errorMessage(err) });
      }
    }
    if (askRegistry) this.scheduleNextCheck();
    this.evaluate();
    await this.publish(false);
  }

  private stateOf(runtime: RuntimeId): RuntimeState {
    const st = this.states.get(runtime);
    if (!st) throw new Error(`runtime ${runtime} is not maintained on this device`);
    return st;
  }

  private advisory(st: RuntimeState): UpdateAdvisory {
    if (st.installedVersion === null || st.latestVersion === null) return "unknown";
    return compareRuntimeVersions(st.latestVersion, st.installedVersion) > 0 ? "behind" : "current";
  }

  /** Starts (or drops) automatic updates from the last check's data (PD-08). */
  private evaluate(): void {
    const automatic = this.effectiveLevel === "automatic";
    for (const r of this.runtimes) {
      const st = this.stateOf(r.id);
      if (!automatic) {
        // A lowered level drops an automatic update that has not started draining yet.
        if (st.state === "pending" && st.job?.trigger === "automatic") this.dropJob(st);
        continue;
      }
      if (st.state !== "idle" || st.job) continue;
      if (!st.resolution?.canUpdate || this.advisory(st) !== "behind" || st.latestVersion === null) continue;
      const candidate = st.latestVersion;
      if (compatibilityOf(this.manifest, r.id, candidate) === "broken") {
        this.skipBroken(r.id, st, candidate);
        continue;
      }
      if ((st.backoff.get(candidate) ?? 0) > this.now()) continue;
      st.job = { trigger: "automatic", candidate, drainNow: false };
      st.state = "pending";
      st.pendingSince = this.now();
      this.attempt(r.id);
    }
  }

  /** D-04: a broken candidate is never installed; one `skipped_broken` run frame per candidate. */
  private skipBroken(runtime: RuntimeId, st: RuntimeState, candidate: string): void {
    if (st.skippedBroken.has(candidate)) return;
    st.skippedBroken.add(candidate);
    this.sendRun({
      type: "runtime.update.run",
      runId: randomUUID(),
      runtime,
      trigger: "automatic",
      phase: "finished",
      outcome: "skipped_broken",
      fromVersion: st.installedVersion,
      toVersion: null,
      candidate,
      method: st.resolution?.method ?? "unknown",
      at: new Date(this.now()).toISOString(),
    });
  }

  private dropJob(st: RuntimeState): void {
    this.clearPoll(st);
    st.job = null;
    st.state = "idle";
    st.pendingSince = null;
    st.stale = false;
  }

  private clearPoll(st: RuntimeState): void {
    if (st.pollTimer !== null) this.clearTimer(st.pollTimer);
    st.pollTimer = null;
  }

  // ---- the run (D-03, PD-07, PD-11) ----

  /** Takes the first idle moment: the gate closes in the same tick as the idle check, or the update tries again later. */
  private attempt(runtime: RuntimeId): void {
    const st = this.stateOf(runtime);
    if (this.stopped || !st.job || st.state !== "pending") return;
    const adapter = this.adapterOf(runtime);
    const gate = this.gateOf(runtime);
    if (gate.closeIfIdle(() => adapter.activeTurns())) {
      this.clearPoll(st);
      void this.runJob(runtime);
      return;
    }
    if (st.pollTimer === null) {
      st.pollTimer = this.setTimer(() => {
        st.pollTimer = null;
        this.attempt(runtime);
      }, this.opts.pollMs ?? PENDING_POLL_MS);
    }
  }

  private adapterOf(runtime: RuntimeId): MaintainedRuntime {
    const r = this.runtimes.find((x) => x.id === runtime);
    if (!r) throw new Error(`runtime ${runtime} is not maintained on this device`);
    return r;
  }

  private gateOf(runtime: RuntimeId): RuntimeGate {
    const g = this.opts.gates.get(runtime);
    if (!g) throw new Error(`runtime ${runtime} has no gate`);
    return g;
  }

  /** PD-19: in scratch mode the install must live under the scratch home, and that home is not the OS user's. */
  private insideScratchHome(resolution: InstallResolution): boolean {
    const home = realpathOr(this.opts.userHome);
    let osHome: string | null = null;
    try {
      osHome = realpathOr(userInfo().homedir);
    } catch {
      osHome = null;
    }
    if (osHome !== null && home === osHome) return false;
    const real = resolution.realPath;
    const root = resolution.installRoot;
    return real !== null && root !== null && within(real, home) && within(realpathOr(root), home);
  }

  /** The gate is closed and the runtime idle: retire, update, re-read, reopen, report. */
  private async runJob(runtime: RuntimeId): Promise<void> {
    const st = this.stateOf(runtime);
    const job = st.job;
    const gate = this.gateOf(runtime);
    if (!job) {
      gate.open();
      return;
    }
    const adapter = this.adapterOf(runtime);
    const runId = randomUUID();
    let resolution: InstallResolution;
    try {
      resolution = this.resolve(runtime);
    } catch (err) {
      resolution = st.resolution ?? this.notInstalled(runtime);
      this.log.warn("runtime update could not re-resolve the install", { runtime, error: errorMessage(err) });
    }
    const fromVersion = st.installedVersion;
    st.state = "running";
    const base = {
      type: "runtime.update.run" as const,
      runId,
      runtime,
      trigger: job.trigger,
      ...(job.commandId ? { commandId: job.commandId } : {}),
      candidate: job.candidate,
      method: resolution.method,
    };
    this.sendRun({
      ...base,
      phase: "started",
      fromVersion,
      toVersion: null,
      at: new Date(this.now()).toISOString(),
    });
    void this.publish(true);

    let result: RunResult;
    try {
      if (this.opts.requireScratchHome && !this.insideScratchHome(resolution)) {
        this.log.warn("runtime update refused: the install is outside the scratch home", { runtime });
        result = {
          outcome: "failed",
          fromVersion,
          toVersion: null,
          output: "",
          error: REFUSED_OUTSIDE_SCRATCH_HOME,
        };
      } else {
        await adapter.retireIdle();
        result = await (this.opts.run ?? runUpdate)({
          resolution,
          candidate: job.candidate,
          lockDir: this.lockDir,
          home: this.opts.userHome,
          env: this.opts.env,
          onProgress: (p: RunProgress) => {
            if (st.state === p.state) return;
            st.state = p.state;
            void this.publish(true);
          },
        });
      }
    } catch (err) {
      result = { outcome: "failed", fromVersion, toVersion: null, output: "", error: errorMessage(err) };
    }
    try {
      adapter.refreshInstall?.();
    } catch (err) {
      this.log.warn("runtime adapter could not refresh its install", { runtime, error: errorMessage(err) });
    }

    const outcome: RuntimeUpdateOutcome = result.outcome;
    const at = new Date(this.now()).toISOString();
    const from = result.fromVersion ?? fromVersion;
    st.lastRun = { runId, outcome, at, fromVersion: from, toVersion: result.toVersion };
    if (result.toVersion !== null) st.installedVersion = result.toVersion;
    if (outcome === "unchanged") st.backoff.set(job.candidate, this.now() + UNCHANGED_BACKOFF_MS);
    if (outcome === "failed" && job.trigger === "automatic") {
      st.backoff.set(job.candidate, this.now() + FAILED_BACKOFF_MS);
    }
    try {
      st.resolution = this.resolve(runtime);
    } catch {
      // keep the last resolution
    }
    this.dropJob(st);
    gate.open();
    try {
      this.opts.notifySession?.(
        runtime,
        outcome === "failed" ? "failed" : "done",
        st.installedVersion ?? undefined,
      );
    } catch (err) {
      this.log.warn("could not tell the held sessions", { runtime, error: errorMessage(err) });
    }
    const text = [result.error, result.output].filter((s): s is string => !!s).join("\n");
    const output = text ? runOutputForFrame(text) : "";
    this.sendRun({
      ...base,
      phase: "finished",
      outcome,
      fromVersion: from,
      toVersion: result.toVersion,
      ...(output ? { output } : {}),
      at,
    });
    await this.publish(true, true);
    try {
      await this.opts.afterRun?.(runtime);
    } catch (err) {
      this.log.warn("after-update refresh failed", { runtime, error: errorMessage(err) });
    }
  }

  private notInstalled(runtime: RuntimeId): InstallResolution {
    return {
      runtime,
      method: "unknown",
      binPath: null,
      realPath: null,
      installRoot: null,
      location: null,
      canUpdate: false,
      reason: null,
      display: null,
      note: null,
      channel: "latest",
    };
  }

  private sendRun(frame: RuntimeUpdateRunFrame): void {
    const parsed = RuntimeUpdateRunFrame.safeParse(frame);
    if (!parsed.success) {
      // Never drop an audit record for an output detail: resend without the output.
      const { output: _dropped, ...rest } = frame;
      const retry = RuntimeUpdateRunFrame.safeParse(rest);
      if (!retry.success) {
        this.log.warn("runtime update run frame rejected", { runtime: frame.runtime });
        return;
      }
      this.opts.sendRun?.(retry.data);
      return;
    }
    this.opts.sendRun?.(parsed.data);
  }

  // ---- snapshots (PD-03, D-06) ----

  private statusOf(runtime: RuntimeId, st: RuntimeState): RuntimeMaintenanceStatus {
    const r = st.resolution;
    return {
      runtime,
      installedVersion: st.installedVersion,
      method: r?.method ?? "unknown",
      location: r?.location ?? null,
      canUpdate: r?.canUpdate ?? false,
      reason: r?.reason ?? null,
      updateCommand: r?.display ?? null,
      channel: r?.channel ?? "latest",
      latestVersion: st.latestVersion,
      advisory: this.advisory(st),
      installedCompatibility: compatibilityOf(this.manifest, runtime, st.installedVersion),
      candidateCompatibility: compatibilityOf(this.manifest, runtime, st.latestVersion),
      state: st.state,
      pendingSince: st.pendingSince === null ? null : new Date(st.pendingSince).toISOString(),
      stale: st.stale,
      lastRun: st.lastRun,
      checkedAt: st.checkedAt === null ? null : new Date(st.checkedAt).toISOString(),
    };
  }

  /** Every maintained runtime's status, each validated with the contract (an invalid one is left out and logged). */
  statuses(): RuntimeMaintenanceStatus[] {
    const out: RuntimeMaintenanceStatus[] = [];
    for (const r of this.runtimes) {
      const parsed = RuntimeMaintenanceStatus.safeParse(this.statusOf(r.id, this.stateOf(r.id)));
      if (parsed.success) out.push(parsed.data);
      else this.log.warn("runtime maintenance status rejected", { runtime: r.id });
    }
    return out;
  }

  /** The `runtime.maintenance` frame (handshake and on change). */
  async snapshot(opts: { fresh?: boolean } = {}): Promise<RuntimeMaintenanceFrame> {
    let runtimeInfo: RuntimeInfo[] = [];
    try {
      runtimeInfo = (await this.opts.runtimeInfo?.({ fresh: opts.fresh === true })) ?? [];
    } catch {
      runtimeInfo = [];
    }
    return {
      type: "runtime.maintenance",
      runtimes: this.statuses(),
      runtimeInfo: runtimeInfo.slice(0, 4),
      localLevel: this.local.level,
      localLevelSource: this.local.source,
      effectiveLevel: this.effectiveLevel,
      orgLevelReceived: this.orgLevelReceived,
    };
  }

  /** Sends a snapshot when something changed (or always, for state transitions). */
  private async publish(force: boolean, fresh = false): Promise<void> {
    if (!this.opts.sendSnapshot) return;
    const key = JSON.stringify([this.statuses(), this.local, this.effectiveLevel, this.orgLevelReceived]);
    if (!force && key === this.lastPublished) return;
    this.lastPublished = key;
    try {
      this.opts.sendSnapshot(await this.snapshot({ fresh }));
    } catch (err) {
      this.log.warn("runtime maintenance snapshot failed", { error: errorMessage(err) });
    }
  }
}
