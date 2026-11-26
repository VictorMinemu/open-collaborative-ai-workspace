// The desktop app's own update (07.13.1, ADR-0046): when to check and download, the restart hold, and the one place an
// install starts. The platform updater (electron-updater's NSIS or AppImage updater, or the ad-hoc macOS updater) is
// injected; this module imports no Electron, so every decision is unit-tested with fakes.
//
// - The 07.11 level decides (D-08): `automatic` checks daily, downloads, installs on a normal quit and restarts by
//   itself only when the daemon holds without draining and the person has been away 30 min; `notify` checks and
//   downloads, and installs only after "Restart to update"; `off` never checks by itself. A click works at every level.
// - The app quits for an update only after the daemon answered `held` to `appUpdateHold` (or when no daemon of the
//   app's own runs: paused, stopped or external), so a Work Zone turn is never cut (D-07, Pitfall 3). Review CR-01:
//   a hold has an owner, its `holdId`; the app quits only on `held` for its own wait's id, releases only by id, and
//   sends its control requests one at a time, so a late answer or release never acts on a newer hold.
// - The install itself starts only in `onQuit()`, which the app calls from Electron's `quit` event, after `before-quit`
//   stopped the daemon.
// - The views (tray, Runtime menu, onboarding window) carry fixed sentences, versions, percentages and counts only:
//   never an updater error text, never a path (D-09).

import { AppUpdateHoldAnswer, DaemonAppUpdate, type OnboardingUpdate } from "../shared/ipc";
import { compareVersions, isReleasePageUrl } from "./update-check";

const RELEASE_TAG_URL = "https://github.com/VictorMinemu/open-collaborative-ai-workspace/releases/tag/v";
const STABLE_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;

/** The person has been away this long (system idle time) before an unattended restart (D-08). */
const AWAY_SECONDS = 1800;
/** A blocked or ended hold is asked again at most this often. */
const REASK_MS = 10_000;
/** The desktop's own bound on a wait, just past the daemon's 30-min drain (which answers `timed_out` first). */
const WAIT_BOUND_MS = 31 * 60_000;
const FIRST_CHECK_FALLBACK_MS = 60_000;
const CHECK_EVERY_MS = 24 * 60 * 60_000;
const IDLE_CHECK_MS = 60_000;

/** Fixed sentences: the only update text besides versions, percentages and counts that reaches a view. */
export const UPDATE_SENTENCES = {
  checkFailed: "Could not check for updates. Try again later.",
  checksumMismatch: "The downloaded update did not match its checksum and was discarded.",
  noUpdateFile: "This release has no update for this computer yet.",
  macPrepareFailed: "The update could not be prepared. Download it from the release page.",
  holdTimedOut: "Sessions were still running after 30 minutes, so OCW did not restart.",
  runtimeUnreachable: "The runtime did not answer, so OCW did not restart.",
  externalRuntime: "A runtime started from OCW's own folder is running. Stop it, then restart to update.",
  upToDate: "OCW is up to date.",
} as const;

/**
 * The subset of electron-updater's `AppUpdater` the controller calls, plus the macOS updater's `prepareDownloaded`
 * (stage and verify a downloaded bundle; plan 04), which runs before "Restart to update" is offered.
 */
export interface UpdaterLike {
  on(event: "download-progress", listener: (info: { percent: number }) => void): unknown;
  on(
    event: "update-downloaded",
    listener: (event: { version: string; downloadedFile: string }) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "download-progress", listener: (info: { percent: number }) => void): unknown;
  removeListener(
    event: "update-downloaded",
    listener: (event: { version: string; downloadedFile: string }) => void,
  ): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  /**
   * BaseUpdater's public, synchronous install (review WR-01): true when the installer started. Called instead of
   * `quitAndInstall`, which returns nothing and would call `app.quit()` a second time from inside the quit event.
   */
  install(isSilent?: boolean, isForceRunAfter?: boolean): boolean;
  prepareDownloaded?(info: { version: string; downloadedFile: string }): Promise<void>;
}

/** Why there is no platform updater (the release-page notice is shown instead). */
export type UpdateFallbackReason =
  | "dmg"
  | "translocated"
  | "unwritable"
  | "not_bundle"
  | "deb"
  | "unsupported"
  | "not_release"
  | "dev";

/**
 * The app's own daemon runs (`ours`), or none needs holding (paused, stopped, or one started by hand). Review WR-03:
 * `external_install` is a daemon started by hand from the folder an update replaces (the installer or the swap would
 * kill it mid-turn), so no update installs while it runs.
 */
export type DaemonKind = "ours" | "paused" | "stopped" | "external" | "external_install";

export type UpdateLevel = "automatic" | "notify" | "off";

type TimerHandle = unknown;

export interface AppUpdateDeps {
  updater: UpdaterLike | null;
  fallback: UpdateFallbackReason | null;
  /** False under the unpackaged test feed: everything runs except the installer. */
  installAllowed: boolean;
  currentVersion: string;
  /** `appUpdateHold { drain }` over the control socket; the answer is parsed here with `AppUpdateHoldAnswer`. */
  hold: (drain: boolean) => Promise<unknown>;
  /** `appUpdateRelease { holdId }`: ends only the hold it names (review CR-01). */
  release: (holdId: string) => Promise<unknown>;
  /**
   * `status.appUpdate`, read when a hold answer was lost (timeout, unreadable): the request may still have started a
   * hold, which is then released by the id the status names. Absent: nothing is released.
   */
  holdState?: () => Promise<unknown>;
  daemon: () => DaemonKind;
  quit: () => void;
  /** `app.relaunch()`: the quit goes on and this version opens again (an install that did not start, WR-01). */
  relaunch: () => void;
  /** Records an install that did not start, for a one-time "OCW was not updated" notice at the next start (WR-01). */
  recordFailure: (version: string) => void;
  /** The system idle time in seconds (`powerMonitor.getSystemIdleTime()`). */
  idleSeconds: () => number;
  notify: (title: string, body: string) => void;
  onChange: () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** The first automatic check when no daemon status arrives (default 60 s). */
  firstCheckFallbackMs?: number;
  /** Between automatic checks (default 24 h). */
  checkEveryMs?: number;
  /** How often the unattended restart reads the idle time (default 60 s). */
  idleCheckMs?: number;
}

/** What the app passes from each daemon status poll. */
export interface DaemonUpdateStatus {
  /** A status answer arrived (false: the daemon is unreachable; the last known level stays). */
  reported: boolean;
  /** `status.runtimeUpdates.effectiveLevel`; absent (older or unpaired daemon) counts as `notify`. */
  level: UpdateLevel | null | undefined;
  /** `status.appUpdate`, the restart hold. */
  appUpdate?: DaemonAppUpdate | null;
}

type WaitingFor = "sessions" | "runtime_update";

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string }
  | { kind: "waiting"; version?: string; running: number; waitingFor: WaitingFor }
  | { kind: "restarting"; version?: string }
  | { kind: "fallback"; version: string; url: string };

/** What the tray, the Runtime menu and the onboarding window render. */
export interface AppUpdateView {
  phase: Phase["kind"];
  version?: string;
  percent?: number;
  running?: number;
  waitingFor?: WaitingFor;
  url?: string;
  /** Why the platform has no updater (null when it has one). */
  fallback: UpdateFallbackReason | null;
  /** A fixed sentence from `UPDATE_SENTENCES`, shown as a disabled line. */
  notice: string | null;
}

type Action = () => void | Promise<void>;
interface PendingHold {
  action: Action;
  previous: Phase;
  /** The hold this wait started (review CR-01); null until an answer names it. */
  holdId: string | null;
  /** A hold request of this wait is queued or in flight. */
  asking: boolean;
}
interface Acting {
  previous: Phase;
  /** The hold the action runs under (null: none was needed). */
  holdId: string | null;
}

function stableVersion(value: unknown): string | null {
  return typeof value === "string" && STABLE_VERSION.test(value) ? value : null;
}

function versionOf(phase: Phase): string | undefined {
  return "version" in phase ? phase.version : undefined;
}

/** The error's code (and the checksum wording) picks a fixed sentence; the error's own text is never shown. */
export function updateErrorSentence(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : "";
  if (code === "ERR_CHECKSUM_MISMATCH" || /\bsha512 checksum mismatch\b/.test(message))
    return UPDATE_SENTENCES.checksumMismatch;
  if (code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" || code === "ERR_UPDATER_LATEST_VERSION_NOT_FOUND")
    return UPDATE_SENTENCES.noUpdateFile;
  return UPDATE_SENTENCES.checkFailed;
}

const PLAIN_FILE_NAME = /^[^/\\]{1,255}$/;

/**
 * Pitfall 6: the AppImage updater keeps the new file's versioned name, so a shortcut to the old file breaks. One
 * notice naming both files (plain file names only; null when nothing changed or a name carries a path).
 */
export function appImageNameNotice(previous: string | null, next: string | null): string | null {
  if (!previous || !next || previous === next) return null;
  if (!PLAIN_FILE_NAME.test(previous) || !PLAIN_FILE_NAME.test(next)) return null;
  return `OCW now runs from ${next}. Shortcuts to ${previous} no longer work: point them at the new file, or rename it to OCW.AppImage so later updates keep that name.`;
}

/**
 * The one-time notice after an install that failed (the macOS swap's result, or an install that did not start; read
 * once at the next start). Versions and fixed sentences only. Review WR-04: after a failed rollback the app is no
 * longer in its folder, so the notice says where to get it again.
 */
export function installFailureNotice(
  result: { outcome: "installed" | "failed"; version: string; reason?: string } | null,
  currentVersion: string,
): { title: string; body: string } | null {
  if (result?.outcome !== "failed") return null;
  const title = "OCW was not updated";
  if (result.reason === "rollback_failed") {
    return {
      title,
      body: `The update to v${result.version} could not be installed and OCW could not be put back in its folder. Download OCW again from the release page and install it.`,
    };
  }
  return {
    title,
    body: `The update to v${result.version} could not be installed. OCW is still on v${currentVersion}.`,
  };
}

export class AppUpdateController {
  private readonly updater: UpdaterLike | null;
  private readonly now: () => number;
  private phase: Phase = { kind: "idle" };
  private notice: string | null = null;
  /** No status yet, or one without a level: `notify` (never install unattended without a known level). */
  private level: UpdateLevel = "notify";
  private readyVersion: string | null = null;
  /** The quit is the update's restart (a click or the unattended restart): install silently and relaunch. */
  private restartRequested = false;
  private installStarted = false;
  private started = false;
  private stopped = false;
  /** Who started the running check or download: a click shows its failure, an automatic run fails silently. */
  private source: "auto" | "click" = "auto";
  private firstDone = false;
  private lastAutoAt: number | null = null;
  private firstTimer: TimerHandle | null = null;
  private autoTimer: TimerHandle | null = null;
  private idleTimer: TimerHandle | null = null;
  private boundTimer: TimerHandle | null = null;
  /** A hold asked with `drain` whose action has not run yet. */
  private pending: PendingHold | null = null;
  /** An action running after the hold (the restart, or Move to Applications). */
  private acting: Acting | null = null;
  private lastAskAt = 0;
  private unattendedAsking = false;
  /** Review CR-01: every hold and release goes through this chain, one request at a time, in the order asked. */
  private controlChain: Promise<unknown> = Promise.resolve();

  private readonly onProgress = (info: { percent: number }) => {
    if (this.phase.kind !== "downloading") return;
    const raw = info?.percent;
    const percent =
      typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.floor(raw))) : 0;
    this.set({ ...this.phase, percent });
  };
  private readonly onDownloaded = (event: { version: string; downloadedFile: string }) => {
    void this.downloaded(event).catch(() => this.fail(null));
  };
  private readonly onError = (error: Error) => {
    if (this.phase.kind === "checking" || this.phase.kind === "downloading") this.fail(error);
  };

  constructor(private readonly deps: AppUpdateDeps) {
    this.updater = deps.updater;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    if (!this.updater) return;
    this.updater.on("download-progress", this.onProgress);
    this.updater.on("update-downloaded", this.onDownloaded);
    this.updater.on("error", this.onError);
    this.firstTimer = this.timer(this.deps.firstCheckFallbackMs ?? FIRST_CHECK_FALLBACK_MS, () => {
      this.firstTimer = null;
      this.firstCheck();
    });
  }

  stop(): void {
    this.stopped = true;
    for (const t of [this.firstTimer, this.autoTimer, this.idleTimer, this.boundTimer]) this.clear(t);
    this.firstTimer = this.autoTimer = this.idleTimer = this.boundTimer = null;
    if (!this.updater || !this.started) return;
    this.updater.removeListener("download-progress", this.onProgress);
    this.updater.removeListener("update-downloaded", this.onDownloaded);
    this.updater.removeListener("error", this.onError);
  }

  /** Every daemon status poll: the level (first automatic check, schedule) and the restart hold's progress. */
  onDaemonStatus(status: DaemonUpdateStatus): void {
    if (this.stopped) return;
    if (status.reported) {
      const next = status.level ?? "notify";
      const changed = next !== this.level;
      this.level = next;
      if (!this.firstDone) this.firstCheck();
      else if (changed) this.scheduleAuto();
      if (changed) this.syncIdleTimer();
    }
    const parsed = DaemonAppUpdate.safeParse(status.appUpdate);
    if (parsed.success) this.onHoldStatus(parsed.data);
  }

  /** Check, and download what it finds. Never throws: a failure becomes a sentence (a click) or nothing (automatic). */
  async check(source: "auto" | "click"): Promise<void> {
    const updater = this.updater;
    if (!updater || this.stopped || this.pending || this.acting) return;
    if (this.phase.kind !== "idle" && this.phase.kind !== "fallback") return;
    if (source === "auto" && this.level === "off") return;
    this.source = source;
    this.notice = null;
    this.set({ kind: "checking" });
    let result: Awaited<ReturnType<UpdaterLike["checkForUpdates"]>>;
    try {
      result = await updater.checkForUpdates();
    } catch (error) {
      return this.fail(error);
    }
    if (this.stopped || this.current().kind !== "checking") return;
    const version = stableVersion(result?.updateInfo?.version);
    if (!result?.isUpdateAvailable || !version || compareVersions(version, this.deps.currentVersion) <= 0) {
      this.set({ kind: "idle" });
      if (source === "click")
        this.deps.notify(UPDATE_SENTENCES.upToDate, `Version ${this.deps.currentVersion}.`);
      return;
    }
    this.set({ kind: "downloading", version, percent: 0 });
    try {
      await updater.downloadUpdate();
    } catch (error) {
      if (this.current().kind === "downloading") this.fail(error);
    }
  }

  /** "Restart to update": hold the daemon (drain), then quit; the install starts from the quit event. */
  async restart(): Promise<void> {
    if (this.phase.kind !== "ready") return;
    await this.holdThen(this.restartAction);
  }

  /**
   * Run `action` once the daemon holds with `drain` (or right away when no daemon of the app's own runs). While the
   * daemon drains, the view waits (`cancelWait` gives up). An action that throws returns the view to its previous
   * phase and reopens the gates; it never escapes.
   */
  async holdThen(action: Action): Promise<void> {
    if (this.stopped || this.pending || this.acting) return;
    const previous = this.phase;
    this.notice = null;
    const daemon = this.deps.daemon();
    if (daemon === "external_install") {
      this.notice = UPDATE_SENTENCES.externalRuntime;
      return this.set(previous);
    }
    if (daemon !== "ours") return this.run(action, previous, null);
    const pending: PendingHold = { action, previous, holdId: null, asking: false };
    this.pending = pending;
    this.boundTimer = this.timer(WAIT_BOUND_MS, () => {
      this.boundTimer = null;
      this.endWait(pending, UPDATE_SENTENCES.holdTimedOut, true);
    });
    await this.ask(pending);
  }

  /** "Cancel the restart" (or a cancelled Move to Applications): reopen the gates and go back. */
  cancelWait(): void {
    if (this.pending) {
      this.endWait(this.pending, null, true);
      return;
    }
    const acting = this.acting;
    if (!acting) return;
    this.acting = null;
    this.restartRequested = false;
    if (acting.holdId) this.releaseHold(acting.holdId);
    this.set(acting.previous);
  }

  /** The 07.13 notice for a platform without an updater (`.deb`, dmg, unwritable folder…): a checked release page. */
  setFallbackNotice(notice: { version: string; url: string } | null): void {
    if (this.updater || this.stopped) return;
    if (this.phase.kind !== "idle" && this.phase.kind !== "fallback") return;
    if (!notice) {
      if (this.phase.kind === "fallback") this.set({ kind: "idle" });
      return;
    }
    const version = stableVersion(notice.version);
    if (!version || !isReleasePageUrl(notice.url)) return;
    this.set({ kind: "fallback", version, url: notice.url });
  }

  /**
   * Electron's `quit` event (the daemon is already stopped): the only place an install starts. Review WR-01: an
   * install that does not start (no installer, an unwritable AppImage, a missing helper) is recorded for the next
   * start's notice, and on a restart the app relaunches itself instead of staying closed.
   */
  onQuit(): void {
    const updater = this.updater;
    const version = this.readyVersion;
    if (!updater || !this.deps.installAllowed || !version || this.installStarted) return;
    const restart = this.restartRequested;
    if (!restart && this.level !== "automatic") return;
    // Review WR-03: the installer or the swap would kill a daemon started by hand from the install folder.
    if (this.deps.daemon() === "external_install") return;
    this.installStarted = true;
    let started = false;
    try {
      // Silent; relaunch only when the quit is the update's restart (a normal quit at `automatic` stays quit).
      started = updater.install(true, restart) === true;
    } catch {
      started = false;
    }
    if (started) return;
    if (restart) {
      try {
        this.deps.relaunch();
      } catch {
        // The app is quitting either way; the next start checks again.
      }
    }
    try {
      this.deps.recordFailure(version);
    } catch {
      // Best effort: the next start checks again.
    }
  }

  view(): AppUpdateView {
    const p = this.phase;
    const view: AppUpdateView = { phase: p.kind, fallback: this.deps.fallback, notice: this.notice };
    const version = versionOf(p);
    if (version) view.version = version;
    if (p.kind === "downloading") view.percent = p.percent;
    if (p.kind === "waiting") {
      view.running = p.running;
      view.waitingFor = p.waitingFor;
    }
    if (p.kind === "fallback") view.url = p.url;
    return view;
  }

  private readonly restartAction: Action = () => {
    this.restartRequested = true;
    this.deps.quit();
  };

  private async ask(pending: PendingHold): Promise<void> {
    if (pending.asking) return;
    pending.asking = true;
    this.lastAskAt = this.now();
    const answer = await this.serial(async () => {
      if (this.pending !== pending) return null; // cancelled before it was sent: nothing to ask
      const got = await this.askHold(true);
      if (this.pending !== pending) {
        // The wait ended while the request was in flight: a hold it started is released before any next request.
        if (got?.holdId) await this.sendRelease(got.holdId);
        return null;
      }
      // No readable answer: the request may still have closed the gates, so the hold that is on is released by id.
      if (!got) await this.releaseLostHold();
      return got;
    });
    pending.asking = false;
    if (this.stopped || this.pending !== pending) return;
    if (!answer) return this.endWait(pending, UPDATE_SENTENCES.runtimeUnreachable, true);
    if (answer.holdId) pending.holdId = answer.holdId;
    // Only this wait's own hold lets the app quit; a `held` without an id is somebody else's.
    if (answer.held && answer.holdId) return this.proceed(pending);
    this.set({
      kind: "waiting",
      version: versionOf(pending.previous),
      running: answer.running,
      waitingFor: answer.blocked ? "runtime_update" : "sessions",
    });
  }

  private async askHold(drain: boolean): Promise<AppUpdateHoldAnswer | null> {
    try {
      const parsed = AppUpdateHoldAnswer.safeParse(await this.deps.hold(drain));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * `status.appUpdate` while a drain hold is pending: follow it, quit on `held` for this wait's own hold only (review
   * CR-01: a status read before a cancel, or another hold, never quits), ask again when it ended.
   */
  private onHoldStatus(hold: DaemonAppUpdate): void {
    const pending = this.pending;
    if (!pending) return;
    if (hold.state === "held") {
      if (pending.holdId !== null && hold.holdId === pending.holdId) void this.proceed(pending);
      return;
    }
    const phase = this.phase;
    if (phase.kind !== "waiting" || pending.asking) return; // a hold request is still queued or in flight
    if (hold.state === "draining") {
      this.set({ ...phase, running: hold.running, waitingFor: "sessions" });
      return;
    }
    // Idle: the hold ended or was refused. A status read just before the last ask is ignored.
    if (this.now() - this.lastAskAt < REASK_MS) return;
    if (phase.waitingFor === "sessions" && hold.lastEnd === "timed_out") {
      this.endWait(pending, UPDATE_SENTENCES.holdTimedOut, false);
      return;
    }
    void this.ask(pending);
  }

  private async proceed(pending: PendingHold): Promise<void> {
    if (this.pending !== pending) return;
    this.pending = null;
    this.clear(this.boundTimer);
    this.boundTimer = null;
    await this.run(pending.action, pending.previous, pending.holdId);
  }

  /** Ends a wait. Its known hold is released by id; a request still in flight releases the hold it started itself. */
  private endWait(pending: PendingHold, notice: string | null, release: boolean): void {
    if (this.pending !== pending) return;
    this.pending = null;
    this.clear(this.boundTimer);
    this.boundTimer = null;
    if (release && pending.holdId) this.releaseHold(pending.holdId);
    this.notice = notice;
    this.set(pending.previous);
  }

  private async run(action: Action, previous: Phase, holdId: string | null): Promise<void> {
    const acting: Acting = { previous, holdId };
    this.acting = acting;
    const version = versionOf(previous);
    this.set(version ? { kind: "restarting", version } : { kind: "restarting" });
    try {
      await action();
    } catch {
      if (this.acting !== acting) return;
      this.acting = null;
      this.restartRequested = false;
      if (holdId) this.releaseHold(holdId);
      this.set(previous);
    }
  }

  /** Queues `fn` behind every earlier control request (review CR-01); `fn` never rejects. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.controlChain.then(fn, fn);
    this.controlChain = next.catch(() => undefined);
    return next;
  }

  /** Releases a hold by id, in order after every earlier request; never throws. */
  private releaseHold(holdId: string): void {
    void this.serial(() => this.sendRelease(holdId));
  }

  private async sendRelease(holdId: string): Promise<void> {
    try {
      await this.deps.release(holdId);
    } catch {
      // The runtime is gone; its gates reopen with it (or by its own bound).
    }
  }

  /** A hold answer was lost: release the hold the daemon reports, if one is on (only this app asks for holds). */
  private async releaseLostHold(): Promise<void> {
    const read = this.deps.holdState;
    if (!read || this.stopped) return;
    let state: DaemonAppUpdate;
    try {
      const parsed = DaemonAppUpdate.safeParse(await read());
      if (!parsed.success) return;
      state = parsed.data;
    } catch {
      return;
    }
    if (state.state !== "idle" && state.holdId) await this.sendRelease(state.holdId);
  }

  private firstCheck(): void {
    if (this.firstDone || this.stopped) return;
    this.firstDone = true;
    this.clear(this.firstTimer);
    this.firstTimer = null;
    this.scheduleAuto();
  }

  /** The next automatic check: now when none ran within `checkEveryMs`, else when it is due; never at `off`. */
  private scheduleAuto(): void {
    this.clear(this.autoTimer);
    this.autoTimer = null;
    if (!this.firstDone || this.stopped || !this.updater || this.level === "off") return;
    const every = this.deps.checkEveryMs ?? CHECK_EVERY_MS;
    const due = this.lastAutoAt === null ? 0 : this.lastAutoAt + every - this.now();
    if (due <= 0) {
      this.autoCheck();
      return;
    }
    this.autoTimer = this.timer(due, () => {
      this.autoTimer = null;
      this.autoCheck();
    });
  }

  private autoCheck(): void {
    this.lastAutoAt = this.now();
    void this.check("auto");
    this.scheduleAuto();
  }

  private unattendedAllowed(): boolean {
    return (
      !this.stopped &&
      this.updater !== null &&
      this.level === "automatic" &&
      this.phase.kind === "ready" &&
      !this.pending &&
      !this.acting
    );
  }

  /** The unattended restart's minute timer runs only at `automatic` with a ready update. */
  private syncIdleTimer(): void {
    if (!this.unattendedAllowed()) {
      this.clear(this.idleTimer);
      this.idleTimer = null;
      return;
    }
    if (this.idleTimer !== null) return;
    this.idleTimer = this.timer(this.deps.idleCheckMs ?? IDLE_CHECK_MS, () => {
      this.idleTimer = null;
      void this.idleTick();
      this.syncIdleTimer();
    });
  }

  /** Away ≥ 30 min and the daemon holds without draining (nothing runs): restart into the update. */
  private async idleTick(): Promise<void> {
    if (this.unattendedAsking || !this.unattendedAllowed()) return;
    let idle: number;
    try {
      idle = this.deps.idleSeconds();
    } catch {
      return;
    }
    if (!(idle >= AWAY_SECONDS)) return;
    const daemon = this.deps.daemon();
    if (daemon === "external_install") return;
    if (daemon !== "ours") return this.run(this.restartAction, this.phase, null);
    this.unattendedAsking = true;
    // Review CR-01: the answer is handled inside its own turn of the chain, so a click that came meanwhile sends its
    // hold only after this one was released.
    const holdId = await this.serial(async () => {
      const answer = await this.askHold(false);
      if (!answer?.held || !answer.holdId) return null;
      if (!this.unattendedAllowed()) {
        await this.sendRelease(answer.holdId);
        return null;
      }
      return answer.holdId;
    });
    this.unattendedAsking = false;
    if (!holdId) return;
    if (!this.unattendedAllowed()) return this.releaseHold(holdId);
    await this.run(this.restartAction, this.phase, holdId);
  }

  private async downloaded(event: { version: string; downloadedFile: string }): Promise<void> {
    if (this.stopped || this.phase.kind !== "downloading") return;
    const version = stableVersion(event?.version);
    if (!version || version !== this.phase.version) return this.fail(null);
    const prepare = this.updater?.prepareDownloaded;
    if (prepare) {
      this.set({ kind: "downloading", version, percent: 100 });
      try {
        await prepare.call(this.updater, { version, downloadedFile: event.downloadedFile });
      } catch {
        if (this.stopped) return;
        this.notice = UPDATE_SENTENCES.macPrepareFailed;
        return this.set({ kind: "fallback", version, url: `${RELEASE_TAG_URL}${version}` });
      }
      if (this.stopped || this.current().kind !== "downloading") return;
    }
    this.readyVersion = version;
    this.set({ kind: "ready", version });
  }

  private fail(error: unknown): void {
    if (this.stopped) return;
    if (this.source === "click") this.notice = updateErrorSentence(error);
    this.set({ kind: "idle" });
  }

  /** The phase now (read after an await: TypeScript's narrowing from before the await no longer holds). */
  private current(): Phase {
    return this.phase;
  }

  private set(phase: Phase): void {
    this.phase = phase;
    this.syncIdleTimer();
    this.deps.onChange();
  }

  private timer(ms: number, fn: () => void): TimerHandle {
    return (this.deps.setTimer ?? ((f: () => void, t: number) => setTimeout(f, t)))(fn, ms);
  }

  private clear(handle: TimerHandle | null): void {
    if (handle === null) return;
    (this.deps.clearTimer ?? ((h: TimerHandle) => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle);
  }
}

export type AppUpdateMenuAction = "check" | "restart" | "cancelWait" | "openRelease" | "moveToApplications";

export interface AppUpdateMenuItem {
  label: string;
  enabled: boolean;
  action?: AppUpdateMenuAction;
  url?: string;
}

const CHECK_LABEL = "Check for updates…";
const MOVE_LABEL = "Move OCW to Applications to get automatic updates";

function canMove(view: AppUpdateView): boolean {
  return view.fallback === "dmg" || view.fallback === "translocated";
}

function updateAvailableLabel(view: AppUpdateView, version: string): string {
  return view.fallback === "deb"
    ? `Update available (v${version}): download the .deb, or use the AppImage, which updates itself`
    : `Update available (v${version})`;
}

function waitingLabel(view: AppUpdateView): string {
  if (view.waitingFor === "runtime_update") return "Waiting for a runtime update to finish…";
  const n = view.running ?? 0;
  if (n === 1) return "Waiting for 1 session to finish…";
  return n > 1 ? `Waiting for ${n} sessions to finish…` : "Waiting for sessions to finish…";
}

function restartingLabel(view: AppUpdateView): string {
  return view.version ? `Restarting to update to v${view.version}…` : "Restarting…";
}

/** The tray's and the Runtime menu's update lines, top to bottom (fixed sentences, versions, counts; no path). */
export function appUpdateMenuModel(view: AppUpdateView): AppUpdateMenuItem[] {
  const items: AppUpdateMenuItem[] = [];
  if (view.notice) items.push({ label: view.notice, enabled: false });
  switch (view.phase) {
    case "checking":
      items.push({ label: "Checking for updates…", enabled: false });
      break;
    case "downloading":
      items.push({ label: `Downloading v${view.version}… ${view.percent ?? 0}%`, enabled: false });
      break;
    case "ready":
      items.push({ label: `Restart to update to v${view.version}`, enabled: true, action: "restart" });
      break;
    case "waiting":
      items.push({ label: waitingLabel(view), enabled: false });
      items.push({ label: "Cancel the restart", enabled: true, action: "cancelWait" });
      break;
    case "restarting":
      items.push({ label: restartingLabel(view), enabled: false });
      break;
    default:
      if (view.phase === "fallback" && view.version && view.url)
        items.push({
          label: updateAvailableLabel(view, view.version),
          enabled: true,
          action: "openRelease",
          url: view.url,
        });
      if (canMove(view)) items.push({ label: MOVE_LABEL, enabled: true, action: "moveToApplications" });
      items.push({ label: CHECK_LABEL, enabled: true, action: "check" });
  }
  return items;
}

/** The onboarding window's update line (undefined: nothing to show). */
export function onboardingUpdateView(view: AppUpdateView): OnboardingUpdate | undefined {
  switch (view.phase) {
    case "checking":
      return { kind: "progress", label: "Checking for updates…" };
    case "downloading":
      return { kind: "progress", label: `Downloading v${view.version}… ${view.percent ?? 0}%` };
    case "ready":
      return { kind: "ready", label: `Restart to update to v${view.version}` };
    case "waiting":
      return { kind: "waiting", label: waitingLabel(view) };
    case "restarting":
      // A sentence only, as in the tray: cancelling now would quit without installing.
      return { kind: "progress", label: restartingLabel(view) };
    case "fallback":
      if (view.version && view.url) {
        const link = { label: updateAvailableLabel(view, view.version), url: view.url };
        return canMove(view) ? { kind: "move", label: MOVE_LABEL, link } : { kind: "link", ...link };
      }
      break;
  }
  if (view.notice) return { kind: "error", label: view.notice };
  return canMove(view) ? { kind: "move", label: MOVE_LABEL } : undefined;
}
