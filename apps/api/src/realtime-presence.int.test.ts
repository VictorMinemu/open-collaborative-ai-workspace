import { WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
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
