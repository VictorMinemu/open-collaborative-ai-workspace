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
  /^CHROME_/,
  /^GOOGLE_API_KEY$/,
];

/** Common user tool locations; apps launched from Finder get a minimal PATH. */
export function augmentPath(path: string | undefined, home = homedir()): string {
  const parts = (path ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(delimiter).filter(Boolean);
  for (const extra of [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]) {
    if (!parts.includes(extra)) parts.push(extra);
  }
  return parts.join(delimiter);
}

export function buildDaemonEnv(
  base: NodeJS.ProcessEnv,
  opts: { token: string | null; apiUrl: string | null; electronAsNode: boolean; home?: string },
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
  return env;
}

export function ocwHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OCW_HOME ? resolve(env.OCW_HOME) : join(homedir(), ".ocw");
}
