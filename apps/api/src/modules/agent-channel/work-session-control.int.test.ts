import { randomUUID } from "node:crypto";
import {
  AgentChannelWorkSessionPromptResponse,
  AgentChannelWorkSessionStartResponse,
  AgentChannelWorkSessionStopResponse,
  type BotWorkZoneProfileInput,
} from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice } from "../../testing-device";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  createBotProfile,
  freshBotTurn,
  grantBotConsent,
  invite,
  pairDevice,
} from "../../testing-workzone";

/**
 * Phase 07.16-16 (D-05 … D-08, D-14; PD-13, PD-15, PD-21; E2, E3, E13, E15; BWZ-02, BWZ-05): a bot keeps orchestrating
 * the Work Zone session it started. `POST /agent-channel/v1/work-sessions/prompt` queues a follow-up prompt through the
 * queue people use (`submitWorkPrompt`, in the sponsor's name, the bot as the prompt's agent author) and
 * `POST /agent-channel/v1/work-sessions/stop` archives it through `archiveWorkSession`. The bot controls only its own
 * sessions; people in the session's audience keep prompting and archiving it with their own rights (one executor, many
 * controllers). Real PostgreSQL + Redis; the device is a FakeDevice reporting a `service` host with the isolated mark.
 */

const CELL_TOKEN = "ocw-test-cell-token-bot-work-session-control-0123456789";
const FIRST = "fix the failing invoice test";
const FOLLOW_UP = "now run the tests";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Cmd = { id: string; payload: Record<string, unknown>; sessionId: string };

let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let ana: TestClient;
let orgId: string;
let victorId: string;
let anaId: string;
let atlasId: string;
let echoId: string;
let engId: string;
let server: FakeDevice;
let serverId: string;
let billingId: string;
let ledgerId: string;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function cell(
  path: string,
  body: unknown,
  token = CELL_TOKEN,
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${stack.baseUrl}/agent-channel/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

/** A team bot of the whole organization, ready (no OpenClaw cell runs in this suite). */
async function teamBot(name: string, username: string): Promise<string> {
  const bot = await ok(
    victor.request("POST", "/api/v1/agents", {
      name,
      username,
      instructions: `You are ${name}.`,
      modelProvider: "mock",
      modelId: "mock-1",
    }),
  );
  await su.query("update app.agents set status = 'ready' where id = $1", [bot.id]);
  return bot.id as string;
}

/** A bot's profile on the build server: two repositories, Claude Code, Opus only, up to Full access. */
const profile = (over: Partial<BotWorkZoneProfileInput> = {}): BotWorkZoneProfileInput => ({
  deviceId: serverId,
  runtime: "claude-code",
  projectIds: [billingId, ledgerId],
  defaultModel: "opus",
  allowedModels: ["opus"],
  defaultEffort: "medium",
  allowedEfforts: ["medium", "high"],
  defaultContextWindow: null,
  allowedContextWindows: [],
  fastMode: "off",
  defaultMode: "default",
  maxMode: "fullAccess",
  worktree: true,
  maxConcurrent: 5,
  promptsPerHour: 30,
  wakesPerSessionDay: 20,
  actOnOutsideContent: false,
  ...over,
});

/** `as` asks `bot` in `conversationId`; the delivered turn's event id. */
const ask = (bot = "atlas", as = ana, conversationId = engId, text = "please fix the invoice test") =>
  freshBotTurn(su, as, conversationId, `@${bot} ${text} ${randomUUID().slice(0, 6)}`);

const promptCall = (
  eventId: string,
  workSessionId: string,
  prompt = FOLLOW_UP,
  agentId = atlasId,
  token = CELL_TOKEN,
) => cell("/work-sessions/prompt", { eventId, agentId, workSessionId, prompt }, token);

const stopCall = (eventId: string, workSessionId: string, agentId = atlasId, token = CELL_TOKEN) =>
  cell("/work-sessions/stop", { eventId, agentId, workSessionId }, token);

/** The answer of a prompt that must have been queued. */
async function queued(eventId: string, workSessionId: string, prompt = FOLLOW_UP) {
  const r = await promptCall(eventId, workSessionId, prompt);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const body = AgentChannelWorkSessionPromptResponse.parse(r.body);
  if (body.kind !== "queued") throw new Error(`not queued: ${JSON.stringify(body)}`);
  return body;
}

/** The answer of a stop that must have stopped. */
async function stopped(eventId: string, workSessionId: string) {
  const r = await stopCall(eventId, workSessionId);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const body = AgentChannelWorkSessionStopResponse.parse(r.body);
  if (body.kind !== "stopped") throw new Error(`not stopped: ${JSON.stringify(body)}`);
  return body;
}

const rowsOf = async (q: string, args: unknown[] = []) => (await su.query(q, args)).rows as Json[];

const auditsOf = (action: string, eventId: string) =>
  rowsOf(
    "select actor_kind, actor_id, agent_id, user_id, device_id, session_id, result, metadata from app.audit_events where action = $1 and metadata->>'eventId' = $2 order by occurred_at",
    [action, eventId],
  );

const promptsOf = (workSessionId: string) =>
  rowsOf(
    "select id, author_user_id, author_agent_id, body, status, tainted from app.work_prompts where work_session_id = $1 order by created_at",
    [workSessionId],
  );

/**
 * `bot` starts a session on `projectId` (from a fresh ask of Ana in #eng) and the device takes it: `session.start`
 * acked, the runtime reports the session idle, and the first prompt (the start's own) reaches the device.
 */
async function botSession(
  bot: { id: string; handle: string } = { id: atlasId, handle: "atlas" },
  projectId = billingId,
): Promise<{ workSessionId: string; first: Cmd }> {
  const eventId = await ask(bot.handle);
  const r = await cell("/work-sessions/start", { eventId, agentId: bot.id, projectId, prompt: FIRST });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const body = AgentChannelWorkSessionStartResponse.parse(r.body);
  if (body.kind !== "started") throw new Error(`not started: ${JSON.stringify(body)}`);
  const id = body.workSessionId;
  const start = await server.command("session.start", id);
  server.ack(start.id);
  server.event(id, {
    type: "session.started",
    runtime: "claude-code",
    runtimeSessionId: `rt-${id}`,
    model: "opus",
    permissionMode: "default",
  });
  server.event(id, { type: "session.state", status: "idle" });
  const first = (await server.command("prompt", id)) as Cmd;
  server.ack(first.id);
  return { workSessionId: id, first };
}

/** The runtime finishes the turn of `cmd` (started → output → completed) and the session is idle again. */
async function finishTurn(workSessionId: string, cmd: Cmd, text = "done") {
  server.emitTurn(workSessionId, { promptId: cmd.payload.promptId as string, text });
  await eventually(async () => {
    const [p] = await rowsOf("select status from app.work_prompts where id = $1", [cmd.payload.promptId]);
    return p?.status === "completed";
  });
}

/**
 * Every session of these tests ends before the next test, and the hour's prompts are forgotten, so each case starts
 * from zero active sessions and an empty prompt budget (the caps are what some cases test).
 */
async function quiesce() {
  await su.query(
    "update app.work_sessions set status = 'archived' where organization_id = $1 and status <> 'archived'",
    [orgId],
  );
  await su.query(
    "update app.work_prompts set created_at = now() - interval '2 hours' where organization_id = $1",
    [orgId],
  );
}

/** Every API log line (LOG_LEVEL debug): the leak sweep reads them. */
const logs: string[] = [];

beforeAll(async () => {
  stack = await startTestStack({
    env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock", LOG_LEVEL: "debug" },
    logStream: { write: (line: string) => void logs.push(line) },
  });
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
  victorId = setup.user.id;
  ({ client: ana, userId: anaId } = await invite(stack, victor, "ana@example.test", "Ana Gil", "developer"));
  atlasId = await teamBot("Atlas", "atlas");
  echoId = await teamBot("Echo", "echo");
  engId = (await ok(victor.request("POST", "/api/v1/channels", { name: "eng", visibility: "public" })))
    .id as string;
  for (const botId of [atlasId, echoId]) {
    await ok(victor.request("POST", `/api/v1/channels/${engId}/members`, { kind: "agent", id: botId }));
  }
  await ok(victor.request("POST", `/api/v1/channels/${engId}/members`, { kind: "user", id: anaId }));

  await ok(victor.request("PUT", "/api/v1/work-zone-policy", { allowFullAccess: true, allowFastMode: true }));
  const paired = await pairDevice(stack, victor, "billing-server");
  serverId = paired.deviceId;
  server = await FakeDevice.connect(stack.baseUrl, paired.token, undefined, {
    host: "service",
    isolatedServer: true,
  });
  server.send({
    type: "projects.sync",
    projects: ["billing-api", "ledger"].map((name) => ({
      localId: `lp_${name}`,
      name,
      gitRemote: null,
      defaultBranch: "main",
    })),
  });
  await server.next((f) => f.type === "projects.ack");
  server.capabilities([CLAUDE_CATALOG, CODEX_CATALOG], true, true);
  await eventually(async () => {
    const r = await su.query(
      "select runtime_catalog, full_access_opt_in, host_kind, isolated_server from app.devices where id = $1",
      [serverId],
    );
    const d = r.rows[0];
    return (d.runtime_catalog as unknown[]).length === 2 && d.host_kind === "service" && d.isolated_server;
  });
  const list = (await ok(victor.request("GET", "/api/v1/projects"))).projects as Json[];
  billingId = list.find((p) => p.name === "billing-api")!.id as string;
  ledgerId = list.find((p) => p.name === "ledger")!.id as string;

  // Víctor (admin) gives Atlas and Echo their profiles (he is their sponsor); the server allows both.
  await createBotProfile(victor, atlasId, profile());
  await createBotProfile(victor, echoId, profile());
  await grantBotConsent(victor, serverId, atlasId, { allowFullAccess: true });
  await grantBotConsent(victor, serverId, echoId, { allowFullAccess: true });
}, 180_000);

afterAll(async () => {
  await server?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

beforeEach(async () => {
  await quiesce();
});

// ---------------------------------------------------------------- tracer: prompt, then stop (PD-13)

describe("tracer: Atlas sends a follow-up prompt to the session it started, then stops it", () => {
  it("queues the prompt in the sponsor's name with Atlas as its agent author, and the device receives it", async () => {
    const { workSessionId, first } = await botSession();
    await finishTurn(workSessionId, first);

    // A second turn of Atlas (Ana asks again) sends the follow-up.
    const eventId = await ask();
    const body = await queued(eventId, workSessionId);
    expect(body).toMatchObject({ kind: "queued", workSessionId, position: 2 });

    const prompts = await promptsOf(workSessionId);
    expect(prompts.map((p) => [p.author_user_id, p.author_agent_id, p.body])).toEqual([
      [victorId, atlasId, FIRST],
      [victorId, atlasId, FOLLOW_UP],
    ]);
    expect(prompts[1]!.id).toBe(body.promptId);
    expect(prompts[1]!.tainted).toBe(false);

    const cmd = (await server.command("prompt", workSessionId)) as Cmd;
    expect(cmd.payload).toMatchObject({ promptId: body.promptId, text: FOLLOW_UP });
    server.ack(cmd.id);
  });

  it("stops the session: archived, queued prompts cancelled, session.stop sent, stopped_by_agent, archive audited by the bot", async () => {
    const { workSessionId } = await botSession();
    // The first turn is still running: the follow-up waits in the queue.
    const waiting = await queued(await ask(), workSessionId);
    expect(waiting.status).toBe("queued");

    const eventId = await ask();
    const body = await stopped(eventId, workSessionId);
    expect(body).toEqual({ kind: "stopped", workSessionId });

    const [s] = await rowsOf("select status from app.work_sessions where id = $1", [workSessionId]);
    expect(s!.status).toBe("archived");
    const prompts = await promptsOf(workSessionId);
    expect(prompts.find((p) => p.id === waiting.promptId)!.status).toBe("cancelled");
    await server.command("session.stop", workSessionId);
    const [bot] = await rowsOf(
      "select stopped_by_agent from app.bot_work_sessions where work_session_id = $1",
      [workSessionId],
    );
    expect(bot!.stopped_by_agent).toBe(true);
    const archived = await rowsOf(
      "select agent_id, metadata from app.audit_events where action = 'work_session.archived' and resource_id = $1",
      [workSessionId],
    );
    expect(archived).toEqual([{ agent_id: atlasId, metadata: { byAgentId: atlasId } }]);
  });

  it("audits bot.work_session_prompted and bot.work_session_stopped with ids, the outcome and promptChars only", async () => {
    const { workSessionId } = await botSession();
    const promptEvent = await ask();
    await queued(promptEvent, workSessionId);
    const [prompted] = await auditsOf("bot.work_session_prompted", promptEvent);
    expect(prompted).toMatchObject({
      actor_kind: "agent",
      actor_id: atlasId,
      agent_id: atlasId,
      user_id: anaId,
      device_id: serverId,
      session_id: workSessionId,
      result: "success",
    });
    expect(prompted!.metadata).toEqual({
      eventId: promptEvent,
      sponsorUserId: victorId,
      projectId: billingId,
      workSessionId,
      outcome: "prompted",
      promptChars: FOLLOW_UP.length,
    });

    const stopEvent = await ask();
    await stopped(stopEvent, workSessionId);
    const stops = await auditsOf("bot.work_session_stopped", stopEvent);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({
      actor_kind: "agent",
      agent_id: atlasId,
      user_id: anaId,
      result: "success",
    });
    expect(stops[0]!.metadata).toEqual({
      eventId: stopEvent,
      sponsorUserId: victorId,
      projectId: billingId,
      workSessionId,
      outcome: "stopped",
    });
  });
});
