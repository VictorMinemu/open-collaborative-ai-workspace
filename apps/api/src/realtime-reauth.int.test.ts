import { WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "./testing";

/**
 * RT-01 live re-authorisation (03-04, D-05/D-06) against the real stack: a membership change re-decides the
 * affected live subscriptions through the `conv` topic authorizer (the Phase 2 resolver). Losing channel.read
 * drops the subscription with a `revoked` frame; a public channel keeps its read-only preview.
 */

let stack: TestStack;
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
