// The one way the service module runs a command (07.12-04, D-04, PD-19): no shell, a time limit, capped output, and a
// guard that refuses the real service managers under Vitest, so no test can install, start or stop a service on the
// developer's machine. Tests inject their own exec; a deliberate proof sets OCW_SERVICE_PROOF=1.

import { spawn } from "node:child_process";
import { basename } from "node:path";

export interface ServiceExecResult {
  /** Exit code; null when the binary could not be started (ENOENT) or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ServiceExecOptions {
  /** Default 30 s; ignored with `inherit`. */
  timeoutMs?: number;
  /**
   * Hand the terminal to the command (`logs --follow`): stdio inherited, no timeout, nothing captured. The result's
   * stdout and stderr are empty.
   */
  inherit?: boolean;
}

export type ServiceExecFn = (
  file: string,
  args: string[],
  opts?: ServiceExecOptions,
) => Promise<ServiceExecResult>;

export const SERVICE_EXEC_TIMEOUT_MS = 30_000;
export const MAX_SERVICE_OUTPUT_BYTES = 64 * 1024;

/** The tools that change or read this machine's services; never run under tests (PD-19). */
const GUARDED = new Set(["systemctl", "loginctl", "launchctl", "journalctl"]);

export function isGuardedServiceCommand(file: string): boolean {
  return GUARDED.has(basename(file));
}

function refusedUnderTests(file: string): boolean {
  return (
    isGuardedServiceCommand(file) && Boolean(process.env.VITEST) && process.env.OCW_SERVICE_PROOF !== "1"
  );
}

export const defaultServiceExec: ServiceExecFn = (file, args, opts = {}) => {
  if (refusedUnderTests(file)) {
    return Promise.reject(
      new Error(`${basename(file)} refused under tests (PD-19): inject an exec, or set OCW_SERVICE_PROOF=1`),
    );
  }
  return new Promise((resolve) => {
    if (opts.inherit) {
      const child = spawn(file, args, { shell: false, stdio: "inherit" });
      child.on("error", () => resolve({ code: null, stdout: "", stderr: "" }));
      child.on("close", (code) => resolve({ code, stdout: "", stderr: "" }));
      return;
    }
    const child = spawn(file, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const out = { stdout: "", stderr: "" };
    const collect = (key: "stdout" | "stderr") => (chunk: Buffer) => {
      const room = MAX_SERVICE_OUTPUT_BYTES - out[key].length;
      if (room > 0) out[key] += chunk.toString("utf8").slice(0, room);
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? SERVICE_EXEC_TIMEOUT_MS);
    let settled = false;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, ...out });
    };
    child.on("error", () => settle(null));
    child.on("close", (code) => settle(code));
  });
};
