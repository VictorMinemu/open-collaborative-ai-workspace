import { randomUUID } from "node:crypto";
import { encodeWorkBrowserFrame } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice, sleep } from "../../testing-device";
import { invite, pairDevice, setAudience, shareDevice, startSession } from "../../testing-workzone";
import { createPermissionService } from "../organization";
import { takeWorkLease } from "./lease";
import {
  fakeJpeg,
  type Json,
  lastState,
  type WorkLiveSocket,
  waitFor,
  waitState,
  workLiveSocket,
} from "./live-testing";
import { sealWorkSignIn } from "./signins";

/**
 * The fixes of the Phase 07.13 code review (07.13-REVIEW.md, API side) on a real PostgreSQL + Redis and the full API:
 * who may take a page that holds a member's sign-in and who receives its frames (HI-03). The fake daemon speaks the
 * Device Link.
 */

const ADMIN = { name: "Ada Admin", email: "ada@example.test", password: "correct-horse-battery" };
const ORIGIN = "http://localhost:3000";

let stack: TestStack;
let su: pg.Client;
let orgId: string;
let ada: TestClient;
let owen: TestClient;
let owenId: string;
/** Mia and Pia may use Owen's device: they ask the turns of these tests. */
let mia: TestClient;
let miaId: string;
let piaId: string;
let dId: string;
let dToken: string;
let d: FakeDevice;
let projectId: string;
const sockets: WorkLiveSocket[] = [];

const core = () => stack.built.core;
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

const send = (s: WorkLiveSocket, frame: Json) => s.socket.send(JSON.stringify(frame));

/** `as` asks a turn of `sid`: the device received the prompt and runs it (in flight). Returns the prompt id. */
async function ask(as: TestClient, sid: string): Promise<string> {
  const res = await as.request("POST", `/api/v1/work-sessions/${sid}/prompts`, { body: "Check the app" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const promptId = res.body!.id as string;
  const cmd = await d.command("prompt", sid);
  d.ack(cmd.id);
  d.event(sid, { type: "prompt.started", promptId });
  await eventually(async () => {
    const r = await su.query("select status from app.work_prompts where id = $1", [promptId]);
    return ["dispatched", "running"].includes((r.rows[0] as Json | undefined)?.status as string) || undefined;
  });
  return promptId;
}

/** A fresh session of `creator` on Owen's device whose turn `asker` asked, with an open page on ORIGIN. */
async function askedSessionWithPage(
  asker: TestClient = mia,
  creator: TestClient = owen,
): Promise<{ sid: string; promptId: string }> {
  const sid = await startSession(creator, d, projectId);
  const promptId = await ask(asker, sid);
  d.browserEvent(sid, { kind: "opened", origin: ORIGIN, promptId });
  await eventually(async () => (await browserRow(sid))?.state === "open" || undefined);
  return { sid, promptId };
}

const browserRow = async (sessionId: string) =>
  (await su.query("select * from app.work_browsers where work_session_id = $1", [sessionId])).rows[0] as
    | Json
    | undefined;

/** The next `browser.*` frame of `type` for the session the device received. */
const deviceFrame = (type: string, sessionId: string, more: (f: Json) => boolean = () => true) =>
  d.next((f) => f.type === type && f.sessionId === sessionId && more(f as Json)) as Promise<Json>;

function frame(sessionId: string, jpeg: Uint8Array): Uint8Array {
  const bytes = encodeWorkBrowserFrame({ sessionId, width: 960, height: 600, jpeg });
  if (!bytes) throw new Error("frame did not encode");
  return bytes;
}

const tags = (s: WorkLiveSocket) => s.binary.map((b) => b[3]);

/** Sends frames from Owen's device until `until()` holds. */
async function pump(sessionId: string, tag: number, until: () => boolean, timeoutMs = 6000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!until()) {
    if (Date.now() > end) throw new Error("frames never arrived");
    await d.sendBinary(frame(sessionId, fakeJpeg(tag)));
    await sleep(100);
  }
}

/** `s` takes the lease of `sid` and is controlling; returns the lease id the device was told. */
async function take(s: WorkLiveSocket, sid: string): Promise<string> {
  send(s, { type: "take" });
  const held = await deviceFrame("browser.lease", sid, (f) => f.state === "held");
  await waitFor(() => s.json.some((f) => f.type === "lease"));
  await waitState(s, "controlling", 4000);
  return held.leaseId as string;
}

const refusals = (s: WorkLiveSocket) => s.json.filter((f) => f.type === "refused");
const setSignedIn = (sid: string, userId: string | null) =>
  su.query("update app.work_browsers set signin_user_id = $2 where work_session_id = $1", [sid, userId]);

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
  orgId = (setup.body!.organization as Json).id as string;
  ({ client: owen, userId: owenId } = await invite(stack, ada, "owen@example.test", "Owen", "developer"));
  ({ client: mia, userId: miaId } = await invite(stack, ada, "mia@example.test", "Mia Lopez", "developer"));
  ({ userId: piaId } = await invite(stack, ada, "pia@example.test", "Pia", "developer"));
  expect((await ada.request("PUT", "/api/v1/work-zone-policy", { allowBrowser: true })).status).toBe(200);

  const paired = await pairDevice(stack, owen, "Owen's Mac");
  dId = paired.deviceId;
  dToken = paired.token;
  d = await FakeDevice.connect(stack.baseUrl, dToken, undefined, { browser: { version: 1, optIn: true } });
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
  await shareDevice(owen, dId, piaId);
}, 240_000);

afterAll(async () => {
  for (const s of sockets) s.socket.terminate();
  await d?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

describe("HI-03: a page with another member's sign-in loaded is never taken, and its frames reach only that member", () => {
  it("the asker may not take a page that holds someone else's sign-in: viewerCan control false, take refused", async () => {
    const { sid } = await askedSessionWithPage(mia);
    await setSignedIn(sid, owenId);
    const miaLive = await open(mia, sid);
    expect(await waitState(miaLive, "private")).toMatchObject({ privateReason: "member_session" });
    expect(miaLive.json.find((f) => f.type === "viewerCan")).toEqual({
      type: "viewerCan",
      watch: true,
      control: false,
    });
    send(miaLive, { type: "take" });
    await waitFor(() => refusals(miaLive).length >= 1);
    expect(refusals(miaLive)).toEqual([{ type: "refused", op: "take", reason: "not_allowed" }]);
    expect((await browserRow(sid))?.lease_id).toBeNull();
    expect(d.frames.some((f) => f.type === "browser.lease" && f.sessionId === sid)).toBe(false);

    // The conditional take itself refuses too (defence in depth behind the live view's decision).
    const perms = createPermissionService(core());
    const taken = await core().db.withTenant({ organizationId: orgId, userId: miaId }, (tx) =>
      takeWorkLease(tx, core(), perms, { sessionId: sid, userId: miaId }),
    );
    expect(taken).toEqual({ refused: "not_allowed" });
    expect((await browserRow(sid))?.lease_id).toBeNull();

    // Her own sign-in on the page leaves her the asker's right.
    await setSignedIn(sid, miaId);
    await waitState(miaLive, "live", 3000);
    const again = await open(mia, sid);
    await waitFor(() => again.json.find((f) => f.type === "viewerCan"));
    expect(again.json.find((f) => f.type === "viewerCan")).toMatchObject({ control: true });
    await take(again, sid);
    send(again, { type: "release", save: false });
    await deviceFrame("browser.lease", sid, (f) => f.state === "released");
    miaLive.close();
    again.close();
  });

  it("a lease holder gets no frame once another member's sign-in is on the page: the sign-in gate comes first", async () => {
    const { sid } = await askedSessionWithPage(mia);
    const miaLive = await open(mia, sid);
    await waitState(miaLive, "live");
    await take(miaLive, sid);
    await pump(sid, 51, () => tags(miaLive).includes(51));

    await setSignedIn(sid, owenId);
    expect(await waitState(miaLive, "private", 3000)).toMatchObject({
      privateReason: "member_session",
      memberName: "Owen",
      host: null,
    });
    const seen = miaLive.binary.length;
    for (let i = 0; i < 5; i++) {
      await d.sendBinary(frame(sid, fakeJpeg(52)));
      await sleep(60);
    }
    await sleep(300);
    expect(miaLive.binary.slice(seen).map((b) => b[3])).not.toContain(52);
    expect(lastState(miaLive)?.state).toBe("private");
    miaLive.close();
  });
});

/** Whether the server lets binary frames pass to `userId`'s viewers of `sid` now (the gate's pushed answer). */
const framesFor = (sid: string, userId: string) =>
  hub()
    .stats()
    .sessions.find((s) => s.sessionId === sid)
    ?.viewers.filter((v) => v.userId === userId)
    .map((v) => v.frames);

/** Seals `userId`'s Work Zone sign-in for ORIGIN through the module's own seal (as that member). */
async function sealFor(userId: string, sid: string): Promise<string> {
  const sealed = await core().db.withTenant({ organizationId: orgId, userId }, (tx) =>
    sealWorkSignIn(tx, core(), {
      userId,
      origin: ORIGIN,
      rawState: JSON.stringify({
        cookies: [
          {
            name: "sid",
            value: `v-${randomUUID()}`,
            domain: "localhost",
            path: "/",
            expires: 2_000_000_000,
            httpOnly: true,
            secure: false,
            sameSite: "Lax",
          },
        ],
        origins: [],
      }),
      device: { deviceId: dId, sessionId: sid },
    }),
  );
  if (!sealed) throw new Error("nothing sealed");
  return sealed.signinId;
}

/** Mia's personal session on Owen's device (seen by her and the device owner), her turn in flight, a page open. */
async function miasSignInSession(): Promise<{ sid: string; promptId: string }> {
  const sid = await startSession(mia, d, projectId);
  await setAudience(mia, sid, { kind: "owner" });
  const promptId = await ask(mia, sid);
  d.browserEvent(sid, { kind: "opened", origin: ORIGIN, promptId });
  await eventually(async () => (await browserRow(sid))?.state === "open" || undefined);
  return { sid, promptId };
}

/** The device asks for the turn asker's sign-in of ORIGIN; resolves with the answer's result. */
async function load(sid: string, promptId: string, onReply?: () => void): Promise<Json> {
  const requestId = randomUUID();
  let seen = false;
  const listener = (data: unknown, isBinary: boolean) => {
    if (isBinary || seen) return;
    const f = JSON.parse(String(data)) as Json;
    if (f.type === "browser.signin.state" && f.requestId === requestId) {
      seen = true;
      onReply?.();
    }
  };
  d.ws.on("message", listener);
  try {
    d.send({ type: "browser.signin.load", requestId, sessionId: sid, promptId, origin: ORIGIN });
    const reply = await d.next((f) => f.type === "browser.signin.state" && f.requestId === requestId);
    return reply.result as Json;
  } finally {
    d.ws.off("message", listener);
  }
}

describe("MD-02: the gate closes at once on a new lease or a new sign-in, not one refresh later", () => {
  it("when the holder learns it holds the lease, every other viewer here already gets no frame", async () => {
    const { sid } = await askedSessionWithPage(mia);
    const owenLive = await open(owen, sid);
    const miaLive = await open(mia, sid);
    await waitState(owenLive, "live");
    await waitState(miaLive, "live");
    let atLease: boolean[] | undefined;
    miaLive.socket.on("message", (data, isBinary) => {
      if (isBinary || atLease) return;
      if ((JSON.parse(String(data)) as Json).type === "lease") atLease = framesFor(sid, owenId);
    });
    await take(miaLive, sid);
    expect(atLease).toEqual([false]);
    send(miaLive, { type: "release", save: false });
    await deviceFrame("browser.lease", sid, (f) => f.state === "released");
    owenLive.close();
    miaLive.close();
  });

  it("when the device gets the member's state, every other viewer here already gets no frame", async () => {
    const { sid, promptId } = await miasSignInSession();
    await sealFor(miaId, sid);
    const owenLive = await open(owen, sid);
    await waitState(owenLive, "live");
    let atReply: boolean[] | undefined;
    const result = await load(sid, promptId, () => {
      atReply = framesFor(sid, owenId);
    });
    expect(result.ok).toBe(true);
    expect(atReply).toEqual([false]);
    expect(await waitState(owenLive, "private", 3000)).toMatchObject({ privateReason: "member_session" });
    owenLive.close();
  });
});

describe("LO-01: pointer-only input keeps the lease's row fresh", () => {
  it("a holder who only moves the pointer for longer than the keep interval has the row's expiry pushed", async () => {
    const { sid } = await askedSessionWithPage(mia);
    const miaLive = await open(mia, sid);
    await waitState(miaLive, "live");
    await take(miaLive, sid);
    const before = Date.parse(String((await browserRow(sid))?.lease_expires_at));
    // 31 s later on the API's clock (past the 30 s keep interval), only pointer moves and a scroll.
    const real = Date.now.bind(Date);
    const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + 31_000);
    try {
      send(miaLive, { type: "mouse", event: "move", x: 5, y: 5, button: "none" });
      send(miaLive, { type: "wheel", x: 5, y: 5, dx: 0, dy: 40 });
      await eventually(
        async () =>
          Date.parse(String((await browserRow(sid))?.lease_expires_at)) >= before + 25_000 || undefined,
      );
    } finally {
      spy.mockRestore();
    }
    const row = await browserRow(sid);
    // Nothing that may leave something in the page was sent: the lease is still input-free.
    expect(row).toMatchObject({ controller_user_id: miaId, lease_input: false });
    send(miaLive, { type: "release", save: false });
    await deviceFrame("browser.lease", sid, (f) => f.state === "released");
    miaLive.close();
  });
});
