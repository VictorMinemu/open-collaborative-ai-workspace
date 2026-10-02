import WebSocket from "ws";
import { type AgentChannelClientFrame, AgentChannelServerFrame } from "./agent-channel-protocol.js";
import { backoffDelayMs, sleep } from "./backoff.js";
import type { CursorStore } from "./cursor-store.js";

export type DurableFrame = { type: string; seq: number; data: unknown };

export type EventStreamLogger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
};

export type EventStreamOptions = {
  /** `ws(s)://…/agent-channel/v1/ws` */
  wsUrl: () => string;
  authHeader: () => string;
  /** `cell:<cellId>` (from GET /cell). */
  topic: string;
  cursor: CursorStore;
  /**
   * Returns the live baseline (`GET /cell` → lastSeq). Used when no cursor was persisted (start live,
   * never re-answer old mentions) and after a server `resync` (gap too large to replay).
   */
  baseline: () => Promise<number>;
  /** Handles one durable event. Business failures must not throw; a throw is logged and the event committed. */
  onEvent: (frame: DurableFrame) => Promise<void>;
  signal: AbortSignal;
  log?: EventStreamLogger;
  onStatus?: (status: { connected: boolean; lastError?: string; lastSeq: number }) => void;
  /** Max events processed concurrently (OpenClaw still serialises per session lane). Default 8. */
  concurrency?: number;
  backoff?: { baseMs?: number; maxMs?: number };
  /** App-level `{op:"ping"}` + ws ping interval; the socket is dropped when nothing comes back. Default 25 s. */
  heartbeatMs?: number;
};

/**
 * Tracks in-flight seqs so the persisted cursor only moves past contiguous completed events.
 * Out-of-order completion never skips an unfinished event on replay.
 */
export class CommitTracker {
  private readonly pending = new Set<number>();
  private maxSeen: number;
  constructor(private committed: number) {
    this.maxSeen = committed;
  }
  get cursor(): number {
    return this.committed;
  }
  isKnown(seq: number): boolean {
    return seq <= this.maxSeen || this.pending.has(seq);
  }
  begin(seq: number): void {
    this.pending.add(seq);
    if (seq > this.maxSeen) this.maxSeen = seq;
  }
  /** Returns the new committable cursor. */
  complete(seq: number): number {
    this.pending.delete(seq);
    const lowestPending = this.pending.size === 0 ? Number.POSITIVE_INFINITY : Math.min(...this.pending);
    const next = Math.min(this.maxSeen, lowestPending - 1);
    if (next > this.committed) this.committed = next;
    return this.committed;
  }
}

function send(socket: WebSocket, frame: AgentChannelClientFrame): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

/**
 * Long-lived outbound WebSocket to the Agent Channel API: subscribe to the cell topic with the
 * persisted cursor (exactly-once replay), process events concurrently, commit contiguously,
 * reconnect with jittered backoff. Resolves only when `signal` aborts.
 */
export async function runEventStream(opts: EventStreamOptions): Promise<void> {
  const log = opts.log ?? {};
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const heartbeatMs = opts.heartbeatMs ?? 25_000;
  const persisted = await opts.cursor.load(opts.topic);
  let tracker = new CommitTracker(persisted ?? (await opts.baseline()));
  if (persisted === null) log.info?.(`no cursor for ${opts.topic}; starting live at seq ${tracker.cursor}`);
  const inflight = new Set<Promise<void>>();
  let attempt = 0;

  while (!opts.signal.aborted) {
    let opened = false;
    let lastError: string | undefined;
    let resync = false;

    await new Promise<void>((resolve) => {
      let settled = false;
      let alive = true;
      let queue: Promise<void> = Promise.resolve();
      const socket = new WebSocket(opts.wsUrl(), {
        headers: { authorization: opts.authHeader() },
        handshakeTimeout: 15_000,
      });
      const heartbeat = setInterval(() => {
        if (!alive) {
          lastError = "heartbeat timeout";
          socket.terminate();
          return;
        }
        alive = false;
        try {
          socket.ping();
          send(socket, { op: "ping" });
        } catch {
          /* not open yet */
        }
      }, heartbeatMs);

      const finish = () => {
        if (settled) return;
        settled = true;
        clearInterval(heartbeat);
        opts.signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        socket.close(1000, "shutdown");
        finish();
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });

      socket.on("open", () => {
        opened = true;
        attempt = 0;
        send(socket, { op: "sub", topic: opts.topic, afterSeq: tracker.cursor });
        log.info?.(`agent channel connected (${opts.topic}, afterSeq=${tracker.cursor})`);
        opts.onStatus?.({ connected: true, lastSeq: tracker.cursor });
      });
      socket.on("pong", () => {
        alive = true;
      });
      socket.on("message", (raw) => {
        alive = true;
        let json: unknown;
        try {
          json = JSON.parse(raw.toString());
        } catch {
          log.warn?.("skipped malformed agent channel frame");
          return;
        }
        const parsed = AgentChannelServerFrame.safeParse(json);
        if (!parsed.success) return;
        const frame = parsed.data;
        switch (frame.op) {
          case "ev": {
            if (frame.topic !== opts.topic) return;
            const current = tracker;
            if (current.isKnown(frame.seq)) return; // replay overlap / duplicate delivery
            current.begin(frame.seq);
            const durable: DurableFrame = { type: frame.type, seq: frame.seq, data: frame.data };
            // Admission is ordered; execution is concurrent up to `concurrency`.
            queue = queue.then(async () => {
              while (inflight.size >= concurrency) await Promise.race(inflight);
              const task = (async () => {
                try {
                  await opts.onEvent(durable);
                } catch (error) {
                  log.error?.(
                    `event seq=${durable.seq} type=${durable.type} failed: ${error instanceof Error ? error.message : String(error)}`,
                  );
                }
                // The account is stopping (e.g. OpenClaw replaced the plugin instance): leave the
                // event uncommitted so the successor instance replays it from the cursor.
                if (!opts.signal.aborted) {
                  const cursor = current.complete(durable.seq);
                  if (current === tracker) {
                    await opts.cursor.save(opts.topic, cursor).catch((error: unknown) => {
                      log.warn?.(
                        `cursor save failed: ${error instanceof Error ? error.message : String(error)}`,
                      );
                    });
                  }
                }
              })();
              inflight.add(task);
              void task.finally(() => inflight.delete(task));
            });
            return;
          }
          case "subscribed":
            log.info?.(`subscribed to ${frame.topic} (server lastSeq=${frame.lastSeq ?? "?"})`);
            return;
          case "resync":
            log.warn?.(`server requested resync of ${frame.topic} (gap too large); re-baselining`);
            resync = true;
            socket.close(4000, "resync");
            return;
          case "err":
            lastError = `${frame.code}${frame.message ? `: ${frame.message}` : ""}`;
            log.error?.(`agent channel error: ${lastError}`);
            if (frame.code === "forbidden" || frame.code === "subscribe_failed")
              socket.close(4001, frame.code);
            return;
          default:
            return;
        }
      });
      socket.on("unexpected-response", (_req, res) => {
        lastError = `handshake rejected: HTTP ${res.statusCode}`;
        log.warn?.(`agent channel ${lastError}`);
        res.resume();
        socket.terminate();
      });
      socket.on("error", (error) => {
        lastError = error.message;
        if (!settled && !opts.signal.aborted) log.warn?.(`agent channel socket error: ${error.message}`);
      });
      socket.on("close", () => {
        if (!opts.signal.aborted) opts.onStatus?.({ connected: false, lastError, lastSeq: tracker.cursor });
        finish();
      });
    });

    if (opts.signal.aborted) break;
    if (resync) {
      try {
        const base = await opts.baseline();
        tracker = new CommitTracker(base);
        await opts.cursor.save(opts.topic, base);
        continue; // resubscribe immediately from the new baseline
      } catch (error) {
        lastError = `resync baseline failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const delay = backoffDelayMs(opened ? 0 : attempt, opts.backoff);
    attempt = opened ? 1 : attempt + 1;
    log.info?.(`agent channel reconnecting in ${delay} ms${lastError ? ` (${lastError})` : ""}`);
    try {
      await sleep(delay, opts.signal);
    } catch {
      break;
    }
  }
  // Let in-flight replies finish posting before the account stops.
  await Promise.allSettled([...inflight]);
}
