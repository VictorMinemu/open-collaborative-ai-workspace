// The macOS swap (07.13.1, D-05), run by the detached helper (`mac-swap-helper.ts`, Electron as Node) that the app
// starts on its way out. It reads only its argv, validated again here: it waits (bounded) for the app's pid and, when
// one is given, its daemon's pid to exit, renames the installed `OCW.app` to `.OCW.app.old-<ts>` and the staged
// bundle to `OCW.app` (one volume, so both are atomic renames), renames the old bundle back if the second rename fails
// (rollback), removes the old bundle and the staging folder only after success, writes `update-result.json` (outcome,
// version, reason, time; never a path) for the next start and relaunches with `/usr/bin/open` when asked. It prints
// nothing, spawns no shell and listens on nothing. No Electron imports: the helper bundle must run without Electron's
// main-process modules (unit-tested).

import { spawn } from "node:child_process";
import { chmod, lstat, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { z } from "zod";

/** Only a stable `x.y.z` (D-02); it also names the staging folder, so nothing else may reach a path. */
export const STABLE_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
export const APP_NAME = "OCW.app";
export const RESULT_FILE = "update-result.json";
export const stagingDirName = (version: string) => `.ocw-update-${version}`;

/** The last swap's outcome, read (and deleted) at the next start. Strict, and no field can hold a path. */
export const SwapResult = z.strictObject({
  outcome: z.enum(["installed", "failed"]),
  version: z.string().regex(STABLE_VERSION),
  reason: z.enum(["app_still_running", "swap_failed", "rollback_failed", "install_failed"]).optional(),
  at: z.iso.datetime(),
});
export type SwapResult = z.infer<typeof SwapResult>;
type FailReason = NonNullable<SwapResult["reason"]>;

export interface HelperArgs {
  appPid: number;
  /** null: no daemon to wait for (already stopped, paused or external). */
  daemonPid: number | null;
  installedApp: string;
  stagedApp: string;
  resultFile: string;
  version: string;
  relaunch: boolean;
}

const PID = /^\d{1,10}$/;
const MAX_PID = 2_147_483_647;

class HelperArgsError extends Error {
  constructor() {
    super("invalid swap helper arguments");
    this.name = "HelperArgsError";
  }
}

const cleanAbsolute = (p: string) => isAbsolute(p) && normalize(p) === p && !p.endsWith("/");

function pid(value: string | undefined, min: number): number {
  if (value === undefined || !PID.test(value)) throw new HelperArgsError();
  const n = Number(value);
  if (n < min || n > MAX_PID) throw new HelperArgsError();
  return n;
}

/**
 * `[appPid, daemonPid, installedApp, stagedApp, resultFile, version, relaunch]`. The staged app must be
 * `<installedApp's folder>/.ocw-update-<version>/OCW.app`; `daemonPid` `0` means there is no daemon to wait for.
 * Throws a fixed error (never naming a path) on anything else.
 */
export function parseHelperArgs(argv: readonly string[]): HelperArgs {
  if (argv.length !== 7) throw new HelperArgsError();
  const [appPidArg, daemonPidArg, installedApp, stagedApp, resultFile, version, relaunch] = argv;
  const appPid = pid(appPidArg, 1);
  const daemon = pid(daemonPidArg, 0);
  if (version === undefined || !STABLE_VERSION.test(version)) throw new HelperArgsError();
  if (installedApp === undefined || !cleanAbsolute(installedApp) || basename(installedApp) !== APP_NAME) {
    throw new HelperArgsError();
  }
  if (stagedApp !== join(dirname(installedApp), stagingDirName(version), APP_NAME))
    throw new HelperArgsError();
  if (resultFile === undefined || !cleanAbsolute(resultFile) || basename(resultFile) !== RESULT_FILE) {
    throw new HelperArgsError();
  }
  if (relaunch !== "0" && relaunch !== "1") throw new HelperArgsError();
  return {
    appPid,
    daemonPid: daemon === 0 ? null : daemon,
    installedApp,
    stagedApp,
    resultFile,
    version,
    relaunch: relaunch === "1",
  };
}

/**
 * Whether a process exists. Only a pid ≥ 1 is ever signalled: `kill(0, …)` and negative pids address process groups
 * (pid 0 is the caller's own group, always alive), so they answer false without a signal. EPERM means it exists.
 */
export function isProcessAlive(target: number): boolean {
  if (!Number.isSafeInteger(target) || target < 1) return false;
  try {
    process.kill(target, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

export interface SwapDeps {
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  openApp?: (app: string) => void;
  now?: () => number;
  rename?: (from: string, to: string) => Promise<void>;
}

const POLL_MS = 200;
const APP_WAIT_MS = 60_000;
const DAEMON_WAIT_MS = 30_000;

const defaultOpen = (app: string) => {
  const child = spawn("/usr/bin/open", [app], { detached: true, stdio: "ignore" });
  child.once("error", () => undefined);
  child.unref();
};

/** Swaps the bundle once the app (and its daemon) exited; never throws, always writes a result when it can. */
export async function runSwap(args: HelperArgs, deps: SwapDeps = {}): Promise<SwapResult> {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const openApp = deps.openApp ?? defaultOpen;
  const now = deps.now ?? Date.now;
  const move = deps.rename ?? rename;

  const waitGone = async (target: number, boundMs: number): Promise<boolean> => {
    for (let polls = Math.ceil(boundMs / POLL_MS); isAlive(target); polls -= 1) {
      if (polls <= 0) return false;
      await sleep(POLL_MS);
    }
    return true;
  };

  const finish = async (outcome: SwapResult["outcome"], reason?: FailReason): Promise<SwapResult> => {
    const result: SwapResult = SwapResult.parse({
      outcome,
      version: args.version,
      ...(reason ? { reason } : {}),
      at: new Date(now()).toISOString(),
    });
    const tmp = `${args.resultFile}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(result)}\n`, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await move(tmp, args.resultFile);
    } catch {
      await rm(tmp, { force: true }).catch(() => undefined);
    }
    return result;
  };
  const relaunch = () => {
    if (!args.relaunch) return;
    try {
      openApp(args.installedApp);
    } catch {
      // nothing to report to: the result file already says what happened
    }
  };

  // A running app cannot be replaced, and `open` would only bring it to the front: wait for it first.
  if (!(await waitGone(args.appPid, APP_WAIT_MS))) return finish("failed", "app_still_running");
  if (args.daemonPid !== null && !(await waitGone(args.daemonPid, DAEMON_WAIT_MS))) {
    const out = await finish("failed", "app_still_running");
    relaunch();
    return out;
  }

  const parent = dirname(args.installedApp);
  const old = join(parent, `.OCW.app.old-${now()}`);
  try {
    await move(args.installedApp, old);
  } catch {
    const out = await finish("failed", "swap_failed");
    relaunch();
    return out;
  }
  try {
    await move(args.stagedApp, args.installedApp);
  } catch {
    // rollback: the original bundle goes back to its path
    try {
      await move(old, args.installedApp);
    } catch {
      const out = await finish("failed", "rollback_failed");
      // Review WR-04: no OCW.app is left; the old bundle, hidden under its dot name, is the only working copy. It is
      // opened where it is (relaunch asked or not), so the person keeps an app and reads the notice.
      const stillThere = await lstat(old).then(
        (st) => st.isDirectory(),
        () => false,
      );
      if (stillThere) {
        try {
          openApp(old);
        } catch {
          // the result file already says what happened
        }
      }
      return out;
    }
    const out = await finish("failed", "swap_failed");
    relaunch();
    return out;
  }
  await rm(old, { recursive: true, force: true }).catch(() => undefined);
  await rm(dirname(args.stagedApp), { recursive: true, force: true }).catch(() => undefined);
  const out = await finish("installed");
  relaunch();
  return out;
}
