import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type LiveStack,
  lastState,
  liveSocket,
  liveUrl,
  sleep,
  startLiveStack,
  upgradeStatus,
  waitFor,
} from "./live-testing";

/**
 * 07.8-16 (BRW-02; D-06, P-08): people watch a bot's browser live through the API's own authorization. The socket is
 * authenticated like `/ws` (Origin + `ocw.auth.<jwt>` before the upgrade); the resolver decides `browser.watch` and
 * `browser.control` on the page; one upstream frame stream per page is fanned out to every viewer who may see it.
 * Real PostgreSQL and Redis; the in-memory sandboxd and its JPEG fixtures (P-13).
 */

let l: LiveStack;

const fakeContext = (contextId: string) =>
  l.s.sandboxd.stats().browser.contexts.find((c) => c.contextId === contextId);

const JPEG_SOI = [0xff, 0xd8, 0xff];

beforeAll(async () => {
  l = await startLiveStack();
});

afterAll(async () => {
  await l?.stop();
});

describe("a reader of the conversation watches the bot's browser (tracer)", () => {
  it("Sam and Alex read #ops: viewerCan then state, then JPEG frames; one upstream for both; it closes with them", async () => {
    const ev = await l.turnIn(l.s.sam);
    const contextId = await l.open(ev);
    const framesBefore = l.s.sandboxd.stats().calls.contextFrames ?? 0;

    const sam = await liveSocket(l.s.stack.baseUrl, await l.s.sam.token(), contextId);
    const alex = await liveSocket(l.s.stack.baseUrl, await l.s.alex.token(), contextId);
    try {
      for (const [who, control] of [
        [sam, true],
        [alex, false],
      ] as const) {
        await waitFor(() => who.json.length >= 2);
        expect(who.json[0]).toEqual({ type: "viewerCan", watch: true, control });
        expect(who.json[1]).toMatchObject({
          type: "state",
          state: "live",
          host: "panel.fake.test",
          secure: true,
          controller: null,
        });
        await waitFor(() => who.binary.length >= 3);
        for (const f of who.binary) expect(f.head).toEqual(JPEG_SOI);
      }
      // One upstream for the two viewers (fake: one subscriber, one frames call).
      expect(fakeContext(contextId)?.viewers).toBe(1);
      expect((l.s.sandboxd.stats().calls.contextFrames ?? 0) - framesBefore).toBe(1);
      expect(l.s.stack.built.browser.live()?.stats().contexts).toEqual([
        expect.objectContaining({ contextId, upstream: true }),
      ]);
    } finally {
      sam.close();
      alex.close();
    }
    await sam.closed;
    await alex.closed;
    await waitFor(() => fakeContext(contextId)?.viewers === 0);
    await waitFor(() => l.s.stack.built.browser.live()?.stats().contexts.length === 0);
  });

  it("the bot's owner watches without reading the conversation (no member session); he cannot take control", async () => {
    const ev = await l.turnIn(l.s.sam);
    const contextId = await l.open(ev);
    const victor = await liveSocket(l.s.stack.baseUrl, await l.s.victor.token(), contextId);
    try {
      await waitFor(() => victor.json.length >= 2);
      expect(victor.json[0]).toEqual({ type: "viewerCan", watch: true, control: false });
      expect(victor.json[1]).toMatchObject({ type: "state", state: "live", host: "panel.fake.test" });
      await waitFor(() => victor.binary.length >= 2);
    } finally {
      victor.close();
    }
  });
});

describe("nobody else sees a frame (D-06, T-07.8-16-05, tenant isolation)", () => {
  it("a member who cannot read #ops: viewerCan false, no_permission without the page, closed, zero frames", async () => {
    const ev = await l.turnIn(l.s.sam);
    const contextId = await l.open(ev);
    const nia = await liveSocket(l.s.stack.baseUrl, await l.nia.token(), contextId);
    const { code } = await nia.closed;
    expect(code).toBe(4403);
    expect(nia.json).toEqual([
      { type: "viewerCan", watch: false, control: false },
      {
        type: "state",
        state: "no_permission",
        pausedFor: null,
        activity: null,
        host: null,
        secure: null,
        controller: null,
      },
    ]);
    await sleep(500);
    expect(nia.binary).toHaveLength(0);
  });

  it("organization B's admin with the context id: no_permission, zero frames (the id is resolved in her tenant)", async () => {
    const ev = await l.turnIn(l.s.sam);
    const contextId = await l.open(ev);
    const eve = await liveSocket(l.s.stack.baseUrl, await l.s.eve.token(), contextId);
    const { code } = await eve.closed;
    expect(code).toBe(4403);
    expect(lastState(eve)).toMatchObject({ state: "no_permission", host: null });
    expect(eve.binary).toHaveLength(0);
    expect(JSON.stringify(eve.json)).not.toContain("panel.fake.test");
  });

  it("the upgrade needs an allowed Origin (403) and the access token subprotocol (401); a bad id is 404", async () => {
    const ev = await l.turnIn(l.s.sam);
    const contextId = await l.open(ev);
    const url = liveUrl(l.s.stack.baseUrl, contextId);
    const token = await l.s.sam.token();
    expect(await upgradeStatus(url, { origin: "https://evil.example", token })).toBe(403);
    expect(await upgradeStatus(url, { origin: null, token })).toBe(403);
    expect(await upgradeStatus(url, { token: null })).toBe(401);
    expect(await upgradeStatus(url, { token: "not-a-jwt" })).toBe(401);
    expect(await upgradeStatus(liveUrl(l.s.stack.baseUrl, "not-a-uuid"), { token })).toBe(404);
    expect(await upgradeStatus(url, { token })).toBe(101);
  });

  it("the live view is the registry's one live route, declared `user`", () => {
    const routes = l.s.stack.built.authz.routes;
    const live = [...routes.keys()].filter((k) => k.startsWith("GET /api/v1/live/"));
    expect(live).toEqual(["GET /api/v1/live/browser/:contextId"]);
    expect(routes.get("GET /api/v1/live/browser/:contextId")).toBe("user");
  });
});
