// Pidfile for the daemon the desktop app spawned (`<OCW_HOME>/desktop-daemon.pid`). On start we
// reap a daemon left behind by a previous app instance that crashed or was force-quit, so there
// is never more than one supervised daemon (ADR-0005: "reaps child process groups on start").

import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const PidfileSchema = z.object({ pid: z.number().int().positive(), startedAt: z.string() });
export type Pidfile = z.infer<typeof PidfileSchema>;

export function pidfilePath(ocwHome: string): string {
  return join(ocwHome, "desktop-daemon.pid");
}

export async function writePidfile(path: string, pid: number): Promise<void> {
  const body: Pidfile = { pid, startedAt: new Date().toISOString() };
  await writeFile(path, `${JSON.stringify(body)}\n`, { mode: 0o600 });
}

export async function readPidfile(path: string): Promise<Pidfile | null> {
  try {
    return PidfileSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
}

export async function removePidfile(path: string): Promise<void> {
  await rm(path, { force: true });
}

/** Remove the pidfile only if it still points at `pid` (a newer daemon may have replaced it). */
export async function removePidfileIfOwner(path: string, pid: number | undefined): Promise<void> {
  const file = await readPidfile(path);
  if (file && pid !== undefined && file.pid === pid) await removePidfile(path);
}

export interface ReapDeps {
  isAlive: (pid: number) => boolean;
  /** Command line of a process, or null if unknown. */
  commandOf: (pid: number) => Promise<string | null>;
  killGroup: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
}

export const defaultReapDeps: ReapDeps = {
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  commandOf: (pid) =>
    new Promise((resolve) => {
      execFile("ps", ["-o", "command=", "-p", String(pid)], { timeout: 3000 }, (err, stdout) =>
        resolve(err ? null : String(stdout).trim() || null),
      );
    }),
  killGroup: (pid, signal) => {
    try {
      process.kill(-pid, signal);
    } catch {
      process.kill(pid, signal);
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Daemon processes look like `<node or Electron> …/ocw-runtime run`. */
export function looksLikeDaemon(command: string | null): boolean {
  return command !== null && /ocw-runtime/.test(command);
}

export type ReapResult = "none" | "stale-file" | "not-ours" | "reaped";

/**
 * If the pidfile points at a live process that is our daemon, terminate its process group
 * (SIGTERM, then SIGKILL after `graceMs`). Never kills a recycled pid running something else.
 */
export async function reapStaleDaemon(
  path: string,
  deps: ReapDeps = defaultReapDeps,
  graceMs = 3000,
): Promise<ReapResult> {
  const file = await readPidfile(path);
  if (!file) return "none";
  const { pid } = file;
  if (!deps.isAlive(pid)) {
    await removePidfile(path);
    return "stale-file";
  }
  if (!looksLikeDaemon(await deps.commandOf(pid))) {
    await removePidfile(path);
    return "not-ours";
  }
  try {
    deps.killGroup(pid, "SIGTERM");
  } catch {
    // raced with exit
  }
  const step = 100;
  for (let waited = 0; waited < graceMs && deps.isAlive(pid); waited += step) await deps.sleep(step);
  if (deps.isAlive(pid)) {
    try {
      deps.killGroup(pid, "SIGKILL");
    } catch {
      // raced with exit
    }
  }
  await removePidfile(path);
  return "reaped";
}
