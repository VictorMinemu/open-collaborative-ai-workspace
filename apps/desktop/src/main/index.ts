// OCW desktop shell (Electron main process).
//
// - Single instance; dock + menu-bar (tray) app.
// - First run: bundled onboarding page (server URL + pairing code → POST /devices/enroll).
// - Device token encrypted with safeStorage; passed to the daemon via env at spawn time.
// - Supervises apps/local-runtime (ADR-0005) and talks to it ONLY over the Unix control socket.
// - Main window loads the web app; `window.ocwDesktop` is a narrow, validated bridge.
// - Full access opt-in (ADR-0012): switched ONLY from the Runtime menu / tray here, after a native confirmation;
//   written to the daemon's runtime.json and applied with `reloadConfig`. Web content can only read it.

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync, truncateSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
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
  type DesktopStatus,
  EnrollArgs,
  FinishArgs,
  LocalProject,
  NoArgs,
  type PublicProject,
  parseArgs,
  SetBadgeCountArgs,
  toPublicProject,
} from "../shared/ipc";
import { ProjectPathError, validateProjectDir } from "../shared/project-path";
import { type DaemonProcessState, deriveStatus, sameStatus } from "../shared/status";
import { deriveApiUrl, normalizeServerUrl, UrlError } from "../shared/urls";
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
import { pidfilePath, reapStaleDaemon, removePidfile, removePidfileIfOwner, writePidfile } from "./pidfile";
import { readDaemonFullAccess, writeDaemonFullAccess } from "./runtime-config";
import { hardenedPreferences, installGlobalGuards, isTrustedSender, restrictNavigation } from "./security";
import { DaemonSupervisor } from "./supervisor";

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
let status: DesktopStatus | null = null;
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
  });
  const out = openDaemonLog();
  try {
    // detached → own process group, so stop() can signal the daemon and everything it spawned.
    return spawn(cmd.command, cmd.args, { cwd: cmd.cwd, env, detached: true, stdio: ["ignore", out, out] });
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
  if (sameStatus(status, next)) return;
  status = next;
  for (const w of [mainWindow, onboardingWindow]) {
    if (w && !w.isDestroyed()) w.webContents.send(Channels.statusChanged, next);
  }
  refreshChrome();
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
    message: "Choose a git repository. It stays on this computer; the server sees its name, never its path.",
    properties: ["openDirectory"],
  };
  const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  const chosen = picked.filePaths[0];
  if (picked.canceled || !chosen) return { ok: false, canceled: true };
  try {
    const root = await validateProjectDir(chosen, { forbidden: [ocwHome, app.getPath("userData")] });
    const raw = await controlRequest(
      socketPath,
      { cmd: "addProject", path: root, ...(name ? { name } : {}) },
      15_000,
    );
    const project = toPublicProject(LocalProject.parse(raw));
    notify("Project added", `${project.name} is ready for Work Zone sessions on this computer.`);
    void pollStatus();
    return { ok: true, project };
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
    titleBarStyle: "hiddenInset",
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
    return status ?? computeStatus();
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
  ];
}

function refreshChrome(): void {
  const s = status ?? computeStatus();
  if (tray) {
    const online = s.state === "online";
    tray.setImage(
      nativeImage.createFromPath(asset("tray", online ? "trayTemplate.png" : "trayOfflineTemplate.png")),
    );
    tray.setToolTip(`OCW · ${s.label}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
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

  app.on("second-instance", () => (store?.config.onboarded ? openMain() : openOnboarding()));

  await app.whenReady();

  store = new ConfigStore(app.getPath("userData"), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  });
  await store.load();
  await readLocalFullAccess();

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

  installGlobalGuards(app, webOrigin);
  registerIpc();

  if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(asset("icon.png"));
  tray = new Tray(nativeImage.createFromPath(asset("tray", "trayOfflineTemplate.png")));
  refreshChrome();

  if (store.config.onboarded && store.config.webUrl) openMain();
  else openOnboarding();

  await startDaemon();
  publishStatus();
  setInterval(() => void pollStatus(), STATUS_POLL_MS).unref();
  void pollStatus();

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
    void shutdown().finally(() => {
      cleanedUp = true;
      app.quit();
    });
  });
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}
