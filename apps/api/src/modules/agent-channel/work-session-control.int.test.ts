import { createHash, randomUUID } from "node:crypto";
import {
  AgentChannelWorkSessionPromptResponse,
  AgentChannelWorkSessionStartResponse,
  AgentChannelWorkSessionStopResponse,
  BOT_WORK_SESSION_SENTENCES,
  type BotWorkSessionRefusal,
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
  createTeamProject,
  freshBotTurn,
  grantBotConsent,
  invite,
  linkRepo,
  pairDevice,
  startSession,
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
let bob: TestClient;
let orgId: string;
let victorId: string;
let anaId: string;
let bobId: string;
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

/** `ocw_work_session_read` of `workSessionId` from the turn, which must succeed (it marks the turn, D-20). */
async function readOk(eventId: string, workSessionId: string) {
  const r = await cell("/work-sessions/read", { eventId, agentId: atlasId, workSessionId });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.kind, JSON.stringify(r.body)).toBe("read");
}

/** A prompt or stop answer that must be the refusal `code`, with its fixed sentence. */
async function refusedWith(res: Promise<{ status: number; body: Json }>, code: BotWorkSessionRefusal) {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.kind, JSON.stringify(r.body)).toBe("refused");
  expect(r.body.code, JSON.stringify(r.body)).toBe(code);
  expect(r.body.sentence).toContain(BOT_WORK_SESSION_SENTENCES[code]);
  return r.body;
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
  ({ client: bob, userId: bobId } = await invite(stack, victor, "bob@example.test", "Bob Ros", "developer"));
  atlasId = await teamBot("Atlas", "atlas");
  echoId = await teamBot("Echo", "echo");
  // Public #eng: Víctor, Ana and Bob read it.
  engId = (await ok(victor.request("POST", "/api/v1/channels", { name: "eng", visibility: "public" })))
    .id as string;
  for (const botId of [atlasId, echoId]) {
    await ok(victor.request("POST", `/api/v1/channels/${engId}/members`, { kind: "agent", id: botId }));
  }
  for (const userId of [anaId, bobId]) {
    await ok(victor.request("POST", `/api/v1/channels/${engId}/members`, { kind: "user", id: userId }));
  }

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
  // ledger belongs to the team project Ledger (Víctor lead, Ana member); Bob is not in it.
  const { unitId } = await createTeamProject(stack, victor, {
    name: "Ledger",
    members: [{ userId: victorId, role: "lead" }, { userId: anaId }],
  });
  await linkRepo(stack, {
    organizationId: orgId,
    unitId,
    projectId: ledgerId,
    deviceId: serverId,
    linkedBy: victorId,
  });

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

// ---------------------------------------------------------------- only its own sessions (D-06, PD-13, E3, E15)

/** What a refused prompt or stop must not have changed in `workSessionId`: its status and its prompts. */
const stateOf = async (workSessionId: string) => ({
  status: (await rowsOf("select status from app.work_sessions where id = $1", [workSessionId]))[0]?.status,
  prompts: (await promptsOf(workSessionId)).map((p) => [p.id, p.status]),
});

describe("the bot controls only the sessions it started (E3)", () => {
  /** Organization B's idle session, with its own device, project and creator (a guessed id from Atlas's side). */
  async function orgBSession(): Promise<string> {
    const orgB = randomUUID();
    const userB = randomUUID();
    const devB = randomUUID();
    const projB = randomUUID();
    const convB = randomUUID();
    const wsB = randomUUID();
    const q = (t: string, v: unknown[]) => su.query(t, v);
    await q("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [orgB, `o-${orgB}`]);
    await q("insert into auth.user (id, name, email) values ($1, 'B', $2)", [userB, `${userB}@b.test`]);
    await q(
      "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash, shared, status, runtime_info) values ($1, $2, $3, 'B mac', 'darwin', $4, true, 'online', '[]')",
      [devB, orgB, userB, createHash("sha256").update(randomUUID()).digest("hex")],
    );
    await q(
      "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, 'lb', 'secret')",
      [projB, orgB, devB],
    );
    await q(
      "insert into app.conversations (id, organization_id, kind, name) values ($1, $2, 'work_session', 'b')",
      [convB, orgB],
    );
    await q(
      "insert into app.work_sessions (id, organization_id, conversation_id, project_id, device_id, title, created_by, status) values ($1, $2, $3, $4, $5, 'B', $6, 'idle')",
      [wsB, orgB, convB, projB, devB, userB],
    );
    return wsB;
  }

  it("a session a person started, one another bot started and one of organization B → not_your_session each; nothing changes", async () => {
    const personal = await startSession(victor, server, billingId);
    const echo = (await botSession({ id: echoId, handle: "echo" })).workSessionId;
    const foreign = await orgBSession();
    for (const workSessionId of [personal, echo, foreign]) {
      const before = await stateOf(workSessionId);
      await refusedWith(promptCall(await ask(), workSessionId), "not_your_session");
      await refusedWith(stopCall(await ask(), workSessionId), "not_your_session");
      expect(await stateOf(workSessionId)).toEqual(before);
    }
    const [bots] = await rowsOf(
      "select count(*)::int as n from app.bot_work_sessions where work_session_id = any($1::uuid[]) and stopped_by_agent",
      [[personal, echo, foreign]],
    );
    expect(bots!.n).toBe(0);
  });

  it("the refusal is recorded as a denied call that does not count against the turn, and audited without content", async () => {
    const personal = await startSession(victor, server, billingId);
    const eventId = await ask();
    await refusedWith(promptCall(eventId, personal), "not_your_session");
    expect(
      await rowsOf("select tool, decision, reason from app.agent_tool_calls where event_id = $1", [eventId]),
    ).toEqual([{ tool: "ocw_work_session_prompt", decision: "denied", reason: "not_your_session" }]);
    const [turn] = await rowsOf("select tool_calls from app.agent_turns where event_id = $1", [eventId]);
    expect(turn!.tool_calls).toBe(0);
    const [audit] = await auditsOf("bot.work_session_refused", eventId);
    expect(audit!.metadata).toEqual({
      eventId,
      tool: "ocw_work_session_prompt",
      sponsorUserId: victorId,
      workSessionId: personal,
      outcome: "not_your_session",
      promptChars: FOLLOW_UP.length,
    });
  });
});

// ---------------------------------------------------------------- people keep control (D-07, principle 4, E13)

describe("people in the session's audience keep control of the bot's session (one executor, many controllers)", () => {
  it("Ana prompts Atlas's session over HTTP: queued after Atlas's, dispatched as her own turn", async () => {
    const { workSessionId, first } = await botSession(undefined, ledgerId);
    const atlasFollowUp = await queued(await ask(), workSessionId);
    const res = await ana.request("POST", `/api/v1/work-sessions/${workSessionId}/prompts`, {
      body: "also update the changelog",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const anaPrompt = res.body as Json;
    expect(anaPrompt.authorUserId).toBe(anaId);
    expect(anaPrompt.position).toBeGreaterThan(atlasFollowUp.position);
    const [row] = await rowsOf("select author_agent_id from app.work_prompts where id = $1", [anaPrompt.id]);
    expect(row!.author_agent_id).toBeNull();

    // One executor: Atlas's first turn, then its follow-up, then Ana's, one at a time.
    await finishTurn(workSessionId, first);
    const second = (await server.command("prompt", workSessionId)) as Cmd;
    expect(second.payload.promptId).toBe(atlasFollowUp.promptId);
    server.ack(second.id);
    await finishTurn(workSessionId, second);
    const third = (await server.command("prompt", workSessionId)) as Cmd;
    expect(third.payload.promptId).toBe(anaPrompt.id);
    server.ack(third.id);
    const [dispatched] = await rowsOf(
      "select user_id, agent_id, metadata from app.audit_events where action = 'work_prompt.dispatched' and resource_id = $1",
      [anaPrompt.id],
    );
    expect(dispatched).toMatchObject({ user_id: anaId, agent_id: null });
    expect(dispatched!.metadata).not.toHaveProperty("authorAgentId");
  });

  it("a person with the archive right archives Atlas's session over HTTP: archived, stopped_by_agent stays false", async () => {
    const { workSessionId } = await botSession(undefined, ledgerId);
    // Ana keeps exactly her own rights: a developer in the audience prompts and interrupts, but archiving is the
    // creator's, the device owner's or an admin's (unchanged by the phase).
    const denied = await ana.request("POST", `/api/v1/work-sessions/${workSessionId}/archive`);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    // Carla, an admin who is neither the sponsor nor the device owner, archives it.
    const { client: carla, userId: carlaId } = await invite(
      stack,
      victor,
      `carla-${randomUUID().slice(0, 6)}@example.test`,
      "Carla Paz",
      "admin",
    );
    await ok(carla.request("POST", `/api/v1/work-sessions/${workSessionId}/archive`));
    const [s] = await rowsOf("select status from app.work_sessions where id = $1", [workSessionId]);
    expect(s!.status).toBe("archived");
    const [bot] = await rowsOf(
      "select stopped_by_agent from app.bot_work_sessions where work_session_id = $1",
      [workSessionId],
    );
    expect(bot!.stopped_by_agent).toBe(false);
    const [archived] = await rowsOf(
      "select user_id, agent_id from app.audit_events where action = 'work_session.archived' and resource_id = $1",
      [workSessionId],
    );
    expect(archived).toMatchObject({ user_id: carlaId, agent_id: null });
  });

  it("Bob reads #eng but is outside the session's audience: 404 on the session, nothing he can prompt", async () => {
    const { workSessionId } = await botSession(undefined, ledgerId);
    expect((await bob.request("GET", `/api/v1/work-sessions/${workSessionId}`)).status).toBe(404);
    const res = await bob.request("POST", `/api/v1/work-sessions/${workSessionId}/prompts`, { body: "hi" });
    expect(res.status).toBe(404);
    // Ana, in the audience, sees it.
    expect((await ana.request("GET", `/api/v1/work-sessions/${workSessionId}`)).status).toBe(200);
  });
});

// ---------------------------------------------------------------- refusals (PD-13, PD-15, E2, E5)

const saveProfile = (over: Partial<BotWorkZoneProfileInput> = {}) =>
  createBotProfile(victor, atlasId, profile(over));

describe("prompt refusals; a stop stays allowed", () => {
  it("an archived session → session_ended for prompt and stop", async () => {
    const { workSessionId } = await botSession();
    await stopped(await ask(), workSessionId);
    const before = await stateOf(workSessionId);
    await refusedWith(promptCall(await ask(), workSessionId), "session_ended");
    await refusedWith(stopCall(await ask(), workSessionId), "session_ended");
    expect(await stateOf(workSessionId)).toEqual(before);
  });

  it("consent revoked → prompt profile_inactive with reason no_consent; the stop still stops", async () => {
    const { workSessionId } = await botSession();
    // The turn was delivered with the tools; the device's owner revokes the consent while it runs (E5's shape).
    const eventId = await ask();
    await ok(victor.request("DELETE", `/api/v1/devices/${serverId}/bot-consents/${atlasId}`));
    try {
      const r = await refusedWith(promptCall(eventId, workSessionId), "profile_inactive");
      expect(r.reason).toBe("no_consent");
      await stopped(eventId, workSessionId);
    } finally {
      await grantBotConsent(victor, serverId, atlasId, { allowFullAccess: true });
    }
  });

  it("prompts_per_hour 3: the start and two prompts are queued, the fourth → prompt_rate (E2)", async () => {
    await saveProfile({ promptsPerHour: 3 });
    try {
      const { workSessionId } = await botSession();
      await queued(await ask(), workSessionId);
      await queued(await ask(), workSessionId, "and the lint");
      const before = await stateOf(workSessionId);
      await refusedWith(promptCall(await ask(), workSessionId, "one more"), "prompt_rate");
      expect(await stateOf(workSessionId)).toEqual(before);
    } finally {
      await saveProfile();
    }
  });

  it("a slash command → prompt_not_allowed; nothing is queued", async () => {
    const { workSessionId } = await botSession();
    const before = await stateOf(workSessionId);
    await refusedWith(promptCall(await ask(), workSessionId, "/model opus"), "prompt_not_allowed");
    expect(await stateOf(workSessionId)).toEqual(before);
  });

  it("a tainted turn's prompt → outside_content; the same turn's stop → stopped", async () => {
    const { workSessionId } = await botSession();
    const eventId = await ask();
    await su.query("update app.agent_turns set tainted = true where event_id = $1", [eventId]);
    const before = await stateOf(workSessionId);
    await refusedWith(promptCall(eventId, workSessionId), "outside_content");
    expect(await stateOf(workSessionId)).toEqual(before);
    await stopped(eventId, workSessionId);
    const [stopCallRow] = await rowsOf(
      "select decision from app.agent_tool_calls where event_id = $1 and tool = 'ocw_work_session_stop'",
      [eventId],
    );
    expect(stopCallRow!.decision).toBe("allowed");
  });

  it("WR-04: the session's project removed from the profile → project_not_allowed; a queued bot prompt is refused at dispatch", async () => {
    const { workSessionId, first } = await botSession();
    const waiting = await queued(await ask(), workSessionId);
    await saveProfile({ projectIds: [ledgerId] });
    try {
      const before = await stateOf(workSessionId);
      await refusedWith(promptCall(await ask(), workSessionId), "project_not_allowed");
      expect(await stateOf(workSessionId)).toEqual(before);
      // The arbiter re-decides the bot's queued prompt against the same rule: never sent to the device.
      await finishTurn(workSessionId, first);
      await eventually(async () => {
        const [p] = await rowsOf("select status from app.work_prompts where id = $1", [waiting.promptId]);
        return p?.status === "failed";
      });
      const [refusal] = await rowsOf(
        "select metadata from app.audit_events where action = 'work_prompt.refused' and metadata->>'promptId' = $1",
        [waiting.promptId],
      );
      expect(refusal!.metadata).toMatchObject({ reason: "bot_not_allowed" });
    } finally {
      await saveProfile();
    }
  });

  it("WR-05: a session started under another sponsor is never prompted in the new sponsor's name → profile_inactive", async () => {
    const { workSessionId } = await botSession();
    // The session was started while Ana sponsored the profile; Víctor has re-saved it since (a change of sponsor).
    await su.query("update app.bot_work_sessions set sponsor_user_id = $2 where work_session_id = $1", [
      workSessionId,
      anaId,
    ]);
    await su.query("update app.work_sessions set created_by = $2 where id = $1", [workSessionId, anaId]);
    const before = await stateOf(workSessionId);
    await refusedWith(promptCall(await ask(), workSessionId), "profile_inactive");
    expect(await stateOf(workSessionId)).toEqual(before);
    // The bot may still end it (stop runs as the session's own sponsor).
    await stopped(await ask(), workSessionId);
  });

  it("WR-04: the profile's runtime switched → profile_inactive for the session's prompts", async () => {
    const { workSessionId } = await botSession();
    await su.query("update app.bot_work_zone_profiles set runtime = 'codex' where agent_id = $1", [atlasId]);
    try {
      const before = await stateOf(workSessionId);
      await refusedWith(promptCall(await ask(), workSessionId), "profile_inactive");
      expect(await stateOf(workSessionId)).toEqual(before);
    } finally {
      await su.query("update app.bot_work_zone_profiles set runtime = 'claude-code' where agent_id = $1", [
        atlasId,
      ]);
    }
  });

  it("CR-03: a completed session restarts under the caps: below them it is queued, at the bot's cap → too_many_sessions", async () => {
    await saveProfile({ maxConcurrent: 2 });
    try {
      const a = await botSession();
      await su.query("update app.work_sessions set status = 'completed' where id = $1", [a.workSessionId]);
      // Below the cap a finished session restarts as before (one other active session would be fine too).
      await queued(await ask(), a.workSessionId);
      expect((await stateOf(a.workSessionId)).status).not.toBe("completed");
      await su.query("update app.work_sessions set status = 'completed' where id = $1", [a.workSessionId]);
      await botSession();
      await botSession();
      // Two active sessions: restarting A would make three.
      const before = await stateOf(a.workSessionId);
      await refusedWith(promptCall(await ask(), a.workSessionId), "too_many_sessions");
      expect(await stateOf(a.workSessionId)).toEqual(before);
      // A failed session the same way.
      await su.query("update app.work_sessions set status = 'failed' where id = $1", [a.workSessionId]);
      await refusedWith(promptCall(await ask(), a.workSessionId), "too_many_sessions");
      expect((await stateOf(a.workSessionId)).status).toBe("failed");
    } finally {
      await saveProfile();
    }
  });

  it("CR-03: at the organization's cap a finished session is not restarted → org_limit", async () => {
    const a = await botSession();
    await su.query("update app.work_sessions set status = 'completed' where id = $1", [a.workSessionId]);
    await botSession({ id: echoId, handle: "echo" });
    await ok(
      victor.request("PUT", "/api/v1/work-zone-policy", {
        allowFullAccess: true,
        allowFastMode: true,
        botSessionsMax: 1,
      }),
    );
    try {
      const before = await stateOf(a.workSessionId);
      await refusedWith(promptCall(await ask(), a.workSessionId), "org_limit");
      expect(await stateOf(a.workSessionId)).toEqual(before);
    } finally {
      await ok(
        victor.request("PUT", "/api/v1/work-zone-policy", {
          allowFullAccess: true,
          allowFastMode: true,
          botSessionsMax: 10,
        }),
      );
    }
  });

  it("CR-03: without a worktree a finished session never restarts next to an active one on its tree → tree_busy", async () => {
    await saveProfile({ worktree: false });
    try {
      const a = await botSession();
      await su.query("update app.work_sessions set status = 'completed' where id = $1", [a.workSessionId]);
      await botSession({ id: echoId, handle: "echo" });
      await su.query(
        "update app.work_sessions set worktree = false where started_by_agent_id = $1 and status <> 'archived'",
        [echoId],
      );
      const before = await stateOf(a.workSessionId);
      await refusedWith(promptCall(await ask(), a.workSessionId), "tree_busy");
      expect(await stateOf(a.workSessionId)).toEqual(before);
    } finally {
      await saveProfile();
    }
  });

  it("after the turn read a session's output, prompt and stop of that session are still allowed (D-20)", async () => {
    const { workSessionId } = await botSession();
    const eventId = await ask();
    await readOk(eventId, workSessionId);
    await queued(eventId, workSessionId);
    await stopped(eventId, workSessionId);
  });

  it("WR-02: after reading session A the turn cannot prompt session B → session_output; B can still be stopped", async () => {
    const a = await botSession();
    const b = await botSession();
    const eventId = await ask();
    await readOk(eventId, a.workSessionId);
    const before = await stateOf(b.workSessionId);
    await refusedWith(promptCall(eventId, b.workSessionId), "session_output");
    expect(await stateOf(b.workSessionId)).toEqual(before);
    // Reading B as well does not clear A's output from the turn: B still cannot be prompted from it.
    await readOk(eventId, b.workSessionId);
    await refusedWith(promptCall(eventId, b.workSessionId), "session_output");
    expect(await stateOf(b.workSessionId)).toEqual(before);
    // Stopping only ends work: never blocked.
    await stopped(eventId, b.workSessionId);
  });

  it("WR-02: a turn that carries the mark without reading here (a re-run, a return, a wake) must read the session first", async () => {
    const { workSessionId } = await botSession();
    const eventId = await ask();
    await su.query("update app.agent_turns set session_output_read = true where event_id = $1", [eventId]);
    await refusedWith(promptCall(eventId, workSessionId), "session_output");
    await readOk(eventId, workSessionId);
    await queued(eventId, workSessionId);
  });
});

// ---------------------------------------------------------------- audits, tenant and leak sweep (D-14, PD-21, P1, E15)

/** The `bot.work_session_*` audit rows of one call (one event id per call in these cases). */
const botAuditsOf = (eventId: string) =>
  rowsOf(
    "select action, result, metadata from app.audit_events where action like 'bot.work_session_%' and metadata->>'eventId' = $1",
    [eventId],
  );

describe("every outcome of prompt and stop has exactly one audit, by ids only (PD-21)", () => {
  it("queued, stopped and each refusal: one bot.work_session_* row with the outcome and (prompts) promptChars", async () => {
    const { workSessionId } = await botSession();
    const person = await startSession(victor, server, billingId);
    const cases: Array<{ eventId: string; outcome: string; tool: "prompt" | "stop" }> = [];
    const run = async (
      tool: "prompt" | "stop",
      outcome: string,
      opts: { session?: string; prompt?: string; prepare?: (eventId: string) => Promise<void> } = {},
    ) => {
      const eventId = await ask();
      await opts.prepare?.(eventId);
      const r =
        tool === "prompt"
          ? await promptCall(eventId, opts.session ?? workSessionId, opts.prompt)
          : await stopCall(eventId, opts.session ?? workSessionId);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.kind === "refused" ? r.body.code : r.body.kind).toBe(outcome);
      cases.push({ eventId, outcome, tool });
    };
    const withoutTool = (tool: string) => async (eventId: string) => {
      await su.query("update app.agent_turns set tools = array_remove(tools, $2) where event_id = $1", [
        eventId,
        tool,
      ]);
    };

    await run("prompt", "queued");
    await run("prompt", "not_in_turn", { prepare: withoutTool("ocw_work_session_prompt") });
    await run("stop", "not_in_turn", { prepare: withoutTool("ocw_work_session_stop") });
    await run("prompt", "not_your_session", { session: person });
    await run("stop", "not_your_session", { session: person });
    await run("prompt", "prompt_not_allowed", { prompt: "/model opus" });
    await run("prompt", "outside_content", {
      prepare: async (eventId) => {
        await su.query("update app.agent_turns set tainted = true where event_id = $1", [eventId]);
      },
    });
    const disabled = await ask();
    await su.query("update app.agents set status = 'disabled' where id = $1", [atlasId]);
    try {
      const r = await refusedWith(promptCall(disabled, workSessionId), "profile_inactive");
      expect(r.reason).toBe("bot_disabled");
      cases.push({ eventId: disabled, outcome: "profile_inactive", tool: "prompt" });
    } finally {
      await su.query("update app.agents set status = 'ready' where id = $1", [atlasId]);
    }
    await run("stop", "stopped");
    await run("prompt", "session_ended");
    await run("stop", "session_ended");

    for (const c of cases) {
      const rows = await botAuditsOf(c.eventId);
      expect(rows, `${c.tool} ${c.outcome}`).toHaveLength(1);
      const [row] = rows;
      const success = c.outcome === "queued" || c.outcome === "stopped";
      expect(row!.action).toBe(
        success
          ? c.tool === "prompt"
            ? "bot.work_session_prompted"
            : "bot.work_session_stopped"
          : "bot.work_session_refused",
      );
      expect(row!.result).toBe(success ? "success" : "denied");
      expect(row!.metadata.outcome).toBe(c.outcome === "queued" ? "prompted" : c.outcome);
      expect(row!.metadata.eventId).toBe(c.eventId);
      if (!success) expect(row!.metadata.tool).toBe(`ocw_work_session_${c.tool}`);
      // Ids, the outcome, a reason code, a length and (07.16-19) the outside-content mark: no key can carry content.
      const allowed = [
        "eventId",
        "tool",
        "sponsorUserId",
        "projectId",
        "workSessionId",
        "outcome",
        "reason",
        "promptChars",
        "outsideContent",
      ];
      expect(Object.keys(row!.metadata).filter((k) => !allowed.includes(k))).toEqual([]);
      expect(typeof row!.metadata.promptChars).toBe(c.tool === "prompt" ? "number" : "undefined");
    }
  });
});

describe("tenant isolation: organization B's cell cannot prompt or stop organization A's sessions (E15)", () => {
  let tokenB: string;

  beforeAll(async () => {
    const orgB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
      orgB,
      `evil-${orgB}`,
    ]);
    tokenB = `ocw_cell_${randomUUID()}${randomUUID()}`;
    await su.query(
      "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
      [orgB, createHash("sha256").update(tokenB).digest("hex")],
    );
  });

  it("organization B's token with organization A's event → 404 unknown_turn on both routes; nothing changes", async () => {
    const { workSessionId } = await botSession();
    const eventId = await ask();
    const before = await stateOf(workSessionId);
    for (const r of [
      await promptCall(eventId, workSessionId, FOLLOW_UP, atlasId, tokenB),
      await stopCall(eventId, workSessionId, atlasId, tokenB),
    ]) {
      expect(r.status, JSON.stringify(r.body)).toBe(404);
      expect(r.body.error.code).toBe("unknown_turn");
    }
    expect(await stateOf(workSessionId)).toEqual(before);
    expect(await rowsOf("select 1 from app.agent_tool_calls where event_id = $1", [eventId])).toEqual([]);
    expect(await botAuditsOf(eventId)).toEqual([]);
    // Recorded as an unknown turn, in organization B, with ids and the prompt's length only.
    const unknown = await rowsOf(
      "select organization_id, metadata from app.audit_events where action = 'bot.tool_call' and metadata->>'eventId' = $1 order by occurred_at",
      [eventId],
    );
    expect(unknown.map((u) => [u.metadata.tool, u.metadata.reason])).toEqual([
      ["ocw_work_session_prompt", "unknown_turn"],
      ["ocw_work_session_stop", "unknown_turn"],
    ]);
    expect(unknown.every((u) => u.organization_id !== orgId)).toBe(true);
  });

  it("another bot's event naming Atlas → 404 unknown_turn", async () => {
    const { workSessionId } = await botSession();
    const echoEvent = await ask("echo");
    const r = await promptCall(echoEvent, workSessionId);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("unknown_turn");
  });
});

describe("the prompt is in no record: audit, tool calls or a log line (P1)", () => {
  it("a bot prompt holding OCW-MARKER-0716-prompt is stored only as the session's prompt", async () => {
    const MARKER = "OCW-MARKER-0716-prompt";
    const { workSessionId } = await botSession();
    const person = await startSession(victor, server, billingId);
    const prompt = `please ${MARKER} run the tests`;
    const queuedBody = await queued(await ask(), workSessionId, prompt);
    // A refused prompt carries the marker too: it must not land anywhere either.
    await refusedWith(promptCall(await ask(), person, prompt), "not_your_session");

    // People see it in the session: the prompt row and the session's detail.
    const [row] = await rowsOf("select body from app.work_prompts where id = $1", [queuedBody.promptId]);
    expect(row!.body).toContain(MARKER);
    const detail = await ok(victor.request("GET", `/api/v1/work-sessions/${workSessionId}`));
    expect(JSON.stringify(detail.prompts)).toContain(MARKER);

    const like = `%${MARKER}%`;
    expect(
      await rowsOf("select action from app.audit_events where to_jsonb(audit_events)::text like $1", [like]),
    ).toEqual([]);
    expect(
      await rowsOf("select id from app.agent_tool_calls where to_jsonb(agent_tool_calls)::text like $1", [
        like,
      ]),
    ).toEqual([]);
    expect(
      await rowsOf("select 1 from app.bot_work_sessions where to_jsonb(bot_work_sessions)::text like $1", [
        like,
      ]),
    ).toEqual([]);
    expect(
      await rowsOf("select 1 from app.message_cards where to_jsonb(message_cards)::text like $1", [like]),
    ).toEqual([]);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.filter((l) => l.includes(MARKER))).toEqual([]);
  });
});
