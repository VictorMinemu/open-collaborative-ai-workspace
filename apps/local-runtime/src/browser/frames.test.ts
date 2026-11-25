// Live frames of the device's browser (07.13-15 Task 1: D-15, PD-12, A-7). The page streams JPEG screencast frames
// over the Device Link only while the API says someone watches: `browser.frames { on: false }`, 25 s without a ping, a
// closed page or a closed link stop it; a frame over 256 KiB is dropped (never split) and nothing is queued while the
// link is down. The unit suite drives `LiveFrames` with a fake clock; the real-Chromium suite runs a real child.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeWorkBrowserFrame,
  type SessionBrowserGrant,
  WORK_BROWSER_FRAME_MAX_BYTES,
  WORK_BROWSER_LIMITS,
} from "@ocw/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "../logger.js";
import { decodeChildJpeg, encodeChildJpeg, type LiveClock, LiveFrames } from "./frames.js";
import { BrowserManager } from "./manager.js";
import { TEST_BROWSER_HINT, testBrowser, testSandbox } from "./test-browser.js";
import { startTestSite, type TestSite } from "./test-site.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, "..", "..", "bin", "ocw-runtime");

const executable = await testBrowser();
if (!executable) console.warn(TEST_BROWSER_HINT);

/** A clock whose timers fire only when the test moves it. */
class FakeClock implements LiveClock {
  now = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private next = 1;
  setTimeout(fn: () => void, ms: number): number {
    const id = this.next++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(id: unknown): void {
    this.timers.delete(id as number);
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.timers]) {
      if (t.at > this.now) continue;
      this.timers.delete(id);
      t.fn();
    }
  }
}

/** A small baseline JPEG header followed by filler: the codec never parses the image. */
function fakeJpeg(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  out[0] = 0xff;
  out[1] = 0xd8;
  return out;
}

function liveHarness(opts: { open?: boolean } = {}) {
  const clock = new FakeClock();
  const sent: Uint8Array[] = [];
  const link = { open: opts.open ?? true };
  const control: Array<{ sessionId: string; on: boolean }> = [];
  const frames = new LiveFrames({
    link: {
      sendBinary: (bytes) => {
        if (!link.open) return false;
        sent.push(bytes);
        return true;
      },
    },
    control: (sessionId, on) => control.push({ sessionId, on }),
    clock,
  });
  return { clock, sent, link, control, frames };
}

describe("child JPEG payload (agent → daemon)", () => {
  it("carries the frame size in a fixed 4-byte header before the JPEG", () => {
    const jpeg = fakeJpeg(32);
    const payload = encodeChildJpeg(jpeg, { width: 960, height: 600 });
    expect(payload.length).toBe(36);
    expect(decodeChildJpeg(payload)).toEqual({ width: 960, height: 600, jpeg });
    expect(decodeChildJpeg(new Uint8Array(3))).toBeNull();
    expect(decodeChildJpeg(encodeChildJpeg(jpeg, { width: 0, height: 600 }))).toBeNull();
  });
});

describe("LiveFrames (07.13-15 Task 1: PD-12, A-7)", () => {
  const sid = randomUUID();

  it("a ping starts the stream, later pings keep it, and 25 s without one stop it", () => {
    const h = liveHarness();
    expect(h.frames.ping(sid)).toBe(true);
    expect(h.control).toEqual([{ sessionId: sid, on: true }]);
    expect(h.frames.watching(sid)).toBe(true);
    h.clock.advance(WORK_BROWSER_LIMITS.watchPingMs);
    expect(h.frames.ping(sid)).toBe(false);
    h.clock.advance(WORK_BROWSER_LIMITS.watchLapseMs - 1);
    expect(h.frames.watching(sid)).toBe(true);
    h.clock.advance(1);
    expect(h.frames.watching(sid)).toBe(false);
    expect(h.control).toEqual([
      { sessionId: sid, on: true },
      { sessionId: sid, on: false },
    ]);
  });

  it("sends each JPEG as one Device Link binary frame for its session; `stop` ends it", () => {
    const h = liveHarness();
    h.frames.ping(sid);
    h.frames.onJpeg(sid, encodeChildJpeg(fakeJpeg(2048), { width: 960, height: 600 }));
    expect(h.sent).toHaveLength(1);
    const frame = decodeWorkBrowserFrame(h.sent[0] as Uint8Array);
    expect(frame).toMatchObject({ sessionId: sid, width: 960, height: 600 });
    expect(frame?.jpeg.length).toBe(2048);
    h.frames.stop(sid);
    h.frames.onJpeg(sid, encodeChildJpeg(fakeJpeg(2048), { width: 960, height: 600 }));
    expect(h.sent).toHaveLength(1);
    expect(h.frames.counters.unwatched).toBe(1);
  });

  it("drops a frame that would exceed 256 KiB, never splits it, and keeps streaming", () => {
    const h = liveHarness();
    h.frames.ping(sid);
    h.frames.onJpeg(
      sid,
      encodeChildJpeg(fakeJpeg(WORK_BROWSER_FRAME_MAX_BYTES), { width: 960, height: 600 }),
    );
    expect(h.sent).toHaveLength(0);
    expect(h.frames.counters.oversize).toBe(1);
    expect(h.frames.watching(sid)).toBe(true);
    h.frames.onJpeg(sid, encodeChildJpeg(fakeJpeg(1024), { width: 960, height: 600 }));
    expect(h.sent).toHaveLength(1);
    expect(h.frames.counters.sent).toBe(1);
  });

  it("sends nothing while the link is down, buffers nothing, and stops until the next ping", () => {
    const h = liveHarness({ open: false });
    h.frames.ping(sid);
    h.frames.onJpeg(sid, encodeChildJpeg(fakeJpeg(1024), { width: 960, height: 600 }));
    expect(h.sent).toHaveLength(0);
    expect(h.frames.counters.linkDown).toBe(1);
    expect(h.frames.watching(sid)).toBe(false);
    expect(h.control.at(-1)).toEqual({ sessionId: sid, on: false });
    h.link.open = true;
    // Nothing of the frame sent while down is ever sent later.
    h.frames.onJpeg(sid, encodeChildJpeg(fakeJpeg(1024), { width: 960, height: 600 }));
    expect(h.sent).toHaveLength(0);
    h.frames.ping(sid);
    h.frames.onJpeg(sid, encodeChildJpeg(fakeJpeg(512), { width: 960, height: 600 }));
    expect(h.sent).toHaveLength(1);
    expect(decodeWorkBrowserFrame(h.sent[0] as Uint8Array)?.jpeg.length).toBe(512);
  });

  it("refuses a session id that is not a uuid and a malformed child payload", () => {
    const h = liveHarness();
    expect(h.frames.ping("not-a-uuid")).toBe(false);
    expect(h.control).toEqual([]);
    h.frames.ping(sid);
    h.frames.onJpeg(sid, new Uint8Array([1, 2]));
    expect(h.sent).toHaveLength(0);
    expect(h.frames.counters.malformed).toBe(1);
  });
});

// ---------------------------------------------------------------------------- a real child

const ALLOW: SessionBrowserGrant = {
  allowed: true,
  reason: "ok",
  askerId: "00000000-0000-4000-8000-000000000001",
  askerIsBot: false,
  alwaysAsk: [],
  whenTainted: [],
  signinAllowed: false,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(25);
  }
  return cond();
}

describe.skipIf(!executable)("live frames from a real Chromium (07.13-15 Task 1)", () => {
  let site: TestSite;
  let manager: BrowserManager | null = null;
  const roots: string[] = [];

  beforeAll(async () => {
    site = await startTestSite();
  });
  afterEach(async () => {
    await manager?.stopAll();
    manager = null;
  });
  afterAll(async () => {
    await site?.close();
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  function start(link: { open: boolean }) {
    const root = mkdtempSync(join(tmpdir(), "ocw-browser-frames-"));
    roots.push(root);
    const sent: Array<{ at: number; bytes: Uint8Array }> = [];
    manager = new BrowserManager({
      root,
      link: {
        send: () => {},
        sendBinary: (bytes) => {
          if (!link.open) return false;
          sent.push({ at: Date.now(), bytes });
          return true;
        },
      },
      api: { put: async () => 404 },
      optIn: () => true,
      sandbox: () => testSandbox(),
      emit: () => {},
      browsers: {
        installed: async () => ({ executable: executable as string, version: "pinned" }),
        install: async () => {
          throw new Error("no install in tests");
        },
      },
      childEntry: [ENTRY],
      log: silentLogger,
    });
    const sid = randomUUID();
    const tools = manager.forSession(sid);
    manager.onPrompt(sid, "p1", ALLOW);
    manager.onTurnStarted(sid, "p1");
    return { sid, tools, sent, manager };
  }

  it("streams ≤ 4 fps of ≤ 960×600 JPEGs while watched, and nothing 500 ms after `on: false`", async () => {
    const t = start({ open: true });
    expect((await t.tools.call("open", { url: site.url("/animate") })).isError).toBe(false);
    await t.manager.onServerFrame({ type: "browser.frames", sessionId: t.sid, on: true });
    expect(await until(() => t.sent.length > 0, 2_000)).toBe(true);

    const first = decodeWorkBrowserFrame(t.sent[0]?.bytes as Uint8Array);
    expect(first?.sessionId).toBe(t.sid);
    expect(first?.width).toBeLessThanOrEqual(960);
    expect(first?.height).toBeLessThanOrEqual(600);
    expect([first?.jpeg[0], first?.jpeg[1]]).toEqual([0xff, 0xd8]);

    const from = t.sent.length;
    const windowStart = Date.now();
    await sleep(3_000);
    const inWindow = t.sent.slice(from).filter((f) => f.at - windowStart <= 3_000);
    expect(inWindow.length).toBeGreaterThanOrEqual(4);
    expect(inWindow.length).toBeLessThanOrEqual(WORK_BROWSER_LIMITS.fps * 3 + 1);
    for (const f of inWindow) expect(decodeWorkBrowserFrame(f.bytes)?.sessionId).toBe(t.sid);

    await t.manager.onServerFrame({ type: "browser.frames", sessionId: t.sid, on: false });
    await sleep(500);
    const stopped = t.sent.length;
    await sleep(1_000);
    expect(t.sent.length).toBe(stopped);
  }, 90_000);

  it("a closed page stops the stream; a watched session's next page streams again", async () => {
    const t = start({ open: true });
    await t.tools.call("open", { url: site.url("/animate") });
    await t.manager.onServerFrame({ type: "browser.frames", sessionId: t.sid, on: true });
    expect(await until(() => t.sent.length > 0, 2_000)).toBe(true);
    await t.tools.call("close", {});
    await sleep(500);
    const after = t.sent.length;
    await sleep(800);
    expect(t.sent.length).toBe(after);

    await t.tools.call("open", { url: site.url("/animate") });
    expect(await until(() => t.sent.length > after, 3_000)).toBe(true);
  }, 90_000);

  it("a link that is not open gets nothing and stops the stream until the next ping", async () => {
    const link = { open: false };
    const t = start(link);
    await t.tools.call("open", { url: site.url("/animate") });
    await t.manager.onServerFrame({ type: "browser.frames", sessionId: t.sid, on: true });
    await sleep(1_500);
    expect(t.sent).toHaveLength(0);
    link.open = true;
    await sleep(800);
    expect(t.sent).toHaveLength(0);
    await t.manager.onServerFrame({ type: "browser.frames", sessionId: t.sid, on: true });
    expect(await until(() => t.sent.length > 0, 2_000)).toBe(true);
  }, 90_000);
});
