import { randomUUID } from "node:crypto";
import {
  BOT_PROFILE_STATUS_SENTENCES,
  type BotWorkZoneProfileInput,
  BotWorkZoneProfileView,
  DeviceBotConsentsView,
} from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice } from "../../testing-device";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  createBotProfile,
  errorCode,
  grantBotConsent,
  invite,
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
}, 180_000);

afterAll(async () => {
  await samDevice?.close().catch(() => {});
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
