// Live frames of a session's browser page (07.13 D-15, PD-12, A-7). The page streams only while the API says someone
// watches: `browser.frames { on: true }` (re-sent every `watchPingMs` while viewers are connected) starts it and keeps
// it, `on: false` or `watchLapseMs` without a ping stops it. Each JPEG leaves as one Device Link binary message
// (`encodeWorkBrowserFrame`) through `link.sendBinary`, or not at all:
//
// - a frame over `WORK_BROWSER_FRAME_MAX_BYTES` (256 KiB, the API's inbound limit) is dropped, never split;
// - a frame the link cannot send now (not connected) is dropped and the stream stops: nothing is queued for later, and
//   the API's next ping after a reconnect starts it again;
// - frame bytes are never logged or persisted (only counters exist, for tests and status).
//
// Between the browser child and the daemon a frame is `FRAME_TYPES.jpeg` whose payload is a fixed 4-byte header
// (width, height: uint16 big endian) followed by the JPEG (`encodeChildJpeg` in the agent, `decodeChildJpeg` here). No
// value import from `agent/ops.ts` here: the daemon must not load playwright-core.

import { encodeWorkBrowserFrame, WORK_BROWSER_LIMITS } from "@ocw/contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The child payload's header: width and height, uint16 big endian each. */
export const CHILD_JPEG_HEADER_BYTES = 4;

const validSize = (n: number): boolean => Number.isInteger(n) && n > 0 && n <= 0xffff;

/** The agent's side: one screencast JPEG with its size, as the payload of a `FRAME_TYPES.jpeg` frame. */
export function encodeChildJpeg(jpeg: Uint8Array, size: { width: number; height: number }): Uint8Array {
  const out = new Uint8Array(CHILD_JPEG_HEADER_BYTES + jpeg.length);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint16(0, Math.max(0, Math.min(0xffff, Math.round(size.width))), false);
  view.setUint16(2, Math.max(0, Math.min(0xffff, Math.round(size.height))), false);
  out.set(jpeg, CHILD_JPEG_HEADER_BYTES);
  return out;
}

/** The daemon's side: null for a short payload, an empty image or a zero size. */
export function decodeChildJpeg(
  payload: Uint8Array,
): { width: number; height: number; jpeg: Uint8Array } | null {
  if (payload.length <= CHILD_JPEG_HEADER_BYTES) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const width = view.getUint16(0, false);
  const height = view.getUint16(2, false);
  if (!validSize(width) || !validSize(height)) return null;
  return { width, height, jpeg: payload.subarray(CHILD_JPEG_HEADER_BYTES) };
}

/** Timers of the watch lapse (a fake one in tests). */
export interface LiveClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: LiveClock = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface LiveFramesOptions {
  /** The Device Link's binary send (07.13-12): false when not connected or over the cap, never queued. */
  link: { sendBinary(bytes: Uint8Array): boolean };
  /** Turns the session's screencast on or off in its browser child (the manager; a no-op without a page). */
  control: (sessionId: string, on: boolean) => void;
  clock?: LiveClock;
  /** Default `WORK_BROWSER_LIMITS.watchLapseMs`. */
  lapseMs?: number;
}

export interface LiveFrameCounters {
  sent: number;
  /** Over `WORK_BROWSER_FRAME_MAX_BYTES` with the header. */
  oversize: number;
  /** The link was not open. */
  linkDown: number;
  /** A frame arrived for a session nobody watches (a late frame after a stop). */
  unwatched: number;
  malformed: number;
}

/** Per session: is someone watching, and when does that lapse. One per daemon (the manager owns it). */
export class LiveFrames {
  readonly counters: LiveFrameCounters = {
    sent: 0,
    oversize: 0,
    linkDown: 0,
    unwatched: 0,
    malformed: 0,
  };
  private readonly watched = new Map<string, unknown>();
  private readonly clock: LiveClock;
  private readonly lapseMs: number;

  constructor(private readonly opts: LiveFramesOptions) {
    this.clock = opts.clock ?? realClock;
    this.lapseMs = opts.lapseMs ?? WORK_BROWSER_LIMITS.watchLapseMs;
  }

  /** Someone watches the session (`browser.frames { on: true }`): starts the stream if needed and re-arms the lapse. */
  ping(sessionId: string): boolean {
    if (!UUID.test(sessionId)) return false;
    const timer = this.watched.get(sessionId);
    const started = timer === undefined;
    if (!started) this.clock.clearTimeout(timer);
    this.watched.set(
      sessionId,
      this.clock.setTimeout(() => {
        if (this.watched.has(sessionId)) this.stop(sessionId);
      }, this.lapseMs),
    );
    if (started) this.opts.control(sessionId, true);
    return started;
  }

  /** Nobody watches any more (`on: false`, the lapse, the link, the session's end). */
  stop(sessionId: string): void {
    const timer = this.watched.get(sessionId);
    if (timer === undefined) return;
    this.clock.clearTimeout(timer);
    this.watched.delete(sessionId);
    this.opts.control(sessionId, false);
  }

  watching(sessionId: string): boolean {
    return this.watched.has(sessionId);
  }

  /** One JPEG from the session's child: sent now as one binary frame, or dropped. */
  onJpeg(sessionId: string, payload: Uint8Array): void {
    if (!this.watched.has(sessionId)) {
      this.counters.unwatched++;
      return;
    }
    const decoded = decodeChildJpeg(payload);
    if (!decoded) {
      this.counters.malformed++;
      return;
    }
    const bytes = encodeWorkBrowserFrame({ sessionId, ...decoded });
    if (!bytes) {
      this.counters.oversize++;
      return;
    }
    if (!this.opts.link.sendBinary(bytes)) {
      // Not connected: nothing waits for the link; the API pings again after a reconnect.
      this.counters.linkDown++;
      this.stop(sessionId);
      return;
    }
    this.counters.sent++;
  }

  /** Daemon stop. */
  stopAll(): void {
    for (const id of [...this.watched.keys()]) this.stop(id);
  }
}
