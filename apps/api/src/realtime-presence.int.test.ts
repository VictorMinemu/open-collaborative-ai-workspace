import { randomUUID } from "node:crypto";
import websocket from "@fastify/websocket";
import { WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import Fastify from "fastify";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { App } from "./core";
import {
  createPresenceStore,
  createRealtimeModule,
  PRESENCE_RATE_LIMIT,
  presenceKey,
} from "./modules/realtime";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "./testing";

/**
 * RT-04 presence (03-01) against the real stack: two users, two sockets, PostgreSQL + Redis. Presence follows
 * resolver-authorised subscriptions only, is keyed by an opaque per-socket id and leaves on unsub and close.
 */

let stack: TestStack;
let orgId: string;
let adminId: string;
let samId: string;
let admin: TestClient;
let sam: TestClient;
let publicId: string;
let privateId: string;

const ADMIN = {
  name: "Víctor Ruiz",
  email: "victor@example.test",
  password: "correct-horse-battery",
  orgName: "Autofy Labs",
};

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  // biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
  return r.body as Record<string, any>;
}

interface Frame {
  op: string;
  topic?: string;
  full?: boolean;
  code?: string;
  entries?: Array<{ conn: string; userId: string; state: string }>;
}

/** An authenticated /ws socket that records every frame with its arrival time. */
async function openSocket(baseUrl: string, token: string, opts: { autoPong?: boolean } = {}) {
  const socket = new WebSocket(
    `${baseUrl.replace("http", "ws")}/ws`,
    [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${token}`],
    { headers: { origin: WEB_ORIGIN }, ...(opts.autoPong === false ? { autoPong: false } : {}) },
  );
  const frames: Array<Frame & { at: number }> = [];
  socket.on("message", (m) => frames.push({ ...(JSON.parse(String(m)) as Frame), at: Date.now() }));
  const closed = new Promise<{ code: number; at: number }>((resolve) =>
    socket.on("close", (code) => resolve({ code, at: Date.now() })),
  );
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const send = (f: unknown) => socket.send(JSON.stringify(f));
  return { socket, frames, closed, send };
}
type Sock = Awaited<ReturnType<typeof openSocket>>;

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const presenceFrames = (s: Sock, topic: string) =>
  s.frames.filter((f) => f.op === "presence" && f.topic === topic);
const snapshotOf = (s: Sock, topic: string) => presenceFrames(s, topic).find((f) => f.full);
const deltaFor = (s: Sock, topic: string, conn: string, state: string) =>
  presenceFrames(s, topic).find(
    (f) => !f.full && f.entries?.some((e) => e.conn === conn && e.state === state),
  );

/** Subscribes and waits for the snapshot; returns this socket's own connection id (the entry with its user). */
async function join(s: Sock, topic: string, userId: string) {
  s.send({ op: "sub", topic, presence: true });
  const snap = await waitFor(() => snapshotOf(s, topic));
  const own = snap.entries?.find((e) => e.userId === userId);
  expect(own, "a snapshot contains the subscriber's own connection").toBeTruthy();
  return own!.conn;
}

beforeAll(async () => {
  stack = await startTestStack();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN }));
  orgId = setup.organization.id;
  adminId = setup.user.id;
  const inv = await ok(
    admin.request("POST", "/api/v1/invitations", { email: "sam@example.test", role: "developer" }),
  );
  sam = new TestClient(stack.baseUrl);
  const accepted = await ok(
    sam.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
      name: "Sam Lee",
      password: "sam-long-password-123",
    }),
  );
  samId = accepted.user.id;
  publicId = (await ok(admin.request("POST", "/api/v1/channels", { name: "launch", visibility: "public" })))
    .id;
  privateId = (await ok(admin.request("POST", "/api/v1/channels", { name: "board", visibility: "private" })))
    .id;
});

afterAll(async () => {
  await stack?.stop();
});

describe("realtime presence (RT-04)", () => {
  it("two members see each other join; unsub and close leave within a second; conn is not the session id", async () => {
    const topic = `conv:${publicId}`;
    const adminToken = await admin.token();
    const a = await openSocket(stack.baseUrl, adminToken);
    const aConn = await join(a, topic, adminId);
    expect(aConn).not.toBe((decodeJwt(adminToken) as { sid: string }).sid);
    expect(orgId).toBeTruthy();

    // Sam subscribes: admin gets Sam's online delta, Sam's snapshot holds both connections.
    const samToken = await sam.token();
    const s = await openSocket(stack.baseUrl, samToken);
    const t0 = Date.now();
    const sConn = await join(s, topic, samId);
    expect(sConn).not.toBe((decodeJwt(samToken) as { sid: string }).sid);
    expect(sConn).not.toBe(aConn);
    expect(
      snapshotOf(s, topic)
        ?.entries?.map((e) => e.conn)
        .sort(),
    ).toEqual([aConn, sConn].sort());
    const online = await waitFor(() => deltaFor(a, topic, sConn, "online"));
    expect(online.entries).toEqual([{ conn: sConn, userId: samId, state: "online" }]);
    const joinMs = online.at - t0;
    expect(joinMs).toBeLessThan(1000);

    // unsub → offline delta within a second
    const t1 = Date.now();
    s.send({ op: "unsub", topic });
    const left = await waitFor(() => deltaFor(a, topic, sConn, "offline"));
    const unsubMs = left.at - t1;
    expect(unsubMs).toBeLessThan(1000);

    // re-join on the same socket gets a fresh entry, then a close leaves too
    s.send({ op: "sub", topic, presence: true });
    const onlineDeltas = () =>
      presenceFrames(a, topic).filter(
        (f) => !f.full && f.entries?.some((e) => e.conn === sConn && e.state === "online"),
      ).length;
    await waitFor(() => onlineDeltas() === 2);
    await waitFor(() => presenceFrames(s, topic).filter((f) => f.full).length === 2);
    const before = presenceFrames(a, topic).length;
    const t2 = Date.now();
    s.socket.close();
    const gone = await waitFor(() =>
      presenceFrames(a, topic)
        .slice(before)
        .find((f) => f.entries?.some((e) => e.conn === sConn && e.state === "offline")),
    );
    const closeMs = gone.at - t2;
    expect(closeMs).toBeLessThan(1000);
    console.info(`presence latencies (ms): join=${joinMs} unsub=${unsubMs} close=${closeMs}`);
    a.socket.close();
  });

  it("a non-member of a private channel is refused and never appears in its presence", async () => {
    const topic = `conv:${privateId}`;
    const a = await openSocket(stack.baseUrl, await admin.token());
    await join(a, topic, adminId);
    const s = await openSocket(stack.baseUrl, await sam.token());
    s.send({ op: "sub", topic, presence: true });
    await waitFor(() => s.frames.find((f) => f.op === "err" && f.topic === topic && f.code === "forbidden"));
    await new Promise((r) => setTimeout(r, 300));
    expect(presenceFrames(s, topic)).toEqual([]);
    expect(s.frames.some((f) => f.op === "presence")).toBe(false);
    expect(
      presenceFrames(a, topic)
        .flatMap((f) => f.entries ?? [])
        .some((e) => e.userId === samId),
    ).toBe(false);
    // org-wide topics carry no presence even when allowed
    a.send({ op: "sub", topic: `org:${orgId}`, presence: true });
    await waitFor(() => a.frames.find((f) => f.op === "subscribed" && f.topic === `org:${orgId}`));
    await new Promise((r) => setTimeout(r, 200));
    expect(presenceFrames(a, `org:${orgId}`)).toEqual([]);
    a.socket.close();
    s.socket.close();
  });

  it("a background subscription (no presence flag) is not 'here' and gets no presence; re-subscribing flips it", async () => {
    const topic = `conv:${publicId}`;
    const a = await openSocket(stack.baseUrl, await admin.token());
    const aConn = await join(a, topic, adminId);
    const s = await openSocket(stack.baseUrl, await sam.token());
    s.send({ op: "sub", topic });
    await waitFor(() => s.frames.find((f) => f.op === "subscribed" && f.topic === topic));
    await new Promise((r) => setTimeout(r, 300));
    expect(presenceFrames(s, topic)).toEqual([]);
    expect(presenceFrames(a, topic).some((f) => f.entries?.some((e) => e.userId === samId))).toBe(false);

    // The view opens: same socket re-subscribes with presence → snapshot for Sam, online delta for admin.
    const sConn = await join(s, topic, samId);
    expect(snapshotOf(s, topic)?.entries?.some((e) => e.conn === aConn)).toBe(true);
    await waitFor(() => deltaFor(a, topic, sConn, "online"));
    // The view closes, the watcher stays: offline for admin, no more presence for Sam.
    s.send({ op: "sub", topic });
    await waitFor(() => deltaFor(a, topic, sConn, "offline"));
    const seen = presenceFrames(s, topic).length;
    a.socket.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(presenceFrames(s, topic)).toHaveLength(seen);
    s.socket.close();
  });
});

describe("away state (RT-04, 03-02 D-04)", () => {
  it("a presence op turns the sender away for everyone watching, follows it into later subscriptions, and online reverses it", async () => {
    const topic = `conv:${publicId}`;
    const a = await openSocket(stack.baseUrl, await admin.token());
    const s = await openSocket(stack.baseUrl, await sam.token());
    try {
      await join(a, topic, adminId);
      const sConn = await join(s, topic, samId);
      await waitFor(() => deltaFor(a, topic, sConn, "online"));

      // Identity fields in the frame are stripped by Zod: the state applies to the sender's own connection only.
      const t0 = Date.now();
      s.send({ op: "presence", state: "away", userId: adminId, conn: randomUUID() });
      const away = await waitFor(() => deltaFor(a, topic, sConn, "away"));
      const awayMs = away.at - t0;
      expect(awayMs).toBeLessThan(1000);
      expect(away.entries).toEqual([{ conn: sConn, userId: samId, state: "away" }]);
      expect(
        presenceFrames(a, topic)
          .flatMap((f) => f.entries ?? [])
          .some((e) => e.userId === adminId && e.state === "away"),
      ).toBe(false);
      // Stored once, under the new state.
      const live = await createPresenceStore({ bus: stack.built.core.bus }).snapshot(orgId, topic);
      expect(live.filter((m) => m.conn === sConn)).toEqual([{ conn: sConn, userId: samId, state: "away" }]);

      // A conversation Sam opens afterwards lists Sam as away from the start.
      const other = (
        await ok(admin.request("POST", "/api/v1/channels", { name: "away-later", visibility: "public" }))
      ).id as string;
      const otherTopic = `conv:${other}`;
      s.send({ op: "sub", topic: otherTopic, presence: true });
      const snap = await waitFor(() => snapshotOf(s, otherTopic));
      expect(snap.entries).toContainEqual({ conn: sConn, userId: samId, state: "away" });

      const t1 = Date.now();
      s.send({ op: "presence", state: "online" });
      const back = await waitFor(() =>
        presenceFrames(a, topic).find(
          (f) => !f.full && f.at >= t1 && f.entries?.some((e) => e.conn === sConn && e.state === "online"),
        ),
      );
      const onlineMs = back.at - t1;
      expect(onlineMs).toBeLessThan(1000);
      const after = await createPresenceStore({ bus: stack.built.core.bus }).snapshot(orgId, otherTopic);
      expect(after.filter((m) => m.conn === sConn)).toEqual([
        { conn: sConn, userId: samId, state: "online" },
      ]);
      console.info(`away latencies (ms): away=${awayMs} online=${onlineMs}`);
    } finally {
      a.socket.close();
      s.socket.close();
    }
  });
});

/**
 * A second gateway on the stack's realtime/identity/bus with a fast heartbeat (100 ms) and TTL (300 ms), and
 * optionally a shorter presence rate-limit window.
 */
async function miniGateway(opts: { rateLimit?: { max: number; windowMs: number } } = {}) {
  const mini = Fastify({ logger: false });
  await mini.register(websocket, {
    options: { handleProtocols: (p: Set<string>) => (p.has(WS_PROTOCOL) ? WS_PROTOCOL : false) },
  });
  const { realtime, identity, bus } = stack.built.core;
  const module = createRealtimeModule({
    realtime,
    identity,
    bus,
    allowedOrigins: new Set([WEB_ORIGIN]),
    presence: {
      heartbeatMs: HEARTBEAT,
      ttlMs: TTL,
      ...(opts.rateLimit ? { rateLimit: opts.rateLimit } : {}),
    },
  });
  await mini.register(async (scope) => module.register(scope as unknown as App));
  await mini.listen({ host: "127.0.0.1", port: 0 });
  const addr = mini.server.address();
  return {
    base: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`,
    close: () => mini.close(),
  };
}
const HEARTBEAT = 100;
const TTL = 300;

describe("presence expiry (RT-04, D-02)", () => {
  it("a dead peer (no pong) is terminated within two heartbeats and announced offline", async () => {
    const gw = await miniGateway();
    try {
      const topic = `conv:${publicId}`;
      const a = await openSocket(gw.base, await admin.token());
      await join(a, topic, adminId);
      const dead = await openSocket(gw.base, await sam.token(), { autoPong: false });
      const deadConn = await join(dead, topic, samId);
      const t0 = Date.now();
      const closed = await Promise.race([
        dead.closed,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("dead peer still open")), 2000)),
      ]);
      const terminatedMs = closed.at - t0;
      expect(terminatedMs).toBeLessThan(400);
      const off = await waitFor(() => deltaFor(a, topic, deadConn, "offline"));
      console.info(`dead peer: terminated after ${terminatedMs} ms, offline after ${off.at - t0} ms`);
      expect(a.socket.readyState).toBe(WebSocket.OPEN);
      a.socket.close();
    } finally {
      await gw.close();
    }
  });

  it("entries of a crashed instance are swept once and announced offline; a lost key heals itself", async () => {
    const gw = await miniGateway();
    try {
      const topic = `conv:${publicId}`;
      const a = await openSocket(gw.base, await admin.token());
      const aConn = await join(a, topic, adminId);
      const redis = stack.built.core.bus.pub;
      const key = presenceKey(orgId, topic);

      // A connection no live instance owns (its API instance crashed): expires 200 ms from now.
      const ghost = randomUUID();
      await redis.zAdd(key, { score: Date.now() + 200, value: `${ghost}|${samId}|online` });
      const t0 = Date.now();
      const swept = await waitFor(() => deltaFor(a, topic, ghost, "offline"), 2000);
      expect(swept.entries).toEqual([{ conn: ghost, userId: samId, state: "offline" }]);
      // Expired at +200 ms; claimed within two heartbeats of that.
      expect(swept.at - t0).toBeLessThan(200 + 2 * HEARTBEAT + 150);
      expect(await createPresenceStore({ bus: stack.built.core.bus }).sweep(orgId, topic)).toBe(0);
      expect(await redis.zScore(key, `${ghost}|${samId}|online`)).toBeNull();

      // The key vanishes (Redis restart, eviction): the next heartbeat re-adds the live entry and re-announces it.
      const before = presenceFrames(a, topic).length;
      await redis.del(key);
      const healed = await waitFor(() =>
        presenceFrames(a, topic)
          .slice(before)
          .find((f) => f.entries?.some((e) => e.conn === aConn && e.state === "online")),
      );
      expect(healed.full).toBe(false);
      expect(await redis.zScore(key, `${aConn}|${adminId}|online`)).not.toBeNull();
      a.socket.close();
    } finally {
      await gw.close();
    }
  });

  it("healthy sockets answer pings and stay present across ten heartbeats", async () => {
    const gw = await miniGateway();
    try {
      const topic = `conv:${publicId}`;
      const a = await openSocket(gw.base, await admin.token());
      const aConn = await join(a, topic, adminId);
      const s = await openSocket(gw.base, await sam.token());
      const sConn = await join(s, topic, samId);
      await new Promise((r) => setTimeout(r, 12 * HEARTBEAT));
      expect(a.socket.readyState).toBe(WebSocket.OPEN);
      expect(s.socket.readyState).toBe(WebSocket.OPEN);
      for (const c of [aConn, sConn]) {
        expect(deltaFor(a, topic, c, "offline")).toBeUndefined();
        expect(deltaFor(s, topic, c, "offline")).toBeUndefined();
      }
      const live = await createPresenceStore({ bus: stack.built.core.bus }).snapshot(orgId, topic);
      expect(live.map((m) => m.conn).sort()).toEqual([aConn, sConn].sort());
      a.socket.close();
      s.socket.close();
    } finally {
      await gw.close();
    }
  });
});

describe("presence rate limit (RT-04, 03-02 T-03-02-02)", () => {
  it("31 changes inside the window: the 31st is refused with rate_limited and never fanned out; later changes apply again", async () => {
    expect(PRESENCE_RATE_LIMIT).toEqual({ max: 30, windowMs: 10_000 });
    const WINDOW = 1000;
    const gw = await miniGateway({ rateLimit: { max: PRESENCE_RATE_LIMIT.max, windowMs: WINDOW } });
    const a = await openSocket(gw.base, await admin.token());
    const s = await openSocket(gw.base, await sam.token());
    try {
      const topic = `conv:${publicId}`;
      await join(a, topic, adminId);
      const sConn = await join(s, topic, samId);
      await waitFor(() => deltaFor(a, topic, sConn, "online"));
      const changes = () =>
        presenceFrames(a, topic).filter(
          (f) => !f.full && f.at >= t0 && f.entries?.some((e) => e.conn === sConn && e.state !== "offline"),
        );

      // Identical states never count: these 5 are ignored before the limiter.
      for (let i = 0; i < 5; i++) s.send({ op: "presence", state: "online" });
      const t0 = Date.now();
      // 31 real changes in a burst: away, online, away, …, away (the 31st).
      for (let i = 0; i < 31; i++) s.send({ op: "presence", state: i % 2 === 0 ? "away" : "online" });
      await waitFor(() => s.frames.find((f) => f.op === "err" && f.code === "rate_limited"));
      await waitFor(() => changes().length === 30);
      await new Promise((r) => setTimeout(r, 200));
      expect(changes()).toHaveLength(30);
      expect(s.frames.filter((f) => f.op === "err" && f.code === "rate_limited")).toHaveLength(1);
      // The refused change was not stored: Sam is still online (the 30th change).
      const stored = await createPresenceStore({ bus: stack.built.core.bus }).snapshot(orgId, topic);
      expect(stored.find((m) => m.conn === sConn)?.state).toBe("online");

      // After the window, changes apply again.
      await new Promise((r) => setTimeout(r, WINDOW + 50));
      s.send({ op: "presence", state: "away" });
      await waitFor(() => changes().length === 31);
      expect(changes().at(-1)?.entries).toEqual([{ conn: sConn, userId: samId, state: "away" }]);
      expect(s.frames.filter((f) => f.op === "err" && f.code === "rate_limited")).toHaveLength(1);
    } finally {
      a.socket.close();
      s.socket.close();
      await gw.close();
    }
  });

  it("a malformed state is answered with bad_frame and changes nothing", async () => {
    const topic = `conv:${publicId}`;
    const a = await openSocket(stack.baseUrl, await admin.token());
    const s = await openSocket(stack.baseUrl, await sam.token());
    try {
      await join(a, topic, adminId);
      const sConn = await join(s, topic, samId);
      await waitFor(() => deltaFor(a, topic, sConn, "online"));
      const before = presenceFrames(a, topic).length;
      for (const bad of [{ state: "busy" }, { state: "offline" }, {}, { state: 1 }]) {
        s.send({ op: "presence", ...bad });
      }
      await waitFor(() => s.frames.filter((f) => f.op === "err" && f.code === "bad_frame").length === 4);
      await new Promise((r) => setTimeout(r, 200));
      expect(presenceFrames(a, topic)).toHaveLength(before);
      const stored = await createPresenceStore({ bus: stack.built.core.bus }).snapshot(orgId, topic);
      expect(stored.filter((m) => m.conn === sConn)).toEqual([
        { conn: sConn, userId: samId, state: "online" },
      ]);
    } finally {
      a.socket.close();
      s.socket.close();
    }
  });
});
