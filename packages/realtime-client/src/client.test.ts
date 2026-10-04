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
  constructor(public url: string) {
    FakeWS.last = this;
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

afterEach(() => vi.useRealTimers());

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

  it("stops on 4401", () => {
    const c = new RealtimeClient({ url: "ws://x/ws", WebSocket: FakeWS });
    c.connect();
    FakeWS.last!.open();
    FakeWS.last!.drop(4401);
    expect(c.status.getState().status).toBe("closed");
  });

  it("backoff is bounded with full jitter", () => {
    expect(backoffDelay(0, 1000, 30_000, () => 0.999)).toBeLessThan(1000);
    expect(backoffDelay(10, 1000, 30_000, () => 0.999)).toBeLessThan(30_000);
    expect(backoffDelay(3, 1000, 30_000, () => 0)).toBe(0);
  });
});
