import { randomUUID } from "node:crypto";
import { encodeWorkBrowserFrame, LiveServerFrame } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice, sleep } from "../../testing-device";
import { invite, pairDevice, shareDevice, startSession } from "../../testing-workzone";
import {
  fakeJpeg,
  lastState,
  upgradeStatus,
  type WorkLiveSocket,
  waitFor,
  waitState,
  workLiveSocket,
  workLiveUrl,
} from "./live-testing";

/**
 * The Work Zone live view (Phase 07.13-10; D-15, D-20, D-27, PD-12, PD-13): the session's audience watches the page the
 * session drives on its device. `GET /api/v1/live/work-browser/:sessionId` is opened like `/ws` (allowed Origin and the
 * `ocw.auth.<jwt>` subprotocol); `work_session.read` on the session decides who watches. The API asks the device for
 * frames (`browser.frames { on: true }`) only while someone watches, and a per-frame privacy gate keeps a loaded
 * sign-in or a takeover private. Real PostgreSQL and Redis; the fake daemon speaks the Device Link.
 */

const ADMIN = { name: "Ada Admin", email: "ada@example.test", password: "correct-horse-battery" };
const ORIGIN = "http://localhost:3000";

let stack: TestStack;
let su: pg.Client;
let ada: TestClient;
let owen: TestClient;
let owenId: string;
/** Mia may use Owen's device: she is in the audience of his personal sessions. */
let mia: TestClient;
let miaId: string;
/** Nia is a member outside every session's audience. */
let nia: TestClient;
let dId: string;
let d: FakeDevice;
/** Ada's device (also has a browser): its frames never reach Owen's sessions' viewers. */
let a: FakeDevice;
let projectId: string;
const sockets: WorkLiveSocket[] = [];

const hub = () => {
  const h = stack.built.workBrowser.live();
  if (!h) throw new Error("live view not registered");
  return h;
};

async function open(who: TestClient, sessionId: string): Promise<WorkLiveSocket> {
  const s = await workLiveSocket(stack.baseUrl, await who.token(), sessionId);
  sockets.push(s);
  return s;
}

/** A fresh session of Owen's with an open page on ORIGIN (the row is `open`). */
async function sessionWithPage(): Promise<string> {
  const id = await startSession(owen, d, projectId);
  d.browserEvent(id, { kind: "opened", origin: ORIGIN });
  await eventually(async () => {
    const res = await su.query("select state from app.work_browsers where work_session_id = $1", [id]);
    return (res.rows[0] as { state?: string } | undefined)?.state === "open";
  });
  return id;
}

function frame(sessionId: string, jpeg: Uint8Array): Uint8Array {
  const bytes = encodeWorkBrowserFrame({ sessionId, width: 960, height: 600, jpeg });
  if (!bytes) throw new Error("frame did not encode");
  return bytes;
}

const framesFor = (dev: FakeDevice, sessionId: string, on: boolean) =>
  dev.frames.filter((f) => f.type === "browser.frames" && f.sessionId === sessionId && f.on === on).length;

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
  ({ client: owen, userId: owenId } = await invite(stack, ada, "owen@example.test", "Owen", "developer"));
  ({ client: mia, userId: miaId } = await invite(stack, ada, "mia@example.test", "Mia Lopez", "developer"));
  ({ client: nia } = await invite(stack, ada, "nia@example.test", "Nia", "developer"));

  const paired = await pairDevice(stack, owen, "Owen's Mac");
  dId = paired.deviceId;
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
  await shareDevice(owen, dId, miaId);

  const adaDevice = await pairDevice(stack, ada, "Ada's box");
  a = await FakeDevice.connect(stack.baseUrl, adaDevice.token, undefined, {
    browser: { version: 1, optIn: true },
  });
}, 240_000);

afterAll(async () => {
  for (const s of sockets) s.socket.terminate();
  await d?.close().catch(() => {});
  await a?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

describe("07.13-10 Task 1: a session reader watches the device's frames live (tracer)", () => {
  it("the creator gets viewerCan then state, the device is asked for frames, its JPEG reaches the viewer, and closing stops it", async () => {
    const sessionId = await sessionWithPage();
    const owenLive = await open(owen, sessionId);
    await waitFor(() => owenLive.json.length >= 2);
    for (const f of owenLive.json) expect(LiveServerFrame.safeParse(f).success, JSON.stringify(f)).toBe(true);
    expect(owenLive.json[0]).toEqual({ type: "viewerCan", watch: true, control: false });
    expect(owenLive.json[1]).toMatchObject({ type: "state", state: "live", controller: null });
    await d.next((f) => f.type === "browser.frames" && f.sessionId === sessionId && f.on === true);

    const jpeg = fakeJpeg(7);
    await d.sendBinary(frame(sessionId, jpeg));
    await waitFor(() => owenLive.binary.length >= 1);
    expect(new Uint8Array(owenLive.binary[0]!)).toEqual(jpeg);

    owenLive.close();
    await owenLive.closed;
    await d.next((f) => f.type === "browser.frames" && f.sessionId === sessionId && f.on === false);
    await waitFor(() => hub().stats().sessions.length === 0);
  });

  it("a frame for another session, or from another device, reaches nobody", async () => {
    const sessionId = await sessionWithPage();
    const other = await sessionWithPage();
    const owenLive = await open(owen, sessionId);
    await waitState(owenLive, "live");
    await d.next((f) => f.type === "browser.frames" && f.sessionId === sessionId && f.on === true);

    // Ada's device names Owen's session: refused (the session runs on Owen's device).
    await a.sendBinary(frame(sessionId, fakeJpeg(1)));
    // Owen's device sends a frame of a session nobody watches.
    await d.sendBinary(frame(other, fakeJpeg(2)));
    await sleep(600);
    expect(owenLive.binary).toHaveLength(0);

    // The real one still passes (the link is healthy, the viewer is waiting).
    const jpeg = fakeJpeg(3);
    await d.sendBinary(frame(sessionId, jpeg));
    await waitFor(() => owenLive.binary.length >= 1);
    expect(owenLive.binary.map((b) => new Uint8Array(b)[3])).toEqual([3]);
    owenLive.close();
    await owenLive.closed;
  });

  it("a member outside the session's audience is closed with 4403 and receives no frame", async () => {
    const sessionId = await sessionWithPage();
    const before = framesFor(d, sessionId, true);
    const niaLive = await open(nia, sessionId);
    const { code } = await niaLive.closed;
    expect(code).toBe(4403);
    expect(lastState(niaLive)).toMatchObject({ state: "no_permission" });
    expect(niaLive.binary).toHaveLength(0);
    // Nobody allowed watched: the device was never asked for frames.
    await sleep(300);
    expect(framesFor(d, sessionId, true)).toBe(before);
  });

  it("an unknown session id is no_permission; a malformed id is 404; no token or a foreign Origin is refused before the upgrade", async () => {
    const unknown = await open(owen, randomUUID());
    expect((await unknown.closed).code).toBe(4403);
    expect(await upgradeStatus(workLiveUrl(stack.baseUrl, "not-a-uuid"), { token: await owen.token() })).toBe(
      404,
    );
    const sessionId = await sessionWithPage();
    expect(await upgradeStatus(workLiveUrl(stack.baseUrl, sessionId), { token: null })).toBe(401);
    expect(
      await upgradeStatus(workLiveUrl(stack.baseUrl, sessionId), {
        token: await owen.token(),
        origin: "https://evil.example",
      }),
    ).toBe(403);
  });
});
