// The browser child's entry (07.13 D-02, PD-19): `ocw-runtime browser-agent`, started only by the daemon's
// `BrowserChild`, one per session with a browser. Spoken to over stdio only (no port, no socket):
//   stdin   JSON lines `{ id, op, ...input }`; `op` must be in `AGENT_OPS` (ops.ts), empty lines are skipped.
//   stdout  frames of the bots' codec (`encodeFrame`, sandboxd-protocol): `FRAME_TYPES.control` carries one JSON message,
//           a response `{ id, ok: true, result }` / `{ id, ok: false, error: { code, message } }` or an event
//           `{ event, ... }` (`ready`, the agent's own events); `FRAME_TYPES.jpeg` carries live frames (15).
//   stderr  fixed diagnostic names only (`browser-agent: <name> [<code>]`): never a URL, page text, typed text or path.
// Env (set only by the parent, `childEnv`): OCW_BROWSER_EXECUTABLE, OCW_BROWSER_SANDBOX (`on` | `off`, from
// `resolveChromiumSandbox`); TMPDIR/TMP/TEMP are the session's run dir, so Playwright's profile lands there.
// Exits 0 when stdin ends or on SIGTERM (after closing the browser), 2 on a line over the bound, 3 when Chromium goes
// away on its own.

import { encodeFrame, FRAME_MAX_PAYLOAD_BYTES, FRAME_TYPES } from "@ocw/contracts";
import {
  AgentError,
  type AgentEvent,
  type AgentOp,
  createBrowserAgent,
  isAgentOp,
  opDeadlineMs,
  runOp,
} from "./ops.js";

/** One stdin line at most (a typed text and its JSON envelope fit far below). */
const STDIN_LINE_MAX_BYTES = 1024 * 1024;

type Message = {
  id: string | number | null;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

export interface BrowserAgentIo {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  exit?: (code: number) => void;
}

export function runBrowserAgent(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  io: Omit<BrowserAgentIo, "stdin" | "stdout"> = {},
): void {
  const env = io.env ?? process.env;
  const stderr = io.stderr ?? process.stderr;
  const exit = io.exit ?? ((code: number) => process.exit(code));
  const diag = (name: string, code?: string) =>
    stderr.write(`browser-agent: ${name}${code && /^[a-z_]{1,40}$/.test(code) ? ` ${code}` : ""}\n`);

  const writeJson = (msg: unknown) => {
    const payload = Buffer.from(JSON.stringify(msg), "utf8");
    if (payload.length > FRAME_MAX_PAYLOAD_BYTES) return false;
    stdout.write(encodeFrame(FRAME_TYPES.control, payload));
    return true;
  };
  const respond = (msg: Message) => {
    if (writeJson(msg)) return;
    writeJson({ id: msg.id, ok: false, error: errorOf(new AgentError("too_large")) });
  };

  const executablePath = env.OCW_BROWSER_EXECUTABLE ?? "";
  const agent = createBrowserAgent({
    executablePath,
    chromiumSandbox: (env.OCW_BROWSER_SANDBOX ?? "on").trim().toLowerCase() !== "off",
    emit: (event: AgentEvent) => {
      writeJson(event);
    },
    onDisconnected: () => {
      diag("chromium_disconnected");
      exit(3);
    },
  });

  let stopping = false;
  const shutdown = (reason: string) => {
    if (stopping) return;
    stopping = true;
    diag("exit", reason);
    void agent
      .close({})
      .catch(() => undefined)
      .finally(() => exit(0));
  };

  async function handle(line: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      diag("bad_line");
      respond({ id: null, ok: false, error: errorOf(new AgentError("invalid_request")) });
      return;
    }
    const record = typeof msg === "object" && msg !== null ? (msg as Record<string, unknown>) : {};
    const id = typeof record.id === "string" || typeof record.id === "number" ? record.id : null;
    const op = record.op;
    if (!isAgentOp(op)) {
      respond({
        id,
        ok: false,
        error: errorOf(new AgentError("invalid_request", "The browser has no such operation.")),
      });
      return;
    }
    const { id: _id, op: _op, ...input } = record;
    try {
      const result = await withDeadline(op, runOp(agent, op, input));
      respond({ id, ok: true, result });
    } catch (err) {
      if (!(err instanceof AgentError)) diag("op_error", op);
      respond({ id, ok: false, error: errorOf(err) });
    }
  }

  let buf = Buffer.alloc(0);
  stdin.on("data", (chunk: Buffer | string) => {
    buf = Buffer.concat([buf, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk]);
    let nl = buf.indexOf(0x0a);
    while (nl >= 0) {
      const line = buf.subarray(0, nl).toString("utf8").trim();
      buf = buf.subarray(nl + 1);
      if (line) void handle(line);
      nl = buf.indexOf(0x0a);
    }
    if (buf.length > STDIN_LINE_MAX_BYTES) {
      diag("exit", "line_too_long");
      exit(2);
    }
  });
  stdin.on("end", () => shutdown("stdin_end"));
  process.on("SIGTERM", () => shutdown("sigterm"));
  writeJson({ event: "ready" });
  diag("ready");
}

/** An op's answer within its deadline (`open` may launch Chromium first), else `timeout`. */
function withDeadline<T>(op: AgentOp, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AgentError("timeout")), opDeadlineMs(op));
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The error a response carries: an `AgentError`'s code and fixed message, else `browser_unavailable` (never a message). */
function errorOf(err: unknown): { code: string; message: string } {
  const e = err instanceof AgentError ? err : new AgentError("browser_unavailable");
  return { code: e.code, message: e.message };
}
