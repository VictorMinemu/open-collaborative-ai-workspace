import { randomUUID } from "node:crypto";
import { isExposed, type RuntimeCatalog } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, type FakeDevice, type Frame, sleep } from "../../testing-device";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  connectWithProject,
  errorCode,
  invite,
  pairDevice,
  startSession,
} from "../../testing-workzone";

/**
 * Shared devices (Phase 03.2 Plan 05, D-05, D-06, ADR-0012 §2, WZC-05): the owner shares a device with chosen
 * members or units, each capped at a mode; listed people start sessions without the owner accepting each one;
 * taking access away stops or downgrades exactly the affected sessions; every change is audited and tenant-scoped.
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };
const DEVICE_NAME = "Build server";

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let dana: TestClient;
let adminId: string;
let samId: string;
let danaId: string;
let orgId: string;
let mac: FakeDevice;
let macId: string;
let macProject: string;
/** Sam's session on the device (Task 1), stopped by the removal (Task 2). */
let samSession: string;
/** The Engineering department (Task 2), granted the device. */
let engId: string;

type DeviceDto = {
  id: string;
  viewerMaxMode?: string | null;
  grants?: Array<Record<string, unknown>>;
  shareMaxMode: string;
};

const FULL: RuntimeCatalog[] = [CLAUDE_CATALOG, CODEX_CATALOG];

const grantUrl = (deviceId: string, kind: "user" | "unit", principalId: string) =>
  `/api/v1/devices/${deviceId}/grants/${kind}/${principalId}`;

async function devicesOf(as: TestClient): Promise<DeviceDto[]> {
  const res = await as.request("GET", "/api/v1/devices");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body!.devices as DeviceDto[];
}

async function projectNames(as: TestClient): Promise<string[]> {
  const res = await as.request("GET", "/api/v1/projects");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body!.projects as Array<{ name: string }>).map((p) => p.name);
}

async function audits(action: string, deviceId: string) {
  const rows = await su.query(
    "select user_id, device_id, resource_id, metadata from app.audit_events where action = $1 and device_id = $2 order by occurred_at",
    [action, deviceId],
  );
  return rows.rows as Array<{
    user_id: string | null;
    device_id: string;
    resource_id: string;
    metadata: Record<string, unknown>;
  }>;
}

type Cmd = Frame & { id: string; payload: Record<string, unknown>; sessionId: string };

/** The highest mode the inventory exposes under acceptEdits' neighbour (Auto only once Plans 02/03 confirm it). */
const TOP = isExposed("claude-code", "mode.auto") ? "auto" : "acceptEdits";

async function prompt(as: TestClient, sessionId: string, body: string): Promise<string> {
  const res = await as.request("POST", `/api/v1/work-sessions/${sessionId}/prompts`, { body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body!.id as string;
}

/** Ack a dispatched prompt and complete its turn on the device. */
function finish(device: FakeDevice, cmd: Cmd) {
  device.ack(cmd.id);
  const promptId = cmd.payload.promptId as string;
  device.event(cmd.sessionId, { type: "prompt.started", promptId });
  device.event(cmd.sessionId, {
    type: "prompt.completed",
    promptId,
    usage: { inputTokens: 1, outputTokens: 1 },
  });
}

async function sessionRow(id: string) {
  return (
    await su.query("select status, permission_mode, last_error from app.work_sessions where id = $1", [id])
  ).rows[0] as { status: string; permission_mode: string; last_error: string | null };
}

const idle = (id: string) => eventually(async () => (await sessionRow(id)).status === "idle");

async function auditFor(action: string, sessionId: string) {
  return (
    await su.query(
      "select metadata from app.audit_events where action = $1 and session_id = $2 order by occurred_at",
      [action, sessionId],
    )
  ).rows as Array<{ metadata: Record<string, unknown> }>;
}

async function optIn(device: FakeDevice, deviceId: string, on: boolean) {
  device.capabilities(FULL, on);
  await eventually(async () => {
    const r = await su.query("select full_access_opt_in, runtime_catalog from app.devices where id = $1", [
      deviceId,
    ]);
    return r.rows[0].full_access_opt_in === on && (r.rows[0].runtime_catalog as unknown[]).length === 2;
  });
}

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await admin.request("POST", "/api/v1/setup", {
    token: TEST_SETUP_TOKEN,
    ...ADMIN,
    orgName: "Autofy Labs",
  });
  expect(setup.status).toBe(200);
  orgId = (setup.body!.organization as { id: string }).id;
  adminId = (setup.body!.user as { id: string }).id;
  ({ client: sam, userId: samId } = await invite(stack, admin, "sam@example.test", "Sam", "developer"));
  ({ client: dana, userId: danaId } = await invite(stack, admin, "dana@example.test", "Dana", "developer"));
  const paired = await pairDevice(stack, admin, DEVICE_NAME);
  macId = paired.deviceId;
  ({ device: mac, projectId: macProject } = await connectWithProject(stack, admin, paired.token, {
    localId: "lp_srv",
    name: "ocw",
  }));
  await optIn(mac, macId, false);
}, 180_000);

afterAll(async () => {
  await mac?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

describe("sharing with a person (Task 1)", () => {
  it("the owner shares with Sam at acceptEdits; Sam sees and uses the device without any acceptance", async () => {
    expect(await projectNames(sam)).toEqual([]);
    const put = await admin.request("PUT", grantUrl(macId, "user", samId), { maxMode: "acceptEdits" });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({
      principalKind: "user",
      principalId: samId,
      principalName: "Sam",
      maxMode: "acceptEdits",
    });
    const [added] = await audits("device.grant_added", macId);
    expect(added).toMatchObject({ user_id: adminId, resource_id: macId });
    expect(added!.metadata).toMatchObject({
      principalKind: "user",
      principalId: samId,
      maxMode: "acceptEdits",
    });

    // Sam now sees the device's projects and their own cap, never the list of grants.
    expect(await projectNames(sam)).toEqual(["ocw"]);
    const asSam = (await devicesOf(sam)).find((d) => d.id === macId)!;
    expect(asSam.viewerMaxMode).toBe("acceptEdits");
    expect(asSam.grants).toBeUndefined();
    // The owner sees the grants on the device card and through the grants route.
    const asOwner = (await devicesOf(admin)).find((d) => d.id === macId)!;
    expect(asOwner.viewerMaxMode).toBe("fullAccess");
    expect(asOwner.grants).toEqual([
      expect.objectContaining({ principalKind: "user", principalId: samId, principalName: "Sam" }),
    ]);
    const list = await admin.request("GET", `/api/v1/devices/${macId}/grants`);
    expect(list.status).toBe(200);
    expect(list.body!.grants).toEqual([
      expect.objectContaining({ principalId: samId, maxMode: "acceptEdits" }),
    ]);

    // Above the cap is refused with the device_grant reason; within it the session starts straight away.
    const auto = await sam.request("POST", "/api/v1/work-sessions", {
      projectId: macProject,
      permissionMode: "auto",
    });
    expect([auto.status, errorCode(auto)]).toEqual([403, "device_grant"]);
    const id = await startSession(sam, mac, macProject, { title: "Sam's", permissionMode: "acceptEdits" });
    samSession = id;
    const row = await su.query("select created_by, status from app.work_sessions where id = $1", [id]);
    expect(row.rows[0]).toEqual({ created_by: samId, status: "idle" });
  });

  it("a member who is neither the owner nor listed still gets device_not_shared", async () => {
    const res = await dana.request("POST", "/api/v1/work-sessions", { projectId: macProject });
    expect([res.status, errorCode(res)]).toEqual([403, "device_not_shared"]);
    expect((await devicesOf(dana)).find((d) => d.id === macId)!.viewerMaxMode).toBeNull();
  });

  it("only the owner changes grants; a grantee cannot list or edit them", async () => {
    const put = await sam.request("PUT", grantUrl(macId, "user", danaId), { maxMode: "plan" });
    expect(put.status).toBe(403);
    expect((put.body!.error as { details: unknown }).details).toMatchObject({ permission: "device.update" });
    expect((await sam.request("DELETE", grantUrl(macId, "user", samId))).status).toBe(403);
    expect((await sam.request("GET", `/api/v1/devices/${macId}/grants`)).status).toBe(403);
    expect((await dana.request("GET", `/api/v1/devices/${macId}/grants`)).status).toBe(403);
  });
});

describe("units, caps, Full access and revocation (Task 2, ADR-0012 §2)", () => {
  let rex: TestClient;
  let lia: TestClient;
  let rexId: string;
  let liaId: string;
  let ownerSession: string;

  const unit = async (kind: string, name: string, parentId: string | null) => {
    const res = await admin.request("POST", "/api/v1/units", { kind, name, parentId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body!.id as string;
  };
  const join = async (unitId: string, userId: string) => {
    const res = await admin.request("POST", `/api/v1/units/${unitId}/members`, { userId, role: "member" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  };

  beforeAll(async () => {
    ({ client: rex, userId: rexId } = await invite(stack, admin, "rex@example.test", "Rex", "developer"));
    ({ client: lia, userId: liaId } = await invite(stack, admin, "lia@example.test", "Lia", "developer"));
    engId = await unit("department", "Engineering", null);
    const backend = await unit("team", "Backend", engId);
    const sales = await unit("department", "Sales", null);
    await join(backend, rexId);
    await join(sales, liaId);
    ownerSession = await startSession(admin, mac, macProject, {
      title: "Owner's",
      permissionMode: "acceptEdits",
    });
  });

  it("a department grant lets a member of a team under it start a session; a sibling department does not", async () => {
    const put = await admin.request("PUT", grantUrl(macId, "unit", engId), { maxMode: "auto" });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({ principalKind: "unit", principalName: "Engineering", maxMode: "auto" });
    expect((await devicesOf(rex)).find((d) => d.id === macId)!.viewerMaxMode).toBe("auto");
    await startSession(rex, mac, macProject, { title: "Rex's" });
    const res = await lia.request("POST", "/api/v1/work-sessions", { projectId: macProject });
    expect([res.status, errorCode(res)]).toEqual([403, "device_not_shared"]);
    expect((await devicesOf(lia)).find((d) => d.id === macId)!.viewerMaxMode).toBeNull();
  });

  it("Full access (a grant or the everyone cap) needs the device's own opt-in", async () => {
    const full = await admin.request("PUT", grantUrl(macId, "user", liaId), { maxMode: "fullAccess" });
    expect([full.status, errorCode(full)]).toEqual([409, "device_opt_in"]);
    expect((full.body!.error as { message: string }).message).toMatch(/ocw-runtime full-access on/);
    const share = await admin.request("PATCH", `/api/v1/devices/${macId}`, { shareMaxMode: "fullAccess" });
    expect([share.status, errorCode(share)]).toEqual([409, "device_opt_in"]);
    const none = await su.query("select count(*)::int as n from app.device_grants where principal_id = $1", [
      liaId,
    ]);
    expect(none.rows[0].n).toBe(0);

    await optIn(mac, macId, true);
    expect(
      (await admin.request("PUT", grantUrl(macId, "user", liaId), { maxMode: "fullAccess" })).status,
    ).toBe(200);
    expect(
      (await admin.request("PATCH", `/api/v1/devices/${macId}`, { shareMaxMode: "fullAccess" })).status,
    ).toBe(200);
    const dev = await su.query("select share_max_mode from app.devices where id = $1", [macId]);
    expect(dev.rows[0].share_max_mode).toBe("fullAccess");
    const updated = await su.query(
      "select metadata from app.audit_events where action = 'device.updated' and device_id = $1 order by occurred_at desc limit 1",
      [macId],
    );
    expect(updated.rows[0].metadata).toMatchObject({
      shareMaxMode: "fullAccess",
      previousShareMaxMode: "acceptEdits",
    });
    // Back to the defaults for the next cases.
    expect(
      (await admin.request("PATCH", `/api/v1/devices/${macId}`, { shareMaxMode: "acceptEdits" })).status,
    ).toBe(200);
    expect((await admin.request("DELETE", grantUrl(macId, "user", liaId))).status).toBe(200);
    await optIn(mac, macId, false);
  });

  it("removing Sam stops Sam's running session, keeps the owner's, and refuses Sam's turns until re-granted", async () => {
    const work = await prompt(sam, samSession, "long task");
    const turn = (await mac.command("prompt", samSession)) as Cmd;
    expect(turn.payload).toMatchObject({ promptId: work, permissionMode: "acceptEdits" });
    mac.ack(turn.id);
    mac.event(samSession, { type: "prompt.started", promptId: work });
    await eventually(async () => (await sessionRow(samSession)).status === "running");

    const del = await admin.request("DELETE", grantUrl(macId, "user", samId));
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    const removed = (await audits("device.grant_removed", macId)).at(-1);
    expect(removed).toMatchObject({ user_id: adminId, resource_id: macId });
    expect(removed!.metadata).toMatchObject({
      principalKind: "user",
      principalId: samId,
      maxMode: "acceptEdits",
    });
    const kept = await su.query(
      "select revoked_at, revoked_by from app.device_grants where device_id = $1 and principal_id = $2",
      [macId, samId],
    );
    expect(kept.rows[0].revoked_at).not.toBeNull();
    expect(kept.rows[0].revoked_by).toBe(adminId);
    const list = await admin.request("GET", `/api/v1/devices/${macId}/grants`);
    expect((list.body!.grants as Array<{ principalId: string }>).map((g) => g.principalId)).toEqual([engId]);
    expect((await admin.request("DELETE", grantUrl(macId, "user", samId))).status).toBe(404);

    const stop = (await mac.command("session.stop", samSession)) as Cmd;
    mac.ack(stop.id);
    // A real daemon then reports the stopped session as ended: the server's failure (and its reason) stands.
    mac.event(samSession, { type: "session.state", status: "completed" });
    await sleep(300);
    expect(await sessionRow(samSession)).toMatchObject({
      status: "failed",
      last_error: `Access to ${DEVICE_NAME} was revoked`,
    });
    await sleep(200);
    expect((await sessionRow(ownerSession)).status).toBe("idle");
    expect(mac.pending("session.stop").filter((f) => f.sessionId === ownerSession)).toHaveLength(0);

    // Sam's prompt in the owner's session is refused, never run at the controller floor.
    const refused = await prompt(sam, ownerSession, "sam after removal");
    const p = await eventually(async () => {
      const r = await su.query("select status, permission_mode from app.work_prompts where id = $1", [
        refused,
      ]);
      return r.rows[0].status === "failed" ? r.rows[0] : undefined;
    });
    expect(p).toEqual({ status: "failed", permission_mode: null });
    const audit = await su.query(
      "select metadata from app.audit_events where action = 'work_prompt.refused' and metadata->>'promptId' = $1",
      [refused],
    );
    expect(audit.rows[0].metadata).toMatchObject({ authorUserId: samId, reason: "access_revoked" });
    expect(mac.pending("prompt").filter((f) => f.sessionId === ownerSession)).toHaveLength(0);

    // Re-granting is an add: the revocation is cleared and Sam's turns run at the new cap.
    const again = await admin.request("PUT", grantUrl(macId, "user", samId), { maxMode: "acceptEdits" });
    expect(again.status).toBe(200);
    expect((await audits("device.grant_added", macId)).at(-1)!.metadata).toMatchObject({
      principalId: samId,
    });
    const cleared = await su.query(
      "select revoked_at, revoked_by from app.device_grants where device_id = $1 and principal_id = $2",
      [macId, samId],
    );
    expect(cleared.rows[0]).toEqual({ revoked_at: null, revoked_by: null });
    const ok = await prompt(sam, ownerSession, "sam again");
    const cmd = (await mac.command("prompt", ownerSession)) as Cmd;
    expect(cmd.payload).toMatchObject({ promptId: ok, permissionMode: "acceptEdits" });
    finish(mac, cmd);
    await idle(ownerSession);
  });

  it("a grant below the floor lowers it: an unlisted member never gets more than a listed one", async () => {
    expect((await admin.request("PUT", grantUrl(macId, "user", samId), { maxMode: "default" })).status).toBe(
      200,
    );
    const id = await prompt(dana, ownerSession, "dana");
    const cmd = (await mac.command("prompt", ownerSession)) as Cmd;
    expect(cmd.payload).toMatchObject({ promptId: id, permissionMode: "default" });
    finish(mac, cmd);
    await idle(ownerSession);
  });

  it("lowering Sam's grant downgrades Sam's live session (session.configure) and audits it", async () => {
    expect((await admin.request("PUT", grantUrl(macId, "user", samId), { maxMode: TOP })).status).toBe(200);
    const s = await startSession(sam, mac, macProject, { title: "Sam's second", permissionMode: TOP });
    const put = await admin.request("PUT", grantUrl(macId, "user", samId), { maxMode: "default" });
    expect(put.status).toBe(200);
    expect((await audits("device.grant_updated", macId)).at(-1)!.metadata).toMatchObject({
      principalId: samId,
      maxMode: "default",
      previousMaxMode: TOP,
    });
    const cfg = (await mac.command("session.configure", s)) as Cmd;
    expect(cfg.payload).toEqual({ settings: { permissionMode: "default" }, reason: "access_changed" });
    mac.ack(cfg.id);
    expect((await sessionRow(s)).permission_mode).toBe("default");
    const [down] = await auditFor("work_session.settings_downgraded", s);
    expect(down!.metadata).toMatchObject({
      reason: "access_changed",
      from: { permissionMode: TOP },
      to: { permissionMode: "default" },
    });
    // Raising never touches live sessions.
    expect(
      (await admin.request("PUT", grantUrl(macId, "user", samId), { maxMode: "acceptEdits" })).status,
    ).toBe(200);
    await sleep(200);
    expect(mac.pending("session.configure").filter((f) => f.sessionId === s)).toHaveLength(0);
  });

  it("un-sharing with everyone stops only the sessions that relied on the everyone share", async () => {
    expect((await admin.request("PATCH", `/api/v1/devices/${macId}`, { shared: true })).status).toBe(200);
    const danaSession = await startSession(dana, mac, macProject, { title: "Dana's" });
    const samLive = await su.query(
      "select id from app.work_sessions where created_by = $1 and status = 'idle' order by created_at desc limit 1",
      [samId],
    );
    const samSecond = samLive.rows[0].id as string;
    expect((await admin.request("PATCH", `/api/v1/devices/${macId}`, { shared: false })).status).toBe(200);
    const stop = (await mac.command("session.stop", danaSession)) as Cmd;
    mac.ack(stop.id);
    expect(await sessionRow(danaSession)).toMatchObject({ status: "failed" });
    await sleep(200);
    expect((await sessionRow(samSecond)).status).toBe("idle");
    expect((await sessionRow(ownerSession)).status).toBe("idle");
    expect(mac.pending("session.stop").filter((f) => f.sessionId !== danaSession)).toHaveLength(0);
  });
});

describe("tenant isolation", () => {
  it("another organization's admin never sees or edits this org's grants, nor grants to this org's members", async () => {
    const { client: eve, userId: eveId } = await invite(stack, admin, "eve@example.test", "Eve", "developer");
    const orgB = randomUUID();
    const devB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
      orgB,
      `o-${orgB}`,
    ]);
    await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
      orgB,
      eveId,
    ]);
    await su.query(
      "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
      [orgB, eveId],
    );
    await su.query(
      "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash, status, runtime_info) values ($1, $2, $3, 'B box', 'linux', $4, 'online', '[]')",
      [devB, orgB, eveId, randomUUID()],
    );
    // Eve now acts in organization B (her active organization), where she is an admin and owns devB.
    await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, eveId]);
    const me = await eve.request("GET", "/api/v1/me");
    expect((me.body!.organization as { id: string }).id).toBe(orgB);
    expect(orgB).not.toBe(orgId);

    expect((await eve.request("GET", `/api/v1/devices/${macId}/grants`)).status).toBe(404);
    expect((await eve.request("PUT", grantUrl(macId, "user", eveId), { maxMode: "plan" })).status).toBe(404);
    expect((await eve.request("DELETE", grantUrl(macId, "unit", engId), {})).status).toBe(404);
    expect((await devicesOf(eve)).map((d) => d.id)).toEqual([devB]);
    // Not vacuous: Eve owns devB and may grant inside org B, but never to org A's members or units.
    const own = await eve.request("GET", `/api/v1/devices/${devB}/grants`);
    expect([own.status, own.body]).toEqual([200, { grants: [] }]);
    const toSam = await eve.request("PUT", grantUrl(devB, "user", samId), { maxMode: "plan" });
    expect([toSam.status, errorCode(toSam)]).toEqual([400, "unknown_principal"]);
    const toUnit = await eve.request("PUT", grantUrl(devB, "unit", engId), { maxMode: "plan" });
    expect([toUnit.status, errorCode(toUnit)]).toEqual([400, "unknown_principal"]);
    const leaked = await su.query("select count(*)::int as n from app.device_grants where device_id = $1", [
      devB,
    ]);
    expect(leaked.rows[0].n).toBe(0);
    // Org A's grants are untouched.
    const a = await su.query(
      "select count(*)::int as n from app.device_grants where device_id = $1 and revoked_at is null",
      [macId],
    );
    expect(a.rows[0].n).toBeGreaterThan(0);
  });
});

describe("authorization coverage", () => {
  it("every grant answer went through the resolver", () => {
    const undecided = stack.built.authz.undecided.filter((u) => /^\/api\/v1\/devices/.test(u.url));
    expect(undecided).toEqual([]);
  });
});
