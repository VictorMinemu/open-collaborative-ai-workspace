// The macOS installer of the desktop app's self-update (07.13.1, D-01, D-04, D-05). Squirrel.Mac (electron-updater's
// MacUpdater) validates an update against the running app's designated requirement, which for an ad-hoc signed build is
// the cdhash of that one build, so every update would fail; it also listens on a loopback TCP port. macOS therefore
// gets its own installer: the downloaded release zip is extracted with `ditto` into `.ocw-update-<version>/` beside
// the installed `OCW.app` (same volume, so the swap is a rename), and the staged bundle is kept only when
// `codesign --verify --deep --strict` passes, its bundle id is `dev.ocw.desktop`, its version is the expected stable
// version, its bundled daemon is there and its framework symlinks survived. Anything else removes the staging folder
// and leaves the installed app untouched. Every tool runs from its absolute path with an argv array, never through a
// shell; errors carry a fixed code and a fixed sentence, never a path or a tool's output. No Electron imports
// (unit-tested).

import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { lstat, mkdir, readdir, rm, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";

export const BUNDLE_ID = "dev.ocw.desktop";
/** Only a stable `x.y.z` (D-02); it also names the staging folder, so nothing else may reach a path. */
export const STABLE_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const APP_NAME = "OCW.app";

export const stagingDirName = (version: string) => `.ocw-update-${version}`;

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
