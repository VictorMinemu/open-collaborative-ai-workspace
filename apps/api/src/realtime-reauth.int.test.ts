import { randomUUID } from "node:crypto";
import websocket from "@fastify/websocket";
import { WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { App, AuthContext } from "./core";
import {
  createRealtimeModule,
  createRealtimeService,
  type RealtimeService,
  type Reauthorization,
} from "./modules/realtime";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "./testing";
import { eventually, FakeDevice } from "./testing-device";
import {
  CLAUDE_CATALOG,
  createTeamProject,
  invite,
  pairDevice,
  shareDevice,
  startSession,
} from "./testing-workzone";

/**
 * RT-01 live re-authorisation (03-04, D-05/D-06) against the real stack: a membership change re-decides the
 * affected live subscriptions through the `conv` topic authorizer (the Phase 2 resolver). Losing channel.read
 * drops the subscription with a `revoked` frame; a public channel keeps its read-only preview.
 */

let stack: TestStack;
let orgId: string;
let adminId: string;
let samId: string;
let admin: TestClient;
let sam: TestClient;

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
  reason?: string;
  cause?: string;
  type?: string;
  entries?: Array<{ conn: string; userId: string; state: string }>;
}

/** An authenticated /ws socket that records every frame with its arrival time. */
async function openSocket(baseUrl: string, token: string) {
  const socket = new WebSocket(
    `${baseUrl.replace("http", "ws")}/ws`,
    [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${token}`],
    { headers: { origin: WEB_ORIGIN } },
  );
  const frames: Array<Frame & { at: number }> = [];
  socket.on("message", (m) => frames.push({ ...(JSON.parse(String(m)) as Frame), at: Date.now() }));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const send = (f: unknown) => socket.send(JSON.stringify(f));
  return { socket, frames, send };
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const revokedFor = (s: Sock, topic: string) => s.frames.find((f) => f.op === "revoked" && f.topic === topic);

/** Subscribes (with presence) and waits for `subscribed` and the snapshot; returns the own connection id. */
async function subscribe(s: Sock, topic: string, userId: string): Promise<string> {
  s.send({ op: "sub", topic, presence: true });
  const snap = await waitFor(() =>
    s.frames.find((f) => f.op === "presence" && f.topic === topic && f.full === true),
  );
  return snap.entries?.find((e) => e.userId === userId)?.conn ?? "";
}

async function channel(name: string, visibility: "public" | "private") {
  return (await ok(admin.request("POST", "/api/v1/channels", { name, visibility }))).id as string;
}
async function addSam(channelId: string) {
  await ok(admin.request("POST", `/api/v1/channels/${channelId}/members`, { kind: "user", id: samId }));
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
});

afterAll(async () => {
  await stack?.stop();
});

describe("live re-authorisation of channel subscriptions (RT-01, D-05/D-06)", () => {
  it("removal from a private channel revokes within a second; a public channel keeps its preview; leaving revokes", async () => {
    const privateId = await channel("board", "private");
    const leaveId = await channel("offsite", "private");
    const publicId = await channel("launch", "public");
    await addSam(privateId);
    await addSam(leaveId);
    await ok(sam.request("POST", `/api/v1/channels/${publicId}/join`, {}));
    const priv = `conv:${privateId}`;
    const pub = `conv:${publicId}`;
    const left = `conv:${leaveId}`;

    const a = await openSocket(stack.baseUrl, await admin.token());
    const s = await openSocket(stack.baseUrl, await sam.token());
    try {
      await subscribe(a, priv, adminId);
      await subscribe(a, pub, adminId);
      const samConn = await subscribe(s, priv, samId);
      await subscribe(s, pub, samId);
      await subscribe(s, left, samId);
      expect(samConn).toBeTruthy();

      // Admin removes Sam from the private channel: revoked within 1 s, admin sees Sam leave, eph refused.
      const t0 = Date.now();
      await ok(admin.request("DELETE", `/api/v1/channels/${privateId}/members/user/${samId}`));
      const revoked = await waitFor(() => revokedFor(s, priv), 1000);
      expect(revoked).toMatchObject({ op: "revoked", topic: priv, reason: "forbidden" });
      // A channel's authorizer gives no reason code: the frame has no `cause` (07.9-07, D-13 is additive).
      expect(revoked).not.toHaveProperty("cause");
      const offline = await waitFor(
        () =>
          a.frames.find(
            (f) =>
              f.op === "presence" &&
              f.topic === priv &&
              !f.full &&
              f.entries?.some((e) => e.conn === samConn && e.state === "offline"),
          ),
        1000,
      );
      console.info(`revocation latency (ms): revoked=${revoked.at - t0} offline=${offline.at - t0}`);

      const before = s.frames.length;
      s.send({ op: "eph", topic: priv, type: "user.typing", data: {} });
      await waitFor(() =>
        s.frames.slice(before).find((f) => f.op === "err" && f.code === "forbidden" && f.topic === priv),
      );
      expect((await sam.request("GET", `/api/v1/channels/${privateId}`)).status).toBe(404);

      // A public channel: removal keeps the read-only preview the resolver allows (D-06).
      await ok(admin.request("DELETE", `/api/v1/channels/${publicId}/members/user/${samId}`));
      await sleep(1000);
      expect(revokedFor(s, pub)).toBeUndefined();
      await ok(
        admin.request("POST", `/api/v1/conversations/${publicId}/messages`, {
          body: "still visible to previewers",
        }),
      );
      await waitFor(
        () => s.frames.find((f) => f.op === "ev" && f.topic === pub && f.type === "message.created"),
        1000,
      );

      // Leaving a private channel yourself also drops the stream.
      const t1 = Date.now();
      await ok(sam.request("POST", `/api/v1/channels/${leaveId}/leave`, {}));
      const leftRevoked = await waitFor(() => revokedFor(s, left), 1000);
      console.info(`revocation latency (ms): leave=${leftRevoked.at - t1}`);

      // Nobody else loses anything.
      expect(a.frames.some((f) => f.op === "revoked")).toBe(false);
    } finally {
      a.socket.close();
      s.socket.close();
    }
  });
});

/**
 * A second gateway on its own realtime service (the stack's db and bus) whose `conv` authorizer the test drives,
 * so races are deterministic. The stack's own gateway and resolver are untouched.
 */
async function controlledGateway() {
  const { db, bus, identity } = stack.built.core;
  const realtime: RealtimeService = createRealtimeService({ db, bus });
  const calls: string[] = [];
  let decide: (auth: AuthContext) => Promise<boolean> | boolean = () => true;
  realtime.registerTopicAuthorizer("conv", (auth) => {
    calls.push(auth.userId);
    return decide(auth);
  });
  const mini = Fastify({ logger: false });
  await mini.register(websocket, {
    options: { handleProtocols: (p: Set<string>) => (p.has(WS_PROTOCOL) ? WS_PROTOCOL : false) },
  });
  const module = createRealtimeModule({ realtime, identity, bus, allowedOrigins: new Set([WEB_ORIGIN]) });
  await mini.register(async (scope) => module.register(scope as unknown as App));
  await mini.listen({ host: "127.0.0.1", port: 0 });
  const addr = mini.server.address();
  return {
    base: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`,
    realtime,
    calls,
    setDecide: (fn: (auth: AuthContext) => Promise<boolean> | boolean) => {
      decide = fn;
    },
    close: () => mini.close(),
  };
}

const subscribedTo = (s: Sock, topic: string) =>
  s.frames.find((f) => f.op === "subscribed" && f.topic === topic);

describe("re-decisions are race-free and fail safe (RT-01, D-05)", () => {
  it("in-flight: a subscribe decided before a concurrent invalidation is re-decided once it is live", async () => {
    const gw = await controlledGateway();
    const s = await openSocket(gw.base, await sam.token());
    try {
      const topic = `conv:${randomUUID()}`;
      let release!: (v: boolean) => void;
      const held = new Promise<boolean>((r) => {
        release = r;
      });
      gw.setDecide(() => (gw.calls.length === 1 ? held : false));
      s.send({ op: "sub", topic });
      await waitFor(() => gw.calls.length === 1);
      await gw.realtime.invalidateSubscriptions({ organizationId: orgId, userIds: [samId] });
      await sleep(200); // the invalidation reached the gateway while the first decision was still held
      const t0 = Date.now();
      release(true);
      await waitFor(() => revokedFor(s, topic), 1000);
      console.info(`in-flight re-decision revoked after ${Date.now() - t0} ms`);
      expect(gw.calls.length).toBe(2);
    } finally {
      s.socket.close();
      await gw.close();
    }
  });

  it("transient: an authorizer error keeps the subscription live; the next invalidation that denies revokes", async () => {
    const gw = await controlledGateway();
    const s = await openSocket(gw.base, await sam.token());
    try {
      const topic = `conv:${randomUUID()}`;
      s.send({ op: "sub", topic });
      await waitFor(() => subscribedTo(s, topic));
      gw.setDecide(() => {
        throw new Error("database hiccup");
      });
      const before = gw.calls.length;
      await gw.realtime.invalidateSubscriptions({ organizationId: orgId, userIds: [samId] });
      await waitFor(() => gw.calls.length > before);
      await sleep(500);
      expect(revokedFor(s, topic)).toBeUndefined();
      await gw.realtime.publishEphemeral(topic, "user.typing", { userId: adminId });
      await waitFor(() => s.frames.find((f) => f.op === "eph" && f.topic === topic), 1000);

      gw.setDecide(() => false);
      await gw.realtime.invalidateSubscriptions({ organizationId: orgId, userIds: [samId], topics: [topic] });
      await waitFor(() => revokedFor(s, topic), 1000);
    } finally {
      s.socket.close();
      await gw.close();
    }
  });

  it("storm: 50 invalidations back to back cost at most two re-decisions per subscription", async () => {
    const gw = await controlledGateway();
    const s = await openSocket(gw.base, await sam.token());
    try {
      const topic = `conv:${randomUUID()}`;
      s.send({ op: "sub", topic });
      await waitFor(() => subscribedTo(s, topic));
      gw.setDecide(async () => {
        await sleep(100); // a realistic decision time: the burst lands while the first one runs
        return true;
      });
      const before = gw.calls.length;
      await Promise.all(
        Array.from({ length: 50 }, () =>
          gw.realtime.invalidateSubscriptions({ organizationId: orgId, userIds: [samId] }),
        ),
      );
      await sleep(1000);
      const runs = gw.calls.length - before;
      console.info(`storm: ${runs} re-decisions for 50 invalidations`);
      expect(runs).toBeGreaterThanOrEqual(1);
      expect(runs).toBeLessThanOrEqual(2);
      expect(revokedFor(s, topic)).toBeUndefined();
      await gw.realtime.publishEphemeral(topic, "user.typing", { userId: adminId });
      await waitFor(() => s.frames.find((f) => f.op === "eph" && f.topic === topic), 1000);
    } finally {
      s.socket.close();
      await gw.close();
    }
  });

  it("scope: another organization or another user never re-decides this connection", async () => {
    const gw = await controlledGateway();
    const s = await openSocket(gw.base, await sam.token());
    try {
      const topic = `conv:${randomUUID()}`;
      s.send({ op: "sub", topic });
      await waitFor(() => subscribedTo(s, topic));
      gw.setDecide(() => false);
      const before = gw.calls.length;
      await gw.realtime.invalidateSubscriptions({ organizationId: randomUUID(), userIds: [samId] });
      await gw.realtime.invalidateSubscriptions({ organizationId: randomUUID() });
      await gw.realtime.invalidateSubscriptions({ organizationId: orgId, userIds: [adminId] });
      await gw.realtime.invalidateSubscriptions({ organizationId: orgId, topics: [`conv:${randomUUID()}`] });
      await sleep(500);
      expect(gw.calls.length).toBe(before);
      expect(revokedFor(s, topic)).toBeUndefined();
    } finally {
      s.socket.close();
      await gw.close();
    }
  });
});

describe("overlapping subscribes (latest wins)", () => {
  it("an older sub decided last never overwrites a newer presence sub; an unsub mid-decision wins", async () => {
    const gw = await controlledGateway();
    const s = await openSocket(gw.base, await sam.token());
    const a = await openSocket(gw.base, await admin.token());
    try {
      // 1. Background sub (held) then presence sub (immediate): the presence sub must stay the live one.
      const topic = `conv:${randomUUID()}`;
      let release!: (v: boolean) => void;
      const held = new Promise<boolean>((r) => {
        release = r;
      });
      gw.setDecide((auth) => (auth.userId === samId && gw.calls.length === 1 ? held : true));
      s.send({ op: "sub", topic });
      await waitFor(() => gw.calls.length === 1);
      s.send({ op: "sub", topic, presence: true });
      await waitFor(() => s.frames.find((f) => f.op === "presence" && f.topic === topic && f.full));
      release(true);
      await sleep(200);
      const adminConn = await subscribe(a, topic, adminId);
      await waitFor(
        () =>
          s.frames.find(
            (f) =>
              f.op === "presence" &&
              f.topic === topic &&
              !f.full &&
              f.entries?.some((e) => e.conn === adminConn),
          ),
        1000,
      );

      // 2. A sub whose decision is still running when the client unsubscribes never goes live.
      const other = `conv:${randomUUID()}`;
      let release2!: (v: boolean) => void;
      const held2 = new Promise<boolean>((r) => {
        release2 = r;
      });
      const n = gw.calls.length;
      gw.setDecide((auth) => (auth.userId === samId && gw.calls.length === n + 1 ? held2 : true));
      s.send({ op: "sub", topic: other, presence: true });
      await waitFor(() => gw.calls.length === n + 1);
      s.send({ op: "unsub", topic: other });
      await sleep(100);
      release2(true);
      await sleep(300);
      expect(subscribedTo(s, other)).toBeUndefined();
      a.send({ op: "sub", topic: other, presence: true });
      const snap = await waitFor(() =>
        a.frames.find((f) => f.op === "presence" && f.topic === other && f.full),
      );
      expect(snap.entries?.some((e) => e.userId === samId)).toBe(false);
    } finally {
      s.socket.close();
      a.socket.close();
      await gw.close();
    }
  });
});

/** Records every live re-decision the stack's gateway makes (the gateway calls the service method per job). */
function watchReauth() {
  const rt = stack.built.core.realtime;
  const original = rt.reauthorizeTopic;
  const calls: Array<{ userId: string; topic: string; verdict: Reauthorization }> = [];
  rt.reauthorizeTopic = async (auth, topic) => {
    const verdict = await original(auth, topic);
    calls.push({ userId: auth.userId, topic, verdict });
    return verdict;
  };
  return {
    calls,
    restore: () => {
      rt.reauthorizeTopic = original;
    },
  };
}

const messageOn = (s: Sock, topic: string, from: number) =>
  s.frames.slice(from).find((f) => f.op === "ev" && f.topic === topic && f.type === "message.created");

describe("organization access changes re-decide live subscriptions (RT-01, D-05)", () => {
  it("an explicit deny rule on channel.read revokes within a second; deleting it revokes nothing else", async () => {
    const publicId = await channel("rules-watch", "public");
    await ok(sam.request("POST", `/api/v1/channels/${publicId}/join`, {}));
    const pub = `conv:${publicId}`;
    const a = await openSocket(stack.baseUrl, await admin.token());
    const s = await openSocket(stack.baseUrl, await sam.token());
    let ruleId: string | null = null;
    try {
      await subscribe(a, pub, adminId);
      await subscribe(s, pub, samId);
      const t0 = Date.now();
      const rule = await ok(
        admin.request("POST", "/api/v1/permission-rules", {
          subjectKind: "user",
          subjectId: samId,
          permission: "channel.read",
          effect: "deny",
        }),
      );
      ruleId = rule.id as string;
      const revoked = await waitFor(() => revokedFor(s, pub), 1000);
      console.info(`revocation latency (ms): deny rule=${revoked.at - t0}`);

      await ok(admin.request("DELETE", `/api/v1/permission-rules/${ruleId}`));
      ruleId = null;
      await sleep(500);
      expect(a.frames.some((f) => f.op === "revoked")).toBe(false);
      expect(s.frames.filter((f) => f.op === "revoked").length).toBe(1);
      // Access is back: Sam subscribes again and both keep streaming.
      const from = s.frames.length;
      await subscribe(s, pub, samId);
      const aFrom = a.frames.length;
      await ok(admin.request("POST", `/api/v1/conversations/${publicId}/messages`, { body: "rule gone" }));
      await waitFor(() => messageOn(s, pub, from), 1000);
      await waitFor(() => messageOn(a, pub, aFrom), 1000);
    } finally {
      if (ruleId) await admin.request("DELETE", `/api/v1/permission-rules/${ruleId}`);
      a.socket.close();
      s.socket.close();
    }
  });

  it("a unit membership change re-decides Sam's subscriptions and keeps the ones still allowed", async () => {
    const publicId = await channel("units-watch", "public");
    const privateId = await channel("units-private", "private");
    await ok(sam.request("POST", `/api/v1/channels/${publicId}/join`, {}));
    await addSam(privateId);
    const pub = `conv:${publicId}`;
    const priv = `conv:${privateId}`;
    const s = await openSocket(stack.baseUrl, await sam.token());
    const spy = watchReauth();
    try {
      await subscribe(s, pub, samId);
      await subscribe(s, priv, samId);
      const unit = await ok(
        admin.request("POST", "/api/v1/units", { kind: "department", name: "Ops", parentId: null }),
      );
      await ok(admin.request("POST", `/api/v1/units/${unit.id as string}/members`, { userId: samId }));
      await waitFor(() => {
        const mine = spy.calls.filter((c) => c.userId === samId);
        return mine.some((c) => c.topic === pub) && mine.some((c) => c.topic === priv);
      }, 1000);
      expect(spy.calls.every((c) => c.verdict === "allowed")).toBe(true);
      expect(revokedFor(s, pub)).toBeUndefined();
      expect(revokedFor(s, priv)).toBeUndefined();
      const from = s.frames.length;
      await ok(admin.request("POST", `/api/v1/conversations/${publicId}/messages`, { body: "still here" }));
      await ok(admin.request("POST", `/api/v1/conversations/${privateId}/messages`, { body: "still here" }));
      await waitFor(() => messageOn(s, pub, from) && messageOn(s, priv, from), 1000);
    } finally {
      spy.restore();
      s.socket.close();
    }
  });

  it("a profile-only member update re-decides nothing", async () => {
    const publicId = await channel("profile-watch", "public");
    await ok(sam.request("POST", `/api/v1/channels/${publicId}/join`, {}));
    const s = await openSocket(stack.baseUrl, await sam.token());
    const spy = watchReauth();
    try {
      await subscribe(s, `conv:${publicId}`, samId);
      s.send({ op: "sub", topic: `org:${orgId}` });
      await waitFor(() => subscribedTo(s, `org:${orgId}`));
      const from = s.frames.length;
      await ok(sam.request("PATCH", "/api/v1/me/profile", { statusText: "heads down" }));
      // The member.updated event itself arrives; no re-decision follows it.
      await waitFor(() =>
        s.frames
          .slice(from)
          .find((f) => f.op === "ev" && f.topic === `org:${orgId}` && f.type === "member.updated"),
      );
      await sleep(500);
      expect(spy.calls).toEqual([]);
    } finally {
      spy.restore();
      s.socket.close();
    }
  });
});

describe("periodic backstop (RT-01, T-03-06-03)", () => {
  it("a lost invalidation is caught by the recheck: a silently removed member is revoked within a second", async () => {
    const { realtime, identity, bus } = stack.built.core;
    const mini = Fastify({ logger: false });
    await mini.register(websocket, {
      options: { handleProtocols: (p: Set<string>) => (p.has(WS_PROTOCOL) ? WS_PROTOCOL : false) },
    });
    const module = createRealtimeModule({
      realtime,
      identity,
      bus,
      allowedOrigins: new Set([WEB_ORIGIN]),
      sessionRecheckMs: 200,
    });
    await mini.register(async (scope) => module.register(scope as unknown as App));
    await mini.listen({ host: "127.0.0.1", port: 0 });
    const addr = mini.server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const su = new pg.Client({ connectionString: stack.db.superuserUrl });
    await su.connect();
    const privateId = await channel("backstop", "private");
    const publicId = await channel("backstop-open", "public");
    await addSam(privateId);
    await ok(sam.request("POST", `/api/v1/channels/${publicId}/join`, {}));
    const priv = `conv:${privateId}`;
    const pub = `conv:${publicId}`;
    const s = await openSocket(base, await sam.token());
    try {
      await subscribe(s, priv, samId);
      await subscribe(s, pub, samId);
      await sleep(500); // a few recheck ticks: still allowed, nothing revoked
      expect(revokedFor(s, priv)).toBeUndefined();
      // No event, no invalidation: as if the message had been lost.
      const t0 = Date.now();
      await su.query(
        "delete from app.conversation_members where conversation_id = $1 and member_kind = 'user' and member_id = $2",
        [privateId, samId],
      );
      const revoked = await waitFor(() => revokedFor(s, priv), 1000);
      console.info(`backstop revoked after ${revoked.at - t0} ms`);
      await sleep(300);
      expect(revokedFor(s, pub)).toBeUndefined();
    } finally {
      s.socket.close();
      await su.end();
      await mini.close();
    }
  });
});

// ---------------------------------------------------------------- Phase 07.9-07: Work Zone sessions (D-04, D-13)

/**
 * Narrowing who may see a session takes the live view away within a second, with the reason as a code (ADR-0009, D-04,
 * D-13, P-09): `visibility` when the audience or the project changed, `module` when Work Zone was turned off, `role`
 * otherwise. People still allowed keep their subscription.
 *
 * Cast (this file's organization): Dora (lead, owns the device with `reauth-api` linked to the team project Orion and
 * the personal repo `reauth-notes`), Ana (developer, Orion member and a grant on the device: creates the sessions), Pia,
 * Leo, Wes and Rae (developers, Orion members), Kim (developer, in the team Platform assigned to Orion), Gus (developer,
 * a grant on the device, not in Orion).
 */
describe("narrowing a Work Zone session re-decides its live subscribers, with a cause (07.9-07, D-04, D-13)", () => {
  const people: Record<string, { client: TestClient; userId: string }> = {};
  let device: FakeDevice;
  let deviceId: string;
  let orion: string;
  let platform: string;
  let apiRepo: string;
  /** A session on the repo linked to Orion (audience `project`). */
  let team: string;
  /** A session on the personal repo (audience: the device owner, its grantees, admins). */
  let personal: string;
  const sockets: Record<string, Sock> = {};

  const who = (name: string) => people[name]!;
  const subscribeWs = async (name: string, sessionId: string) => {
    const s = sockets[name]!;
    s.send({ op: "sub", topic: `ws:${sessionId}` });
    const answer = await waitFor(() =>
      s.frames.find((f) => (f.op === "subscribed" || f.op === "err") && f.topic === `ws:${sessionId}`),
    );
    expect(answer.op, `${name} follows ws:${sessionId}`).toBe("subscribed");
  };
  /** `name` loses `ws:<sessionId>` within a second of `t0`, with `cause`. */
  const lostWithin = async (name: string, sessionId: string, cause: string, t0: number) => {
    const revoked = await waitFor(() => revokedFor(sockets[name]!, `ws:${sessionId}`), 1000);
    expect(revoked, name).toMatchObject({ op: "revoked", reason: "forbidden", cause });
    console.info(`work session revocation latency (ms): ${name} ${cause}=${revoked.at - t0}`);
  };
  const keeps = (name: string, sessionId: string) =>
    expect(revokedFor(sockets[name]!, `ws:${sessionId}`), `${name} keeps ws:${sessionId}`).toBeUndefined();

  beforeAll(async () => {
    for (const [name, role] of [
      ["Dora", "lead"],
      ["Ana", "developer"],
      ["Pia", "developer"],
      ["Leo", "developer"],
      ["Wes", "developer"],
      ["Rae", "developer"],
      ["Kim", "developer"],
      ["Gus", "developer"],
    ] as const) {
      people[name] = await invite(stack, admin, `${name.toLowerCase()}@example.test`, name, role);
    }
    const paired = await pairDevice(stack, who("Dora").client, "Dora's Orion Laptop");
    deviceId = paired.deviceId;
    device = await FakeDevice.connect(stack.baseUrl, paired.token);
    device.send({
      type: "projects.sync",
      projects: [
        { localId: "lp_api", name: "reauth-api", gitRemote: null, defaultBranch: "main" },
        { localId: "lp_notes", name: "reauth-notes", gitRemote: null, defaultBranch: "main" },
      ],
    });
    await device.next((f) => f.type === "projects.ack");
    device.capabilities([CLAUDE_CATALOG], false);
    const su = new pg.Client({ connectionString: stack.db.superuserUrl });
    await su.connect();
    try {
      await eventually(async () => {
        const r = await su.query("select runtime_catalog from app.devices where id = $1", [deviceId]);
        return (r.rows[0].runtime_catalog as unknown[]).length === 1;
      });
    } finally {
      await su.end();
    }
    const repos = (await ok(who("Dora").client.request("GET", "/api/v1/projects"))).projects as Array<{
      id: string;
      name: string;
    }>;
    apiRepo = repos.find((p) => p.name === "reauth-api")!.id;
    const notesRepo = repos.find((p) => p.name === "reauth-notes")!.id;
    await shareDevice(who("Dora").client, deviceId, who("Ana").userId, "acceptEdits");
    await shareDevice(who("Dora").client, deviceId, who("Gus").userId);

    orion = (
      await createTeamProject(stack, admin, {
        name: "Orion",
        members: [
          { userId: who("Dora").userId, role: "lead" },
          ...["Ana", "Pia", "Leo", "Wes", "Rae"].map((n) => ({ userId: who(n).userId })),
        ],
      })
    ).unitId;
    const eng = await ok(
      admin.request("POST", "/api/v1/units", {
        kind: "department",
        name: "Orion engineering",
        parentId: null,
      }),
    );
    platform = (
      await ok(admin.request("POST", "/api/v1/units", { kind: "team", name: "Platform", parentId: eng.id }))
    ).id as string;
    await ok(admin.request("POST", `/api/v1/units/${platform}/members`, { userId: who("Kim").userId }));
    await ok(admin.request("POST", `/api/v1/work-projects/${orion}/teams`, { unitId: platform }));
    await ok(
      who("Dora").client.request("POST", `/api/v1/work-projects/${orion}/repos`, { projectId: apiRepo }),
    );

    team = await startSession(who("Ana").client, device, apiRepo, { title: "Orion live view" });
    personal = await startSession(who("Ana").client, device, notesRepo, { title: "Personal live view" });
    for (const name of Object.keys(people)) {
      sockets[name] = await openSocket(stack.baseUrl, await who(name).client.token());
    }
  }, 240_000);

  afterAll(async () => {
    for (const s of Object.values(sockets)) s.socket.close();
    await device?.close().catch(() => {});
  });

  it("everyone the audience names follows the session; Gus follows the personal one", async () => {
    for (const name of ["Dora", "Ana", "Pia", "Leo", "Wes", "Rae", "Kim"]) await subscribeWs(name, team);
    for (const name of ["Dora", "Ana", "Gus"]) await subscribeWs(name, personal);
  });

  it("removing Leo from the project unit revokes him (visibility); the others keep it", async () => {
    const t0 = Date.now();
    await ok(admin.request("DELETE", `/api/v1/units/${orion}/members/${who("Leo").userId}`));
    await lostWithin("Leo", team, "visibility", t0);
    await sleep(300);
    for (const name of ["Dora", "Ana", "Pia", "Wes", "Rae", "Kim"]) keeps(name, team);
  });

  it("unassigning the team that gave Kim access revokes Kim (visibility)", async () => {
    const t0 = Date.now();
    await ok(admin.request("DELETE", `/api/v1/work-projects/${orion}/teams/${platform}`));
    await lostWithin("Kim", team, "visibility", t0);
    await sleep(300);
    for (const name of ["Dora", "Ana", "Pia", "Wes", "Rae"]) keeps(name, team);
  });

  it("revoking Gus's device grant revokes his view of the personal session (visibility)", async () => {
    const t0 = Date.now();
    await ok(
      who("Dora").client.request("DELETE", `/api/v1/devices/${deviceId}/grants/user/${who("Gus").userId}`),
    );
    await lostWithin("Gus", personal, "visibility", t0);
    await sleep(300);
    for (const name of ["Dora", "Ana"]) keeps(name, personal);
    for (const name of ["Dora", "Ana", "Pia", "Wes", "Rae"]) keeps(name, team);
  });

  it("turning Work Zone off for Wes's unit revokes him (module)", async () => {
    const ops = await ok(
      admin.request("POST", "/api/v1/units", { kind: "department", name: "Orion support", parentId: null }),
    );
    await ok(admin.request("POST", `/api/v1/units/${ops.id}/members`, { userId: who("Wes").userId }));
    await sleep(300);
    keeps("Wes", team);
    const t0 = Date.now();
    await ok(
      admin.request("PUT", "/api/v1/module-access", {
        module: "work_zone",
        scopeUnitId: ops.id,
        subject: { kind: "everyone" },
        enabled: false,
      }),
    );
    await lostWithin("Wes", team, "module", t0);
    await sleep(300);
    for (const name of ["Dora", "Ana", "Pia", "Rae"]) keeps(name, team);
  });

  it("downgrading Rae to standard revokes her (role)", async () => {
    const t0 = Date.now();
    await ok(admin.request("PATCH", `/api/v1/members/${who("Rae").userId}/role`, { role: "standard" }));
    await lostWithin("Rae", team, "role", t0);
    await sleep(300);
    for (const name of ["Dora", "Ana", "Pia"]) keeps(name, team);
  });

  it("unlinking the repo revokes project members without device use (visibility); the owner and grantees keep it", async () => {
    const t0 = Date.now();
    await ok(admin.request("DELETE", `/api/v1/work-projects/${orion}/repos/${apiRepo}`));
    await lostWithin("Pia", team, "visibility", t0);
    await sleep(300);
    for (const name of ["Dora", "Ana"]) keeps(name, team);
    for (const name of ["Dora", "Ana"]) keeps(name, personal);
  });
});
