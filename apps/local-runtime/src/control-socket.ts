// Local control channel for the desktop shell: newline-delimited JSON over a Unix domain socket
// (`~/.ocw/runtime.sock`, mode 0600) or a named pipe on Windows. Never a TCP port.

import { chmod, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { errorMessage, type Logger, silentLogger } from "./logger.js";

export const ControlRequestSchema = z.discriminatedUnion("cmd", [
  z.object({ id: z.union([z.string(), z.number()]).optional(), cmd: z.literal("status") }),
  z.object({ id: z.union([z.string(), z.number()]).optional(), cmd: z.literal("listProjects") }),
  z.object({
    id: z.union([z.string(), z.number()]).optional(),
    cmd: z.literal("addProject"),
    path: z.string().min(1),
    name: z.string().optional(),
  }),
  z.object({
    id: z.union([z.string(), z.number()]).optional(),
    cmd: z.literal("removeProject"),
    localId: z.string(),
  }),
]);
export type ControlRequest = z.infer<typeof ControlRequestSchema>;

export type ControlHandler = (req: ControlRequest) => Promise<unknown>;

export function controlSocketPath(home: string): string {
  return process.platform === "win32" ? "\\\\.\\pipe\\ocw-runtime" : join(home, "runtime.sock");
}

export class ControlSocketServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly log: Logger;

  constructor(
    private readonly path: string,
    private readonly handler: ControlHandler,
    logger?: Logger,
  ) {
    this.log = logger ?? silentLogger;
  }

  async listen(): Promise<void> {
    if (process.platform !== "win32") await unlink(this.path).catch(() => undefined); // stale socket
    const server = createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (process.platform !== "win32") await chmod(this.path, 0o600);
    this.server = server;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== "win32") await unlink(this.path).catch(() => undefined);
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) {
        socket.destroy();
        return;
      }
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) void this.handleLine(socket, line);
        idx = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => this.sockets.delete(socket));
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let id: string | number | undefined;
    try {
      const raw = JSON.parse(line) as unknown;
      const maybeId = (raw as { id?: unknown } | null)?.id;
      if (typeof maybeId === "string" || typeof maybeId === "number") id = maybeId;
      const req = ControlRequestSchema.parse(raw);
      const result = await this.handler(req);
      this.reply(socket, { id, ok: true, result });
    } catch (err) {
      this.log.debug("control request failed", { error: errorMessage(err) });
      this.reply(socket, {
        id,
        ok: false,
        error: err instanceof z.ZodError ? "invalid request" : errorMessage(err),
      });
    }
  }

  private reply(socket: Socket, body: unknown): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(body)}\n`);
  }
}

/** Client helper (used by the CLI and tests): send one request, await one response line. */
export function controlRequest(
  path: string,
  req: ControlRequest,
  timeoutMs = 10_000,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("control socket timeout"));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(req)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, idx)) as { ok: boolean; result?: unknown; error?: string });
      } catch (err) {
        reject(err);
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
