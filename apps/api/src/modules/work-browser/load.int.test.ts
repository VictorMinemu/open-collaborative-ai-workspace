import { randomUUID } from "node:crypto";
import { BrowserSignInStateFrame } from "@ocw/contracts";
import pg from "pg";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice, type Frame, sleep } from "../../testing-device";
import { invite, pairDevice, shareDevice, startSession } from "../../testing-workzone";
import { sealWorkSignIn, workSignInAad } from "./signins";

/**
 * Phase 07.13-17 Task 2 (D-24, D-25, D-29, D-32, PD-16, PD-17, P7) on a real PostgreSQL + Redis and the full API: a
 * member's Work Zone sign-in reaches the device only as the answer to that device's own `browser.signin.load`, on the
 * same socket, and only for the member's own in-flight human turn in a human session that only they (and the device
 * owner) can see, while the organization's policy and the device's opt-in allow the browser. Every other case answers
 * `{ ok: false, reason }`; a frame from another device gets no answer at all. The state never crosses Redis. While it is
 * loaded the device may re-seal it; `signin_unloaded` ends that.
 */

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const ORIGIN = "http://127.0.0.1:4300";
const SITE = "127.0.0.1:4300";
const CANARY = `canary-${randomUUID()}`;

let stack: TestStack;
let su: pg.Client;
let orgA: string;
let ada: TestClient; // admin
let owen: TestClient; // developer, owns the device
let owenId: string;
let piaId: string;
let d: FakeDevice;
let dId: string;
let spare: FakeDevice; // Owen's second device
let spareId: string;
let projectId: string;
let botId: string;
/** Owen's session and his in-flight prompt the matrix runs against. */
let sid: string;
let promptId: string;
let signinId: string;
let monitor: ReturnType<typeof createClient>;
/** Every command Redis saw while the matrix ran (MONITOR). */
const redisSeen: string[] = [];
const open: FakeDevice[] = [];

const core = () => stack.built.core;

const cookie = (value: string, expires = 2_000_000_000) => ({
  name: "sid",
  value,
  domain: "127.0.0.1",
  path: "/",
  expires,
  httpOnly: true,
  secure: false,
  sameSite: "Lax" as const,
});

/** Seals Owen's sign-in for `origin` through the module's own seal (as Owen). */
async function sealFor(userId: string, origin: string, value: string): Promise<string> {
  const sealed = await core().db.withTenant({ organizationId: orgA, userId }, (tx) =>
    sealWorkSignIn(tx, core(), {
      userId,
      origin,
      rawState: JSON.stringify({ cookies: [cookie(value)], origins: [] }),
      device: { deviceId: dId, sessionId: sid },
    }),
  );
  if (!sealed) throw new Error("nothing sealed");
  return sealed.signinId;
}

/** `dev` asks for the sign-in of `origin` in `sessionId` for `prompt`; returns the request id. */
function askLoad(dev: FakeDevice, origin = ORIGIN, sessionId = sid, prompt = promptId): string {
  const requestId = randomUUID();
  dev.send({ type: "browser.signin.load", requestId, sessionId, promptId: prompt, origin });
  return requestId;
}

async function answer(dev: FakeDevice, requestId: string): Promise<BrowserSignInStateFrame> {
  const frame = await dev.next((f) => f.type === "browser.signin.state" && f.requestId === requestId);
  return BrowserSignInStateFrame.parse(frame);
}

async function refusal(origin = ORIGIN): Promise<string> {
  const res = await answer(d, askLoad(d, origin));
  if (res.result.ok) throw new Error("expected a refusal");
  return res.result.reason;
}

const browserRow = async (sessionId = sid) =>
  (await su.query("select * from app.work_browsers where work_session_id = $1", [sessionId])).rows[0] as
    | Json
    | undefined;

const signinRow = async (id: string) =>
  (await su.query("select * from app.work_browser_signins where id = $1", [id])).rows[0] as Json;

const loadedAudits = async () =>
  (
    await su.query(
      "select actor_kind, actor_id, user_id, device_id, session_id, resource_id, metadata from app.audit_events where action = 'work_browser.signin_loaded' order by occurred_at, id",
    )
  ).rows as Json[];

async function put(path: string, token: string | null, body: unknown) {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    method: "PUT",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Json | null };
}

const reseal = (id: string, token: string | null, value: string, expires?: number) =>
  put(`/api/v1/runtime/browser-signins/${id}/state`, token, {
    sessionId: sid,
    origin: ORIGIN,
    state: { cookies: [cookie(value, expires)], origins: [] },
    changed: true,
  });

/**
 * Frames of one socket are handled in order: once a `capabilities` frame sent now is stored, every frame `dev` sent
 * before it was handled.
 */
async function barrier(dev: FakeDevice, deviceId: string): Promise<void> {
  const read = async () =>
    ((await su.query("select browser_opt_in from app.devices where id = $1", [deviceId])).rows[0] as Json)
      .browser_opt_in as boolean;
  const before = await read();
  dev.capabilities([], false, undefined, { version: 1, optIn: !before });
  await eventually(async () => (await read()) === !before);
  dev.capabilities([], false, undefined, { version: 1, optIn: before });
  await eventually(async () => (await read()) === before);
}

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  ada = new TestClient(stack.baseUrl);
  const setup = await ada.request("POST", "/api/v1/setup", {
    token: TEST_SETUP_TOKEN,
    name: "Ada Admin",
    email: "ada@example.test",
    password: "correct-horse-battery",
    orgName: "Autofy Labs",
  });
  expect(setup.status, JSON.stringify(setup.body)).toBe(200);
  orgA = (setup.body!.organization as Json).id as string;
  ({ client: owen, userId: owenId } = await invite(stack, ada, "owen@example.test", "Owen", "developer"));
  ({ userId: piaId } = await invite(stack, ada, "pia@example.test", "Pia", "developer"));
  expect((await ada.request("PUT", "/api/v1/work-zone-policy", { allowBrowser: true })).status).toBe(200);

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
  const second = await pairDevice(stack, owen, "Owen's spare");
  spareId = second.deviceId;
  spare = await FakeDevice.connect(stack.baseUrl, second.token, undefined, {
    browser: { version: 1, optIn: true },
  });
  open.push(spare);

  botId = (
    (
      await su.query(
        "insert into app.agents (organization_id, name, username, instructions, model_provider, model_id) values ($1, 'Scout', 'scout', 'Help', 'mock', 'mock-1') returning id",
        [orgA],
      )
    ).rows[0] as Json
  ).id as string;

  // Owen's personal session and his prompt, delivered to the device and not finished: the in-flight turn.
  sid = await startSession(owen, d, projectId);
  const res = await owen.request("POST", `/api/v1/work-sessions/${sid}/prompts`, {
    body: "open the dev server",
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  promptId = res.body!.id as string;
  const cmd = await d.command("prompt", sid);
  d.ack(cmd.id);
  await eventually(async () => {
    const r = await su.query("select status from app.work_prompts where id = $1", [promptId]);
    return ["dispatched", "running"].includes((r.rows[0] as Json).status) || undefined;
  });
  signinId = await sealFor(owenId, ORIGIN, CANARY);

  monitor = createClient({ url: stack.redis.getConnectionUrl() });
  await monitor.connect();
  await monitor.monitor((reply) => {
    redisSeen.push(String(reply));
  });
}, 240_000);

afterAll(async () => {
  monitor?.destroy();
  for (const dev of open) await dev.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

describe("07.13-17 Task 2: the sign-in load, answered on the requesting socket only", () => {
  it("the member's own in-flight turn in their personal session: the state on that socket, recorded and audited", async () => {
    const res = await answer(d, askLoad(d));
    expect(res.result.ok).toBe(true);
    if (!res.result.ok) return;
    expect(res.result.signinId).toBe(signinId);
    expect(res.result.state).toEqual({ cookies: [cookie(CANARY)], origins: [] });
    expect(Date.parse(res.result.expiresAt)).toBeGreaterThan(Date.now());
    // Only that socket: the other device of the same owner received nothing.
    expect(spare.frames.filter((f: Frame) => f.type === "browser.signin.state")).toEqual([]);

    expect(await browserRow()).toMatchObject({ signin_id: signinId, signin_user_id: owenId });
    expect((await signinRow(signinId)).last_used_at).not.toBeNull();
    expect(await loadedAudits()).toEqual([
      {
        actor_kind: "device",
        actor_id: dId,
        user_id: owenId,
        device_id: dId,
        session_id: sid,
        resource_id: signinId,
        metadata: { origin: ORIGIN },
      },
    ]);
  });

  it("the state never crossed Redis, a device command, an event or an audit row", async () => {
    await sleep(200);
    expect(redisSeen.length).toBeGreaterThan(0);
    expect(redisSeen.filter((line) => line.includes(CANARY))).toEqual([]);
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

  it("while loaded the session's device re-seals it in place; another device cannot", async () => {
    const soon = Math.floor(Date.now() / 1000) + 2 * 24 * 3600;
    const res = await reseal(signinId, d.jwt, "rolled", soon);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ saved: true });
    const row = await signinRow(signinId);
    expect(new Date(String(row.expires_at)).getTime()).toBe(soon * 1000);
    const sealed = JSON.parse(
      await core().db.withTenant({ organizationId: orgA, userId: owenId }, (tx) =>
        core().secrets.revealSealed(
          tx,
          row.secret_id as string,
          workSignInAad({ organizationId: orgA, userId: owenId, siteKey: SITE }),
        ),
      ),
    ) as Json;
    expect(sealed.cookies).toEqual([cookie("rolled", soon)]);
    expect((await reseal(signinId, spare.jwt, "evil")).status).toBe(404);
    expect((await reseal(signinId, await owen.token(), "evil")).status).toBe(401);
  });

  it("`signin_unloaded` from the session's device clears the loaded sign-in; a re-seal is then 409", async () => {
    // Another device's unload changes nothing.
    spare.browserEvent(sid, { kind: "signin_unloaded", origin: ORIGIN, promptId });
    await barrier(spare, spareId);
    expect(await browserRow()).toMatchObject({ signin_id: signinId, signin_user_id: owenId });

    d.browserEvent(sid, { kind: "signin_unloaded", origin: ORIGIN, promptId });
    await eventually(async () => (await browserRow())?.signin_user_id === null || undefined);
    expect(await browserRow()).toMatchObject({ signin_id: null, signin_user_id: null });
    const res = await reseal(signinId, d.jwt, "late");
    expect(res.status).toBe(409);
    expect((res.body!.error as Json).code).toBe("not_loaded");
  });

  it("a frame from another device is never answered and changes nothing", async () => {
    const before = (await loadedAudits()).length;
    askLoad(spare);
    await sleep(800);
    expect(spare.frames.filter((f: Frame) => f.type === "browser.signin.state")).toEqual([]);
    expect((await browserRow())?.signin_user_id).toBeNull();
    expect(await loadedAudits()).toHaveLength(before);
  });

  it("no sign-in for the site → no_context", async () => {
    expect(await refusal("http://127.0.0.1:4399")).toBe("no_context");
  });

  it("an expired sign-in → signin_expired, never loaded", async () => {
    await su.query(
      "update app.work_browser_signins set expires_at = now() - interval '1 minute' where id = $1",
      [signinId],
    );
    try {
      expect(await refusal()).toBe("signin_expired");
      expect((await browserRow())?.signin_user_id).toBeNull();
    } finally {
      await su.query(
        "update app.work_browser_signins set expires_at = now() + interval '1 day' where id = $1",
        [signinId],
      );
    }
  });

  it("the prompt is another member's → signin_not_allowed", async () => {
    await su.query("update app.work_prompts set author_user_id = $2 where id = $1", [promptId, piaId]);
    try {
      expect(await refusal()).toBe("signin_not_allowed");
    } finally {
      await su.query("update app.work_prompts set author_user_id = $2 where id = $1", [promptId, owenId]);
    }
  });

  it("a prompt that is not in flight (or not of this session) → signin_not_allowed", async () => {
    expect((await answer(d, askLoad(d, ORIGIN, sid, randomUUID()))).result).toEqual({
      ok: false,
      reason: "signin_not_allowed",
    });
    expect((await answer(d, askLoad(d, ORIGIN, sid, "not-a-uuid"))).result).toEqual({
      ok: false,
      reason: "signin_not_allowed",
    });
  });

  it("a bot-authored prompt or a bot-started session → signin_not_allowed", async () => {
    await su.query("update app.work_prompts set author_agent_id = $2 where id = $1", [promptId, botId]);
    try {
      expect(await refusal()).toBe("signin_not_allowed");
    } finally {
      await su.query("update app.work_prompts set author_agent_id = null where id = $1", [promptId]);
    }
    await su.query("update app.work_sessions set started_by_agent_id = $2 where id = $1", [sid, botId]);
    try {
      expect(await refusal()).toBe("signin_not_allowed");
    } finally {
      await su.query("update app.work_sessions set started_by_agent_id = null where id = $1", [sid]);
    }
  });

  it("the organization's policy off, or the device's opt-in off → not_allowed", async () => {
    expect((await ada.request("PUT", "/api/v1/work-zone-policy", { allowBrowser: false })).status).toBe(200);
    try {
      expect(await refusal()).toBe("not_allowed");
    } finally {
      expect((await ada.request("PUT", "/api/v1/work-zone-policy", { allowBrowser: true })).status).toBe(200);
    }
    await su.query("update app.devices set browser_opt_in = false where id = $1", [dId]);
    try {
      expect(await refusal()).toBe("not_allowed");
    } finally {
      await su.query("update app.devices set browser_opt_in = true where id = $1", [dId]);
    }
    expect((await browserRow())?.signin_user_id).toBeNull();
  });

  it("the session also visible to a third person → signin_not_allowed (D-32)", async () => {
    // The device shared with Pia: she may use it, so she sees Owen's personal session on it.
    await shareDevice(owen, dId, piaId);
    expect(await refusal()).toBe("signin_not_allowed");
    expect((await browserRow())?.signin_user_id).toBeNull();
  });
});
