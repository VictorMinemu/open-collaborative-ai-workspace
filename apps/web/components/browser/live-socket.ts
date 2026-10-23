"use client";

import { type LiveClientFrame, LiveServerFrame, WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import { getAccessToken } from "@/lib/auth-token";
import { getRuntimeConfig } from "@/lib/config";

/**
 * The live-view socket of one browser context (07.8-22; P-08): `GET /api/v1/live/browser/:contextId` on the API's own
 * origin, authenticated exactly like the realtime socket (the short-lived access JWT as the `ocw.auth.<jwt>`
 * subprotocol, never in the URL). Text messages are `LiveServerFrame`s (parsed with the contract; anything else is
 * dropped); binary messages are JPEG frames, handed on as Blobs and never kept here.
 *
 * Reconnects with full-jitter backoff after a drop. A socket the browser does not report dead (a sleeping laptop, a
 * proxy that stopped forwarding) is caught by silence: the server sends every viewer its state at least every 10 s
 * (its heartbeat), so four 5-second checks without any message close it and reconnect. The checks count messages, not
 * clock time, so a jumping clock never kills a healthy socket. Close codes: 1000 after `ended` and 4403 after
 * `no_permission` are final (no reconnect); 4401 refreshes the token once.
 *
 * Nothing here logs: not a frame, not an input frame, not an error's message (P-10, Semgrep `ocw.live-input-logging`).
 */

export type LiveSocketStatus = "connecting" | "open" | "reconnecting" | "error" | "closed";

export interface LiveSocketHandlers {
  onServer(frame: LiveServerFrame): void;
  onFrame(jpeg: Blob): void;
  onStatus(status: LiveSocketStatus): void;
}

interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface LiveSocketOptions {
  /** `wss://…/api/v1/live/browser/<id>`; default from the runtime config. */
  url?: string;
  getToken?: (opts: { force?: boolean }) => Promise<string>;
  WebSocketCtor?: new (url: string, protocols: string[]) => SocketLike;
  /** Silence checks (default every 5 s, 4 empty checks = dead). */
  checkMs?: number;
  quietChecks?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Attempts before a never-opened socket shows `error` (default 3), and after a drop (default 6). */
  firstAttempts?: number;
  dropAttempts?: number;
  random?: () => number;
}

export interface LiveConnection {
  send(frame: LiveClientFrame): boolean;
  close(): void;
}

const OPEN = 1;
const FINAL_CLOSE = new Set([1000, 4403]);

export function liveSocketUrl(contextId: string, apiUrl = getRuntimeConfig().apiUrl): string {
  return `${apiUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/api/v1/live/browser/${encodeURIComponent(contextId)}`;
}

export function connectLive(
  contextId: string,
  handlers: LiveSocketHandlers,
  options: LiveSocketOptions = {},
): LiveConnection {
  const url = options.url ?? liveSocketUrl(contextId);
  const getToken = options.getToken ?? getAccessToken;
  const Ctor =
    options.WebSocketCtor ?? (WebSocket as unknown as NonNullable<LiveSocketOptions["WebSocketCtor"]>);
  const checkMs = options.checkMs ?? 5_000;
  const quietChecks = options.quietChecks ?? 4;
  const base = options.backoffBaseMs ?? 1_000;
  const max = options.backoffMaxMs ?? 10_000;
  const firstAttempts = options.firstAttempts ?? 3;
  const dropAttempts = options.dropAttempts ?? 6;
  const random = options.random ?? Math.random;

  let ws: SocketLike | null = null;
  let stopped = false;
  let final = false;
  let everOpened = false;
  let attempt = 0;
  let authRetried = false;
  let received = 0;
  let quiet = 0;
  let checker: ReturnType<typeof setInterval> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = () => {
    if (checker) clearInterval(checker);
    if (retry) clearTimeout(retry);
    checker = null;
    retry = null;
  };

  const fail = () => {
    stopped = true;
    clearTimers();
    handlers.onStatus("error");
  };

  const scheduleRetry = () => {
    attempt++;
    if (attempt >= (everOpened ? dropAttempts : firstAttempts)) {
      fail();
      return;
    }
    handlers.onStatus(everOpened ? "reconnecting" : "connecting");
    const delay = Math.floor(random() * Math.min(max, base * 2 ** (attempt - 1)));
    retry = setTimeout(() => {
      retry = null;
      if (!stopped) open(false);
    }, delay);
  };

  const open = (force: boolean) => {
    getToken({ force }).then(
      (token) => {
        if (stopped) return;
        let socket: SocketLike;
        try {
          socket = new Ctor(url, [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${token}`]);
        } catch {
          scheduleRetry();
          return;
        }
        ws = socket;
        socket.binaryType = "blob";
        socket.onopen = () => {
          if (ws !== socket) return;
          everOpened = true;
          attempt = 0;
          received = 0;
          quiet = 0;
          handlers.onStatus("open");
          checker = setInterval(() => {
            if (received === 0) quiet++;
            else quiet = 0;
            received = 0;
            // Silent for too long: the browser never said so, but nothing arrives. Close and start again.
            if (quiet >= quietChecks && ws === socket) {
              ws = null;
              socket.onclose = null;
              socket.close();
              clearTimers();
              scheduleRetry();
            }
          }, checkMs);
        };
        socket.onmessage = (ev) => {
          if (ws !== socket) return;
          received++;
          const data = ev.data;
          if (typeof data === "string") {
            let parsed: ReturnType<typeof LiveServerFrame.safeParse>;
            try {
              parsed = LiveServerFrame.safeParse(JSON.parse(data));
            } catch {
              return;
            }
            if (!parsed.success) return;
            const frame = parsed.data;
            if (frame.type === "state" && (frame.state === "ended" || frame.state === "no_permission"))
              final = true;
            handlers.onServer(frame);
          } else if (data instanceof Blob) {
            handlers.onFrame(data);
          }
        };
        socket.onerror = () => {};
        socket.onclose = (ev) => {
          if (ws !== socket) return;
          ws = null;
          clearTimers();
          if (stopped) return;
          if (final || FINAL_CLOSE.has(ev.code)) {
            stopped = true;
            // The state frame before the close says why; a bare final close is an error.
            handlers.onStatus(final ? "closed" : "error");
            return;
          }
          if (ev.code === 4401 && !authRetried) {
            authRetried = true;
            open(true);
            return;
          }
          scheduleRetry();
        };
      },
      (err: unknown) => {
        if (stopped) return;
        if ((err as { status?: unknown } | null)?.status === 401) {
          fail();
          return;
        }
        scheduleRetry();
      },
    );
  };

  handlers.onStatus("connecting");
  open(false);

  return {
    send(frame) {
      const socket = ws;
      if (!socket || socket.readyState !== OPEN) return false;
      socket.send(JSON.stringify(frame));
      return true;
    },
    close() {
      stopped = true;
      clearTimers();
      const socket = ws;
      ws = null;
      if (socket) {
        socket.onclose = null;
        socket.onmessage = null;
        socket.close(1000);
      }
    },
  };
}
