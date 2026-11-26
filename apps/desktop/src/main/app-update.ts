// The desktop app's own update (07.13.1, ADR-0046): when to check and download, the restart hold, and the one place an
// install starts. The platform updater (electron-updater's NSIS or AppImage updater, or the ad-hoc macOS updater) is
// injected; this module imports no Electron, so every decision is unit-tested with fakes.
//
// - The app quits for an update only after the daemon answered `held` to `appUpdateHold` (or when no daemon of the
//   app's own runs: paused, stopped or external), so a Work Zone turn is never cut (D-07, Pitfall 3).
// - The install itself starts only in `onQuit()`, which the app calls from Electron's `quit` event, after `before-quit`
//   stopped the daemon.
// - The views (tray, Runtime menu, onboarding window) carry fixed sentences, versions, percentages and counts only:
//   never an updater error text, never a path (D-09).

import { AppUpdateHoldAnswer, type OnboardingUpdate } from "../shared/ipc";
import { compareVersions } from "./update-check";

const RELEASE_TAG_URL = "https://github.com/VictorMinemu/open-collaborative-ai-workspace/releases/tag/v";
const STABLE_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;

/** Fixed sentences: the only update text besides versions, percentages and counts that reaches a view. */
export const UPDATE_SENTENCES = {
  checkFailed: "Could not check for updates. Try again later.",
  checksumMismatch: "The downloaded update did not match its checksum and was discarded.",
  noUpdateFile: "This release has no update for this computer yet.",
  macPrepareFailed: "The update could not be prepared. Download it from the release page.",
  holdTimedOut: "Sessions were still running after 30 minutes, so OCW did not restart.",
  runtimeUnreachable: "The runtime did not answer, so OCW did not restart.",
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
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
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

/** The app's own daemon runs (`ours`), or none needs holding (paused, stopped, or one started by hand). */
export type DaemonKind = "ours" | "paused" | "stopped" | "external";

export type UpdateLevel = "automatic" | "notify" | "off";

type TimerHandle = unknown;

export interface AppUpdateDeps {
  updater: UpdaterLike | null;
  fallback: UpdateFallbackReason | null;
  /** False under the unpackaged test feed: everything runs except the installer. */
  installAllowed: boolean;
  currentVersion: string;
  /** `appUpdateHold { drain }` over the control socket; the answer is parsed here. */
  hold: (drain: boolean) => Promise<unknown>;
  /** `appUpdateRelease`. */
  release: () => Promise<unknown>;
  daemon: () => DaemonKind;
  quit: () => void;
  /** The system idle time in seconds (`powerMonitor.getSystemIdleTime()`). */
  idleSeconds: () => number;
  notify: (title: string, body: string) => void;
  onChange: () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  firstCheckFallbackMs?: number;
  checkEveryMs?: number;
  idleCheckMs?: number;
}

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string }
  | { kind: "restarting"; version?: string }
  | { kind: "fallback"; version: string; url: string };

/** What the tray, the Runtime menu and the onboarding window render. */
export interface AppUpdateView {
  phase: Phase["kind"];
  version?: string;
  percent?: number;
  url?: string;
  /** Why the platform has no updater (null when it has one). */
  fallback: UpdateFallbackReason | null;
  /** A fixed sentence from `UPDATE_SENTENCES`, shown as a disabled line. */
  notice: string | null;
}

function stableVersion(value: unknown): string | null {
  return typeof value === "string" && STABLE_VERSION.test(value) ? value : null;
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

export class AppUpdateController {
  private readonly updater: UpdaterLike | null;
  private phase: Phase = { kind: "idle" };
  private notice: string | null = null;
  private readyVersion: string | null = null;
  /** The quit is the update's restart (a click or the unattended restart): install silently and relaunch. */
  private restartRequested = false;
  private installStarted = false;
  private started = false;
  private stopped = false;
  /** Who started the running check or download: a click shows its failure, an automatic run fails silently. */
  private source: "auto" | "click" = "auto";

  private readonly onProgress = (info: { percent: number }) => {
    if (this.phase.kind !== "downloading") return;
    const percent = Number.isFinite(info?.percent) ? Math.max(0, Math.min(100, Math.floor(info.percent))) : 0;
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
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    if (!this.updater) return;
    this.updater.on("download-progress", this.onProgress);
    this.updater.on("update-downloaded", this.onDownloaded);
    this.updater.on("error", this.onError);
  }

  stop(): void {
    this.stopped = true;
    if (!this.updater || !this.started) return;
    this.updater.removeListener("download-progress", this.onProgress);
    this.updater.removeListener("update-downloaded", this.onDownloaded);
    this.updater.removeListener("error", this.onError);
  }

  /** Check, and download what it finds. Never throws: a failure becomes a sentence (a click) or nothing (automatic). */
  async check(source: "auto" | "click"): Promise<void> {
    const updater = this.updater;
    if (!updater || this.stopped) return;
    if (this.phase.kind !== "idle" && this.phase.kind !== "fallback") return;
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
    await this.holdThen(() => {
      this.restartRequested = true;
      this.deps.quit();
    });
  }

  /**
   * Run `action` once the daemon holds (or right away when no daemon of the app's own runs). An action that throws
   * returns the view to its previous phase.
   */
  async holdThen(action: () => void | Promise<void>): Promise<void> {
    if (this.stopped || this.phase.kind === "restarting") return;
    const previous = this.phase;
    this.notice = null;
    if (this.deps.daemon() !== "ours") return this.run(action, previous, false);
    let answer: AppUpdateHoldAnswer | null = null;
    try {
      const parsed = AppUpdateHoldAnswer.safeParse(await this.deps.hold(true));
      answer = parsed.success ? parsed.data : null;
    } catch {
      answer = null;
    }
    if (this.stopped) return;
    if (!answer) {
      this.notice = UPDATE_SENTENCES.runtimeUnreachable;
      return this.set(previous);
    }
    if (answer.held) return this.run(action, previous, true);
  }

  /** Electron's `quit` event (the daemon is already stopped): the only place an install starts. */
  onQuit(): void {
    const updater = this.updater;
    if (!updater || !this.deps.installAllowed || !this.readyVersion || this.installStarted) return;
    if (!this.restartRequested) return;
    this.installStarted = true;
    try {
      updater.quitAndInstall(true, true);
    } catch {
      // The app is quitting either way; the next start checks again.
    }
  }

  view(): AppUpdateView {
    const p = this.phase;
    const view: AppUpdateView = { phase: p.kind, fallback: this.deps.fallback, notice: this.notice };
    if ("version" in p && p.version) view.version = p.version;
    if (p.kind === "downloading") view.percent = p.percent;
    if (p.kind === "fallback") view.url = p.url;
    return view;
  }

  private async run(action: () => void | Promise<void>, previous: Phase, held: boolean): Promise<void> {
    const version = "version" in previous ? previous.version : undefined;
    this.set(version ? { kind: "restarting", version } : { kind: "restarting" });
    try {
      await action();
    } catch {
      this.restartRequested = false;
      if (held) await this.deps.release().catch(() => undefined);
      this.set(previous);
    }
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
    this.deps.onChange();
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

function updateAvailableLabel(version: string): string {
  return `Update available (v${version})`;
}

/** The tray's and the Runtime menu's update lines, top to bottom. */
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
    case "restarting":
      items.push({
        label: view.version ? `Restarting to update to v${view.version}…` : "Restarting…",
        enabled: false,
      });
      break;
    case "fallback":
      if (view.version && view.url)
        items.push({
          label: updateAvailableLabel(view.version),
          enabled: true,
          action: "openRelease",
          url: view.url,
        });
      items.push({ label: CHECK_LABEL, enabled: true, action: "check" });
      break;
    default:
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
    case "restarting":
      return {
        kind: "waiting",
        label: view.version ? `Restarting to update to v${view.version}…` : "Restarting…",
      };
    case "fallback":
      if (view.version && view.url)
        return { kind: "link", label: updateAvailableLabel(view.version), url: view.url };
      return undefined;
    default:
      return view.notice ? { kind: "error", label: view.notice } : undefined;
  }
}
