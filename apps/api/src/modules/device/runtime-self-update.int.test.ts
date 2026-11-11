import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RuntimeSelfStatus, runtimeBuildOf } from "@ocw/contracts";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice, selfStatus, sleep } from "../../testing-device";
import { writeRuntimeDist } from "../../testing-runtime-dist";
import { invite, pairDevice, shareDevice } from "../../testing-workzone";

/**
 * The OCW runtime's own update on the Control Plane (07.17.1-09, D-01, D-02, D-05, D-07, D-09, PD-13, PD-14, PD-15,
 * PD-27): the owner's (or an admin's) click is decided by the API alone, queues one `runtime.update { runtime:
 * "ocw-runtime" }` to that device, and the device's run frames close the history row with both builds, audited
 * without a path. The workspace's served build (`hub.servedRuntime()`) reaches the owner's and admins' device DTO.
 *
 * One stack over one dist directory, which starts empty (a missing dist is re-read on every request; only a verified
 * one is cached), so the "no bundle served" case runs before the bundle is written.
 */

const ADMIN = { name: "Ada Admin", email: "ada@example.test", password: "correct-horse-battery" };
const A = "1a2b3c4d5e6f";

let stack: TestStack;
let su: pg.Client;
let dist: string;
let ada: TestClient;
let owen: TestClient;
let gail: TestClient;
let owenId: string;
/** Owen's service device, shared with Gail. */
let dId: string;
let dToken: string;
let d: FakeDevice;
/** The build the workspace serves once the bundle is written (`B`). */
let served: { version: string; build: string } | null = null;
const open: FakeDevice[] = [];

type Row = Record<string, unknown>;
type DeviceDto = { id: string; runtimeMaintenance?: Row & { self?: Row; served?: Row | null } };

const updateUrl = (deviceId: string, runtime = "ocw-runtime") =>
  `/api/v1/devices/${deviceId}/runtimes/${runtime}/update`;
const historyUrl = (deviceId: string, runtime?: string) =>
  `/api/v1/devices/${deviceId}/runtime-updates${runtime ? `?runtime=${runtime}` : ""}`;

async function serveBundle(): Promise<{ version: string; build: string }> {
  if (served) return served;
  const { manifest } = await writeRuntimeDist(dist, { version: "0.3.2" });
  served = { version: manifest.version, build: runtimeBuildOf(manifest.sha256) };
  return served;
}

async function deviceRow(id: string) {
  const res = await su.query("select status, runtime_maintenance from app.devices where id = $1", [id]);
  return res.rows[0] as { status: string; runtime_maintenance: (Row & { reportedAt: string }) | null };
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

/** A maintenance snapshot (the 07.11 defaults) with the device's own runtime `self` (omitted when null). */
function snapshot(self: RuntimeSelfStatus | null): Record<string, unknown> {
  return self ? { self } : {};
}

/**
 * Send a snapshot and wait until it is stored: frames of one socket are handled in order, so every frame sent before
 * it was handled too.
 */
async function report(dev: FakeDevice, deviceId: string, self: RuntimeSelfStatus | null) {
  const before = (await deviceRow(deviceId)).runtime_maintenance?.reportedAt ?? null;
  await sleep(5);
  dev.maintenance(snapshot(self));
  await eventually(async () => {
    const m = (await deviceRow(deviceId)).runtime_maintenance;
    return m && m.reportedAt !== before ? m : undefined;
  });
}

async function seen(as: TestClient, deviceId: string): Promise<DeviceDto | undefined> {
  const res = await as.request("GET", "/api/v1/devices");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body!.devices as DeviceDto[]).find((x) => x.id === deviceId);
}

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "ocw-self-update-dist-"));
  stack = await startTestStack({ env: { OCW_RUNTIME_DIST_DIR: dist } });
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
  let gailId: string;
  ({ client: gail, userId: gailId } = await invite(stack, ada, "gail@example.test", "Gail", "developer"));

  const paired = await pairDevice(stack, owen, "Owen's server");
  dId = paired.deviceId;
  dToken = paired.token;
  d = await FakeDevice.connect(stack.baseUrl, dToken, undefined, { host: "service" });
  open.push(d);
  await shareDevice(owen, dId, gailId);
}, 240_000);

afterEach(() => {
  // No frame of these tests is ever refused as invalid.
  for (const dev of open) expect(dev.frames.filter((f) => f.type === "error")).toEqual([]);
});

afterAll(async () => {
  for (const dev of open) await dev.close().catch(() => {});
  await su?.end();
  await stack?.stop();
  if (dist) await rm(dist, { recursive: true, force: true });
});

describe("07.17.1-09 Task 1: the owner's click reaches the device, and its report closes the run with its builds", () => {
  it("the device list shows self and served; the click queues { runtime } only; started and finished close the row with both builds, audited without a path", async () => {
    const B = (await serveBundle()).build;
    expect(B).toMatch(/^[0-9a-f]{12}$/);
    expect(B).not.toBe(A);
    await report(d, dId, selfStatus({ version: "0.3.1", build: A, supervised: true }));

    // D-01, PD-15: the owner reads the device's own runtime and what the workspace serves.
    const mine = await seen(owen, dId);
    expect(mine?.runtimeMaintenance?.self).toMatchObject({ version: "0.3.1", build: A, state: "idle" });
    expect(mine?.runtimeMaintenance?.served).toEqual({ version: "0.3.2", build: B });
    // A grantee sees the device, never its maintenance (07.11 PD-05).
    const shared = await seen(gail, dId);
    expect(shared).toBeDefined();
    expect(shared).not.toHaveProperty("runtimeMaintenance");

    const res = await owen.request("POST", updateUrl(dId));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const run = res.body!.run as Row;
    expect(run).toMatchObject({
      runtime: "ocw-runtime",
      state: "requested",
      trigger: "manual",
      requestedBy: { id: owenId, name: "Owen" },
      fromBuild: A,
      toBuild: B,
      candidate: "0.3.2",
    });

    // P1: the command names the target and nothing else.
    const cmd = await d.command("runtime.update");
    expect(cmd.payload).toEqual({ runtime: "ocw-runtime" });
    expect(d.pending("runtime.update")).toEqual([]);
    expect((await runs(dId)).find((r) => r.id === run.id)!.command_id).toBe(cmd.id);

    d.ack(cmd.id);
    const runId = randomUUID();
    const frame = {
      runId,
      runtime: "ocw-runtime",
      trigger: "manual",
      commandId: cmd.id,
      fromVersion: "0.3.1",
      toVersion: null,
      candidate: "0.3.2",
      method: "ocw_bundle",
      fromBuild: A,
      toBuild: B,
    };
    d.updateRun({ ...frame, phase: "started" });
    await report(d, dId, selfStatus({ build: A, state: "restarting" }));
    expect((await runs(dId)).find((r) => r.id === run.id)).toMatchObject({
      state: "started",
      run_id: runId,
      from_build: A,
      to_build: B,
    });
    d.updateRun({ ...frame, phase: "finished", outcome: "succeeded", toVersion: "0.3.2" });
    await report(d, dId, selfStatus({ version: "0.3.2", build: B }));

    const history = await owen.request("GET", historyUrl(dId, "ocw-runtime"));
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    const listed = history.body!.runs as Row[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: run.id,
      runtime: "ocw-runtime",
      state: "succeeded",
      fromVersion: "0.3.1",
      toVersion: "0.3.2",
      fromBuild: A,
      toBuild: B,
      method: "ocw_bundle",
      requestedBy: { id: owenId, name: "Owen" },
    });
    const all = await owen.request("GET", historyUrl(dId));
    expect((all.body!.runs as Row[]).map((r) => r.id)).toContain(run.id);

    // D-02, E20: requested, started and finished, each once, with versions and builds; never a path.
    for (const action of [
      "device.runtime_update_requested",
      "device.runtime_update_started",
      "device.runtime_update_finished",
    ]) {
      const rows = await audits(action, dId);
      expect(rows, action).toHaveLength(1);
      expect(rows[0], action).toMatchObject({
        actor_kind: "user",
        actor_id: owenId,
        result: "success",
        metadata: { runtime: "ocw-runtime", fromBuild: A, toBuild: B },
      });
      expect(JSON.stringify(rows[0]!.metadata), action).not.toContain("/");
    }
    expect((await audits("device.runtime_update_requested", dId))[0]!.metadata).toEqual({
      runtime: "ocw-runtime",
      from: "0.3.1",
      to: "0.3.2",
      fromBuild: A,
      toBuild: B,
    });
    expect((await audits("device.runtime_update_finished", dId))[0]!.metadata).toMatchObject({
      outcome: "succeeded",
      from: "0.3.1",
      to: "0.3.2",
      method: "ocw_bundle",
    });
  });
});
