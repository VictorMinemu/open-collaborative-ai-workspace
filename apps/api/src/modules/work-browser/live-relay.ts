import { WORK_BROWSER_FRAME_MAX_BYTES, WORK_BROWSER_LIMITS } from "@ocw/contracts";
import type { FastifyBaseLogger } from "fastify";

/**
 * Cross-instance transit of Work Zone live frames (07.13-10; D-33, PD-12).
 *
 * The device's frames arrive on the API instance holding its Device Link; a viewer may be on another instance. Each
 * instance with viewers of a session announces `{ i: <instanceId> }` on `ocw:wb:watch:<sessionId>` with every ping; the
 * instance holding the link follows that channel while it receives the session's frames (and while it has viewers of
 * its own) and publishes each frame on `ocw:wb:frames:<sessionId>` as `{ i, w, h, b64 }` ONLY when another instance
 * announced within `WORK_BROWSER_LIMITS.watchLapseMs`. Instances with viewers subscribe to the frames channel while
 * they have them; a frame an instance published itself is ignored there (its own viewers got it directly).
 *
 * This is a deliberate, transit-only exception to the bots' rule that nothing typed or seen reaches Redis (D-33,
 * recorded in ADR-0035): frames are never persisted, never logged (log lines carry ids and error names only), never
 * put in a span, and nothing is published while nobody elsewhere watches. Messages from the bus are untrusted input:
 * parsed, bounded and dropped silently when malformed.
 */

export const watchChannel = (sessionId: string) => `ocw:wb:watch:${sessionId.toLowerCase()}`;
export const framesChannel = (sessionId: string) => `ocw:wb:frames:${sessionId.toLowerCase()}`;

/** The pub/sub the relay needs (`RedisBus`). */
export interface LiveRelayBus {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, listener: (message: string) => void): Promise<() => Promise<void>>;
}

export interface RelayFrame {
  width: number;
  height: number;
  jpeg: Uint8Array;
}

export interface LiveRelay {
  readonly instanceId: string;
  /** This instance watches `sessionId` now (sent with every ping while it has viewers). */
  announceWatch(sessionId: string): Promise<void>;
  /** Follows the session's watch channel until the returned release (this instance has viewers of it). */
  hold(sessionId: string): () => void;
  /** Follows the session's watch channel for one more lapse (this instance just received one of its frames). */
  touch(sessionId: string): void;
  /** Another instance announced a watch of `sessionId` within the lapse (seen only while followed). */
  remoteWatching(sessionId: string): boolean;
  /** Publishes the frame when another instance watches; true when it was published. */
  publishFrame(sessionId: string, frame: RelayFrame): Promise<boolean>;
  /** The frames other instances publish for `sessionId`, until the returned stop. */
  subscribeFrames(sessionId: string, cb: (frame: RelayFrame) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

interface Follow {
  holds: number;
  /** Followed at least until then (the link holder's frames). */
  until: number;
  /** The last announcement of another instance (ms). */
  lastRemote: number;
  stop: Promise<(() => Promise<void>) | null>;
}

const U16_MAX = 0xffff;
/** The longest base64 a valid frame can have (4 characters per 3 bytes). */
const B64_MAX = Math.ceil(WORK_BROWSER_FRAME_MAX_BYTES / 3) * 4;

const name = (err: unknown) => (err as Error | undefined)?.name ?? "Error";
const validSize = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= U16_MAX;

function parse(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function createLiveRelay(opts: {
  bus: LiveRelayBus;
  instanceId: string;
  lapseMs?: number;
  log?: FastifyBaseLogger;
}): LiveRelay {
  const { bus, instanceId, log } = opts;
  const lapseMs = opts.lapseMs ?? WORK_BROWSER_LIMITS.watchLapseMs;
  const follows = new Map<string, Follow>();

  const warn = (sessionId: string, err: unknown, msg: string) =>
    log?.warn({ sessionId, error: name(err) }, msg);

  function follow(sessionId: string): Follow {
    const id = sessionId.toLowerCase();
    let f = follows.get(id);
    if (!f) {
      const created: Follow = { holds: 0, until: 0, lastRemote: 0, stop: Promise.resolve(null) };
      created.stop = bus
        .subscribe(watchChannel(id), (raw) => {
          const msg = parse(raw);
          if (!msg || typeof msg.i !== "string" || msg.i === instanceId) return;
          created.lastRemote = Date.now();
        })
        .catch((err: unknown) => {
          warn(id, err, "work live relay watch subscribe failed");
          if (follows.get(id) === created) follows.delete(id);
          return null;
        });
      follows.set(id, created);
      f = created;
    }
    return f;
  }

  function unfollow(id: string, f: Follow): void {
    if (follows.get(id) !== f) return;
    follows.delete(id);
    void f.stop.then((stop) => stop?.()).catch(() => {});
  }

  /** Drops the follows nobody holds and no frame touched within the lapse. */
  function sweep(now = Date.now()): void {
    for (const [id, f] of follows) if (f.holds === 0 && f.until < now) unfollow(id, f);
  }
  const sweeper = setInterval(sweep, Math.max(250, Math.min(lapseMs, 5_000)));
  sweeper.unref();

  function remoteWatching(sessionId: string): boolean {
    const f = follows.get(sessionId.toLowerCase());
    return !!f && Date.now() - f.lastRemote <= lapseMs;
  }

  return {
    instanceId,
    async announceWatch(sessionId) {
      await bus.publish(watchChannel(sessionId), JSON.stringify({ i: instanceId }));
    },
    hold(sessionId) {
      const f = follow(sessionId);
      f.holds++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        f.holds--;
        f.until = Math.max(f.until, Date.now() + lapseMs);
      };
    },
    touch(sessionId) {
      follow(sessionId).until = Date.now() + lapseMs;
    },
    remoteWatching,
    async publishFrame(sessionId, frame) {
      if (!remoteWatching(sessionId)) return false;
      const message = JSON.stringify({
        i: instanceId,
        w: frame.width,
        h: frame.height,
        b64: Buffer.from(frame.jpeg.buffer, frame.jpeg.byteOffset, frame.jpeg.byteLength).toString("base64"),
      });
      await bus.publish(framesChannel(sessionId), message);
      return true;
    },
    async subscribeFrames(sessionId, cb) {
      return bus.subscribe(framesChannel(sessionId), (raw) => {
        if (raw.length > B64_MAX + 256) return;
        const msg = parse(raw);
        if (!msg || typeof msg.i !== "string" || msg.i === instanceId) return;
        if (!validSize(msg.w) || !validSize(msg.h)) return;
        if (typeof msg.b64 !== "string" || msg.b64.length === 0 || msg.b64.length > B64_MAX) return;
        const jpeg = Buffer.from(msg.b64, "base64");
        if (jpeg.length === 0 || jpeg.length > WORK_BROWSER_FRAME_MAX_BYTES) return;
        cb({ width: msg.w, height: msg.h, jpeg });
      });
    },
    async close() {
      clearInterval(sweeper);
      const all = [...follows.values()];
      follows.clear();
      for (const f of all) await (await f.stop.catch(() => null))?.().catch(() => {});
    },
  };
}
