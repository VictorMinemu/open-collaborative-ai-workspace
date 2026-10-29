// One runtime owner per `~/.ocw` (07.12-04, D-14, PD-15, RESEARCH Pitfall 6). A second daemon would steal the control
// socket (`listen()` unlinks it) and both would connect with the same token and double-execute commands, so
// `service install` refuses while another runtime runs on this account: one answering on the control socket that is
// not this service, or the desktop app's supervised daemon (its pidfile names a live process). Read only: nothing here
// stops or signals another process (`kill(pid, 0)` only tests that it exists).

import { join } from "node:path";
import { z } from "zod";
import { type ControlRequest, controlSocketPath } from "../control-socket.js";

export const RUNTIME_ALREADY_RUNS =
  "a runtime already runs on this account (the desktop app or a hand-started `ocw-runtime run`); stop it, then re-run";
export const DESKTOP_OWNS_RUNTIME =
  "the desktop app supervises the runtime on this account; use the desktop app or the service, not both";

/** How long the socket gets to answer `status` before it counts as nobody's. */
export const OWNER_PROBE_TIMEOUT_MS = 2_000;

/** `<OCW_HOME>/desktop-daemon.pid` as `apps/desktop/src/main/pidfile.ts` writes it (read only, not imported). */
const DesktopPidfile = z.object({ pid: z.number().int().positive(), startedAt: z.string() });

export type OwnerConflict = { kind: "none" } | { kind: "socket" | "desktop"; message: string };

export interface OwnerDeps {
  controlRequest: (
    path: string,
    req: ControlRequest,
    timeoutMs?: number,
  ) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  /** A file's text, or null when it does not exist (the caller maps machine paths). */
  readText: (path: string) => Promise<string | null>;
  /** `process.kill(pid, 0)`. */
  kill: (pid: number, signal: 0) => void;
  /** The unit this command manages is installed and running, so an answering socket is that service. */
  serviceActive: boolean;
}

function alive(pid: number, kill: OwnerDeps["kill"]): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another account.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function desktopDaemonAlive(home: string, deps: OwnerDeps): Promise<boolean> {
  const text = await deps.readText(join(home, "desktop-daemon.pid"));
  if (text === null) return false;
  let parsed: z.infer<typeof DesktopPidfile>;
  try {
    const result = DesktopPidfile.safeParse(JSON.parse(text));
    if (!result.success) return false;
    parsed = result.data;
  } catch {
    return false;
  }
  return alive(parsed.pid, deps.kill);
}

async function socketAnswers(home: string, deps: OwnerDeps): Promise<boolean> {
  try {
    await deps.controlRequest(controlSocketPath(home), { cmd: "status" }, OWNER_PROBE_TIMEOUT_MS);
    return true; // any answer, even an error reply, is a runtime listening
  } catch {
    return false; // ENOENT, ECONNREFUSED (a stale socket file) or a timeout
  }
}

export async function runtimeOwnerConflict(home: string, deps: OwnerDeps): Promise<OwnerConflict> {
  if (await desktopDaemonAlive(home, deps)) return { kind: "desktop", message: DESKTOP_OWNS_RUNTIME };
  if (!deps.serviceActive && (await socketAnswers(home, deps))) {
    return { kind: "socket", message: RUNTIME_ALREADY_RUNS };
  }
  return { kind: "none" };
}

/**
 * Whether the runtime on this `~/.ocw` reports no running session, so a restart cannot cut one. Unknown (no answer,
 * an error reply, an unexpected shape) is "not idle": the caller then prints the restart command instead.
 */
export async function runtimeIdle(home: string, deps: Pick<OwnerDeps, "controlRequest">): Promise<boolean> {
  try {
    const reply = await deps.controlRequest(
      controlSocketPath(home),
      { cmd: "status" },
      OWNER_PROBE_TIMEOUT_MS,
    );
    const parsed = z.object({ sessions: z.array(z.unknown()) }).safeParse(reply.result);
    return reply.ok && parsed.success && parsed.data.sessions.length === 0;
  } catch {
    return false;
  }
}
