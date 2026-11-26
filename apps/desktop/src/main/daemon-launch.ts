// How the desktop app starts the Local Runtime daemon: which entry script, which Node binary
// (Electron's own, as plain Node via ELECTRON_RUN_AS_NODE), and which environment. The device
// token goes in through `OCW_DEVICE_TOKEN`, which the daemon deletes from its own env on read,
// so it is never written to disk in plaintext. No Electron imports (unit-tested).

import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

export interface LaunchContext {
  isPackaged: boolean;
  /** `app.getAppPath()`: apps/desktop in dev. */
  appPath: string;
  /** `process.resourcesPath` in the packaged app. */
  resourcesPath: string;
  /** Electron binary (`process.execPath`). */
  execPath: string;
  env: NodeJS.ProcessEnv;
}

export interface DaemonCommand {
  command: string;
  args: string[];
  cwd: string;
  /** True when `command` is the Electron binary and must run in Node mode. */
  electronAsNode: boolean;
}

export function resolveDaemonCommand(ctx: LaunchContext): DaemonCommand {
  const entry =
    ctx.env.OCW_DAEMON_ENTRY ??
    (ctx.isPackaged
      ? join(ctx.resourcesPath, "daemon", "bin", "ocw-runtime")
      : resolve(ctx.appPath, "..", "local-runtime", "bin", "ocw-runtime"));
  const node = ctx.env.OCW_DAEMON_NODE;
  return {
    command: node ?? ctx.execPath,
    args: [entry, "run"],
    cwd: dirname(dirname(entry)),
    electronAsNode: node === undefined,
  };
}

/** Variables that must never leak from the desktop process into the daemon. */
const DROP = [
  /^ELECTRON_/,
  /^OCW_DEVICE_TOKEN/,
  /^OCW_DAEMON_/,
  /^OCW_DESKTOP_/,
  /^OCW_APP_VERSION$/,
  /^CHROME_/,
  /^GOOGLE_API_KEY$/,
  // The AppImage updater's markers for this app's own start (review WR-02).
  /^APPIMAGE_SILENT_INSTALL$/,
  /^APPIMAGE_EXIT_AFTER_INSTALL$/,
];

/** Common user tool locations; apps launched from Finder get a minimal PATH. */
export function augmentPath(path: string | undefined, home = homedir()): string {
  const parts = (path ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(delimiter).filter(Boolean);
  for (const extra of [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]) {
    if (!parts.includes(extra)) parts.push(extra);
  }
  return parts.join(delimiter);
}

/** A plain semver (`0.5.0`, `0.5.0-rc.1`), bounded like `DeviceInfo.appVersion`; anything else is not reported. */
const APP_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function buildDaemonEnv(
  base: NodeJS.ProcessEnv,
  opts: {
    token: string | null;
    apiUrl: string | null;
    electronAsNode: boolean;
    home?: string;
    /** `app.getVersion()`: the daemon reports it as `DeviceInfo.appVersion` (07.13, D-18, PD-21). */
    appVersion?: string;
  },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || DROP.some((re) => re.test(k))) continue;
    env[k] = v;
  }
  env.PATH = augmentPath(base.PATH, opts.home);
  if (opts.electronAsNode) env.ELECTRON_RUN_AS_NODE = "1";
  if (opts.apiUrl) env.OCW_SERVER_URL = opts.apiUrl;
  if (opts.token) env.OCW_DEVICE_TOKEN = opts.token;
  // 07.16 PD-18: tells the daemon it runs under the desktop app (an inherited value is replaced); the server honours
  // the isolated-server mark only for headless services.
  env.OCW_RUNTIME_HOST = "desktop";
  // An inherited value is always dropped above: only this app's own version is reported.
  if (opts.appVersion && opts.appVersion.length <= 64 && APP_VERSION.test(opts.appVersion)) {
    env.OCW_APP_VERSION = opts.appVersion;
  }
  return env;
}

export function ocwHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OCW_HOME ? resolve(env.OCW_HOME) : join(homedir(), ".ocw");
}
