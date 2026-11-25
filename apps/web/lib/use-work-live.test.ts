import type { LiveStateFrame } from "@ocw/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkLive, workShowsFrames, workUiStateOf } from "./use-work-live";
import { workLiveSocketUrl } from "./work-browser-queries";

/**
 * The Work Zone live view's socket (07.13-16; D-15, PD-13): one socket per open Browser panel, on the API's
 * `/api/v1/live/work-browser/:sessionId`, authenticated like the bots' one (the JWT as a subprotocol, never in the URL),
 * its state kept in the bots' `LiveView` shape and its frames handed on, never kept past the latest one.
 */

const SID = "0199f1c2-7a4b-7c3d-9e8f-123456789abc";

class FakeSocket {
  static all: FakeSocket[] = [];
  binaryType = "";
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closedWith: number | undefined | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.all.push(this);
  }
  send() {}
  close(code?: number) {
    this.closedWith = code;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  json(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function state(over: Partial<LiveStateFrame> = {}): LiveStateFrame {
  return {
    type: "state",
    state: "live",
    pausedFor: null,
    activity: null,
    host: "localhost:3000",
    secure: false,
    controller: null,
    ...over,
  } as LiveStateFrame;
}

function start() {
  const live = createWorkLive(SID, "Claude Code", {
    url: workLiveSocketUrl(SID, "https://api.example"),
    getToken: async () => "jwt",
    WebSocketCtor: FakeSocket as never,
  });
  live.start();
  return live;
}

afterEach(() => {
  FakeSocket.all = [];
});

describe("workLiveSocketUrl", () => {
  it("is the API's work-browser live route on ws(s)", () => {
    expect(workLiveSocketUrl(SID, "https://api.example")).toBe(
      `wss://api.example/api/v1/live/work-browser/${SID}`,
    );
    expect(workLiveSocketUrl(SID, "http://localhost:4000/")).toBe(
      `ws://localhost:4000/api/v1/live/work-browser/${SID}`,
    );
  });
});

describe("createWorkLive (D-15)", () => {
  it("connects to the session's live route with the token as a subprotocol, never in the URL", async () => {
    const live = start();
    await flush();
    const ws = FakeSocket.all[0] as FakeSocket;
    expect(ws.url).toBe(`wss://api.example/api/v1/live/work-browser/${SID}`);
    expect(ws.protocols).toEqual(["ocw.v1", "ocw.auth.jwt"]);
    expect(ws.url).not.toContain("jwt");
    live.stop();
  });

  it("keeps the state in the bots' LiveView shape: the session as the context, the runtime as the bot", async () => {
    const live = start();
    expect(live.getView()).toMatchObject({
      contextId: SID,
      bot: { id: SID, name: "Claude Code" },
      conn: "connecting",
      server: null,
      hasFrame: false,
    });
    live.stop();
  });

  it("a live state then a JPEG: the view is live with a frame, and the frame reaches the listeners", async () => {
    const live = start();
    const seen: Blob[] = [];
    live.frames.listeners.add((b) => seen.push(b));
    const changes = vi.fn();
    const off = live.subscribe(changes);
    await flush();
    const ws = FakeSocket.all[0] as FakeSocket;
    ws.open();
    ws.json({ type: "viewerCan", watch: true, control: false });
    ws.json(state());
    const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
    ws.onmessage?.({ data: jpeg });
    const v = live.getView();
    expect(v.server?.state).toBe("live");
    expect(v.viewerCan).toEqual({ watch: true, control: false });
    expect(v.hasFrame).toBe(true);
    expect(seen).toEqual([jpeg]);
    expect(changes).toHaveBeenCalled();
    off();
    live.stop();
  });

  it("stop() (the panel unmounting) closes the socket with 1000 and forgets the latest frame", async () => {
    const live = start();
    await flush();
    const ws = FakeSocket.all[0] as FakeSocket;
    ws.open();
    ws.json(state());
    ws.onmessage?.({ data: new Blob([new Uint8Array([1])]) });
    expect(live.frames.latest).not.toBeNull();
    live.stop();
    expect(ws.closedWith).toBe(1000);
    expect(live.frames.latest).toBeNull();
  });

  it("a private, ended or no-permission state drops the frame and lets no later frame through (T-07.13-16-03)", async () => {
    const live = start();
    const seen: Blob[] = [];
    live.frames.listeners.add((b) => seen.push(b));
    await flush();
    const ws = FakeSocket.all[0] as FakeSocket;
    ws.open();
    ws.json(state());
    ws.onmessage?.({ data: new Blob([new Uint8Array([1])]) });
    ws.json(state({ state: "private", privateReason: "member_session", memberName: "Ana", host: null }));
    expect(live.getView().hasFrame).toBe(false);
    expect(live.frames.latest).toBeNull();
    ws.onmessage?.({ data: new Blob([new Uint8Array([2])]) });
    expect(seen).toHaveLength(1);
    expect(live.getView().hasFrame).toBe(false);
    live.stop();
  });

  it("retry() opens a new socket from a fresh view", async () => {
    const live = start();
    await flush();
    const first = FakeSocket.all[0] as FakeSocket;
    first.open();
    first.json(state({ state: "ended", endReason: "idle", host: null }));
    live.retry();
    expect(first.closedWith).toBe(1000);
    expect(live.getView()).toMatchObject({ conn: "connecting", server: null, hasFrame: false });
    await flush();
    expect(FakeSocket.all).toHaveLength(2);
    live.stop();
  });
});

describe("workUiStateOf", () => {
  const base = { conn: "open" as const, server: state() };
  it("an open socket whose page does not exist yet reads idle (nothing opened yet)", () => {
    expect(workUiStateOf({ ...base, server: state({ state: "connecting", host: null }) })).toBe("idle");
    expect(workUiStateOf({ conn: "connecting", server: null })).toBe("connecting");
    expect(workUiStateOf(base)).toBe("live");
    expect(workUiStateOf({ ...base, server: state({ state: "ended", endReason: "access_lost" }) })).toBe(
      "no_permission",
    );
  });
  it("frames show only while the page is there to see", () => {
    expect(workShowsFrames("live")).toBe(true);
    expect(workShowsFrames("controlling")).toBe(true);
    expect(workShowsFrames("reconnecting")).toBe(true);
    for (const s of ["idle", "connecting", "private", "ended", "no_permission", "error"] as const) {
      expect(workShowsFrames(s)).toBe(false);
    }
  });
});
