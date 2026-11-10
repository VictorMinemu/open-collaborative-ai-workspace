import {
  type BotWorkZoneProfileInput,
  BotWorkZoneProfileView,
  DeviceBotConsentsView,
  type PermissionMode,
  type RuntimeCatalog,
  type RuntimeModel,
  type SessionAudienceInput,
  UpdateWorkSessionVisibilityResult,
} from "@ocw/contracts";
import { workProjectRepos } from "@ocw/db";
import type pg from "pg";
import { expect } from "vitest";
import { WorkSessionService } from "./modules/work-session";
import { TestClient, type TestStack } from "./testing";
import { eventually, FakeDevice } from "./testing-device";

/**
 * Shared fixtures for the Work Zone controls integration suites (Phase 03.2): runtime catalogs as a device
 * reports them, member invitations, device pairing and a session brought to `idle` through a FakeDevice.
 */

export const model = (id: string, displayName: string, extra: Partial<RuntimeModel> = {}): RuntimeModel => ({
  id,
  displayName,
  description: null,
  legacy: false,
  isDefault: false,
  badge: null,
  efforts: ["low", "medium", "high", "xhigh", "max"].map((value) => ({ value, description: null })),
  defaultEffort: "medium",
  contextWindows: [],
  defaultContextWindow: 1_000_000,
  fastMode: { supported: false, reason: "model_not_allowed" },
  supportsAutoMode: true,
  ...extra,
});

const now = () => new Date().toISOString();

export const CLAUDE_CATALOG: RuntimeCatalog = {
  runtime: "claude-code",
  runtimeVersion: "2.1.289",
  models: [
    model("opus", "Claude Opus 5.5", { isDefault: true, fastMode: { supported: true, reason: null } }),
    model("sonnet", "Claude Sonnet 5.5"),
    model("haiku", "Claude Haiku 4.5", { efforts: [], defaultEffort: null, supportsAutoMode: false }),
  ],
  permissionModes: ["default", "acceptEdits", "plan", "auto", "fullAccess"],
  fastModeCost: "Uses paid usage credits",
  collectedAt: now(),
};

export const CODEX_CATALOG: RuntimeCatalog = {
  runtime: "codex",
  runtimeVersion: "0.160.0",
  models: [
    model("gpt-6.1-sol", "GPT-6.1 Sol", { isDefault: true, fastMode: { supported: true, reason: null } }),
  ],
  permissionModes: ["default", "acceptEdits", "plan", "fullAccess"],
  fastModeCost: "About 2.5x your subscription limits",
  collectedAt: now(),
};

export const errorCode = (res: { body: Record<string, unknown> | null }) =>
  (res.body?.error as { code?: string } | undefined)?.code;

export async function invite(
  stack: TestStack,
  admin: TestClient,
  email: string,
  name: string,
  role: "standard" | "developer" | "lead" | "admin",
): Promise<{ client: TestClient; userId: string }> {
  const inv = await admin.request("POST", "/api/v1/invitations", { email, role });
  expect(inv.status, JSON.stringify(inv.body)).toBe(200);
  const client = new TestClient(stack.baseUrl);
  const res = await client.request("POST", `/api/v1/invitations/${inv.body!.id as string}/accept`, {
    name,
    password: "yet-another-long-password",
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const me = await client.request("GET", "/api/v1/me");
  expect(me.status, JSON.stringify(me.body)).toBe(200);
  const userId = (me.body!.user as { id: string }).id;
  return { client, userId };
}

export async function pairDevice(stack: TestStack, owner: TestClient, name: string) {
  const code = (await owner.request("POST", "/api/v1/devices/enrollments")).body!.code as string;
  const anon = new TestClient(stack.baseUrl);
  const ok = await anon.request("POST", "/api/v1/devices/enroll", { code, name, platform: "darwin" });
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  return { deviceId: ok.body!.deviceId as string, token: ok.body!.deviceToken as string };
}

/** Connect a paired device, announce one project and return its id (as the owner sees it). */
export async function connectWithProject(
  stack: TestStack,
  owner: TestClient,
  token: string,
  project: { localId: string; name: string },
): Promise<{ device: FakeDevice; projectId: string }> {
  const device = await FakeDevice.connect(stack.baseUrl, token);
  device.send({
    type: "projects.sync",
    projects: [{ localId: project.localId, name: project.name, gitRemote: null, defaultBranch: "main" }],
  });
  await device.next((f) => f.type === "projects.ack");
  const projects = (await owner.request("GET", "/api/v1/projects")).body!.projects as Array<{
    id: string;
    name: string;
  }>;
  return { device, projectId: projects.find((p) => p.name === project.name)!.id };
}

/** Create a session through the API and bring it to `idle` through the fake device. */
export async function startSession(
  as: TestClient,
  device: FakeDevice,
  projectId: string,
  body: Record<string, unknown> = {},
): Promise<string> {
  const res = await as.request("POST", "/api/v1/work-sessions", { projectId, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const id = res.body!.id as string;
  const start = await device.command("session.start", id);
  device.ack(start.id);
  device.event(id, {
    type: "session.started",
    runtime: (body.runtime as string | undefined) ?? "claude-code",
    runtimeSessionId: `rt-${id}`,
    model: "claude-opus-5-5",
    permissionMode: (body.permissionMode as string | undefined) ?? "default",
  });
  device.event(id, { type: "session.state", status: "idle" });
  await eventually(async () => {
    const d = await as.request("GET", `/api/v1/work-sessions/${id}`);
    return (d.body?.session as { status?: string } | undefined)?.status === "idle";
  });
  return id;
}

// ---------------------------------------------------------------- explicit session access (07.9-03, P-07)
//
// From 07.9-05 on, a member sees another member's session only through the session's audience (D-06): a fellow
// member of the team project its repo is linked to, or (for a personal repo) someone who may use the device. These
// helpers state that access in a test's setup, so the test is valid under the organization-wide rule and the D-06 one.

/**
 * D-13 (07.9): a project created through the unit routes has its creator as lead. A fixture that builds a tree for
 * other people removes that membership, so the creator stays outside the project as the test intends. Call it right
 * after the project's creation, while the creator is its only member.
 */
export async function dropProjectCreator(creator: TestClient, unitId: string): Promise<void> {
  const res = await creator.request("GET", `/api/v1/units/${unitId}/members`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const members = res.body!.members as Array<{ userId: string }>;
  expect(members, "only the creator is in a new project").toHaveLength(1);
  for (const m of members) {
    const del = await creator.request("DELETE", `/api/v1/units/${unitId}/members/${m.userId}`);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
  }
}

/**
 * D-06 "same team project": the admin creates a department (unless `parentId`) and a project unit under it through the
 * unit routes, then adds the given members. Link the session's repo with `linkRepo` for the access to apply.
 * The roster is exactly `members`: creating the project makes the admin its lead (D-13), so the helper sets the admin
 * to the listed role, or removes them when they are not listed (a test's admin outside the project stays outside).
 */
export async function createTeamProject(
  _stack: TestStack,
  admin: TestClient,
  opts: { name: string; members: Array<{ userId: string; role?: "member" | "lead" }>; parentId?: string },
): Promise<{ unitId: string; parentId: string }> {
  let parentId = opts.parentId;
  if (!parentId) {
    const dept = await admin.request("POST", "/api/v1/units", {
      kind: "department",
      name: `${opts.name} department`,
      parentId: null,
    });
    expect(dept.status, JSON.stringify(dept.body)).toBe(200);
    parentId = dept.body!.id as string;
  }
  const unit = await admin.request("POST", "/api/v1/units", { kind: "project", name: opts.name, parentId });
  expect(unit.status, JSON.stringify(unit.body)).toBe(200);
  const unitId = unit.body!.id as string;
  const auto = await admin.request("GET", `/api/v1/units/${unitId}/members`);
  expect(auto.status, JSON.stringify(auto.body)).toBe(200);
  const creators = new Set((auto.body!.members as Array<{ userId: string }>).map((m) => m.userId));
  for (const creator of creators) {
    const listed = opts.members.find((m) => m.userId === creator);
    const res = listed
      ? await admin.request("PATCH", `/api/v1/units/${unitId}/members/${creator}`, {
          role: listed.role ?? "member",
        })
      : await admin.request("DELETE", `/api/v1/units/${unitId}/members/${creator}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  for (const m of opts.members) {
    if (creators.has(m.userId)) continue;
    const res = await admin.request("POST", `/api/v1/units/${unitId}/members`, {
      userId: m.userId,
      role: m.role ?? "member",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  return { unitId, parentId };
}

/**
 * D-06 "the repo belongs to this team project": one `work_project_repos` row, written in the tenant's system context
 * (`userId: null`, as the Device Link writes) because the link route arrives in 07.9-04; new tests use that route.
 */
export async function linkRepo(
  stack: TestStack,
  opts: { organizationId: string; unitId: string; projectId: string; deviceId: string; linkedBy: string },
): Promise<void> {
  await stack.built.core.db.withTenant({ organizationId: opts.organizationId, userId: null }, async (tx) => {
    await tx.insert(workProjectRepos).values({
      organizationId: opts.organizationId,
      projectId: opts.projectId,
      deviceId: opts.deviceId,
      unitId: opts.unitId,
      linkedBy: opts.linkedBy,
    });
  });
}

/**
 * D-06 "may use the device" (personal repos only): the owner grants `userId` the device through the grant route
 * (ADR-0012). It also changes `device.use` and the person's mode cap, so use it only where the test is about sharing.
 */
export async function shareDevice(
  owner: TestClient,
  deviceId: string,
  userId: string,
  maxMode: PermissionMode = "default",
): Promise<void> {
  const res = await owner.request("PUT", `/api/v1/devices/${deviceId}/grants/user/${userId}`, { maxMode });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

/**
 * D-04 "who can see this session" (07.9-06): `client` sets the session's audience through
 * `PUT /work-sessions/:id/visibility` (the creator, a project lead or an admin) and gets the parsed result.
 */
export async function setAudience(
  client: TestClient,
  sessionId: string,
  input: SessionAudienceInput,
): Promise<UpdateWorkSessionVisibilityResult> {
  const res = await client.request("PUT", `/api/v1/work-sessions/${sessionId}/visibility`, input);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return UpdateWorkSessionVisibilityResult.parse(res.body);
}

/**
 * Waits until the work-session background queue (session deliveries, `removed` notices, re-authorization sweeps) of
 * the organization, or of every organization, has run (Phase 07.9 fan-out): a request now returns right after its
 * commit, before that work.
 */
export async function settled(stack: TestStack, organizationId?: string): Promise<void> {
  const handler = stack.built.deviceHub.sessionHandler;
  if (!(handler instanceof WorkSessionService)) throw new Error("no work-session service");
  await handler.settled(organizationId);
}

// ---------------------------------------------------------------- bot Work Zone profiles (07.16-07)

/**
 * D-01, PD-04: `client` (who manages the bot) saves its Work Zone profile and becomes its sponsor; returns the parsed
 * view. Call the route directly to assert a refusal.
 */
export async function createBotProfile(
  client: TestClient,
  agentId: string,
  input: BotWorkZoneProfileInput,
): Promise<BotWorkZoneProfileView> {
  const res = await client.request("PUT", `/api/v1/agents/${agentId}/work-zone-profile`, input);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return BotWorkZoneProfileView.parse(res.body);
}

/** D-03, PD-06: `client` (the device's owner, or an admin on a service host) lets the bot run sessions on the device. */
export async function grantBotConsent(
  client: TestClient,
  deviceId: string,
  agentId: string,
  opts: { allowFullAccess: boolean },
): Promise<DeviceBotConsentsView> {
  const res = await client.request("PUT", `/api/v1/devices/${deviceId}/bot-consents/${agentId}`, {
    allowFullAccess: opts.allowFullAccess,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return DeviceBotConsentsView.parse(res.body);
}

/**
 * `client` writes `text` in `conversationId` (a DM with the bot, or a channel mention) and gets the event id of the
 * delivered bot turn. Today's usage is cleared first: suites deliver more turns than a personal bot's daily limit (30),
 * which is not what they test (lifted from `proposals.int.test.ts`, which keeps its own copy).
 */
export async function freshBotTurn(
  su: pg.Client,
  client: TestClient,
  conversationId: string,
  text: string,
): Promise<string> {
  await su.query("delete from app.agent_usage_daily");
  const msg = await client.request("POST", `/api/v1/conversations/${conversationId}/messages`, {
    body: text,
  });
  expect(msg.status, JSON.stringify(msg.body)).toBe(200);
  const messageId = msg.body!.id as string;
  const rows = await eventually(async () => {
    const r = (
      await su.query(
        "select payload from app.stream_events where type = 'agent.mention.v1' and payload->'message'->>'id' = $1",
        [messageId],
      )
    ).rows as Array<{ payload: { eventId: string } }>;
    return r.length > 0 ? r : undefined;
  });
  expect(rows).toHaveLength(1);
  return rows[0]!.payload.eventId;
}
