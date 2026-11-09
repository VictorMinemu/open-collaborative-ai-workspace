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
import type { AgentControlsLayer } from "./context";
import type { WorkSessionStartInput, WorkSessionStartOptions, WorkSessionStartResult } from "./start";

/**
 * Phase 07.16-06 (D-02, D-04, D-06, PD-07, PD-23): a bot's Work Zone session is created by the ONE
 * `createWorkSession`, in its sponsor's tenant transaction, with the bot's caps intersected into the one controls
 * context (`bot_profile` refusals). The session and its first prompt are recorded as the bot's; a person's start is
 * unchanged.
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

const input = (over: Partial<WorkSessionStartInput> = {}): WorkSessionStartInput => ({
  projectId,
  deviceId,
  runtime: "claude-code",
  prompt: "fix the login bug",
  ...over,
});

/** The bot's caps as `profileStatus` hands them over (07.16-07); each test overrides one input. */
const layer = (over: Partial<AgentControlsLayer> = {}): AgentControlsLayer => ({
  agentId: botId,
  maxMode: "acceptEdits",
  allowFullAccess: false,
  tainted: false,
  isolated: false,
  models: ["opus", "sonnet"],
  efforts: ["low", "medium", "high"],
  contextWindows: [],
  fastMode: "allowed",
  ...over,
});

/** Start through the app's own module, as `userId` in their tenant transaction (what the bot route does). */
function startAs(
  userId: string,
  body: WorkSessionStartInput,
  opts?: WorkSessionStartOptions,
): Promise<WorkSessionStartResult> {
  return stack.built.core.db.withTenant({ organizationId: orgId, userId }, (tx) =>
    stack.built.workSession.start(tx, { userId, organizationId: orgId, clientKind: null }, body, opts),
  );
}

const botStart = (body: WorkSessionStartInput, l: AgentControlsLayer = layer()) =>
  startAs(samId, body, { agent: { layer: l } });

/** The device takes the session.start command (so later starts are not behind an unacked one). */
async function ackStart(sessionId: string) {
  device.ack((await device.command("session.start", sessionId)).id);
}

async function auditOf(action: string, sessionId: string) {
  return (
    await su.query(
      "select user_id, actor_id, metadata from app.audit_events where action = $1 and session_id = $2 order by occurred_at",
      [action, sessionId],
    )
  ).rows as Array<{ user_id: string; actor_id: string; metadata: Record<string, unknown> }>;
}

async function sessionRow(id: string) {
  return (
    await su.query(
      "select created_by, started_by_agent_id, tainted_at, permission_mode, model from app.work_sessions where id = $1",
      [id],
    )
  ).rows[0] as {
    created_by: string;
    started_by_agent_id: string | null;
    tainted_at: Date | null;
    permission_mode: string;
    model: string | null;
  };
}

async function promptRows(id: string) {
  return (
    await su.query(
      "select author_user_id, author_agent_id, proposed_by_agent_id, tainted from app.work_prompts where work_session_id = $1 order by position",
      [id],
    )
  ).rows;
}

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

/** The bot's start is refused as a settings denial on `field` with `reason`, and leaves no trace. */
async function refused(body: WorkSessionStartInput, l: AgentControlsLayer, field: string, reason: string) {
  const before = await traces();
  const res = await botStart(body, l);
  expect(res, JSON.stringify(res)).toMatchObject({ ok: false, code: "settings_denied", field, reason });
  expect(await traces()).toEqual(before);
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
  // Full access allowed for Sam everywhere (policy, the device's opt-in, he owns the device): every `bot_profile`
  // below is the bot's own cap, never a member layer.
  const put = await admin.request("PUT", "/api/v1/work-zone-policy", { allowFullAccess: true });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  device.capabilities([CLAUDE_CATALOG, CODEX_CATALOG], true);
  await eventually(async () => {
    const r = await su.query("select runtime_catalog, full_access_opt_in from app.devices where id = $1", [
      deviceId,
    ]);
    return (r.rows[0].runtime_catalog as unknown[]).length === 2 && r.rows[0].full_access_opt_in === true;
  });
  // Sam's personal bot, seeded directly: no OpenClaw cell is involved in creating a session.
  botId = randomUUID();
  await su.query(
    `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status, scope, owner_user_id)
     values ($1, $2, 'Scout', 'scout', '', 'mock', 'mock', 'ready', 'personal', $3)`,
    [botId, orgId, samId],
  );
}, 180_000);

afterAll(async () => {
  await device?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

describe("tracer: a bot-capped session through the one createWorkSession (D-02, D-06, PD-07)", () => {
  it("the sponsor's start with the agent option records the bot as the starter and the first prompt's author", async () => {
    const res = await botStart(input());
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    const id = res.session.id;
    await ackStart(id);
    // `default` is at or below the profile's acceptEdits cap, so the implicit default stays.
    expect(await sessionRow(id)).toMatchObject({
      created_by: samId,
      started_by_agent_id: botId,
      tainted_at: null,
      permission_mode: "default",
    });
    expect(await promptRows(id)).toEqual([
      { author_user_id: samId, author_agent_id: botId, proposed_by_agent_id: null, tainted: false },
    ]);
    const [created] = await auditOf("work_session.created", id);
    expect(created).toMatchObject({ user_id: samId, actor_id: samId });
    expect(created!.metadata).toMatchObject({ startedByAgentId: botId, permissionMode: "default" });
    const [queued] = await auditOf("work_prompt.queued", id);
    expect(queued!.metadata).toMatchObject({ authorUserId: samId, authorAgentId: botId, length: 17 });
    // Audit never carries the prompt.
    expect(JSON.stringify(queued!.metadata)).not.toContain("login");
  });

  it("an explicit Full access above the profile is refused bot_profile and writes nothing", async () => {
    await refused(input({ permissionMode: "fullAccess" }), layer(), "permissionMode", "bot_profile");
  });

  it("a mode within the member's rights but above the profile's max is refused bot_profile", async () => {
    await refused(input({ permissionMode: "auto" }), layer(), "permissionMode", "bot_profile");
  });

  it("a person's POST /work-sessions answers exactly as before (PD-23)", async () => {
    const res = await sam.request("POST", "/api/v1/work-sessions", { projectId, prompt: "Typed by Sam" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const id = res.body!.id as string;
    expect(res.body).toMatchObject({ createdBy: samId, permissionMode: "default", model: null });
    await ackStart(id);
    expect(await sessionRow(id)).toMatchObject({ started_by_agent_id: null, tainted_at: null });
    expect(await promptRows(id)).toEqual([
      { author_user_id: samId, author_agent_id: null, proposed_by_agent_id: null, tainted: false },
    ]);
    const [created] = await auditOf("work_session.created", id);
    expect(created!.metadata).toEqual({
      projectId,
      runtime: "claude-code",
      permissionMode: "default",
      worktree: false,
      visibility: "project",
    });
    const [queued] = await auditOf("work_prompt.queued", id);
    expect(Object.keys(queued!.metadata).sort()).toEqual([
      "authorUserId",
      "executionDeviceId",
      "length",
      "originDeviceId",
      "promptId",
      "workSessionId",
    ]);
    // Full access is still the person's to pick (the bot's cap never reaches a human path).
    const full = await sam.request("POST", "/api/v1/work-sessions", {
      projectId,
      permissionMode: "fullAccess",
    });
    expect(full.status, JSON.stringify(full.body)).toBe(200);
    expect(full.body).toMatchObject({ permissionMode: "fullAccess", fullAccess: true });
    await ackStart(full.body!.id as string);
  });
});
