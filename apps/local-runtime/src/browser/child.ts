// The daemon's side of a session's browser (07.13 D-02, D-03, PD-19, PD-24, Pitfall 1): one child process per session,
// `ocw-runtime browser-agent` (agent/main.ts), so a Chromium crash ends that page and never the daemon.
//
// - The child is the daemon's own entry re-executed (`process.execPath` + `entry` + `browser-agent`; the bundle, the
//   desktop's Electron-as-Node and dev under tsx all re-exec themselves), over stdio only: JSON lines in, the bots'
//   frame codec out (`decodeFrameHeader`, `FRAME_TYPES`). No port, no socket.
// - Its env is an allowlist (`childEnv`): PATH, HOME, the browser settings and TMPDIR/TMP/TEMP = the session's run dir
//   `<browsersRoot>/run/<sessionId>` (0700). Playwright creates Chromium's throwaway profile in the temp dir, so the
//   profile lives in the run dir (the research correction of D-03: never Chromium's own profile flag) and goes with
//   it: removed on close, after a crash, and by `sweepRunDirs` at daemon start for sessions that are not alive.
//   No device token, no `OCW_*` secret and no provider key reaches the child.
// - `call` answers with the agent's result or rejects with a `BrowserChildError` (the agent's code and fixed message);
//   a dead child rejects every pending and later call with `browser_unavailable` and reports `{ event: "crashed",
//   scope: "process" }`.

import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { decodeFrameHeader, FRAME_HEADER_BYTES, FRAME_TYPES, WORK_BROWSER_TIMEOUTS_MS } from "@ocw/contracts";
import type { AgentErrorCode, AgentEvent, AgentOp } from "./agent/ops.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `<root>/run/<sessionId>`; the session id must be a uuid (it becomes a path). */
export function sessionRunDir(root: string, sessionId: string): string {
  if (!UUID.test(sessionId)) throw new Error("the session id is not a uuid");
  return join(root, "run", sessionId);
}

/** Removes every run dir under `<root>/run` whose session is not in `live` (daemon start, Pitfall 1). */
export async function sweepRunDirs(root: string, live: ReadonlySet<string>): Promise<void> {
  const dir = join(root, "run");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (live.has(name)) continue;
    await rm(join(dir, name), { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

/** The child's whole env: an allowlist, never the daemon's env passed through. */
export function childEnv(
  parent: NodeJS.ProcessEnv,
  opts: { runDir: string; executablePath: string; sandbox: boolean },
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: parent.PATH ?? "",
    HOME: parent.HOME ?? "",
    TMPDIR: opts.runDir,
    TMP: opts.runDir,
    TEMP: opts.runDir,
    OCW_BROWSER_EXECUTABLE: opts.executablePath,
    OCW_BROWSER_SANDBOX: opts.sandbox ? "on" : "off",
  };
  // The desktop runs the daemon as Electron-as-Node; the child re-execs the same binary.
  if (parent.ELECTRON_RUN_AS_NODE) env.ELECTRON_RUN_AS_NODE = parent.ELECTRON_RUN_AS_NODE;
  // Windows: Node and Chromium need the system root; it names no secret.
  if (process.platform === "win32" && parent.SystemRoot) env.SystemRoot = parent.SystemRoot;
  return env;
}

/** A refused or failed call: the agent's code and its fixed message, or `browser_unavailable` / `timeout` from here. */
export class BrowserChildError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrowserChildError";
  }
}

const UNAVAILABLE = "The browser stopped. Open the page again.";
const TIMED_OUT = "The browser did not answer in time.";

/** What the parent waits for one call: the child's own deadline plus a margin for the round trip. */
function callTimeoutMs(op: AgentOp): number {
  const margin = 5_000;
  return op === "open"
    ? WORK_BROWSER_TIMEOUTS_MS.launch + WORK_BROWSER_TIMEOUTS_MS.op + margin
    : WORK_BROWSER_TIMEOUTS_MS.op + margin;
}

const CLOSE_TERM_MS = 3_000;
const CLOSE_KILL_MS = 6_000;

export type BrowserChildEvent = AgentEvent | { event: "ready" } | { event: "crashed"; scope: "process" };

export interface BrowserChildOptions {
  sessionId: string;
  /** `browsersRoot()`. */
  root: string;
  executablePath: string;
  /** From `resolveChromiumSandbox` (PD-18). */
  sandbox: boolean;
  /** The runtime's entry script(s) before `browser-agent`; default `[process.argv[1]]` (research Pattern 1). */
  entry?: string[];
  /** The env the allowlist reads from (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: BrowserChildEvent) => void;
  /** A live JPEG frame (15). Never persisted. */
  onFrame?: (jpeg: Uint8Array) => void;
  /**
   * 07.13-12: names in the run dir that outlive this child (the session's `shim-token`, which the manager owns and
   * removes at session end). Everything else in the run dir goes when the child ends; absent = the whole dir goes.
   */
  keepFiles?: readonly string[];
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: BrowserChildError) => void;
  timer: NodeJS.Timeout;
}

export class BrowserChild {
  readonly runDir: string;
  /** Resolves once the child exited and its run dir is gone. */
  readonly closed: Promise<void>;
  state: "running" | "closing" | "closed" | "crashed" = "running";

  private readonly proc: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly opts: BrowserChildOptions) {
    this.runDir = sessionRunDir(opts.root, opts.sessionId);
    mkdirSync(join(opts.root, "run"), { recursive: true, mode: 0o700 });
    mkdirSync(this.runDir, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by the umask, and an existing dir keeps its mode.
    chmodSync(this.runDir, 0o700);
    const entry = opts.entry ?? (process.argv[1] ? [process.argv[1]] : []);
    this.proc = spawn(process.execPath, [...entry, "browser-agent"], {
      env: childEnv(opts.env ?? process.env, {
        runDir: this.runDir,
        executablePath: opts.executablePath,
        sandbox: opts.sandbox,
      }),
      cwd: this.runDir,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
      windowsHide: true,
    });
    this.proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    // Fixed diagnostic names only; drained so the child never blocks on a full pipe.
    this.proc.stderr?.resume();
    this.proc.stdin?.on("error", () => {});
    this.closed = new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        void this.onExit().finally(resolve);
      };
      this.proc.once("exit", finish);
      this.proc.once("error", finish);
    });
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  /** One op; resolves with its result or rejects with a `BrowserChildError`. */
  call(
    op: AgentOp,
    input: Readonly<Record<string, unknown>>,
    timeoutMs = callTimeoutMs(op),
  ): Promise<unknown> {
    if (this.state !== "running" || !this.proc.stdin?.writable)
      return Promise.reject(new BrowserChildError("browser_unavailable", UNAVAILABLE));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserChildError("timeout", TIMED_OUT));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin?.write(`${JSON.stringify({ ...input, id, op })}\n`);
    });
  }

  /** Ends the child: stdin closed (the agent closes Chromium), SIGTERM after 3 s, SIGKILL after 6 s; run dir removed. */
  async close(): Promise<void> {
    if (this.state === "running") {
      this.state = "closing";
      this.proc.stdin?.end();
      const term = setTimeout(() => this.proc.kill("SIGTERM"), CLOSE_TERM_MS);
      const kill = setTimeout(() => this.proc.kill("SIGKILL"), CLOSE_KILL_MS);
      await this.closed;
      clearTimeout(term);
      clearTimeout(kill);
    }
    await this.closed;
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      let header: ReturnType<typeof decodeFrameHeader>;
      try {
        header = decodeFrameHeader(this.buf);
      } catch {
        // An unknown type or an oversize frame: the stream cannot be trusted any more.
        this.buf = Buffer.alloc(0);
        this.proc.kill("SIGKILL");
        return;
      }
      if (!header || this.buf.length < FRAME_HEADER_BYTES + header.length) return;
      const payload = this.buf.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + header.length);
      this.buf = this.buf.subarray(FRAME_HEADER_BYTES + header.length);
      if (header.type === FRAME_TYPES.jpeg) this.opts.onFrame?.(new Uint8Array(payload));
      else this.onControl(payload);
    }
  }

  private onControl(payload: Buffer): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg.event === "string") {
      this.opts.onEvent?.(msg as BrowserChildEvent);
      return;
    }
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok === true) p.resolve(msg.result);
    else {
      const error = (msg.error ?? {}) as { code?: unknown; message?: unknown };
      p.reject(
        new BrowserChildError(
          (typeof error.code === "string" ? error.code : "browser_unavailable") as AgentErrorCode,
          typeof error.message === "string" ? error.message.slice(0, 200) : UNAVAILABLE,
        ),
      );
    }
  }

  private async onExit(): Promise<void> {
    const crashed = this.state === "running";
    this.state = crashed ? "crashed" : "closed";
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new BrowserChildError("browser_unavailable", UNAVAILABLE));
    }
    if (crashed) this.opts.onEvent?.({ event: "crashed", scope: "process" });
    await this.removeRunDir();
  }

  /** Chromium may still be leaving after a crash: remove, then once more a moment later for what it wrote last. */
  private async removeRunDir(): Promise<void> {
    const keep = this.opts.keepFiles ?? [];
    const remove = async () => {
      if (keep.length === 0) {
        await rm(this.runDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
        return;
      }
      const names = await readdir(this.runDir).catch(() => [] as string[]);
      await Promise.all(
        names
          .filter((n) => !keep.includes(n))
          .map((n) =>
            rm(join(this.runDir, n), { recursive: true, force: true, maxRetries: 3 }).catch(() => {}),
          ),
      );
    };
    await remove();
    setTimeout(() => void remove(), 2_000).unref();
  }
}
