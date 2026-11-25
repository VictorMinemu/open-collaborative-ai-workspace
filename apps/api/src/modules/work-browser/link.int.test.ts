import { randomUUID } from "node:crypto";
import { DEVICE_LINK_MAX_DEVICE_FRAME_BYTES } from "@ocw/contracts";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RedisBus } from "../../lib/redis";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice, sleep } from "../../testing-device";
import { invite, pairDevice } from "../../testing-workzone";
import { type DeviceBrowserHandler, DeviceHub } from "../device";

/**
 * The Device Link transport of the Work Zone browser (Phase 07.13-08, D-15, PD-12, PD-20, P7, research Pattern 6):
 * binary frames (live JPEGs) reach the browser handler OFF the JSON chain, so they never delay an `ack` and are never
 * parsed as JSON; `hub.sendBrowserFrame` sends a validated browser frame on the local link, or publishes it on the
 * device's Redis control channel for the instance that holds the link. Nothing is written to `device_commands`, and a
 * device whose hello carried no `browser` never receives one.
 */

const ADMIN = { name: "Ada Admin", email: "ada@example.test", password: "correct-horse-battery" };

let stack: TestStack;
let su: pg.Client;
let ada: TestClient;
let owen: TestClient;
/** Owen's device: has a browser. */
let dId: string;
let d: FakeDevice;
/** Ada's device: an older daemon without a browser. */
let aId: string;
let a: FakeDevice;
let projectId: string;
/** A second API instance's hub on the same Redis (no local links). */
let busB: RedisBus;
let hubB: DeviceHub;
const open: FakeDevice[] = [];
let original: DeviceBrowserHandler | null;
/** Byte lengths the test's `onBinary` saw, per device. */
let seen: Map<string, number[]>;

async function commandStatus(id: string): Promise<string> {
  const res = await su.query("select status from app.device_commands where id = $1", [id]);
  return (res.rows[0] as { status: string }).status;
}

async function commandCount(deviceId: string): Promise<number> {
  const res = await su.query("select count(*)::int as n from app.device_commands where device_id = $1", [
    deviceId,
  ]);
  return (res.rows[0] as { n: number }).n;
}

/** A session start for Owen's device; returns its `session.start` command id, delivered and not acked yet. */
async function pendingCommand(): Promise<string> {
  const res = await owen.request("POST", "/api/v1/work-sessions", { projectId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const start = await d.command("session.start", res.body!.id as string);
  await eventually(async () => (await commandStatus(start.id)) === "sent");
  return start.id;
}

/**
 * Frames of one socket are handled in order: once a `capabilities` frame sent now is stored (the opt-in flipped),
 * every JSON frame `dev` sent before it was handled.
 */
async function barrier(dev: FakeDevice, deviceId: string): Promise<void> {
  const read = async () =>
    (
      (await su.query("select browser_opt_in from app.devices where id = $1", [deviceId])).rows[0] as {
        browser_opt_in: boolean;
      }
    ).browser_opt_in;
  const before = await read();
  dev.capabilities([], false, undefined, { version: 1, optIn: !before });
  await eventually(async () => (await read()) === !before);
}

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  ada = new TestClient(stack.baseUrl);
  const setup = await ada.request("POST", "/api/v1/setup", {
    token: TEST_SETUP_TOKEN,
    ...ADMIN,
    orgName: "Autofy Labs",
  });
  expect(setup.status, JSON.stringify(setup.body)).toBe(200);
  ({ client: owen } = await invite(stack, ada, "owen@example.test", "Owen", "developer"));

  const paired = await pairDevice(stack, owen, "Owen's Mac");
  dId = paired.deviceId;
  d = await FakeDevice.connect(stack.baseUrl, paired.token, undefined, {
    browser: { version: 1, optIn: true },
  });
  open.push(d);
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

  const adaDevice = await pairDevice(stack, ada, "Ada's box");
  aId = adaDevice.deviceId;
  a = await FakeDevice.connect(stack.baseUrl, adaDevice.token);
  open.push(a);

  const core = stack.built.core;
  busB = await RedisBus.connect(stack.redis.getConnectionUrl());
  hubB = new DeviceHub({ db: core.db, bus: busB, realtime: core.realtime, audit: core.audit, log: core.log });

  // The test's binary handler records what it saw and never settles: were binaries on the JSON chain, no ack after
  // them would ever be applied.
  original = stack.built.deviceHub.browserHandler;
  seen = new Map();
  stack.built.deviceHub.setBrowserHandler({
    ...original,
    onBinary(device, bytes) {
      const list = seen.get(device.deviceId) ?? [];
      list.push(bytes.length);
      seen.set(device.deviceId, list);
      return new Promise<void>(() => {});
    },
  });
}, 240_000);

afterEach(() => {
  // No frame of these tests is ever refused as invalid (a binary frame is never parsed as JSON).
  for (const dev of open) expect(dev.frames.filter((f) => f.type === "error")).toEqual([]);
});

afterAll(async () => {
  if (original) stack?.built.deviceHub.setBrowserHandler(original);
  for (const dev of open) await dev.close().catch(() => {});
  await hubB?.closeAll();
  await busB?.close();
  await su?.end();
  await stack?.stop();
});

describe("07.13-08 Task 2: binary frames bypass the JSON chain", () => {
  it("30 binary frames of 100 KiB, then an ack: the ack is applied and the handler saw 30 buffers", async () => {
    const id = await pendingCommand();
    seen.set(dId, []);
    for (let i = 0; i < 30; i++) await d.sendBinary(Buffer.alloc(100 * 1024, i));
    d.ack(id);
    await eventually(async () => (await commandStatus(id)) === "acked", 5000);
    await eventually(async () => seen.get(dId)!.length === 30);
    expect(seen.get(dId)).toEqual(Array.from({ length: 30 }, () => 100 * 1024));
  });

  it("a binary frame holding JSON is never parsed: an ack sent as binary acks nothing", async () => {
    const id = await pendingCommand();
    seen.set(dId, []);
    await d.sendBinary(Buffer.from(JSON.stringify({ type: "ack", commandId: id, ok: true })));
    await barrier(d, dId);
    expect(await commandStatus(id)).toBe("sent");
    expect(seen.get(dId)).toHaveLength(1);
    d.ack(id);
    await eventually(async () => (await commandStatus(id)) === "acked");
  });

  it("a binary frame at the 256 KiB cap arrives whole; one above it is refused by ws `maxPayload` (1009)", async () => {
    const spare = await pairDevice(stack, owen, "Owen's spare");
    const s = await FakeDevice.connect(stack.baseUrl, spare.token, undefined, {
      browser: { version: 1, optIn: true },
    });
    open.push(s);
    await s.sendBinary(Buffer.alloc(DEVICE_LINK_MAX_DEVICE_FRAME_BYTES, 7));
    await eventually(async () => seen.get(spare.deviceId)?.length === 1);
    expect(seen.get(spare.deviceId)).toEqual([DEVICE_LINK_MAX_DEVICE_FRAME_BYTES]);

    const closed = new Promise<number>((resolve) => s.ws.once("close", (code) => resolve(code)));
    await s.sendBinary(Buffer.alloc(DEVICE_LINK_MAX_DEVICE_FRAME_BYTES + 1, 7)).catch(() => {});
    expect(await closed).toBe(1009);
    expect(seen.get(spare.deviceId)).toHaveLength(1);
    open.splice(open.indexOf(s), 1);
  });
});

describe("07.13-08 Task 2: browser frames reach the device from any instance, never through the queue", () => {
  it("on the instance holding the link: sent directly, and no device_commands row", async () => {
    const before = await commandCount(dId);
    const sessionId = randomUUID();
    const result = await stack.built.deviceHub.sendBrowserFrame(dId, {
      type: "browser.frames",
      sessionId,
      on: true,
    });
    expect(result).toBe("sent");
    expect(await d.next((f) => f.type === "browser.frames" && f.sessionId === sessionId)).toEqual({
      type: "browser.frames",
      sessionId,
      on: true,
    });
    expect(await commandCount(dId)).toBe(before);
  });

  it("from another instance: published, and the instance holding the link delivers it", async () => {
    const before = await commandCount(dId);
    expect(hubB.isConnectedHere(dId)).toBe(false);
    const sessionId = randomUUID();
    const leaseId = randomUUID();
    const result = await hubB.sendBrowserFrame(dId, {
      type: "browser.lease",
      sessionId,
      leaseId,
      state: "held",
    });
    expect(result).toBe("published");
    expect(await d.next((f) => f.type === "browser.lease" && f.sessionId === sessionId)).toEqual({
      type: "browser.lease",
      sessionId,
      leaseId,
      state: "held",
    });
    expect(await commandCount(dId)).toBe(before);
  });

  it("a device whose hello carried no `browser` never receives one (PD-20), locally or through Redis", async () => {
    const sessionId = randomUUID();
    const frame = { type: "browser.close", sessionId, reason: "policy" } as const;
    expect(await stack.built.deviceHub.sendBrowserFrame(aId, frame)).toBe("unsupported");
    expect(await hubB.sendBrowserFrame(aId, frame)).toBe("published");
    await sleep(500);
    expect(a.frames.filter((f) => f.type.startsWith("browser."))).toEqual([]);
  });

  it("an invalid browser frame is refused before sending", async () => {
    const hub = stack.built.deviceHub;
    await expect(
      hub.sendBrowserFrame(dId, { type: "browser.frames", sessionId: "not-a-uuid", on: true }),
    ).rejects.toThrow();
    await expect(
      hub.sendBrowserFrame(dId, {
        type: "browser.close",
        sessionId: randomUUID(),
        reason: "policy",
        note: "page text",
      } as unknown as Parameters<DeviceHub["sendBrowserFrame"]>[1]),
    ).rejects.toThrow();
    await expect(
      hubB.sendBrowserFrame(dId, {
        type: "welcome",
        deviceId: dId,
        organizationId: randomUUID(),
      } as unknown as Parameters<DeviceHub["sendBrowserFrame"]>[1]),
    ).rejects.toThrow();
    await sleep(200);
    expect(d.frames.filter((f) => f.type.startsWith("browser.") || f.type === "welcome")).toEqual([]);
  });
});
