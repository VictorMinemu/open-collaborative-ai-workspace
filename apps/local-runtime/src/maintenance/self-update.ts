// Phase 07.17.1 (runtime self-update, ADR-0040, D-03, D-07, D-08; hub PD-06, PD-07, PD-08, PD-25): the device builds
// the runtime its workspace serves beside the running one, exactly as `install.sh` lays it out
// (`<OCW_HOME>/runtime/versions/<sha12>/` with the bundle, its `package.json`, its npm lockfile and the SDK installed by
// `npm ci`), and later switches `current` to it in one atomic step. Deciding when (08) and restarting (10) are not here.
//
// What this module never does: run a script or anything else from the download except the verified bundle itself
// (`npm ci --ignore-scripts`, a fixed argv, no shell); follow a redirect; take a URL, host, path or version from a
// command (the URLs are only `config.serverUrl` + the fixed `RUNTIME_ROUTES`); write outside `<OCW_HOME>/runtime`;
// call `sudo` or a service manager; put an absolute host path in a thrown message (they are fixed sentences).

import { createHash } from "node:crypto";
import { constants, createWriteStream, realpathSync } from "node:fs";
import {
  access,
  rename as fsRename,
  symlink as fsSymlink,
  mkdir,
  readFile,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  CLAUDE_AGENT_SDK_PACKAGE,
  IsoDateTime,
  parseServedRuntimeManifest,
  RUNTIME_BUNDLE_FILE,
  RUNTIME_EXTERNAL_LOCK_FILE,
  RUNTIME_ROUTES,
  RUNTIME_SELF_BLOCK_SENTENCES,
  type RuntimeDistManifest,
  RuntimeUpdateTrigger,
  RuntimeVersion,
  runtimeBuildOf,
  runtimeExternalFiles,
  scrubHostPaths,
} from "@ocw/contracts";
import { z } from "zod";
import { installInfoPath, RuntimeInstallInfo, readInstallInfo, runtimeDir } from "../install-info.js";
import { errorMessage } from "../logger.js";
import { runFixedCommand, UPDATE_TIMEOUT_MS, updateChildEnv } from "./runner.js";

/** The exit code that asks the service manager for a restart on the new version (`EX_TEMPFAIL`, D-05). */
export const SELF_UPDATE_EXIT_CODE = 75;
/** Free space required on `<OCW_HOME>/runtime` before a download starts (A-05). */
export const SELF_UPDATE_MIN_FREE_BYTES = 512 * 1024 * 1024;
export const SELF_UPDATE_MANIFEST_TIMEOUT_MS = 30_000;
export const SELF_UPDATE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** The preflight `node <bundle> version` gets this long. */
const PREFLIGHT_TIMEOUT_MS = 60_000;
/** Upper bounds on what is read into memory: the manifest and the lockfile. */
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_LOCK_BYTES = 16 * 1024 * 1024;

/** `npm ci` exactly as `install.sh` runs it (install.sh parity, D-03). */
export function NPM_CI_ARGS(prefix: string): readonly string[] {
  return ["ci", "--prefix", prefix, "--no-audit", "--no-fund", "--omit=optional", "--ignore-scripts"];
}

export type SelfUpdateFailure =
  | "insecure_url"
  | "unreachable"
  | "bad_manifest"
  | "node_too_old"
  | "disk_full"
  | "checksum"
  | "bad_lockfile"
  | "npm_missing"
  | "npm_failed"
  | "preflight_failed"
  | "wrong_version"
  | "outside_scratch_home"
  | "switch_failed"
  | "cancelled";

/** The one sentence each failure is reported with (run error, toast, log). None carries a host path. */
export const SELF_UPDATE_FAILURE_SENTENCES: Readonly<Record<SelfUpdateFailure, string>> = {
  insecure_url:
    "refusing plain http to a non-loopback server; use https, or set OCW_INSTALL_ALLOW_HTTP=1 in ~/.ocw/service.env on a network you trust",
  unreachable: "the workspace did not answer",
  bad_manifest: "the workspace sent an invalid runtime manifest",
  node_too_old: RUNTIME_SELF_BLOCK_SENTENCES.node_too_old,
  disk_full: "not enough disk space",
  checksum: "checksum mismatch",
  bad_lockfile: "the lockfile does not match the manifest",
  npm_missing: "npm was not found next to node; re-run the install command",
  npm_failed: "npm could not install the runtime's dependencies",
  preflight_failed: "the new runtime does not start",
  wrong_version: "the new runtime reports another version",
  outside_scratch_home: "refused outside a scratch home",
  switch_failed: "could not switch to the new version",
  cancelled: "cancelled: the runtime stopped",
};

/**
 * A self-update step that failed. `message` is the failure's fixed sentence; `detail` is a path-scrubbed note for the
 * caller's local log only (never sent off the device); `cause` keeps the underlying error.
 */
export class SelfUpdateError extends Error {
  readonly failure: SelfUpdateFailure;
  readonly detail: string | null;

  constructor(failure: SelfUpdateFailure, cause?: unknown, detail?: string) {
    super(SELF_UPDATE_FAILURE_SENTENCES[failure], cause === undefined ? undefined : { cause });
    this.name = "SelfUpdateError";
    this.failure = failure;
    this.detail =
      detail !== undefined
        ? scrubHostPaths(detail)
        : cause === undefined
          ? null
          : scrubHostPaths(errorMessage(cause));
  }
}

// ---- where the bytes come from (PD-06) ----

/**
 * `install.sh`'s `is_loopback`: `localhost`, or only digits and dots starting `127.` with no `..` and no trailing dot
 * (so `127.0.0.1.nip.io`, a DNS name that only starts like one, is not loopback).
 */
export function isLoopbackHost(host: string): boolean {
  if (host === "localhost") return true;
  if (!host.startsWith("127.")) return false;
  return /^[0-9.]+$/.test(host) && !host.includes("..") && !host.endsWith(".");
}

/**
 * `serverUrl` + one fixed route as a URL. https always; plain http only to a loopback host or with
 * `OCW_INSTALL_ALLOW_HTTP=1` in the daemon's environment (installer parity, D-08). Throws `insecure_url` otherwise,
 * also for a URL that does not parse.
 */
export function serverRuntimeUrl(serverUrl: string, route: string, env: NodeJS.ProcessEnv): URL {
  const base = serverUrl.replace(/\/+$/, "");
  const scheme = /^(https?):\/\//i.exec(base)?.[1]?.toLowerCase();
  if (!scheme) throw new SelfUpdateError("insecure_url");
  // The host as written (install.sh's `host_of`), before WHATWG parsing normalises it.
  const rawHost = (base.slice(scheme.length + 3).split("/")[0] ?? "").replace(/:\d*$/, "");
  if (scheme === "http" && !isLoopbackHost(rawHost) && env.OCW_INSTALL_ALLOW_HTTP !== "1") {
    throw new SelfUpdateError("insecure_url");
  }
  try {
    return new URL(`${base}${route}`);
  } catch (err) {
    throw new SelfUpdateError("insecure_url", err);
  }
}

function combinedSignal(timeoutMs: number, ...signals: (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), ...signals.filter((s): s is AbortSignal => !!s)]);
}

/** One GET, never following a redirect; anything but a 200 is `unreachable`. */
async function get(url: URL, f: typeof fetch, signal: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await f(url, { redirect: "error", signal });
  } catch (err) {
    throw new SelfUpdateError("unreachable", err);
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    throw new SelfUpdateError("unreachable", undefined, `HTTP ${res.status} from ${url.pathname}`);
  }
  return res;
}

class TooLarge extends Error {}

/** A transform that hashes and counts what passes through and fails past `cap` bytes. */
class Capped extends Transform {
  readonly hash = createHash("sha256");
  bytes = 0;

  constructor(private readonly cap: number) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    this.bytes += chunk.byteLength;
    if (this.bytes > this.cap) {
      done(new TooLarge(`more than ${this.cap} bytes`));
      return;
    }
    this.hash.update(chunk);
    done(null, chunk);
  }
}

/** The whole body, failing with `TooLarge` past `cap` bytes (the connection is dropped then). */
async function readCapped(res: Response, cap: number, abort: AbortController): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    abort.abort();
    throw new TooLarge(`declared ${declared} bytes`);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of Readable.fromWeb(res.body as import("node:stream/web").ReadableStream)) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > cap) {
      abort.abort();
      throw new TooLarge(`more than ${cap} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * The manifest the paired workspace serves now (`RUNTIME_ROUTES.version`), parsed with `parseServedRuntimeManifest`
 * (PD-06; unknown keys dropped, every known field strict: review WR-04).
 */
export async function fetchServedManifest(p: {
  serverUrl: string;
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<RuntimeDistManifest> {
  const url = serverRuntimeUrl(p.serverUrl, RUNTIME_ROUTES.version, p.env);
  const abort = new AbortController();
  const signal = combinedSignal(p.timeoutMs ?? SELF_UPDATE_MANIFEST_TIMEOUT_MS, abort.signal, p.signal);
  const res = await get(url, p.fetch ?? fetch, signal);
  let body: Buffer;
  try {
    body = await readCapped(res, MAX_MANIFEST_BYTES, abort);
  } catch (err) {
    if (err instanceof TooLarge) throw new SelfUpdateError("bad_manifest", err);
    throw new SelfUpdateError("unreachable", err);
  }
  let json: unknown;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch (err) {
    throw new SelfUpdateError("bad_manifest", err);
  }
  // Review WR-04: keys a later release adds are dropped, every field used here is still checked strictly.
  const parsed = parseServedRuntimeManifest(json);
  if (!parsed.success) throw new SelfUpdateError("bad_manifest", undefined, parsed.error.message);
  return parsed.data;
}

// ---- prepare (PD-07) ----

export interface PreparedVersion {
  manifest: RuntimeDistManifest;
  /** `versions/<sha12>`: the first 12 hex of the bundle's sha256 (`RuntimeBuild`). */
  sha12: string;
  /** True when a complete `versions/<sha12>` was already there (no download, no npm). */
  reused: boolean;
}

export interface PrepareVersionOptions {
  ocwHome: string;
  /** The daemon's `config.serverUrl` (never `install.json`'s, never a command's). */
  serverUrl: string;
  /** The daemon's environment: `OCW_INSTALL_ALLOW_HTTP`, and the base of the children's filtered environment. */
  env: NodeJS.ProcessEnv;
  /** The served manifest (`fetchServedManifest`). */
  manifest: RuntimeDistManifest;
  /** Names the staging directory (`versions/.staging-<runId>`). */
  runId: string;
  /** The node that runs this daemon (`process.execPath`): runs npm and the preflight. */
  execPath: string;
  /** `process.versions.node`. */
  nodeVersion: string;
  /** Tests: refuse an `ocwHome` inside the OS user's home and an npm outside the temp directory (PD-19). */
  requireScratchHome: boolean;
  fetch?: typeof fetch;
  run?: typeof runFixedCommand;
  /** An explicit npm (tests: `fakeNpm`); else `<dirname(execPath)>/npm`, else `npm` on `env.PATH` (A-07). */
  npmPath?: string | null;
  freeBytes?: (dir: string) => Promise<number>;
  onPhase?: (phase: "downloading" | "installing") => void;
  signal?: AbortSignal;
}

function insideDir(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** PD-19: in tests, an `ocwHome` inside the OS user's real home is refused before anything is read or written. */
function assertScratchHome(ocwHome: string): void {
  const home = userInfo().homedir;
  const homes = [home, tryRealpath(home)].filter((h): h is string => !!h);
  const targets = [resolve(ocwHome), tryRealpath(ocwHome)].filter((t): t is string => !!t);
  if (targets.some((t) => homes.some((h) => insideDir(t, h)))) {
    throw new SelfUpdateError("outside_scratch_home");
  }
}

async function defaultFreeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

async function isExecutableFile(p: string): Promise<boolean> {
  try {
    if (!(await stat(p)).isFile()) return false;
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * npm's real path (A-07): the explicit `npmPath`, else the npm beside the node that runs the daemon, else the first
 * `npm` on `env.PATH`. Only the daemon's own PATH is searched (never the user's home or a package manager's prefix),
 * so what runs is what the service was configured with.
 */
async function resolveNpm(p: PrepareVersionOptions): Promise<string | null> {
  const candidates = p.npmPath
    ? [p.npmPath]
    : [
        join(dirname(p.execPath), "npm"),
        ...(p.env.PATH ?? "")
          .split(delimiter)
          .filter((d) => isAbsolute(d))
          .map((d) => join(d, "npm")),
      ];
  for (const candidate of candidates) {
    if (!(await isExecutableFile(candidate))) continue;
    const real = tryRealpath(candidate);
    if (real) return real;
  }
  return null;
}

async function fileSha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

/** `install.sh`'s reuse test: bundle, SDK and lockfile present and the bundle hashes to the manifest. */
async function isComplete(dir: string, manifest: RuntimeDistManifest): Promise<boolean> {
  try {
    await stat(join(dir, "node_modules", CLAUDE_AGENT_SDK_PACKAGE, "package.json"));
    await stat(join(dir, RUNTIME_EXTERNAL_LOCK_FILE));
    return (await fileSha256(join(dir, RUNTIME_BUNDLE_FILE))) === manifest.sha256;
  } catch {
    return false;
  }
}

/** Streams the bundle into `file` (0600) through a hashing, byte-counting transform capped at `manifest.bytes`. */
async function downloadBundle(p: PrepareVersionOptions, f: typeof fetch, file: string): Promise<void> {
  const url = serverRuntimeUrl(p.serverUrl, RUNTIME_ROUTES.bundle, p.env);
  const abort = new AbortController();
  const res = await get(url, f, combinedSignal(SELF_UPDATE_DOWNLOAD_TIMEOUT_MS, abort.signal, p.signal));
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && res.headers.has("content-length") && declared !== p.manifest.bytes) {
    abort.abort();
    throw new SelfUpdateError(
      "checksum",
      undefined,
      `declared ${declared} bytes, expected ${p.manifest.bytes}`,
    );
  }
  if (!res.body) throw new SelfUpdateError("checksum", undefined, "empty bundle response");
  const capped = new Capped(p.manifest.bytes);
  try {
    await pipeline(
      Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
      capped,
      createWriteStream(file, { flags: "wx", mode: 0o600 }),
    );
  } catch (err) {
    abort.abort();
    if (err instanceof TooLarge) throw new SelfUpdateError("checksum", err);
    throw new SelfUpdateError("unreachable", err);
  }
  const actual = capped.hash.digest("hex");
  if (capped.bytes !== p.manifest.bytes || actual !== p.manifest.sha256) {
    throw new SelfUpdateError("checksum", undefined, `got ${capped.bytes} bytes hashing to ${actual}`);
  }
}

/** The served lockfile, hash-checked against the manifest, then structure-checked (`runtimeExternalFiles`). */
async function downloadLock(
  p: PrepareVersionOptions,
  f: typeof fetch,
): Promise<{ lock: string; packageJson: string }> {
  const url = serverRuntimeUrl(p.serverUrl, RUNTIME_ROUTES.externalLock, p.env);
  const abort = new AbortController();
  const res = await get(url, f, combinedSignal(SELF_UPDATE_MANIFEST_TIMEOUT_MS, abort.signal, p.signal));
  let body: Buffer;
  try {
    body = await readCapped(res, MAX_LOCK_BYTES, abort);
  } catch (err) {
    if (err instanceof TooLarge) throw new SelfUpdateError("bad_lockfile", err);
    throw new SelfUpdateError("unreachable", err);
  }
  if (createHash("sha256").update(body).digest("hex") !== p.manifest.externalLockSha256) {
    throw new SelfUpdateError("bad_lockfile", undefined, "the lockfile's sha256 is not the manifest's");
  }
  try {
    return runtimeExternalFiles(p.manifest, body.toString("utf8"));
  } catch (err) {
    throw new SelfUpdateError("bad_lockfile", err);
  }
}

/** The last non-empty line of a command's output. */
function lastLine(output: string): string {
  const lines = output.split("\n").map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]) return lines[i] as string;
  return "";
}

/**
 * Builds `versions/<sha12>` for the served manifest beside the running version (PD-07), in this order: the scratch-home
 * guard (tests) → Node major ≥ `manifest.minNode` → free space on `<OCW_HOME>/runtime` → reuse a complete
 * `versions/<sha12>` → else, in `versions/.staging-<runId>`: the bundle (capped, hashed), the lockfile (hash, then
 * structure), `package.json` and the lockfile as `install.sh` writes them, `npm ci` (fixed argv, filtered env, PATH
 * starting at node's directory) → the preflight `<node> <bundle> version` must print `manifest.version` → rename to
 * `versions/<sha12>`.
 *
 * Any failure throws `SelfUpdateError` and removes the staging directory; `current` and `install.json` are never
 * touched here (the switch is `switchToVersion`).
 */
export async function prepareVersion(p: PrepareVersionOptions): Promise<PreparedVersion> {
  try {
    return await prepare(p);
  } catch (err) {
    if (err instanceof SelfUpdateError) throw err;
    // A filesystem error while laying the version out: its message names paths, so only the sentence leaves.
    const code = (err as NodeJS.ErrnoException).code;
    throw new SelfUpdateError(code === "ENOSPC" || code === "EDQUOT" ? "disk_full" : "switch_failed", err);
  }
}

async function prepare(p: PrepareVersionOptions): Promise<PreparedVersion> {
  if (p.requireScratchHome) assertScratchHome(p.ocwHome);
  const { manifest } = p;
  const nodeMajor = Number.parseInt(p.nodeVersion.replace(/^v/, ""), 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < manifest.minNode) {
    throw new SelfUpdateError("node_too_old", undefined, `node ${p.nodeVersion} < ${manifest.minNode}`);
  }

  const runtime = runtimeDir(p.ocwHome);
  const versions = join(runtime, "versions");
  await mkdir(versions, { recursive: true, mode: 0o700 });
  let free = Number.POSITIVE_INFINITY;
  try {
    free = await (p.freeBytes ?? defaultFreeBytes)(runtime);
  } catch {
    // Unknown free space does not block (statfs is not available everywhere).
  }
  if (free < SELF_UPDATE_MIN_FREE_BYTES) {
    throw new SelfUpdateError("disk_full", undefined, `${free} bytes free`);
  }

  const sha12 = runtimeBuildOf(manifest.sha256);
  const versionDir = join(versions, sha12);
  const run = p.run ?? runFixedCommand;
  const home = homedir();
  const childEnv = updateChildEnv(p.env, {
    PATH: [dirname(p.execPath), p.env.PATH].filter(Boolean).join(delimiter),
  });
  const preflight = async (dir: string) => {
    const res = await run({
      file: p.execPath,
      args: [join(dir, RUNTIME_BUNDLE_FILE), "version"],
      env: childEnv,
      cwd: dir,
      timeoutMs: PREFLIGHT_TIMEOUT_MS,
      roots: [p.ocwHome],
      home,
      ...(p.signal ? { signal: p.signal } : {}),
    });
    if (res.aborted) throw new SelfUpdateError("cancelled");
    if (res.exitCode !== 0 || res.timedOut) {
      throw new SelfUpdateError("preflight_failed", undefined, res.output);
    }
    const got = lastLine(res.output);
    if (got !== manifest.version) {
      throw new SelfUpdateError("wrong_version", undefined, `reports ${got.slice(0, 80)}`);
    }
  };

  if (await isComplete(versionDir, manifest)) {
    await preflight(versionDir);
    return { manifest, sha12, reused: true };
  }

  const staging = join(versions, `.staging-${p.runId}`);
  try {
    const npm = await resolveNpm(p);
    if (!npm) throw new SelfUpdateError("npm_missing");
    // PD-19: a test never runs an npm outside the OS temp directory (the real npm and its registry stay out of reach).
    if (p.requireScratchHome && !insideDir(npm, tryRealpath(tmpdir()) ?? tmpdir())) {
      throw new SelfUpdateError("outside_scratch_home");
    }

    const f = p.fetch ?? fetch;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { mode: 0o700 });
    p.onPhase?.("downloading");
    await downloadBundle(p, f, join(staging, RUNTIME_BUNDLE_FILE));
    const files = await downloadLock(p, f);
    await writeFile(join(staging, "package.json"), files.packageJson, { mode: 0o600 });
    await writeFile(join(staging, RUNTIME_EXTERNAL_LOCK_FILE), files.lock, { mode: 0o600 });

    p.onPhase?.("installing");
    const ci = await run({
      file: p.execPath,
      args: [npm, ...NPM_CI_ARGS(staging)],
      env: childEnv,
      cwd: staging,
      timeoutMs: UPDATE_TIMEOUT_MS,
      roots: [p.ocwHome],
      home,
      ...(p.signal ? { signal: p.signal } : {}),
    });
    if (ci.aborted) throw new SelfUpdateError("cancelled");
    if (ci.exitCode !== 0 || ci.timedOut) throw new SelfUpdateError("npm_failed", undefined, ci.output);
    await preflight(staging);
    // Review WR-05: a stop that came after the preflight leaves nothing half-adopted behind.
    if (p.signal?.aborted) throw new SelfUpdateError("cancelled");

    // An incomplete directory of the same build (an interrupted install) is replaced.
    await rm(versionDir, { recursive: true, force: true });
    await fsRename(staging, versionDir);
    return { manifest, sha12, reused: false };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---- the marker (PD-08, PD-12) ----

const BuildRef = z
  .object({
    version: RuntimeVersion,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/**
 * The run in flight across the restart (`<OCW_HOME>/runtime/self-update.json`, 0600): written just before `current`
 * moves, read at boot by `reconcileSelfUpdate` (07), which reports the run and deletes it. Versions, hashes, ids and a
 * time only: never a path.
 */
export const SelfUpdateMarker = z
  .object({
    runId: z.uuid(),
    commandId: z.uuid().nullable(),
    trigger: RuntimeUpdateTrigger,
    from: BuildRef,
    to: BuildRef,
    startedAt: IsoDateTime,
  })
  .strict();
export type SelfUpdateMarker = z.infer<typeof SelfUpdateMarker>;

/** `<ocwHome>/runtime/self-update.json`. */
export function selfUpdateMarkerPath(ocwHome: string): string {
  return join(runtimeDir(ocwHome), "self-update.json");
}

/** The marker, or null when there is none or it does not parse strictly. */
export async function readSelfUpdateMarker(ocwHome: string): Promise<SelfUpdateMarker | null> {
  let text: string;
  try {
    text = await readFile(selfUpdateMarkerPath(ocwHome), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = SelfUpdateMarker.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The filesystem calls of the switch (a test seam for injected failures and the step order). */
export interface SwitchFs {
  rename: (from: string, to: string) => Promise<void>;
  symlink: (target: string, path: string) => Promise<void>;
}

const realFs: SwitchFs = { rename: fsRename, symlink: fsSymlink };

/** Writes `value` as JSON to `file` in one step: a 0600 temp file renamed over it. */
async function writeJsonAtomic(file: string, value: unknown, fs: SwitchFs): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  await rm(tmp, { force: true });
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function writeMarker(ocwHome: string, m: SelfUpdateMarker, fs: SwitchFs): Promise<void> {
  const parsed = SelfUpdateMarker.parse(m);
  await mkdir(runtimeDir(ocwHome), { recursive: true, mode: 0o700 });
  await writeJsonAtomic(selfUpdateMarkerPath(ocwHome), parsed, fs);
}

/** Writes the marker (validated strictly; 0600; temp file + rename). */
export async function writeSelfUpdateMarker(ocwHome: string, m: SelfUpdateMarker): Promise<void> {
  await writeMarker(ocwHome, m, realFs);
}

/** Removes the marker; a missing one is fine. */
export async function removeSelfUpdateMarker(ocwHome: string): Promise<void> {
  await rm(selfUpdateMarkerPath(ocwHome), { force: true });
}

// ---- the switch (PD-08) ----

/**
 * Makes the prepared version the one that runs at the next start (PD-08), in this order: the marker → a relative
 * `versions/<sha12>` symlink at `current.tmp-<pid>` (a leftover one is replaced) renamed over `current` (atomic: there
 * is never a moment without a `current`) → `install.json` (temp file + rename, 0600) with `serverUrl` (the daemon's
 * `config.serverUrl`), the new version and sha256, and the old record's `nodePath` (else `process.execPath`). The
 * previous `versions/<sha12>` stays (rollback = point `current` back). No exit here (the caller restarts, 10).
 *
 * Throws `switch_failed` when anything before or at the link fails, and then leaves `current` where it was and no
 * marker behind. An `install.json` that cannot be written after the link moved is not a failure: `current` is the
 * authority, and the next boot rewrites a stale record from the running build (07, PD-12).
 */
export async function switchToVersion(p: {
  ocwHome: string;
  prepared: PreparedVersion;
  marker: SelfUpdateMarker;
  serverUrl: string;
  now?: () => Date;
  fs?: Partial<SwitchFs>;
}): Promise<void> {
  const fs: SwitchFs = { ...realFs, ...p.fs };
  const runtime = runtimeDir(p.ocwHome);
  const { manifest, sha12 } = p.prepared;
  const target = `versions/${sha12}`;

  // Everything that can be checked is checked before anything changes.
  const old = await readInstallInfo(p.ocwHome);
  const record = RuntimeInstallInfo.safeParse({
    serverUrl: p.serverUrl,
    version: manifest.version,
    sha256: manifest.sha256,
    installedAt: (p.now ?? (() => new Date()))().toISOString(),
    nodePath: old?.nodePath ?? process.execPath,
  });
  if (!record.success)
    throw new SelfUpdateError("switch_failed", undefined, "the install record would not parse");
  try {
    if (!(await stat(join(runtime, target, RUNTIME_BUNDLE_FILE))).isFile()) throw new Error("not a file");
  } catch (err) {
    throw new SelfUpdateError("switch_failed", err);
  }

  try {
    await writeMarker(p.ocwHome, p.marker, fs);
  } catch (err) {
    throw new SelfUpdateError("switch_failed", err);
  }

  const tmp = join(runtime, `current.tmp-${process.pid}`);
  try {
    await rm(tmp, { force: true });
    await fs.symlink(target, tmp);
    await fs.rename(tmp, join(runtime, "current"));
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    await removeSelfUpdateMarker(p.ocwHome).catch(() => undefined);
    throw new SelfUpdateError("switch_failed", err);
  }

  try {
    await writeJsonAtomic(installInfoPath(p.ocwHome), record.data, fs);
  } catch {
    // Not fatal: `current` already names the new version; the next boot rewrites the record (PD-12).
  }
}
