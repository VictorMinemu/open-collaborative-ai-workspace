import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { encodeWorkBrowserFrame } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BuiltApp } from "../../app";
import type { Core } from "../../core";
import { RedisBus } from "../../lib/redis";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { startSecondInstance } from "../../testing-ai";
import { eventually, FakeDevice, sleep } from "../../testing-device";
import { invite, pairDevice, startSession } from "../../testing-workzone";
import { createLiveRelay, framesChannel, watchChannel } from "./live-relay";
import { fakeJpeg, type WorkLiveSocket, waitFor, waitState, workLiveSocket } from "./live-testing";

/**
 * Viewers on another API instance (Phase 07.13-10; D-33, PD-12): the instance holding the device link fans frames out
 * to its own viewers and publishes them on `ocw:wb:frames:<sessionId>` only while another instance pinged
 * `ocw:wb:watch:<sessionId>` in the last `watchLapseMs`. Transit only: nothing of a frame is persisted or logged.
 * Real PostgreSQL and Redis, two API instances on them.
 */

const ADMIN = { name: "Ada Admin", email: "ada@example.test", password: "correct-horse-battery" };
const ORIGIN = "http://localhost:3000";

let stack: TestStack;
let second: { built: BuiltApp; baseUrl: string; stop(): Promise<void> };
let su: pg.Client;
let owen: TestClient;
let d: FakeDevice;
let projectId: string;
const sockets: WorkLiveSocket[] = [];
const buses: RedisBus[] = [];

beforeAll(async () => {
  stack = await startTestStack();
  second = await startSecondInstance(stack);
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  const ada = new TestClient(stack.baseUrl);
  const setup = await ada.request("POST", "/api/v1/setup", {
    token: TEST_SETUP_TOKEN,
    ...ADMIN,
    orgName: "Autofy Labs",
  });
  expect(setup.status, JSON.stringify(setup.body)).toBe(200);
  ({ client: owen } = await invite(stack, ada, "owen@example.test", "Owen", "developer"));
  const paired = await pairDevice(stack, owen, "Owen's Mac");
  // The device link is on instance A (the stack's).
  d = await FakeDevice.connect(stack.baseUrl, paired.token, undefined, {
    browser: { version: 1, optIn: true },
  });
  d.send({
    type: "projects.sync",
    projects: [{ localId: "web", name: "web", gitRemote: null, defaultBranch: "main" }],
  });
  await d.next((f) => f.type === "projects.ack");
  const projects = (await owen.request("GET", "/api/v1/projects")).body!.projects as Array<{
    id: string;
    name: string;
  }>;
  projectId = projects.find((p) => p.name === "web")!.id;
}, 240_000);

afterAll(async () => {
  for (const s of sockets) s.socket.terminate();
  for (const b of buses) await b.close();
  await d?.close().catch(() => {});
  await second?.stop();
  await su?.end();
  await stack?.stop();
});

async function bus(): Promise<RedisBus> {
  const b = await RedisBus.connect(stack.redis.getConnectionUrl());
  buses.push(b);
  return b;
}

describe("07.13-10 Task 3: the relay publishes frames only while another instance watches", () => {
  it("no remote ping: nothing on the frames channel; a remote ping: the frame crosses as { w, h, b64 }; after the lapse: nothing again", async () => {
    const busA = await bus();
    const busB = await bus();
    const relayA = createLiveRelay({ bus: busA, instanceId: "A", lapseMs: 600 });
    const relayB = createLiveRelay({ bus: busB, instanceId: "B", lapseMs: 600 });
    const publish = vi.spyOn(busA, "publish");
    const sessionId = randomUUID();
    const frame = { sessionId, width: 960, height: 600, jpeg: fakeJpeg(5) };
    try {
      relayA.touch(sessionId);
      // A's own announcement is no remote watch.
      await relayA.announceWatch(sessionId);
      await sleep(200);
      expect(await relayA.publishFrame(sessionId, frame)).toBe(false);
      expect(publish.mock.calls.filter(([channel]) => channel === framesChannel(sessionId))).toHaveLength(0);

      const got: Uint8Array[] = [];
      const raw: string[] = [];
      const stopRaw = await busB.subscribe(framesChannel(sessionId), (m) => raw.push(m));
      const stop = await relayB.subscribeFrames(sessionId, (f) => got.push(f.jpeg));
      await eventually(async () => {
        await relayB.announceWatch(sessionId);
        return relayA.remoteWatching(sessionId);
      });
      expect(await relayA.publishFrame(sessionId, frame)).toBe(true);
      await waitFor(() => got.length >= 1);
      expect(new Uint8Array(got[0]!)).toEqual(frame.jpeg);
      const message = JSON.parse(raw[0]!) as Record<string, unknown>;
      expect(Object.keys(message).sort()).toEqual(["b64", "h", "i", "w"]);
      expect(message).toMatchObject({ w: 960, h: 600, i: "A" });
      expect(publish.mock.calls.some(([channel]) => channel === watchChannel(sessionId))).toBe(true);

      // A frame A published itself never comes back to A's own subscribers.
      const echoed: Uint8Array[] = [];
      const stopA = await relayA.subscribeFrames(sessionId, (f) => echoed.push(f.jpeg));
      await relayA.publishFrame(sessionId, frame);
      await waitFor(() => got.length >= 2);
      await sleep(100);
      expect(echoed).toHaveLength(0);
      await stopA();

      await sleep(800);
      const before = publish.mock.calls.filter(([channel]) => channel === framesChannel(sessionId)).length;
      expect(relayA.remoteWatching(sessionId)).toBe(false);
      expect(await relayA.publishFrame(sessionId, frame)).toBe(false);
      expect(publish.mock.calls.filter(([channel]) => channel === framesChannel(sessionId))).toHaveLength(
        before,
      );
      await stop();
      await stopRaw();
    } finally {
      await relayA.close();
      await relayB.close();
    }
  });

  it("a malformed or oversize message on the frames channel reaches no subscriber", async () => {
    const busB = await bus();
    const relayB = createLiveRelay({ bus: busB, instanceId: "B" });
    const sessionId = randomUUID();
    const got: Uint8Array[] = [];
    const stop = await relayB.subscribeFrames(sessionId, (f) => got.push(f.jpeg));
    try {
      const pub = await bus();
      for (const m of [
        "not json",
        JSON.stringify({ i: "X", w: 0, h: 600, b64: "AAAA" }),
        JSON.stringify({ i: "X", w: 960, h: 600, b64: "" }),
        JSON.stringify({ i: "X", w: 960, h: 600, b64: Buffer.alloc(300 * 1024).toString("base64") }),
      ]) {
        await pub.publish(framesChannel(sessionId), m);
      }
      await pub.publish(
        framesChannel(sessionId),
        JSON.stringify({ i: "X", w: 960, h: 600, b64: "/9j/AA==" }),
      );
      await waitFor(() => got.length >= 1);
      await sleep(100);
      expect(got).toHaveLength(1);
    } finally {
      await stop();
      await relayB.close();
    }
  });
});

/** Every argument any logger method of `core` received, while `fn` runs. */
async function logArgs(cores: Core[], fn: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const spies = cores.flatMap((c) =>
    (["trace", "debug", "info", "warn", "error", "fatal"] as const).map((level) =>
      vi.spyOn(c.log, level).mockImplementation(((...args: unknown[]) => {
        seen.push(...args);
      }) as never),
    ),
  );
  try {
    await fn();
  } finally {
    for (const s of spies) s.mockRestore();
  }
  return seen;
}

describe("07.13-10 Task 3: a viewer on another API instance", () => {
  it("the viewer on B gets the device's frames from A, B's ping reaches the device, and no logger sees a frame", async () => {
    const sessionId = await startSession(owen, d, projectId);
    d.browserEvent(sessionId, { kind: "opened", origin: ORIGIN });
    await eventually(async () => {
      const res = await su.query("select state from app.work_browsers where work_session_id = $1", [
        sessionId,
      ]);
      return (res.rows[0] as { state?: string } | undefined)?.state === "open";
    });
    const jpeg = fakeJpeg(41, 2048);
    const b64 = Buffer.from(jpeg).toString("base64");
    const args = await logArgs([stack.built.core, second.built.core], async () => {
      const viewer = await workLiveSocket(second.baseUrl, await owen.token(), sessionId);
      sockets.push(viewer);
      await waitState(viewer, "live");
      // B holds no link: its `browser.frames` crossed Redis to A, which holds the device's.
      await d.next((f) => f.type === "browser.frames" && f.sessionId === sessionId && f.on === true);
      const bytes = encodeWorkBrowserFrame({ sessionId, width: 960, height: 600, jpeg })!;
      const end = Date.now() + 8000;
      while (viewer.binary.length === 0) {
        if (Date.now() > end) throw new Error("no frame reached the viewer on B");
        await d.sendBinary(bytes);
        await sleep(150);
      }
      expect(new Uint8Array(viewer.binary[0]!)).toEqual(jpeg);
      viewer.close();
      await viewer.closed;
      await d.next((f) => f.type === "browser.frames" && f.sessionId === sessionId && f.on === false);
    });
    for (const arg of args) {
      expect(arg instanceof Uint8Array).toBe(false);
      // Fastify's own lines carry circular request objects: inspected, not stringified.
      expect(inspect(arg, { depth: 6, maxStringLength: null })).not.toContain(b64.slice(0, 40));
    }
  });
});
