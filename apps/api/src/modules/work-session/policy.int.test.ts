import { randomUUID } from "node:crypto";
import { DEFAULT_WORK_ZONE_POLICY } from "@ocw/contracts";
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
import { loadWorkZonePolicy } from "./policy";

/**
 * Organization Work Zone policy (Phase 03.2 Plan 04 Task 1, D-02, D-11, P-08): admin-only, audited with the
 * changed keys, and it bites at once on the controls and on every settings request.
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let dana: TestClient;
let device: FakeDevice;
let deviceId: string;
let projectId: string;
let orgId: string;
let sessionId: string;

type Option = { available: boolean; reason: string | null; detail: string | null };
type Controls = {
  models: Array<
    Option & {
      id: string;
      efforts: Array<Option & { value: string }>;
      fastMode: Option & { supported: boolean };
    }
  >;
  permissionModes: Array<Option & { value: string }>;
};

async function controls(id = sessionId): Promise<Controls> {
  const res = await admin.request("GET", `/api/v1/work-sessions/${id}/controls`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as unknown as Controls;
}
const modeOf = (c: Controls, mode: string) => c.permissionModes.find((m) => m.value === mode)!;
const modelOf = (c: Controls, id: string) => c.models.find((m) => m.id === id)!;

async function put(body: Record<string, unknown>, as: TestClient = admin) {
  return as.request("PUT", "/api/v1/work-zone-policy", body);
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
  ({ client: dana } = await invite(stack, admin, "dana@example.test", "Dana", "developer"));
  const paired = await pairDevice(stack, admin, "Víctor's MacBook");
  deviceId = paired.deviceId;
  ({ device, projectId } = await connectWithProject(stack, admin, paired.token, {
    localId: "lp_demo",
    name: "ocw",
  }));
  device.capabilities([CLAUDE_CATALOG, CODEX_CATALOG], false);
  await eventually(async () => {
    const r = await su.query("select runtime_catalog from app.devices where id = $1", [deviceId]);
    return (r.rows[0].runtime_catalog as unknown[]).length === 2;
  });
  sessionId = await startSession(admin, device, projectId, { title: "Policy" });
}, 180_000);

afterAll(async () => {
  await device?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

describe("Work Zone policy (D-02, D-11)", () => {
  it("an admin reads the defaults and the models the org's devices reported", async () => {
    const res = await admin.request("GET", "/api/v1/work-zone-policy");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ ...DEFAULT_WORK_ZONE_POLICY, updatedAt: null });
    expect(res.body!.knownModels).toEqual({
      "claude-code": [
        { id: "opus", displayName: "Claude Opus 5.5" },
        { id: "sonnet", displayName: "Claude Sonnet 5.5" },
        { id: "haiku", displayName: "Claude Haiku 4.5" },
      ],
      codex: [{ id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" }],
    });
  });

  it("a developer can neither read nor change it", async () => {
    expect((await dana.request("GET", "/api/v1/work-zone-policy")).status).toBe(403);
    expect((await put({ allowFastMode: true }, dana)).status).toBe(403);
    const rows = await su.query("select count(*)::int as n from app.work_zone_policies");
    expect(rows.rows[0].n).toBe(0);
  });

  it("narrowing the modes is audited with the changed keys and bites on controls and PATCH", async () => {
    const res = await put({ allowedPermissionModes: ["plan", "default"] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ allowedPermissionModes: ["plan", "default"] });
    expect(res.body!.updatedAt).not.toBeNull();
    const audit = await su.query(
      "select metadata from app.audit_events where action = 'work_zone_policy.updated' order by occurred_at",
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata).toMatchObject({ changed: ["allowedPermissionModes"] });

    // The same body again changes nothing and audits nothing.
    expect((await put({ allowedPermissionModes: ["plan", "default"] })).status).toBe(200);
    const again = await su.query(
      "select count(*)::int as n from app.audit_events where action = 'work_zone_policy.updated'",
    );
    expect(again.rows[0].n).toBe(1);

    const c = await controls();
    expect(modeOf(c, "acceptEdits")).toMatchObject({ available: false, reason: "org_policy" });
    expect(modeOf(c, "auto")).toMatchObject({ available: false, reason: "org_policy" });
    expect(modeOf(c, "default")).toMatchObject({ available: true });

    const patch = await admin.request("PATCH", `/api/v1/work-sessions/${sessionId}/settings`, {
      permissionMode: "acceptEdits",
    });
    expect(patch.status).toBe(403);
    expect(errorCode(patch)).toBe("org_policy");
    const denials = await su.query(
      "select metadata from app.audit_events where action = 'authz.denied' and metadata->>'permission' = 'work_session.configure'",
    );
    expect(denials.rows.at(-1)?.metadata).toMatchObject({ reason: "org_policy", layer: "org" });
    expect(device.pending("session.configure")).toHaveLength(0);
  });

  it("an empty mode list is refused (400)", async () => {
    const res = await put({ allowedPermissionModes: [] });
    expect(res.status).toBe(400);
    const row = await su.query("select allowed_permission_modes from app.work_zone_policies");
    expect(row.rows[0].allowed_permission_modes).toEqual(["plan", "default"]);
  });

  it("a max effort makes higher efforts unavailable and refuses them", async () => {
    const res = await put({ maxEffort: { "claude-code": "medium", codex: null } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const audit = await su.query(
      "select metadata from app.audit_events where action = 'work_zone_policy.updated' order by occurred_at desc limit 1",
    );
    expect(audit.rows[0].metadata).toMatchObject({ changed: ["maxEffort"] });
    const opus = modelOf(await controls(), "opus");
    expect(opus.efforts.find((e) => e.value === "high")).toMatchObject({
      available: false,
      reason: "org_policy",
    });
    expect(opus.efforts.find((e) => e.value === "xhigh")).toMatchObject({ reason: "org_policy" });
    const patch = await admin.request("PATCH", `/api/v1/work-sessions/${sessionId}/settings`, {
      effort: "high",
    });
    expect(patch.status).toBe(403);
    expect(errorCode(patch)).toBe("org_policy");
  });

  it("an allowed-models list makes the other models unavailable", async () => {
    const res = await put({ allowedModels: { "claude-code": ["opus"], codex: [] } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const c = await controls();
    expect(modelOf(c, "opus")).toMatchObject({ available: true });
    expect(modelOf(c, "sonnet")).toMatchObject({ available: false, reason: "org_policy" });
    expect(modelOf(c, "haiku")).toMatchObject({ available: false, reason: "org_policy" });
    const patch = await admin.request("PATCH", `/api/v1/work-sessions/${sessionId}/settings`, {
      model: "sonnet",
    });
    expect([patch.status, errorCode(patch)]).toEqual([403, "org_policy"]);
  });

  it("allowing fast mode offers it only on models whose catalog supports it", async () => {
    let opus = modelOf(await controls(), "opus");
    expect(opus.fastMode).toMatchObject({ available: false, reason: "org_policy" });
    expect((await put({ allowFastMode: true, allowedModels: { "claude-code": [], codex: [] } })).status).toBe(
      200,
    );
    const c = await controls();
    opus = modelOf(c, "opus");
    expect(opus.fastMode).toMatchObject({ available: true, reason: null });
    expect(modelOf(c, "sonnet").fastMode).toMatchObject({
      available: false,
      reason: "runtime",
      detail: "model_not_allowed",
    });
    const patch = await admin.request("PATCH", `/api/v1/work-sessions/${sessionId}/settings`, {
      fastMode: true,
    });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    device.ack((await device.command("session.configure", sessionId)).id);
  });

  it("another organization reads its own defaults and never this org's row", async () => {
    const orgB = randomUUID();
    const userB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
      orgB,
      `other-${orgB}`,
    ]);
    await su.query("insert into auth.user (id, name, email) values ($1, 'Eve', $2)", [
      userB,
      `${userB}@other.test`,
    ]);
    await su.query(
      "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
      [orgB, userB],
    );
    const { db } = stack.built.core;
    const policyB = await db.withTenant({ organizationId: orgB, userId: userB }, (tx) =>
      loadWorkZonePolicy(tx),
    );
    expect(policyB).toEqual({ ...DEFAULT_WORK_ZONE_POLICY, updatedAt: null });
    // Not vacuous: the same call in org A sees its own row.
    const policyA = await db.withTenant({ organizationId: orgId, userId: null }, (tx) =>
      loadWorkZonePolicy(tx),
    );
    expect(policyA.allowFastMode).toBe(true);

    // Org B's own row never leaks into org A's view, and org A's PUT never touches it.
    await su.query(
      "insert into app.work_zone_policies (organization_id, allowed_permission_modes, allow_full_access) values ($1, '{plan}', true)",
      [orgB],
    );
    const mine = await admin.request("GET", "/api/v1/work-zone-policy");
    expect(mine.body).toMatchObject({ allowFullAccess: false, allowedPermissionModes: ["plan", "default"] });
    expect((await put({ allowedPermissionModes: ["plan", "default", "acceptEdits"] })).status).toBe(200);
    const b = await su.query(
      "select allowed_permission_modes, allow_full_access from app.work_zone_policies where organization_id = $1",
      [orgB],
    );
    expect(b.rows[0]).toEqual({ allowed_permission_modes: ["plan"], allow_full_access: true });
  });
});
