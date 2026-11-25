// The Work Zone browser on this device (07.13 D-05, D-06, PD-19, Pitfall 9): the pinned Chrome for Testing headless
// shell, downloaded or copied from a local zip, verified against the sha256 in `pins.ts` while it streams, extracted with
// the shared zip-slip-safe `extractZip` into a staging directory and renamed into `<browsersRoot>/<version>/` only once
// it is complete. There is no switch that skips the hash: `--from-zip` (CI, the proof pre-seed) is verified the same way.
// One install at a time per root (`.install.lock`, exclusive create, stale after 15 minutes untouched), so two sessions
// never download twice. Errors carry a `WorkBrowserLaunchFailure` code and a message without any path.
//
// The doctor helpers at the end (D-06, Pitfall 4) only read: `ldd` on the executable, `/etc/os-release` and the AppArmor
// sysctl. They print the `sudo` line for the owner to run; the runtime itself never runs sudo or installs a package (P5).

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { extractZip } from "@ocw/browser-engine/unzip";
import type { WorkBrowserLaunchFailure } from "@ocw/contracts";
import { z } from "zod";
import { ocwHome } from "../config.js";
import {
  CFT_PINS,
  CFT_PLATFORMS,
  CFT_VERSION,
  type CftPin,
  type CftPlatform,
  cftPlatformOf,
  cftZipUrl,
  headlessShellRelativePath,
} from "./pins.js";

/** Why the browser could not be installed or started, as the contracts name it; the message never holds a path. */
export class BrowserInstallError extends Error {
  constructor(
    readonly code: WorkBrowserLaunchFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BrowserInstallError";
  }
}

/**
 * Where browsers live: `OCW_BROWSERS_DIR` (a location only, absolute; it changes nothing about the verification), else
 * `<OCW_HOME>/browsers`.
 */
export function browsersRoot(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.OCW_BROWSERS_DIR?.trim();
  if (dir) {
    if (!isAbsolute(dir)) throw new Error("OCW_BROWSERS_DIR must be an absolute path");
    return resolve(dir);
  }
  return join(ocwHome(env), "browsers");
}

const MARKER_FILE = ".ocw-browser.json";
const LOCK_FILE = ".install.lock";
const STAGING_PREFIX = ".staging-";
/** A lock nobody touched for this long belongs to a crashed install. */
const LOCK_STALE_MS = 15 * 60_000;
/** How often a waiting install looks at the lock again. */
const LOCK_POLL_MS = 250;
/** How often a running install touches its lock, so a slow download is never taken for a crash. */
const LOCK_TOUCH_MS = 60_000;

const Marker = z.strictObject({
  version: z.string(),
  platform: z.enum(CFT_PLATFORMS),
  zipSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export interface InstalledBrowser {
  version: string;
  platform: CftPlatform;
  /** `<root>/<version>` (device-local only; show it with `displayPath`). */
  dir: string;
  /** The headless shell's executable inside `dir`. */
  executable: string;
}

interface PinOptions {
  /** This machine's CfT platform (default: from `process.platform` and `process.arch`). */
  platform?: CftPlatform | null;
  /** The pins to verify against (default `CFT_PINS`); a test seam, never configurable at run time. */
  pins?: Readonly<Record<CftPlatform, CftPin>>;
}

const hostPlatform = (): CftPlatform | null => cftPlatformOf(process.platform, process.arch);

/**
 * The pinned build installed under `root`, or null: the marker must name this version, this platform and the pinned
 * zip hash, and the executable must be present (and executable outside Windows).
 */
export async function installedBrowser(
  root: string,
  opts: PinOptions = {},
): Promise<InstalledBrowser | null> {
  const platform = opts.platform === undefined ? hostPlatform() : opts.platform;
  if (!platform) return null;
  const pin = (opts.pins ?? CFT_PINS)[platform];
  const dir = join(root, CFT_VERSION);
  let marker: z.infer<typeof Marker>;
  try {
    marker = Marker.parse(JSON.parse(await readFile(join(dir, MARKER_FILE), "utf8")));
  } catch {
    return null;
  }
  if (marker.version !== CFT_VERSION || marker.platform !== platform || marker.zipSha256 !== pin.sha256)
    return null;
  const executable = join(dir, headlessShellRelativePath(platform));
  try {
    await access(executable, platform === "win64" ? constants.F_OK : constants.X_OK);
  } catch {
    return null;
  }
  return { version: CFT_VERSION, platform, dir, executable };
}

export interface InstallProgress {
  receivedBytes: number;
  totalBytes: number;
}

export interface InstallBrowserOptions extends PinOptions {
  root: string;
  /** A local copy of the pinned zip (CI, offline pre-seed); verified exactly like a download. */
  fromZip?: string;
  /** Default: the global `fetch`. */
  fetchImpl?: typeof fetch;
  onProgress?: (p: InstallProgress) => void;
  /** Test seam: removes macOS's quarantine attribute from the extracted tree (A-9). */
  stripQuarantine?: (dir: string) => Promise<void>;
}

/** In-process installs per root, so concurrent callers in one daemon share one download. */
const running = new Map<string, Promise<InstalledBrowser>>();

/**
 * The pinned headless shell under `root`, installing it first when needed (see the file comment). Resolves with the
 * install; rejects with `BrowserInstallError` (`unsupported_platform`, `download_failed`, `checksum_mismatch`) and
 * leaves nothing behind but what was there before.
 */
export function installBrowser(opts: InstallBrowserOptions): Promise<InstalledBrowser> {
  const key = resolve(opts.root);
  const current = running.get(key);
  if (current) return current;
  const p = installLocked(opts).finally(() => running.delete(key));
  running.set(key, p);
  return p;
}

async function installLocked(opts: InstallBrowserOptions): Promise<InstalledBrowser> {
  const platform = opts.platform === undefined ? hostPlatform() : opts.platform;
  if (!platform) {
    throw new BrowserInstallError(
      "unsupported_platform",
      `There is no Chrome for Testing build for ${process.platform} ${process.arch}`,
    );
  }
  const pinOpts = { platform, ...(opts.pins ? { pins: opts.pins } : {}) };
  const root = opts.root;
  const done = await installedBrowser(root, pinOpts);
  if (done) return done;
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new BrowserInstallError("download_failed", "The browsers directory could not be created", {
      cause: err,
    });
  }
  const lock = join(root, LOCK_FILE);
  for (;;) {
    if (await tryLock(lock)) break;
    if (await lockIsStale(lock)) {
      await rm(lock, { force: true });
      continue;
    }
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    const other = await installedBrowser(root, pinOpts);
    if (other) return other;
  }
  try {
    // Another process may have finished between our first look and the lock.
    const other = await installedBrowser(root, pinOpts);
    if (other) return other;
    await sweepStaging(root);
    return await installUnderLock(opts, platform, lock);
  } finally {
    await rm(lock, { force: true }).catch(() => undefined);
  }
}

async function tryLock(lock: string): Promise<boolean> {
  try {
    const fh = await open(lock, "wx", 0o600);
    await fh.writeFile(`${process.pid}\n`);
    await fh.close();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new BrowserInstallError("download_failed", "The install lock could not be taken", { cause: err });
  }
}

async function lockIsStale(lock: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false; // gone already: the next round takes it
  }
}

/** Staging directories left by a crashed install (only the lock holder installs, so none is in use). */
async function sweepStaging(root: string): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((n) => n.startsWith(STAGING_PREFIX))
      .map((n) => rm(join(root, n), { recursive: true, force: true }).catch(() => undefined)),
  );
}

class TooLarge extends Error {}

/** Hashes and counts what passes through; fails past `cap` bytes. */
class Hashing extends Transform {
  readonly hash = createHash("sha256");
  bytes = 0;

  constructor(
    private readonly cap: number,
    private readonly onChunk: (bytes: number) => void,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.byteLength;
    if (this.bytes > this.cap) {
      cb(new TooLarge(`more than ${this.cap} bytes`));
      return;
    }
    this.hash.update(chunk);
    this.onChunk(this.bytes);
    cb(null, chunk);
  }
}

async function installUnderLock(
  opts: InstallBrowserOptions,
  platform: CftPlatform,
  lock: string,
): Promise<InstalledBrowser> {
  const pin = (opts.pins ?? CFT_PINS)[platform];
  const staging = join(opts.root, `${STAGING_PREFIX}${randomBytes(6).toString("hex")}`);
  const zipFile = join(staging, "chrome-headless-shell.zip");
  const tree = join(staging, "tree");
  let lastTouch = Date.now();
  const progress = (receivedBytes: number) => {
    opts.onProgress?.({ receivedBytes, totalBytes: pin.bytes });
    if (Date.now() - lastTouch > LOCK_TOUCH_MS) {
      lastTouch = Date.now();
      const now = new Date();
      utimes(lock, now, now).catch(() => undefined);
    }
  };
  try {
    await mkdir(staging, { mode: 0o700 });
    const hashing = new Hashing(pin.bytes, progress);
    const source = opts.fromZip ? await openLocalZip(opts.fromZip) : await download(opts, platform, pin);
    try {
      await pipeline(source, hashing, createWriteStream(zipFile, { flags: "wx", mode: 0o600 }));
    } catch (err) {
      if (err instanceof TooLarge) {
        throw new BrowserInstallError(
          "checksum_mismatch",
          "The browser archive is larger than the pinned build",
          {
            cause: err,
          },
        );
      }
      throw new BrowserInstallError(
        "download_failed",
        opts.fromZip ? "The browser archive could not be read" : "The browser download was interrupted",
        { cause: err },
      );
    }
    const actual = hashing.hash.digest("hex");
    if (hashing.bytes !== pin.bytes || actual !== pin.sha256) {
      throw new BrowserInstallError(
        "checksum_mismatch",
        `The browser archive does not match the pinned Chrome for Testing ${CFT_VERSION} build (${platform})`,
      );
    }
    try {
      await mkdir(tree, { mode: 0o700 });
      await extractZip(zipFile, tree);
    } catch (err) {
      throw new BrowserInstallError("download_failed", "The browser archive could not be extracted", {
        cause: err,
      });
    }
    await rm(zipFile, { force: true });
    const executable = join(tree, headlessShellRelativePath(platform));
    try {
      await stat(executable);
      if (platform !== "win64") await chmod(executable, 0o755);
    } catch (err) {
      throw new BrowserInstallError("download_failed", "The browser archive holds no headless shell", {
        cause: err,
      });
    }
    if (process.platform === "darwin" || opts.stripQuarantine) {
      await (opts.stripQuarantine ?? stripMacQuarantine)(tree).catch(() => undefined);
    }
    const marker: z.infer<typeof Marker> = { version: CFT_VERSION, platform, zipSha256: pin.sha256 };
    await writeFile(join(tree, MARKER_FILE), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
    const dir = join(opts.root, CFT_VERSION);
    // A directory without a valid marker is an older partial install (we hold the lock): replace it.
    await rm(dir, { recursive: true, force: true });
    await rename(tree, dir);
    return {
      version: CFT_VERSION,
      platform,
      dir,
      executable: join(dir, headlessShellRelativePath(platform)),
    };
  } catch (err) {
    if (err instanceof BrowserInstallError) throw err;
    throw new BrowserInstallError("download_failed", "The browser could not be installed", { cause: err });
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function openLocalZip(file: string): Promise<Readable> {
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error("not a file");
  } catch (err) {
    throw new BrowserInstallError("download_failed", "The browser archive could not be read", { cause: err });
  }
  return createReadStream(file);
}

async function download(opts: InstallBrowserOptions, platform: CftPlatform, pin: CftPin): Promise<Readable> {
  const url = cftZipUrl(platform);
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, { redirect: "follow" });
  } catch (err) {
    throw new BrowserInstallError("download_failed", "The browser download could not start", { cause: err });
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    throw new BrowserInstallError("download_failed", `The browser download failed (HTTP ${res.status})`);
  }
  const declared = Number(res.headers.get("content-length"));
  if (res.headers.has("content-length") && Number.isFinite(declared) && declared !== pin.bytes) {
    await res.body.cancel().catch(() => undefined);
    throw new BrowserInstallError(
      "checksum_mismatch",
      `The browser download is not the pinned Chrome for Testing ${CFT_VERSION} build (${platform})`,
    );
  }
  return Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>);
}

/** A9: CfT builds fetched by Node normally carry no quarantine flag; remove it when a copied zip brought one. */
function stripMacQuarantine(dir: string): Promise<void> {
  return new Promise((resolveDone) => {
    execFile("/usr/bin/xattr", ["-dr", "com.apple.quarantine", dir], { timeout: 30_000 }, () =>
      resolveDone(),
    );
  });
}

// ---------------------------------------------------------------- doctor helpers (D-06, Pitfall 4, SPIKES A-6)

/** `ldd <exe>`'s stdout (ldd itself never runs the executable's code beyond the loader's listing). */
function runLdd(exe: string): Promise<string> {
  return new Promise((resolveOut, reject) => {
    execFile("ldd", [exe], { timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      // ldd may exit non-zero and still list what it found.
      if (err && !stdout) reject(err);
      else resolveOut(String(stdout));
    });
  });
}

/**
 * The sonames `ldd` reports `=> not found` for the headless shell (Linux), sorted and unique; empty when ldd cannot
 * run (the launch then reports what it finds). `run` is a test seam returning ldd's output.
 */
export async function missingLinuxLibraries(
  exe: string,
  run: (exe: string) => Promise<string> = runLdd,
): Promise<string[]> {
  let out: string;
  try {
    out = await run(exe);
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\S+)\s+=>\s+not found/.exec(line);
    if (m?.[1]) found.add(m[1]);
  }
  return [...found].sort();
}

/** A soname's Debian package (the brw Dockerfile's names, SPIKES A-6's probe map). */
const SONAME_PACKAGES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^libasound\.so\./, "libasound2"],
  [/^libatk-bridge-2\.0\.so\./, "libatk-bridge2.0-0"],
  [/^libatk-1\.0\.so\./, "libatk1.0-0"],
  [/^libatspi\.so\./, "libatspi2.0-0"],
  [/^libcairo\.so\./, "libcairo2"],
  [/^libcups\.so\./, "libcups2"],
  [/^libdbus-1\.so\./, "libdbus-1-3"],
  [/^libdrm\.so\./, "libdrm2"],
  [/^libgbm\.so\./, "libgbm1"],
  [/^lib(glib|gobject|gio|gmodule)-2\.0\.so\./, "libglib2.0-0"],
  [/^lib(nspr4|plc4|plds4)\.so$/, "libnspr4"],
  [/^lib(nss3|nssutil3|smime3|ssl3)\.so$/, "libnss3"],
  [/^libpango-1\.0\.so\./, "libpango-1.0-0"],
  [/^libX11\.so\./, "libx11-6"],
  [/^libxcb\.so\./, "libxcb1"],
  [/^libXcomposite\.so\./, "libxcomposite1"],
  [/^libXdamage\.so\./, "libxdamage1"],
  [/^libXext\.so\./, "libxext6"],
  [/^libXfixes\.so\./, "libxfixes3"],
  [/^libxkbcommon\.so\./, "libxkbcommon0"],
  [/^libXrandr\.so\./, "libxrandr2"],
  [/^libexpat\.so\./, "libexpat1"],
  [/^libudev\.so\./, "libudev1"],
];

/** The packages the 64-bit time_t transition renamed (`<name>t64`), measured on Ubuntu 24.04 (SPIKES A-6). */
const T64_RENAMED: ReadonlySet<string> = new Set([
  "libasound2",
  "libatk-bridge2.0-0",
  "libatk1.0-0",
  "libatspi2.0-0",
  "libglib2.0-0",
]);

/** Ubuntu releases before the t64 transition (24.04 "noble"). */
const PRE_T64_UBUNTU = new Set([
  "trusty",
  "xenial",
  "bionic",
  "focal",
  "jammy",
  "kinetic",
  "lunar",
  "mantic",
]);

export interface OsRelease {
  /** `ID` (lowercase). */
  id: string;
  versionId?: string;
  /** `ID_LIKE`, split. */
  idLike?: string[];
  ubuntuCodename?: string;
}

/** `/etc/os-release` (KEY=value, values optionally quoted); null without an `ID`. */
export function parseOsRelease(text: string): OsRelease | null {
  const kv = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!m?.[1]) continue;
    kv.set(m[1], (m[2] ?? "").replace(/^(["'])(.*)\1$/, "$2"));
  }
  const id = kv.get("ID")?.toLowerCase();
  if (!id) return null;
  const versionId = kv.get("VERSION_ID");
  const ubuntuCodename = kv.get("UBUNTU_CODENAME");
  return {
    id,
    ...(versionId ? { versionId } : {}),
    idLike: (kv.get("ID_LIKE") ?? "").toLowerCase().split(/\s+/).filter(Boolean),
    ...(ubuntuCodename ? { ubuntuCodename } : {}),
  };
}

/** This machine's `/etc/os-release`, or null (not Linux, unreadable). */
export async function readOsRelease(
  read: (path: string) => Promise<string | null> = readTextOrNull,
): Promise<OsRelease | null> {
  const text = (await read("/etc/os-release")) ?? (await read("/usr/lib/os-release"));
  return text === null ? null : parseOsRelease(text);
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

const versionAtLeast = (version: string | undefined, min: number[]): boolean => {
  if (!version) return false;
  const parts = version.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < min.length; i++) {
    const a = parts[i] ?? 0;
    const b = min[i] ?? 0;
    if (!Number.isFinite(a)) return false;
    if (a !== b) return a > b;
  }
  return true;
};

/**
 * Whether apt names the t64 packages here: Ubuntu 24.04 and later (measured), an Ubuntu derivative whose
 * `UBUNTU_CODENAME` is noble or later, and Debian 13 and later or testing/sid (no `VERSION_ID`), which carry the same
 * transition. Null when this is no Debian or Ubuntu system.
 */
function usesT64(os: OsRelease): boolean | null {
  const like = os.idLike ?? [];
  if (os.id === "ubuntu") return versionAtLeast(os.versionId, [24, 4]);
  if (os.ubuntuCodename || like.includes("ubuntu")) {
    return os.ubuntuCodename ? !PRE_T64_UBUNTU.has(os.ubuntuCodename) : null;
  }
  if (os.id === "debian") return os.versionId ? versionAtLeast(os.versionId, [13]) : true;
  // Other Debian derivatives: their release does not say which names apt has; the doctor names the libraries instead.
  return null;
}

/**
 * The one apt line installing what provides `sonames` on this Debian or Ubuntu system (SPIKES A-6: sonames → Debian
 * names, `t64` where the release renamed them), packages sorted and unique; null when this is no Debian/Ubuntu system
 * or no soname is known. Printed by the doctor for the owner; never run by the runtime.
 */
export function aptInstallLine(sonames: readonly string[], os: OsRelease | null): string | null {
  if (!os) return null;
  const t64 = usesT64(os);
  if (t64 === null) return null;
  const packages = new Set<string>();
  for (const so of sonames) {
    const pkg = SONAME_PACKAGES.find(([re]) => re.test(so))?.[1];
    if (pkg) packages.add(t64 && T64_RENAMED.has(pkg) ? `${pkg}t64` : pkg);
  }
  if (packages.size === 0) return null;
  return `sudo apt-get install -y ${[...packages].sort().join(" ")}`;
}

/** The AppArmor profile file the doctor's fix line writes (a fixed system path, safe to print). */
export const APPARMOR_PROFILE_PATH = "/etc/apparmor.d/ocw-chrome-headless-shell";
const APPARMOR_RESTRICT_SYSCTL = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

/** The executable as an AppArmor path: `@{HOME}/…` under the home (never the home itself), else as it is. */
function appArmorPath(exe: string, home: string): string {
  const h = home.replace(/\/+$/, "");
  return h && h !== "/" && exe.startsWith(`${h}/`) ? `@{HOME}/${exe.slice(h.length + 1)}` : exe;
}

/**
 * Pitfall 4: when Ubuntu restricts unprivileged user namespaces (`kernel.apparmor_restrict_unprivileged_userns = 1`),
 * Chromium's sandbox cannot start unless an AppArmor profile grants `userns` to this executable (the way the desktop
 * `.deb` does for Electron). Returns the one line that writes and loads that profile, or null when there is no
 * restriction or the profile file already names this executable. Never retried with `--no-sandbox`.
 */
export async function appArmorFixLine(
  exe: string,
  read: (path: string) => Promise<string | null> = readTextOrNull,
  home: string = homedir(),
): Promise<string | null> {
  const restricted = (await read(APPARMOR_RESTRICT_SYSCTL))?.trim();
  if (restricted !== "1") return null;
  const attach = `"${appArmorPath(exe, home)}"`;
  const existing = await read(APPARMOR_PROFILE_PATH);
  if (existing?.includes(attach)) return null;
  const profile = [
    "abi <abi/4.0>,",
    "include <tunables/global>",
    `profile ocw-chrome-headless-shell ${attach} flags=(unconfined) {`,
    "  userns,",
    "}",
    "",
  ].join("\\n");
  return (
    `printf '${profile}' | sudo tee ${APPARMOR_PROFILE_PATH} >/dev/null && ` +
    `sudo apparmor_parser -r ${APPARMOR_PROFILE_PATH}`
  );
}
