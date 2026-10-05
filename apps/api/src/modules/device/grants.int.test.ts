import type { RuntimeCatalog } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, type FakeDevice } from "../../testing-device";
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
    expect(added!.metadata).toMatchObject({ principalKind: "user", principalId: samId, maxMode: "acceptEdits" });

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

describe("authorization coverage", () => {
  it("every grant answer went through the resolver", () => {
    const undecided = stack.built.authz.undecided.filter((u) => /^\/api\/v1\/devices/.test(u.url));
    expect(undecided).toEqual([]);
  });
});
