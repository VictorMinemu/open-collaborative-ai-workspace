// The macOS installer of the desktop app's self-update (07.13.1, D-01, D-04, D-05). Squirrel.Mac (electron-updater's
// MacUpdater) validates an update against the running app's designated requirement, which for an ad-hoc signed build is
// the cdhash of that one build, so every update would fail; it also listens on a loopback TCP port. macOS therefore
// gets its own installer: the downloaded release zip is extracted with `ditto` into `.ocw-update-<version>/` beside
// the installed `OCW.app` (same volume, so the swap is a rename), and the staged bundle is kept only when
// `codesign --verify --deep --strict` passes, its bundle id is `dev.ocw.desktop`, its version is the expected stable
// version, its bundled daemon is there and its framework symlinks survived. Anything else removes the staging folder
// and leaves the installed app untouched. Every tool runs from its absolute path with an argv array, never through a
// shell; errors carry a fixed code and a fixed sentence, never a path or a tool's output.
//
// `AdhocMacUpdater`, a subclass of electron-updater's BaseUpdater, keeps its check, download and sha512 (from
// latest-mac.yml): it downloads the release's `.zip` through `executeDownload`, stages it in `prepareDownloaded` (the
// controller calls it on `update-downloaded`, so a valid cached download from an earlier run is staged too) and
// installs by starting the detached swap helper (mac-swap.ts) with Electron as Node, argv only, when the app quits.
// It never constructs electron-updater's MacUpdater, never listens on a port and never asks for elevation: a folder
// this user cannot write gets the release-page notice instead. No Electron imports (electron-updater is mocked in the
// tests).

import { execFile, spawn } from "node:child_process";
import {
  accessSync,
  chmodSync,
  existsSync,
  constants as fsConstants,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { BaseUpdater } from "electron-updater";
import type {
  DownloadExecutorResult,
  DownloadExecutorTask,
  DownloadUpdateOptions,
} from "electron-updater/out/AppUpdater";
import { APP_NAME, RESULT_FILE, STABLE_VERSION, SwapResult, stagingDirName } from "./mac-swap";

export const BUNDLE_ID = "dev.ocw.desktop";

const MESSAGES = {
  dmg: "OCW is running from its disk image.",
  translocated: "OCW is running from a translocated copy.",
  not_bundle: "OCW is not running from an OCW app bundle.",
  unwritable: "The folder that holds OCW is not writable.",
  bad_version: "The update has no stable version.",
  extract_failed: "The update could not be extracted.",
  no_app: "The update holds no OCW app.",
  seal_invalid: "The update's code signature is not valid.",
  wrong_bundle: "The update is not the OCW app.",
  wrong_version: "The update's version is not the expected one.",
  no_daemon: "The update holds no Local Runtime.",
  symlinks_lost: "The update lost its framework links.",
  no_zip: "The release has no macOS zip.",
  helper_failed: "The update's install helper could not be prepared.",
  install_failed: "The update's install helper could not be started.",
} as const;

export type MacUpdateErrorCode = keyof typeof MESSAGES;

/** A refused or failed macOS update: a fixed code and a fixed sentence, never a path. */
export class MacUpdateError extends Error {
  readonly code: MacUpdateErrorCode;
  constructor(code: MacUpdateErrorCode) {
    super(MESSAGES[code]);
    this.name = "MacUpdateError";
    this.code = code;
  }
}

export type MacTargetRefusal = "dmg" | "translocated" | "unwritable" | "not_bundle";
export type MacInstallTarget =
  | { ok: true; app: string; parent: string }
  | { ok: false; reason: MacTargetRefusal };

const defaultIsWritable = (dir: string): boolean => {
  try {
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Where an update can be installed, from the running executable (`app.getPath("exe")`). A disk image, a translocated
 * copy, anything that is not `…/OCW.app/Contents/MacOS/<exe>` or a folder this user cannot write gets the release-page
 * notice instead (plan 05 offers "Move OCW to Applications").
 */
export function macInstallTarget(
  exePath: string,
  opts: { isWritable?: (dir: string) => boolean } = {},
): MacInstallTarget {
  if (!isAbsolute(exePath) || normalize(exePath) !== exePath) return { ok: false, reason: "not_bundle" };
  if (exePath.startsWith("/Volumes/")) return { ok: false, reason: "dmg" };
  if (exePath.includes("/AppTranslocation/")) return { ok: false, reason: "translocated" };
  const m = /^(.+\/[^/]+\.app)\/Contents\/MacOS\/[^/]+$/.exec(exePath);
  const app = m?.[1];
  if (!app || basename(app) !== APP_NAME) return { ok: false, reason: "not_bundle" };
  const parent = dirname(app);
  if (!(opts.isWritable ?? defaultIsWritable)(parent)) return { ok: false, reason: "unwritable" };
  return { ok: true, app, parent };
}

/** Runs one tool from its absolute path with an argv array; rejects on a non-zero exit or the timeout. */
export type RunTool = (
  cmd: string,
  args: readonly string[],
  opts: { timeoutMs: number },
) => Promise<{ stdout: string }>;

export const runTool: RunTool = (cmd, args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      [...args],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve({ stdout })),
    );
  });

const TIMEOUT = { ditto: 5 * 60_000, codesign: 2 * 60_000, plutil: 30_000, xattr: 30_000 } as const;

/** Removes a path without following it: a symlink is unlinked, a folder removed with its content. */
async function removePath(path: string): Promise<void> {
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(path);
  } catch {
    return;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) await unlink(path);
  else await rm(path, { recursive: true, force: true });
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

/** Every `*.framework` in `Contents/Frameworks` must keep `Versions/Current` as a symlink (Pitfall 4). */
async function frameworkLinksSurvived(app: string): Promise<boolean> {
  const dir = join(app, "Contents", "Frameworks");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return true; // no frameworks (the test dummy)
  }
  for (const name of entries) {
    if (!name.endsWith(".framework")) continue;
    try {
      if (!(await lstat(join(dir, name, "Versions", "Current"))).isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export interface StagedUpdate {
  /** `<parent>/.ocw-update-<version>` */
  stagingDir: string;
  /** `<stagingDir>/OCW.app`, verified */
  stagedApp: string;
}

/**
 * Extracts the downloaded zip beside the installed app and verifies it (D-04). Any failure removes the staging folder
 * and throws a `MacUpdateError`; the installed app is never touched here.
 */
export async function stageUpdate(opts: {
  zipPath: string;
  version: string;
  target: { parent: string };
  run?: RunTool;
}): Promise<StagedUpdate> {
  const { zipPath, version, target } = opts;
  if (!STABLE_VERSION.test(version)) throw new MacUpdateError("bad_version");
  const run = opts.run ?? runTool;
  const stagingDir = join(target.parent, stagingDirName(version));
  const stagedApp = join(stagingDir, APP_NAME);
  const step = async (code: MacUpdateErrorCode, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch {
      throw new MacUpdateError(code);
    }
  };
  try {
    await step("extract_failed", async () => {
      await removePath(stagingDir);
      await mkdir(stagingDir, { mode: 0o700 });
      await run("/usr/bin/ditto", ["-x", "-k", zipPath, stagingDir], { timeoutMs: TIMEOUT.ditto });
    });
    const st = await lstat(stagedApp).catch(() => null);
    if (!st?.isDirectory()) throw new MacUpdateError("no_app");
    await step("seal_invalid", () =>
      run("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedApp], {
        timeoutMs: TIMEOUT.codesign,
      }),
    );
    const plist = join(stagedApp, "Contents", "Info.plist");
    const read = async (key: string): Promise<string | null> => {
      try {
        const { stdout } = await run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist], {
          timeoutMs: TIMEOUT.plutil,
        });
        return stdout.trim();
      } catch {
        return null;
      }
    };
    if ((await read("CFBundleIdentifier")) !== BUNDLE_ID) throw new MacUpdateError("wrong_bundle");
    if ((await read("CFBundleShortVersionString")) !== version) throw new MacUpdateError("wrong_version");
    if (!(await isFile(join(stagedApp, "Contents", "Resources", "daemon", "bin", "ocw-runtime")))) {
      throw new MacUpdateError("no_daemon");
    }
    if (!(await frameworkLinksSurvived(stagedApp))) throw new MacUpdateError("symlinks_lost");
    // A download by the app's own HTTP client carries no quarantine; cleared anyway, its exit status ignored.
    await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", stagedApp], {
      timeoutMs: TIMEOUT.xattr,
    }).catch(() => undefined);
    return { stagingDir, stagedApp };
  } catch (err) {
    await removePath(stagingDir).catch(() => undefined);
    throw err instanceof MacUpdateError ? err : new MacUpdateError("extract_failed");
  }
}

/** Starts the detached helper; the default is `child_process.spawn` (never a shell) with its error swallowed. */
export type SpawnDetached = (
  command: string,
  args: readonly string[],
  options: { detached: true; stdio: "ignore"; env: Record<string, string> },
) => { unref(): void };

const spawnDetached: SpawnDetached = (command, args, options) => {
  const child = spawn(command, [...args], options);
  child.once("error", () => undefined);
  return child;
};

type DownloadOptions = Parameters<DownloadExecutorTask["task"]>[1];

/** The swap helper's file name inside the staging folder. */
export const HELPER_FILE = "swap-helper.cjs";

interface Prepared {
  version: string;
  stagingDir: string;
  stagedApp: string;
  helper: string;
}

export interface AdhocMacUpdaterOptions {
  target: { app: string; parent: string };
  /** `app.getPath("userData")`: where the helper writes update-result.json. */
  userData: string;
  /** The bundled helper (`dist/main/mac-swap-helper.cjs`, inside the app's asar). */
  helperSource: string;
  /**
   * The pid of the app's own daemon, recorded before the app stopped it (plan 05); 0 when there was none of its own
   * (paused, external or already stopped), and the helper then skips the daemon wait.
   */
  daemonPid: () => number;
  run?: RunTool;
  spawn?: SpawnDetached;
}

/** electron-updater for an ad-hoc signed macOS app: its download and sha512, our verified stage and swap (D-01, D-05). */
export class AdhocMacUpdater extends BaseUpdater {
  /** electron-updater's HTTP client, set by AppUpdater's constructor (not in its published typings). */
  declare protected readonly httpExecutor: {
    download(url: URL, destination: string, options: DownloadOptions): Promise<string>;
  } | null;

  /** The installed bundle the update replaces. */
  readonly installedApp: string;
  private readonly parentDir: string;
  private readonly userData: string;
  private readonly helperSource: string;
  private readonly daemonPid: () => number;
  private readonly run: RunTool;
  private readonly spawnHelper: SpawnDetached;
  private prepared: Prepared | null = null;
  private preparing: { version: string; promise: Promise<void> } | null = null;

  constructor(opts: AdhocMacUpdaterOptions) {
    super(null);
    this.installedApp = opts.target.app;
    this.parentDir = opts.target.parent;
    this.userData = opts.userData;
    this.helperSource = opts.helperSource;
    this.daemonPid = opts.daemonPid;
    this.run = opts.run ?? runTool;
    this.spawnHelper = opts.spawn ?? spawnDetached;
  }

  /** The release's `.zip` through electron-updater's download (cache, sha512 from latest-mac.yml). */
  protected override async doDownloadUpdate(options: DownloadUpdateOptions): Promise<DownloadExecutorResult> {
    const { info, provider } = options.updateInfoAndProvider;
    const zip = provider.resolveFiles(info).find((f) => f.url.pathname.endsWith(".zip"));
    if (!zip) throw new MacUpdateError("no_zip");
    return this.executeDownload({
      fileExtension: "zip",
      fileInfo: zip,
      downloadUpdateOptions: options,
      task: async (destination, downloadOptions) => {
        const http = this.httpExecutor;
        if (!http) throw new MacUpdateError("extract_failed");
        // The options carry the manifest's sha512: electron-updater rejects a file that does not match.
        await http.download(zip.url, destination, downloadOptions);
      },
    });
  }

  /**
   * Stages a downloaded zip and copies the helper beside the staged app. Once per version; a failure leaves nothing
   * prepared (and no staging folder), so `doInstall` installs nothing.
   */
  prepareDownloaded(update: { version: string; downloadedFile: string }): Promise<void> {
    if (this.prepared?.version === update.version) return Promise.resolve();
    if (this.preparing?.version === update.version) return this.preparing.promise;
    const promise: Promise<void> = this.prepare(update.version, update.downloadedFile).finally(() => {
      if (this.preparing?.promise === promise) this.preparing = null;
    });
    this.preparing = { version: update.version, promise };
    return promise;
  }

  private async prepare(version: string, downloadedFile: string): Promise<void> {
    const previous = this.prepared;
    this.prepared = null;
    if (previous) await removePath(previous.stagingDir).catch(() => undefined);
    const staged = await stageUpdate({
      zipPath: downloadedFile,
      version,
      target: { parent: this.parentDir },
      run: this.run,
    });
    const helper = join(staged.stagingDir, HELPER_FILE);
    try {
      // Read + write, not copyFile: the source lives inside the app's asar.
      const bytes = await readFile(this.helperSource);
      await writeFile(helper, bytes, { mode: 0o600, flag: "wx" });
      await chmod(helper, 0o600);
    } catch {
      await removePath(staged.stagingDir).catch(() => undefined);
      throw new MacUpdateError("helper_failed");
    }
    this.prepared = { version, stagingDir: staged.stagingDir, stagedApp: staged.stagedApp, helper };
  }

  /**
   * Synchronous, as BaseUpdater requires (the quit handler cannot wait): starts the helper, detached, with Electron as
   * Node and argv only, and returns; the helper swaps once this app and its daemon have exited.
   */
  protected override doInstall(options: {
    readonly isSilent: boolean;
    readonly isForceRunAfter: boolean;
  }): boolean {
    const p = this.prepared;
    if (!p) return false;
    // Review WR-01: the detached spawn reports a missing helper or executable only after this app has exited, so
    // nothing would install and nobody would know; checked here, so the install reports false instead.
    if (!existsSync(p.helper) || !existsSync(process.execPath) || !existsSync(p.stagedApp)) {
      throw new MacUpdateError("install_failed");
    }
    const recorded = this.daemonPid();
    const daemon = Number.isSafeInteger(recorded) && recorded >= 1 ? String(recorded) : "0";
    const args = [
      p.helper,
      String(process.pid),
      daemon,
      this.installedApp,
      p.stagedApp,
      join(this.userData, RESULT_FILE),
      p.version,
      options.isForceRunAfter ? "1" : "0",
    ];
    try {
      this.spawnHelper(process.execPath, args, {
        detached: true,
        stdio: "ignore",
        env: { ELECTRON_RUN_AS_NODE: "1" },
      }).unref();
    } catch {
      throw new MacUpdateError("install_failed");
    }
    return true;
  }
}

export type CreateAdhocMacUpdaterResult =
  | { ok: true; updater: AdhocMacUpdater }
  | { ok: false; reason: MacTargetRefusal };

/**
 * The macOS updater for the running app (`exePath` = `app.getPath("exe")`), or why it cannot update itself.
 * `installedAppOverride` (the e2e test mode's dummy `OCW.app`) replaces the computed bundle and is checked the same way.
 */
export function createAdhocMacUpdater(opts: {
  exePath: string;
  userData: string;
  helperSource: string;
  daemonPid: () => number;
  installedAppOverride?: string;
  isWritable?: (dir: string) => boolean;
  run?: RunTool;
  spawn?: SpawnDetached;
}): CreateAdhocMacUpdaterResult {
  const exe = opts.installedAppOverride
    ? join(opts.installedAppOverride, "Contents", "MacOS", "OCW")
    : opts.exePath;
  const target = macInstallTarget(exe, { isWritable: opts.isWritable });
  if (!target.ok) return target;
  return {
    ok: true,
    updater: new AdhocMacUpdater({
      target,
      userData: opts.userData,
      helperSource: opts.helperSource,
      daemonPid: opts.daemonPid,
      run: opts.run,
      spawn: opts.spawn,
    }),
  };
}

/** The last swap's result (`userData/update-result.json`), read once: the file is deleted, valid or not. */
export async function readSwapResult(userData: string): Promise<SwapResult | null> {
  const file = join(userData, RESULT_FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  await rm(file, { force: true }).catch(() => undefined);
  try {
    const parsed = SwapResult.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Review WR-01: records an install that did not start (on any platform), synchronously because it runs in the quit
 * event. The next start reads it with `readSwapResult` and says once that the app was not updated. Never throws; no
 * field can hold a path.
 */
export function recordInstallFailure(userData: string, version: string, now: () => number = Date.now): void {
  const parsed = SwapResult.safeParse({
    outcome: "failed",
    version,
    reason: "install_failed",
    at: new Date(now()).toISOString(),
  });
  if (!parsed.success) return;
  const file = join(userData, RESULT_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(parsed.data)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // nothing more to do
    }
  }
}

const LEFTOVER = [/^\.OCW\.app\.old-\d{1,16}$/, /^\.ocw-update-\d{1,9}\.\d{1,9}\.\d{1,9}$/];

/** Removes old bundles (`.OCW.app.old-<digits>`) and staging folders (`.ocw-update-<x.y.z>`) beside the app, nothing else. */
export async function sweepLeftovers(parentDir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(parentDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (LEFTOVER.some((re) => re.test(name))) await removePath(join(parentDir, name)).catch(() => undefined);
  }
}
