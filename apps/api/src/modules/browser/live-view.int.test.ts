import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Json, ok, type Res } from "../../testing-sandbox";
import { createSandboxEventsConsumer, type SandboxdClient } from "../sandbox";
import {
  type LiveSocket,
  type LiveStack,
  lastState,
  liveSocket,
  liveUrl,
  sleep,
  startLiveStack,
  upgradeStatus,
  waitFor,
  waitState,
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

describe("what the web client needs (07.8-22)", () => {
  it("a state with the page names the requester; a state without it never does", async () => {
    const ev = await l.turnIn(l.s.sam);
    const contextId = await l.open(ev);
    const alex = await liveSocket(l.s.stack.baseUrl, await l.s.alex.token(), contextId);
    const nia = await liveSocket(l.s.stack.baseUrl, await l.nia.token(), contextId);
    try {
      expect(await waitState(alex, "live")).toMatchObject({
        host: "panel.fake.test",
        requesterName: "Sam Lee",
      });
      const refused = await waitState(nia, "no_permission");
      expect(refused.requesterName).toBeUndefined();
      expect(refused.host).toBeNull();
    } finally {
      alex.close();
      nia.close();
    }
  });

  it("the heartbeat sends every viewer its current state again, so a client can tell a dead socket from a quiet one", async () => {
    const ev = await l.turnIn(l.s.sam);
    const contextId = await l.open(ev);
    const sam = await liveSocket(l.s.stack.baseUrl, await l.s.sam.token(), contextId);
    try {
      const first = await waitState(sam, "live");
      const states = () => sam.json.filter((f) => f.type === "state").length;
      const before = states();
      l.s.stack.built.browser.live()?.heartbeat();
      await waitFor(() => states() === before + 1);
      expect(lastState(sam)).toEqual(first);
    } finally {
      sam.close();
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

// ---------------------------------------------------------------- Task 3: live re-authorization, states, resize

/** One pass of sandboxd's event feed through the app's own `browser` handler (the app's consumer is off in tests). */
async function pumpEvents(): Promise<void> {
  const consumer = createSandboxEventsConsumer(l.s.stack.built.core, {
    client: l.s.stack.built.sandbox.client as SandboxdClient,
    lockKey: 0x0b0e_1600 + Math.floor(Math.random() * 1000),
    waitMs: 0,
  });
  consumer.onEvent("browser", l.s.stack.built.browser.onBrowserEvent);
  try {
    await consumer.runOnce({ waitMs: 0 });
  } finally {
    await consumer.stop();
  }
}

async function control(path: string, body: Json = {}): Promise<void> {
  const res = await fetch(`${l.s.sandboxd.url}/__control${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

/** Sam's page in #ops with Sam and Alex watching (frames flowing on both). */
async function watchedPage() {
  const ev = await l.turnIn(l.s.sam);
  const contextId = await l.open(ev);
  const sam = await liveSocket(l.s.stack.baseUrl, await l.s.sam.token(), contextId);
  const alex = await liveSocket(l.s.stack.baseUrl, await l.s.alex.token(), contextId);
  await waitFor(() => sam.binary.length >= 2 && alex.binary.length >= 2);
  return { ev, contextId, sam, alex };
}

/** After `ended`/`no_permission`, no binary frame arrives (the frame count settles for 1 s). */
async function noFrameAfter(s: LiveSocket) {
  await s.closed;
  const at = s.binary.length;
  await sleep(1000);
  expect(s.binary.length).toBe(at);
}

const contextRow = async (id: string) =>
  (
    await l.s.su.query("select state, end_reason, closed_at, host from app.browser_contexts where id = $1", [
      id,
    ])
  ).rows[0] as Json;

describe("live re-authorization (D-06, ADR-0009, T-07.8-16-05)", () => {
  it("Alex removed from #ops while watching: no_permission at once, then no frame; Sam keeps watching", async () => {
    const { sam, alex } = await watchedPage();
    try {
      await ok(
        l.s.sam.request("DELETE", `/api/v1/channels/${l.ops}/members/user/${l.s.alexId}`) as Promise<Res>,
      );
      const st = await waitState(alex, "no_permission");
      expect(st).toMatchObject({ host: null, secure: null });
      expect(alex.json.filter((f) => f.type === "viewerCan").at(-1)).toEqual({
        type: "viewerCan",
        watch: false,
        control: false,
      });
      expect((await alex.closed).code).toBe(4403);
      await noFrameAfter(alex);
      const samAt = sam.binary.length;
      await waitFor(() => sam.binary.length > samAt + 2);
    } finally {
      sam.close();
      alex.close();
      await ok(
        l.s.sam.request("POST", `/api/v1/channels/${l.ops}/members`, {
          kind: "user",
          id: l.s.alexId,
        }) as Promise<Res>,
      );
    }
  });

  it("the Browser module turned off for Alex: ended (module_off) for him only; back on, he watches again", async () => {
    const { contextId, sam, alex } = await watchedPage();
    const put = (enabled: boolean) =>
      ok(
        l.s.victor.request("PUT", "/api/v1/module-access", {
          module: "browser",
          scopeUnitId: null,
          subject: { kind: "user", userId: l.s.alexId },
          enabled,
        }) as Promise<Res>,
      );
    try {
      await put(false);
      expect(await waitState(alex, "ended")).toMatchObject({ endReason: "module_off" });
      await noFrameAfter(alex);
      expect(lastState(sam)?.state).toBe("live");
      expect((await contextRow(contextId)).closed_at).toBeNull();
    } finally {
      await put(true);
      sam.close();
      alex.close();
    }
    const again = await liveSocket(l.s.stack.baseUrl, await l.s.alex.token(), contextId);
    try {
      await waitFor(() => again.binary.length >= 1);
    } finally {
      again.close();
    }
  });

  it("the bot's Browser switch turned off: ended (module_off) for every viewer, the page closed and audited", async () => {
    const { contextId, sam, alex } = await watchedPage();
    try {
      await ok(
        l.s.victor.request("PATCH", `/api/v1/agents/${l.s.scoutId}/capabilities`, {
          browser: false,
        }) as Promise<Res>,
      );
      for (const s of [sam, alex])
        expect(await waitState(s, "ended")).toMatchObject({ endReason: "module_off" });
      await noFrameAfter(sam);
      expect(await contextRow(contextId)).toMatchObject({ state: "ended", end_reason: "module_off" });
      await waitFor(() => !fakeContext(contextId));
    } finally {
      sam.close();
      alex.close();
      await ok(
        l.s.victor.request("PATCH", `/api/v1/agents/${l.s.scoutId}/capabilities`, {
          browser: true,
        }) as Promise<Res>,
      );
    }
  });
});

describe("every ended reason the UI names (UI-SPEC §1.4)", () => {
  it("kill_switch: the admin's kill ends the page for every viewer", async () => {
    const { contextId, sam, alex } = await watchedPage();
    try {
      await ok(l.s.victor.request("POST", "/api/v1/sandbox/kill", {}) as Promise<Res>);
      for (const s of [sam, alex])
        expect(await waitState(s, "ended")).toMatchObject({ endReason: "kill_switch" });
      await noFrameAfter(alex);
      expect(await contextRow(contextId)).toMatchObject({ end_reason: "kill_switch" });
    } finally {
      sam.close();
      alex.close();
      await ok(l.s.victor.request("POST", "/api/v1/sandbox/resume", {}) as Promise<Res>);
    }
  });

  it("closed_by_bot: the bot's close ends the page", async () => {
    const { ev, sam } = await watchedPage();
    try {
      await ok(l.browser("close", ev));
      expect(await waitState(sam, "ended")).toMatchObject({
        endReason: "closed_by_bot",
        host: "panel.fake.test",
      });
      await noFrameAfter(sam);
    } finally {
      sam.close();
    }
  });

  it("crashed: sandboxd reports a crash (event feed) and the page ends", async () => {
    const { contextId, sam } = await watchedPage();
    try {
      await control("/browser/event", { contextId, event: "crashed" });
      await pumpEvents();
      expect(await waitState(sam, "ended")).toMatchObject({ endReason: "crashed" });
    } finally {
      sam.close();
    }
  });

  it("idle: sandboxd closes the page on its own (idle stop); the stream's close ends it", async () => {
    const { contextId, sam } = await watchedPage();
    try {
      await control("/browser/event", { contextId, event: "closed" });
      expect(await waitState(sam, "ended")).toMatchObject({ endReason: "idle" });
      expect(await contextRow(contextId)).toMatchObject({ end_reason: "idle" });
    } finally {
      sam.close();
    }
  });

  it("a sandboxd restart that forgot the page (no_context): it ends cleanly as crashed; the bot's next open starts a new page", async () => {
    const { ev, contextId, sam } = await watchedPage();
    try {
      l.s.sandboxd.fake.reboot({ forgetContexts: true });
      expect(await waitState(sam, "ended", 6000)).toMatchObject({ endReason: "crashed" });
      expect(await contextRow(contextId)).toMatchObject({ end_reason: "crashed" });
      const snap = await l.browser("snapshot", ev);
      expect(snap.status).toBe(404);
      const reopened = await l.open(ev);
      expect(reopened).not.toBe(contextId);
    } finally {
      sam.close();
    }
  });
});

describe("paused, activity, resize and slow viewers (R3, R10, P-08)", () => {
  it("the activity follows the bot's latest step (masked, no typed text); a pending approval pauses the page with its route", async () => {
    const { ev, sam } = await watchedPage();
    try {
      await ok(l.browser("act", ev, { action: "type", ref: "r2", text: "OCW-SENTINEL-TYPED-8842" }));
      const typing = await waitFor(() => {
        const st = lastState(sam);
        return st?.activity?.startsWith("typing into") ? st : undefined;
      });
      expect(typing.activity).toBe("typing into “Email” on panel.fake.test");
      expect(JSON.stringify(sam.json)).not.toContain("OCW-SENTINEL-TYPED-8842");
      await ok(l.browser("act", ev, { action: "click", ref: "r4" }));
      await waitFor(() => lastState(sam)?.activity === "clicking “Sign in” on panel.fake.test");

      const policy = (
        await l.s.su.query(
          `insert into app.tool_approval_policies
             (organization_id, scope_unit_id, tool_pattern, mode, approver_kind, approver_user_ids, created_by, updated_by)
           values ($1, null, 'ocw_browser_act', 'always', 'requester', '{}', $2, $2) returning id`,
          [l.s.orgA, l.s.victorId],
        )
      ).rows[0].id as string;
      try {
        const r = await l.browser("act", ev, { action: "click", ref: "r4" });
        expect(r.status).toBe(409);
        const paused = await waitState(sam, "paused");
        expect(paused.pausedFor).toBe("approval");
        expect(paused.approvalRoute).toMatch(/^\/chat\//u);
        expect(sam.binary.length).toBeGreaterThan(0);
      } finally {
        await l.s.su.query("delete from app.tool_approval_policies where id = $1", [policy]);
      }
    } finally {
      sam.close();
    }
  });

  it("resize: small by default; expanded while one viewer expands; phone only from the controller", async () => {
    const { contextId, sam, alex } = await watchedPage();
    const viewport = () => fakeContext(contextId)?.viewport;
    try {
      await waitFor(() => viewport()?.width === 960);
      expect(viewport()).toEqual({ width: 960, height: 600 });
      alex.send({ type: "resize", mode: "expanded" });
      await waitFor(() => viewport()?.width === 1280);
      expect(viewport()).toEqual({ width: 1280, height: 800 });
      alex.send({ type: "resize", mode: "small" });
      await waitFor(() => viewport()?.width === 960);

      // Phone from a viewer without the lease is ignored; from the controller it applies with its mode.
      alex.send({ type: "resize", mode: "phone", width: 390, height: 700 });
      await sleep(400);
      expect(viewport()).toEqual({ width: 960, height: 600 });
      sam.send({ type: "take" });
      await waitState(sam, "controlling");
      sam.send({ type: "resize", mode: "phone", width: 390, height: 700 });
      await waitFor(() => viewport()?.width === 390);
      expect(fakeContext(contextId)?.viewportMode).toBe("phone");
      sam.send({ type: "release" });
      await waitFor(() => viewport()?.width === 960);
      expect(fakeContext(contextId)?.viewportMode).toBe("small");
    } finally {
      sam.close();
      alex.close();
    }
  });

  it("a viewer that stops reading for 2 s never queues more than the frame being written; it catches up with the latest", async () => {
    const { contextId, sam, alex } = await watchedPage();
    try {
      const raw = (alex.socket as unknown as { _socket: { pause(): void; resume(): void } })._socket;
      raw.pause();
      await sleep(2000);
      raw.resume();
      const at = alex.binary.length;
      await waitFor(() => alex.binary.length > at + 2);
      const viewer = l.s.stack.built.browser
        .live()
        ?.stats()
        .contexts.find((c) => c.contextId === contextId)
        ?.viewers.find((v) => v.userId === l.s.alexId);
      // One fixture frame is at most 12 KiB: the socket's own buffer never held more than one frame plus framing.
      expect(viewer?.maxBuffered ?? Number.POSITIVE_INFINITY).toBeLessThan(13 * 1024);
    } finally {
      sam.close();
      alex.close();
    }
  });
});

describe("http refusals (07.8-13: navigation_refused)", () => {
  it("a first open the egress refuses: 403 navigation_refused, the new page ends (not a crash)", async () => {
    const ev = await l.turnIn(l.s.sam);
    await l.browser("close", ev);
    const r = await l.browser("open", ev, { url: "https://refused.fake.test/" });
    expect(r.status).toBe(403);
    expect((r.body?.error as Json | undefined)?.code).toBe("navigation_refused");
    const rows = (
      await l.s.su.query(
        "select end_reason, closed_at from app.browser_contexts where event_id = $1 and host = 'refused.fake.test'",
        [ev.eventId],
      )
    ).rows as Json[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.closed_at).not.toBeNull();
    expect(rows[0]?.end_reason).toBe("closed_by_bot");
  });

  it("on an open page: 403 navigation_refused and the page stays where it was, still watched live", async () => {
    const { ev, contextId, sam } = await watchedPage();
    try {
      const r = await l.browser("open", ev, { url: "https://refused.fake.test/" });
      expect(r.status).toBe(403);
      expect((r.body?.error as Json | undefined)?.code).toBe("navigation_refused");
      expect(await contextRow(contextId)).toMatchObject({ host: "panel.fake.test", closed_at: null });
      await sleep(300);
      expect(lastState(sam)).toMatchObject({ state: "live", host: "panel.fake.test" });
    } finally {
      sam.close();
    }
  });
});
