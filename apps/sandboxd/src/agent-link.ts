import type { Duplex } from "node:stream";
import { z } from "zod";
import { Demuxer, type Docker, DockerUnavailableError } from "./docker";

/**
 * sandboxd's side of the `brw` agent's stdio (07.8-07 protocol, 07.8-13). One link per `brw` container: sandboxd
 * attaches to the container's main process (the hijacked `POST /containers/{id}/attach`, multiplexed stdout and stderr,
 * no TTY) and is the only thing that ever speaks to the agent. There is no port to connect to.
 *
 *   stdin   JSON lines `{ id, op, ...input }`, each after a newline (an empty line is skipped by the agent).
 *   stdout  agent frames: 4-byte big-endian length, 1-byte type, payload. Type 0 is one screencast JPEG tagged with its
 *           context id (`[id length][id][JPEG]`), type 1 one JSON message (a response `{ id, ok, result | error }` or
 *           an event `{ event, contextId?, ... }`).
 *   stderr  the agent's structured diagnostics (`{ brw: 1, ev, t, ... }`, 07.8 hardening): each line is parsed against
 *           `AgentDiag` (fixed event, op, phase, posture and reason names, error codes and names, durations, context
 *           ids; nothing else, unknown keys refused) and only what passes reaches `onDiag`. Any other stderr text
 *           (Chromium's launch lines) is dropped, never logged.
 *
 * The link strips the context-id tag (callers get the bare JPEG per context) and never logs or keeps a request, a
 * response, an input payload or a frame.
 */

/** A JSON message (responses carry a download as base64: up to 50 MiB decoded, ~67 MiB of JSON). */
export const AGENT_JSON_MAX_BYTES = 80 * 1024 * 1024;
/** A screencast JPEG at 1280x800 is ~100 KiB; anything near this is not a frame. */
export const AGENT_JPEG_MAX_BYTES = 4 * 1024 * 1024;
const AGENT_FRAME_HEADER = 5;
export const AGENT_REQUEST_TIMEOUT_MS = 60_000;

/** A refusal the agent answered (`{ ok: false, error: { code, message } }`), or a link failure (`link_closed`, …). */
export class AgentError extends Error {
  override readonly name = "AgentError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type AgentOutput =
  | { type: "jpeg"; contextId: string; jpeg: Buffer }
  | { type: "json"; message: Record<string, unknown> };

/**
 * The agent's stdout framing, split across chunks anywhere. Throws on an unknown type, an oversized frame or a JSON
 * payload that is not an object (the link then closes: the agent's stream cannot be trusted any more).
 */
export class AgentOutputReader {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): AgentOutput[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const out: AgentOutput[] = [];
    let offset = 0;
    while (this.pending.length - offset >= AGENT_FRAME_HEADER) {
      const length = this.pending.readUInt32BE(offset);
      const type = this.pending[offset + 4] as number;
      if (type !== 0 && type !== 1) throw new AgentError("protocol", "unknown agent frame type");
      if (length > (type === 0 ? AGENT_JPEG_MAX_BYTES + 256 : AGENT_JSON_MAX_BYTES)) {
        throw new AgentError("protocol", "agent frame too large");
      }
      if (this.pending.length - offset - AGENT_FRAME_HEADER < length) break;
      const payload = this.pending.subarray(
        offset + AGENT_FRAME_HEADER,
        offset + AGENT_FRAME_HEADER + length,
      );
      offset += AGENT_FRAME_HEADER + length;
      if (type === 0) {
        const idLength = payload[0] ?? 0;
        if (idLength === 0 || payload.length < 1 + idLength)
          throw new AgentError("protocol", "untagged frame");
        out.push({
          type: "jpeg",
          contextId: payload.subarray(1, 1 + idLength).toString("ascii"),
          jpeg: Buffer.from(payload.subarray(1 + idLength)),
        });
      } else {
        let message: unknown;
        try {
          message = JSON.parse(payload.toString("utf8"));
        } catch {
          throw new AgentError("protocol", "agent message is not JSON");
        }
        if (typeof message !== "object" || message === null || Array.isArray(message)) {
          throw new AgentError("protocol", "agent message is not an object");
        }
        out.push({ type: "json", message: message as Record<string, unknown> });
      }
    }
    this.pending = offset === 0 ? this.pending : Buffer.from(this.pending.subarray(offset));
    return out;
  }
}

/** The agent's op names (agent.mjs `OPS`): the only `op` a diagnostic may name. */
export const AGENT_OPS = [
  "info",
  "contextOpen",
  "contextNavigate",
  "contextSnapshot",
  "contextAct",
  "contextScreenshot",
  "contextWait",
  "contextFrames",
  "contextTakeover",
  "contextInput",
  "contextResize",
  "contextHold",
  "contextLock",
  "contextExportState",
  "contextDownload",
  "contextClose",
] as const;

const Code = z.string().regex(/^[a-z_]{1,32}$/);
const Ms = z.number().int().min(0).max(86_400_000);

/**
 * One diagnostic line of the agent, as sandboxd accepts it: no free text anywhere (a URL, a host, page text, typed
 * input, a cookie or an error message cannot pass), so a forwarded line can only repeat names, codes, ids and numbers.
 */
export const AgentDiag = z
  .object({
    brw: z.literal(1),
    ev: z.enum([
      "start",
      "launched",
      "launch_failed",
      "sandbox_fallback",
      "ready",
      "stdin_first",
      "op_start",
      "op",
      "op_error",
      "open_phase",
      "crashed",
      "exit",
      "check_failed",
      "bad_line",
    ]),
    t: Ms,
    op: z.enum(AGENT_OPS).optional(),
    ctx: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      .optional(),
    ms: Ms.optional(),
    outcome: Code.optional(),
    code: Code.optional(),
    reason: Code.optional(),
    error: z
      .string()
      .regex(/^[A-Za-z]{1,40}$/)
      .optional(),
    phase: z.enum(["context", "page", "cdp"]).optional(),
    posture: z.enum(["chromium", "chromium+gvisor", "container-only"]).nullable().optional(),
    runtime: z.enum(["runsc", "runc"]).optional(),
    scope: z.enum(["browser", "page"]).optional(),
    bytes: z
      .number()
      .int()
      .min(0)
      .max(1 << 30)
      .optional(),
  })
  .strict();
export type AgentDiag = z.infer<typeof AgentDiag>;

/** A stderr line longer than this is not a diagnostic (and is dropped unread). */
const DIAG_LINE_MAX = 1024;

/**
 * The agent's stderr split into lines; returns the lines that parse as `AgentDiag`. Everything else, including an
 * overlong line, is dropped.
 */
export class AgentDiagReader {
  private pending = "";
  private skipping = false;

  push(chunk: Buffer): AgentDiag[] {
    const out: AgentDiag[] = [];
    let text = this.pending + chunk.toString("utf8");
    for (;;) {
      const nl = text.indexOf("\n");
      if (nl < 0) break;
      const line = text.slice(0, nl);
      text = text.slice(nl + 1);
      if (this.skipping) {
        this.skipping = false;
        continue;
      }
      const diag = parseDiag(line);
      if (diag) out.push(diag);
    }
    if (text.length > DIAG_LINE_MAX) {
      // An overlong line: dropped, and so is its rest up to the next newline.
      this.skipping = true;
      text = "";
    }
    this.pending = text;
    return out;
  }
}

function parseDiag(line: string): AgentDiag | null {
  if (line.length > DIAG_LINE_MAX || !line.startsWith("{")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = AgentDiag.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** What the agent says once Chromium is up (`ready`), or what `info` answers on a re-attach. */
export interface AgentReady {
  browserSandbox: string | null;
  runtime: string | null;
}

export interface AgentLink {
  /** One op; resolves with its `result` or rejects with an `AgentError` (the agent's code, or `link_closed`). */
  request(op: string, input: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  /** The agent's `ready` (fresh start) or its refusal (`fatal`, `link_closed`) within `timeoutMs`. */
  ready(timeoutMs: number): Promise<AgentReady>;
  /** Every JPEG frame, untagged (the context id is passed separately). */
  onFrame(listener: (contextId: string, jpeg: Buffer) => void): void;
  /** Every agent event except `ready` and `fatal`. */
  onEvent(listener: (event: Record<string, unknown>) => void): void;
  /** Every stderr diagnostic that passed `AgentDiag` (07.8 hardening). */
  onDiag(listener: (diag: AgentDiag) => void): void;
  onClose(listener: () => void): void;
  readonly closed: boolean;
  close(): void;
}

/**
 * A link over any duplex carrying the Docker multiplexed stream (the attach socket; tests pass a fake). Exported for
 * tests; `openAgentLink` is the production entry.
 */
export function linkOverStream(stream: Duplex): AgentLink {
  const demuxer = new Demuxer();
  const reader = new AgentOutputReader();
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const frameListeners: Array<(contextId: string, jpeg: Buffer) => void> = [];
  const eventListeners: Array<(event: Record<string, unknown>) => void> = [];
  const closeListeners: Array<() => void> = [];
  const diagListeners: Array<(diag: AgentDiag) => void> = [];
  const diagReader = new AgentDiagReader();
  let readyState: { ok: true; value: AgentReady } | { ok: false; error: AgentError } | null = null;
  const readyWaiters: Array<() => void> = [];
  let nextId = 1;
  let closed = false;

  const settleReady = (state: NonNullable<typeof readyState>) => {
    if (readyState) return;
    readyState = state;
    for (const w of readyWaiters.splice(0)) w();
  };

  function finish() {
    if (closed) return;
    closed = true;
    const gone = new AgentError("link_closed", "the browser is gone");
    for (const p of pending.values()) p.reject(gone);
    pending.clear();
    settleReady({ ok: false, error: gone });
    stream.destroy();
    for (const l of closeListeners) l();
  }

  function onMessage(message: Record<string, unknown>) {
    if (typeof message.event === "string") {
      if (message.event === "ready") {
        settleReady({
          ok: true,
          value: {
            browserSandbox: typeof message.browserSandbox === "string" ? message.browserSandbox : null,
            runtime: typeof message.runtime === "string" ? message.runtime : null,
          },
        });
        return;
      }
      if (message.event === "fatal") {
        settleReady({
          ok: false,
          error: new AgentError(String(message.code ?? "fatal"), "the browser did not start"),
        });
        return;
      }
      for (const l of eventListeners) l(message);
      return;
    }
    const id = typeof message.id === "number" ? message.id : null;
    const waiter = id === null ? undefined : pending.get(id);
    if (!waiter || id === null) return;
    pending.delete(id);
    if (message.ok === true) {
      waiter.resolve(message.result);
    } else {
      const error = (typeof message.error === "object" && message.error !== null ? message.error : {}) as {
        code?: unknown;
        message?: unknown;
      };
      waiter.reject(
        new AgentError(
          typeof error.code === "string" ? error.code.slice(0, 64) : "internal",
          typeof error.message === "string" ? error.message.slice(0, 200) : "the browser operation failed",
        ),
      );
    }
  }

  stream.on("data", (chunk: Buffer) => {
    if (closed) return;
    try {
      for (const frame of demuxer.push(chunk)) {
        if (frame.stream === 2) {
          // stderr: only allowlisted diagnostics go on; everything else is dropped, never logged.
          for (const diag of diagReader.push(frame.data)) {
            for (const l of diagListeners) {
              try {
                l(diag);
              } catch {
                // A diagnostic never breaks the link.
              }
            }
          }
          continue;
        }
        if (frame.stream !== 1) continue;
        for (const out of reader.push(frame.data)) {
          if (out.type === "jpeg") for (const l of frameListeners) l(out.contextId, out.jpeg);
          else onMessage(out.message);
        }
      }
    } catch {
      finish();
    }
  });
  stream.on("end", finish);
  stream.on("close", finish);
  stream.on("error", finish);

  return {
    get closed() {
      return closed;
    },

    request(op, input, timeoutMs = AGENT_REQUEST_TIMEOUT_MS) {
      if (closed) return Promise.reject(new AgentError("link_closed", "the browser is gone"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new AgentError("timeout", "the browser did not answer in time"));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        // The input is written once to the agent's stdin and kept nowhere else. The leading newline ends whatever
        // stray bytes reached the agent's stdin before this line (they become a line of their own, refused with no
        // id), so a request is never glued to them and left unanswered (07.8 hardening).
        stream.write(`\n${JSON.stringify({ ...input, id, op })}\n`);
      });
    },

    ready(timeoutMs) {
      return new Promise((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          const state = readyState;
          if (!state) return;
          if (state.ok) resolve(state.value);
          else reject(state.error);
        };
        const timer = setTimeout(() => {
          const i = readyWaiters.indexOf(done);
          if (i >= 0) readyWaiters.splice(i, 1);
          reject(new AgentError("timeout", "the browser did not start in time"));
        }, timeoutMs);
        timer.unref?.();
        if (readyState) done();
        else readyWaiters.push(done);
      });
    },

    onFrame(listener) {
      frameListeners.push(listener);
    },
    onEvent(listener) {
      eventListeners.push(listener);
    },
    onDiag(listener) {
      diagListeners.push(listener);
    },
    onClose(listener) {
      if (closed) listener();
      else closeListeners.push(listener);
    },
    close: finish,
  };
}

/** Attaches to the `brw` container's main process (stdin, stdout, stderr; before or after it starts). */
export async function openAgentLink(docker: Docker, containerId: string): Promise<AgentLink> {
  let stream: Duplex;
  try {
    // No request body: on an attach with stdin, the Engine could pass it on to the agent's stdin (see `hijack`).
    stream = await docker.hijack(
      `/containers/${encodeURIComponent(containerId)}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
      null,
    );
  } catch (err) {
    if (err instanceof DockerUnavailableError)
      throw new AgentError("link_closed", "cannot attach to the browser");
    throw err;
  }
  return linkOverStream(stream);
}
