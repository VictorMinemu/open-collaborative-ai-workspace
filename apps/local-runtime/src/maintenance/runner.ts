// Phase 07.11 (runtime CLI auto-updates, D-03, D-05, D-08, PD-11): run the one command the fixed table gives for an
// install, under a per-install lock, without a shell, with a filtered environment and a time limit, then re-detect
// the version and say how it ended. Never escalates: a `needs_admin` install has no command (D-08).
//
// No host path leaves the device (AGENTS principle 7): kept output passes ANSI strip → contain/redact →
// `scrubHostPaths` → 10 KB cap, and progress lines are sanitised the same way and cut to 200 characters.

import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareRuntimeVersions, parseRuntimeVersion, scrubHostPaths } from "@ocw/contracts";
import { defaultExec, type ExecFn } from "../claude/detect.js";
import { sanitizeString } from "../sanitize.js";
import { type InstallResolution, resolveInstall, updateCommandFor } from "./install-method.js";

export const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;
export const KILL_GRACE_MS = 5_000;
/** After the installer exits, its output gets this long to drain; then its pipes are closed (07.11 review HI-03). */
export const STDIO_GRACE_MS = 2_000;
/** Past timeout + kill grace + output grace, a run settles as timed out whatever the process does. */
const HARD_DEADLINE_SLACK_MS = 1_000;
export const LOCK_RETRY_MS = 5_000;
export const LOCK_GIVE_UP_MS = 10 * 60 * 1000;
export const MAX_KEPT_OUTPUT_BYTES = 10 * 1024;
const MAX_PROGRESS_CHARS = 200;
const PROGRESS_INTERVAL_MS = 1_000;
/** Raw bytes collected from the child before sanitising (the kept output is far smaller). */
const MAX_RAW_OUTPUT_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 10_000;
/** A lock file without a readable owner is someone mid-write unless it is older than this. */
const UNREADABLE_LOCK_STALE_MS = 60_000;

export const QUEUED_MESSAGE = "Waiting for another update of this install to finish";
export const LOCK_GAVE_UP = "gave up waiting for another update of this install to finish";

export interface RunResult {
  outcome: "succeeded" | "unchanged" | "failed";
  fromVersion: string | null;
  toVersion: string | null;
  /** Sanitised, path-free, ≤ 10 KB. */
  output: string;
  /** One short path-free sentence when `failed`. */
  error?: string;
}

export interface RunProgress {
  state: "queued" | "running";
  message: string;
}

/** The per-OS-user lock directory (Pitfall 5): never `/tmp`, never under `OCW_HOME`. */
export function defaultLockDir(home: string = homedir()): string {
  return join(home, ".cache", "ocw", "runtime-updates");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether the installer's process group (it is spawned as its own group leader) still has a live member. */
function groupAlive(pgid: number): boolean {
  if (process.platform === "win32") return pidAlive(pgid);
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM" || pidAlive(pgid);
  }
}

const isPid = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** A held install lock: released by its holder; the installer's pid is recorded in it while it runs. */
export interface HeldInstallLock {
  release(): Promise<void>;
  /** Records the installer's pid (its process group), so the lock outlives a daemon that dies mid-install. */
  recordInstaller(pid: number): Promise<void>;
}

/**
 * One lock file per install root (`<sha256(installRoot)>.lock`, directory 0700, file 0600, `open(…, "wx")`, `{ pid,
 * startedAt }` inside, plus `installerPid` once the installer runs), so two daemons of the same OS user never run two
 * installers on one install (Pitfall 5). A lock is taken over only when neither its daemon nor its installer's process
 * group is alive: a daemon restarted mid-install waits for the orphaned installer (07.11 review HI-04).
 */
export class InstallLock {
  constructor(
    private readonly dir: string,
    /** Test seam: runs between judging a lock stale and taking it over (the race ME-01 closes). */
    private readonly hooks: { onStaleJudged?: () => Promise<void> } = {},
  ) {}

  async acquire(installRoot: string): Promise<HeldInstallLock | "busy"> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const st = await lstat(this.dir);
    if (!st.isDirectory()) throw new Error("the update lock directory is not a directory");
    await chmod(this.dir, 0o700);
    const file = join(this.dir, `${createHash("sha256").update(installRoot).digest("hex")}.lock`);
    const owner = { pid: process.pid, startedAt: new Date().toISOString(), nonce: randomUUID() };
    let token = JSON.stringify(owner);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(file, "wx", 0o600);
        try {
          await handle.writeFile(token);
        } finally {
          await handle.close();
        }
        return {
          release: async () => {
            const current = await readFile(file, "utf8").catch(() => null);
            if (current === token) await unlink(file).catch(() => undefined);
          },
          recordInstaller: async (installerPid: number) => {
            const current = await readFile(file, "utf8").catch(() => null);
            if (current !== token) return;
            const next = JSON.stringify({ ...owner, installerPid });
            // Replaced in one step (a reader never sees a half-written owner).
            const tmp = `${file}.${owner.nonce}.tmp`;
            await writeFile(tmp, next, { mode: 0o600 });
            await rename(tmp, file);
            token = next;
          },
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (attempt > 0) return "busy";
        const content = await readFile(file, "utf8").catch(() => null);
        if (content === null || !(await this.isStale(file, content))) return "busy";
        await this.hooks.onStaleJudged?.();
        if (!(await this.takeOver(file, content, owner.nonce))) return "busy";
      }
    }
    return "busy";
  }

  /**
   * Removes the stale lock `content` judged above, atomically (07.11 review ME-01): whatever is at `file` now is moved
   * aside in one step and deleted only when it is that same stale lock; a fresh lock another daemon took meanwhile is
   * put back and this caller stays busy. Never unlinks a path not just proven to be the stale one.
   */
  private async takeOver(file: string, content: string, nonce: string): Promise<boolean> {
    const aside = `${file}.stale.${nonce}`;
    try {
      await rename(file, aside);
    } catch (err) {
      // Gone already (released, or taken over and released): try to create it.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw err;
    }
    const moved = await readFile(aside, "utf8").catch(() => null);
    if (moved === content) {
      await unlink(aside).catch(() => undefined);
      return true;
    }
    // Someone else's live lock: back where it was (never over a lock created since), and wait.
    await link(aside, file).catch(() => undefined);
    await unlink(aside).catch(() => undefined);
    return false;
  }

  private async isStale(file: string, content: string): Promise<boolean> {
    let owner: { pid?: unknown; installerPid?: unknown } = {};
    try {
      owner = JSON.parse(content) as { pid?: unknown; installerPid?: unknown };
    } catch {
      owner = {};
    }
    if (isPid(owner.pid)) {
      if (pidAlive(owner.pid)) return false;
      return !(isPid(owner.installerPid) && groupAlive(owner.installerPid));
    }
    const st = await stat(file).catch(() => null);
    return st !== null && Date.now() - st.mtimeMs > UNREADABLE_LOCK_STALE_MS;
  }
}

/** The version a CLI reports for `--version`, or null. */
export async function probeVersion(binPath: string, exec: ExecFn = defaultExec): Promise<string | null> {
  const res = await exec(binPath, ["--version"], PROBE_TIMEOUT_MS).catch(() => null);
  if (res?.code !== 0) return null;
  return parseRuntimeVersion(res.stdout);
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_RE = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-_]`,
  "g",
);
// Control characters other than tab and newline (after \r has become \n).
const CONTROL_RE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  "g",
);

function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function scrub(raw: string, roots: readonly string[], home: string): string {
  let text = raw.replace(/\r\n?/g, "\n").replace(ANSI_RE, "").replace(CONTROL_RE, "");
  text = sanitizeString(text, roots, home);
  const realHome = tryRealpath(home);
  if (realHome && realHome !== home) text = sanitizeString(text, [], realHome);
  return scrubHostPaths(text);
}

/**
 * The last `maxBytes` of `text` (installers print their error at the end, 07.11 review LO-06), behind a marker that
 * says how much was cut; never splits a UTF-8 character.
 */
export function keepTail(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  let start = buf.byteLength - maxBytes;
  // Continuation bytes (10xxxxxx) belong to the character before them.
  while (start < buf.byteLength && ((buf[start] ?? 0) & 0xc0) === 0x80) start++;
  return `…[truncated ${start} bytes]\n${buf.subarray(start).toString("utf8")}`;
}

/** ANSI strip → contain/redact (home and its realpath) → `scrubHostPaths` → the last 10 KB (Pitfall 9). */
export function sanitizeUpdateOutput(raw: string, roots: readonly string[], home: string): string {
  return keepTail(scrub(raw, roots, home), MAX_KEPT_OUTPUT_BYTES);
}

export interface RunUpdateOptions {
  resolution: InstallResolution;
  /** The registry candidate; must be a `RuntimeVersion` (D-05). */
  candidate: string;
  lockDir: string;
  /** The daemon user's home (re-resolution and output scrubbing). Default `os.homedir()`. */
  home?: string;
  /** The daemon's environment, filtered for the child. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** 5 min: then the process group gets SIGTERM, and SIGKILL `killGraceMs` later. */
  timeoutMs?: number;
  killGraceMs?: number;
  /** After the installer exits, how long its output may drain before the run settles (default 2 s). */
  stdioGraceMs?: number;
  /** Retry interval while another updater holds the install's lock (5 s), and when to give up (10 min). */
  lockRetryMs?: number;
  lockGiveUpMs?: number;
  /** The install's lock, already held by the caller (who releases it); the runner then never waits for one. */
  lock?: HeldInstallLock;
  spawnFn?: typeof spawn;
  exec?: ExecFn;
  /** A fresh resolution (before and after the command); default re-resolves the same binary. */
  reResolve?: () => InstallResolution;
  onProgress?: (progress: RunProgress) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface ChildOutcome {
  code: number | null;
  timedOut: boolean;
  spawnError: boolean;
  raw: string;
}

/**
 * What the installer may receive from the daemon's environment (07.11 review ME-03): an allowlist, so a headless
 * server's tokens, cloud keys, database URLs or agent sockets never reach an installer (or the lifecycle scripts of
 * the packages it installs). The user, locale, temp directory, proxies and CA bundles, the CLIs' own config homes,
 * and npm/Homebrew settings stay; anything named like a credential is dropped even inside those families.
 */
const CHILD_ENV_KEEP = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  // Windows (manual-only there today; kept so a future method finds a sane environment).
  "SystemRoot",
  "SYSTEMROOT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "PATHEXT",
  "ComSpec",
  "COMSPEC",
]);
const CHILD_ENV_KEEP_PREFIXES = ["LC_", "npm_config_", "NPM_CONFIG_", "HOMEBREW_"];
const CREDENTIAL_NAME_RE = /auth|token|passw|secret|_key$|otp/i;

function keepForInstaller(name: string): boolean {
  if (name.startsWith("OCW_") || CREDENTIAL_NAME_RE.test(name)) return false;
  return CHILD_ENV_KEEP.has(name) || CHILD_ENV_KEEP_PREFIXES.some((p) => name.startsWith(p));
}

/** The installer's environment: the allowlist above (no `OCW_*`, no credential); quiet, colourless output. */
export function updateChildEnv(env: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && keepForInstaller(name)) kept[name] = value;
  }
  return {
    ...kept,
    NO_COLOR: "1",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    HOMEBREW_NO_ENV_HINTS: "1",
    // 07.11 review LO-02: `brew upgrade <cli>` changes nothing else unattended (no cleanup, no dependents upgraded).
    // Auto-update stays on: without it a server nobody runs `brew update` on would never see the new version.
    HOMEBREW_NO_INSTALL_CLEANUP: "1",
    HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: "1",
    ...extra,
  };
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // already gone
  }
}

interface ChildLimits {
  timeoutMs: number;
  killGraceMs: number;
  /** After the installer exits, how long its output may take to drain before the pipes are closed. */
  stdioGraceMs: number;
}

/**
 * Runs the installer and settles on its exit plus a short grace for the output to drain (a helper it left behind may
 * hold the pipes open for ever), on a spawn error, or at a hard deadline whatever the process and its pipes do
 * (07.11 review HI-03): the caller always gets an answer, so the gate is always reopened.
 */
function runChild(
  spawnFn: typeof spawn,
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  limits: ChildLimits,
  onChunk: (text: string) => void,
  onSpawn: (pid: number) => void = () => undefined,
): Promise<ChildOutcome> {
  const { timeoutMs, killGraceMs, stdioGraceMs } = limits;
  return new Promise((resolve) => {
    let raw = "";
    let rawBytes = 0;
    let timedOut = false;
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawnFn(file, args, {
        shell: false,
        // Its own process group, so a timeout kills the installer and everything it started.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env,
        cwd,
      });
    } catch {
      resolve({ code: null, timedOut: false, spawnError: true, raw: "" });
      return;
    }
    if (child.pid) onSpawn(child.pid);
    const collect = (chunk: Buffer) => {
      if (rawBytes >= MAX_RAW_OUTPUT_BYTES) return;
      rawBytes += chunk.byteLength;
      const text = chunk.toString("utf8");
      raw += text;
      onChunk(text);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    let killTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), killGraceMs);
    }, timeoutMs);
    const deadline = setTimeout(
      () => {
        timedOut = true;
        done({ code: null, timedOut: true, spawnError: false, raw });
      },
      timeoutMs + killGraceMs + stdioGraceMs + HARD_DEADLINE_SLACK_MS,
    );
    const done = (outcome: ChildOutcome) => {
      if (settled) return;
      settled = true;
      for (const t of [timer, killTimer, drainTimer, deadline]) if (t) clearTimeout(t);
      // The leader is gone; make sure nothing it started outlives it.
      if (outcome.timedOut) killGroup(child, "SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(outcome);
    };
    child.once("error", () => done({ code: null, timedOut, spawnError: true, raw }));
    child.once("close", (code: number | null) => done({ code, timedOut, spawnError: false, raw }));
    // `close` waits for every pipe; a helper the installer left behind may hold them open for ever.
    child.once("exit", (code: number | null) => {
      drainTimer = setTimeout(() => done({ code, timedOut, spawnError: false, raw }), stdioGraceMs);
    });
  });
}

export interface FixedCommandResult {
  /** The child's exit code; null when it could not be started or was killed by a signal. */
  exitCode: number | null;
  /** Sanitised, path-free, ≤ 10 KB (`sanitizeUpdateOutput`). */
  output: string;
  timedOut: boolean;
}

/**
 * 07.17.1 (D-03, PD-07): one fixed command (the self-update's `npm ci` and its preflight) with the 07.11 child rules —
 * no shell, its own process group, SIGTERM at `timeoutMs` then SIGKILL, a hard deadline, pipes closed after a short
 * grace — and its output through `sanitizeUpdateOutput(output, roots, home)`. The caller builds `env` (normally
 * `updateChildEnv`); a spawn failure settles with `exitCode: null`, never a throw.
 */
export async function runFixedCommand(p: {
  file: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
  roots: readonly string[];
  home: string;
}): Promise<FixedCommandResult> {
  const child = await runChild(
    spawn,
    p.file,
    [...p.args],
    p.env,
    p.cwd,
    { timeoutMs: p.timeoutMs, killGraceMs: KILL_GRACE_MS, stdioGraceMs: STDIO_GRACE_MS },
    () => undefined,
  );
  return {
    exitCode: child.spawnError ? null : child.code,
    output: sanitizeUpdateOutput(child.raw, p.roots, p.home),
    timedOut: child.timedOut,
  };
}

function failed(fromVersion: string | null, output: string, error: string): RunResult {
  return { outcome: "failed", fromVersion, toVersion: null, output, error };
}

/** The same install as the one checked: same method and same install root (else "install method changed"). */
function sameInstall(a: InstallResolution, b: InstallResolution): boolean {
  return a.method === b.method && a.installRoot !== null && a.installRoot === b.installRoot;
}

/**
 * Update one install (PD-11): wait for the install's lock (`queued`, every 5 s, up to 10 min) → re-resolve (method or
 * root changed → `failed`) → probe the version → the fixed command (shell-less, own process group, filtered env, 5
 * min then SIGTERM/SIGKILL) → re-resolve and probe → `succeeded` (moved up), `unchanged` (did not move) or `failed`.
 */
export async function runUpdate(opts: RunUpdateOptions): Promise<RunResult> {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const exec = opts.exec ?? defaultExec;
  const spawnFn = opts.spawnFn ?? spawn;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const input = opts.resolution;
  const reResolve =
    opts.reResolve ??
    (() =>
      resolveInstall(input.runtime, {
        home,
        env,
        ...(input.binPath ? { configuredPath: input.binPath } : {}),
      }));

  if (!updateCommandFor(input, opts.candidate, env) || !input.installRoot || !input.binPath) {
    return failed(null, "", "this install is not updatable here");
  }

  // A lock handed over by the caller (taken before it closed its gate, 07.11 review ME-02) stays the caller's to release.
  let held: HeldInstallLock;
  if (opts.lock) held = opts.lock;
  else {
    const locks = new InstallLock(opts.lockDir);
    const giveUpAt = now() + (opts.lockGiveUpMs ?? LOCK_GIVE_UP_MS);
    let lock = await locks.acquire(input.installRoot);
    let reportedQueued = false;
    while (lock === "busy") {
      if (!reportedQueued) {
        opts.onProgress?.({ state: "queued", message: QUEUED_MESSAGE });
        reportedQueued = true;
      }
      if (now() >= giveUpAt) return failed(null, "", LOCK_GAVE_UP);
      await sleep(opts.lockRetryMs ?? LOCK_RETRY_MS);
      lock = await locks.acquire(input.installRoot);
    }
    held = lock;
  }

  try {
    // Fresh, under the lock: the binary may have moved, or another updater may already have done the work.
    const before = reResolve();
    if (!sameInstall(input, before)) return failed(null, "", "install method changed since the check");
    const command = updateCommandFor(before, opts.candidate, env);
    if (!command || !before.binPath) return failed(null, "", "this install is not updatable here");
    const fromVersion = await probeVersion(before.binPath, exec);
    // Never a downgrade (07.11 review HI-01): the install may have caught up with (or moved past) the candidate since
    // the check, by hand or through another daemon; then there is nothing to run.
    if (fromVersion !== null && compareRuntimeVersions(fromVersion, opts.candidate) >= 0) {
      return { outcome: "unchanged", fromVersion, toVersion: fromVersion, output: "" };
    }

    let lastProgressAt = Number.NEGATIVE_INFINITY;
    const progress = (state: RunProgress["state"], text: string) => {
      if (!opts.onProgress) return;
      const t = now();
      if (t - lastProgressAt < PROGRESS_INTERVAL_MS) return;
      const line = scrub(text, [], home).trim().slice(0, MAX_PROGRESS_CHARS);
      if (!line) return;
      lastProgressAt = t;
      opts.onProgress({ state, message: line });
    };
    progress("running", "Running the update");
    const child = await runChild(
      spawnFn,
      command.file,
      command.args,
      updateChildEnv(env, command.env),
      home,
      {
        timeoutMs: opts.timeoutMs ?? UPDATE_TIMEOUT_MS,
        killGraceMs: opts.killGraceMs ?? KILL_GRACE_MS,
        stdioGraceMs: opts.stdioGraceMs ?? STDIO_GRACE_MS,
      },
      (text) => {
        const lines = text.split(/\r?\n|\r/).filter((l) => l.trim() !== "");
        const last = lines[lines.length - 1];
        if (last) progress("running", last);
      },
      // HI-04: the lock names the installer, so it is not taken over while the installer outlives this daemon.
      (pid) => {
        held.recordInstaller(pid).catch(() => undefined);
      },
    );
    const output = sanitizeUpdateOutput(child.raw, [], home);
    if (child.spawnError) return failed(fromVersion, output, "the update command could not be started");
    if (child.timedOut) return failed(fromVersion, output, "the update timed out");
    if (child.code !== 0) {
      return failed(fromVersion, output, `the update command exited with code ${child.code ?? "unknown"}`);
    }

    const after = reResolve();
    if (!sameInstall(input, after))
      return failed(fromVersion, output, "install method changed during the update");
    const toVersion = after.binPath ? await probeVersion(after.binPath, exec) : null;
    if (toVersion === null) return failed(fromVersion, output, "could not read the version after the update");
    if (fromVersion === null) return { outcome: "succeeded", fromVersion, toVersion, output };
    const moved = compareRuntimeVersions(toVersion, fromVersion);
    if (moved === 0) return { outcome: "unchanged", fromVersion, toVersion, output };
    if (moved < 0) {
      return { ...failed(fromVersion, output, "the installed version went down"), toVersion };
    }
    return { outcome: "succeeded", fromVersion, toVersion, output };
  } finally {
    if (!opts.lock) await held.release();
  }
}
