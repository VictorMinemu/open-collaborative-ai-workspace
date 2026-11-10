import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice } from "../../testing-device";
import { CLAUDE_CATALOG, invite, pairDevice, startSession } from "../../testing-workzone";

/**
 * Phase 07.16-05 (D-03, D-19, PD-18, E17): the device facts the bypass-after-outside-content rule reads. The host kind
 * (`desktop` | `service`) and the owner's local isolated-server mark reach `app.devices` (`host_kind`,
 * `isolated_server`) and `GET /api/v1/devices` (`hostKind`, `isolatedServer`) only from the device's own hello and
 * capabilities frames, like the Full access opt-in (ADR-0012). The mark is honoured only for a `service` host: a
 * desktop or unknown host reporting it is stored as `false`. Turning it off on the device runs the device's
 * re-authorization sweep (`device_opt_out`). No user route writes either column. Organization B never sees A's
 * device. Also proves the Wave 0 FakeDevice helpers (`emitTurn`, `emitApproval`) against the real hub.
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let eve: TestClient;
let serverId: string;
let macId: string;
let plainId: string;
let eveDeviceId: string;
let server: FakeDevice;
let mac: FakeDevice;
let plain: FakeDevice;
const fakes: FakeDevice[] = [];

type DeviceDto = { id: string; name: string; hostKind?: string | null; isolatedServer?: boolean };

async function devicesOf(as: TestClient): Promise<{ list: DeviceDto[]; raw: string }> {
  const res = await as.request("GET", "/api/v1/devices");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { list: res.body!.devices as DeviceDto[], raw: JSON.stringify(res.body) };
}

async function seen(as: TestClient, deviceId: string): Promise<DeviceDto> {
  const d = (await devicesOf(as)).list.find((x) => x.id === deviceId);
  expect(d, `device ${deviceId} is listed`).toBeDefined();
  return d!;
}

async function row(deviceId: string): Promise<{ host_kind: string | null; isolated_server: boolean }> {
  const r = await su.query("select host_kind, isolated_server from app.devices where id = $1", [deviceId]);
  return r.rows[0] as { host_kind: string | null; isolated_server: boolean };
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
  admin = new TestClient(stack.baseUrl);
  const setup = await admin.request("POST", "/api/v1/setup", {
    token: TEST_SETUP_TOKEN,
    ...ADMIN,
    orgName: "Autofy Labs",
  });
  expect(setup.status, JSON.stringify(setup.body)).toBe(200);
  ({ client: sam } = await invite(stack, admin, "sam@example.test", "Sam", "developer"));

  // Sam's headless server (a service daemon with the mark on), his Mac (a desktop daemon claiming the mark) and a
  // box whose daemon reports neither (an older daemon).
  const s = await pairDevice(stack, sam, "Build server");
  serverId = s.deviceId;
  server = await FakeDevice.connect(stack.baseUrl, s.token, undefined, {
    host: "service",
    isolatedServer: true,
  });
  const m = await pairDevice(stack, sam, "Sam's Mac");
  macId = m.deviceId;
  mac = await FakeDevice.connect(stack.baseUrl, m.token, undefined, {
    host: "desktop",
    isolatedServer: true,
  });
  const p = await pairDevice(stack, sam, "Old box");
  plainId = p.deviceId;
  plain = await FakeDevice.connect(stack.baseUrl, p.token);
  fakes.push(server, mac, plain);

  // Organization B with its own service device.
  const { client: eveClient, userId: eveId } = await invite(
    stack,
    admin,
    "eve@example.test",
    "Eve",
    "developer",
  );
  eve = eveClient;
  await moveToOrgB(eveId);
  const e = await pairDevice(stack, eve, "Eve's server");
  eveDeviceId = e.deviceId;
  fakes.push(
    await FakeDevice.connect(stack.baseUrl, e.token, undefined, { host: "service", isolatedServer: true }),
  );
}, 240_000);

afterAll(async () => {
  vi.restoreAllMocks();
  for (const d of fakes) await d.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

describe("07.16: the host kind and the isolated-server mark come from the device's hello (D-19, PD-18, E17)", () => {
  it("a service daemon with the mark on is stored and listed as an isolated service", async () => {
    expect(await row(serverId)).toEqual({ host_kind: "service", isolated_server: true });
    for (const viewer of [sam, admin]) {
      const d = await seen(viewer, serverId);
      expect(d.hostKind).toBe("service");
      expect(d.isolatedServer).toBe(true);
    }
  });

  it("a desktop daemon reporting the mark is stored with isolated_server = false (E17)", async () => {
    expect(await row(macId)).toEqual({ host_kind: "desktop", isolated_server: false });
    const d = await seen(sam, macId);
    expect(d.hostKind).toBe("desktop");
    expect(d.isolatedServer).toBe(false);
  });

  it("a daemon that reports neither has an unknown host and no mark", async () => {
    expect(await row(plainId)).toEqual({ host_kind: null, isolated_server: false });
    const d = await seen(sam, plainId);
    expect(d.hostKind).toBeNull();
    expect(d.isolatedServer).toBe(false);
  });
});

describe("07.16: capabilities frames update the mark under the same rule (D-19, PD-18)", () => {
  it("turning the mark off on the service device clears it and runs the device sweep once", async () => {
    const handler = stack.built.deviceHub.sessionHandler!;
    const spy = vi.spyOn(handler, "onAccessChanged");
    const forServer = () => spy.mock.calls.filter(([d]) => d.deviceId === serverId);

    server.capabilities([CLAUDE_CATALOG], false, false);
    await eventually(async () => (await row(serverId)).isolated_server === false);
    await eventually(async () => forServer().length === 1);
    expect(forServer()[0]![1]).toBe("device_opt_out");
    expect((await seen(sam, serverId)).isolatedServer).toBe(false);

    // Back on: stored again, no sweep (access only grows).
    server.capabilities([CLAUDE_CATALOG], false, true);
    await eventually(async () => (await row(serverId)).isolated_server === true);
    expect((await seen(admin, serverId)).isolatedServer).toBe(true);
    // Unchanged true → true: still no sweep.
    server.capabilities([CLAUDE_CATALOG], false, true);
    await eventually(async () => {
      const r = await su.query("select runtime_catalog from app.devices where id = $1", [serverId]);
      return (r.rows[0].runtime_catalog as unknown[]).length === 1;
    });
    expect(forServer()).toHaveLength(1);
    spy.mockRestore();
  });

  it("a capabilities frame claiming the mark on a desktop device leaves it false", async () => {
    mac.capabilities([CLAUDE_CATALOG], false, true);
    await eventually(async () => {
      const r = await su.query("select runtime_catalog from app.devices where id = $1", [macId]);
      return (r.rows[0].runtime_catalog as unknown[]).length === 1;
    });
    expect(await row(macId)).toEqual({ host_kind: "desktop", isolated_server: false });
    expect((await seen(sam, macId)).isolatedServer).toBe(false);
  });
});

describe("07.16: no user route writes the host kind or the mark (P5, T-07.16-05-01)", () => {
  it("PATCH /devices/:id with the two keys, as the owner and as an admin, leaves the row unchanged", async () => {
    // The body schema is not strict: unknown keys are stripped (200, nothing written). An admin is not granted
    // `device.update` on a member's device (403). Either way the row is what the device reported.
    for (const [as, allowed] of [
      [sam, [200, 400]],
      [admin, [200, 400, 403]],
    ] as const) {
      for (const body of [
        { isolatedServer: true },
        { hostKind: "service" },
        { name: "Sam's Mac", isolatedServer: true },
      ]) {
        const res = await as.request("PATCH", `/api/v1/devices/${macId}`, body);
        expect(allowed, JSON.stringify(res.body)).toContain(res.status);
        expect(await row(macId)).toEqual({ host_kind: "desktop", isolated_server: false });
      }
      const res = await as.request("PATCH", `/api/v1/devices/${plainId}`, {
        hostKind: "service",
        isolatedServer: true,
      });
      expect(allowed, JSON.stringify(res.body)).toContain(res.status);
      expect(await row(plainId)).toEqual({ host_kind: null, isolated_server: false });
    }
  });
});

describe("07.16: tenant isolation of the device facts", () => {
  it("organization B lists its own service device only, never organization A's", async () => {
    const { list, raw } = await devicesOf(eve);
    expect(list.map((d) => d.id)).toEqual([eveDeviceId]);
    expect(list[0]!.hostKind).toBe("service");
    expect(list[0]!.isolatedServer).toBe(true);
    expect(raw).not.toContain(serverId);
    expect(raw).not.toContain("Build server");
    expect((await devicesOf(admin)).list.map((d) => d.id)).not.toContain(eveDeviceId);
  });
});

describe("07.16 Wave 0: FakeDevice.emitTurn and emitApproval drive a real session", () => {
  it("a prompt reaches completed and an approval appears in the session detail", async () => {
    plain.send({
      type: "projects.sync",
      projects: [{ localId: "lp_app", name: "app", gitRemote: null, defaultBranch: "main" }],
    });
    await plain.next((f) => f.type === "projects.ack");
    plain.capabilities([CLAUDE_CATALOG], false);
    await eventually(async () => {
      const r = await su.query("select runtime_catalog from app.devices where id = $1", [plainId]);
      return (r.rows[0].runtime_catalog as unknown[]).length === 1;
    });
    const projects = (await sam.request("GET", "/api/v1/projects")).body!.projects as Array<{
      id: string;
      name: string;
    }>;
    const projectId = projects.find((x) => x.name === "app")!.id;
    const id = await startSession(sam, plain, projectId);

    const posted = await sam.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body: "hello" });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const cmd = await plain.command("prompt", id);
    plain.ack(cmd.id);
    plain.emitTurn(id, { promptId: cmd.payload.promptId as string, text: "Done." });
    await eventually(async () => {
      const d = await sam.request("GET", `/api/v1/work-sessions/${id}`);
      const prompts = (d.body?.prompts ?? []) as Array<{ id: string; status: string }>;
      return prompts.find((x) => x.id === cmd.payload.promptId)?.status === "completed";
    });

    const approvalId = randomUUID();
    plain.emitApproval(id, { approvalId, tool: "Edit", paths: ["src/app.ts"] });
    await eventually(async () => {
      const d = await sam.request("GET", `/api/v1/work-sessions/${id}`);
      return ((d.body?.approvals ?? []) as Array<{ id: string }>).some((a) => a.id === approvalId);
    });
  });
});
