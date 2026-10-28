import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { FakeDevice } from "../../testing-device";
import { invite, pairDevice, shareDevice } from "../../testing-workzone";

/**
 * Runtime compatibility on the device DTO (Phase 07.11, D-04, PD-05, RTU-03): `GET /devices` carries the Control
 * Plane manifest's verdict per installed runtime for everyone who already sees the device (the owner, an admin, a
 * grantee and any other member who sees it), since it is derived from versions they all see. A runtime that is not
 * installed has no key; a version the manifest cannot parse is `unknown`. The maintenance details stay out of the DTO
 * (`runtimeMaintenance`, owner and admins only, comes with 07.11-06). Organization B never sees organization A's
 * devices or their compatibility.
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let dana: TestClient;
let olga: TestClient;
let eve: TestClient;
let danaId: string;
let macId: string;
let labId: string;
let eveDeviceId: string;
const devices: FakeDevice[] = [];

type DeviceDto = {
  id: string;
  name: string;
  runtimeCompatibility?: Record<string, string>;
  runtimeMaintenance?: unknown;
};

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
  ({ client: dana, userId: danaId } = await invite(stack, admin, "dana@example.test", "Dana", "developer"));
  ({ client: olga } = await invite(stack, admin, "olga@example.test", "Olga", "developer"));

  // Sam's Mac: Claude Code below the floor, Codex at it.
  const mac = await pairDevice(stack, sam, "Sam's Mac");
  macId = mac.deviceId;
  devices.push(await FakeDevice.connect(stack.baseUrl, mac.token, undefined, { claudeVersion: "2.1.200" }));
  // Sam's lab box: the fake runtime's unparsable version, Codex not installed.
  const lab = await pairDevice(stack, sam, "Lab box");
  labId = lab.deviceId;
  devices.push(
    await FakeDevice.connect(stack.baseUrl, lab.token, undefined, {
      claudeVersion: "fake",
      codexInstalled: false,
    }),
  );

  // Organization B with its own device.
  const { client: eveClient, userId: eveId } = await invite(
    stack,
    admin,
    "eve@example.test",
    "Eve",
    "developer",
  );
  eve = eveClient;
  await moveToOrgB(eveId);
  const eveDevice = await pairDevice(stack, eve, "Eve's box");
  eveDeviceId = eveDevice.deviceId;
  devices.push(await FakeDevice.connect(stack.baseUrl, eveDevice.token));
}, 240_000);

afterAll(async () => {
  for (const d of devices) await d.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

describe("07.11: everyone who sees a device sees whether its runtimes are supported (D-04, PD-05)", () => {
  const MAC = { "claude-code": "unsupported", codex: "supported" };

  it("the owner and an admin read the verdict per installed runtime, without the maintenance details", async () => {
    for (const viewer of [sam, admin]) {
      const d = await seen(viewer, macId);
      expect(d.runtimeCompatibility).toEqual(MAC);
      expect(d).not.toHaveProperty("runtimeMaintenance");
    }
  });

  it("a grantee and a member who only sees the device (no grant) read it too", async () => {
    await shareDevice(sam, macId, danaId);
    for (const viewer of [dana, olga]) {
      const d = await seen(viewer, macId);
      expect(d.runtimeCompatibility).toEqual(MAC);
      expect(d).not.toHaveProperty("runtimeMaintenance");
    }
  });

  it("a rename keeps it: the device the list answers after the PATCH still carries the verdict", async () => {
    const rename = await sam.request("PATCH", `/api/v1/devices/${macId}`, { name: "Sam's MacBook" });
    expect(rename.status, JSON.stringify(rename.body)).toBe(200);
    for (const viewer of [sam, admin, dana, olga]) {
      const d = await seen(viewer, macId);
      expect(d.name).toBe("Sam's MacBook");
      expect(d.runtimeCompatibility).toEqual(MAC);
    }
  });

  it("a runtime that is not installed has no key; a version the manifest cannot parse is unknown", async () => {
    for (const viewer of [sam, admin]) {
      expect((await seen(viewer, labId)).runtimeCompatibility).toEqual({ "claude-code": "unknown" });
    }
  });

  it("organization B lists its own devices only, with none of organization A's ids or verdicts", async () => {
    const { list, raw } = await devicesOf(eve);
    expect(list.map((d) => d.id)).toEqual([eveDeviceId]);
    expect(list[0]!.runtimeCompatibility).toEqual({ "claude-code": "supported", codex: "supported" });
    expect(raw).not.toContain(macId);
    expect(raw).not.toContain(labId);
    expect(raw).not.toContain("Sam's");
    // And organization A never sees B's device.
    expect((await devicesOf(admin)).list.map((d) => d.id)).not.toContain(eveDeviceId);
  });
});
