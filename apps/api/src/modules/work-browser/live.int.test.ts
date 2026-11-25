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
/** Mia may use Owen's device: she is in the audience of his personal sessions. */
let mia: TestClient;
let miaId: string;
/** Nia is a member outside every session's audience. */
let nia: TestClient;
/** Eve is organization B's admin. */
let eve: TestClient;
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
  ({ client: owen } = await invite(stack, ada, "owen@example.test", "Owen", "developer"));
  ({ client: mia, userId: miaId } = await invite(stack, ada, "mia@example.test", "Mia Lopez", "developer"));
  ({ client: nia } = await invite(stack, ada, "nia@example.test", "Nia", "developer"));
  // Organization B: Eve moves into her own organization as its admin (tenant isolation).
  let eveId: string;
  ({ client: eve, userId: eveId } = await invite(stack, ada, "eve@example.test", "Eve", "developer"));
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    orgB,
    `evil-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [eveId]);
  await su.query("delete from app.org_members where user_id = $1", [eveId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    eveId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, eveId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, eveId]);

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

  it("tenant isolation: organization B's admin opening organization A's session is closed with 4403, gets no frame and starts no stream", async () => {
    const sessionId = await sessionWithPage();
    const before = framesFor(d, sessionId, true);
    const eveLive = await open(eve, sessionId);
    expect((await eveLive.closed).code).toBe(4403);
    expect(lastState(eveLive)).toMatchObject({ state: "no_permission", host: null });
    await d.sendBinary(frame(sessionId, fakeJpeg(9)));
    await sleep(300);
    expect(eveLive.binary).toHaveLength(0);
    expect(framesFor(d, sessionId, true)).toBe(before);
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

/** Sends frames from Owen's device until `until()` holds (the poll and the decisions are asynchronous). */
async function pump(sessionId: string, tag: number, until: () => boolean, timeoutMs = 6000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!until()) {
    if (Date.now() > end) throw new Error("frames never arrived");
    await d.sendBinary(frame(sessionId, fakeJpeg(tag)));
    await sleep(100);
  }
}

const tags = (s: WorkLiveSocket) => s.binary.map((b) => b[3]);

describe("07.13-10 Task 2: the privacy gate, states and live re-authorization", () => {
  it("a loaded sign-in is its member's alone: the others see `private member_session` with her name, and no frame until it is cleared", async () => {
    const sessionId = await sessionWithPage();
    const owenLive = await open(owen, sessionId);
    const miaLive = await open(mia, sessionId);
    await waitState(owenLive, "live");
    await waitState(miaLive, "live");

    await su.query("update app.work_browsers set signin_user_id = $2 where work_session_id = $1", [
      sessionId,
      miaId,
    ]);
    const priv = await waitState(owenLive, "private", 3000);
    expect(LiveServerFrame.safeParse(priv).success).toBe(true);
    expect(priv).toMatchObject({ privateReason: "member_session", memberName: "Mia Lopez", host: null });
    expect(lastState(miaLive)).toMatchObject({ state: "live" });

    await pump(sessionId, 11, () => tags(miaLive).includes(11));
    await sleep(300);
    expect(tags(owenLive)).not.toContain(11);

    await su.query("update app.work_browsers set signin_user_id = null where work_session_id = $1", [
      sessionId,
    ]);
    await waitState(owenLive, "live", 3000);
    await pump(sessionId, 12, () => tags(owenLive).includes(12));
    owenLive.close();
    miaLive.close();
  });

  it("during a takeover only the socket holding the lease gets frames; the holder's other socket and everyone else get `private takeover`", async () => {
    const sessionId = await sessionWithPage();
    const m1 = await open(mia, sessionId);
    await waitState(m1, "live");
    const m2 = await open(mia, sessionId);
    const owenLive = await open(owen, sessionId);
    await waitState(m2, "live");
    await waitState(owenLive, "live");
    const viewers = hub()
      .stats()
      .sessions.find((s) => s.sessionId === sessionId)!.viewers;
    const holder = viewers[0]!;
    expect(holder.userId).toBe(miaId);

    const leaseId = randomUUID();
    expect(hub().registerLeaseSocket(sessionId, leaseId, holder.viewerId)).toBe(true);
    await su.query(
      "update app.work_browsers set lease_id = $2, controller_user_id = $3, lease_expires_at = now() + interval '10 minutes' where work_session_id = $1",
      [sessionId, leaseId, miaId],
    );
    expect(await waitState(m1, "controlling", 3000)).toMatchObject({ controller: "self" });
    // Private from the moment the lease is held here (MD-02); the holder's name follows with the row's next read.
    await waitFor(() => lastState(m2)?.memberName);
    expect(await waitState(m2, "private", 3000)).toMatchObject({
      privateReason: "takeover",
      controller: "other_device",
      memberName: "Mia Lopez",
    });
    expect(await waitState(owenLive, "private", 3000)).toMatchObject({
      privateReason: "takeover",
      controller: "other",
    });

    await pump(sessionId, 21, () => tags(m1).includes(21));
    await sleep(300);
    expect(tags(m2)).not.toContain(21);
    expect(tags(owenLive)).not.toContain(21);

    // A lease in the row that no socket here registered: nobody here receives frames.
    hub().clearLeaseSocket(sessionId);
    await waitState(m1, "private", 3000);

    await su.query(
      "update app.work_browsers set lease_id = null, controller_user_id = null, lease_expires_at = null where work_session_id = $1",
      [sessionId],
    );
    await waitState(m1, "live", 3000);
    await waitState(owenLive, "live", 3000);
    m1.close();
    m2.close();
    owenLive.close();
  });

  it("a page that ended tells every viewer `ended` with its reason and closes the socket with 1000", async () => {
    const sessionId = await sessionWithPage();
    const owenLive = await open(owen, sessionId);
    const miaLive = await open(mia, sessionId);
    await waitState(owenLive, "live");
    await waitState(miaLive, "live");
    d.browserEvent(sessionId, { kind: "crashed", origin: ORIGIN });
    for (const s of [owenLive, miaLive]) {
      expect((await s.closed).code).toBe(1000);
      expect(lastState(s)).toMatchObject({ state: "ended", endReason: "crashed" });
    }
    await d.next((f) => f.type === "browser.frames" && f.sessionId === sessionId && f.on === false);
  });

  it("the heartbeat sends every viewer its current state again", async () => {
    const sessionId = await sessionWithPage();
    const owenLive = await open(owen, sessionId);
    const first = await waitState(owenLive, "live");
    const count = owenLive.json.filter((f) => f.type === "state").length;
    hub().heartbeat();
    await waitFor(() => owenLive.json.filter((f) => f.type === "state").length === count + 1);
    expect(lastState(owenLive)).toEqual(first);
    owenLive.close();
  });

  it("a viewer removed from the session's audience gets no frame after, `no_permission` and 4403", async () => {
    const sessionId = await sessionWithPage();
    const miaLive = await open(mia, sessionId);
    await waitState(miaLive, "live");
    await pump(sessionId, 31, () => tags(miaLive).includes(31));

    const res = await owen.request("DELETE", `/api/v1/devices/${dId}/grants/user/${miaId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await miaLive.closed).code).toBe(4403);
    expect(lastState(miaLive)).toMatchObject({ state: "no_permission" });
    expect(tags(miaLive)).not.toContain(32);
    await shareDevice(owen, dId, miaId);
  });
});
