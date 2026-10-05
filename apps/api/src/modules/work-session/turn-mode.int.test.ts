import { createHash, randomUUID } from "node:crypto";
import { isExposed, type RuntimeCatalog } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice, type Frame, sleep } from "../../testing-device";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  connectWithProject,
  invite,
  pairDevice,
  startSession,
} from "../../testing-workzone";
import { loadDeviceAccess } from "../device";
import type { WorkSessionService } from "./service";

/**
 * Every turn is re-checked and audited (Phase 03.2 Plan 04 Task 3, D-02, D-03, D-04, P-07; ADR-0012): the mode of
 * each dispatched turn is min(session mode, the author's cap), grantees below the floor and revoked principals,
 * downgrades when the policy, the device opt-in or a member's access tightens, the server-side fail-closed check of
 * an unauthorized Full access report, and the cross-tenant cases.
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };
const DEVICE_NAME = "Víctor's MacBook";

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
let server: FakeDevice;
let serverId: string;
let serverProject: string;
let s1: string; // owner, Full access, on the Mac
let s2: string; // owner, acceptEdits, on the Mac
let s3: string; // owner, Full access, on the server

type Cmd = Frame & { id: string; payload: Record<string, unknown>; sessionId: string };

/** The owner's highest mode under the default listed modes (Auto only once the inventory confirms it). */
const OWNER_TOP = isExposed("claude-code", "mode.auto") ? "auto" : "acceptEdits";

const svc = () => stack.built.deviceHub.sessionHandler as unknown as WorkSessionService;

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
    await su.query(
      "select status, permission_mode, last_error, settings_pending, effective_settings from app.work_sessions where id = $1",
      [id],
    )
  ).rows[0] as {
    status: string;
    permission_mode: string;
    last_error: string | null;
    settings_pending: boolean;
    effective_settings: Record<string, unknown> | null;
  };
}

const idle = (id: string) => eventually(async () => (await sessionRow(id)).status === "idle");

async function auditOf(action: string, where: { promptId?: string; sessionId?: string }) {
  const rows = await su.query(
    `select result, metadata, user_id, device_id, session_id from app.audit_events where action = $1
       and ($2::text is null or metadata->>'promptId' = $2) and ($3::text is null or session_id = $3)
     order by occurred_at`,
    [action, where.promptId ?? null, where.sessionId ?? null],
  );
  return rows.rows as Array<{
    result: string;
    metadata: Record<string, unknown>;
    user_id: string | null;
    device_id: string | null;
    session_id: string | null;
  }>;
}

const grant = (principalId: string, maxMode: string, revoked = false) =>
  su.query(
    `insert into app.device_grants (organization_id, device_id, principal_kind, principal_id, max_mode, revoked_at)
     values ($1, $2, 'user', $3, $4, ${revoked ? "now()" : "null"})
     on conflict (device_id, principal_kind, principal_id)
     do update set max_mode = excluded.max_mode, revoked_at = excluded.revoked_at`,
    [orgId, macId, principalId, maxMode],
  );

const FULL: RuntimeCatalog[] = [
  CLAUDE_CATALOG,
  { ...CODEX_CATALOG, permissionModes: ["default", "acceptEdits", "plan", "fullAccess"] },
];

async function optIn(device: FakeDevice, deviceId: string, on: boolean) {
  device.capabilities(FULL, on);
  await eventually(async () => {
    const r = await su.query("select full_access_opt_in, runtime_catalog from app.devices where id = $1", [
      deviceId,
    ]);
    return r.rows[0].full_access_opt_in === on && (r.rows[0].runtime_catalog as unknown[]).length === 2;
  });
}

async function putPolicy(body: Record<string, unknown>) {
  const res = await admin.request("PUT", "/api/v1/work-zone-policy", body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
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

  const pairedMac = await pairDevice(stack, admin, DEVICE_NAME);
  macId = pairedMac.deviceId;
  ({ device: mac, projectId: macProject } = await connectWithProject(stack, admin, pairedMac.token, {
    localId: "lp_mac",
    name: "ocw",
  }));
  const pairedServer = await pairDevice(stack, admin, "Build server");
  serverId = pairedServer.deviceId;
  ({ device: server, projectId: serverProject } = await connectWithProject(stack, admin, pairedServer.token, {
    localId: "lp_srv",
    name: "infra",
  }));
  await optIn(mac, macId, true);
  await optIn(server, serverId, true);
  await putPolicy({ allowFullAccess: true });
  s1 = await startSession(admin, mac, macProject, { title: "S1", permissionMode: "fullAccess" });
  s2 = await startSession(admin, mac, macProject, { title: "S2", permissionMode: "acceptEdits" });
}, 180_000);

afterAll(async () => {
  await mac?.close().catch(() => {});
  await server?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

describe("per-turn mode (P-07)", () => {
  it("the owner's turn in a Full access session runs in Full access, recorded and audited", async () => {
    const id = await prompt(admin, s1, "one");
    const cmd = (await mac.command("prompt", s1)) as Cmd;
    expect(cmd.payload).toMatchObject({ promptId: id, permissionMode: "fullAccess" });
    const row = await su.query("select permission_mode from app.work_prompts where id = $1", [id]);
    expect(row.rows[0].permission_mode).toBe("fullAccess");
    const [audit] = await auditOf("work_prompt.dispatched", { promptId: id });
    expect(audit).toMatchObject({ result: "success", device_id: macId, session_id: s1 });
    expect(audit!.metadata).toMatchObject({
      promptId: id,
      authorUserId: adminId,
      requestedMode: "fullAccess",
      effectiveMode: "fullAccess",
      capped: false,
      fullAccess: true,
    });
    finish(mac, cmd);
    await idle(s1);
  });

  it("a grantee capped at acceptEdits runs at acceptEdits in the same session (capped)", async () => {
    await grant(samId, "acceptEdits");
    const id = await prompt(sam, s1, "two");
    const cmd = (await mac.command("prompt", s1)) as Cmd;
    expect(cmd.payload).toMatchObject({ promptId: id, permissionMode: "acceptEdits" });
    const [audit] = await auditOf("work_prompt.dispatched", { promptId: id });
    expect(audit!.metadata).toMatchObject({
      authorUserId: samId,
      requestedMode: "fullAccess",
      effectiveMode: "acceptEdits",
      capped: true,
    });
    finish(mac, cmd);
    await idle(s1);
  });

  it("a controller with no relation to the device runs at the floor, never Full access", async () => {
    const id = await prompt(dana, s1, "three");
    const cmd = (await mac.command("prompt", s1)) as Cmd;
    expect(cmd.payload).toMatchObject({ promptId: id, permissionMode: "acceptEdits" });
    expect((await auditOf("work_prompt.dispatched", { promptId: id }))[0]!.metadata).toMatchObject({
      authorUserId: danaId,
      capped: true,
    });
    finish(mac, cmd);
    await idle(s1);
  });

  it("(a) a grantee below the floor lowers it: the unlisted member never gets more than the grantee", async () => {
    await grant(samId, "default");
    const samPrompt = await prompt(sam, s2, "sam");
    let cmd = (await mac.command("prompt", s2)) as Cmd;
    expect(cmd.payload).toMatchObject({ promptId: samPrompt, permissionMode: "default" });
    finish(mac, cmd);
    await idle(s2);
    const danaPrompt = await prompt(dana, s2, "dana");
    cmd = (await mac.command("prompt", s2)) as Cmd;
    expect(cmd.payload).toMatchObject({ promptId: danaPrompt, permissionMode: "default" });
    finish(mac, cmd);
    await idle(s2);
    // The owner lowers the everyone-share cap: the floor follows.
    await su.query("update app.devices set share_max_mode = 'plan' where id = $1", [macId]);
    const low = await prompt(dana, s2, "dana again");
    cmd = (await mac.command("prompt", s2)) as Cmd;
    expect(cmd.payload).toMatchObject({ promptId: low, permissionMode: "plan" });
    finish(mac, cmd);
    await idle(s2);
    await su.query("update app.devices set share_max_mode = 'acceptEdits' where id = $1", [macId]);
  });

  it("(b) a revoked grantee's turn is refused (never the floor) and the next queued prompt still runs", async () => {
    const first = await prompt(admin, s2, "owner first");
    const running = (await mac.command("prompt", s2)) as Cmd;
    expect(running.payload.promptId).toBe(first);
    const refused = await prompt(sam, s2, "sam queued");
    const next = await prompt(admin, s2, "owner next");
    await grant(samId, "default", true); // revoked_at set
    finish(mac, running);
    const cmd = (await mac.command("prompt", s2)) as Cmd;
    expect(cmd.payload).toMatchObject({ promptId: next, permissionMode: "acceptEdits" });
    const p = await su.query("select status, permission_mode from app.work_prompts where id = $1", [refused]);
    expect(p.rows[0]).toEqual({ status: "failed", permission_mode: null });
    const [audit] = await auditOf("work_prompt.refused", { promptId: refused });
    expect(audit).toMatchObject({ result: "denied", session_id: s2 });
    expect(audit!.metadata).toMatchObject({
      promptId: refused,
      authorUserId: samId,
      reason: "access_revoked",
    });
    finish(mac, cmd);
    await idle(s2);
  });

  it("a policy whose only allowed mode is above the author's cap refuses that author's turn", async () => {
    await grant(samId, "default"); // current again
    await putPolicy({ allowedPermissionModes: ["acceptEdits"] });
    const first = await prompt(admin, s2, "owner");
    const running = (await mac.command("prompt", s2)) as Cmd;
    expect(running.payload).toMatchObject({ promptId: first, permissionMode: "acceptEdits" });
    const refused = await prompt(sam, s2, "sam");
    const next = await prompt(admin, s2, "owner again");
    finish(mac, running);
    const cmd = (await mac.command("prompt", s2)) as Cmd;
    expect(cmd.payload.promptId).toBe(next);
    expect((await auditOf("work_prompt.refused", { promptId: refused }))[0]).toMatchObject({
      result: "denied",
      metadata: expect.objectContaining({ reason: "mode_not_allowed" }),
    });
    finish(mac, cmd);
    await idle(s2);
    await putPolicy({ allowedPermissionModes: ["plan", "default", "acceptEdits", "auto"] });
  });
});

describe("downgrades (ADR-0012)", () => {
  it("turning Full access off in the policy downgrades every Full access session of the org", async () => {
    s3 = await startSession(admin, server, serverProject, { title: "S3", permissionMode: "fullAccess" });
    await putPolicy({ allowFullAccess: false });
    for (const [device, id] of [
      [mac, s1],
      [server, s3],
    ] as const) {
      const cmd = (await device.command("session.configure", id)) as Cmd;
      expect(cmd.payload).toEqual({ settings: { permissionMode: OWNER_TOP }, reason: "policy" });
      device.ack(cmd.id);
      const row = await sessionRow(id);
      expect(row).toMatchObject({ permission_mode: OWNER_TOP, settings_pending: true });
      const [down] = await auditOf("work_session.settings_downgraded", { sessionId: id });
      expect(down!.metadata).toMatchObject({
        reason: "policy",
        changed: ["permissionMode"],
        from: { permissionMode: "fullAccess" },
        to: { permissionMode: OWNER_TOP },
      });
      expect(await auditOf("work_session.full_access_left", { sessionId: id })).toHaveLength(1);
      const emitted = await su.query(
        "select payload from app.stream_events where stream_id = $1 and type = 'work_session.updated' order by seq desc limit 1",
        [`ws:${id}`],
      );
      // The badge stays until the device reports the lower mode (the effective value still says Full access).
      expect(emitted.rows[0].payload).toMatchObject({
        permissionMode: OWNER_TOP,
        settings: { pending: true, requested: { permissionMode: OWNER_TOP } },
      });
    }
    // s2 (acceptEdits) was within the new policy: untouched.
    await sleep(200);
    expect(mac.pending("session.configure").filter((f) => f.sessionId === s2)).toHaveLength(0);
    await putPolicy({ allowFullAccess: true });
    for (const [device, id] of [
      [mac, s1],
      [server, s3],
    ] as const) {
      const res = await admin.request("PATCH", `/api/v1/work-sessions/${id}/settings`, {
        permissionMode: "fullAccess",
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      device.ack(((await device.command("session.configure", id)) as Cmd).id);
    }
  });

  it("a device that turns its opt-in off downgrades its own sessions only and interrupts a Full access turn", async () => {
    const id = await prompt(admin, s1, "long full access task");
    const turn = (await mac.command("prompt", s1)) as Cmd;
    expect(turn.payload).toMatchObject({ promptId: id, permissionMode: "fullAccess" });
    mac.ack(turn.id);
    mac.event(s1, { type: "prompt.started", promptId: id });
    await eventually(async () => (await sessionRow(s1)).status === "running");
    await optIn(mac, macId, false);
    const cmd = (await mac.command("session.configure", s1)) as Cmd;
    expect(cmd.payload).toEqual({ settings: { permissionMode: OWNER_TOP }, reason: "device_opt_out" });
    mac.ack(cmd.id);
    // The Full access turn in flight does not keep running at a mode nobody may use any more.
    const interrupt = (await mac.command("interrupt", s1)) as Cmd;
    mac.ack(interrupt.id);
    mac.event(s1, {
      type: "prompt.completed",
      promptId: id,
      interrupted: true,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await idle(s1);
    const downs = await auditOf("work_session.settings_downgraded", { sessionId: s1 });
    expect(downs.at(-1)!.metadata).toMatchObject({ reason: "device_opt_out" });
    expect((await sessionRow(s1)).permission_mode).toBe(OWNER_TOP);
    await sleep(200);
    expect((await sessionRow(s3)).permission_mode).toBe("fullAccess");
    expect(server.pending("session.configure")).toHaveLength(0);
    await optIn(mac, macId, true);
  });

  it("a member whose access to the device ends has their sessions stopped; the owner's keep running", async () => {
    await grant(samId, "acceptEdits");
    const s4 = await startSession(sam, mac, macProject, { title: "Sam's", permissionMode: "default" });
    await su.query("delete from app.device_grants where device_id = $1 and principal_id = $2", [
      macId,
      samId,
    ]);
    await stack.built.deviceHub.sessionHandler!.onAccessChanged(
      { deviceId: macId, organizationId: orgId },
      "access_changed",
    );
    const stop = (await mac.command("session.stop", s4)) as Cmd;
    mac.ack(stop.id);
    expect(await sessionRow(s4)).toMatchObject({
      status: "failed",
      last_error: `Access to ${DEVICE_NAME} was revoked`,
    });
    const [audit] = await auditOf("work_session.access_revoked", { sessionId: s4 });
    expect(audit).toMatchObject({ device_id: macId });
    expect(audit!.metadata).toMatchObject({ reason: "access_changed", createdBy: samId });
    expect((await sessionRow(s2)).status).toBe("idle");
    expect(mac.pending("session.stop").filter((f) => f.sessionId === s2)).toHaveLength(0);
  });
});

describe("server-side fail-closed (D-03)", () => {
  it("an unauthorized Full access report stops the session and is audited", async () => {
    mac.event(s2, { type: "session.settings", permissionMode: "bypassPermissions" });
    const interrupt = (await mac.command("interrupt", s2)) as Cmd;
    const stop = (await mac.command("session.stop", s2)) as Cmd;
    mac.ack(interrupt.id);
    mac.ack(stop.id);
    const row = await eventually(async () => {
      const r = await sessionRow(s2);
      return r.status === "failed" ? r : undefined;
    });
    expect(row.last_error).toBe(
      "The device reported Full access without authorization; the session was stopped",
    );
    expect((row.effective_settings as { permissionMode?: string } | null)?.permissionMode).not.toBe(
      "bypassPermissions",
    );
    const [audit] = await auditOf("work_session.unauthorized_mode", { sessionId: s2 });
    expect(audit).toMatchObject({ result: "denied", device_id: macId });
    expect(audit!.metadata).toMatchObject({ reported: "bypassPermissions", authorizedMode: "acceptEdits" });
  });

  it("the same report during an authorized Full access turn is stored as effective", async () => {
    const id = await prompt(admin, s3, "full");
    const cmd = (await server.command("prompt", s3)) as Cmd;
    expect(cmd.payload).toMatchObject({ promptId: id, permissionMode: "fullAccess" });
    server.ack(cmd.id);
    server.event(s3, { type: "prompt.started", promptId: id });
    server.event(s3, { type: "session.settings", permissionMode: "bypassPermissions" });
    const row = await eventually(async () => {
      const r = await sessionRow(s3);
      return (r.effective_settings as { permissionMode?: string } | null)?.permissionMode ===
        "bypassPermissions"
        ? r
        : undefined;
    });
    expect(row.status).toBe("running");
    expect(await auditOf("work_session.unauthorized_mode", { sessionId: s3 })).toHaveLength(0);
    server.event(s3, { type: "prompt.completed", promptId: id, usage: { inputTokens: 1, outputTokens: 1 } });
    await idle(s3);
  });
});

describe("server-side fail-closed at start (D-03)", () => {
  it("a session.started that reports a bypass mode for a session not in Full access stops it", async () => {
    const res = await admin.request("POST", "/api/v1/work-sessions", {
      projectId: macProject,
      title: "S5",
      permissionMode: "default",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const s5 = res.body!.id as string;
    mac.ack(((await mac.command("session.start", s5)) as Cmd).id);
    mac.event(s5, { type: "session.started", runtime: "claude-code", permissionMode: "bypassPermissions" });
    mac.ack(((await mac.command("session.stop", s5)) as Cmd).id);
    const row = await eventually(async () => {
      const r = await sessionRow(s5);
      return r.status === "failed" ? r : undefined;
    });
    expect(row.last_error).toMatch(/without authorization/);
    expect(await auditOf("work_session.unauthorized_mode", { sessionId: s5 })).toHaveLength(1);
  });
});

describe("tenant isolation", () => {
  it("another organization's policy change and device opt-out never touch this org's sessions", async () => {
    const orgB = randomUUID();
    const userB = randomUUID();
    const devB = randomUUID();
    const tokenB = `ocwd_${randomUUID()}`;
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
      orgB,
      `o-${orgB}`,
    ]);
    await su.query("insert into auth.user (id, name, email) values ($1, 'Eve', $2)", [
      userB,
      `${userB}@b.test`,
    ]);
    await su.query(
      "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
      [orgB, userB],
    );
    await su.query(
      "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash, status, runtime_info, full_access_opt_in) values ($1, $2, $3, 'B mac', 'darwin', $4, 'online', '[]', true)",
      [devB, orgB, userB, createHash("sha256").update(tokenB).digest("hex")],
    );
    await su.query(
      "insert into app.work_zone_policies (organization_id, allowed_permission_modes, allow_full_access) values ($1, '{plan}', false)",
      [orgB],
    );
    const before = await sessionRow(s3);
    expect(before.permission_mode).toBe("fullAccess");

    // Org B's policy reauthorization runs in org B's tenant: org A's Full access session is invisible to it.
    await stack.built.core.db.withTenant({ organizationId: orgB, userId: userB }, (tx) =>
      svc().reauthorizeOrg(tx, "policy"),
    );
    // Org B's device opts out: only its own sessions could be downgraded.
    const intruder = await FakeDevice.connect(stack.baseUrl, tokenB);
    intruder.capabilities(FULL, true);
    intruder.capabilities(FULL, false);
    await eventually(async () => {
      const r = await su.query("select full_access_opt_in from app.devices where id = $1", [devB]);
      return r.rows[0].full_access_opt_in === false;
    });
    // Org B's hub handler call for org A's device id is scoped to org B's tenant: nothing happens either.
    await stack.built.deviceHub.sessionHandler!.onAccessChanged(
      { deviceId: serverId, organizationId: orgB },
      "access_changed",
    );
    await sleep(300);
    expect((await sessionRow(s3)).permission_mode).toBe("fullAccess");
    expect((await sessionRow(s3)).status).toBe("idle");
    expect(server.pending("session.configure")).toHaveLength(0);
    expect(server.pending("session.stop")).toHaveLength(0);
    expect(await auditOf("work_session.settings_downgraded", { sessionId: s3 })).toHaveLength(1); // the policy test
    await intruder.close();

    // Device grants are tenant-scoped: org B's tenant sees none of org A's (not vacuous: org A sees it).
    await grant(samId, "acceptEdits");
    const macRow = {
      id: macId,
      ownerUserId: adminId,
      shared: false,
      shareMaxMode: "acceptEdits" as const,
      revokedAt: null,
    };
    const capIn = (organizationId: string) =>
      stack.built.core.db.withTenant({ organizationId, userId: null }, async (tx) =>
        (await loadDeviceAccess(tx, samId)).capOf(macRow),
      );
    expect(await capIn(orgId)).toBe("acceptEdits");
    expect(await capIn(orgB)).toBeNull();
  });
});
