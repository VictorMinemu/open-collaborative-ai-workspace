import { randomUUID } from "node:crypto";
import { encodeWorkBrowserFrame, LiveServerFrame } from "@ocw/contracts";
import pg from "pg";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice, sleep } from "../../testing-device";
import { invite, pairDevice, shareDevice, startSession } from "../../testing-workzone";
import {
  fakeJpeg,
  type Json,
  lastState,
  type WorkLiveSocket,
  waitFor,
  waitState,
  workLiveSocket,
} from "./live-testing";

/**
 * The takeover lease of a Work Zone session's page (Phase 07.13-18; D-20, D-22, D-28, D-33, PD-14, PD-15; WZB-08,
 * WZB-09). On the session's live socket, the person who asked the session's in-flight (or last) turn and may prompt it
 * takes control (`take`), types into the device's page (input reaches the device as `browser.input`, from the holder's
 * socket only) and hands it back (`release { save }`). One holder (a conditional UPDATE on `work_browsers`), the bots'
 * lease rules (10 minutes after the latest input, warning at 9, abandoned after input closes the page), a lapsed lease
 * of a dead instance swept. Nothing typed is logged, audited, stored or announced. Real PostgreSQL and Redis; the fake
 * daemon speaks the Device Link.
 */

const ADMIN = { name: "Ada Admin", email: "ada@example.test", password: "correct-horse-battery" };
const ORIGIN = "http://localhost:3000";
const CANARY = `canary-typed-${randomUUID()}`;

let stack: TestStack;
let su: pg.Client;
let ada: TestClient;
let owen: TestClient;
/** Mia may use Owen's device: she asks the turns of these tests. */
let mia: TestClient;
let miaId: string;
/** Pia may use Owen's device too (the reader whose prompt right a rule takes away). */
let pia: TestClient;
let piaId: string;
let dId: string;
let d: FakeDevice;
let projectId: string;
const sockets: WorkLiveSocket[] = [];
let monitor: ReturnType<typeof createClient>;
/** Every command Redis saw while the suite ran (MONITOR). */
const redisSeen: string[] = [];
/** Every logger call of the API's core logger, as JSON. */
const logged: string[] = [];
/** Every message the API published on its bus: channel and payload. */
const published: Array<{ channel: string; message: string }> = [];

const core = () => stack.built.core;

/** JSON of a logger call's arguments (request objects are circular: a repeat is written as "[seen]"). */
function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[seen]";
        seen.add(v);
      }
      return typeof v === "bigint" ? String(v) : v;
    });
  } catch {
    return String(value);
  }
}
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

/** `as` asks a turn of `sid`: the device received the prompt and runs it (in flight). */
async function ask(as: TestClient, sid: string): Promise<string> {
  const res = await as.request("POST", `/api/v1/work-sessions/${sid}/prompts`, {
    body: "Sign in to the app",
  });
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

/** A fresh session of Owen's whose turn `asker` asked, with an open page on ORIGIN. */
async function askedSessionWithPage(asker: TestClient = mia): Promise<string> {
  const id = await startSession(owen, d, projectId);
  await ask(asker, id);
  d.browserEvent(id, { kind: "opened", origin: ORIGIN });
  await eventually(async () => {
    const res = await su.query("select state from app.work_browsers where work_session_id = $1", [id]);
    return (res.rows[0] as { state?: string } | undefined)?.state === "open";
  });
  return id;
}

const browserRow = async (sessionId: string) =>
  (await su.query("select * from app.work_browsers where work_session_id = $1", [sessionId])).rows[0] as Json;

const audits = async (action: string, sessionId: string) =>
  (
    await su.query(
      "select actor_kind, actor_id, user_id, metadata from app.audit_events where action = $1 and resource_id = $2 order by occurred_at, id",
      [action, sessionId],
    )
  ).rows as Json[];

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

/** Mia's socket takes the lease of `sid` and is controlling; returns the lease id the device was told. */
async function take(s: WorkLiveSocket, sid: string): Promise<string> {
  send(s, { type: "take" });
  const held = await deviceFrame("browser.lease", sid, (f) => f.state === "held");
  await waitFor(() => s.json.some((f) => f.type === "lease"));
  await waitState(s, "controlling", 4000);
  return held.leaseId as string;
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
  ({ client: mia, userId: miaId } = await invite(stack, ada, "mia@example.test", "Mia Lopez", "developer"));
  ({ client: pia, userId: piaId } = await invite(stack, ada, "pia@example.test", "Pia", "developer"));

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
  await shareDevice(owen, dId, piaId);

  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
    const original = core().log[level].bind(core().log);
    vi.spyOn(core().log, level).mockImplementation(((...args: unknown[]) => {
      logged.push(safeJson(args));
      return (original as (...a: unknown[]) => void)(...args);
    }) as never);
  }
  const publish = core().bus.publish.bind(core().bus);
  vi.spyOn(core().bus, "publish").mockImplementation(async (channel: string, message: string) => {
    published.push({ channel, message });
    return publish(channel, message);
  });
  monitor = createClient({ url: stack.redis.getConnectionUrl() });
  await monitor.connect();
  await monitor.monitor((reply) => {
    redisSeen.push(String(reply));
  });
}, 240_000);

afterAll(async () => {
  vi.restoreAllMocks();
  monitor?.destroy();
  for (const s of sockets) s.socket.terminate();
  await d?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

describe("07.13-18 Task 1: the asker takes control, types into the device's page and hands it back (tracer)", () => {
  it("take → held on the device and `controlling`; text reaches the device after `lease_input`; the others see `private takeover`; release hands it back", async () => {
    const sid = await askedSessionWithPage(mia);
    const owenLive = await open(owen, sid);
    const miaLive = await open(mia, sid);
    await waitState(owenLive, "live");
    await waitState(miaLive, "live");
    // Mia asked the turn: she may take control; Owen (the creator, who did not ask it) may not.
    await waitFor(() => miaLive.json.find((f) => f.type === "viewerCan"));
    expect(miaLive.json.find((f) => f.type === "viewerCan")).toEqual({
      type: "viewerCan",
      watch: true,
      control: true,
    });
    expect(owenLive.json.find((f) => f.type === "viewerCan")).toEqual({
      type: "viewerCan",
      watch: true,
      control: false,
    });

    const leaseId = await take(miaLive, sid);
    const row = await browserRow(sid);
    expect(row).toMatchObject({ controller_user_id: miaId, lease_id: leaseId, lease_input: false });
    const expires = new Date(String(row.lease_expires_at)).getTime();
    expect(Math.abs(expires - (Date.now() + 10 * 60_000))).toBeLessThan(30_000);
    const lease = miaLive.json.find((f) => f.type === "lease")!;
    expect(LiveServerFrame.safeParse(lease).success).toBe(true);
    expect(Math.abs(Date.parse(String(lease.expiresAt)) - expires)).toBeLessThan(1_000);
    expect(lastState(miaLive)).toMatchObject({
      state: "controlling",
      controller: "self",
      host: "localhost:3000",
    });
    expect(await waitState(owenLive, "private", 3000)).toMatchObject({
      privateReason: "takeover",
      controller: "other",
      memberName: "Mia Lopez",
      host: null,
    });
    // MD-02: the others go private at the take, before the row's next read; that very first frame names the holder.
    expect(owenLive.json.find((f) => f.type === "state" && f.state === "private")).toMatchObject({
      privateReason: "takeover",
      controller: "other",
      memberName: "Mia Lopez",
    });
    expect(await audits("work_browser.takeover_started", sid)).toEqual([
      { actor_kind: "user", actor_id: miaId, user_id: miaId, metadata: { origin: ORIGIN } },
    ]);

    // Input from the holder's socket: recorded on the row before the device receives it, then forwarded.
    send(miaLive, { type: "text", text: CANARY });
    const input = await deviceFrame("browser.input", sid);
    expect((await browserRow(sid)).lease_input).toBe(true);
    expect(input).toEqual({
      type: "browser.input",
      sessionId: sid,
      leaseId,
      events: [{ type: "text", text: CANARY }],
    });
    // Owen's input is dropped (he does not hold the lease).
    send(owenLive, { type: "text", text: "not-the-holder" });
    await sleep(300);
    expect(d.frames.some((f) => f.type === "browser.input")).toBe(false);

    // Only the holder's socket gets frames.
    await pump(sid, 41, () => tags(miaLive).includes(41));
    await sleep(300);
    expect(tags(owenLive)).not.toContain(41);

    send(miaLive, { type: "release", save: false });
    expect(await deviceFrame("browser.lease", sid, (f) => f.state === "released")).toEqual({
      type: "browser.lease",
      sessionId: sid,
      leaseId,
      state: "released",
    });
    await eventually(async () => (await browserRow(sid)).lease_id === null || undefined);
    expect(await browserRow(sid)).toMatchObject({
      controller_user_id: null,
      lease_id: null,
      lease_expires_at: null,
      lease_input: false,
      state: "open",
      upload_id: null,
    });
    expect(await audits("work_browser.takeover_ended", sid)).toEqual([
      {
        actor_kind: "user",
        actor_id: miaId,
        user_id: miaId,
        metadata: { origin: ORIGIN, reason: "released", saved: false, abandoned: false },
      },
    ]);
    await waitState(owenLive, "live", 3000);
    await waitState(miaLive, "live", 3000);
    owenLive.close();
    miaLive.close();
  });

  it("nothing typed reached a log line, an audit row, an event, a device command or Redis", async () => {
    const probe = `probe-${randomUUID()}`;
    await core().bus.publish("ocw:test:probe", probe);
    await eventually(async () => redisSeen.some((line) => line.includes(probe)) || undefined);
    expect(redisSeen.filter((line) => line.includes(CANARY))).toEqual([]);
    expect(published.filter((p) => p.message.includes(CANARY))).toEqual([]);
    // The logger spy works: a probe line logged now is seen.
    core().log.info({ probe }, "lease test probe");
    expect(logged.some((line) => line.includes(probe))).toBe(true);
    expect(logged.filter((line) => line.includes(CANARY))).toEqual([]);
    for (const [table, column] of [
      ["device_commands", "payload"],
      ["stream_events", "payload"],
      ["audit_events", "metadata"],
    ] as const) {
      const r = await su.query(`select count(*)::int as n from app.${table} where ${column}::text like $1`, [
        `%${CANARY}%`,
      ]);
      expect((r.rows[0] as Json).n, table).toBe(0);
    }
  });
});

const leaseFrames = (s: WorkLiveSocket) => s.json.filter((f) => f.type === "lease");
const refusals = (s: WorkLiveSocket) => s.json.filter((f) => f.type === "refused");

describe("07.13-18 Task 2: lease rules, expiry, abandonment and dead instances", () => {
  it("only the asker who may prompt takes it: another member and a reader without work_session.prompt are refused `not_allowed`; the holder's other socket `someone_else`", async () => {
    const sid = await askedSessionWithPage(mia);
    const owenLive = await open(owen, sid);
    await waitState(owenLive, "live");
    send(owenLive, { type: "take" });
    await waitFor(() => refusals(owenLive).length >= 1);
    expect(refusals(owenLive)).toEqual([{ type: "refused", op: "take", reason: "not_allowed" }]);
    expect((await browserRow(sid)).lease_id).toBeNull();

    const m1 = await open(mia, sid);
    const m2 = await open(mia, sid);
    await waitState(m1, "live");
    await waitState(m2, "live");
    await take(m1, sid);
    send(m2, { type: "take" });
    await waitFor(() => refusals(m2).length >= 1);
    expect(refusals(m2)).toEqual([{ type: "refused", op: "take", reason: "someone_else" }]);
    expect(await waitState(m2, "private", 3000)).toMatchObject({
      privateReason: "takeover",
      controller: "other_device",
    });
    send(m1, { type: "release", save: false });
    await deviceFrame("browser.lease", sid, (f) => f.state === "released");

    // Pia asked her own session's turn, then a rule takes work_session.prompt from her: she still reads it, never takes it.
    const sid2 = await askedSessionWithPage(pia);
    const rule = await ada.request("POST", "/api/v1/permission-rules", {
      subjectKind: "user",
      subjectId: piaId,
      permission: "work_session.prompt",
      effect: "deny",
    });
    expect([200, 201], JSON.stringify(rule.body)).toContain(rule.status);
    try {
      const piaLive = await open(pia, sid2);
      await waitState(piaLive, "live");
      expect(piaLive.json.find((f) => f.type === "viewerCan")).toMatchObject({ watch: true, control: false });
      send(piaLive, { type: "take" });
      await waitFor(() => refusals(piaLive).length >= 1);
      expect(refusals(piaLive)).toEqual([{ type: "refused", op: "take", reason: "not_allowed" }]);
      expect((await browserRow(sid2)).lease_id).toBeNull();
      piaLive.close();
    } finally {
      await ada.request("DELETE", `/api/v1/permission-rules/${rule.body!.id as string}`);
    }
    owenLive.close();
    m1.close();
    m2.close();
  });

  it("no input for 10 minutes: warned at 9 (the `lease` frame again), then released (nothing typed: not abandoned)", async () => {
    const sid = await askedSessionWithPage(mia);
    const miaLive = await open(mia, sid);
    await waitState(miaLive, "live");
    const leaseId = await take(miaLive, sid);
    const before = leaseFrames(miaLive).length;
    await hub().sweep(Date.now() + 8 * 60_000);
    expect(leaseFrames(miaLive)).toHaveLength(before);
    await hub().sweep(Date.now() + 9 * 60_000 + 30_000);
    await waitFor(() => leaseFrames(miaLive).length === before + 1);
    await hub().sweep(Date.now() + 10 * 60_000 + 30_000);
    expect(await deviceFrame("browser.lease", sid, (f) => f.state === "released")).toMatchObject({ leaseId });
    expect(await browserRow(sid)).toMatchObject({ lease_id: null, state: "open" });
    expect((await audits("work_browser.takeover_ended", sid)).map((a) => a.metadata)).toEqual([
      { origin: ORIGIN, reason: "idle", saved: false, abandoned: false },
    ]);
    await waitState(miaLive, "live", 3000);
    miaLive.close();
  });

  it("the lease's expiry moves with input; idle after input abandons the page: closed on the row and the device, `ended takeover_abandoned` for everyone", async () => {
    const sid = await askedSessionWithPage(mia);
    const owenLive = await open(owen, sid);
    const miaLive = await open(mia, sid);
    await waitState(owenLive, "live");
    await waitState(miaLive, "live");
    const leaseId = await take(miaLive, sid);
    const first = Date.parse(String(leaseFrames(miaLive)[0]!.expiresAt));
    await sleep(50);
    send(miaLive, { type: "mouse", event: "down", x: 10, y: 10, button: "left" });
    await deviceFrame("browser.input", sid);
    await waitFor(() => leaseFrames(miaLive).length >= 2);
    expect(Date.parse(String(leaseFrames(miaLive).at(-1)!.expiresAt))).toBeGreaterThan(first);

    await hub().sweep(Date.now() + 10 * 60_000 + 30_000);
    expect(await deviceFrame("browser.lease", sid, (f) => f.state === "abandoned")).toMatchObject({
      leaseId,
    });
    expect(await browserRow(sid)).toMatchObject({ lease_id: null, state: "closed" });
    for (const s of [owenLive, miaLive]) {
      expect((await s.closed).code).toBe(1000);
      expect(lastState(s)).toMatchObject({ state: "ended", endReason: "takeover_abandoned" });
    }
    expect((await audits("work_browser.takeover_ended", sid)).map((a) => a.metadata)).toEqual([
      { origin: ORIGIN, reason: "idle", saved: false, abandoned: true },
    ]);
    // The device's own echo of the close audits nothing again.
    d.browserEvent(sid, { kind: "takeover_abandoned", origin: ORIGIN });
    await sleep(500);
    expect((await audits("work_browser.closed", sid)).map((a) => a.metadata)).toEqual([
      { origin: ORIGIN, endReason: "takeover_abandoned" },
    ]);
  });

  it("the holder's socket closing after input abandons the page; closing without input releases it", async () => {
    const sid = await askedSessionWithPage(mia);
    const quiet = await open(mia, sid);
    await waitState(quiet, "live");
    await take(quiet, sid);
    quiet.close();
    await deviceFrame("browser.lease", sid, (f) => f.state === "released");
    await eventually(async () => (await browserRow(sid)).lease_id === null || undefined);

    const typing = await open(mia, sid);
    await waitState(typing, "live");
    await take(typing, sid);
    send(typing, { type: "key", event: "down", key: "a", code: "KeyA", modifiers: 0 });
    await deviceFrame("browser.input", sid);
    typing.close();
    await deviceFrame("browser.lease", sid, (f) => f.state === "abandoned");
    await eventually(async () => (await browserRow(sid)).state === "closed" || undefined);
    expect((await audits("work_browser.takeover_ended", sid)).map((a) => a.metadata)).toEqual([
      { origin: ORIGIN, reason: "closed", saved: false, abandoned: false },
      { origin: ORIGIN, reason: "closed", saved: false, abandoned: true },
    ]);
  });

  it("the holder losing access to the session abandons the page (after input) and gets `no_permission`", async () => {
    const sid = await askedSessionWithPage(mia);
    const miaLive = await open(mia, sid);
    await waitState(miaLive, "live");
    await take(miaLive, sid);
    send(miaLive, { type: "text", text: "x" });
    await deviceFrame("browser.input", sid);
    const res = await owen.request("DELETE", `/api/v1/devices/${dId}/grants/user/${miaId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    try {
      expect((await miaLive.closed).code).toBe(4403);
      expect(lastState(miaLive)).toMatchObject({ state: "no_permission" });
      await deviceFrame("browser.lease", sid, (f) => f.state === "abandoned");
      expect((await audits("work_browser.takeover_ended", sid)).map((a) => a.metadata)).toEqual([
        { origin: ORIGIN, reason: "access_lost", saved: false, abandoned: true },
      ]);
    } finally {
      await shareDevice(owen, dId, miaId);
    }
  });

  it("the page closing on the device clears the lease: the holder sees `ended`, the end is audited", async () => {
    const sid = await askedSessionWithPage(mia);
    const miaLive = await open(mia, sid);
    await waitState(miaLive, "live");
    await take(miaLive, sid);
    d.browserEvent(sid, { kind: "closed", origin: ORIGIN });
    expect((await miaLive.closed).code).toBe(1000);
    expect(lastState(miaLive)).toMatchObject({ state: "ended" });
    expect(await browserRow(sid)).toMatchObject({
      lease_id: null,
      controller_user_id: null,
      state: "closed",
    });
    expect((await audits("work_browser.takeover_ended", sid)).map((a) => a.metadata)).toEqual([
      { origin: ORIGIN, reason: "page_ended", saved: false, abandoned: false },
    ]);
  });

  it("a lease left by a dead instance is cleared by the sweep: abandoned (page closed) after input, released without", async () => {
    const typed = await askedSessionWithPage(mia);
    const quiet = await askedSessionWithPage(mia);
    const typedLease = randomUUID();
    const quietLease = randomUUID();
    for (const [sid, leaseId, input] of [
      [typed, typedLease, true],
      [quiet, quietLease, false],
    ] as const) {
      await su.query(
        `update app.work_browsers set lease_id = $2, controller_user_id = $3, lease_input = $4,
           lease_expires_at = now() - interval '2 minutes' where work_session_id = $1`,
        [sid, leaseId, miaId, input],
      );
    }
    const swept = await stack.built.workBrowser.sweeper.runOnce();
    expect(swept.leases).toBe(2);
    expect(await deviceFrame("browser.lease", typed, (f) => f.state === "abandoned")).toMatchObject({
      leaseId: typedLease,
    });
    expect(await deviceFrame("browser.lease", quiet, (f) => f.state === "released")).toMatchObject({
      leaseId: quietLease,
    });
    expect(await browserRow(typed)).toMatchObject({ lease_id: null, state: "closed" });
    expect(await browserRow(quiet)).toMatchObject({ lease_id: null, state: "open" });
    expect(await audits("work_browser.takeover_ended", typed)).toEqual([
      {
        actor_kind: "system",
        actor_id: expect.any(String),
        user_id: miaId,
        metadata: { origin: ORIGIN, reason: "idle", saved: false, abandoned: true },
      },
    ]);
    // A lease that lapsed within the grace (its holder's instance may still end it) is left alone.
    await su.query(
      `update app.work_browsers set lease_id = $2, controller_user_id = $3, lease_expires_at = now() - interval '10 seconds'
         where work_session_id = $1`,
      [quiet, randomUUID(), miaId],
    );
    expect((await stack.built.workBrowser.sweeper.runOnce()).leases).toBe(0);
    await su.query(
      "update app.work_browsers set lease_id = null, controller_user_id = null, lease_expires_at = null where work_session_id = $1",
      [quiet],
    );
  });

  it("lease announcements between instances carry ids only", () => {
    const lease = published.filter((p) => p.channel === "ocw:wb:lease");
    expect(lease.length).toBeGreaterThan(0);
    for (const p of lease) expect(Object.keys(JSON.parse(p.message) as Json).sort()).toEqual(["o", "s"]);
  });
});

describe("07.13-18 Task 3: the hand back that saves, and the focus hint", () => {
  it("`release { save: true }` ends the lease and mints the one-use upload in one step; the device's PUT with it seals the sign-in", async () => {
    const sid = await askedSessionWithPage(mia);
    const miaLive = await open(mia, sid);
    await waitState(miaLive, "live");
    const leaseId = await take(miaLive, sid);
    send(miaLive, { type: "text", text: "secret-password" });
    await deviceFrame("browser.input", sid);
    send(miaLive, { type: "release", save: true });
    const handback = await deviceFrame("browser.handback", sid);
    expect(handback).toEqual({
      type: "browser.handback",
      sessionId: sid,
      leaseId,
      save: true,
      uploadId: expect.any(String),
    });
    // The hand back is no abandonment: the page stays open, the device is not told `released` on top.
    const row = await browserRow(sid);
    expect(row).toMatchObject({
      lease_id: null,
      controller_user_id: null,
      state: "open",
      upload_id: handback.uploadId,
      upload_user_id: miaId,
      upload_origin: ORIGIN,
    });
    const expires = new Date(String(row.upload_expires_at)).getTime();
    expect(Math.abs(expires - (Date.now() + 5 * 60_000))).toBeLessThan(30_000);
    expect((await audits("work_browser.takeover_ended", sid)).map((a) => a.metadata)).toEqual([
      { origin: ORIGIN, reason: "released", saved: true, abandoned: false },
    ]);
    await sleep(200);
    expect(d.frames.some((f) => f.type === "browser.lease" && f.sessionId === sid)).toBe(false);

    const cookie = {
      name: "sid",
      value: `sealed-${randomUUID()}`,
      domain: "localhost",
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 86_400,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    };
    const put = await fetch(
      `${stack.baseUrl}/api/v1/runtime/browser-signins/uploads/${handback.uploadId as string}`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${d.jwt}`, "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: sid,
          origin: ORIGIN,
          state: { cookies: [cookie], origins: [] },
          changed: true,
        }),
      },
    );
    expect(put.status).toBe(201);
    expect(await put.json()).toEqual({ saved: true });
    expect(await browserRow(sid)).toMatchObject({ upload_id: null, upload_user_id: null });
    const signins = await su.query("select site_key from app.work_browser_signins where user_id = $1", [
      miaId,
    ]);
    expect(signins.rows).toEqual([{ site_key: "localhost:3000" }]);
    miaLive.close();
  });

  it("`release { save: true }` from a socket that does not hold the lease changes nothing", async () => {
    const sid = await askedSessionWithPage(mia);
    const m1 = await open(mia, sid);
    const owenLive = await open(owen, sid);
    await waitState(m1, "live");
    await waitState(owenLive, "live");
    await take(m1, sid);
    send(owenLive, { type: "release", save: true });
    await sleep(400);
    expect(await browserRow(sid)).toMatchObject({ controller_user_id: miaId, upload_id: null });
    send(m1, { type: "release", save: false });
    await deviceFrame("browser.lease", sid, (f) => f.state === "released");
    m1.close();
    owenLive.close();
  });

  it("the device's focus hint reaches the holder's socket only; one for a stale lease reaches nobody", async () => {
    const sid = await askedSessionWithPage(mia);
    const owenLive = await open(owen, sid);
    const m1 = await open(mia, sid);
    const m2 = await open(mia, sid);
    for (const s of [owenLive, m1, m2]) await waitState(s, "live");
    const leaseId = await take(m1, sid);
    const focus = (s: WorkLiveSocket) => s.json.filter((f) => f.type === "focus");

    d.send({ type: "browser.focus", sessionId: sid, leaseId: randomUUID(), sensitive: true });
    await sleep(400);
    expect([focus(m1), focus(m2), focus(owenLive)]).toEqual([[], [], []]);

    d.send({ type: "browser.focus", sessionId: sid, leaseId, sensitive: true });
    await waitFor(() => focus(m1).length >= 1);
    expect(focus(m1)).toEqual([{ type: "focus", sensitive: true }]);
    expect(LiveServerFrame.safeParse(focus(m1)[0]).success).toBe(true);
    await sleep(200);
    expect([focus(m2), focus(owenLive)]).toEqual([[], []]);

    send(m1, { type: "release", save: false });
    await deviceFrame("browser.lease", sid, (f) => f.state === "released");
    d.send({ type: "browser.focus", sessionId: sid, leaseId, sensitive: false });
    await sleep(400);
    expect(focus(m1)).toHaveLength(1);
    for (const s of [owenLive, m1, m2]) s.close();
  });
});
