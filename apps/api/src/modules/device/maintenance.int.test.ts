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
