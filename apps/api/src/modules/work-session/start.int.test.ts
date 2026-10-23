import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, type FakeDevice } from "../../testing-device";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  connectWithProject,
  createTeamProject,
  invite,
  linkRepo,
  pairDevice,
  shareDevice,
} from "../../testing-workzone";
import { createPermissionService } from "../organization";
import { createWorkSessionModule } from "./index";
import type { WorkSessionService } from "./service";
import {
  createWorkSession,
  type WorkSessionStartDeps,
  type WorkSessionStartFailure,
  type WorkSessionStartInput,
  type WorkSessionStartResult,
} from "./start";

/**
 * Phase 07.5-05 (D-03, D-04, APPROVE-03, APPROVE-04): one way to start a Work Zone session. `createWorkSession` runs
 * the checks of `POST /work-sessions` for a given member without a request, so a person's Start on a bot's proposal
 * creates the session in that person's name; the first prompt is marked as proposed by the bot.
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let samId: string;
let orgId: string;
let device: FakeDevice;
let deviceId: string;
let projectId: string;
let botId: string;
let deps: WorkSessionStartDeps;

const proposal = (over: Partial<WorkSessionStartInput> = {}): WorkSessionStartInput => ({
  projectId,
  deviceId,
  runtime: "claude-code",
  prompt: "Fix the rounding error",
  ...over,
});

/** Start as `userId` in their own tenant transaction (what a decision route does for its decider). */
function startAs(
  userId: string,
  input: WorkSessionStartInput,
  opts?: { proposedByAgentId?: string; approvalId?: string },
): Promise<WorkSessionStartResult> {
  return stack.built.core.db.withTenant({ organizationId: orgId, userId }, (tx) =>
    createWorkSession(tx, deps, { userId, organizationId: orgId, clientKind: null }, input, opts),
  );
}

async function auditOf(action: string, sessionId: string) {
  return (
    await su.query(
      "select user_id, actor_id, metadata from app.audit_events where action = $1 and session_id = $2 order by occurred_at",
      [action, sessionId],
    )
  ).rows as Array<{ user_id: string; actor_id: string; metadata: Record<string, unknown> }>;
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
  ({ client: sam, userId: samId } = await invite(stack, admin, "sam@example.test", "Sam", "developer"));
  const paired = await pairDevice(stack, sam, "Sam's MacBook");
  deviceId = paired.deviceId;
  ({ device, projectId } = await connectWithProject(stack, sam, paired.token, {
    localId: "lp_billing",
    name: "billing-api",
  }));
  device.capabilities([CLAUDE_CATALOG, CODEX_CATALOG], false);
  await eventually(async () => {
    const r = await su.query("select runtime_catalog from app.devices where id = $1", [deviceId]);
    return (r.rows[0].runtime_catalog as unknown[]).length === 2;
  });
  // Sam's personal bot (the proposer). Seeded directly: no OpenClaw cell is involved in starting a session.
  botId = randomUUID();
  await su.query(
    `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status, scope, owner_user_id)
     values ($1, $2, 'Sam''s helper', 'sams-helper', '', 'mock', 'mock', 'ready', 'personal', $3)`,
    [botId, orgId, samId],
  );
  const { core, deviceHub } = stack.built;
  // The hub's session handler IS the module's WorkSessionService (the one the routes use).
  deps = {
    core,
    perms: createPermissionService(core),
    svc: deviceHub.sessionHandler as WorkSessionService,
    hub: deviceHub,
  };
}, 180_000);

afterAll(async () => {
  await device?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

describe("tracer: a session is created by a function for a given member (APPROVE-03)", () => {
  it("createWorkSession starts Sam's session with the first prompt proposed by his bot", async () => {
    const approvalId = randomUUID();
    const res = await startAs(samId, proposal(), { proposedByAgentId: botId, approvalId });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    const id = res.session.id;
    expect(res.session).toMatchObject({ createdBy: samId, permissionMode: "default", projectId, deviceId });

    // One session.start command for the device, in default mode.
    const start = await device.command("session.start", id);
    expect(start.payload).toMatchObject({ projectLocalId: "lp_billing", runtime: "claude-code" });
    expect(start.payload.permissionMode).toBe("default");
    device.ack(start.id);
    const commands = await su.query(
      "select count(*)::int as n from app.device_commands where work_session_id = $1 and kind = 'session.start'",
      [id],
    );
    expect(commands.rows[0].n).toBe(1);

    // One prompt, authored by Sam, proposed by the bot.
    const prompts = await su.query(
      "select author_user_id, proposed_by_agent_id, body from app.work_prompts where work_session_id = $1",
      [id],
    );
    expect(prompts.rows).toEqual([
      { author_user_id: samId, proposed_by_agent_id: botId, body: "Fix the rounding error" },
    ]);

    // Audit: created (attributed to Sam, naming the bot and the approval) and queued as today.
    const [created] = await auditOf("work_session.created", id);
    expect(created).toMatchObject({ user_id: samId, actor_id: samId });
    expect(created!.metadata).toMatchObject({
      projectId,
      runtime: "claude-code",
      permissionMode: "default",
      worktree: false,
      proposedByAgentId: botId,
      approvalId,
    });
    const queued = await auditOf("work_prompt.queued", id);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.metadata).toMatchObject({ authorUserId: samId, workSessionId: id, length: 22 });
    // Audit never carries the prompt.
    expect(JSON.stringify(queued[0]!.metadata)).not.toContain("rounding");

    // Sam is the owner-member of the session conversation.
    const members = await su.query(
      `select m.member_kind, m.member_id, m.role from app.conversation_members m
       join app.work_sessions s on s.conversation_id = m.conversation_id where s.id = $1`,
      [id],
    );
    expect(members.rows).toEqual([{ member_kind: "user", member_id: samId, role: "owner" }]);

    // Sam reads it through the API like any session he started.
    const detail = await sam.request("GET", `/api/v1/work-sessions/${id}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
  });

  it("the module object exposes `start` with its deps bound", async () => {
    const hub = stack.built.deviceHub;
    const previous = hub.sessionHandler;
    const mod = createWorkSessionModule(stack.built.core, hub);
    // Creating a second module instance re-points the hub's handler; put the app's own back.
    if (previous) hub.setSessionHandler(previous);
    expect(typeof mod.start).toBe("function");
    const res = await stack.built.core.db.withTenant({ organizationId: orgId, userId: samId }, (tx) =>
      mod.start(tx, { userId: samId, organizationId: orgId, clientKind: null }, proposal(), {
        proposedByAgentId: botId,
      }),
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.session).toMatchObject({ createdBy: samId, permissionMode: "default" });
    device.ack((await device.command("session.start", res.session.id)).id);
    const p = await su.query("select proposed_by_agent_id from app.work_prompts where work_session_id = $1", [
      res.session.id,
    ]);
    expect(p.rows).toEqual([{ proposed_by_agent_id: botId }]);
  });

  it("POST /work-sessions still creates the human's session with no proposer", async () => {
    const res = await sam.request("POST", "/api/v1/work-sessions", { projectId, prompt: "Typed by Sam" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const id = res.body!.id as string;
    device.ack((await device.command("session.start", id)).id);
    const p = await su.query("select proposed_by_agent_id from app.work_prompts where work_session_id = $1", [
      id,
    ]);
    expect(p.rows).toEqual([{ proposed_by_agent_id: null }]);
    const [created] = await auditOf("work_session.created", id);
    expect(created!.metadata).toEqual({
      projectId,
      runtime: "claude-code",
      permissionMode: "default",
      worktree: false,
      // 07.9-06: the audience kind it started with (a personal repository: `project`).
      visibility: "project",
    });
  });
});

// ---------------------------------------------------------------- Task 2: result codes, no partial writes

const TRACE_TABLES = [
  "work_sessions",
  "conversations",
  "conversation_members",
  "work_prompts",
  "device_commands",
  "audit_events",
  "stream_events",
  "work_session_grants",
] as const;

async function traces(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TRACE_TABLES) {
    out[t] = (await su.query(`select count(*)::int as n from app.${t}`)).rows[0].n as number;
  }
  return out;
}

/** The call fails with `code` and leaves no row, command, audit or event behind. */
async function refusedWith(userId: string, input: WorkSessionStartInput, code: string) {
  const before = await traces();
  const res = await startAs(userId, input, { proposedByAgentId: botId, approvalId: randomUUID() });
  expect(res, JSON.stringify(res)).toMatchObject({ ok: false, code });
  expect(await traces()).toEqual(before);
  return res as WorkSessionStartFailure;
}

/** A device of Sam's seeded directly, with one project on it. */
async function seedDevice(o: {
  name: string;
  status: "online" | "offline";
  runtimeInfo: unknown[];
  revoked?: boolean;
}): Promise<{ deviceId: string; projectId: string }> {
  const id = randomUUID();
  const project = randomUUID();
  await su.query(
    `insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash, status, runtime_info, revoked_at)
     values ($1, $2, $3, $4, 'darwin', $5, $6, $7, ${o.revoked ? "now()" : "null"})`,
    [
      id,
      orgId,
      samId,
      o.name,
      createHash("sha256").update(randomUUID()).digest("hex"),
      o.status,
      JSON.stringify(o.runtimeInfo),
    ],
  );
  await su.query(
    "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, $4, 'seeded')",
    [project, orgId, id, `lp_${project.slice(0, 8)}`],
  );
  return { deviceId: id, projectId: project };
}

const CLAUDE_READY = { id: "claude-code", installed: true, version: "2.1.287", loggedIn: true };

let stanId: string;
let danaId: string;
let rexId: string;
let rex: TestClient;

describe("failures are result codes with no partial writes (D-04, Pitfall 9)", () => {
  beforeAll(async () => {
    ({ userId: stanId } = await invite(stack, admin, "stan@example.test", "Stan", "standard"));
    ({ userId: danaId } = await invite(stack, admin, "dana@example.test", "Dana", "developer"));
    ({ client: rex, userId: rexId } = await invite(stack, admin, "rex@example.test", "Rex", "developer"));
  });

  it("not_allowed: a standard member without work_session.create", async () => {
    const r = await refusedWith(stanId, proposal(), "not_allowed");
    expect(r).toMatchObject({ denial: { permission: "work_session.create" } });
  });

  it("not_allowed: a developer under a Work Zone module deny (07.3)", async () => {
    const off = await admin.request("PUT", "/api/v1/module-access", {
      module: "work_zone",
      scopeUnitId: null,
      subject: { kind: "user", userId: danaId },
      enabled: false,
    });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    try {
      await refusedWith(danaId, proposal(), "not_allowed");
    } finally {
      const on = await admin.request("PUT", "/api/v1/module-access", {
        module: "work_zone",
        scopeUnitId: null,
        subject: { kind: "user", userId: danaId },
        enabled: true,
      });
      expect(on.status, JSON.stringify(on.body)).toBe(200);
    }
  });

  it("project_not_found: missing, removed, another organization's, and on another device", async () => {
    await refusedWith(samId, proposal({ projectId: randomUUID() }), "project_not_found");

    const removed = randomUUID();
    await su.query(
      "insert into app.projects (id, organization_id, device_id, local_id, name, removed_at) values ($1, $2, $3, 'lp_gone', 'gone', now())",
      [removed, orgId, deviceId],
    );
    await refusedWith(samId, proposal({ projectId: removed }), "project_not_found");

    const orgB = randomUUID();
    const userB = randomUUID();
    const devB = randomUUID();
    const projB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
      orgB,
      `o-${orgB}`,
    ]);
    await su.query("insert into auth.user (id, name, email) values ($1, 'B', $2)", [
      userB,
      `${userB}@b.test`,
    ]);
    await su.query(
      "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash, shared, status, runtime_info) values ($1, $2, $3, 'B mac', 'darwin', $4, true, 'online', $5)",
      [
        devB,
        orgB,
        userB,
        createHash("sha256").update(randomUUID()).digest("hex"),
        JSON.stringify([CLAUDE_READY]),
      ],
    );
    await su.query(
      "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, 'lb', 'secret')",
      [projB, orgB, devB],
    );
    await refusedWith(samId, proposal({ projectId: projB, deviceId: devB }), "project_not_found");

    const other = await seedDevice({ name: "Sam's iMac", status: "online", runtimeInfo: [CLAUDE_READY] });
    const r = await refusedWith(samId, proposal({ deviceId: other.deviceId }), "project_not_found");
    expect(r).toMatchObject({ reason: "other_device" });
  });

  it("device_not_shared: a device not shared with the actor, and a revoked one", async () => {
    await refusedWith(rexId, proposal(), "device_not_shared");
    const revoked = await seedDevice({
      name: "Old laptop",
      status: "online",
      runtimeInfo: [CLAUDE_READY],
      revoked: true,
    });
    const r = await refusedWith(samId, proposal(revoked), "device_not_shared");
    expect(r).toMatchObject({
      message: "Old laptop was revoked. Pair it again to use it.",
      denial: { reason: "device_revoked" },
    });
  });

  it("device_offline: the device is offline", async () => {
    const offline = await seedDevice({
      name: "Sleeping Mac",
      status: "offline",
      runtimeInfo: [CLAUDE_READY],
    });
    await refusedWith(samId, proposal(offline), "device_offline");
  });

  it("runtime_unavailable: Claude Code not installed, and installed but signed out", async () => {
    const bare = await seedDevice({
      name: "Bare Mac",
      status: "online",
      runtimeInfo: [{ id: "claude-code", installed: false, version: null, loggedIn: false }],
    });
    await refusedWith(samId, proposal(bare), "runtime_unavailable");
    const signedOut = await seedDevice({
      name: "Signed-out Mac",
      status: "online",
      runtimeInfo: [{ id: "claude-code", installed: true, version: "2.1.287", loggedIn: false }],
    });
    await refusedWith(samId, proposal(signedOut), "runtime_unavailable");
  });

  it("prompt_not_allowed: a slash-command prompt, checked on the trimmed prompt (P-08)", async () => {
    for (const prompt of ["/permissions", "/model x", "  /permissions", "\n/model"]) {
      await refusedWith(samId, proposal({ prompt }), "prompt_not_allowed");
    }
  });

  it("settings_denied: an explicit mode above the intersection (the human path) is refused with its reason", async () => {
    const r = await refusedWith(samId, proposal({ permissionMode: "fullAccess" }), "settings_denied");
    expect(r).toMatchObject({ field: "permissionMode", reason: "org_policy" });
  });
});

describe("POST /work-sessions keeps today's error for every code", () => {
  const post = (as: TestClient, body: Record<string, unknown>) =>
    as.request("POST", "/api/v1/work-sessions", body);
  const errorOf = (res: { status: number; body: Record<string, unknown> | null }) => {
    const e = res.body?.error as { code?: string; message?: string } | undefined;
    return [res.status, e?.code, e?.message];
  };

  it("maps each refusal to the same status, code and message as before the extraction", async () => {
    const stan = (await invite(stack, admin, "stella@example.test", "Stella", "standard")).client;
    expect(errorOf(await post(stan, { projectId }))).toEqual([
      403,
      "forbidden",
      "You do not have permission to do this",
    ]);
    expect(errorOf(await post(sam, { projectId: randomUUID() }))).toEqual([
      404,
      "not_found",
      "Project not found",
    ]);
    const other = await seedDevice({ name: "Second Mac", status: "online", runtimeInfo: [CLAUDE_READY] });
    expect(errorOf(await post(sam, { projectId, deviceId: other.deviceId }))).toEqual([
      409,
      "conflict",
      "The project belongs to another device",
    ]);
    const outsider = (await invite(stack, admin, "olga@example.test", "Olga", "developer")).client;
    expect(errorOf(await post(outsider, { projectId }))).toEqual([
      403,
      "device_not_shared",
      "This device is not shared with you. Ask its owner to share it.",
    ]);
    const offline = await seedDevice({ name: "Night Mac", status: "offline", runtimeInfo: [CLAUDE_READY] });
    expect(errorOf(await post(sam, offline))).toEqual([
      409,
      "device_offline",
      "Night Mac is offline. Start the desktop app.",
    ]);
    const bare = await seedDevice({
      name: "Empty Mac",
      status: "online",
      runtimeInfo: [{ id: "claude-code", installed: false, version: null, loggedIn: false }],
    });
    expect(errorOf(await post(sam, bare))).toEqual([
      409,
      "runtime_unavailable",
      "Claude Code is not installed on Empty Mac",
    ]);
    expect(errorOf(await post(sam, { projectId, runtime: "codex" }))).toEqual([
      409,
      "runtime_unavailable",
      "Codex is not signed in on Sam's MacBook. Sign in from a terminal first.",
    ]);
    expect(errorOf(await post(sam, { projectId, prompt: "  /permissions" }))).toEqual([
      400,
      "slash_command",
      "Send slash commands from the composer",
    ]);
    const full = await post(sam, { projectId, permissionMode: "fullAccess" });
    expect(errorOf(full)).toEqual([
      403,
      "org_policy",
      "Permission mode: Your organization's Work Zone policy does not allow this",
    ]);
    expect((full.body!.error as { details?: unknown }).details).toMatchObject({
      permission: "work_session.configure",
      layer: "org",
      reason: "org_policy",
    });
  });
});

describe("the start mode never rises without an explicit mode (APPROVE-04, T-07.5-05-01)", () => {
  beforeAll(async () => {
    // Full access allowed everywhere: organization policy, the device's opt-in, and Sam owns the device.
    const put = await admin.request("PUT", "/api/v1/work-zone-policy", { allowFullAccess: true });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    device.capabilities([CLAUDE_CATALOG, CODEX_CATALOG], true);
    await eventually(async () => {
      const r = await su.query("select full_access_opt_in from app.devices where id = $1", [deviceId]);
      return r.rows[0].full_access_opt_in === true;
    });
  });

  it("with full access allowed for Sam, a call without a mode starts at default", async () => {
    // Not vacuous: Full access is available to Sam on this device right now.
    const controls = await sam.request(
      "GET",
      `/api/v1/work-zone/controls?deviceId=${deviceId}&runtime=claude-code`,
    );
    expect(controls.status, JSON.stringify(controls.body)).toBe(200);
    const modes = (controls.body as { permissionModes: Array<{ value: string; available: boolean }> })
      .permissionModes;
    for (const m of ["fullAccess", "auto", "acceptEdits"]) {
      expect(modes.find((x) => x.value === m)?.available, m).toBe(true);
    }
    const res = await startAs(samId, proposal(), { proposedByAgentId: botId });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.session.permissionMode).toBe("default");
    expect(res.session.fullAccess).toBe(false);
    const start = await device.command("session.start", res.session.id);
    expect(start.payload.permissionMode).toBe("default");
    device.ack(start.id);
  });

  it("a member whose grant is capped at plan starts at plan (lowered, never refused for the default)", async () => {
    await su.query(
      `insert into app.device_grants (organization_id, device_id, principal_kind, principal_id, max_mode)
       values ($1, $2, 'user', $3, 'plan')`,
      [orgId, deviceId, rexId],
    );
    const res = await startAs(rexId, proposal(), { proposedByAgentId: botId });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.session).toMatchObject({ createdBy: rexId, permissionMode: "plan" });
    const start = await device.command("session.start", res.session.id);
    expect(start.payload.permissionMode).toBe("plan");
    device.ack(start.id);
  });

  it("over HTTP too (WINDOWS #205): Rex posts without a mode and starts at plan; an explicit mode is still refused", async () => {
    const lowered = await rex.request("POST", "/api/v1/work-sessions", {
      projectId,
      deviceId,
      runtime: "claude-code",
    });
    expect(lowered.status, JSON.stringify(lowered.body)).toBe(200);
    expect(lowered.body).toMatchObject({ createdBy: rexId, permissionMode: "plan", fullAccess: false });
    const start = await device.command("session.start", (lowered.body as { id: string }).id);
    expect(start.payload.permissionMode).toBe("plan");
    device.ack(start.id);
    // A mode the person picked is never lowered: the same answer as before (403, the grant's cap as the reason).
    const explicit = await rex.request("POST", "/api/v1/work-sessions", {
      projectId,
      deviceId,
      runtime: "claude-code",
      permissionMode: "default",
    });
    expect(explicit.status, JSON.stringify(explicit.body)).toBe(403);
    expect((explicit.body!.error as { code: string }).code).toBe("device_grant");
  });
});

describe("proposed by reaches every prompt view (UI-SPEC Surface 3)", () => {
  type PromptDto = {
    id: string;
    authorUserId: string;
    proposedBy: { agentId: string; displayName: string } | null;
  };

  it("REST and prompt.updated name the bot on the proposed prompt and null on Sam's own", async () => {
    // The bot used here is a fresh one, deleted at the end.
    const helper = randomUUID();
    await su.query(
      `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status, scope, owner_user_id)
       values ($1, $2, 'Release bot', 'release-bot', '', 'mock', 'mock', 'ready', 'personal', $3)`,
      [helper, orgId, samId],
    );
    const res = await startAs(samId, proposal({ prompt: "Cut the release notes" }), {
      proposedByAgentId: helper,
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    const id = res.session.id;
    device.ack((await device.command("session.start", id)).id);
    const typed = await sam.request("POST", `/api/v1/work-sessions/${id}/prompts`, {
      body: "Also bump the version",
    });
    expect(typed.status, JSON.stringify(typed.body)).toBe(200);
    expect((typed.body as unknown as PromptDto).proposedBy).toBeNull();

    const prompts = async () => {
      const d = await sam.request("GET", `/api/v1/work-sessions/${id}`);
      expect(d.status, JSON.stringify(d.body)).toBe(200);
      return (d.body as { prompts: PromptDto[] }).prompts;
    };
    let list = await prompts();
    expect(list.map((p) => p.proposedBy)).toEqual([{ agentId: helper, displayName: "Release bot" }, null]);
    expect(list.every((p) => p.authorUserId === samId)).toBe(true);

    const events = await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'prompt.updated' order by seq",
      [`ws:${id}`],
    );
    const proposedEvents = events.rows.filter((r) => r.payload.id === list[0]!.id);
    const typedEvents = events.rows.filter((r) => r.payload.id === list[1]!.id);
    expect(proposedEvents.length).toBeGreaterThan(0);
    for (const e of proposedEvents) {
      expect(e.payload.proposedBy).toEqual({ agentId: helper, displayName: "Release bot" });
    }
    for (const e of typedEvents) expect(e.payload.proposedBy).toBeNull();

    // A deleted bot (soft delete, as `DELETE /agents/:id` does) is gone from the prompt; the prompt stays.
    await su.query("update app.agents set deleted_at = now(), status = 'disabled' where id = $1", [helper]);
    list = await prompts();
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.proposedBy)).toEqual([null, null]);

    // Hard delete: the foreign key clears the column, the prompt stays.
    await su.query("delete from app.agents where id = $1", [helper]);
    const row = await su.query("select proposed_by_agent_id from app.work_prompts where id = $1", [
      list[0]!.id,
    ]);
    expect(row.rows).toEqual([{ proposed_by_agent_id: null }]);
    expect((await prompts()).map((p) => p.proposedBy)).toEqual([null, null]);
  });
});

// ---------------------------------------------------------------- 07.9-06: the audience a session starts with

describe("a new session's audience and the D-13 start rule (07.9-06, D-03, D-13, P-12)", () => {
  let teamRepo: string;
  let portalUnit: string;
  let pia: TestClient;
  let piaId: string;
  let leo: TestClient;
  let leoId: string;
  let max: TestClient;
  let maxId: string;

  const post = (as: TestClient, body: Record<string, unknown>) =>
    as.request("POST", "/api/v1/work-sessions", body);
  const created = async (as: TestClient, body: Record<string, unknown>) => {
    const res = await post(as, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { id: string; visibility: { kind: string } };
  };
  const errorOf = (res: { status: number; body: Record<string, unknown> | null }) =>
    [res.status, (res.body?.error as { code?: string } | undefined)?.code] as const;
  const sessionCount = async () =>
    (await su.query("select count(*)::int as n from app.work_sessions")).rows[0].n as number;

  beforeAll(async () => {
    ({ client: pia, userId: piaId } = await invite(
      stack,
      admin,
      "pia.portal@example.test",
      "Pia",
      "developer",
    ));
    ({ client: leo, userId: leoId } = await invite(
      stack,
      admin,
      "leo.portal@example.test",
      "Leo",
      "developer",
    ));
    ({ client: max, userId: maxId } = await invite(
      stack,
      admin,
      "max.portal@example.test",
      "Max",
      "developer",
    ));
    // A second repository on Sam's Mac, linked to the team project Portal (Sam, Pia, Max).
    teamRepo = randomUUID();
    await su.query(
      "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, 'lp_portal', 'portal-web')",
      [teamRepo, orgId, deviceId],
    );
    ({ unitId: portalUnit } = await createTeamProject(stack, admin, {
      name: "Portal",
      members: [{ userId: samId }, { userId: piaId }, { userId: maxId }],
    }));
    await linkRepo(stack, {
      organizationId: orgId,
      unitId: portalUnit,
      projectId: teamRepo,
      deviceId,
      linkedBy: samId,
    });
    await shareDevice(sam, deviceId, piaId);
    await shareDevice(sam, deviceId, leoId);
  });

  it("no audience asked: the project's default (on: Project, off: Only me); a personal repository: Project", async () => {
    expect((await created(sam, { projectId: teamRepo })).visibility.kind).toBe("project");
    const off = await admin.request("PATCH", `/api/v1/work-projects/${portalUnit}`, {
      defaultVisibility: "owner",
    });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    try {
      const s = await created(sam, { projectId: teamRepo });
      expect(s.visibility.kind).toBe("owner");
      expect(
        (await su.query("select visibility from app.work_sessions where id = $1", [s.id])).rows[0],
      ).toEqual({
        visibility: "owner",
      });
    } finally {
      await admin.request("PATCH", `/api/v1/work-projects/${portalUnit}`, { defaultVisibility: "project" });
    }
    expect((await created(sam, { projectId })).visibility.kind).toBe("project");
  });

  it("an audience asked is stored as asked, and the creation audit names its kind only", async () => {
    const s = await created(sam, { projectId: teamRepo, visibility: { kind: "people", userIds: [piaId] } });
    expect(s.visibility.kind).toBe("people");
    const grants = await su.query(
      "select subject_kind, subject_id, granted_by from app.work_session_grants where work_session_id = $1 and revoked_at is null",
      [s.id],
    );
    expect(grants.rows).toEqual([{ subject_kind: "user", subject_id: piaId, granted_by: samId }]);
    expect((await pia.request("GET", `/api/v1/work-sessions/${s.id}`)).status).toBe(200);
    expect((await max.request("GET", `/api/v1/work-sessions/${s.id}`)).status).toBe(404);
    const [audit] = await auditOf("work_session.created", s.id);
    expect(audit!.metadata).toMatchObject({ visibility: "people" });
    expect(JSON.stringify(audit!.metadata)).not.toContain(piaId);
  });

  it("someone outside the project is refused (422, ids only) and no session is created", async () => {
    const before = await sessionCount();
    const res = await post(sam, { projectId: teamRepo, visibility: { kind: "people", userIds: [leoId] } });
    expect(errorOf(res)).toEqual([422, "audience_outside_project"]);
    expect((res.body!.error as { details?: unknown }).details).toEqual({ ids: [leoId] });
    expect(
      errorOf(await post(sam, { projectId, visibility: { kind: "teams", teamIds: [portalUnit] } })),
    ).toEqual([422, "team_not_assigned"]);
    expect(await sessionCount()).toBe(before);
    await refusedWith(
      samId,
      proposal({ projectId: teamRepo, visibility: { kind: "people", userIds: [leoId] } }),
      "audience_outside_project",
    );
  });

  it("starting on a team-project repository needs project access and device.use", async () => {
    expect((await created(pia, { projectId: teamRepo })).visibility.kind).toBe("project");
    const outsider = await post(leo, { projectId: teamRepo });
    expect(errorOf(outsider)).toEqual([403, "not_in_project"]);
    expect((outsider.body!.error as { details?: unknown }).details).toMatchObject({
      reason: "not_in_project",
    });
    expect(errorOf(await post(max, { projectId: teamRepo }))).toEqual([403, "device_not_shared"]);
    await refusedWith(leoId, proposal({ projectId: teamRepo }), "not_in_project");
  });
});
