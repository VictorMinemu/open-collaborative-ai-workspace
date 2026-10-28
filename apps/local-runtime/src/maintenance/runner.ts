// Phase 07.11 (runtime CLI auto-updates, D-03, D-05, D-08, PD-11): run the one command the fixed table gives for an
// install, under a per-install lock, without a shell, with a filtered environment and a time limit, then re-detect
// the version and say how it ended. Never escalates: a `needs_admin` install has no command (D-08).
//
// No host path leaves the device (AGENTS principle 7): kept output passes ANSI strip → contain/redact →
// `scrubHostPaths` → 10 KB cap.

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareRuntimeVersions, parseRuntimeVersion, scrubHostPaths } from "@ocw/contracts";
import { defaultExec, type ExecFn } from "../claude/detect.js";
import { filterEnv } from "../exec-path.js";
import { sanitizeString, truncateBytes } from "../sanitize.js";
import { type InstallResolution, resolveInstall, updateCommandFor } from "./install-method.js";

export const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_KEPT_OUTPUT_BYTES = 10 * 1024;
/** Raw bytes collected from the child before sanitising (the kept output is far smaller). */
const MAX_RAW_OUTPUT_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 10_000;

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

/**
 * One lock file per install root (`<sha256(installRoot)>.lock`, directory 0700, file 0600, `open(…, "wx")`), so two
 * daemons of the same OS user never run two installers on one install (Pitfall 5).
 */
export class InstallLock {
  constructor(private readonly dir: string) {}

  async acquire(installRoot: string): Promise<{ release: () => Promise<void> } | "busy"> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const st = await lstat(this.dir);
    if (!st.isDirectory()) throw new Error("the update lock directory is not a directory");
    await chmod(this.dir, 0o700);
    const file = join(this.dir, `${createHash("sha256").update(installRoot).digest("hex")}.lock`);
    const token = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
    try {
      const handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(token);
      } finally {
        await handle.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return "busy";
      throw err;
    }
    return {
      release: async () => {
        const current = await readFile(file, "utf8").catch(() => null);
        if (current === token) await unlink(file).catch(() => undefined);
      },
    };
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

/** ANSI strip → contain/redact (home and its realpath) → `scrubHostPaths` → 10 KB cap (Pitfall 9). */
export function sanitizeUpdateOutput(raw: string, roots: readonly string[], home: string): string {
  let text = raw.replace(/\r\n?/g, "\n").replace(ANSI_RE, "").replace(CONTROL_RE, "");
  text = sanitizeString(text, roots, home);
  const realHome = tryRealpath(home);
  if (realHome && realHome !== home) text = sanitizeString(text, [], realHome);
  return truncateBytes(scrubHostPaths(text), MAX_KEPT_OUTPUT_BYTES).text;
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
  timeoutMs?: number;
  spawnFn?: typeof spawn;
  exec?: ExecFn;
  /** Fresh resolution after the command; default re-resolves the same binary. */
  reResolve?: () => InstallResolution;
  onProgress?: (progress: RunProgress) => void;
}

interface ChildOutcome {
  code: number | null;
  timedOut: boolean;
  spawnError: boolean;
  raw: string;
}

function childEnv(env: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...filterEnv(env, (k) => k.startsWith("OCW_")),
    NO_COLOR: "1",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    HOMEBREW_NO_ENV_HINTS: "1",
    ...extra,
  };
}

function runChild(
  spawnFn: typeof spawn,
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    let raw = "";
    let rawBytes = 0;
    let timedOut = false;
    let child: ChildProcess;
    try {
      child = spawnFn(file, args, {
        shell: false,
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
      raw += chunk.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ code: null, timedOut, spawnError: true, raw });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, spawnError: false, raw });
    });
  });
}

function failed(fromVersion: string | null, output: string, error: string): RunResult {
  return { outcome: "failed", fromVersion, toVersion: null, output, error };
}

/**
 * Update one install (PD-11): lock → the fixed command (shell-less, own process group, filtered env, time limit) →
 * re-resolve and probe `--version` → `succeeded` (moved up), `unchanged` (did not move) or `failed`.
 */
export async function runUpdate(opts: RunUpdateOptions): Promise<RunResult> {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const exec = opts.exec ?? defaultExec;
  const spawnFn = opts.spawnFn ?? spawn;
  const input = opts.resolution;
  const reResolve =
    opts.reResolve ??
    (() =>
      resolveInstall(input.runtime, {
        home,
        env,
        ...(input.binPath ? { configuredPath: input.binPath } : {}),
      }));

  const command = updateCommandFor(input, opts.candidate);
  if (!command || !input.installRoot || !input.binPath)
    return failed(null, "", "this install is not updatable here");

  const lock = await new InstallLock(opts.lockDir).acquire(input.installRoot);
  if (lock === "busy") return failed(null, "", "another update of this install is running");
  try {
    const fromVersion = await probeVersion(input.binPath, exec);
    opts.onProgress?.({ state: "running", message: "Running the update" });
    const child = await runChild(
      spawnFn,
      command.file,
      command.args,
      childEnv(env, command.env),
      home,
      opts.timeoutMs ?? UPDATE_TIMEOUT_MS,
    );
    const output = sanitizeUpdateOutput(child.raw, [], home);
    if (child.spawnError) return failed(fromVersion, output, "the update command could not be started");
    if (child.timedOut) return failed(fromVersion, output, "the update timed out");
    if (child.code !== 0)
      return failed(fromVersion, output, `the update command exited with code ${child.code}`);

    const after = reResolve();
    const toVersion = after.binPath ? await probeVersion(after.binPath, exec) : null;
    if (toVersion === null) return failed(fromVersion, output, "could not read the version after the update");
    if (fromVersion !== null && compareRuntimeVersions(toVersion, fromVersion) === 0) {
      return { outcome: "unchanged", fromVersion, toVersion, output };
    }
    return { outcome: "succeeded", fromVersion, toVersion, output };
  } finally {
    await lock.release();
  }
}
