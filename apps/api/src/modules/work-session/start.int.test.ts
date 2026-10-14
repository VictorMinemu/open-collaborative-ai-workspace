import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, type FakeDevice } from "../../testing-device";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  connectWithProject,
  invite,
  pairDevice,
} from "../../testing-workzone";
import { createPermissionService } from "../organization";
import { createWorkSessionModule } from "./index";
import type { WorkSessionService } from "./service";
import {
  createWorkSession,
  type WorkSessionStartDeps,
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
    });
  });
});
