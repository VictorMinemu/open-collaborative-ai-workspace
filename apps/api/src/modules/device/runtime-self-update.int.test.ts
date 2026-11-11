import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNTIME_SELF_UPDATE_REFUSAL_SENTENCES,
  type RuntimeSelfStatus,
  type RuntimeSelfUpdateRefusal,
  runtimeBuildOf,
} from "@ocw/contracts";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice, selfStatus, sleep } from "../../testing-device";
import { writeRuntimeDist } from "../../testing-runtime-dist";
import { errorCode, invite, pairDevice, shareDevice, startSession } from "../../testing-workzone";
import { RUN_INTERRUPTED } from "./maintenance";

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
let eve: TestClient;
let adaId: string;
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

/** The `runtime.update` commands ever queued for `deviceId`. */
async function updateCommands(deviceId: string): Promise<number> {
  const res = await su.query(
    "select count(*)::int as n from app.device_commands where device_id = $1 and kind = 'runtime.update'",
    [deviceId],
  );
  return (res.rows[0] as { n: number }).n;
}

const requestedRows = async (deviceId: string) =>
  (await runs(deviceId)).filter((r) => r.state === "requested");

/** A 409 with `code` and the contracts' sentence, that queued nothing and recorded nothing. */
async function expectRefusal(
  as: TestClient,
  deviceId: string,
  code: RuntimeSelfUpdateRefusal | "device_offline",
): Promise<void> {
  const commands = await updateCommands(deviceId);
  const rows = (await runs(deviceId)).length;
  const res = await as.request("POST", updateUrl(deviceId));
  expect(res.status, JSON.stringify(res.body)).toBe(409);
  expect(errorCode(res)).toBe(code);
  if (code !== "device_offline") {
    expect((res.body!.error as { message: string }).message).toBe(
      RUNTIME_SELF_UPDATE_REFUSAL_SENTENCES[code],
    );
  }
  expect(await updateCommands(deviceId)).toBe(commands);
  expect((await runs(deviceId)).length).toBe(rows);
}

async function setLevel(level: "automatic" | "notify" | "off"): Promise<void> {
  const res = await ada.request("PUT", "/api/v1/work-zone-policy", { runtimeUpdates: level });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body!.runtimeUpdates).toBe(level);
}

/** The device refuses the waiting command (its own re-decision), closing the request as `refused`. */
async function refuseNext(dev: FakeDevice, deviceId: string, error: string): Promise<Row> {
  const cmd = await dev.command("runtime.update");
  dev.ack(cmd.id, false, error);
  return eventually(async () =>
    (await runs(deviceId)).find((r) => r.command_id === cmd.id && r.state === "refused"),
  );
}

/** Organization B: Eve leaves A and becomes the admin of her own organization (the 07.11 matrix pattern). */
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

async function seen(as: TestClient, deviceId: string): Promise<DeviceDto | undefined> {
  const res = await as.request("GET", "/api/v1/devices");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body!.devices as DeviceDto[]).find((x) => x.id === deviceId);
}

beforeAll(async () => {
  // A closed socket reads as offline quickly (the abandoned-run case, PD-14).
  process.env.OCW_DEVICE_OFFLINE_GRACE_MS = "300";
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
  adaId = ((await ada.request("GET", "/api/v1/me")).body!.user as { id: string }).id;
  ({ client: owen, userId: owenId } = await invite(stack, ada, "owen@example.test", "Owen", "developer"));
  let gailId: string;
  ({ client: gail, userId: gailId } = await invite(stack, ada, "gail@example.test", "Gail", "developer"));

  const paired = await pairDevice(stack, owen, "Owen's server");
  dId = paired.deviceId;
  dToken = paired.token;
  d = await FakeDevice.connect(stack.baseUrl, dToken, undefined, { host: "service" });
  open.push(d);
  await shareDevice(owen, dId, gailId);
  let eveId: string;
  ({ client: eve, userId: eveId } = await invite(stack, ada, "eve@example.test", "Eve", "developer"));
  await moveToOrgB(eveId);
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
  delete process.env.OCW_DEVICE_OFFLINE_GRACE_MS;
});

describe("07.17.1-09 Task 2 (runs first, before the bundle exists): no served bundle", () => {
  it("with no bundle served the DTO's served is null and the click is 409 runtime_not_served", async () => {
    await report(d, dId, selfStatus({ build: A }));
    const mine = await seen(owen, dId);
    expect(mine?.runtimeMaintenance?.self).toMatchObject({ build: A });
    expect(mine?.runtimeMaintenance?.served).toBeNull();
    await expectRefusal(owen, dId, "runtime_not_served");
  });
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

describe("07.17.1-09 Task 2: who may update, which devices qualify, and the organization's `off` level", () => {
  it("a device that already runs the served build is 409 already_current", async () => {
    const B = (await serveBundle()).build;
    await report(d, dId, selfStatus({ version: "0.3.2", build: B }));
    await expectRefusal(owen, dId, "already_current");
  });

  it("a device whose runtime cannot update itself answers its reason as the code; no self is self_update_unsupported", async () => {
    const blocks = [
      { reason: "not_supervised", supervised: false },
      { reason: "not_installed", supervised: true },
      { reason: "node_too_old", supervised: true },
    ] as const;
    for (const b of blocks) {
      await report(d, dId, selfStatus({ build: A, canUpdate: false, ...b }));
      await expectRefusal(owen, dId, b.reason);
    }
    // A daemon older than 07.17.1 reports no `self`: the API never sends it a command it does not know.
    await report(d, dId, null);
    expect((await seen(owen, dId))?.runtimeMaintenance).not.toHaveProperty("self");
    await expectRefusal(owen, dId, "self_update_unsupported");
  });

  it("a desktop host is 409 not_a_service and an offline device is 409 device_offline", async () => {
    const desk = await pairDevice(stack, owen, "Owen's laptop");
    const laptop = await FakeDevice.connect(stack.baseUrl, desk.token, undefined, { host: "desktop" });
    open.push(laptop);
    await report(laptop, desk.deviceId, selfStatus({ build: null, supervised: false, canUpdate: false }));
    await expectRefusal(owen, desk.deviceId, "not_a_service");
    // A host that never said how it runs is not a service either.
    const unknown = await pairDevice(stack, owen, "Owen's old box");
    const box = await FakeDevice.connect(stack.baseUrl, unknown.token);
    open.push(box);
    await report(box, unknown.deviceId, selfStatus({ build: A }));
    await expectRefusal(owen, unknown.deviceId, "not_a_service");

    const asleep = await pairDevice(stack, owen, "Owen's other server");
    await expectRefusal(owen, asleep.deviceId, "device_offline");
  });

  it("a grantee member gets 403 and organization B's admin gets 404; neither queues anything", async () => {
    await report(d, dId, selfStatus({ build: A }));
    const commands = await updateCommands(dId);
    const rows = (await runs(dId)).length;
    const grantee = await gail.request("POST", updateUrl(dId));
    expect(grantee.status, JSON.stringify(grantee.body)).toBe(403);
    const other = await eve.request("POST", updateUrl(dId));
    expect(other.status, JSON.stringify(other.body)).toBe(404);
    const otherHistory = await eve.request("GET", historyUrl(dId, "ocw-runtime"));
    expect(otherHistory.status, JSON.stringify(otherHistory.body)).toBe(404);
    const otherList = await eve.request("GET", "/api/v1/devices");
    expect(otherList.status).toBe(200);
    expect(JSON.stringify(otherList.body)).not.toContain(dId);
    expect(await updateCommands(dId)).toBe(commands);
    expect((await runs(dId)).length).toBe(rows);
  });

  it("an admin may update the owner's server; a second click waits (update_pending); the device's refusal closes it as refused", async () => {
    await report(d, dId, selfStatus({ build: A }));
    const res = await ada.request("POST", updateUrl(dId));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body!.run as Row).requestedBy).toEqual({ id: adaId, name: "Ada Admin" });
    const again = await owen.request("POST", updateUrl(dId));
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(errorCode(again)).toBe("update_pending");
    expect(await requestedRows(dId)).toHaveLength(1);

    const sentence = "Run as a service to update from the browser; or re-run the install command";
    const refused = await refuseNext(d, dId, sentence);
    expect(refused).toMatchObject({ runtime: "ocw-runtime", error: sentence, requested_by: adaId });
    const finished = (await audits("device.runtime_update_finished", dId)).filter(
      (a) => a.actor_id === adaId,
    );
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      result: "error",
      metadata: { runtime: "ocw-runtime", outcome: "refused", fromBuild: A },
    });
  });

  it("the organization's `off` level never blocks the OCW runtime click, and still blocks Claude Code (07.11)", async () => {
    await setLevel("off");
    try {
      await report(d, dId, selfStatus({ build: A }));
      const ocw = await owen.request("POST", updateUrl(dId));
      expect(ocw.status, JSON.stringify(ocw.body)).toBe(200);
      await refuseNext(d, dId, "updates are off on this device");
      const cli = await owen.request("POST", updateUrl(dId, "claude-code"));
      expect(cli.status, JSON.stringify(cli.body)).toBe(409);
      expect(errorCode(cli)).toBe("runtime_updates_off");
    } finally {
      await setLevel("automatic");
    }
  });
});

/** A clicked OCW runtime update the device accepted and started (its `runId`), as the device reports it. */
async function startedSelfUpdate(dev: FakeDevice, deviceId: string): Promise<{ id: string; runId: string }> {
  const B = (await serveBundle()).build;
  await report(dev, deviceId, selfStatus({ build: A }));
  const res = await owen.request("POST", updateUrl(deviceId));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const cmd = await dev.command("runtime.update");
  dev.ack(cmd.id);
  const runId = randomUUID();
  dev.updateRun({
    runId,
    runtime: "ocw-runtime",
    trigger: "manual",
    commandId: cmd.id,
    phase: "started",
    fromVersion: "0.3.1",
    toVersion: null,
    candidate: "0.3.2",
    method: "ocw_bundle",
    fromBuild: A,
    toBuild: B,
  });
  await report(dev, deviceId, selfStatus({ build: A, state: "waiting" }));
  const row = (await runs(deviceId)).find((r) => r.run_id === runId);
  expect(row).toMatchObject({ state: "started" });
  return { id: row!.id as string, runId };
}

/** Make a run look started 31 minutes ago (past `RUNTIME_UPDATE_RUN_ABANDON_MS`). */
async function age(runId: string): Promise<void> {
  await su.query(
    "update app.device_runtime_updates set started_at = now() - interval '31 minutes' where run_id = $1",
    [runId],
  );
}

/** The system's `finished failed` audits of this device's OCW runtime runs (closed as interrupted). */
const interrupted = async (deviceId: string) =>
  (await audits("device.runtime_update_finished", deviceId)).filter(
    (a) =>
      a.actor_kind === "system" && a.metadata.runtime === "ocw-runtime" && a.metadata.outcome === "failed",
  ).length;

describe("07.17.1-09 Task 3: an update that never reports back reads as failed (PD-14)", () => {
  it("offline past the abandon time: the read closes the row as failed RUN_INTERRUPTED, audited once; a CLI row is untouched; a late finished frame still wins", async () => {
    const srv = await pairDevice(stack, owen, "Owen's build server");
    let dev = await FakeDevice.connect(stack.baseUrl, srv.token, undefined, { host: "service" });
    open.push(dev);
    const { runId } = await startedSelfUpdate(dev, srv.deviceId);
    const cliRun = randomUUID();
    dev.updateRun({ runId: cliRun, phase: "started", fromVersion: "2.1.290", candidate: "2.1.300" });
    await report(dev, srv.deviceId, selfStatus({ build: A, state: "waiting" }));
    await age(runId);
    await age(cliRun);
    await dev.close();
    await eventually(async () => (await deviceRow(srv.deviceId)).status === "offline");

    const read = await owen.request("GET", historyUrl(srv.deviceId, "ocw-runtime"));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body!.runs as Row[]).toHaveLength(1);
    expect((read.body!.runs as Row[])[0]).toMatchObject({
      runtime: "ocw-runtime",
      state: "failed",
      error: RUN_INTERRUPTED,
    });
    expect(await interrupted(srv.deviceId)).toBe(1);
    // 07.11 closes CLI rows only at a snapshot: the read leaves them alone.
    expect((await runs(srv.deviceId)).find((r) => r.run_id === cliRun)).toMatchObject({ state: "started" });
    // A second read writes nothing new.
    expect((await owen.request("GET", historyUrl(srv.deviceId))).status).toBe(200);
    expect(await interrupted(srv.deviceId)).toBe(1);

    // The new daemon's real outcome, replayed from its offline log, still closes the row (07.11 ME-04).
    dev = await FakeDevice.connect(stack.baseUrl, srv.token, undefined, { host: "service" });
    open.push(dev);
    dev.updateRun({
      runId,
      runtime: "ocw-runtime",
      trigger: "manual",
      phase: "finished",
      outcome: "succeeded",
      fromVersion: "0.3.1",
      toVersion: "0.3.2",
      candidate: "0.3.2",
      method: "ocw_bundle",
      fromBuild: A,
      toBuild: served!.build,
    });
    await report(dev, srv.deviceId, selfStatus({ version: "0.3.2", build: served!.build }));
    expect((await runs(srv.deviceId)).find((r) => r.run_id === runId)).toMatchObject({
      state: "succeeded",
      error: null,
      to_version: "0.3.2",
      to_build: served!.build,
    });
  });

  it("online and waiting for sessions to finish keeps the row open (snapshot and read); the stored self at idle closes it on read", async () => {
    const { runId } = await startedSelfUpdate(d, dId);
    await age(runId);
    // A snapshot while the device still waits does not close it either.
    await report(d, dId, selfStatus({ build: A, state: "waiting" }));
    expect((await runs(dId)).find((r) => r.run_id === runId)).toMatchObject({ state: "started" });
    const waiting = await owen.request("GET", historyUrl(dId, "ocw-runtime"));
    expect(waiting.status).toBe(200);
    expect((waiting.body!.runs as Row[]).find((r) => r.state === "started")).toBeDefined();
    expect((await runs(dId)).find((r) => r.run_id === runId)).toMatchObject({ state: "started" });

    // The stored report says idle (no new snapshot): the read closes the run.
    await su.query(
      "update app.devices set runtime_maintenance = jsonb_set(runtime_maintenance, '{self,state}', '\"idle\"') where id = $1",
      [dId],
    );
    const before = await interrupted(dId);
    // Organization B's read of the same id is 404 and closes nothing of organization A.
    const other = await eve.request("GET", historyUrl(dId, "ocw-runtime"));
    expect(other.status, JSON.stringify(other.body)).toBe(404);
    expect((await runs(dId)).find((r) => r.run_id === runId)).toMatchObject({ state: "started" });
    expect(await interrupted(dId)).toBe(before);
    const idle = await owen.request("GET", historyUrl(dId, "ocw-runtime"));
    expect(idle.status).toBe(200);
    expect((await runs(dId)).find((r) => r.run_id === runId)).toMatchObject({
      state: "failed",
      error: RUN_INTERRUPTED,
    });
    expect(await interrupted(dId)).toBe(before + 1);
  });
});

describe("07.17.1-09 Task 3: a prompt held while the device restarts runs after it (PD-27)", () => {
  let wzToken: string;
  let wz: FakeDevice;
  let projectId: string;

  async function promptOf(sessionId: string, promptId: string) {
    const res = await owen.request("GET", `/api/v1/work-sessions/${sessionId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body!.prompts as Array<{ id: string; status: string }>).find((p) => p.id === promptId);
  }

  async function promptStatuses(sessionId: string, promptId: string): Promise<string[]> {
    const res = await su.query(
      "select payload->>'status' as status from app.stream_events where stream_id = $1 and type = 'prompt.updated' and payload->>'id' = $2 order by seq",
      [`ws:${sessionId}`, promptId],
    );
    return res.rows.map((r) => (r as { status: string }).status);
  }

  beforeAll(async () => {
    const paired = await pairDevice(stack, owen, "Owen's work server");
    wzToken = paired.token;
    wz = await FakeDevice.connect(stack.baseUrl, wzToken, undefined, { host: "service" });
    open.push(wz);
    wz.send({
      type: "projects.sync",
      projects: [{ localId: "lp_held", name: "held", gitRemote: null, defaultBranch: "main" }],
    });
    await wz.next((f) => f.type === "projects.ack");
    const projects = (await owen.request("GET", "/api/v1/projects")).body!.projects as Array<{
      id: string;
      name: string;
    }>;
    projectId = projects.find((p) => p.name === "held")!.id;
  });

  it("a dispatched prompt the device never acked is re-queued, its stale command never redelivered, and it runs once after the resume", async () => {
    const sessionId = await startSession(owen, wz, projectId);
    const posted = await owen.request("POST", `/api/v1/work-sessions/${sessionId}/prompts`, {
      body: "held by the restart",
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    // The device gets the prompt and holds it at its gate: no ack, no turn event.
    const held = await wz.command("prompt", sessionId);
    const promptId = held.payload.promptId as string;
    await eventually(async () => (await promptOf(sessionId, promptId))?.status === "dispatched");

    // The update's exit, then the new daemon, which runs no session yet.
    await wz.close();
    wz = await FakeDevice.connect(stack.baseUrl, wzToken, [], { host: "service" });
    open.push(wz);
    const start = await wz.command("session.start", sessionId);
    expect(start.payload).toMatchObject({ resumeRuntimeSessionId: `rt-${sessionId}` });
    // Commands are redelivered in creation order, so a stale prompt would already be here.
    await sleep(200);
    expect(wz.frames.filter((f) => f.type === "command" && f.id === held.id)).toEqual([]);
    expect(wz.pending("prompt")).toEqual([]);
    expect((await promptOf(sessionId, promptId))?.status).toBe("queued");
    const stale = await su.query("select status, error from app.device_commands where id = $1", [held.id]);
    expect(stale.rows[0]).toMatchObject({ status: "failed", error: "superseded: the device restarted" });

    wz.ack(start.id);
    const again = await wz.command("prompt", sessionId);
    expect(again.id).not.toBe(held.id);
    expect(again.payload).toMatchObject({ promptId, text: "held by the restart" });
    wz.ack(again.id);
    wz.emitTurn(sessionId, { promptId, text: "ran after the restart" });
    await eventually(async () => (await promptOf(sessionId, promptId))?.status === "completed");
    await sleep(200);
    expect(wz.pending("prompt")).toEqual([]);
    expect(await promptStatuses(sessionId, promptId)).not.toContain("failed");
  });

  it("a prompt that was running when the device restarted still fails (07.11/07.12 behaviour)", async () => {
    const sessionId = await startSession(owen, wz, projectId);
    await owen.request("POST", `/api/v1/work-sessions/${sessionId}/prompts`, { body: "was running" });
    const cmd = await wz.command("prompt", sessionId);
    const promptId = cmd.payload.promptId as string;
    wz.ack(cmd.id);
    wz.event(sessionId, { type: "prompt.started", promptId });
    await eventually(async () => (await promptOf(sessionId, promptId))?.status === "running");

    await wz.close();
    wz = await FakeDevice.connect(stack.baseUrl, wzToken, [], { host: "service" });
    open.push(wz);
    const start = await wz.command("session.start", sessionId);
    expect(start.payload).toMatchObject({ resumeRuntimeSessionId: `rt-${sessionId}` });
    expect((await promptOf(sessionId, promptId))?.status).toBe("failed");
    wz.ack(start.id);
    await sleep(200);
    expect(wz.pending("prompt")).toEqual([]);
  });
});
