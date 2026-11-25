import { WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL, workLivePath } from "@ocw/contracts";
import WebSocket from "ws";
import { WEB_ORIGIN } from "../../testing";

/**
 * Test helpers of the Work Zone live view (07.13-10): an authenticated socket on `/api/v1/live/work-browser/:sessionId`
 * that records every frame, and the bare upgrade status of a refused one. Test-only (never imported by the module).
 */

export type Json = Record<string, unknown>;

export interface WorkLiveSocket {
  socket: WebSocket;
  /** JSON control frames in arrival order. */
  json: Json[];
  /** Binary frames, whole (test JPEGs are small). */
  binary: Buffer[];
  closed: Promise<{ code: number }>;
  close(): void;
}

export const workLiveUrl = (baseUrl: string, sessionId: string) =>
  `${baseUrl.replace(/^http/, "ws")}${workLivePath(sessionId)}`;

export async function workLiveSocket(
  baseUrl: string,
  token: string,
  sessionId: string,
): Promise<WorkLiveSocket> {
  const socket = new WebSocket(
    workLiveUrl(baseUrl, sessionId),
    [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${token}`],
    { headers: { origin: WEB_ORIGIN } },
  );
  const json: Json[] = [];
  const binary: Buffer[] = [];
  socket.on("message", (data, isBinary) => {
    const buf = data as Buffer;
    if (isBinary) binary.push(Buffer.from(buf));
    else json.push(JSON.parse(buf.toString("utf8")) as Json);
  });
  const closed = new Promise<{ code: number }>((resolve) => socket.on("close", (code) => resolve({ code })));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, json, binary, closed, close: () => socket.close() };
}

/** The HTTP status of an upgrade (101 when it opened). */
export async function upgradeStatus(url: string, opts: { origin?: string | null; token?: string | null }) {
  const protocols = [WS_PROTOCOL, ...(opts.token ? [`${WS_AUTH_PROTOCOL_PREFIX}${opts.token}`] : [])];
  const socket = new WebSocket(url, protocols, {
    headers: opts.origin === null ? {} : { origin: opts.origin ?? WEB_ORIGIN },
  });
  return new Promise<number>((resolve) => {
    socket.once("open", () => {
      socket.close();
      resolve(101);
    });
    socket.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      socket.terminate();
    });
    socket.once("error", () => resolve(0));
  });
}

/** The last `state` frame the socket received. */
export const lastState = (s: WorkLiveSocket): Json | undefined =>
  [...s.json].reverse().find((f) => f.type === "state");

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 6000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Waits for the socket's latest state to be `state` and returns it. */
export const waitState = (s: WorkLiveSocket, state: string, timeoutMs?: number) =>
  waitFor(() => {
    const last = lastState(s);
    return last?.state === state ? last : undefined;
  }, timeoutMs);

/** A fake JPEG: the SOI marker, then `tag` repeated (distinct per frame, so a test tells frames apart). */
export const fakeJpeg = (tag: number, size = 512): Uint8Array => {
  const out = new Uint8Array(size).fill(tag & 0xff);
  out.set([0xff, 0xd8, 0xff], 0);
  return out;
};
