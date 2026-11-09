import { createHash, randomUUID } from "node:crypto";
import {
  BOT_PROFILE_STATUS_SENTENCES,
  type BotWorkZoneProfileInput,
  BotWorkZoneProfileView,
  DeviceBotConsentsView,
  OUTSIDE_CONTENT_WARNING,
} from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice } from "../../testing-device";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  createBotProfile,
  createTeamProject,
  errorCode,
  grantBotConsent,
  invite,
  linkRepo,
  pairDevice,
} from "../../testing-workzone";
import { createPermissionService } from "../organization";
import { loadBotProfile, profileStatus } from "./bot-profile";

/**
 * Phase 07.16-07 (D-01 … D-04, D-08, D-14 … D-16, D-22; PD-04 … PD-06, PD-21): a bot's Work Zone profile and the
 * per-bot device consent. Who may save (the bot's managers; the saver is the sponsor), what a profile may hold (the
 * sponsor's own live controls), the admin-only outside-content flag, the consent (owner, or an admin on a server), every
 * inactive reason in order, the org cap, and tenant isolation. Real PostgreSQL + Redis.
 */

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let sam: TestClient;
let samId: string;
let orgId: string;
let scoutId: string;
let samDevice: FakeDevice;
let samDeviceId: string;
let billingId: string;
let ledgerId: string;
// A team bot in Sales (07.16-07 Task 2): Lena leads Sales, Mia is a Sales member, Pia is in Ops, Noa owns Atlas.
let victorId: string;
let lena: TestClient;
let lenaId: string;
let mia: TestClient;
let miaId: string;
let pia: TestClient;
let noa: TestClient;
let noaId: string;
let atlasId: string;
// Víctor's build server, shared with every member up to acceptEdits, with the repo `infra`.
let server: FakeDevice;
let serverId: string;
let infraId: string;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

/** Connect a paired device, announce `repos` (by name) and the two catalogs; returns the project ids by name. */
async function connectDevice(
  owner: TestClient,
  token: string,
  deviceId: string,
  repos: string[],
): Promise<{ device: FakeDevice; projectIds: Record<string, string> }> {
  const device = await FakeDevice.connect(stack.baseUrl, token);
  device.send({
    type: "projects.sync",
    projects: repos.map((r) => ({ localId: `lp_${r}`, name: r, gitRemote: null, defaultBranch: "main" })),
  });
  await device.next((f) => f.type === "projects.ack");
  device.capabilities([CLAUDE_CATALOG, CODEX_CATALOG], false);
  await eventually(async () => {
    const r = await su.query("select runtime_catalog from app.devices where id = $1", [deviceId]);
    return (r.rows[0].runtime_catalog as unknown[]).length === 2;
  });
  const list = (await ok(owner.request("GET", "/api/v1/projects"))).projects as Array<{
    id: string;
    name: string;
    deviceId: string;
  }>;
  const projectIds: Record<string, string> = {};
  for (const p of list) if (p.deviceId === deviceId) projectIds[p.name] = p.id;
  return { device, projectIds };
}

/** A valid profile on Sam's MacBook with billing-api; each test overrides what it is about. */
const body = (over: Partial<BotWorkZoneProfileInput> = {}): BotWorkZoneProfileInput => ({
  deviceId: samDeviceId,
  runtime: "claude-code",
  projectIds: [billingId],
  defaultModel: "opus",
  allowedModels: ["sonnet"],
  defaultEffort: "medium",
  allowedEfforts: ["low"],
  defaultContextWindow: null,
  allowedContextWindows: [],
  fastMode: "off",
  defaultMode: "default",
  maxMode: "acceptEdits",
  worktree: true,
  maxConcurrent: 2,
  promptsPerHour: 30,
  wakesPerSessionDay: 20,
  actOnOutsideContent: false,
  ...over,
});

const getProfile = async (as: TestClient, agentId: string) =>
  BotWorkZoneProfileView.parse(await ok(as.request("GET", `/api/v1/agents/${agentId}/work-zone-profile`)));

const audits = async (action: string) =>
  (
    await su.query(
      "select actor_id, agent_id, device_id, resource_type, resource_id, metadata from app.audit_events where action = $1 and organization_id = $2 order by occurred_at",
      [action, orgId],
    )
  ).rows as Json[];

/** `profileStatus` for the bot's stored profile, decided in a system transaction of the organization. */
async function statusOf(agentId: string) {
  const perms = createPermissionService(stack.built.core);
  return stack.built.core.db.withTenant({ organizationId: orgId, userId: null }, async (tx) => {
    const profile = await loadBotProfile(tx, agentId);
    if (!profile) throw new Error("no profile");
    return profileStatus(tx, perms, profile);
  });
}

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_MODEL_PROVIDER: "mock" } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  victor = new TestClient(stack.baseUrl);
  const setup = await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = setup.organization.id;
  ({ client: sam, userId: samId } = await invite(stack, victor, "sam@example.test", "Sam Lee", "developer"));
  scoutId = (await ok(sam.request("POST", "/api/v1/agents/personal", { name: "Scout" }))).agent.id;
  const paired = await pairDevice(stack, sam, "MacBook Pro");
  samDeviceId = paired.deviceId;
  const connected = await connectDevice(sam, paired.token, samDeviceId, ["billing-api", "ledger"]);
  samDevice = connected.device;
  billingId = connected.projectIds["billing-api"]!;
  ledgerId = connected.projectIds.ledger!;

  victorId = setup.user.id;
  ({ client: lena, userId: lenaId } = await invite(stack, victor, "lena@example.test", "Lena Ortiz", "lead"));
  ({ client: mia, userId: miaId } = await invite(stack, victor, "mia@example.test", "Mia Chen", "developer"));
  let piaId: string;
  ({ client: pia, userId: piaId } = await invite(
    stack,
    victor,
    "pia@example.test",
    "Pia Novak",
    "developer",
  ));
  ({ client: noa, userId: noaId } = await invite(stack, victor, "noa@example.test", "Noa Levi", "developer"));
  const unit = async (kind: string, name: string, parentId: string | null) =>
    (await ok(victor.request("POST", "/api/v1/units", { kind, name, parentId }))).id as string;
  const company = await unit("department", "Company", null);
  const sales = await unit("team", "Sales", company);
  const ops = await unit("team", "Ops", company);
  await ok(victor.request("POST", `/api/v1/units/${sales}/members`, { userId: lenaId, role: "lead" }));
  await ok(victor.request("POST", `/api/v1/units/${sales}/members`, { userId: miaId }));
  await ok(victor.request("POST", `/api/v1/units/${ops}/members`, { userId: piaId }));
  atlasId = (
    await ok(
      victor.request("POST", "/api/v1/agents", {
        name: "Atlas",
        instructions: "You help Sales.",
        modelProvider: "mock",
        modelId: "mock-1",
        unitId: sales,
        ownerUserId: noaId,
      }),
    )
  ).id;

  const pairedServer = await pairDevice(stack, victor, "Build server");
  serverId = pairedServer.deviceId;
  const s = await connectDevice(victor, pairedServer.token, serverId, ["infra"]);
  server = s.device;
  infraId = s.projectIds.infra!;
  await ok(
    victor.request("PATCH", `/api/v1/devices/${serverId}`, { shared: true, shareMaxMode: "acceptEdits" }),
  );
}, 180_000);

afterAll(async () => {
  await samDevice?.close().catch(() => {});
  await server?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

describe("tracer: Sam saves Scout's profile, consents on his MacBook and sees it active (D-01 … D-03, D-14)", () => {
  it("GET before any save answers no profile and no status", async () => {
    const view = await getProfile(sam, scoutId);
    expect(view).toEqual({
      profile: null,
      status: { active: false, reason: null, sentence: null },
      viewerCan: { edit: true, setOutsideContent: false },
    });
  });

  it("PUT saves the profile with Sam as its sponsor; it waits for the device owner's consent", async () => {
    const view = await createBotProfile(sam, scoutId, body());
    expect(view.profile).toMatchObject({
      agentId: scoutId,
      sponsor: { id: samId, displayName: "Sam Lee" },
      device: { id: samDeviceId, name: "MacBook Pro", online: true, hostKind: null, isolatedServer: false },
      projects: [{ id: billingId, name: "billing-api" }],
      runtime: "claude-code",
      defaultMode: "default",
      maxMode: "acceptEdits",
      actOnOutsideContent: false,
      actOnOutsideContentBy: null,
    });
    // The defaults are always members of the allowed sets (PD-04).
    expect([...view.profile!.allowedModels].sort()).toEqual(["opus", "sonnet"]);
    expect([...view.profile!.allowedEfforts].sort()).toEqual(["low", "medium"]);
    expect(view.status).toEqual({
      active: false,
      reason: "no_consent",
      sentence: BOT_PROFILE_STATUS_SENTENCES.no_consent,
    });
    expect(view.viewerCan).toEqual({ edit: true, setOutsideContent: false });

    const [saved] = await audits("bot.work_zone_profile_saved");
    expect(saved).toMatchObject({
      actor_id: samId,
      agent_id: scoutId,
      resource_type: "agent",
      resource_id: scoutId,
      metadata: {
        agentId: scoutId,
        deviceId: samDeviceId,
        projectCount: 1,
        runtime: "claude-code",
        maxMode: "acceptEdits",
        sponsorUserId: samId,
      },
    });
    // Ids and counts only: no project name, device name or model id (PD-21).
    const text = JSON.stringify(saved);
    for (const leak of ["billing-api", "MacBook", "opus", "sonnet"]) expect(text).not.toContain(leak);
  });

  it("Sam, the device's owner, consents; the profile is active with the PD-05 layer", async () => {
    const consents = await grantBotConsent(sam, samDeviceId, scoutId, { allowFullAccess: false });
    expect(consents.consents).toEqual([
      expect.objectContaining({
        agentId: scoutId,
        displayName: "Scout",
        allowFullAccess: false,
        grantedBy: { id: samId, displayName: "Sam Lee" },
      }),
    ]);
    expect(consents.requests).toEqual([]);
    expect(consents.viewerCan).toEqual({ grant: true });

    const view = await getProfile(sam, scoutId);
    expect(view.status).toEqual({ active: true, reason: null, sentence: null });

    const [granted] = await audits("device.bot_consent_granted");
    expect(granted).toMatchObject({
      actor_id: samId,
      agent_id: scoutId,
      device_id: samDeviceId,
      metadata: { deviceId: samDeviceId, agentId: scoutId, allowFullAccess: false },
    });
    const text = JSON.stringify(granted);
    for (const leak of ["billing-api", "MacBook"]) expect(text).not.toContain(leak);

    const status = await statusOf(scoutId);
    expect(status.active).toBe(true);
    if (!status.active) throw new Error("inactive");
    expect(status.projectIds).toEqual([billingId]);
    expect(status.layer).toMatchObject({
      agentId: scoutId,
      maxMode: "acceptEdits",
      allowFullAccess: false,
      isolated: false,
      tainted: false,
      fastMode: "off",
    });
    expect([...status.layer.models].sort()).toEqual(["opus", "sonnet"]);
    expect([...status.layer.efforts].sort()).toEqual(["low", "medium"]);
  });

  it("the device's consent list parses and names the bot by its handle", async () => {
    const list = DeviceBotConsentsView.parse(
      await ok(sam.request("GET", `/api/v1/devices/${samDeviceId}/bot-consents`)),
    );
    expect(list.consents.map((c) => c.agentId)).toEqual([scoutId]);
    expect(list.consents[0]!.handle).toMatch(/\S/);
  });

  it("a consent naming an unknown bot is 404 and writes nothing", async () => {
    const res = await sam.request("PUT", `/api/v1/devices/${samDeviceId}/bot-consents/${randomUUID()}`, {
      allowFullAccess: false,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(errorCode(res)).toBe("agent_not_found");
  });
});

// ---------------------------------------------------------------- Task 2: rights, validation, the flag, delete

const put = (as: TestClient, agentId: string, b: unknown) =>
  as.request("PUT", `/api/v1/agents/${agentId}/work-zone-profile`, b);

/** The refusal's status, code and field (`details.field` of `invalid_work_zone_profile`). */
const refusal = (res: { status: number; body: Record<string, unknown> | null }) => ({
  status: res.status,
  code: errorCode(res),
  field: ((res.body?.error as Json | undefined)?.details as Json | undefined)?.field,
});

/** Atlas's profile on the build server (shared up to acceptEdits): every manager can save it. */
const serverBody = (over: Partial<BotWorkZoneProfileInput> = {}) =>
  body({ deviceId: serverId, projectIds: [infraId], ...over });

const putPolicy = (b: Json) => ok(victor.request("PUT", "/api/v1/work-zone-policy", b));

/** A client whose membership moved to a fresh organization B, with B's own device and project (superuser). */
async function organizationB() {
  const email = `eve-${randomUUID().slice(0, 8)}@example.test`;
  const { client, userId } = await invite(stack, victor, email, "Eve", "admin");
  const org = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    org,
    `evil-${org}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [userId]);
  await su.query("delete from app.org_members where user_id = $1", [userId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    org,
    userId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [org, userId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [org, userId]);
  const devB = randomUUID();
  const projB = randomUUID();
  await su.query(
    `insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash, shared, status)
     values ($1, $2, $3, 'B mac', 'darwin', $4, true, 'online')`,
    [devB, org, userId, createHash("sha256").update(randomUUID()).digest("hex")],
  );
  await su.query(
    "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, 'lb', 'secret')",
    [projB, org, devB],
  );
  return { client, orgB: org, devB, projB };
}

let orgB: Awaited<ReturnType<typeof organizationB>>;

describe("who may save a bot's profile (D-01, PD-04)", () => {
  it("another member's PUT on Sam's personal bot is hidden (404) and writes nothing", async () => {
    const res = await put(mia, scoutId, body());
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    const rows = await su.query(
      "select sponsor_user_id from app.bot_work_zone_profiles where agent_id = $1",
      [scoutId],
    );
    expect(rows.rows).toEqual([{ sponsor_user_id: samId }]);
  });

  it("an admin's PUT on someone's personal bot answers as the bot's other configure routes do (404)", async () => {
    const capabilities = await victor.request("GET", `/api/v1/agents/${scoutId}/capabilities`);
    const res = await put(victor, scoutId, body());
    expect(res.status).toBe(capabilities.status);
    expect(res.status).toBe(404);
  });

  it("a team bot: an admin, its unit's lead and its owner save it, each becoming the sponsor", async () => {
    for (const [client, id] of [
      [victor, victorId],
      [lena, lenaId],
      [noa, noaId],
    ] as const) {
      const view = await createBotProfile(client, atlasId, serverBody());
      expect(view.profile!.sponsor.id).toBe(id);
    }
  });

  it("a member of the bot's unit is refused (403); someone outside it is refused as bot.read decides", async () => {
    const res = await put(mia, atlasId, serverBody());
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    const outsider = await put(pia, atlasId, serverBody());
    const capabilities = await pia.request("GET", `/api/v1/agents/${atlasId}/capabilities`);
    expect(outsider.status).toBe(capabilities.status);
    expect([403, 404]).toContain(outsider.status);
    const rows = await su.query(
      "select sponsor_user_id from app.bot_work_zone_profiles where agent_id = $1",
      [atlasId],
    );
    expect(rows.rows).toEqual([{ sponsor_user_id: noaId }]);
  });

  it("the body cannot name a sponsor", async () => {
    const res = await put(sam, scoutId, { ...body(), sponsorUserId: victorId });
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("validation_error");
  });
});

describe("what a profile may hold: the sponsor's own live controls (PD-04)", () => {
  it("a device the sponsor may not use", async () => {
    const other = await pairDevice(stack, victor, "Víctor's iMac");
    expect(refusal(await put(sam, scoutId, body({ deviceId: other.deviceId })))).toEqual({
      status: 400,
      code: "invalid_work_zone_profile",
      field: "deviceId",
    });
  });

  it("a revoked device", async () => {
    const old = await pairDevice(stack, sam, "Old laptop");
    await su.query("update app.devices set revoked_at = now() where id = $1", [old.deviceId]);
    expect(refusal(await put(sam, scoutId, body({ deviceId: old.deviceId })))).toEqual({
      status: 400,
      code: "invalid_work_zone_profile",
      field: "deviceId",
    });
  });

  it("a project on another device", async () => {
    expect(refusal(await put(sam, scoutId, body({ projectIds: [billingId, infraId] })))).toEqual({
      status: 400,
      code: "invalid_work_zone_profile",
      field: "projectIds",
    });
  });

  it("a repository of a team project the sponsor is not in", async () => {
    const { unitId } = await createTeamProject(stack, victor, {
      name: "Payments",
      members: [{ userId: miaId }],
    });
    await linkRepo(stack, {
      organizationId: orgId,
      unitId,
      projectId: ledgerId,
      deviceId: samDeviceId,
      linkedBy: victorId,
    });
    expect(refusal(await put(sam, scoutId, body({ projectIds: [ledgerId] })))).toEqual({
      status: 400,
      code: "invalid_work_zone_profile",
      field: "projectIds",
    });
  });

  it("an allowed model the device did not report, or one the organization's policy refuses", async () => {
    expect(refusal(await put(sam, scoutId, body({ allowedModels: ["gpt-6.1-sol"] })))).toEqual({
      status: 400,
      code: "invalid_work_zone_profile",
      field: "allowedModels",
    });
    await putPolicy({ allowedModels: { "claude-code": ["opus"], codex: [] } });
    try {
      expect(refusal(await put(sam, scoutId, body({ allowedModels: ["sonnet"] })))).toEqual({
        status: 400,
        code: "invalid_work_zone_profile",
        field: "allowedModels",
      });
    } finally {
      await putPolicy({ allowedModels: { "claude-code": [], codex: [] } });
    }
  });

  it("an effort above the organization's maximum", async () => {
    await putPolicy({ maxEffort: { "claude-code": "medium", codex: null } });
    try {
      expect(refusal(await put(sam, scoutId, body({ allowedEfforts: ["high"] })))).toEqual({
        status: 400,
        code: "invalid_work_zone_profile",
        field: "allowedEfforts",
      });
    } finally {
      await putPolicy({ maxEffort: { "claude-code": null, codex: null } });
    }
  });

  it("a default mode above the highest mode, and Full access without the organization's policy", async () => {
    expect(
      refusal(await put(sam, scoutId, body({ defaultMode: "fullAccess", maxMode: "acceptEdits" }))),
    ).toEqual({ status: 400, code: "invalid_work_zone_profile", field: "defaultMode" });
    expect(refusal(await put(sam, scoutId, body({ maxMode: "fullAccess" })))).toEqual({
      status: 400,
      code: "invalid_work_zone_profile",
      field: "maxMode",
    });
  });

  it("a default model the catalog does not list, and fast mode the policy keeps off", async () => {
    expect(refusal(await put(sam, scoutId, body({ defaultModel: "claude-ultra" })))).toEqual({
      status: 400,
      code: "invalid_work_zone_profile",
      field: "defaultModel",
    });
    expect(refusal(await put(sam, scoutId, body({ fastMode: "allowed" })))).toEqual({
      status: 400,
      code: "invalid_work_zone_profile",
      field: "fastMode",
    });
  });

  it("no refusal changed the stored profile", async () => {
    const view = await getProfile(sam, scoutId);
    expect(view.profile).toMatchObject({
      deviceId: samDeviceId,
      maxMode: "acceptEdits",
      defaultModel: "opus",
    });
    expect(view.profile!.projects.map((p) => p.id)).toEqual([billingId]);
  });
});

describe("act on outside content: admins only (D-08, PD-04)", () => {
  it("Lena (a lead) cannot turn it on", async () => {
    await createBotProfile(lena, atlasId, serverBody());
    const res = await put(lena, atlasId, serverBody({ actOnOutsideContent: true }));
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(errorCode(res)).toBe("outside_content_admin_only");
  });

  it("an admin turns it on for Lena's profile without becoming its sponsor", async () => {
    const view = await createBotProfile(victor, atlasId, serverBody({ actOnOutsideContent: true }));
    expect(view.profile).toMatchObject({
      actOnOutsideContent: true,
      actOnOutsideContentBy: { id: victorId, displayName: "Víctor Ruiz" },
      sponsor: { id: lenaId },
    });
    expect(view.profile!.actOnOutsideContentAt).not.toBeNull();
    expect(view.viewerCan).toEqual({ edit: true, setOutsideContent: true });
    expect(OUTSIDE_CONTENT_WARNING).toContain("Full access still needs an isolated server.");
    const changes = await audits("bot.work_zone_profile_outside_content_changed");
    expect(changes.at(-1)).toMatchObject({
      actor_id: victorId,
      agent_id: atlasId,
      metadata: { agentId: atlasId, value: true, sponsorUserId: lenaId, reason: "set" },
    });
  });

  it("Lena, the sponsor, re-saves with it on: it stays on", async () => {
    const view = await createBotProfile(lena, atlasId, serverBody({ actOnOutsideContent: true }));
    expect(view.profile).toMatchObject({ actOnOutsideContent: true, sponsor: { id: lenaId } });
  });

  it("a manager who is not the sponsor cannot turn it off, and re-saving resets it to off", async () => {
    const off = await put(noa, atlasId, serverBody({ actOnOutsideContent: false }));
    expect(off.status).toBe(403);
    expect(errorCode(off)).toBe("outside_content_admin_only");

    const view = await createBotProfile(noa, atlasId, serverBody({ actOnOutsideContent: true }));
    expect(view.profile).toMatchObject({
      actOnOutsideContent: false,
      actOnOutsideContentBy: null,
      sponsor: { id: noaId },
    });
    const changes = await audits("bot.work_zone_profile_outside_content_changed");
    expect(changes.at(-1)).toMatchObject({
      actor_id: noaId,
      metadata: { agentId: atlasId, value: false, sponsorUserId: noaId, reason: "sponsor_changed" },
    });
  });
});

describe("delete (PD-21)", () => {
  it("a manager deletes the profile and its projects; it is audited and GET shows none", async () => {
    const res = await ok(lena.request("DELETE", `/api/v1/agents/${atlasId}/work-zone-profile`));
    expect(res.profile).toBeNull();
    const left = await su.query(
      `select (select count(*)::int from app.bot_work_zone_profiles where agent_id = $1) as profiles,
              (select count(*)::int from app.bot_work_zone_profile_projects pp
                 join app.bot_work_zone_profiles p on p.id = pp.profile_id where p.agent_id = $1) as projects`,
      [atlasId],
    );
    expect(left.rows[0]).toEqual({ profiles: 0, projects: 0 });
    const [deleted] = await audits("bot.work_zone_profile_deleted");
    expect(deleted).toMatchObject({
      actor_id: lenaId,
      agent_id: atlasId,
      metadata: { agentId: atlasId, deviceId: serverId, sponsorUserId: noaId },
    });
    expect((await getProfile(lena, atlasId)).profile).toBeNull();
    const again = await lena.request("DELETE", `/api/v1/agents/${atlasId}/work-zone-profile`);
    expect(again.status).toBe(404);
    expect(errorCode(again)).toBe("work_zone_profile_not_found");
  });
});

describe("tenant isolation (organization B, BWZ-05)", () => {
  beforeAll(async () => {
    orgB = await organizationB();
  });

  it("organization B's admin cannot read, save or delete organization A's profiles (404)", async () => {
    expect((await orgB.client.request("GET", `/api/v1/agents/${scoutId}/work-zone-profile`)).status).toBe(
      404,
    );
    expect((await put(orgB.client, scoutId, body())).status).toBe(404);
    expect((await orgB.client.request("DELETE", `/api/v1/agents/${scoutId}/work-zone-profile`)).status).toBe(
      404,
    );
    const rows = await su.query(
      "select sponsor_user_id from app.bot_work_zone_profiles where agent_id = $1",
      [scoutId],
    );
    expect(rows.rows).toEqual([{ sponsor_user_id: samId }]);
  });

  it("an organization-A save naming organization B's device or project is refused (400)", async () => {
    expect(refusal(await put(sam, scoutId, body({ deviceId: orgB.devB })))).toEqual({
      status: 400,
      code: "invalid_work_zone_profile",
      field: "deviceId",
    });
    expect(refusal(await put(sam, scoutId, body({ projectIds: [orgB.projB] })))).toEqual({
      status: 400,
      code: "invalid_work_zone_profile",
      field: "projectIds",
    });
  });
});
