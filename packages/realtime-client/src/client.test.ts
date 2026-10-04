import { afterEach, describe, expect, it, vi } from "vitest";
import { backoffDelay } from "./backoff";
import { RealtimeClient, type TopicFrame, type WebSocketLike } from "./client";

const T = "conv:0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e5f";

class FakeWS implements WebSocketLike {
  static last: FakeWS | null = null;
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  static all: FakeWS[] = [];
  constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    FakeWS.last = this;
    FakeWS.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const ev = (seq: number) => ({ op: "ev", topic: T, seq, type: "message.created", data: { seq } });

afterEach(() => {
  vi.useRealTimers();
  FakeWS.last = null;
  FakeWS.all = [];
});

/** Let pending promise callbacks (getToken) run. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("RealtimeClient", () => {
  it("subscribes with afterSeq, dedupes and delivers in order", () => {
    const c = new RealtimeClient({ url: "ws://x/ws", WebSocket: FakeWS });
    const got: TopicFrame[] = [];
    c.subscribe(T, (f) => got.push(f), { afterSeq: 5 });
    c.connect();
    const ws = FakeWS.last!;
    ws.open();
    expect(ws.sent).toContainEqual({ op: "sub", topic: T, afterSeq: 5 });
    ws.push(ev(5)); // duplicate of snapshot
    ws.push(ev(6));
    ws.push(ev(6)); // duplicate
    ws.push({ op: "eph", topic: T, type: "user.typing", data: {} });
    expect(got.map((f) => (f.op === "ev" ? f.seq : "eph"))).toEqual([6, "eph"]);
    expect(c.lastSeq(T)).toBe(6);
  });

  it("requests replay on gap and resumes after reconnect", () => {
    vi.useFakeTimers();
    const c = new RealtimeClient({ url: "ws://x/ws", WebSocket: FakeWS, backoffBaseMs: 10 });
    const seqs: number[] = [];
    c.subscribe(T, (f) => f.op === "ev" && seqs.push(f.seq));
    c.connect();
    let ws = FakeWS.last!;
    ws.open();
    ws.push(ev(1));
    ws.push(ev(3)); // gap → resubscribe from 1
    expect(ws.sent.at(-1)).toEqual({ op: "sub", topic: T, afterSeq: 1 });
    ws.push(ev(2));
    ws.push(ev(3));
    expect(seqs).toEqual([1, 2, 3]);

    ws.drop();
    expect(c.status.getState().status).toBe("reconnecting");
    vi.advanceTimersByTime(50);
    ws = FakeWS.last!;
    ws.open();
    expect(ws.sent).toContainEqual({ op: "sub", topic: T, afterSeq: 3 });
    expect(c.status.getState().status).toBe("open");
  });

  it("on 4401 with getToken forces one token refresh and reconnects; a second 4401 before subscribing stops", async () => {
    let n = 0;
    const getToken = vi.fn(async (_o: { force: boolean }) => `tok${++n}`);
    const c = new RealtimeClient({ url: "ws://x/ws", WebSocket: FakeWS, getToken });
    c.subscribe(T, () => {});
    c.connect();
    await flush();
    FakeWS.last!.open();
    FakeWS.last!.drop(4401);
    await flush();
    expect(getToken).toHaveBeenLastCalledWith({ force: true });
    expect(FakeWS.all).toHaveLength(2);
    expect(FakeWS.last!.protocols).toEqual(["ocw.v1", "ocw.auth.tok2"]);
    expect(c.status.getState().status).not.toBe("closed");

    FakeWS.last!.open();
    FakeWS.last!.drop(4401); // still refused: give up and let the app re-authenticate
    await flush();
    expect(c.status.getState().status).toBe("closed");
    expect(FakeWS.all).toHaveLength(2);
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it("a successful subscribe re-arms the one-shot 4401 refresh", async () => {
    const getToken = vi.fn(async (_o: { force: boolean }) => "tok");
    const c = new RealtimeClient({ url: "ws://x/ws", WebSocket: FakeWS, getToken });
    c.subscribe(T, () => {});
    c.connect();
    await flush();
    for (let i = 0; i < 3; i++) {
      FakeWS.last!.open();
      FakeWS.last!.push({ op: "subscribed", topic: T, lastSeq: 0 });
      FakeWS.last!.drop(4401);
      await flush();
    }
    expect(FakeWS.all).toHaveLength(4);
    expect(c.status.getState().status).not.toBe("closed");
  });

  it("on 4401 a forced refresh rejected with 401 (signed out) stops the client", async () => {
    const getToken = vi
      .fn<(o: { force: boolean }) => Promise<string>>()
      .mockResolvedValueOnce("tok")
      .mockRejectedValueOnce(Object.assign(new Error("signed out"), { status: 401 }));
    const c = new RealtimeClient({ url: "ws://x/ws", WebSocket: FakeWS, getToken });
    c.connect();
    await flush();
    FakeWS.last!.open();
    FakeWS.last!.drop(4401);
    await flush();
    expect(getToken).toHaveBeenLastCalledWith({ force: true });
    expect(c.status.getState().status).toBe("closed");
    expect(FakeWS.all).toHaveLength(1);
  });

  it("stops on 4401 (client without getToken)", () => {
    const c = new RealtimeClient({ url: "ws://x/ws", WebSocket: FakeWS });
    c.connect();
    FakeWS.last!.open();
    FakeWS.last!.drop(4401);
    expect(c.status.getState().status).toBe("closed");
  });

  it("without getToken connects with no subprotocols (unchanged behaviour)", () => {
    const c = new RealtimeClient({ url: "ws://x/ws", WebSocket: FakeWS });
    c.connect();
    expect(FakeWS.last!.protocols).toBeUndefined();
  });

  it("with getToken offers [ocw.v1, ocw.auth.<token>] and fetches a token before every (re)connect", async () => {
    vi.useFakeTimers();
    let n = 0;
    const getToken = vi.fn(async (_o: { force: boolean }) => `tok${++n}`);
    const c = new RealtimeClient({ url: "ws://x/ws", WebSocket: FakeWS, getToken, backoffBaseMs: 10 });
    c.subscribe(T, () => {});
    c.connect();
    expect(FakeWS.last).toBeNull(); // the socket waits for the token
    await flush();
    let ws = FakeWS.last!;
    expect(ws.url).toBe("ws://x/ws");
    expect(ws.protocols).toEqual(["ocw.v1", "ocw.auth.tok1"]);
    expect(getToken).toHaveBeenLastCalledWith({ force: false });
    ws.open();
    expect(ws.sent).toContainEqual({ op: "sub", topic: T, afterSeq: 0 });

    ws.drop();
    vi.advanceTimersByTime(50);
    await flush();
    ws = FakeWS.last!;
    expect(FakeWS.all).toHaveLength(2);
    expect(ws.protocols).toEqual(["ocw.v1", "ocw.auth.tok2"]);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenLastCalledWith({ force: false });
  });

  it("a token resolving after close() never opens a socket", async () => {
    let release: (t: string) => void = () => {};
    const getToken = () => new Promise<string>((r) => (release = r));
    const c = new RealtimeClient({ url: "ws://x/ws", WebSocket: FakeWS, getToken });
    c.connect();
    c.close();
    release("late");
    await flush();
    expect(FakeWS.all).toHaveLength(0);
    expect(c.status.getState().status).toBe("closed");
  });

  it("a failing getToken backs off and retries; a 401 rejection stops the client", async () => {
    vi.useFakeTimers();
    const getToken = vi
      .fn<(o: { force: boolean }) => Promise<string>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(Object.assign(new Error("signed out"), { status: 401 }));
    const c = new RealtimeClient({ url: "ws://x/ws", WebSocket: FakeWS, getToken, backoffBaseMs: 10 });
    c.connect();
    await flush();
    expect(c.status.getState().status).toBe("reconnecting");
    vi.advanceTimersByTime(50);
    await flush();
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(c.status.getState().status).toBe("closed");
    expect(FakeWS.all).toHaveLength(0);
  });

  it("presence frames of subscribed topics update client.presence; unknown topics are ignored", () => {
    const c = new RealtimeClient({ url: "ws://x/ws", WebSocket: FakeWS });
    c.subscribe(T, () => {}, { presence: true });
    c.connect();
    const ws = FakeWS.last!;
    ws.open();
    const conn = "0190d5e2-7c3a-7cc2-9d2e-0000000000c1";
    const userId = "0190d5e2-7c3a-7cc2-9d2e-000000000001";
    ws.push({ op: "presence", topic: T, full: true, entries: [{ conn, userId, state: "online" }] });
    expect(c.presence.getState().topics[T]).toEqual({ [conn]: { userId, state: "online" } });
    const other = "conv:0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e60";
    ws.push({ op: "presence", topic: other, full: true, entries: [{ conn, userId, state: "online" }] });
    expect(c.presence.getState().topics[other]).toBeUndefined();
    ws.push({ op: "presence", topic: T, full: false, entries: [{ conn, userId, state: "offline" }] });
    expect(c.presence.getState().topics[T]).toEqual({});
  });

  it("a socket close clears every topic's presence; the last unsubscribe deletes the topic's presence", () => {
    vi.useFakeTimers();
    const c = new RealtimeClient({ url: "ws://x/ws", WebSocket: FakeWS, backoffBaseMs: 10 });
    const T2 = "ws:0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e60";
    c.subscribe(T, () => {}, { presence: true });
    const off2a = c.subscribe(T2, () => {}, { presence: true });
    const off2b = c.subscribe(T2, () => {}, { presence: true });
    c.connect();
    let ws = FakeWS.last!;
    ws.open();
    const entry = {
      conn: "0190d5e2-7c3a-7cc2-9d2e-0000000000c1",
      userId: "0190d5e2-7c3a-7cc2-9d2e-000000000001",
      state: "online",
    };
    ws.push({ op: "presence", topic: T, full: true, entries: [entry] });
    ws.push({ op: "presence", topic: T2, full: true, entries: [entry] });
    ws.drop();
    expect(c.presence.getState().topics).toEqual({});

    vi.advanceTimersByTime(50);
    ws = FakeWS.last!;
    ws.open();
    ws.push({ op: "presence", topic: T2, full: true, entries: [entry] });
    off2a();
    expect(c.presence.getState().topics[T2]).toBeDefined(); // one listener left
    off2b();
    expect(c.presence.getState().topics[T2]).toBeUndefined();

    ws.push({ op: "presence", topic: T, full: true, entries: [entry] });
    c.close();
    expect(c.presence.getState().topics).toEqual({});
  });

  it("presence is opt-in per listener: the sub carries it while any listener wants it, and flips by re-subscribing", () => {
    const c = new RealtimeClient({ url: "ws://x/ws", WebSocket: FakeWS });
    c.connect();
    const ws = FakeWS.last!;
    ws.open();
    // A background watcher (unread dot) never counts as "here" and ignores presence frames.
    const offWatcher = c.subscribe(T, () => {}, { afterSeq: 4 });
    expect(ws.sent.at(-1)).toEqual({ op: "sub", topic: T, afterSeq: 4 });
    const entry = {
      conn: "0190d5e2-7c3a-7cc2-9d2e-0000000000c1",
      userId: "0190d5e2-7c3a-7cc2-9d2e-000000000001",
      state: "online",
    };
    ws.push({ op: "presence", topic: T, full: true, entries: [entry] });
    expect(c.presence.getState().topics[T]).toBeUndefined();

    // The view opens: one re-sub with presence, from the topic's cursor.
    ws.push(ev(5));
    const offView = c.subscribe(T, () => {}, { presence: true });
    expect(ws.sent.at(-1)).toEqual({ op: "sub", topic: T, afterSeq: 5, presence: true });
    const subs = ws.sent.length;
    const offView2 = c.subscribe(T, () => {}, { presence: true });
    expect(ws.sent).toHaveLength(subs); // already present: no new frame
    ws.push({ op: "presence", topic: T, full: true, entries: [entry] });
    expect(c.presence.getState().topics[T]).toBeDefined();

    // The view closes while the watcher stays: re-sub without presence, local presence dropped.
    offView2();
    expect(ws.sent).toHaveLength(subs);
    offView();
    expect(ws.sent.at(-1)).toEqual({ op: "sub", topic: T, afterSeq: 5 });
    expect(c.presence.getState().topics[T]).toBeUndefined();
    offWatcher();
    expect(ws.sent.at(-1)).toEqual({ op: "unsub", topic: T });
  });

  it("reconnect re-subscribes with presence for topics a listener is present in", () => {
    vi.useFakeTimers();
    const c = new RealtimeClient({ url: "ws://x/ws", WebSocket: FakeWS, backoffBaseMs: 10 });
    c.subscribe(T, () => {}, { presence: true });
    c.connect();
    FakeWS.last!.open();
    expect(FakeWS.last!.sent).toContainEqual({ op: "sub", topic: T, afterSeq: 0, presence: true });
    FakeWS.last!.drop();
    vi.advanceTimersByTime(50);
    FakeWS.last!.open();
    expect(FakeWS.last!.sent).toContainEqual({ op: "sub", topic: T, afterSeq: 0, presence: true });
  });

  it("backoff is bounded with full jitter", () => {
    expect(backoffDelay(0, 1000, 30_000, () => 0.999)).toBeLessThan(1000);
    expect(backoffDelay(10, 1000, 30_000, () => 0.999)).toBeLessThan(30_000);
    expect(backoffDelay(3, 1000, 30_000, () => 0)).toBe(0);
  });
});
