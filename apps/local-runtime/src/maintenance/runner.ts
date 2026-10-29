// Phase 07.11 (runtime CLI auto-updates, D-03, D-05, D-08, PD-11): run the one command the fixed table gives for an
// install, under a per-install lock, without a shell, with a filtered environment and a time limit, then re-detect
// the version and say how it ended. Never escalates: a `needs_admin` install has no command (D-08).
//
// No host path leaves the device (AGENTS principle 7): kept output passes ANSI strip → contain/redact →
// `scrubHostPaths` → 10 KB cap, and progress lines are sanitised the same way and cut to 200 characters.

import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareRuntimeVersions, parseRuntimeVersion, scrubHostPaths } from "@ocw/contracts";
import { CLAUDE_API_KEY_VARS } from "../claude/claude-runtime.js";
import { defaultExec, type ExecFn } from "../claude/detect.js";
import { filterEnv } from "../exec-path.js";
import { sanitizeString, truncateBytes } from "../sanitize.js";
import { type InstallResolution, resolveInstall, updateCommandFor } from "./install-method.js";

export const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;
export const KILL_GRACE_MS = 5_000;
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

/** Credentials the installer never receives (besides every `OCW_*`, which includes the device token). */
const CHILD_ENV_DROP = new Set([...CLAUDE_API_KEY_VARS, "OPENAI_API_KEY", "CODEX_API_KEY"]);

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

/**
 * One lock file per install root (`<sha256(installRoot)>.lock`, directory 0700, file 0600, `open(…, "wx")`, `{ pid,
 * startedAt }` inside), so two daemons of the same OS user never run two installers on one install (Pitfall 5). A
 * lock whose pid is gone is taken over.
 */
export class InstallLock {
  constructor(private readonly dir: string) {}

  async acquire(installRoot: string): Promise<{ release: () => Promise<void> } | "busy"> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const st = await lstat(this.dir);
    if (!st.isDirectory()) throw new Error("the update lock directory is not a directory");
    await chmod(this.dir, 0o700);
    const file = join(this.dir, `${createHash("sha256").update(installRoot).digest("hex")}.lock`);
    const token = JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      nonce: randomUUID(),
    });

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
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (attempt > 0 || !(await this.isStale(file))) return "busy";
        await unlink(file).catch(() => undefined);
      }
    }
    return "busy";
  }

  private async isStale(file: string): Promise<boolean> {
    const content = await readFile(file, "utf8").catch(() => null);
    if (content === null) return false;
    let pid: unknown;
    try {
      pid = (JSON.parse(content) as { pid?: unknown }).pid;
    } catch {
      pid = undefined;
    }
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) return !pidAlive(pid);
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

/** ANSI strip → contain/redact (home and its realpath) → `scrubHostPaths` → 10 KB cap (Pitfall 9). */
export function sanitizeUpdateOutput(raw: string, roots: readonly string[], home: string): string {
  return truncateBytes(scrub(raw, roots, home), MAX_KEPT_OUTPUT_BYTES).text;
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
  /** Retry interval while another updater holds the install's lock (5 s), and when to give up (10 min). */
  lockRetryMs?: number;
  lockGiveUpMs?: number;
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

/** The installer's environment: no `OCW_*` (device token, server URL), no API key; quiet, colourless output. */
export function updateChildEnv(env: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...filterEnv(env, (k) => k.startsWith("OCW_") || CHILD_ENV_DROP.has(k) || k.endsWith("_API_KEY")),
    NO_COLOR: "1",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    HOMEBREW_NO_ENV_HINTS: "1",
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

function runChild(
  spawnFn: typeof spawn,
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
  killGraceMs: number,
  onChunk: (text: string) => void,
): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    let raw = "";
    let rawBytes = 0;
    let timedOut = false;
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
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), killGraceMs);
    }, timeoutMs);
    const done = (outcome: ChildOutcome) => {
      clearTimeout(timer);
      // The leader is gone; make sure nothing it started outlives it.
      if (outcome.timedOut) killGroup(child, "SIGKILL");
      if (killTimer) clearTimeout(killTimer);
      resolve(outcome);
    };
    child.once("error", () => done({ code: null, timedOut, spawnError: true, raw }));
    child.once("close", (code) => done({ code, timedOut, spawnError: false, raw }));
  });
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

  const locks = new InstallLock(opts.lockDir);
  const giveUpAt = now() + (opts.lockGiveUpMs ?? LOCK_GIVE_UP_MS);
  let lock = await locks.acquire(input.installRoot);
  let reportedQueued = false;
  while (lock === "busy") {
    if (!reportedQueued) {
      opts.onProgress?.({ state: "queued", message: QUEUED_MESSAGE });
      reportedQueued = true;
    }
    if (now() >= giveUpAt)
      return failed(null, "", "gave up waiting for another update of this install to finish");
    await sleep(opts.lockRetryMs ?? LOCK_RETRY_MS);
    lock = await locks.acquire(input.installRoot);
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
      opts.timeoutMs ?? UPDATE_TIMEOUT_MS,
      opts.killGraceMs ?? KILL_GRACE_MS,
      (text) => {
        const lines = text.split(/\r?\n|\r/).filter((l) => l.trim() !== "");
        const last = lines[lines.length - 1];
        if (last) progress("running", last);
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
    await lock.release();
  }
}
