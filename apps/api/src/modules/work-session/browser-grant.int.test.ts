import { randomUUID } from "node:crypto";
import { SessionBrowserGrant } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, type FakeDevice } from "../../testing-device";
import { connectWithProject, invite, pairDevice } from "../../testing-workzone";

/**
 * Phase 07.13 Plan 07 (D-10, D-19, PD-09, PD-20) on a real PostgreSQL + Redis and the full API: the browser a turn may
 * use is decided by the API at send time (org policy ∩ the device's opt-in ∩ its capability) and rides only the copy
 * of `session.start` / `prompt` its device receives, never the stored `device_commands` row. A device that never
 * reported a browser version gets no `browser` key at all (an older daemon sees today's payload).
 */

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

let stack: TestStack;
let su: pg.Client;
let victor: TestClient; // admin
let dana: TestClient; // developer, owner of the device
let danaId: string;
let device: FakeDevice;
let deviceId: string;
let projectId: string;

async function ok(res: Promise<{ status: number; body: Json | null }>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const setPolicy = (allowBrowser: boolean) =>
  ok(victor.request("PUT", "/api/v1/work-zone-policy", { allowBrowser }));

/** The device's browser columns as the hub stores them from `hello.browser` (plan 08); set here by SQL. */
const setDevice = (version: number | null, optIn: boolean, id = deviceId) =>
  su.query("update app.devices set browser_version = $2, browser_opt_in = $3 where id = $1", [
    id,
    version,
    optIn,
  ]);

const storedPayload = async (commandId: string) =>
  (await su.query("select payload from app.device_commands where id = $1", [commandId])).rows[0]
    ?.payload as Json;

const sessionOf = async (as: TestClient, id: string) =>
  (await ok(as.request("GET", `/api/v1/work-sessions/${id}`))).session as Json;

/** `as` prompts `sid`; the `prompt` frame the device received, after its turn ran to the end (the session is idle). */
async function promptFrame(as: TestClient, sid: string, dev = device) {
  const promptId = (
    await ok(as.request("POST", `/api/v1/work-sessions/${sid}/prompts`, { body: "Open the app" }))
  ).id as string;
  const frame = await dev.command("prompt", sid);
  dev.ack(frame.id);
  dev.emitTurn(sid, { promptId, text: "Done" });
  await eventually(async () => (await sessionOf(as, sid)).status === "idle");
  return { frame, promptId };
}

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  victor = new TestClient(stack.baseUrl);
  await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  ({ client: dana, userId: danaId } = await invite(stack, victor, "dana@example.test", "Dana", "developer"));
  const paired = await pairDevice(stack, dana, "Dana's Mac");
  deviceId = paired.deviceId;
  ({ device, projectId } = await connectWithProject(stack, dana, paired.token, {
    localId: "lp_web",
    name: "web",
  }));
}, 180_000);

afterAll(async () => {
  await device?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

describe("the per-turn browser grant (D-10, PD-09, PD-20)", () => {
  let sid: string;

  it("session.start on a capable, opted-in device of an allowing org carries a grant for the creator", async () => {
    await setPolicy(true);
    await setDevice(1, true);
    const created = await ok(dana.request("POST", "/api/v1/work-sessions", { projectId }));
    sid = created.id as string;
    const start = await device.command("session.start", sid);
    const grant = SessionBrowserGrant.parse(start.payload.browser);
    expect(grant).toMatchObject({ allowed: true, reason: "ok", askerId: danaId, askerIsBot: false });
    // Sent copy only: never written to the stored command.
    expect(await storedPayload(start.id)).not.toHaveProperty("browser");
    device.ack(start.id);
    device.event(sid, {
      type: "session.started",
      runtime: "claude-code",
      runtimeSessionId: `rt-${sid}`,
      model: "claude-opus-5-5",
      permissionMode: "default",
    });
    device.event(sid, { type: "session.state", status: "idle" });
    await eventually(async () => (await sessionOf(dana, sid)).status === "idle");
  });

  it("a prompt carries an allowed grant whose asker is the prompt's author; the stored command has no browser", async () => {
    const { frame } = await promptFrame(dana, sid);
    const grant = SessionBrowserGrant.parse(frame.payload.browser);
    expect(grant).toMatchObject({
      allowed: true,
      reason: "ok",
      askerId: danaId,
      askerIsBot: false,
      alwaysAsk: [],
      whenTainted: [],
    });
    const stored = await storedPayload(frame.id);
    expect(stored).not.toHaveProperty("browser");
    expect(JSON.stringify(stored)).not.toContain("askerId");
  });

  it("policy off → off_policy (even with the device opted out); opt-in off → off_device", async () => {
    await setPolicy(false);
    let grant = SessionBrowserGrant.parse((await promptFrame(dana, sid)).frame.payload.browser);
    expect(grant).toMatchObject({
      allowed: false,
      reason: "off_policy",
      askerId: danaId,
      signinAllowed: false,
    });
    await setDevice(1, false);
    grant = SessionBrowserGrant.parse((await promptFrame(dana, sid)).frame.payload.browser);
    expect(grant.reason).toBe("off_policy");
    await setPolicy(true);
    grant = SessionBrowserGrant.parse((await promptFrame(dana, sid)).frame.payload.browser);
    expect(grant).toMatchObject({ allowed: false, reason: "off_device", alwaysAsk: [], whenTainted: [] });
    // Fresh at send time: the very next turn after the opt-in comes back is allowed again.
    await setDevice(1, true);
    grant = SessionBrowserGrant.parse((await promptFrame(dana, sid)).frame.payload.browser);
    expect(grant).toMatchObject({ allowed: true, reason: "ok" });
  });

  it("a device that never reported a browser version gets no browser key on prompt or start", async () => {
    await setDevice(null, false);
    const { frame } = await promptFrame(dana, sid);
    expect(frame.payload).not.toHaveProperty("browser");
    const created = await ok(dana.request("POST", "/api/v1/work-sessions", { projectId }));
    const start = await device.command("session.start", created.id as string);
    expect(start.payload).not.toHaveProperty("browser");
    device.ack(start.id);
    await setDevice(1, true);
  });

  it("another organization's switch never reaches this org's grant", async () => {
    const orgB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
      orgB,
      `o-${orgB}`,
    ]);
    await su.query("insert into app.work_zone_policies (organization_id, allow_browser) values ($1, true)", [
      orgB,
    ]);
    await setPolicy(false);
    const grant = SessionBrowserGrant.parse((await promptFrame(dana, sid)).frame.payload.browser);
    expect(grant.reason).toBe("off_policy");
    await setPolicy(true);
  });
});
