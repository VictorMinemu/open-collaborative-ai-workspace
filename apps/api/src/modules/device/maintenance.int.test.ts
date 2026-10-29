import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice, maintenanceStatus, sleep } from "../../testing-device";
import { errorCode, invite, pairDevice, shareDevice } from "../../testing-workzone";

/**
 * Runtime maintenance on the Control Plane (Phase 07.11-06, D-02, D-04, D-05, D-06, D-11, PD-03…PD-08, RTU-03,
 * RTU-05, RTU-06): what a device reports about its coding CLIs is stored (`devices.runtime_maintenance`, the last
 * snapshot) and kept as history (`device_runtime_updates`); every step is audited in the same transaction without
 * output or a path; only the owner and admins (`device.maintain`) see the details and press "Update now", whose
 * command carries the runtime id and nothing else; every device hears the org's level and the manifest at connect and
 * on change; organization B never sees or touches organization A's device.
 */

const ADMIN = { name: "Ada Admin", email: "ada@example.test", password: "correct-horse-battery" };

let stack: TestStack;
let su: pg.Client;
let ada: TestClient;
let owen: TestClient;
let gail: TestClient;
let max: TestClient;
let eve: TestClient;
let adaId: string;
let owenId: string;
let orgId: string;
/** Owen's device, shared with Gail. */
let dId: string;
let d: FakeDevice;
/** Organization B's device. */
let eId: string;
let e: FakeDevice;
const open: FakeDevice[] = [];

type Row = Record<string, unknown>;
type DeviceDto = {
  id: string;
  viewerCan?: string[];
  runtimeCompatibility?: Record<string, string>;
  runtimeMaintenance?: Record<string, unknown> & { runtimes: Array<Record<string, unknown>> };
};

const CODEX = maintenanceStatus({
  runtime: "codex",
  installedVersion: "0.160.0",
  method: "codex_standalone",
  location: "~/.codex/packages/standalone",
  updateCommand: "codex update",
  latestVersion: "0.160.0",
});

/** A snapshot whose Claude Code status is `claude` (over the defaults) and whose Codex is current. */
function snapshot(claude: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const status = maintenanceStatus(claude);
  return {
    runtimes: [status, CODEX],
    runtimeInfo: [
      { id: "claude-code", installed: true, version: status.installedVersion, loggedIn: true },
      { id: "codex", installed: true, version: "0.160.0", loggedIn: false },
    ],
    ...extra,
  };
}

const BEHIND = snapshot({
  installedVersion: "2.1.290",
  latestVersion: "2.1.300",
  advisory: "behind",
  state: "pending",
  pendingSince: new Date().toISOString(),
});
const CURRENT = snapshot({ installedVersion: "2.1.300", latestVersion: "2.1.300" });

async function deviceRow(id: string) {
  const res = await su.query(
    "select status, runtime_info, runtime_maintenance from app.devices where id = $1",
    [id],
  );
  return res.rows[0] as {
    status: string;
    runtime_info: Array<{ id: string; version: string | null }>;
    runtime_maintenance: (Row & { reportedAt: string; runtimes: Row[] }) | null;
  };
}

async function audits(action: string, deviceId: string) {
  const res = await su.query(
    "select actor_kind, actor_id, user_id, result, metadata from app.audit_events where action = $1 and device_id = $2 order by occurred_at",
    [action, deviceId],
  );
  return res.rows as Array<{
    actor_kind: string;
    actor_id: string | null;
    user_id: string | null;
    result: string;
    metadata: Row;
  }>;
}

async function runs(deviceId: string) {
  const res = await su.query(
    "select * from app.device_runtime_updates where device_id = $1 order by created_at",
    [deviceId],
  );
  return res.rows as Row[];
}

async function lastSeq(stream: string): Promise<number> {
  const res = await su.query(
    "select coalesce(max(seq), 0)::int as s from app.stream_events where stream_id = $1",
    [stream],
  );
  return (res.rows[0] as { s: number }).s;
}

async function devicePings(stream: string, since: number) {
  const res = await su.query(
    "select payload from app.stream_events where stream_id = $1 and type = 'device.updated' and seq > $2",
    [stream, since],
  );
  return res.rows.map((r) => (r as { payload: Row }).payload);
}

/**
 * Frames of one socket are handled in order: once a snapshot sent now is stored (its `reportedAt` moved), every frame
 * sent before it was handled.
 */
async function barrier(dev: FakeDevice, deviceId: string, frame: Record<string, unknown>) {
  const before = (await deviceRow(deviceId)).runtime_maintenance?.reportedAt ?? null;
  await sleep(5);
  dev.maintenance(frame);
  await eventually(async () => {
    const m = (await deviceRow(deviceId)).runtime_maintenance;
    return m && m.reportedAt !== before ? m : undefined;
  });
}

async function devicesOf(as: TestClient): Promise<{ list: DeviceDto[]; raw: string }> {
  const res = await as.request("GET", "/api/v1/devices");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { list: res.body!.devices as DeviceDto[], raw: JSON.stringify(res.body) };
}

async function seen(as: TestClient, deviceId: string): Promise<DeviceDto> {
  const found = (await devicesOf(as)).list.find((x) => x.id === deviceId);
  expect(found, `device ${deviceId} is listed`).toBeDefined();
  return found!;
}

/** Organization B: Eve leaves A and becomes the admin of her own organization (the 07.5 / 07.9 matrix pattern). */
async function moveToOrgB(userId: string): Promise<void> {
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
    orgB,
    `o-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [userId]);
  await su.query("delete from app.org_members where user_id = $1", [userId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    userId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, userId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, userId]);
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
  adaId = ((await ada.request("GET", "/api/v1/me")).body!.user as { id: string }).id;
  ({ client: owen, userId: owenId } = await invite(stack, ada, "owen@example.test", "Owen", "developer"));
  let gailId: string;
  ({ client: gail, userId: gailId } = await invite(stack, ada, "gail@example.test", "Gail", "developer"));
  ({ client: max } = await invite(stack, ada, "max@example.test", "Max", "developer"));

  const paired = await pairDevice(stack, owen, "Owen's Mac");
  dId = paired.deviceId;
  d = await FakeDevice.connect(stack.baseUrl, paired.token, undefined, { claudeVersion: "2.1.290" });
  open.push(d);
  await shareDevice(owen, dId, gailId);
  orgId = (
    (await su.query("select organization_id from app.devices where id = $1", [dId])).rows[0] as {
      organization_id: string;
    }
  ).organization_id;

  const { client: eveClient, userId: eveId } = await invite(
    stack,
    ada,
    "eve@example.test",
    "Eve",
    "developer",
  );
  eve = eveClient;
  await moveToOrgB(eveId);
  const eveDevice = await pairDevice(stack, eve, "Eve's box");
  eId = eveDevice.deviceId;
  e = await FakeDevice.connect(stack.baseUrl, eveDevice.token);
  open.push(e);
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

describe("07.11-06 Task 1: a device reports its CLIs and updates itself; owners and admins see it", () => {
  it("a snapshot is stored with runtime_info, audits `available` once and pings org: with ids only", async () => {
    const stream = `org:${orgId}`;
    const since = await lastSeq(stream);
    d.maintenance(BEHIND);
    const stored = await eventually(async () => (await deviceRow(dId)).runtime_maintenance ?? undefined);
    expect(stored.runtimes[0]).toMatchObject({
      runtime: "claude-code",
      installedVersion: "2.1.290",
      latestVersion: "2.1.300",
      advisory: "behind",
      method: "native",
      location: "~/.local/bin",
    });
    expect(stored).toMatchObject({
      localLevel: "automatic",
      localLevelSource: "config",
      orgLevelReceived: true,
    });
    expect((await deviceRow(dId)).runtime_info.find((r) => r.id === "claude-code")?.version).toBe("2.1.290");

    const available = await audits("device.runtime_update_available", dId);
    expect(available).toHaveLength(1);
    expect(available[0]).toMatchObject({
      actor_kind: "device",
      actor_id: dId,
      user_id: null,
      result: "success",
      metadata: {
        runtime: "claude-code",
        installed: "2.1.290",
        candidate: "2.1.300",
        candidateCompatibility: "supported",
      },
    });

    const pings = await eventually(async () => {
      const p = await devicePings(stream, since);
      return p.length > 0 ? p : undefined;
    });
    for (const p of pings) expect(Object.keys(p).sort()).toEqual(["changed", "deviceId", "status"]);

    // The same snapshot again: stored again, no second `available`.
    await barrier(d, dId, BEHIND);
    expect(await audits("device.runtime_update_available", dId)).toHaveLength(1);
  });

  it("an automatic run leaves one history row with scrubbed output and system audits without it; a replay changes nothing", async () => {
    const runId = randomUUID();
    const started = { runId, phase: "started", fromVersion: "2.1.290", candidate: "2.1.300" };
    const finished = {
      runId,
      phase: "finished",
      outcome: "succeeded",
      fromVersion: "2.1.290",
      toVersion: "2.1.300",
      candidate: "2.1.300",
      output: "changed 1 package\nnpm error path /usr/lib/x",
    };
    d.updateRun(started);
    d.updateRun(finished);
    await barrier(d, dId, CURRENT);

    const rows = await runs(dId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      run_id: runId,
      runtime: "claude-code",
      trigger: "automatic",
      state: "succeeded",
      requested_by: null,
      from_version: "2.1.290",
      to_version: "2.1.300",
      candidate: "2.1.300",
      method: "native",
    });
    expect(rows[0]!.output).toBe("changed 1 package\nnpm error path <path>");
    expect(rows[0]!.started_at).not.toBeNull();
    expect(rows[0]!.finished_at).not.toBeNull();
    expect((await deviceRow(dId)).runtime_info.find((r) => r.id === "claude-code")?.version).toBe("2.1.300");

    const s = await audits("device.runtime_update_started", dId);
    const f = await audits("device.runtime_update_finished", dId);
    expect(s).toHaveLength(1);
    expect(f).toHaveLength(1);
    for (const a of [...s, ...f]) {
      expect(a).toMatchObject({ actor_kind: "system", actor_id: null, user_id: null });
      expect(Object.keys(a.metadata).sort()).toEqual([
        "candidate",
        "from",
        "method",
        "outcome",
        "runtime",
        "to",
        "trigger",
      ]);
    }
    expect(f[0]).toMatchObject({
      result: "success",
      metadata: {
        runtime: "claude-code",
        from: "2.1.290",
        to: "2.1.300",
        candidate: "2.1.300",
        outcome: "succeeded",
        trigger: "automatic",
        method: "native",
      },
    });

    // Replayed from the device's offline log: nothing changes.
    d.updateRun(started);
    d.updateRun(finished);
    await barrier(d, dId, CURRENT);
    expect(await runs(dId)).toHaveLength(1);
    expect(await audits("device.runtime_update_started", dId)).toHaveLength(1);
    expect(await audits("device.runtime_update_finished", dId)).toHaveLength(1);

    // No audit row of this phase carries output or a path.
    const all = await su.query(
      "select metadata::text as m from app.audit_events where action like 'device.runtime_update%' and device_id = $1",
      [dId],
    );
    for (const r of all.rows as Array<{ m: string }>) {
      expect(r.m).not.toMatch(/npm error|<path>|\/usr|~\//);
    }
  });

  it("GET /devices: the owner and an admin see runtimeMaintenance; a grantee and a member see only compatibility", async () => {
    for (const viewer of [owen, ada]) {
      const dto = await seen(viewer, dId);
      expect(dto.viewerCan).toContain("device.maintain");
      expect(dto.runtimeMaintenance).toMatchObject({
        localLevel: "automatic",
        localLevelSource: "config",
        effectiveLevel: "automatic",
        orgLevel: "automatic",
      });
      expect(dto.runtimeMaintenance).not.toHaveProperty("orgLevelReceived");
      expect(typeof dto.runtimeMaintenance!.reportedAt).toBe("string");
      expect(dto.runtimeMaintenance!.runtimes.map((r) => r.runtime)).toEqual(["claude-code", "codex"]);
      expect(dto.runtimeCompatibility).toEqual({ "claude-code": "supported", codex: "supported" });
    }
    for (const viewer of [gail, max]) {
      const dto = await seen(viewer, dId);
      expect(dto.viewerCan ?? []).not.toContain("device.maintain");
      expect(dto).not.toHaveProperty("runtimeMaintenance");
      expect(dto.runtimeCompatibility).toEqual({ "claude-code": "supported", codex: "supported" });
    }
  });

  it("GET /devices/:id/runtime-updates: owner and admin read the history, filtered by runtime; others get 403", async () => {
    for (const viewer of [owen, ada]) {
      const res = await viewer.request("GET", `/api/v1/devices/${dId}/runtime-updates`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const list = res.body!.runs as Row[];
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        runtime: "claude-code",
        trigger: "automatic",
        state: "succeeded",
        requestedBy: null,
        fromVersion: "2.1.290",
        toVersion: "2.1.300",
        method: "native",
        output: "changed 1 package\nnpm error path <path>",
        requestedAt: null,
      });
      const codex = await viewer.request("GET", `/api/v1/devices/${dId}/runtime-updates?runtime=codex`);
      expect(codex.status).toBe(200);
      expect(codex.body!.runs).toEqual([]);
    }
    for (const viewer of [gail, max]) {
      const res = await viewer.request("GET", `/api/v1/devices/${dId}/runtime-updates`);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    }
    const unknown = await ada.request("GET", `/api/v1/devices/${randomUUID()}/runtime-updates`);
    expect(unknown.status).toBe(404);
    expect(errorCode(unknown)).toBe("not_found");
  });
});

const ZERO_SESSION = "00000000-0000-0000-0000-000000000000";
const updateUrl = (deviceId: string, runtime = "claude-code") =>
  `/api/v1/devices/${deviceId}/runtimes/${runtime}/update`;

describe("07.11-06 Task 2: Update now (owner or admin, one pending at a time, payload = runtime id)", () => {
  it("the owner's request is audited with the runtime only, queues { runtime } exactly, and the device's run adopts it", async () => {
    const res = await owen.request("POST", updateUrl(dId));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const run = res.body!.run as Row;
    expect(run).toMatchObject({
      runtime: "claude-code",
      state: "requested",
      trigger: "manual",
      requestedBy: { id: owenId, name: "Owen" },
      startedAt: null,
      finishedAt: null,
    });
    expect(typeof run.requestedAt).toBe("string");

    const requested = await audits("device.runtime_update_requested", dId);
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ actor_kind: "user", actor_id: owenId, user_id: owenId });
    expect(requested[0]!.metadata).toEqual({ runtime: "claude-code" });

    // D-05: the command names the runtime and nothing else.
    const cmd = await d.command("runtime.update");
    expect(cmd.payload).toEqual({ runtime: "claude-code" });
    expect(cmd.sessionId).toBe(ZERO_SESSION);
    expect((await runs(dId)).find((r) => r.id === run.id)!.command_id).toBe(cmd.id);

    d.ack(cmd.id);
    const runId = randomUUID();
    d.updateRun({
      runId,
      trigger: "manual",
      commandId: cmd.id,
      fromVersion: "2.1.300",
      candidate: "2.1.301",
    });
    await barrier(d, dId, CURRENT);
    const adopted = (await runs(dId)).find((r) => r.id === run.id)!;
    expect(adopted).toMatchObject({
      state: "started",
      run_id: runId,
      requested_by: owenId,
      method: "native",
    });
    const started = (await audits("device.runtime_update_started", dId)).filter(
      (a) => a.actor_kind === "user",
    );
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ actor_id: owenId, user_id: owenId, metadata: { trigger: "manual" } });

    d.updateRun({
      runId,
      trigger: "manual",
      commandId: cmd.id,
      phase: "finished",
      outcome: "succeeded",
      fromVersion: "2.1.300",
      toVersion: "2.1.301",
      candidate: "2.1.301",
    });
    await barrier(d, dId, CURRENT);
    expect((await runs(dId)).find((r) => r.id === run.id)!.state).toBe("succeeded");
    const finished = (await audits("device.runtime_update_finished", dId)).filter(
      (a) => a.actor_kind === "user",
    );
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      actor_id: owenId,
      result: "success",
      metadata: { outcome: "succeeded", from: "2.1.300", to: "2.1.301", trigger: "manual" },
    });
    expect(await runs(dId)).toHaveLength(2);
  });

  it("a second request while one waits is 409 update_pending; one older than an hour expires and a new one is accepted", async () => {
    const first = await owen.request("POST", updateUrl(dId));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const firstId = (first.body!.run as Row).id as string;
    const again = await ada.request("POST", updateUrl(dId));
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(errorCode(again)).toBe("update_pending");

    await su.query(
      "update app.device_runtime_updates set requested_at = now() - interval '2 hours' where id = $1",
      [firstId],
    );
    const fresh = await ada.request("POST", updateUrl(dId));
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect((fresh.body!.run as Row).requestedBy).toEqual({ id: adaId, name: "Ada Admin" });
    const rows = await runs(dId);
    expect(rows.find((r) => r.id === firstId)!.state).toBe("expired");
    expect(rows.filter((r) => r.state === "requested")).toHaveLength(1);
  });

  it("the device refusing the command marks the request refused with its reason, audited as an error", async () => {
    // Owen's expired command and Ada's both reach the device, in order.
    const expired = await d.command("runtime.update");
    d.ack(expired.id);
    const cmd = await d.command("runtime.update");
    expect(cmd.payload).toEqual({ runtime: "claude-code" });
    d.ack(cmd.id, false, "updates are off on this device");
    const refused = await eventually(async () =>
      (await runs(dId)).find((r) => r.command_id === cmd.id && r.state === "refused"),
    );
    expect(refused).toMatchObject({ error: "updates are off on this device", requested_by: adaId });
    expect(refused.finished_at).not.toBeNull();
    const finished = (await audits("device.runtime_update_finished", dId)).filter(
      (a) => a.actor_id === adaId,
    );
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      actor_kind: "user",
      result: "error",
      metadata: { runtime: "claude-code", outcome: "refused", trigger: "manual" },
    });
    // The expired request stays expired (its accepted ack changes nothing).
    expect((await runs(dId)).find((r) => r.command_id === expired.id)!.state).toBe("expired");

    const history = await owen.request("GET", `/api/v1/devices/${dId}/runtime-updates`);
    expect(history.status).toBe(200);
    const listed = history.body!.runs as Row[];
    expect(listed[0]).toMatchObject({ state: "refused", error: "updates are off on this device" });
    expect(listed.map((r) => r.state)).toEqual(["refused", "expired", "succeeded", "succeeded"]);
  });

  it("only the owner and admins may ask: a grantee and a member get 403; bad runtime 400; unknown or revoked device 404", async () => {
    for (const viewer of [gail, max]) {
      const res = await viewer.request("POST", updateUrl(dId));
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    }
    const bad = await owen.request("POST", updateUrl(dId, "gemini"));
    expect(bad.status).toBe(400);
    const unknown = await ada.request("POST", updateUrl(randomUUID()));
    expect(unknown.status).toBe(404);

    const old = await pairDevice(stack, owen, "Owen's old laptop");
    const revoke = await owen.request("DELETE", `/api/v1/devices/${old.deviceId}`);
    expect(revoke.status, JSON.stringify(revoke.body)).toBe(200);
    for (const viewer of [owen, ada]) {
      expect((await viewer.request("POST", updateUrl(old.deviceId))).status).toBe(404);
      expect((await viewer.request("GET", `/api/v1/devices/${old.deviceId}/runtime-updates`)).status).toBe(
        404,
      );
    }
    // Nobody but the owner and Ada asked: still one requested audit per accepted request.
    expect(await audits("device.runtime_update_requested", dId)).toHaveLength(3);
  });

  it("refusals: an offline device is 409 device_offline; a CLI the device cannot update is 409 manual_update", async () => {
    const asleep = await pairDevice(stack, owen, "Owen's iMac");
    const offline = await owen.request("POST", updateUrl(asleep.deviceId));
    expect(offline.status, JSON.stringify(offline.body)).toBe(409);
    expect(errorCode(offline)).toBe("device_offline");

    d.maintenance(
      snapshot({
        method: "homebrew_cask",
        location: null,
        canUpdate: false,
        reason: "manual",
        updateCommand: "brew upgrade --cask claude-code",
      }),
    );
    await eventually(
      async () => (await deviceRow(dId)).runtime_maintenance?.runtimes[0]?.canUpdate === false,
    );
    const manual = await owen.request("POST", updateUrl(dId));
    expect(manual.status, JSON.stringify(manual.body)).toBe(409);
    expect(errorCode(manual)).toBe("manual_update");
    expect((manual.body!.error as { message: string }).message).toContain("brew upgrade --cask claude-code");

    await barrier(
      d,
      dId,
      snapshot({
        canUpdate: false,
        reason: "needs_admin",
        updateCommand: "sudo npm install -g @anthropic-ai/claude-code",
      }),
    );
    const admin = await ada.request("POST", updateUrl(dId));
    expect(admin.status, JSON.stringify(admin.body)).toBe(409);
    expect(errorCode(admin)).toBe("manual_update");
    expect((admin.body!.error as { message: string }).message).toContain("administrator");

    // Codex on the same device is still updatable; restore the snapshot for the next cases.
    await barrier(d, dId, CURRENT);
    expect(await audits("device.runtime_update_requested", dId)).toHaveLength(3);
  });
});

/** Drop the `runtime.config` frames a device already got, so the next one is the push under test. */
function forgetConfigs(dev: FakeDevice): void {
  for (let i = dev.frames.length - 1; i >= 0; i--)
    if (dev.frames[i]!.type === "runtime.config") dev.frames.splice(i, 1);
}

const configsOf = (dev: FakeDevice) => dev.frames.filter((f) => f.type === "runtime.config");

async function setLevel(level: "automatic" | "notify" | "off"): Promise<void> {
  const res = await ada.request("PUT", "/api/v1/work-zone-policy", { runtimeUpdates: level });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body!.runtimeUpdates).toBe(level);
}

describe("07.11-06 Task 3: every device hears the org's level and the manifest; organization B is never touched", () => {
  it("a connecting device gets runtime.config right after welcome: the org level and the hub's manifest", async () => {
    const fresh = await pairDevice(stack, owen, "Owen's mini");
    const dev = await FakeDevice.connect(stack.baseUrl, fresh.token);
    open.push(dev);
    // `connect` consumed `welcome`; the next frame is the config.
    const first = await eventually(async () => dev.frames[0]);
    expect(first).toEqual({
      type: "runtime.config",
      policy: "automatic",
      manifest: stack.built.deviceHub.runtimeManifest,
    });
    await dev.close();
  });

  it("an admin's level change reaches every online device of the org within a second, and no device of org B", async () => {
    // Both devices got their config at connect.
    expect(configsOf(d).length).toBeGreaterThan(0);
    expect(configsOf(e).length).toBeGreaterThan(0);
    forgetConfigs(d);
    forgetConfigs(e);

    const t0 = Date.now();
    await setLevel("notify");
    const pushed = await d.next((f) => f.type === "runtime.config", 1000);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(pushed).toEqual({
      type: "runtime.config",
      policy: "notify",
      manifest: stack.built.deviceHub.runtimeManifest,
    });
    await sleep(300);
    expect(configsOf(e)).toEqual([]);

    // The owner's and an admin's view applies the org level.
    for (const viewer of [owen, ada]) {
      expect((await seen(viewer, dId)).runtimeMaintenance).toMatchObject({ orgLevel: "notify" });
    }

    // A change that leaves runtimeUpdates alone sends nothing.
    const fast = (await ada.request("GET", "/api/v1/work-zone-policy")).body!.allowFastMode as boolean;
    const other = await ada.request("PUT", "/api/v1/work-zone-policy", { allowFastMode: !fast });
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    const same = await ada.request("PUT", "/api/v1/work-zone-policy", { runtimeUpdates: "notify" });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    await sleep(500);
    expect(configsOf(d)).toEqual([]);
    expect(configsOf(e)).toEqual([]);
  });

  it("with the org level off, Update now is 409 runtime_updates_off and the device hears off", async () => {
    forgetConfigs(d);
    await setLevel("off");
    expect(await d.next((f) => f.type === "runtime.config", 1000)).toMatchObject({ policy: "off" });
    const res = await owen.request("POST", updateUrl(dId));
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(errorCode(res)).toBe("runtime_updates_off");

    await setLevel("automatic");
    expect(await d.next((f) => f.type === "runtime.config", 1000)).toMatchObject({ policy: "automatic" });
    await sleep(300);
    expect(configsOf(e)).toEqual([]);
  });

  it("organization B can neither request, list nor read anything about organization A's device", async () => {
    const post = await eve.request("POST", updateUrl(dId));
    expect(post.status, JSON.stringify(post.body)).toBe(404);
    const history = await eve.request("GET", `/api/v1/devices/${dId}/runtime-updates`);
    expect(history.status, JSON.stringify(history.body)).toBe(404);
    const { list, raw } = await devicesOf(eve);
    expect(list.map((x) => x.id)).toEqual([eId]);
    expect(raw).not.toContain(dId);
    expect(raw).not.toContain("Owen");
    expect(list[0]).not.toHaveProperty("runtimeMaintenance");
    // And organization A never lists B's device.
    expect((await devicesOf(ada)).list.map((x) => x.id)).not.toContain(eId);
    // Nothing of B's device was ever written by A's activity.
    expect(await runs(eId)).toEqual([]);
    expect((await deviceRow(eId)).runtime_maintenance).toBeNull();
  });
});

describe("07.11 review LO-03: a committed policy change never answers 500", () => {
  it("a failing push of the new level to the devices still answers 200 with the saved policy", async () => {
    const hub = stack.built.deviceHub;
    const push = hub.pushRuntimeConfig.bind(hub);
    hub.pushRuntimeConfig = async () => {
      throw new Error("redis is down");
    };
    try {
      await setLevel("notify");
      const read = await ada.request("GET", "/api/v1/work-zone-policy");
      expect(read.body!.runtimeUpdates).toBe("notify");
    } finally {
      hub.pushRuntimeConfig = push;
    }
    await setLevel("automatic");
  });
});

describe("07.11 review ME-04: history rows that can never finish are closed", () => {
  it("a run the device started and never finished is closed as failed (interrupted) at its next snapshot; a late finished frame still records the real outcome", async () => {
    const runId = randomUUID();
    d.updateRun({ runId, phase: "started", fromVersion: "2.1.300", candidate: "2.1.301" });
    await barrier(d, dId, CURRENT);
    expect((await runs(dId)).find((r) => r.run_id === runId)).toMatchObject({ state: "started" });
    // A fresh run is left alone by the next snapshot.
    await barrier(d, dId, CURRENT);
    expect((await runs(dId)).find((r) => r.run_id === runId)).toMatchObject({ state: "started" });

    // The daemon died mid-install (07.11 review HI-04): no finished frame for over half an hour.
    await su.query(
      "update app.device_runtime_updates set started_at = now() - interval '2 hours' where run_id = $1",
      [runId],
    );
    const before = (await audits("device.runtime_update_finished", dId)).length;
    await barrier(d, dId, CURRENT);
    const closed = (await runs(dId)).find((r) => r.run_id === runId)!;
    expect(closed).toMatchObject({ state: "failed" });
    expect(String(closed.error)).toMatch(/^interrupted/);
    expect(closed.finished_at).not.toBeNull();
    const finished = await audits("device.runtime_update_finished", dId);
    expect(finished).toHaveLength(before + 1);
    expect(finished.at(-1)).toMatchObject({
      actor_kind: "system",
      result: "error",
      metadata: { runtime: "claude-code", outcome: "failed", candidate: "2.1.301" },
    });

    // The device's real finished frame, replayed late from its offline log, still closes it.
    d.updateRun({
      runId,
      phase: "finished",
      outcome: "succeeded",
      fromVersion: "2.1.300",
      toVersion: "2.1.301",
      candidate: "2.1.301",
    });
    await barrier(d, dId, CURRENT);
    expect((await runs(dId)).find((r) => r.run_id === runId)).toMatchObject({
      state: "succeeded",
      to_version: "2.1.301",
      error: null,
    });
  });

  it("reading the history expires a request older than the hour (and organization B's reads touch nothing of A)", async () => {
    await setLevel("automatic");
    const res = await owen.request("POST", updateUrl(dId));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const id = (res.body!.run as Row).id as string;
    await su.query(
      "update app.device_runtime_updates set requested_at = now() - interval '2 hours' where id = $1",
      [id],
    );
    const other = await eve.request("GET", `/api/v1/devices/${eId}/runtime-updates`);
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    expect((await runs(dId)).find((r) => r.id === id)).toMatchObject({ state: "requested" });

    const history = await owen.request("GET", `/api/v1/devices/${dId}/runtime-updates`);
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    expect((history.body!.runs as Row[]).find((r) => r.id === id)).toMatchObject({ state: "expired" });
    expect((await runs(dId)).find((r) => r.id === id)).toMatchObject({ state: "expired" });
  });
});
