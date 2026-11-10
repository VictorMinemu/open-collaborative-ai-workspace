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
import { knownModels, loadWorkZonePolicy } from "./policy";

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
    // 07.16 (D-15): the org cap on bot sessions is a new optional field; absent row = 10.
    expect(policyB).toEqual({ ...DEFAULT_WORK_ZONE_POLICY, botSessionsMax: 10, updatedAt: null });
    // Org A's device catalogs never show up in org B's known models.
    expect(await db.withTenant({ organizationId: orgB, userId: userB }, (tx) => knownModels(tx))).toEqual({
      "claude-code": [],
      codex: [],
    });
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

describe("07.11: runtime updates level (D-02)", () => {
  async function newOrg(name: string): Promise<{ org: string; user: string }> {
    const org = randomUUID();
    const user = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, $2, $3)", [
      org,
      name,
      `${name.toLowerCase()}-${org}`,
    ]);
    await su.query("insert into auth.user (id, name, email) values ($1, $2, $3)", [
      user,
      name,
      `${user}@${name.toLowerCase()}.test`,
    ]);
    await su.query(
      "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, $3, 'admin')",
      [org, user, name],
    );
    return { org, user };
  }
  const levelAudits = async () =>
    (
      await su.query(
        "select metadata from app.audit_events where action = 'work_zone_policy.updated' and metadata->'changed' @> '[\"runtimeUpdates\"]'::jsonb order by occurred_at",
      )
    ).rows;

  it("an organization with no policy row reads automatic (the D-02 default)", async () => {
    expect(DEFAULT_WORK_ZONE_POLICY.runtimeUpdates).toBe("automatic");
    const { org, user } = await newOrg("Fresh");
    const policy = await stack.built.core.db.withTenant({ organizationId: org, userId: user }, (tx) =>
      loadWorkZonePolicy(tx),
    );
    expect(policy.runtimeUpdates).toBe("automatic");
    expect(policy.updatedAt).toBeNull();
  });

  it("an admin switches it to notify: answered, read back and audited once with the changed key", async () => {
    const before = await admin.request("GET", "/api/v1/work-zone-policy");
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body).toMatchObject({ runtimeUpdates: "automatic" });

    const res = await put({ runtimeUpdates: "notify" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ runtimeUpdates: "notify" });
    const read = await admin.request("GET", "/api/v1/work-zone-policy");
    expect(read.body).toMatchObject({ runtimeUpdates: "notify" });
    const row = await su.query(
      "select runtime_updates from app.work_zone_policies where organization_id = $1",
      [orgId],
    );
    expect(row.rows[0].runtime_updates).toBe("notify");

    const audits = await levelAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata.changed).toEqual(["runtimeUpdates"]);

    // The same body again changes nothing and audits nothing.
    expect((await put({ runtimeUpdates: "notify" })).status).toBe(200);
    expect(await levelAudits()).toHaveLength(1);
  });

  it("an unknown level is refused by the schema and nothing is written", async () => {
    const res = await put({ runtimeUpdates: "sometimes" });
    expect(res.status).toBe(400);
    const row = await su.query(
      "select runtime_updates from app.work_zone_policies where organization_id = $1",
      [orgId],
    );
    expect(row.rows[0].runtime_updates).toBe("notify");
  });

  it("a developer can neither read nor change it", async () => {
    expect((await dana.request("GET", "/api/v1/work-zone-policy")).status).toBe(403);
    expect((await put({ runtimeUpdates: "off" }, dana)).status).toBe(403);
    const row = await su.query(
      "select runtime_updates from app.work_zone_policies where organization_id = $1",
      [orgId],
    );
    expect(row.rows[0].runtime_updates).toBe("notify");
    expect(await levelAudits()).toHaveLength(1);
  });

  it("another organization still reads automatic, with or without its own row", async () => {
    const { org, user } = await newOrg("Beta");
    const { db } = stack.built.core;
    const read = () => db.withTenant({ organizationId: org, userId: user }, (tx) => loadWorkZonePolicy(tx));
    expect((await read()).runtimeUpdates).toBe("automatic");
    await su.query(
      "insert into app.work_zone_policies (organization_id, allow_fast_mode) values ($1, true)",
      [org],
    );
    expect(await read()).toMatchObject({ runtimeUpdates: "automatic", allowFastMode: true });
    // Not vacuous: org A reads its own notify.
    const a = await db.withTenant({ organizationId: orgId, userId: null }, (tx) => loadWorkZonePolicy(tx));
    expect(a.runtimeUpdates).toBe("notify");
  });

  it("a stored level that no longer parses reads back as automatic (tolerant read)", async () => {
    const { org, user } = await newOrg("Legacy");
    await su.query("insert into app.work_zone_policies (organization_id) values ($1)", [org]);
    // Only a superuser with the check constraint dropped can store an unknown level; restored right after.
    await su.query(
      "alter table app.work_zone_policies drop constraint work_zone_policies_runtime_updates_ck",
    );
    try {
      await su.query(
        "update app.work_zone_policies set runtime_updates = 'sometimes' where organization_id = $1",
        [org],
      );
      const policy = await stack.built.core.db.withTenant({ organizationId: org, userId: user }, (tx) =>
        loadWorkZonePolicy(tx),
      );
      expect(policy.runtimeUpdates).toBe("automatic");
    } finally {
      await su.query(
        "update app.work_zone_policies set runtime_updates = 'automatic' where organization_id = $1",
        [org],
      );
      await su.query(
        "alter table app.work_zone_policies add constraint work_zone_policies_runtime_updates_ck check (runtime_updates in ('automatic','notify','off'))",
      );
    }
  });
});

describe("07.16: the organization's cap on bot Work Zone sessions (D-15, PD-22)", () => {
  const capAudits = async () =>
    (
      await su.query(
        "select metadata from app.audit_events where action = 'work_zone_policy.updated' and metadata->'changed' @> '[\"botSessionsMax\"]'::jsonb order by occurred_at",
      )
    ).rows;

  it("an organization with no policy row reads 10", async () => {
    const org = randomUUID();
    const user = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Gamma', $2)", [
      org,
      `gamma-${org}`,
    ]);
    await su.query("insert into auth.user (id, name, email) values ($1, 'Gamma', $2)", [
      user,
      `${user}@gamma.test`,
    ]);
    await su.query(
      "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Gamma', 'admin')",
      [org, user],
    );
    const policy = await stack.built.core.db.withTenant({ organizationId: org, userId: user }, (tx) =>
      loadWorkZonePolicy(tx),
    );
    expect(policy.botSessionsMax).toBe(10);
  });

  it("an admin reads it and saves 0..1000, audited with the changed key", async () => {
    const res = await admin.request("GET", "/api/v1/work-zone-policy");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body!.botSessionsMax).toBe(10);

    const saved = await put({ botSessionsMax: 3 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body!.botSessionsMax).toBe(3);
    expect((await admin.request("GET", "/api/v1/work-zone-policy")).body!.botSessionsMax).toBe(3);
    const row = await su.query(
      "select bot_sessions_max from app.work_zone_policies where organization_id = $1",
      [orgId],
    );
    expect(row.rows[0].bot_sessions_max).toBe(3);
    expect((await capAudits()).at(-1)).toEqual({ metadata: { changed: ["botSessionsMax"] } });

    // 0 = bots never start sessions (the admin's switch).
    expect((await put({ botSessionsMax: 0 })).body!.botSessionsMax).toBe(0);
  });

  it("1001 is refused (400) and a non-admin cannot change it (403)", async () => {
    expect((await put({ botSessionsMax: 1001 })).status).toBe(400);
    expect((await put({ botSessionsMax: 5 }, dana)).status).toBe(403);
    const row = await su.query(
      "select bot_sessions_max from app.work_zone_policies where organization_id = $1",
      [orgId],
    );
    expect(row.rows[0].bot_sessions_max).toBe(0);
    expect((await put({ botSessionsMax: 10 })).body!.botSessionsMax).toBe(10);
  });
});
