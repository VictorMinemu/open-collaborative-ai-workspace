// OCW desktop shell (Electron main process).
//
// - Single instance; dock + menu-bar (tray) app.
// - First run: bundled onboarding page (server URL + pairing code → POST /devices/enroll).
// - Device token encrypted with safeStorage; passed to the daemon via env at spawn time.
// - Supervises apps/local-runtime (ADR-0005) and talks to it ONLY over the Unix control socket.
// - Main window loads the web app; `window.ocwDesktop` is a narrow, validated bridge.
// - Full access opt-in (ADR-0012): switched ONLY from the Runtime menu / tray here, after a native confirmation;
//   written to the daemon's runtime.json and applied with `reloadConfig`. Web content can only read it.
// - Runtime CLI updates (07.11, D-02, D-09): the Runtime menu / tray shows each runtime's update status from the
//   daemon and switches the device's own level (Automatic / Notify only / Off) the same way as Full access, without a
//   confirmation. Web content never sees or sets it.
// - Browser opt-in (07.13, D-10, PD-27): "Allow the browser on this computer" in the Runtime menu / tray, after a
//   native confirmation, written to runtime.json like Full access. Web content never sees or sets it.
// - The app's own update (07.13.1, ADR-0046): the platform's one updater (NSIS, AppImage or the ad-hoc macOS updater,
//   platform-updater.ts; release builds only) is driven by one AppUpdateController at the org ∩ device 07.11 level.
//   "Check for updates…", progress, "Restart to update" and the wait for running sessions live in the tray and the
//   Runtime menu (and the onboarding window), never in the web app. The install starts only from Electron's `quit`
//   event, after `before-quit` stopped the daemon. Where the app cannot update itself (.deb, a Mac from the disk image
//   or an unwritable folder, other builds) the daily 07.13 GitHub notice links the release page instead.

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync, truncateSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  nativeImage,
  powerMonitor,
  safeStorage,
  shell,
  Tray,
} from "electron";
import { Channels } from "../shared/channels";
import {
  AddProjectArgs,
  type AddProjectResult,
  ChatgptLoopbackAwaitArgs,
  ChatgptLoopbackCancelArgs,
  CheckServerArgs,
  DaemonStatusPayload,
  type DesktopRuntimeUpdatesLevel,
  type DesktopStatus,
  EnrollArgs,
  FinishArgs,
  LocalProject,
  NoArgs,
  type OnboardingStatus,
  type PublicProject,
  parseArgs,
  SetBadgeCountArgs,
  toPublicProject,
  UpdateActionArgs,
} from "../shared/ipc";
import { ProjectPathError, validateProjectDir } from "../shared/project-path";
import { runtimeUpdateLines, runtimeUpdatesMenuModel } from "../shared/runtime-updates";
import { type DaemonProcessState, deriveStatus, sameStatus } from "../shared/status";
import { deriveApiUrl, isSafeExternalUrl, normalizeServerUrl, UrlError } from "../shared/urls";
import {
  AppUpdateController,
  type AppUpdateMenuAction,
  appImageNameNotice,
  appUpdateMenuModel,
  type DaemonKind,
  onboardingUpdateView,
} from "./app-update";
import { RELEASE_BUILD } from "./build-flags";
import {
  awaitChatgptCallback,
  cancelAllChatgptLoopbacks,
  cancelChatgptLoopback,
  prepareChatgptLoopback,
} from "./chatgpt-loopback";
import { ConfigStore } from "./config-store";
import { ControlError, controlRequest, controlSocketPath } from "./control-client";
import { buildDaemonEnv, ocwHomeDir, resolveDaemonCommand } from "./daemon-launch";
import { checkServer, EnrollError, enrollDevice } from "./enroll";
import { createAdhocMacUpdater, macInstallTarget, readSwapResult, sweepLeftovers } from "./mac-update";
import { pidfilePath, reapStaleDaemon, removePidfile, removePidfileIfOwner, writePidfile } from "./pidfile";
import { createPlatformUpdater, type UpdaterMode, updaterMode } from "./platform-updater";
import {
  readDaemonBrowser,
  readDaemonFullAccess,
  readDaemonRuntimeUpdates,
  writeDaemonBrowser,
  writeDaemonFullAccess,
  writeDaemonRuntimeUpdates,
} from "./runtime-config";
import { hardenedPreferences, installGlobalGuards, isTrustedSender, restrictNavigation } from "./security";
import { DaemonSupervisor } from "./supervisor";
import {
  checkForUpdate,
  fileUpdateStore,
  isReleasePageUrl,
  UPDATE_CHECK_INTERVAL_MS,
  type UpdateCheckResult,
} from "./update-check";

const DEFAULT_WEB_URL = "http://localhost:3000";
const STATUS_POLL_MS = 2500;
const BG = "#0f0f12";

// Test/dev isolation: a separate profile directory (must be set before `ready`).
if (process.env.OCW_DESKTOP_USER_DATA) app.setPath("userData", process.env.OCW_DESKTOP_USER_DATA);

// ---------------------------------------------------------------------------------------------

const DIST = join(__dirname, "..");
const asset = (...p: string[]) => join(DIST, "assets", ...p);
const ocwHome = ocwHomeDir();
const socketPath = controlSocketPath(ocwHome);
const pidfile = pidfilePath(ocwHome);

let store: ConfigStore;
let supervisor: DaemonSupervisor;
let mainWindow: BrowserWindow | null = null;
let onboardingWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let paused = false;
let externalDaemon = false;
let lastReport: DaemonStatusPayload | null = null;
/** runtime.json's Full access opt-in as last read here (shown while the daemon is unreachable). */
let localFullAccess = false;
/** runtime.json's browser opt-in as last read here (07.13, D-10); the menu shows it, web content never sees it. */
let localBrowser = false;
/** runtime.json's runtime updates level as last read here (shown while the daemon is unreachable). */
let localUpdatesLevel: DesktopRuntimeUpdatesLevel = "automatic";
/** What the menu last showed about runtime updates: they are not part of DesktopStatus (web content never sees them). */
let updatesChromeKey = "";
let status: DesktopStatus | null = null;
/**
 * The last "Update available" answer (07.13, D-18), kept only where the app has no updater of its own (07.13.1, D-05,
 * D-06); it feeds the controller's fallback link. Tray, Runtime menu and onboarding window only, never the web app.
 */
let updateNotice: UpdateCheckResult = { available: false };
/** The app's own update (07.13.1): one controller, created in main() once the supervisor exists. */
let appUpdate: AppUpdateController | null = null;
/** Whether this install has a platform updater; without one, "Check for updates…" forces the GitHub notice. */
let hasPlatformUpdater = false;
/** What the update lines last showed, so a download's progress events rebuild the menus only when a line changes. */
let appUpdateChromeKey = "";
/**
 * The pid of the app's own daemon, captured before the daemon is stopped: when the restart hold is asked and again in
 * `before-quit` right before `shutdown()`, because `shutdown()` clears the supervisor's child and reading
 * `supervisor.pid` at install time (the `quit` event) would always give 0. The macOS swap helper waits for this pid to
 * exit before it swaps the bundle; `0` means none of the app's own was running (paused, external or already stopped),
 * and the helper then skips the daemon wait.
 */
let recordedDaemonPid = 0;
let polling = false;
let quitting = false;
let cleanedUp = false;
let pidChain: Promise<void> = Promise.resolve();

function pidOp(fn: () => Promise<void>): void {
  pidChain = pidChain.then(fn).catch(() => undefined);
}

function log(msg: string): void {
  if (!app.isPackaged) process.stdout.write(`[ocw-desktop] ${msg}\n`);
}

function webOrigin(): string | null {
  return store?.config.webUrl ?? null;
}

// ---- daemon ---------------------------------------------------------------------------------

function openDaemonLog(): number | "ignore" {
  try {
    const dir = join(app.getPath("userData"), "logs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "daemon.log");
    try {
      if (statSync(file).size > 5 * 1024 * 1024) truncateSync(file, 0);
    } catch {
      // first run
    }
    return openSync(file, "a", 0o600);
  } catch {
    return "ignore";
  }
}

function spawnDaemon(): ChildProcess {
  const cmd = resolveDaemonCommand({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    execPath: process.execPath,
    env: process.env,
  });
  const env = buildDaemonEnv(process.env, {
    token: store.token(),
    apiUrl: store.config.apiUrl,
    electronAsNode: cmd.electronAsNode,
    appVersion: app.getVersion(),
  });
  const out = openDaemonLog();
  try {
    // detached → own process group, so stop() can signal the daemon and everything it spawned.
    // windowsHide: no console window for the daemon on Windows.
    return spawn(cmd.command, cmd.args, {
      cwd: cmd.cwd,
      env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", out, out],
    });
  } finally {
    if (typeof out === "number") closeSync(out);
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    process.kill(pid, signal);
  }
}

async function probeDaemon(): Promise<DaemonStatusPayload | null> {
  try {
    return DaemonStatusPayload.parse(await controlRequest(socketPath, { cmd: "status" }, 8000));
  } catch {
    return null;
  }
}

function daemonState(): DaemonProcessState {
  if (externalDaemon) return "external";
  return supervisor.state;
}

async function startDaemon(): Promise<void> {
  mkdirSync(ocwHome, { recursive: true, mode: 0o700 });
  const reaped = await reapStaleDaemon(pidfile);
  if (reaped === "reaped") log("reaped a daemon left by a previous run");
  // A daemon started by hand (`ocw-runtime run`) already owns the socket: adopt it.
  const existing = await probeDaemon();
  if (existing) {
    externalDaemon = true;
    lastReport = existing;
    log("using an already running daemon");
    return;
  }
  externalDaemon = false;
  supervisor.start();
}

// ---- status ---------------------------------------------------------------------------------

function computeStatus(): DesktopStatus {
  return deriveStatus({
    paused,
    paired: store.paired,
    daemon: daemonState(),
    report: lastReport,
    localFullAccess,
  });
}

function publishStatus(): void {
  const next = computeStatus();
  const updatesKey = JSON.stringify([
    runtimeUpdateLines(lastReport),
    runtimeUpdatesMenuModel(lastReport, localUpdatesLevel),
  ]);
  const statusChanged = !sameStatus(status, next);
  if (!statusChanged && updatesKey === updatesChromeKey) return;
  status = next;
  updatesChromeKey = updatesKey;
  if (statusChanged) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(Channels.statusChanged, next);
    sendOnboardingStatus();
  }
  refreshChrome();
}

/**
 * What the onboarding window shows: the status plus the app update's line (07.13.1, D-09). The web app never gets it.
 */
function onboardingStatus(): OnboardingStatus {
  const s = status ?? computeStatus();
  const line = appUpdate ? onboardingUpdateView(appUpdate.view()) : undefined;
  return line ? { ...s, appUpdate: line } : s;
}

function sendOnboardingStatus(): void {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.webContents.send(Channels.statusChanged, onboardingStatus());
  }
}

// ---- app update (07.13.1, ADR-0046) and the fallback notice (07.13, D-18, PD-21) ------------

/** Opens a release page in the default browser, only after both URL checks (T-07.13-11-01). */
function openReleasePage(url: string): void {
  if (isSafeExternalUrl(url) && isReleasePageUrl(url)) void shell.openExternal(url);
}

/**
 * The fallback notice, only where the app has no updater of its own (`.deb`, a Mac from the disk image, translocated
 * or unwritable, an unsupported platform, a packaged non-release build): asks GitHub's public releases/latest at most
 * once a day (the stored answer covers restarts; `force`, a click on "Check for updates…", asks again) and hands the
 * answer to the controller's fallback link. Packaged builds only (a dev build's 0.1.0 is not a release);
 * `OCW_DESKTOP_UPDATE_CHECK=1` turns it on in dev. Never throws, never downloads.
 */
async function runUpdateCheck(opts: { force?: boolean } = {}): Promise<void> {
  if (hasPlatformUpdater) return;
  if (!app.isPackaged && process.env.OCW_DESKTOP_UPDATE_CHECK !== "1") return;
  const next = await checkForUpdate({
    current: app.getVersion(),
    fetchImpl: fetch,
    now: Date.now,
    store: fileUpdateStore(app.getPath("userData")),
    force: opts.force === true,
  }).catch((): UpdateCheckResult => updateNotice);
  appUpdate?.setFallbackNotice(next.available ? { version: next.version, url: next.url } : null);
  if (JSON.stringify(next) === JSON.stringify(updateNotice)) return;
  updateNotice = next;
  if (next.available) log(`update available: v${next.version}`);
  refreshChrome();
  sendOnboardingStatus();
}

/**
 * "Move OCW to Applications to get automatic updates" (D-05): held like a restart. Electron's mover terminates and
 * relaunches the app by itself, so the daemon is stopped here first instead of relying on `before-quit` (with
 * `cleanedUp` already true, a `before-quit` the mover may still emit passes straight through). A cancelled move starts
 * the daemon again and releases the hold.
 */
async function moveToApplications(): Promise<void> {
  const controller = appUpdate;
  if (!controller || process.platform !== "darwin") return;
  await controller.holdThen(async () => {
    quitting = true;
    recordedDaemonPid = externalDaemon ? 0 : (supervisor.pid ?? 0);
    await shutdown();
    cleanedUp = true;
    let moved = false;
    let failed = false;
    try {
      moved = app.moveToApplicationsFolder();
    } catch {
      failed = true; // anything but the person's own cancel; the error text may carry a path, so it is not shown
    }
    if (moved) return;
    quitting = false;
    cleanedUp = false;
    if (!paused) await startDaemon();
    controller.cancelWait();
    if (failed)
      notify(
        "OCW was not moved",
        "Move OCW to the Applications folder in the Finder, then open it from there.",
      );
    void pollStatus();
  });
}

/** The update lines' actions (tray, Runtime menu and the onboarding window's update panel). */
function runUpdateAction(action: AppUpdateMenuAction, url?: string): void {
  const controller = appUpdate;
  if (!controller) return;
  switch (action) {
    case "check":
      if (hasPlatformUpdater) void controller.check("click");
      else void runUpdateCheck({ force: true });
      return;
    case "restart":
      void controller.restart();
      return;
    case "cancelWait":
      controller.cancelWait();
      return;
    case "openRelease":
      if (url) openReleasePage(url);
      return;
    case "moveToApplications":
      void moveToApplications();
      return;
  }
}

/** The controller's lines followed by a separator, at the top of the tray and the Runtime menu (D-09). */
function appUpdateItems(): MenuItemConstructorOptions[] {
  if (!appUpdate) return [];
  const items = appUpdateMenuModel(appUpdate.view());
  if (items.length === 0) return [];
  return [
    ...items.map((item): MenuItemConstructorOptions => {
      const { action, url } = item;
      return {
        label: item.label,
        enabled: item.enabled,
        ...(action ? { click: () => runUpdateAction(action, url) } : {}),
      };
    }),
    { type: "separator" },
  ];
}

/** The controller changed: rebuild the menus (only when a line changed) and tell the onboarding window. */
function onAppUpdateChange(): void {
  const key = appUpdate ? JSON.stringify(appUpdateMenuModel(appUpdate.view())) : "";
  if (key !== appUpdateChromeKey) {
    appUpdateChromeKey = key;
    refreshChrome();
  }
  sendOnboardingStatus();
}

function appDaemonKind(): DaemonKind {
  if (externalDaemon) return "external";
  if (paused) return "paused";
  return supervisor.state === "running" ? "ours" : "stopped";
}

/**
 * The platform updater (release builds; a loopback test feed when unpackaged) and the one controller that drives it
 * (D-01, D-02, D-08). On macOS the ad-hoc updater swaps the bundle at `app.getPath("exe")`; the test mode's dummy app
 * replaces it only unpackaged. The test mode never installs.
 */
function setUpAppUpdate(mode: UpdaterMode): void {
  const platform = createPlatformUpdater({
    platform: process.platform,
    env: process.env,
    mode,
    createMac: () =>
      createAdhocMacUpdater({
        exePath: app.getPath("exe"),
        userData: app.getPath("userData"),
        helperSource: join(__dirname, "mac-swap-helper.cjs"),
        daemonPid: () => recordedDaemonPid,
        ...(mode.kind === "test" && mode.macTestApp ? { installedAppOverride: mode.macTestApp } : {}),
      }),
  });
  hasPlatformUpdater = platform.updater !== null;
  appUpdate = new AppUpdateController({
    updater: platform.updater,
    fallback: platform.fallback,
    installAllowed: mode.kind !== "test",
    currentVersion: app.getVersion(),
    hold: async (drain) => {
      recordedDaemonPid = externalDaemon ? 0 : (supervisor.pid ?? 0);
      return controlRequest(socketPath, { cmd: "appUpdateHold", drain }, 15_000);
    },
    release: () => controlRequest(socketPath, { cmd: "appUpdateRelease" }),
    daemon: appDaemonKind,
    quit: () => app.quit(),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    notify,
    onChange: onAppUpdateChange,
  });
  appUpdate.start();
  log(hasPlatformUpdater ? "app updates: on" : `app updates: release page only (${platform.fallback})`);
}

/**
 * What the person learns once after an update (D-05, Pitfall 6), versions and file names only, never a folder:
 * - macOS (packaged, or the test mode's dummy app): a failed swap (the helper's `update-result.json`, deleted once
 *   read) and the removal of leftover staging folders or old bundles beside the app when that folder is writable.
 * - Linux AppImage: the file now has a new versioned name, so shortcuts to the old one break; the new name is stored.
 */
async function afterUpdateNotices(mode: UpdaterMode): Promise<void> {
  try {
    if (process.platform === "darwin") {
      const testApp = mode.kind === "test" ? mode.macTestApp : null;
      if (!app.isPackaged && !testApp) return;
      const result = await readSwapResult(app.getPath("userData"));
      if (result?.outcome === "failed") {
        notify(
          "OCW was not updated",
          `The update to v${result.version} could not be installed. OCW is still on v${app.getVersion()}.`,
        );
      }
      const exe = testApp ? join(testApp, "Contents", "MacOS", "OCW") : app.getPath("exe");
      const target = macInstallTarget(exe);
      if (target.ok) await sweepLeftovers(target.parent);
      return;
    }
    const appImage = process.platform === "linux" ? process.env.APPIMAGE : undefined;
    if (!appImage) return;
    const name = basename(appImage);
    const previous = store.config.lastAppImageName ?? null;
    const notice = appImageNameNotice(previous, name);
    if (notice) notify("OCW was updated", notice);
    if (name !== previous) await store.update({ lastAppImageName: name });
  } catch {
    // Best effort: nothing here may keep the app from starting.
  }
}

async function pollStatus(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const running = externalDaemon || supervisor.state === "running";
    lastReport = running && !paused ? await probeDaemon() : null;
    if (externalDaemon && !lastReport) {
      // The adopted daemon went away; supervise our own from now on.
      externalDaemon = false;
      if (!paused) supervisor.start();
    }
    // The org ∩ device level and the restart hold (07.13.1, D-07, D-08); no answer keeps the last known level.
    appUpdate?.onDaemonStatus({
      reported: lastReport !== null,
      level: lastReport?.runtimeUpdates?.effectiveLevel ?? null,
      appUpdate: lastReport?.appUpdate ?? null,
    });
  } finally {
    polling = false;
    publishStatus();
  }
}

// ---- projects -------------------------------------------------------------------------------

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
}

async function addProjectFlow(name?: string): Promise<AddProjectResult> {
  const parent = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
  const options: Electron.OpenDialogOptions = {
    title: "Add project",
    buttonLabel: "Add project",
    message:
      "Choose a project folder (a git repository or any folder). It stays on this computer; the server sees its name, never its path.",
    properties: ["openDirectory"],
  };
  const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  const chosen = picked.filePaths[0];
  if (picked.canceled || !chosen) return { ok: false, canceled: true };
  try {
    const { root, git } = await validateProjectDir(chosen, { forbidden: [ocwHome, app.getPath("userData")] });
    const raw = await controlRequest(
      socketPath,
      { cmd: "addProject", path: root, ...(name ? { name } : {}) },
      15_000,
    );
    const project = toPublicProject(LocalProject.parse(raw));
    // Folder name only: web content never sees a path (AGENTS principle 7).
    const notice = git
      ? undefined
      : `${basename(root)} has no git repository: sessions work; changes and worktrees are off.`;
    notify(
      "Project added",
      `${project.name} is ready for Work Zone sessions on this computer.${notice ? ` ${notice}` : ""}`,
    );
    void pollStatus();
    return { ok: true, project, ...(notice ? { notice } : {}) };
  } catch (err) {
    const error =
      err instanceof ProjectPathError
        ? err.message
        : err instanceof ControlError
          ? `The local runtime could not add the project: ${err.message}.`
          : "Could not add the project.";
    notify("Project not added", error);
    return { ok: false, canceled: false, error };
  }
}

async function listProjects(): Promise<PublicProject[]> {
  const raw = await controlRequest(socketPath, { cmd: "listProjects" });
  return LocalProject.array().parse(raw).map(toPublicProject);
}

// ---- windows --------------------------------------------------------------------------------

function onboardingUrlOk(url: string): boolean {
  return url.startsWith("file://") && url.includes("/renderer/onboarding/index.html");
}

function webUrlOk(url: string): boolean {
  const origin = webOrigin();
  if (!origin) return false;
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/** Linux takes the window icon from here; macOS and Windows from the app bundle / executable. */
function windowIcon(): { icon?: string } {
  return process.platform === "linux" ? { icon: asset("icon.png") } : {};
}

function openOnboarding(): void {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show();
    onboardingWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 560,
    height: 700,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Welcome to OCW",
    // hiddenInset exists only on macOS; elsewhere a hidden title bar would leave no close button.
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    ...windowIcon(),
    backgroundColor: BG,
    show: false,
    webPreferences: hardenedPreferences(join(DIST, "preload", "onboarding.cjs")),
  });
  onboardingWindow = win;
  restrictNavigation(win.webContents, () => null);
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (onboardingWindow === win) onboardingWindow = null;
  });
  void win.loadFile(join(DIST, "renderer", "onboarding", "index.html"));
}

function offlinePage(win: BrowserWindow, url: string): void {
  void win.loadFile(join(DIST, "renderer", "onboarding", "offline.html"), { query: { url } });
}

function openMain(): void {
  const url = store.config.webUrl;
  if (!url) {
    openOnboarding();
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: "OCW",
    ...windowIcon(),
    backgroundColor: BG,
    show: false,
    webPreferences: hardenedPreferences(join(DIST, "preload", "main.cjs")),
  });
  mainWindow = win;
  restrictNavigation(win.webContents, webOrigin);
  win.once("ready-to-show", () => win.show());
  win.webContents.on("did-fail-load", (_e, code, _desc, failedUrl, isMainFrame) => {
    // -3 = aborted (a redirect or a newer navigation); not an outage.
    if (isMainFrame && code !== -3 && webUrlOk(failedUrl)) offlinePage(win, url);
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    // The page waiting for a ChatGPT sign-in is gone: free the loopback port now, not in 5 minutes.
    cancelAllChatgptLoopbacks();
  });
  void win.loadURL(url);
}

// ---- IPC ------------------------------------------------------------------------------------

function handle(
  channel: string,
  trusted: (e: IpcMainInvokeEvent) => boolean,
  fn: (arg: unknown, event: IpcMainInvokeEvent) => Promise<unknown> | unknown,
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    if (!trusted(event)) throw new Error("forbidden");
    if (args.length > 1) throw new Error("invalid arguments");
    return fn(args[0], event);
  });
}

function registerIpc(): void {
  const fromWeb = (e: IpcMainInvokeEvent) => isTrustedSender(e, mainWindow?.webContents, webUrlOk);
  const fromOnboarding = (e: IpcMainInvokeEvent) =>
    isTrustedSender(e, onboardingWindow?.webContents, onboardingUrlOk);

  // window.ocwDesktop
  handle(Channels.status, fromWeb, (arg) => {
    parseArgs(NoArgs, arg);
    return status ?? computeStatus();
  });
  handle(Channels.listProjects, fromWeb, (arg) => {
    parseArgs(NoArgs, arg);
    return listProjects();
  });
  handle(Channels.addProject, fromWeb, (arg) => addProjectFlow(parseArgs(AddProjectArgs, arg)?.name));
  // CHAT-10 (T-04-11-01): the web app's unread mention count on the dock/taskbar badge. Trusted web sender only,
  // a validated integer, and nothing else reachable through it.
  handle(Channels.setBadgeCount, fromWeb, (arg) => {
    app.setBadgeCount(parseArgs(SetBadgeCountArgs, arg));
  });
  // 05-07 "Sign in with ChatGPT" without pasting (T-05-07-03/04): trusted web sender only; the one-shot listener binds
  // 127.0.0.1, serves one callback and closes (chatgpt-loopback.ts). Dev builds may open the e2e fake's
  // http://127.0.0.1 authorize page; packaged builds open https only.
  handle(Channels.chatgptLoopbackPrepare, fromWeb, (arg) => {
    parseArgs(NoArgs, arg);
    return prepareChatgptLoopback({ allowLoopbackAuthorize: !app.isPackaged });
  });
  handle(Channels.chatgptLoopbackAwait, fromWeb, (arg) => {
    const { flowToken, authorizeUrl } = parseArgs(ChatgptLoopbackAwaitArgs, arg);
    return awaitChatgptCallback(flowToken, authorizeUrl, (url) => shell.openExternal(url));
  });
  handle(Channels.chatgptLoopbackCancel, fromWeb, (arg) => {
    cancelChatgptLoopback(parseArgs(ChatgptLoopbackCancelArgs, arg).flowToken);
  });

  // window.ocwOnboarding
  handle(Channels.onboardingDefaults, fromOnboarding, (arg) => {
    parseArgs(NoArgs, arg);
    const webUrl = store.config.webUrl ?? process.env.OCW_WEB_URL ?? DEFAULT_WEB_URL;
    return {
      webUrl,
      apiUrl: store.config.apiUrl ?? deriveApiUrl(normalizeServerUrl(webUrl)),
      deviceName: store.config.deviceName ?? hostname().replace(/\.local$/, ""),
      paired: store.paired,
      platform: process.platform,
    };
  });
  handle(Channels.onboardingStatus, fromOnboarding, (arg) => {
    parseArgs(NoArgs, arg);
    return onboardingStatus();
  });
  handle(Channels.onboardingCheckServer, fromOnboarding, async (arg) => {
    const input = parseArgs(CheckServerArgs, arg);
    try {
      const webUrl = normalizeServerUrl(input.webUrl);
      const apiUrl = input.apiUrl?.trim() ? normalizeServerUrl(input.apiUrl) : deriveApiUrl(webUrl);
      const res = await checkServer(webUrl, apiUrl);
      if (res.web && res.api) await store.update({ webUrl, apiUrl });
      return { ok: res.web && res.api, webUrl, apiUrl, message: res.message };
    } catch (err) {
      return { ok: false, message: err instanceof UrlError ? err.message : "Could not check that server." };
    }
  });
  handle(Channels.onboardingEnroll, fromOnboarding, async (arg) => {
    const input = parseArgs(EnrollArgs, arg);
    try {
      const webUrl = normalizeServerUrl(input.webUrl);
      const apiUrl = normalizeServerUrl(input.apiUrl);
      const res = await enrollDevice({ apiUrl, code: input.code, deviceName: input.deviceName });
      await store.update({ webUrl, apiUrl });
      await store.setDevice({
        deviceId: res.deviceId,
        organizationId: res.organizationId ?? null,
        deviceName: input.deviceName,
        token: res.deviceToken,
      });
      // Hand the new token to the daemon (env at spawn) and reconnect.
      if (externalDaemon) {
        externalDaemon = false;
        await startDaemon();
      } else if (!paused) {
        await supervisor.restart();
      }
      publishStatus();
      return { ok: true, deviceName: input.deviceName };
    } catch (err) {
      const message =
        err instanceof EnrollError || err instanceof UrlError
          ? err.message
          : err instanceof Error && /Secure storage/.test(err.message)
            ? err.message
            : "Pairing failed. Try again.";
      return { ok: false, message };
    }
  });
  // 07.13.1 (D-09, T-07.13.1-06-01/02): the update panel's buttons run the menu's action, from a closed list and the
  // onboarding page only. Its release link stays an <a> the window-open guard checks, so it is not an action.
  handle(Channels.onboardingUpdateAction, fromOnboarding, (arg) => {
    runUpdateAction(parseArgs(UpdateActionArgs, arg));
  });
  handle(Channels.onboardingFinish, fromOnboarding, async (arg) => {
    parseArgs(FinishArgs, arg);
    await store.update({ onboarded: true });
    openMain();
    onboardingWindow?.close();
    return { ok: true };
  });
}

// ---- tray + menu ----------------------------------------------------------------------------

function statusDot(s: DesktopStatus): string {
  return s.state === "online" ? "●" : s.state === "connecting" ? "◐" : "○";
}

async function togglePause(): Promise<void> {
  if (externalDaemon) return;
  paused = !paused;
  if (paused) await supervisor.stop();
  else supervisor.start();
  void pollStatus();
}

async function unpair(): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Unpair", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Unpair this computer?",
    detail: "The local runtime stops accepting Work Zone sessions until you pair it again.",
  });
  if (response !== 0) return;
  await store.unpair();
  if (!externalDaemon && !paused) await supervisor.restart();
  publishStatus();
  openOnboarding();
}

// ADR-0012 §Decision 5: say it in plain words before the owner enables it.
const FULL_ACCESS_WARNING =
  "Full access lets agents run any command and edit any file your user can reach on this computer, without asking. " +
  "Recommended only on a dedicated machine such as a server or VM. Your organization must also allow it.";

async function readLocalFullAccess(): Promise<void> {
  try {
    localFullAccess = await readDaemonFullAccess(ocwHome);
  } catch {
    localFullAccess = false; // a malformed runtime.json is reported when the owner tries to change it
  }
}

/**
 * The device owner's Full access opt-in. Turning it on needs the native confirmation (Cancel is the default);
 * turning it off is immediate. The daemon reloads runtime.json at once (no restart): an opt-out interrupts running
 * Full access turns and tells the server. Never reachable from web content.
 */
async function setFullAccess(on: boolean): Promise<void> {
  if (on) {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Allow Full access", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "Allow Full access on this device?",
      detail: FULL_ACCESS_WARNING,
    });
    if (response !== 0) {
      refreshChrome(); // the checkbox flipped itself on click; put it back
      return;
    }
  }
  try {
    await writeDaemonFullAccess(ocwHome, on);
    localFullAccess = on;
  } catch (err) {
    dialog.showErrorBox(
      "Full access was not changed",
      err instanceof Error ? err.message : "The runtime configuration could not be written.",
    );
    refreshChrome();
    return;
  }
  await controlRequest(socketPath, { cmd: "reloadConfig" }).catch(() => undefined); // daemon down: read at start
  log(`full access ${on ? "enabled" : "disabled"} on this device`);
  await pollStatus();
  refreshChrome();
}

// 07.13 (D-10, PD-27): what the owner allows, in plain words, before the browser is turned on.
const BROWSER_WARNING =
  "Agents in Work Zone sessions on this computer can open web pages, your localhost included, in a separate browser " +
  "with its own empty profile. Your own browser and its cookies are never used.";

/** `OCW_ALLOW_BROWSER` in this app's environment reaches the daemon it starts and wins over runtime.json (PD-27). */
function browserEnv(): boolean | null {
  if (externalDaemon) return null;
  const raw = process.env.OCW_ALLOW_BROWSER;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return null;
}

async function readLocalBrowser(): Promise<void> {
  try {
    localBrowser = await readDaemonBrowser(ocwHome);
  } catch {
    localBrowser = false; // a malformed runtime.json is reported when the owner tries to change it
  }
}

/**
 * The device owner's browser opt-in (07.13, D-10, PD-27), one of the three switches the browser needs (the
 * organization's policy and a capable device are the others). Turning it on needs the native confirmation (Cancel is
 * the default); turning it off is immediate. Written to runtime.json; the daemon reloads it at once. Main-process menu
 * only: never reachable from web content or the preload API.
 */
async function setBrowser(on: boolean): Promise<void> {
  if (on) {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Allow the browser", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "Allow the browser on this computer?",
      detail: BROWSER_WARNING,
    });
    if (response !== 0) {
      refreshChrome(); // the checkbox flipped itself on click; put it back
      return;
    }
  }
  try {
    await writeDaemonBrowser(ocwHome, on);
    localBrowser = on;
  } catch (err) {
    dialog.showErrorBox(
      "The browser setting was not changed",
      err instanceof Error ? err.message : "The runtime configuration could not be written.",
    );
    refreshChrome();
    return;
  }
  await controlRequest(socketPath, { cmd: "reloadConfig" }).catch(() => undefined); // daemon down: read at start
  log(`browser ${on ? "allowed" : "turned off"} on this computer`);
  await pollStatus();
  refreshChrome();
}

function browserItem(): MenuItemConstructorOptions {
  const fromEnv = browserEnv();
  return {
    label:
      fromEnv === null
        ? "Allow the browser on this computer…"
        : "Allow the browser on this computer… (set by OCW_ALLOW_BROWSER)",
    type: "checkbox",
    checked: fromEnv ?? localBrowser,
    enabled: fromEnv === null,
    click: () => void setBrowser(!localBrowser),
  };
}

async function readLocalUpdatesLevel(): Promise<void> {
  try {
    localUpdatesLevel = await readDaemonRuntimeUpdates(ocwHome);
  } catch {
    localUpdatesLevel = "automatic"; // a malformed runtime.json is reported when the owner tries to change it
  }
}

/**
 * The device owner's runtime updates level (07.11, D-02): it can only lower the organization's level, so no
 * confirmation. Written to runtime.json; the daemon reloads it at once (no restart), drops a pending automatic update
 * when lowered and tells the server. Never reachable from web content.
 */
async function setRuntimeUpdatesLevel(level: DesktopRuntimeUpdatesLevel): Promise<void> {
  try {
    await writeDaemonRuntimeUpdates(ocwHome, level);
    localUpdatesLevel = level;
  } catch (err) {
    dialog.showErrorBox(
      "Runtime updates were not changed",
      err instanceof Error ? err.message : "The runtime configuration could not be written.",
    );
    refreshChrome(); // the radio item moved itself on click; put it back
    return;
  }
  await controlRequest(socketPath, { cmd: "reloadConfig" }).catch(() => undefined); // daemon down: read at start
  log(`runtime updates set to ${level} on this device`);
  await pollStatus();
  refreshChrome();
}

/** Each runtime's update status (disabled lines) and the "Runtime updates" submenu; nothing from an older daemon. */
function runtimeUpdatesItems(): MenuItemConstructorOptions[] {
  const lines = runtimeUpdateLines(lastReport);
  const model = runtimeUpdatesMenuModel(lastReport, localUpdatesLevel);
  if (lines.length === 0 && !model) return [];
  const items: MenuItemConstructorOptions[] = [
    { type: "separator" },
    ...lines.map((label): MenuItemConstructorOptions => ({ label, enabled: false })),
  ];
  if (model) {
    items.push({
      label: model.label,
      submenu: [
        ...(model.note
          ? ([{ label: model.note, enabled: false }, { type: "separator" }] as MenuItemConstructorOptions[])
          : []),
        ...model.items.map(
          (i): MenuItemConstructorOptions => ({
            label: i.label,
            type: "radio",
            checked: i.checked,
            enabled: i.enabled,
            click: () => {
              if (!i.checked) void setRuntimeUpdatesLevel(i.level);
            },
          }),
        ),
      ],
    });
  }
  return items;
}

function fullAccessItem(s: DesktopStatus): MenuItemConstructorOptions {
  const fromEnv = lastReport?.fullAccessSource === "env";
  return {
    label: fromEnv
      ? "Allow Full access on this device… (set by OCW_ALLOW_FULL_ACCESS)"
      : "Allow Full access on this device…",
    type: "checkbox",
    checked: s.fullAccessOptIn,
    enabled: !fromEnv,
    click: () => void setFullAccess(!s.fullAccessOptIn),
  };
}

function runtimeItems(s: DesktopStatus): MenuItemConstructorOptions[] {
  return [
    { label: `${statusDot(s)}  ${s.label}`, enabled: false },
    ...(s.deviceName ? [{ label: `This device: ${s.deviceName}`, enabled: false }] : []),
    { type: "separator" },
    ...(s.state === "needs_pairing" ? [{ label: "Pair this computer…", click: () => openOnboarding() }] : []),
    { label: "Open workspace", accelerator: "CmdOrCtrl+O", click: () => openMain() },
    { label: "Add project…", click: () => void addProjectFlow() },
    {
      label: paused ? "Resume runtime" : "Pause runtime",
      enabled: !externalDaemon,
      click: () => void togglePause(),
    },
    { type: "separator" },
    fullAccessItem(s),
    browserItem(),
    ...runtimeUpdatesItems(),
  ];
}

/** macOS tints black template images; Windows and Linux get the coloured icon (faded when offline). */
function trayImage(online: boolean): Electron.NativeImage {
  const name =
    process.platform === "darwin"
      ? online
        ? "trayTemplate.png"
        : "trayOfflineTemplate.png"
      : online
        ? "trayColor.png"
        : "trayColorOffline.png";
  return nativeImage.createFromPath(asset("tray", name));
}

function refreshChrome(): void {
  const s = status ?? computeStatus();
  if (tray) {
    const online = s.state === "online";
    tray.setImage(trayImage(online));
    tray.setToolTip(`OCW · ${s.label}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        ...appUpdateItems(),
        ...runtimeItems(s),
        { type: "separator" },
        { label: "Quit OCW", role: "quit" },
      ]),
    );
  }
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { label: "Server and pairing…", click: () => openOnboarding() },
              ...(s.paired ? [{ label: "Unpair this computer…", click: () => void unpair() }] : []),
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ] as MenuItemConstructorOptions[],
          },
        ]
      : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Runtime",
      submenu: [
        ...appUpdateItems(),
        ...runtimeItems(s),
        { type: "separator" },
        {
          label: "Show runtime log",
          click: () => shell.showItemInFolder(join(app.getPath("userData"), "logs", "daemon.log")),
        },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- lifecycle ------------------------------------------------------------------------------

async function shutdown(): Promise<void> {
  if (!externalDaemon) await supervisor.stop();
  await pidChain;
  if (!externalDaemon) await removePidfile(pidfile).catch(() => undefined);
}

async function main(): Promise<void> {
  app.setName("OCW");
  app.setAboutPanelOptions({
    applicationName: "OCW",
    applicationVersion: app.getVersion(),
    copyright: "Open Collaborative AI Workspace · AGPL-3.0",
  });

  app.on("second-instance", () => {
    // During a quit (an update's restart included) a second start must not reopen windows (T-07.13.1-05-05).
    if (quitting) return;
    if (store?.config.onboarded) openMain();
    else openOnboarding();
  });

  await app.whenReady();

  store = new ConfigStore(app.getPath("userData"), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  });
  await store.load();
  await readLocalFullAccess();
  await readLocalBrowser();
  await readLocalUpdatesLevel();

  supervisor = new DaemonSupervisor({
    spawn: spawnDaemon,
    killGroup,
    // Serialised so a restart's "remove old" can never land after "write new".
    onSpawned: (pid) => pidOp(() => writePidfile(pidfile, pid)),
    onExited: (pid) => pidOp(() => removePidfileIfOwner(pidfile, pid)),
  });
  supervisor.on("state", () => publishStatus());
  supervisor.on("restart-scheduled", (ms: number) => log(`daemon exited; restarting in ${ms} ms`));
  supervisor.on("spawn-error", () => log("daemon failed to spawn"));

  const updateMode = updaterMode({
    isPackaged: app.isPackaged,
    releaseBuild: RELEASE_BUILD,
    env: process.env,
  });
  setUpAppUpdate(updateMode);

  installGlobalGuards(app, webOrigin);
  registerIpc();

  if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(asset("icon.png"));
  tray = new Tray(trayImage(false));
  refreshChrome();

  if (store.config.onboarded && store.config.webUrl) openMain();
  else openOnboarding();

  // Before the daemon starts: the first automatic check waits for its first status, so the leftover sweep is done
  // before any download can stage a new update beside the app.
  await afterUpdateNotices(updateMode);
  await startDaemon();
  publishStatus();
  setInterval(() => void pollStatus(), STATUS_POLL_MS).unref();
  void pollStatus();
  void runUpdateCheck();
  setInterval(() => void runUpdateCheck(), UPDATE_CHECK_INTERVAL_MS).unref();

  app.on("activate", () => (store.config.onboarded ? openMain() : openOnboarding()));
  // Keep running in the menu bar when windows close (macOS convention; the runtime keeps serving).
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    cancelAllChatgptLoopbacks();
    if (cleanedUp) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    // Before shutdown() clears the supervisor's child: the macOS swap helper waits for this pid (0: none ran).
    recordedDaemonPid = externalDaemon ? 0 : (supervisor.pid ?? 0);
    void shutdown().finally(() => {
      cleanedUp = true;
      app.quit();
    });
  });
  // The only place an update installs (07.13.1, D-07, Pitfall 3): `quit` follows the `before-quit` above, which awaited
  // shutdown(), so the daemon is already stopped. The unpackaged test mode never installs.
  app.on("quit", () => appUpdate?.onQuit());
  // Last resort if the app is torn down without before-quit: never orphan the daemon.
  process.on("exit", () => {
    const pid = supervisor.pid;
    if (pid !== undefined && !externalDaemon) {
      try {
        killGroup(pid, "SIGTERM");
      } catch {
        // gone
      }
    }
  });
}

if (process.env.APPIMAGE_EXIT_AFTER_INSTALL === "true") {
  // electron-updater runs the new AppImage once with this variable after replacing the file on a normal quit (no
  // relaunch wanted): that instance exits at once, before any window, tray or daemon (Pitfall 6).
  app.exit(0);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}
