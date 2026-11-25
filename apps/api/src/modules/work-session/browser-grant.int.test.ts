import { randomUUID } from "node:crypto";
import { SessionBrowserGrant } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, type FakeDevice } from "../../testing-device";
import {
  connectWithProject,
  invite,
  pairDevice,
  setAudience,
  shareDevice,
  startSession,
} from "../../testing-workzone";
import { createPermissionService } from "../organization";
import { browserGrantFor } from "./browser-grant";
import type { WorkSessionService } from "./service";

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
let orgId: string;
let eli: TestClient; // developer, owner of a second device
let eliId: string;
let eliDevice: FakeDevice;
let eliDeviceId: string;
let eliProjectId: string;

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
  const setup = await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = (setup.organization as Json).id as string;
  ({ client: dana, userId: danaId } = await invite(stack, victor, "dana@example.test", "Dana", "developer"));
  const paired = await pairDevice(stack, dana, "Dana's Mac");
  deviceId = paired.deviceId;
  ({ device, projectId } = await connectWithProject(stack, dana, paired.token, {
    localId: "lp_web",
    name: "web",
  }));
  ({ client: eli, userId: eliId } = await invite(stack, victor, "eli@example.test", "Eli", "developer"));
  const eliPaired = await pairDevice(stack, eli, "Eli's Mac");
  eliDeviceId = eliPaired.deviceId;
  ({ device: eliDevice, projectId: eliProjectId } = await connectWithProject(stack, eli, eliPaired.token, {
    localId: "lp_api",
    name: "api",
  }));
}, 180_000);

afterAll(async () => {
  await device?.close().catch(() => {});
  await eliDevice?.close().catch(() => {});
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

// ---------------------------------------------------------------- Task 2: rule modes, sign-in audience, DTO state

/** An admin's per-tool rule, stored as the tool-approval routes store it (scope null = the organization). */
const addRule = (
  toolPattern: string,
  mode: "always" | "when_tainted" | "never",
  scopeUnitId: string | null = null,
  organizationId = orgId,
) =>
  su.query(
    `insert into app.tool_approval_policies (organization_id, scope_unit_id, tool_pattern, mode, approver_kind)
     values ($1, $2, $3, $4, $5)`,
    // Approver kinds are not honoured in v1 (D-34); `never` only takes `requester` (the table's check).
    [organizationId, scopeUnitId, toolPattern, mode, mode === "never" ? "requester" : "admins"],
  );

/** A started, idle session of `as` on `dev` (its project), with the start frame consumed. */
const idleSession = (as: TestClient, dev: FakeDevice, project: string) => startSession(as, dev, project);

const grantOf = async (as: TestClient, sid: string, dev = device) =>
  SessionBrowserGrant.parse((await promptFrame(as, sid, dev)).frame.payload.browser);

describe("admin rule modes, the sign-in audience and the session's browser state (D-19, D-32, D-34, PD-26)", () => {
  let danaSid: string;
  let eliSid: string;
  let sales: string;

  beforeAll(async () => {
    await setPolicy(true);
    await setDevice(1, true);
    await setDevice(1, true, eliDeviceId);
    danaSid = await idleSession(dana, device, projectId);
    eliSid = await idleSession(eli, eliDevice, eliProjectId);
    sales = (
      await ok(victor.request("POST", "/api/v1/units", { kind: "department", name: "Sales", parentId: null }))
    ).id as string;
    await ok(victor.request("POST", `/api/v1/units/${sales}/members`, { userId: danaId }));
  });

  it("rule modes ride the grant: always → alwaysAsk, when_tainted → whenTainted, approvers ignored", async () => {
    await addRule("ocw_browser_open", "always");
    await addRule("ocw_browser_act", "when_tainted");
    await addRule("ocw_browser_wait", "never");
    // A rule on another tool changes nothing.
    await addRule("notes__write_note", "always");
    // A unit rule applies only to an asker in that unit (Dana, not Eli).
    await addRule("ocw_browser_snapshot", "always", sales);
    const d = await grantOf(dana, danaSid);
    expect(d).toMatchObject({ allowed: true, alwaysAsk: ["open", "snapshot"], whenTainted: ["act"] });
    const e = await grantOf(eli, eliSid, eliDevice);
    expect(e).toMatchObject({ allowed: true, alwaysAsk: ["open"], whenTainted: ["act"] });
  });

  it("another organization's rules never change this org's grant", async () => {
    const orgB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Beta', $2)", [
      orgB,
      `b-${orgB}`,
    ]);
    await addRule("ocw_browser_screenshot", "always", null, orgB);
    await addRule("ocw_browser_snapshot", "when_tainted", null, orgB);
    const e = await grantOf(eli, eliSid, eliDevice);
    expect(e.alwaysAsk).toEqual(["open"]);
    expect(e.whenTainted).toEqual(["act"]);
  });

  it("signinAllowed: a personal session on the member's own device, seen by nobody else", async () => {
    expect((await grantOf(dana, danaSid)).signinAllowed).toBe(true);
  });

  it("signinAllowed is false once another member sees the session, true again when it is back to its owner", async () => {
    // Sharing the device widens a personal project's audience (`project` = whoever may use the device).
    await shareDevice(dana, deviceId, eliId);
    expect((await grantOf(dana, danaSid)).signinAllowed).toBe(false);
    await setAudience(dana, danaSid, { kind: "owner" });
    expect((await grantOf(dana, danaSid)).signinAllowed).toBe(true);
  });

  it("signinAllowed: a session on a device owned by O and visible only to M and O", async () => {
    // Eli (O) shares his device with Dana (M) only; Dana's session there is seen by Dana and Eli.
    await shareDevice(eli, eliDeviceId, danaId);
    const sid = await idleSession(dana, eliDevice, eliProjectId);
    expect((await grantOf(dana, sid, eliDevice)).signinAllowed).toBe(true);
  });

  it("signinAllowed is false for a bot asker and in a bot-started session", async () => {
    const { db } = stack.built.core;
    const perms = createPermissionService(stack.built.core);
    const agentId = (
      await su.query(
        "insert into app.agents (organization_id, name, username, instructions, model_provider, model_id) values ($1, 'Scout', 'scout', 'Help', 'mock', 'mock-1') returning id",
        [orgId],
      )
    ).rows[0].id as string;
    const asBot = await db.withTenant({ organizationId: orgId, userId: null }, (tx) =>
      browserGrantFor(tx, perms, { sessionId: danaSid, askerId: agentId, askerIsBot: true }),
    );
    expect(asBot).toMatchObject({ allowed: true, askerId: agentId, askerIsBot: true, signinAllowed: false });
    // A person's turn in a session a bot started.
    const sid = await idleSession(dana, device, projectId);
    await setAudience(dana, sid, { kind: "owner" });
    expect((await grantOf(dana, sid)).signinAllowed).toBe(true);
    await su.query("update app.work_sessions set started_by_agent_id = $2 where id = $1", [sid, agentId]);
    expect((await grantOf(dana, sid)).signinAllowed).toBe(false);
  });

  it("GET /work-sessions/:id shows the browser state from policy, opt-in and capability; live from an open page", async () => {
    const state = async () => (await sessionOf(dana, danaSid)).browser as Json;
    expect(await state()).toEqual({ status: "available", live: false });
    await su.query(
      "insert into app.work_browsers (work_session_id, organization_id, state) values ($1, $2, 'open')",
      [danaSid, orgId],
    );
    expect(await state()).toEqual({ status: "available", live: true });
    // The list shows it too, from one batched read.
    const list = (await ok(dana.request("GET", "/api/v1/work-sessions"))).sessions as Json[];
    expect(list.find((s) => s.id === danaSid)?.browser).toEqual({ status: "available", live: true });
    expect(list.every((s) => s.browser && typeof s.browser.status === "string")).toBe(true);
    await su.query(
      "update app.work_browsers set state = 'closed', closed_at = now() where work_session_id = $1",
      [danaSid],
    );
    expect(await state()).toEqual({ status: "available", live: false });

    await setDevice(1, false);
    expect((await state()).status).toBe("off_device");
    await setPolicy(false);
    expect((await state()).status).toBe("off_policy");
    await setDevice(null, false);
    expect((await state()).status).toBe("update_device");
    await setPolicy(true);
    await setDevice(1, true);
    expect((await state()).status).toBe("available");
  });

  it("another organization cannot read this org's sessions or their browser state", async () => {
    const orgB = randomUUID();
    const userB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Gamma', $2)", [
      orgB,
      `g-${orgB}`,
    ]);
    await su.query("insert into auth.user (id, name, email) values ($1, 'Gil', $2)", [
      userB,
      `${userB}@g.test`,
    ]);
    await su.query(
      "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Gil', 'admin')",
      [orgB, userB],
    );
    const svc = stack.built.deviceHub.sessionHandler as unknown as WorkSessionService;
    const { db } = stack.built.core;
    const inB = await db.withTenant({ organizationId: orgB, userId: userB }, (tx) =>
      svc.readableSessions(tx, userB),
    );
    expect(inB).toEqual([]);
    const perms = createPermissionService(stack.built.core);
    const grantB = await db.withTenant({ organizationId: orgB, userId: null }, (tx) =>
      browserGrantFor(tx, perms, { sessionId: danaSid, askerId: userB, askerIsBot: false }),
    );
    expect(grantB).toBeNull();
  });
});
