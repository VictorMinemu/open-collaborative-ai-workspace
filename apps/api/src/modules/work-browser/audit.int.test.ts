import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice, sleep } from "../../testing-device";
import { invite, pairDevice, startSession } from "../../testing-workzone";

/**
 * The Control Plane side of the Work Zone browser (Phase 07.13-08, D-10, D-14, D-19, PD-20, PD-25): a device says it
 * has a browser (hello and capabilities), and every page event it reports for its own session is recorded in
 * `work_browsers` and audited as `work_browser.*` with ids, the origin and enum codes only. A device naming another
 * device's session changes nothing.
 */

const ADMIN = { name: "Ada Admin", email: "ada@example.test", password: "correct-horse-battery" };
const ORIGIN = "http://localhost:3000";

let stack: TestStack;
let su: pg.Client;
let ada: TestClient;
let owen: TestClient;
let owenId: string;
/** Owen's device: has a browser, opted in. */
let dId: string;
let d: FakeDevice;
/** Ada's device: an older daemon without a browser. */
let aId: string;
let a: FakeDevice;
let projectId: string;
const open: FakeDevice[] = [];

type Row = Record<string, unknown>;

async function deviceBrowser(id: string) {
  const res = await su.query("select browser_version, browser_opt_in from app.devices where id = $1", [id]);
  return res.rows[0] as { browser_version: number | null; browser_opt_in: boolean };
}

async function browserRow(sessionId: string) {
  const res = await su.query("select * from app.work_browsers where work_session_id = $1", [sessionId]);
  return (res.rows[0] as Row | undefined) ?? null;
}

async function audits(sessionId: string, action?: string) {
  const res = await su.query(
    `select action, actor_kind, actor_id, user_id, device_id, session_id, resource_type, resource_id, result, metadata
       from app.audit_events where session_id = $1 and action like 'work_browser.%' ${action ? "and action = $2" : ""}
       order by occurred_at, id`,
    action ? [sessionId, action] : [sessionId],
  );
  return res.rows as Array<{
    action: string;
    actor_kind: string;
    actor_id: string | null;
    user_id: string | null;
    device_id: string | null;
    session_id: string | null;
    resource_type: string;
    resource_id: string | null;
    result: string;
    metadata: Row;
  }>;
}

/** Owen writes a prompt in `sessionId`; the device receives and acks it. Returns the prompt id. */
async function prompt(sessionId: string, body = "open the dev server"): Promise<string> {
  const res = await owen.request("POST", `/api/v1/work-sessions/${sessionId}/prompts`, { body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const cmd = await d.command("prompt", sessionId);
  d.ack(cmd.id);
  return res.body!.id as string;
}

/**
 * Frames of one socket are handled in order: once a `capabilities` frame sent now is stored (the opt-in flipped),
 * every frame `dev` sent before it was handled.
 */
async function barrier(dev: FakeDevice, deviceId: string): Promise<void> {
  const before = (await deviceBrowser(deviceId)).browser_opt_in;
  dev.capabilities([], false, undefined, { version: 1, optIn: !before });
  await eventually(async () => (await deviceBrowser(deviceId)).browser_opt_in === !before);
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
  ({ client: owen, userId: owenId } = await invite(stack, ada, "owen@example.test", "Owen", "developer"));

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
}, 240_000);

afterEach(() => {
  // No frame of these tests is ever refused as invalid.
  for (const dev of open) expect(dev.frames.filter((f) => f.type === "error")).toEqual([]);
});

afterAll(async () => {
  for (const dev of open) await dev.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

describe("07.13-08 Task 1: a device with a browser opens a page and the Control Plane records and audits it", () => {
  it("hello stores the browser capability; a device without it stores null and false", async () => {
    expect(await deviceBrowser(dId)).toEqual({ browser_version: 1, browser_opt_in: true });
    expect(await deviceBrowser(aId)).toEqual({ browser_version: null, browser_opt_in: false });
  });

  it("a capabilities frame updates the opt-in; one without `browser` leaves it", async () => {
    d.capabilities([], false, undefined, { version: 1, optIn: false });
    await eventually(async () => (await deviceBrowser(dId)).browser_opt_in === false);
    d.capabilities([], false);
    await sleep(100);
    d.capabilities([], false, undefined, { version: 1, optIn: true });
    await eventually(async () => (await deviceBrowser(dId)).browser_opt_in === true);
    expect((await deviceBrowser(dId)).browser_version).toBe(1);
  });

  it("`opened` upserts the session's browser and audits the origin only, as the device for the prompt's author", async () => {
    const s = await startSession(owen, d, projectId);
    const promptId = await prompt(s);
    d.browserEvent(s, { promptId, kind: "opened", origin: ORIGIN, action: "open" });
    const [row] = await eventually(async () => {
      const list = await audits(s, "work_browser.opened");
      return list.length > 0 ? list : undefined;
    });
    expect(row).toEqual({
      action: "work_browser.opened",
      actor_kind: "device",
      actor_id: dId,
      user_id: owenId,
      device_id: dId,
      session_id: s,
      resource_type: "work_session",
      resource_id: s,
      result: "success",
      metadata: { origin: ORIGIN },
    });
    expect(await browserRow(s)).toMatchObject({ state: "open", origin: ORIGIN, closed_at: null });
  });

  it("the same frame from another device of the organization changes no row and writes no audit", async () => {
    const s = await startSession(owen, d, projectId);
    const promptId = await prompt(s);
    a.browserEvent(s, { promptId, kind: "opened", origin: ORIGIN });
    a.browserEvent(s, { promptId, kind: "closed", origin: ORIGIN });
    await barrier(a, aId);
    expect(await browserRow(s)).toBeNull();
    expect(await audits(s)).toEqual([]);

    // Owen's device opens it; Ada's device then tries to close it: the page stays open.
    d.browserEvent(s, { promptId, kind: "opened", origin: ORIGIN });
    await eventually(async () => (await browserRow(s))?.state === "open");
    a.browserEvent(s, { promptId, kind: "closed", origin: ORIGIN });
    await barrier(a, aId);
    expect(await browserRow(s)).toMatchObject({ state: "open" });
    expect((await audits(s)).map((r) => r.action)).toEqual(["work_browser.opened"]);
  });
});

/** What the audit metadata may ever look like: the origin and enum codes, nothing else (T-07.13-08-02). */
const METADATA_SHAPE =
  /^\{("origin":"https?:\/\/[^/"?#]+:\d+"|"action":"[a-z]+"|"refusal":"[a-z_]+"|"failure":"[a-z_]+"|"endReason":"[a-z_]+"|,)*\}$/;

describe("07.13-08 Task 3: every browser event kind is audited with ids and the origin only", () => {
  const GITHUB = "https://github.com:443";

  /** Send `events` for a fresh session (opened first), wait for `count` more audit rows, return them. */
  async function run(events: Array<Record<string, unknown> & { kind: string }>, count: number) {
    const s = await startSession(owen, d, projectId);
    const promptId = await prompt(s);
    d.browserEvent(s, { promptId, kind: "opened", origin: ORIGIN });
    for (const e of events) d.browserEvent(s, { promptId, ...e });
    await eventually(async () => (await audits(s)).length >= count + 1);
    await barrier(d, dId);
    return { s, rows: (await audits(s)).slice(1) };
  }

  it("navigated, acted, refused (refusal or failure) and closed are audited as the table says", async () => {
    const { s, rows } = await run(
      [
        { kind: "navigated", origin: GITHUB, action: "navigate" },
        { kind: "acted", origin: GITHUB, action: "click" },
        { kind: "refused", origin: GITHUB, refusal: "metadata_refused" },
        { kind: "refused", origin: null, failure: "missing_library" },
        { kind: "closed", origin: GITHUB, action: "close" },
      ],
      5,
    );
    expect(rows.map((r) => [r.action, r.result, r.metadata])).toEqual([
      ["work_browser.navigated", "success", { origin: GITHUB }],
      ["work_browser.acted", "success", { origin: GITHUB, action: "click" }],
      ["work_browser.refused", "denied", { origin: GITHUB, refusal: "metadata_refused" }],
      ["work_browser.refused", "denied", { failure: "missing_library" }],
      ["work_browser.closed", "success", { origin: GITHUB }],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({ actor_kind: "device", actor_id: dId, user_id: owenId, device_id: dId });
    }
    const row = await browserRow(s);
    expect(row).toMatchObject({ state: "closed", origin: GITHUB, lease_id: null, controller_user_id: null });
    expect(row!.closed_at).not.toBeNull();
  });

  it("navigated updates the row's origin while the page stays open", async () => {
    const { s } = await run([{ kind: "navigated", origin: GITHUB }], 1);
    expect(await browserRow(s)).toMatchObject({ state: "open", origin: GITHUB, closed_at: null });
  });

  it("crashed and takeover_abandoned close the row and clear its lease, audited as closed with endReason", async () => {
    for (const kind of ["crashed", "takeover_abandoned"] as const) {
      const s = await startSession(owen, d, projectId);
      const promptId = await prompt(s);
      d.browserEvent(s, { promptId, kind: "opened", origin: ORIGIN });
      await eventually(async () => (await browserRow(s))?.state === "open");
      // A person held the page (the lease columns are set together, 07.13-03).
      await su.query(
        "update app.work_browsers set lease_id = gen_random_uuid(), controller_user_id = $2, lease_expires_at = now() + interval '1 minute', lease_input = true where work_session_id = $1",
        [s, owenId],
      );
      d.browserEvent(s, { promptId, kind, origin: null });
      const closed = await eventually(async () => {
        const list = await audits(s, "work_browser.closed");
        return list.length > 0 ? list : undefined;
      });
      // The frame carried no origin: the page's last origin is audited.
      expect(closed.map((r) => r.metadata)).toEqual([{ origin: ORIGIN, endReason: kind }]);
      expect(await browserRow(s)).toMatchObject({
        state: "closed",
        lease_id: null,
        controller_user_id: null,
        lease_expires_at: null,
        lease_input: false,
      });
    }
  });

  it("a prompt of another session never names the audit's user", async () => {
    const other = await startSession(owen, d, projectId);
    const foreignPrompt = await prompt(other, "another session's turn");
    const s = await startSession(owen, d, projectId);
    d.browserEvent(s, { promptId: foreignPrompt, kind: "opened", origin: ORIGIN });
    d.browserEvent(s, { promptId: "not-a-uuid", kind: "acted", origin: ORIGIN, action: "click" });
    d.browserEvent(s, { promptId: null, kind: "acted", origin: ORIGIN, action: "scroll" });
    const rows = await eventually(async () => {
      const list = await audits(s);
      return list.length >= 3 ? list : undefined;
    });
    expect(rows.map((r) => r.user_id)).toEqual([null, null, null]);
    expect(rows.map((r) => r.actor_id)).toEqual([dId, dId, dId]);
  });

  it("signin_loaded and signin_unloaded are accepted and ignored here", async () => {
    const s = await startSession(owen, d, projectId);
    const promptId = await prompt(s);
    d.browserEvent(s, { promptId, kind: "signin_loaded", origin: GITHUB });
    d.browserEvent(s, { promptId, kind: "signin_unloaded", origin: GITHUB });
    await barrier(d, dId);
    expect(await audits(s)).toEqual([]);
    expect(await browserRow(s)).toBeNull();
  });

  it("every work_browser.* audit row's metadata is the origin and enum codes only", async () => {
    const res = await su.query(
      "select action, metadata::text as m from app.audit_events where action like 'work_browser.%'",
    );
    const rows = res.rows as Array<{ action: string; m: string }>;
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) expect(JSON.stringify(JSON.parse(r.m)), r.action).toMatch(METADATA_SHAPE);
  });
});
