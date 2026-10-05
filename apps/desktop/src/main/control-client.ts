// Client for the daemon's local control socket (`<OCW_HOME>/runtime.sock`, JSON lines). The
// desktop app talks to the daemon ONLY through this socket — never a TCP port.

import { createConnection } from "node:net";
import { join } from "node:path";

export type ControlCommand =
  | { cmd: "status" }
  | { cmd: "listProjects" }
  | { cmd: "addProject"; path: string; name?: string }
  | { cmd: "removeProject"; localId: string }
  /** Re-read runtime.json (Full access opt-in, ADR-0012); carries no value. */
  | { cmd: "reloadConfig" };

export class ControlError extends Error {}

export function controlSocketPath(ocwHome: string): string {
  return process.platform === "win32" ? "\\\\.\\pipe\\ocw-runtime" : join(ocwHome, "runtime.sock");
}

let nextId = 1;

/** Send one request and resolve with its `result` (or reject with the daemon's error). */
export function controlRequest(socketPath: string, req: ControlCommand, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(
      () => settle(() => reject(new ControlError("runtime did not answer"))),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, ...req })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024)
        return settle(() => reject(new ControlError("response too large")));
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
        let msg: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          return settle(() => reject(new ControlError("malformed response from runtime")));
        }
        if (msg.id !== undefined && msg.id !== id) continue;
        if (msg.ok === true) return settle(() => resolve(msg.result));
        const error = typeof msg.error === "string" ? msg.error : "runtime request failed";
        return settle(() => reject(new ControlError(error)));
      }
    });
    socket.on("error", (err: NodeJS.ErrnoException) =>
      settle(() =>
        reject(
          new ControlError(
            err.code === "ENOENT" || err.code === "ECONNREFUSED"
              ? "runtime is not running"
              : "runtime unreachable",
          ),
        ),
      ),
    );
    socket.on("close", () => settle(() => reject(new ControlError("runtime closed the connection"))));
  });
}
