import { createHash, randomUUID } from "node:crypto";
import { isExposed, type RuntimeCatalog, type RuntimeModel } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice, sleep } from "../../testing-device";

/**
 * Work Zone session controls (Phase 03.2, D-07, D-08, D-14, P-04 … P-08) against a real PostgreSQL + Redis and
 * a contracts-level fake device: catalog ingestion, `GET /controls`, `PATCH /settings` → `session.configure`,
 * `session.settings` back, denials and their audit, the per-turn mode on dispatched prompts.
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };

const model = (id: string, displayName: string, extra: Partial<RuntimeModel> = {}): RuntimeModel => ({
  id,
  displayName,
  description: null,
  legacy: false,
  isDefault: false,
  badge: null,
  efforts: ["low", "medium", "high", "xhigh", "max"].map((value) => ({ value, description: null })),
  defaultEffort: "medium",
  contextWindows: [],
  defaultContextWindow: 1_000_000,
  fastMode: { supported: false, reason: "model_not_allowed" },
  supportsAutoMode: true,
  ...extra,
});

const now = () => new Date().toISOString();
const CLAUDE: RuntimeCatalog = {
  runtime: "claude-code",
  runtimeVersion: "2.1.289",
  models: [
    model("opus", "Claude Opus 5.5", { isDefault: true, fastMode: { supported: true, reason: null } }),
    model("sonnet", "Claude Sonnet 5.5"),
    model("haiku", "Claude Haiku 4.5", { efforts: [], defaultEffort: null, supportsAutoMode: false }),
    model("claude-opus-4-6", "Claude Opus 4.6", {
      legacy: true,
      efforts: ["low", "medium", "high", "max"].map((value) => ({ value, description: null })),
      contextWindows: [200_000, 1_000_000],
      defaultContextWindow: 200_000,
    }),
  ],
  permissionModes: ["default", "acceptEdits", "plan", "auto"],
  fastModeCost: "Uses paid usage credits",
  collectedAt: now(),
};
const CODEX: RuntimeCatalog = {
  runtime: "codex",
  runtimeVersion: "0.160.0",
  models: [model("gpt-6.1-sol", "GPT-6.1 Sol", { isDefault: true })],
  permissionModes: ["default", "acceptEdits", "plan"],
  fastModeCost: "About 2.5x your subscription limits",
  collectedAt: now(),
};

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let alex: TestClient;
let stan: TestClient;
let device: FakeDevice;
let deviceId: string;
let projectId: string;

const errorCode = (res: { body: Record<string, unknown> | null }) =>
  (res.body?.error as { code?: string } | undefined)?.code;

async function invite(email: string, name: string, role: "standard" | "developer" | "admin") {
  const inv = await admin.request("POST", "/api/v1/invitations", { email, role });
  expect(inv.status, JSON.stringify(inv.body)).toBe(200);
  const c = new TestClient(stack.baseUrl);
  const res = await c.request("POST", `/api/v1/invitations/${inv.body!.id as string}/accept`, {
    name,
    password: "yet-another-long-password",
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return c;
}

async function pairDevice(owner: TestClient, name: string) {
  const code = (await owner.request("POST", "/api/v1/devices/enrollments")).body!.code as string;
  const anon = new TestClient(stack.baseUrl);
  const ok = await anon.request("POST", "/api/v1/devices/enroll", { code, name, platform: "darwin" });
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  return { deviceId: ok.body!.deviceId as string, token: ok.body!.deviceToken as string };
}

async function newSession(body: Record<string, unknown> = {}, as: TestClient = admin) {
  const res = await as.request("POST", "/api/v1/work-sessions", { projectId, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const id = res.body!.id as string;
  const start = await device.command("session.start", id);
  device.ack(start.id);
  device.event(id, {
    type: "session.started",
    runtime: "claude-code",
    runtimeSessionId: `rt-${id}`,
    model: "claude-opus-5-5",
    permissionMode: "default",
  });
  device.event(id, { type: "session.state", status: "idle" });
  await eventually(async () => (await detail(id)).session.status === "idle");
  return { id, start };
}

type SessionDto = {
  status: string;
  model: string | null;
  permissionMode: string;
  settings: {
    requested: Record<string, unknown>;
    effective: Record<string, unknown> | null;
    pending: boolean;
  };
  runningSince: string | null;
  diffStat: { files: number; additions: number; deletions: number } | null;
  fullAccess: boolean;
};

async function detail(id: string, as: TestClient = admin) {
  const res = await as.request("GET", `/api/v1/work-sessions/${id}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { session: SessionDto };
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
  alex = await invite("alex@example.test", "Alex", "developer");
  stan = await invite("stan@example.test", "Stan", "standard");

  const paired = await pairDevice(admin, "Víctor's MacBook");
  deviceId = paired.deviceId;
  device = await FakeDevice.connect(stack.baseUrl, paired.token);
  device.send({
    type: "projects.sync",
    projects: [{ localId: "lp_demo", name: "ocw", gitRemote: null, defaultBranch: "main" }],
  });
  await device.next((f) => f.type === "projects.ack");
  const projects = (await admin.request("GET", "/api/v1/projects")).body!.projects as Array<{ id: string }>;
  projectId = projects[0]!.id;
}, 180_000);

afterAll(async () => {
  await device?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

describe("runtime catalog (P-05)", () => {
  it("a capabilities frame is stored on the device; the hello opt-in defaults to off", async () => {
    device.capabilities([CLAUDE, CODEX], false);
    const row = await eventually(async () => {
      const r = await su.query("select runtime_catalog, full_access_opt_in from app.devices where id = $1", [
        deviceId,
      ]);
      return (r.rows[0].runtime_catalog as unknown[]).length === 2 ? r.rows[0] : undefined;
    });
    expect(row.full_access_opt_in).toBe(false);
    const devices = (await admin.request("GET", "/api/v1/devices")).body!.devices as Array<
      Record<string, unknown>
    >;
    expect(devices[0]).toMatchObject({ fullAccessOptIn: false, shareMaxMode: "acceptEdits" });
  });

  it("an invalid capabilities frame changes nothing", async () => {
    device.send({ type: "capabilities", catalogs: [{ runtime: "codex" }], fullAccessOptIn: true });
    await device.next((f) => f.type === "error" && f.code === "invalid_frame");
    const r = await su.query("select runtime_catalog, full_access_opt_in from app.devices where id = $1", [
      deviceId,
    ]);
    expect((r.rows[0].runtime_catalog as unknown[]).length).toBe(2);
    expect(r.rows[0].full_access_opt_in).toBe(false);
  });
});

describe("session controls (D-07, D-08, D-14)", () => {
  let sessionId: string;

  it("GET /controls lists only the session runtime's catalog models; Codex is under otherRuntimes", async () => {
    ({ id: sessionId } = await newSession({ title: "Controls" }));
    const res = await admin.request("GET", `/api/v1/work-sessions/${sessionId}/controls`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as {
      runtime: string;
      models: Array<{ id: string; available: boolean; fastMode: { available: boolean; reason: string } }>;
      otherRuntimes: Array<{ runtime: string; models: Array<{ id: string }> }>;
      permissionModes: Array<{ value: string; available: boolean; reason: string | null }>;
      settings: { pending: boolean };
    };
    expect(body.runtime).toBe("claude-code");
    expect(body.models.map((m) => m.id)).toEqual(CLAUDE.models.map((m) => m.id));
    expect(body.otherRuntimes).toEqual([
      { runtime: "codex", models: [{ id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" }] },
    ]);
    // Fast mode is off by org policy by default (D-11).
    expect(body.models[0]!.fastMode).toMatchObject({ available: false, reason: "org_policy" });
    const modes = Object.fromEntries(body.permissionModes.map((m) => [m.value, m]));
    expect(modes.default).toMatchObject({ available: true });
    // Auto awaits its fixture in the inventory (Plans 02/03 flip it): available exactly when it is exposed.
    expect(modes.auto!.available).toBe(isExposed("claude-code", "mode.auto"));
    if (!modes.auto!.available) expect(modes.auto!.reason).toBe("not_confirmed");
    expect(modes.fullAccess).toMatchObject({ available: false, reason: "org_policy" });
    expect(body.settings.pending).toBe(false);
  });

  it("PATCH /settings persists the model as requested, sends session.configure, audits and emits", async () => {
    const res = await admin.request("PATCH", `/api/v1/work-sessions/${sessionId}/settings`, {
      model: "sonnet",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const dto = res.body as unknown as SessionDto;
    expect(dto.model).toBe("sonnet");
    expect(dto.settings.requested.model).toBe("sonnet");
    expect(dto.settings.pending).toBe(true);

    const cmd = await device.command("session.configure", sessionId);
    expect(cmd.payload).toEqual({ settings: { model: "sonnet" }, reason: "user" });
    device.ack(cmd.id);

    const audit = await su.query(
      "select metadata from app.audit_events where action = 'work_session.settings_changed' and session_id = $1",
      [sessionId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata).toMatchObject({
      changed: ["model"],
      from: { model: null },
      to: { model: "sonnet" },
      source: "user",
    });
    const emitted = await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'work_session.updated' order by seq desc limit 1",
      [`ws:${sessionId}`],
    );
    expect(emitted.rows[0].payload.settings).toMatchObject({ pending: true, requested: { model: "sonnet" } });

    device.event(sessionId, {
      type: "session.settings",
      model: "claude-sonnet-5-5",
      permissionMode: "default",
    });
    const after = await eventually(async () => {
      const d = await detail(sessionId);
      return d.session.settings.pending ? undefined : d.session;
    });
    expect(after.settings.effective).toMatchObject({ model: "claude-sonnet-5-5", permissionMode: "default" });
  });

  it("a model outside the catalog is refused (403 not_in_catalog) and the denial is audited", async () => {
    const res = await admin.request("PATCH", `/api/v1/work-sessions/${sessionId}/settings`, {
      model: "unknown",
    });
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe("not_in_catalog");
    const denials = await su.query(
      "select metadata from app.audit_events where action = 'authz.denied' and metadata->>'permission' = 'work_session.configure'",
    );
    expect(denials.rows.map((r) => r.metadata.reason)).toContain("not_in_catalog");
    expect((await detail(sessionId)).session.model).toBe("sonnet");
  });

  it("full access is refused under the default org policy, on PATCH and on create", async () => {
    const res = await admin.request("PATCH", `/api/v1/work-sessions/${sessionId}/settings`, {
      permissionMode: "fullAccess",
    });
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe("org_policy");
    const create = await admin.request("POST", "/api/v1/work-sessions", {
      projectId,
      permissionMode: "fullAccess",
    });
    expect(create.status).toBe(403);
    expect(errorCode(create)).toBe("org_policy");
    expect(device.pending("session.configure")).toHaveLength(0);
  });

  it("a model switch drops an effort the new model does not offer (adjusted)", async () => {
    // Claude effort awaits its fixture in the inventory (Plan 02): store the requested effort directly.
    await su.query(`update app.work_sessions set settings = '{"effort":"xhigh"}' where id = $1`, [sessionId]);
    const res = await admin.request("PATCH", `/api/v1/work-sessions/${sessionId}/settings`, {
      model: "haiku",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const cmd = await device.command("session.configure", sessionId);
    expect(cmd.payload).toEqual({ settings: { model: "haiku", effort: null }, reason: "user" });
    device.ack(cmd.id);
    const audit = await su.query(
      "select metadata from app.audit_events where action = 'work_session.settings_changed' and session_id = $1 order by occurred_at desc limit 1",
      [sessionId],
    );
    expect(audit.rows[0].metadata).toMatchObject({ changed: ["model"], adjusted: ["effort"] });
    expect((res.body as unknown as SessionDto).settings.requested).toMatchObject({
      model: "haiku",
      effort: null,
    });
  });

  it("a standard member cannot change settings", async () => {
    const res = await stan.request("PATCH", `/api/v1/work-sessions/${sessionId}/settings`, { model: "opus" });
    expect(res.status).toBe(403);
  });

  it("a failed session.configure clears pending, stores the error and is audited", async () => {
    const res = await admin.request("PATCH", `/api/v1/work-sessions/${sessionId}/settings`, {
      model: "opus",
    });
    expect(res.status).toBe(200);
    const cmd = await device.command("session.configure", sessionId);
    device.ack(cmd.id, false, "settings changes are not supported by claude-code");
    const s = await eventually(async () => {
      const d = await detail(sessionId);
      return d.session.settings.pending ? undefined : d.session;
    });
    expect(s).toBeTruthy();
    const audit = await su.query(
      "select count(*)::int as n from app.audit_events where action = 'work_session.settings_failed' and session_id = $1",
      [sessionId],
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it("the next dispatched prompt carries the session's mode (P-07) and records it on the prompt", async () => {
    const mode = await admin.request("PATCH", `/api/v1/work-sessions/${sessionId}/settings`, {
      permissionMode: "acceptEdits",
    });
    expect(mode.status, JSON.stringify(mode.body)).toBe(200);
    device.ack((await device.command("session.configure", sessionId)).id);
    const queued = await alex.request("POST", `/api/v1/work-sessions/${sessionId}/prompts`, { body: "go" });
    expect(queued.status, JSON.stringify(queued.body)).toBe(200);
    const cmd = await device.command("prompt", sessionId);
    expect(cmd.payload).toMatchObject({ text: "go", permissionMode: "acceptEdits" });
    const row = await su.query("select permission_mode from app.work_prompts where id = $1", [
      cmd.payload.promptId,
    ]);
    expect(row.rows[0].permission_mode).toBe("acceptEdits");
    // runningSince is set while the turn is in flight.
    expect((await detail(sessionId)).session.runningSince).not.toBeNull();
    device.ack(cmd.id);
    const promptId = cmd.payload.promptId as string;
    device.event(sessionId, { type: "prompt.started", promptId });
    device.event(sessionId, {
      type: "prompt.completed",
      promptId,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await eventually(async () => (await detail(sessionId)).session.runningSince === null);
  });

  it("a diff.result stores the session's diff stat and shows it live (Task 3)", async () => {
    const cmd = await device.command("diff.request", sessionId);
    device.send({
      type: "diff.result",
      requestId: cmd.id,
      sessionId,
      files: [
        { path: "src/a.ts", status: "modified", additions: 6, deletions: 1 },
        { path: "src/b.ts", status: "added", additions: 3, deletions: 0 },
        { path: "README.md", status: "modified", additions: 1, deletions: 1 },
      ],
      patch: "",
      branch: "main",
    });
    device.ack(cmd.id);
    const s = await eventually(async () => {
      const d = await detail(sessionId);
      return d.session.diffStat ? d.session : undefined;
    });
    expect(s.diffStat).toEqual({ files: 3, additions: 10, deletions: 2 });
    const emitted = await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'work_session.updated' order by seq desc limit 1",
      [`ws:${sessionId}`],
    );
    expect(emitted.rows[0].payload.diffStat).toEqual({ files: 3, additions: 10, deletions: 2 });
  });

  it("an unknown session is a 404 for controls and settings", async () => {
    const id = randomUUID();
    expect((await admin.request("GET", `/api/v1/work-sessions/${id}/controls`)).status).toBe(404);
    expect(
      (await admin.request("PATCH", `/api/v1/work-sessions/${id}/settings`, { model: "opus" })).status,
    ).toBe(404);
  });
});

describe("Full access and device caps (Plan 04 Task 2: policy ∩ opt-in ∩ cap ∩ grain, D-02, D-04, P-06 … P-08)", () => {
  let ownerSession: string;
  let orgId: string;
  let adminId: string;
  let samId: string;
  let rexId: string;
  let sam: TestClient;
  let rex: TestClient;
  const FULL_CLAUDE: RuntimeCatalog = {
    ...CLAUDE,
    permissionModes: ["default", "acceptEdits", "plan", "auto", "fullAccess"],
  };
  const FULL_CODEX: RuntimeCatalog = {
    ...CODEX,
    permissionModes: ["default", "acceptEdits", "plan", "fullAccess"],
  };
  const userId = async (email: string) =>
    (await su.query("select id from auth.user where email = $1", [email])).rows[0].id as string;
  const report = async (optIn: boolean) => {
    device.capabilities([FULL_CLAUDE, FULL_CODEX], optIn);
    await eventually(async () => {
      const r = await su.query("select full_access_opt_in, runtime_catalog from app.devices where id = $1", [
        deviceId,
      ]);
      const modes = (r.rows[0].runtime_catalog as RuntimeCatalog[])[0]?.permissionModes ?? [];
      return r.rows[0].full_access_opt_in === optIn && modes.includes("fullAccess");
    });
  };
  const patch = (as: TestClient, id: string, body: Record<string, unknown>) =>
    as.request("PATCH", `/api/v1/work-sessions/${id}/settings`, body);
  const lastDenial = async () =>
    (
      await su.query(
        "select metadata from app.audit_events where action = 'authz.denied' and metadata->>'permission' = 'work_session.configure' order by occurred_at desc limit 1",
      )
    ).rows[0]?.metadata as Record<string, unknown> | undefined;
  const grant = (principalId: string, maxMode: string, revoked = false) =>
    su.query(
      `insert into app.device_grants (organization_id, device_id, principal_kind, principal_id, max_mode, revoked_at)
       values ($1, $2, 'user', $3, $4, ${revoked ? "now()" : "null"})
       on conflict (device_id, principal_kind, principal_id) do update set max_mode = excluded.max_mode, revoked_at = excluded.revoked_at`,
      [orgId, deviceId, principalId, maxMode],
    );

  beforeAll(async () => {
    orgId = (await su.query("select organization_id from app.devices where id = $1", [deviceId])).rows[0]
      .organization_id as string;
    adminId = await userId(ADMIN.email);
    sam = await invite("sam@example.test", "Sam", "developer");
    rex = await invite("rex@example.test", "Rex", "developer");
    samId = await userId("sam@example.test");
    rexId = await userId("rex@example.test");
    const put = await admin.request("PUT", "/api/v1/work-zone-policy", { allowFullAccess: true });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    await report(true);
    ({ id: ownerSession } = await newSession({ title: "Full access" }));
  });

  it("the owner enters Full access (audited) and leaves it (audited)", async () => {
    const res = await patch(admin, ownerSession, { permissionMode: "fullAccess" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as unknown as SessionDto).fullAccess).toBe(true);
    const cmd = await device.command("session.configure", ownerSession);
    expect(cmd.payload).toEqual({ settings: { permissionMode: "fullAccess" }, reason: "user" });
    device.ack(cmd.id);
    const actions = async () =>
      (
        await su.query(
          "select action, metadata, device_id from app.audit_events where session_id = $1 and action like 'work_session.%' order by occurred_at",
          [ownerSession],
        )
      ).rows as Array<{ action: string; metadata: Record<string, unknown>; device_id: string }>;
    let rows = await actions();
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(["work_session.settings_changed", "work_session.full_access_entered"]),
    );
    const entered = rows.find((r) => r.action === "work_session.full_access_entered")!;
    expect(entered.metadata).toMatchObject({ from: "default", to: "fullAccess" });
    expect(entered.device_id).toBe(deviceId);

    const back = await patch(admin, ownerSession, { permissionMode: "acceptEdits" });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    device.ack((await device.command("session.configure", ownerSession)).id);
    rows = await actions();
    expect(rows.find((r) => r.action === "work_session.full_access_left")?.metadata).toMatchObject({
      from: "fullAccess",
      to: "acceptEdits",
    });
  });

  it("with the device opt-in off, Full access is refused at the device layer", async () => {
    await report(false);
    const res = await patch(admin, ownerSession, { permissionMode: "fullAccess" });
    expect([res.status, errorCode(res)]).toEqual([403, "device_opt_in"]);
    expect(await lastDenial()).toMatchObject({ reason: "device_opt_in", layer: "device" });
    await report(true);
  });

  it("an unlisted developer gets the controller floor: acceptEdits yes, auto no", async () => {
    const ok = await patch(alex, ownerSession, { permissionMode: "default" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    device.ack((await device.command("session.configure", ownerSession)).id);
    const up = await patch(alex, ownerSession, { permissionMode: "acceptEdits" });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    device.ack((await device.command("session.configure", ownerSession)).id);
    const auto = await patch(alex, ownerSession, { permissionMode: "auto" });
    expect([auto.status, errorCode(auto)]).toEqual([403, "device_grant"]);
    const full = await patch(alex, ownerSession, { permissionMode: "fullAccess" });
    expect([full.status, errorCode(full)]).toEqual([403, "device_grant"]);
  });

  it("a grant below the floor lowers the floor for unlisted members (no inversion)", async () => {
    await patch(admin, ownerSession, { permissionMode: "default" });
    device.ack((await device.command("session.configure", ownerSession)).id);
    await grant(samId, "default");
    const res = await patch(alex, ownerSession, { permissionMode: "acceptEdits" });
    expect([res.status, errorCode(res)]).toEqual([403, "device_grant"]);
    // The grantee capped at default cannot go above it either.
    const samUp = await patch(sam, ownerSession, { permissionMode: "acceptEdits" });
    expect([samUp.status, errorCode(samUp)]).toEqual([403, "device_grant"]);
    const samPlan = await patch(sam, ownerSession, { permissionMode: "plan" });
    expect(samPlan.status, JSON.stringify(samPlan.body)).toBe(200);
    device.ack((await device.command("session.configure", ownerSession)).id);
  });

  it("a principal whose grant was revoked gets nothing in others' sessions, not even the floor", async () => {
    await grant(rexId, "acceptEdits", true);
    const res = await patch(rex, ownerSession, { permissionMode: "default" });
    expect([res.status, errorCode(res)]).toEqual([403, "device_grant"]);
    // An active grant wins over the revoked row.
    await grant(rexId, "default");
    const ok = await patch(rex, ownerSession, { permissionMode: "default" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    device.ack((await device.command("session.configure", ownerSession)).id);
  });

  it("POST /work-sessions in Full access follows the same rules", async () => {
    const ok = await admin.request("POST", "/api/v1/work-sessions", {
      projectId,
      title: "Born full",
      permissionMode: "fullAccess",
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const start = await device.command("session.start", ok.body!.id as string);
    expect(start.payload).toMatchObject({ permissionMode: "fullAccess" });
    device.ack(start.id);
    // Sam holds a current grant (default): he may start sessions on the device, but never in Full access.
    const samFull = await sam.request("POST", "/api/v1/work-sessions", {
      projectId,
      permissionMode: "fullAccess",
    });
    expect([samFull.status, errorCode(samFull)]).toEqual([403, "device_grant"]);
    await report(false);
    const off = await admin.request("POST", "/api/v1/work-sessions", {
      projectId,
      permissionMode: "fullAccess",
    });
    expect([off.status, errorCode(off)]).toEqual([403, "device_opt_in"]);
    await report(true);
  });

  it("GET /work-zone/controls answers for a usable device and refuses others", async () => {
    const res = await admin.request("GET", `/api/v1/work-zone/controls?deviceId=${deviceId}&runtime=codex`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as {
      runtime: string;
      models: Array<{ id: string }>;
      permissionModes: Array<{ value: string; available: boolean }>;
    };
    expect(body.runtime).toBe("codex");
    expect(body.models.map((m) => m.id)).toEqual(["gpt-6.1-sol"]);
    expect(body.permissionModes.find((m) => m.value === "fullAccess")?.available).toBe(true);
    // Sam (grant: default) sees fullAccess as above his cap.
    const samView = await sam.request("GET", `/api/v1/work-zone/controls?deviceId=${deviceId}&runtime=codex`);
    expect(samView.status).toBe(200);
    expect((samView.body as typeof body).permissionModes.find((m) => m.value === "fullAccess")).toMatchObject(
      { available: false, reason: "device_grant" },
    );
    // Alex has no relation to the device: no controls for a new session on it.
    const denied = await alex.request("GET", `/api/v1/work-zone/controls?deviceId=${deviceId}&runtime=codex`);
    expect([denied.status, errorCode(denied)]).toEqual([403, "device_not_shared"]);
    expect(
      (await admin.request("GET", `/api/v1/work-zone/controls?deviceId=${randomUUID()}&runtime=codex`))
        .status,
    ).toBe(404);
  });

  it("a deny rule on device.full_access makes Full access denied_for_you, even for the owner", async () => {
    const rule = await admin.request("POST", "/api/v1/permission-rules", {
      subjectKind: "user",
      subjectId: adminId,
      permission: "device.full_access",
      effect: "deny",
    });
    expect(rule.status, JSON.stringify(rule.body)).toBe(200);
    const c = await admin.request("GET", `/api/v1/work-sessions/${ownerSession}/controls`);
    const modes = (
      c.body as { permissionModes: Array<{ value: string; available: boolean; reason: string }> }
    ).permissionModes;
    expect(modes.find((m) => m.value === "fullAccess")).toMatchObject({
      available: false,
      reason: "denied_for_you",
    });
    const res = await patch(admin, ownerSession, { permissionMode: "fullAccess" });
    expect([res.status, errorCode(res)]).toEqual([403, "denied_for_you"]);
    expect(await lastDenial()).toMatchObject({ reason: "denied_for_you", layer: "user" });
    expect(
      (await admin.request("DELETE", `/api/v1/permission-rules/${rule.body!.id as string}`)).status,
    ).toBe(200);
  });
});

describe("tenant isolation (Task 2)", () => {
  it("another organization's session controls, settings, device frames and events are refused", async () => {
    const orgB = randomUUID();
    const userB = randomUUID();
    const devB = randomUUID();
    const projB = randomUUID();
    const convB = randomUUID();
    const wsB = randomUUID();
    const tokenB = `ocwd_${randomUUID()}`;
    const q = (t: string, v: unknown[]) => su.query(t, v);
    await q("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [orgB, `o-${orgB}`]);
    await q("insert into auth.user (id, name, email) values ($1, 'B', $2)", [userB, `${userB}@b.test`]);
    await q(
      "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash, shared, status, runtime_info) values ($1, $2, $3, 'B mac', 'darwin', $4, true, 'online', '[]')",
      [devB, orgB, userB, createHash("sha256").update(tokenB).digest("hex")],
    );
    await q(
      "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, 'lb', 'secret')",
      [projB, orgB, devB],
    );
    await q(
      "insert into app.conversations (id, organization_id, kind, name) values ($1, $2, 'work_session', 'b')",
      [convB, orgB],
    );
    await q(
      "insert into app.work_sessions (id, organization_id, conversation_id, project_id, device_id, title, created_by, status) values ($1, $2, $3, $4, $5, 'B', $6, 'idle')",
      [wsB, orgB, convB, projB, devB, userB],
    );

    // Org A's admin cannot read or change org B's session (404, nothing leaks).
    expect((await admin.request("GET", `/api/v1/work-sessions/${wsB}/controls`)).status).toBe(404);
    expect(
      (await admin.request("PATCH", `/api/v1/work-sessions/${wsB}/settings`, { model: "opus" })).status,
    ).toBe(404);
    const untouched = await su.query("select model, settings_pending from app.work_sessions where id = $1", [
      wsB,
    ]);
    expect(untouched.rows[0]).toEqual({ model: null, settings_pending: false });

    // Org B's device reports a catalog and an opt-in: only its own row changes.
    const before = await su.query(
      "select runtime_catalog, full_access_opt_in from app.devices where id = $1",
      [deviceId],
    );
    const intruder = await FakeDevice.connect(stack.baseUrl, tokenB);
    intruder.capabilities([{ ...CODEX, models: [model("evil", "Evil")] }], true);
    await eventually(async () => {
      const r = await su.query("select full_access_opt_in from app.devices where id = $1", [devB]);
      return r.rows[0].full_access_opt_in === true;
    });
    const after = await su.query(
      "select runtime_catalog, full_access_opt_in from app.devices where id = $1",
      [deviceId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);

    // Org B's device cannot report settings for org A's session.
    const { id: target } = await newSession({ title: "Tenant target" });
    const effectiveBefore = (await detail(target)).session.settings.effective;
    intruder.event(target, { type: "session.settings", model: "evil", permissionMode: "fullAccess" });
    await sleep(400);
    const s = (await detail(target)).session;
    expect(s.settings.effective).toEqual(effectiveBefore);
    expect(s.fullAccess).toBe(false);
    await intruder.close();
  });

  it("every device, project and Work Zone answer went through the resolver", () => {
    const undecided = stack.built.authz.undecided.filter((u) =>
      /^\/api\/v1\/(devices|projects|work-sessions|work-zone)/.test(u.url),
    );
    expect(undecided).toEqual([]);
  });
});
