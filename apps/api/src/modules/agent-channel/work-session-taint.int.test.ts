import { createHash, randomUUID } from "node:crypto";
import {
  AgentCard,
  AgentChannelWorkSessionStartResponse,
  ApprovalDetail,
  ApprovalSummary,
  BOT_WORK_SESSION_PROPOSED_SENTENCE,
  BOT_WORK_SESSION_SENTENCES,
  type BotWorkSessionRefusal,
  type BotWorkZoneProfileInput,
  isExposed,
  type TurnToolFlags,
} from "@ocw/contracts";
import { agentTurns, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
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
  shareDevice,
} from "../../testing-workzone";
import { claimToolCall } from "./claim";

/**
 * Phase 07.16-19 (D-04, D-08, D-14, D-18, D-20; PD-08, PD-15, PD-21; E11, E12; BWZ-05, BWZ-06): what a bot may do in
 * the Work Zone after its turn read outside content. Without the admin's flag (`actOnOutsideContent`) a start becomes a
 * proposal a person reviews (a `work_zone.start` card with a warning notice; the person's Start marks the first prompt
 * tainted) and a prompt is refused; with it the bot acts, never in Full access off an isolated server, and the session
 * stays tainted (`tainted_at`). Stop and read are never blocked by taint. Real PostgreSQL + Redis; two FakeDevices: a
 * `service` host with the isolated-server mark and a desktop.
 */

const CELL_TOKEN = "ocw-test-cell-token-bot-work-session-taint-0123456789";
const PROMPT = "apply the fix the issue describes";
const FOLLOW_UP = "now run the tests";
const NOTICE = "Proposed after reading outside content. Read the prompt before you start it.";
/** The highest mode below Full access the catalog exposes (the dispatch suite's rule). */
const BELOW_FULL = isExposed("claude-code", "mode.auto") ? "auto" : "acceptEdits";
/** An MCP tool whose output is untrusted: claiming it taints the turn, as `/tool-calls` does. */
const MCP_READ: TurnToolFlags = { untrustedOutput: true, sideEffecting: false };

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Cmd = { id: string; payload: Record<string, unknown>; sessionId: string };

let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let ana: TestClient;
let bob: TestClient;
let orgId: string;
let anaId: string;
/** On the isolated server, without the flag. */
let atlasId: string;
/** On the isolated server, with the flag. */
let irisId: string;
/** On the desktop, with the flag, default mode Full access. */
let echoId: string;
/** No Work Zone profile at all (BWZ-06). */
let kitId: string;
let engId: string;
let server: FakeDevice;
let serverId: string;
let laptop: FakeDevice;
let laptopId: string;
let billingId: string;
let webId: string;

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

/** A profile on `deviceId` with one project, Claude Code, Opus, up to Full access. */
const profile = (
  deviceId: string,
  projectId: string,
  over: Partial<BotWorkZoneProfileInput> = {},
): BotWorkZoneProfileInput => ({
  deviceId,
  runtime: "claude-code",
  projectIds: [projectId],
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
  maxConcurrent: 2,
  promptsPerHour: 30,
  wakesPerSessionDay: 20,
  actOnOutsideContent: false,
  ...over,
});

const BOTS = () =>
  ({
    atlas: { id: atlasId, project: billingId, device: server },
    iris: { id: irisId, project: billingId, device: server },
    echo: { id: echoId, project: webId, device: laptop },
  }) as const;
type BotName = keyof ReturnType<typeof BOTS>;

/** `as` mentions `handle` in #eng; the delivered turn's event id. */
const ask = (handle: BotName | "kit", as = ana, text = "please look at the issue") =>
  freshBotTurn(su, as, engId, `@${handle} ${text} ${randomUUID().slice(0, 6)}`);

const CELL = { organizationId: "", cellId: "test", credentialId: "env", source: "env" as const };

/** `claimToolCall` on `eventId`'s turn as its human (what `/tool-calls` does), with `flags`. */
async function claimOn(eventId: string, tool: string, flags: TurnToolFlags) {
  const [human] = await rowsOf("select user_id from app.agent_turns where event_id = $1", [eventId]);
  return stack.built.core.db.withTenant(
    { organizationId: orgId, userId: human!.user_id as string },
    async (tx: Tx) => {
      const [turn] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, eventId));
      return claimToolCall(tx, stack.built.core, {
        cell: { ...CELL, organizationId: orgId },
        turn: turn!,
        tool,
        flags,
        web: false,
        sourceKind: "mcp",
        sourceId: null,
        target: null,
        reason: null,
        metadata: { eventId },
      });
    },
  );
}

/** The turn reads an MCP result (untrusted output): from now on it is tainted. */
async function readOutside(eventId: string) {
  expect(await claimOn(eventId, "github__search_issues", MCP_READ)).toMatchObject({ allowed: true });
  expect((await rowsOf("select tainted from app.agent_turns where event_id = $1", [eventId]))[0]).toEqual({
    tainted: true,
  });
}

/** A fresh ask of `bot` whose turn then read outside content. */
async function taintedAsk(bot: BotName | "kit", as = ana): Promise<string> {
  const eventId = await ask(bot, as);
  await readOutside(eventId);
  return eventId;
}

const start = (bot: BotName, eventId: string, over: Json = {}, token = CELL_TOKEN) =>
  cell(
    "/work-sessions/start",
    { eventId, agentId: BOTS()[bot].id, projectId: BOTS()[bot].project, prompt: PROMPT, ...over },
    token,
  );

const promptCall = (bot: BotName, eventId: string, workSessionId: string, prompt = FOLLOW_UP) =>
  cell("/work-sessions/prompt", { eventId, agentId: BOTS()[bot].id, workSessionId, prompt });

const stopCall = (bot: BotName, eventId: string, workSessionId: string) =>
  cell("/work-sessions/stop", { eventId, agentId: BOTS()[bot].id, workSessionId });

const readCall = (bot: BotName, eventId: string, workSessionId: string) =>
  cell("/work-sessions/read", { eventId, agentId: BOTS()[bot].id, workSessionId });

/** The answer of a start that must have started. */
async function started(bot: BotName, eventId: string, over: Json = {}) {
  const r = await start(bot, eventId, over);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const body = AgentChannelWorkSessionStartResponse.parse(r.body);
  if (body.kind !== "started") throw new Error(`not started: ${JSON.stringify(body)}`);
  return body;
}

/** An answer that must be the refusal `code`, with its fixed sentence. */
async function refusedWith(res: Promise<{ status: number; body: Json }>, code: BotWorkSessionRefusal) {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.kind, JSON.stringify(r.body)).toBe("refused");
  expect(r.body.code, JSON.stringify(r.body)).toBe(code);
  expect(r.body.sentence).toBe(BOT_WORK_SESSION_SENTENCES[code]);
  return r.body;
}

const rowsOf = async (q: string, args: unknown[] = []) => (await su.query(q, args)).rows as Json[];

const auditsOf = (action: string, eventId: string) =>
  rowsOf(
    "select actor_kind, actor_id, agent_id, user_id, device_id, result, metadata from app.audit_events where action = $1 and metadata->>'eventId' = $2 order by occurred_at",
    [action, eventId],
  );

/** The `bot.work_session_*` audit rows of one call (one event id per call). */
const botAuditsOf = (eventId: string) =>
  rowsOf(
    "select action, result, metadata from app.audit_events where action like 'bot.work_session_%' and metadata->>'eventId' = $1 order by occurred_at",
    [eventId],
  );

const toolCallsOf = (eventId: string, tool: string) =>
  rowsOf(
    "select decision, reason from app.agent_tool_calls where event_id = $1 and tool = $2 order by created_at",
    [eventId, tool],
  );

async function counts() {
  const [r] = await rowsOf(
    `select (select count(*)::int from app.work_sessions) as sessions,
            (select count(*)::int from app.work_prompts) as prompts,
            (select count(*)::int from app.bot_work_sessions) as bots,
            (select count(*)::int from app.work_zone_proposals) as proposals`,
  );
  return r;
}

const sessionRow = async (id: string) =>
  (
    await rowsOf(
      "select created_by, started_by_agent_id, permission_mode, tainted_at from app.work_sessions where id = $1",
      [id],
    )
  )[0]!;

const promptsOf = (workSessionId: string) =>
  rowsOf(
    "select id, author_user_id, author_agent_id, proposed_by_agent_id, body, status, tainted from app.work_prompts where work_session_id = $1 order by created_at",
    [workSessionId],
  );

/** The device takes the session: `session.start` acked, the runtime idle in `mode`; the first prompt arrives. */
async function take(device: FakeDevice, workSessionId: string, mode: string): Promise<Cmd> {
  const cmd = await device.command("session.start", workSessionId);
  device.ack(cmd.id as string);
  device.event(workSessionId, {
    type: "session.started",
    runtime: "claude-code",
    runtimeSessionId: `rt-${workSessionId}`,
    model: "opus",
    permissionMode: mode,
  });
  device.event(workSessionId, { type: "session.state", status: "idle" });
  const first = (await device.command("prompt", workSessionId)) as Cmd;
  device.ack(first.id);
  return first;
}

/** The runtime finishes the turn of `cmd` and the prompt is completed. */
async function finishTurn(device: FakeDevice, workSessionId: string, cmd: Cmd, text = "done") {
  device.emitTurn(workSessionId, { promptId: cmd.payload.promptId as string, text });
  await eventually(async () => {
    const [p] = await rowsOf("select status from app.work_prompts where id = $1", [cmd.payload.promptId]);
    return p?.status === "completed";
  });
}

/**
 * Every session of these tests ends before the next test, and the hour's prompts are forgotten, so each case starts
 * from zero active sessions and an empty prompt budget.
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
  ({ client: ana, userId: anaId } = await invite(stack, victor, "ana@example.test", "Ana Gil", "developer"));
  let bobId: string;
  ({ client: bob, userId: bobId } = await invite(stack, victor, "bob@example.test", "Bob Ros", "developer"));
  atlasId = await teamBot("Atlas", "atlas");
  irisId = await teamBot("Iris", "iris");
  echoId = await teamBot("Echo", "echo");
  kitId = await teamBot("Kit", "kit");
  // Public #eng: Víctor, Ana, Bob and the four bots.
  engId = (await ok(victor.request("POST", "/api/v1/channels", { name: "eng", visibility: "public" })))
    .id as string;
  for (const botId of [atlasId, irisId, echoId, kitId]) {
    await ok(victor.request("POST", `/api/v1/channels/${engId}/members`, { kind: "agent", id: botId }));
  }
  for (const userId of [anaId, bobId]) {
    await ok(victor.request("POST", `/api/v1/channels/${engId}/members`, { kind: "user", id: userId }));
  }

  await ok(victor.request("PUT", "/api/v1/work-zone-policy", { allowFullAccess: true, allowFastMode: true }));

  // Víctor's build server: a service host with the isolated-server mark and its own Full access opt-in.
  const paired = await pairDevice(stack, victor, "billing-server");
  serverId = paired.deviceId;
  server = await FakeDevice.connect(stack.baseUrl, paired.token, undefined, {
    host: "service",
    isolatedServer: true,
  });
  server.send({
    type: "projects.sync",
    projects: [{ localId: "lp_billing", name: "billing-api", gitRemote: null, defaultBranch: "main" }],
  });
  await server.next((f) => f.type === "projects.ack");
  server.capabilities([CLAUDE_CATALOG, CODEX_CATALOG], true, true);

  // Víctor's laptop: a desktop host (never isolated) with Full access turned on locally.
  const pairedLaptop = await pairDevice(stack, victor, "victor-laptop");
  laptopId = pairedLaptop.deviceId;
  laptop = await FakeDevice.connect(stack.baseUrl, pairedLaptop.token, undefined, { host: "desktop" });
  laptop.send({
    type: "projects.sync",
    projects: [{ localId: "lp_web", name: "web-app", gitRemote: null, defaultBranch: "main" }],
  });
  await laptop.next((f) => f.type === "projects.ack");
  laptop.capabilities([CLAUDE_CATALOG, CODEX_CATALOG], true);

  await eventually(async () => {
    const r = await su.query(
      "select id, runtime_catalog, full_access_opt_in, host_kind, isolated_server from app.devices where id = any($1)",
      [[serverId, laptopId]],
    );
    const s = r.rows.find((d) => d.id === serverId);
    const l = r.rows.find((d) => d.id === laptopId);
    return (
      (s?.runtime_catalog as unknown[] | undefined)?.length === 2 &&
      s.full_access_opt_in === true &&
      s.host_kind === "service" &&
      s.isolated_server === true &&
      (l?.runtime_catalog as unknown[] | undefined)?.length === 2 &&
      l.full_access_opt_in === true &&
      l.isolated_server === false
    );
  });
  const list = (await ok(victor.request("GET", "/api/v1/projects"))).projects as Json[];
  billingId = list.find((p) => p.name === "billing-api")!.id as string;
  webId = list.find((p) => p.name === "web-app")!.id as string;
  // Ana may use the server (a proposal is started by the person it was proposed for); Bob may not.
  await shareDevice(victor, serverId, anaId);

  // Víctor (admin) gives the bots their profiles (he is their sponsor); each device allows its bots with Full access.
  await createBotProfile(victor, atlasId, profile(serverId, billingId));
  await createBotProfile(victor, irisId, profile(serverId, billingId, { actOnOutsideContent: true }));
  await createBotProfile(
    victor,
    echoId,
    profile(laptopId, webId, { actOnOutsideContent: true, defaultMode: "fullAccess" }),
  );
  await grantBotConsent(victor, serverId, atlasId, { allowFullAccess: true });
  await grantBotConsent(victor, serverId, irisId, { allowFullAccess: true });
  await grantBotConsent(victor, laptopId, echoId, { allowFullAccess: true });
}, 180_000);

afterAll(async () => {
  await server?.close().catch(() => {});
  await laptop?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

beforeEach(async () => {
  await quiesce();
});

// ---------------------------------------------------------------- without the flag: a proposal (D-08, D-18, E11)

/** The pending proposal of a turn and its approval request. */
async function proposalOf(eventId: string) {
  const [p] = await rowsOf("select * from app.work_zone_proposals where event_id = $1", [eventId]);
  const [a] = await rowsOf(
    "select id, status, card_message_id, requested_for_user_id from app.approval_requests where resource_id = $1",
    [p?.id],
  );
  return { proposal: p, approval: a };
}

describe("tracer: without the admin's flag a tainted start becomes a proposal a person reviews (D-08, D-18, E11)", () => {
  it("answers proposed: no session, one tainted proposal with the profile's device and runtime, a card with the notice", async () => {
    const eventId = await taintedAsk("atlas");
    const before = await counts();
    const r = await start("atlas", eventId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const body = AgentChannelWorkSessionStartResponse.parse(r.body);
    if (body.kind !== "proposed") throw new Error(`not proposed: ${JSON.stringify(body)}`);
    expect(body).toEqual({
      kind: "proposed",
      approvalId: expect.any(String),
      reason: "outside_content",
      sentence: BOT_WORK_SESSION_PROPOSED_SENTENCE,
    });

    // No session; exactly one proposal, for the asker, on the profile's device and runtime, with the prompt.
    expect(await counts()).toEqual({ ...before, proposals: before!.proposals + 1 });
    expect(await rowsOf("select 1 from app.bot_work_sessions where origin_event_id = $1", [eventId])).toEqual(
      [],
    );
    const { proposal, approval } = await proposalOf(eventId);
    expect(proposal).toMatchObject({
      agent_id: atlasId,
      requested_for_user_id: anaId,
      conversation_id: engId,
      project_id: billingId,
      device_id: serverId,
      runtime: "claude-code",
      prompt: PROMPT,
      tainted: true,
      work_session_id: null,
    });
    expect(approval).toMatchObject({ id: body.approvalId, status: "pending", requested_for_user_id: anaId });

    // One platform work_zone card by Atlas in #eng with the proposal's fields and the warning notice.
    const [message] = await rowsOf(
      "select conversation_id, author_kind, author_id from app.messages where id = $1",
      [approval!.card_message_id],
    );
    expect(message).toEqual({ conversation_id: engId, author_kind: "agent", author_id: atlasId });
    const card = AgentCard.parse(await ok(ana.request("GET", `/api/v1/cards/${approval!.card_message_id}`)));
    expect(card).toMatchObject({
      kind: "work_zone",
      status: "pending",
      platformOwned: true,
      title: "Start a session in billing-api",
      notices: [{ tone: "warning", text: NOTICE }],
    });
    expect(card.fields).toEqual([
      { label: "Project", value: "billing-api" },
      { label: "Device", value: "billing-server · Online" },
      { label: "Runtime", value: "Claude Code" },
      { label: "Mode", value: "Supervised" },
      { label: "For", value: "Ana Gil · proposed by Atlas" },
      { label: "Prompt", value: PROMPT },
    ]);
    expect(card.viewerCan).toContain("decide");

    // The call was claimed on the tainted turn (it counts), said so, and named the fallback.
    expect(await toolCallsOf(eventId, "ocw_work_session_start")).toEqual([
      { decision: "allowed", reason: null },
    ]);
    const [claimed] = (await auditsOf("bot.tool_call", eventId)).filter(
      (a) => a.metadata.tool === "ocw_work_session_start",
    );
    expect(claimed!.metadata).toMatchObject({ outsideContent: true, fallback: "proposal" });

    // Audits: the proposal's (tainted) and the bot's (`proposed`, outside content, the approval); no refusal.
    const proposed = await auditsOf("work_zone.proposed", eventId);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ actor_kind: "agent", actor_id: atlasId, user_id: anaId });
    expect(proposed[0]!.metadata).toMatchObject({ tainted: true, approvalId: body.approvalId });
    const bot = await auditsOf("bot.work_session_proposed", eventId);
    expect(bot).toHaveLength(1);
    expect(bot[0]).toMatchObject({
      actor_kind: "agent",
      actor_id: atlasId,
      user_id: anaId,
      result: "success",
    });
    expect(bot[0]!.metadata).toMatchObject({
      outcome: "proposed",
      outsideContent: true,
      approvalId: body.approvalId,
      projectId: billingId,
    });
    expect(await auditsOf("bot.work_session_refused", eventId)).toEqual([]);
  });

  it("Ana presses Start: a session in her name, mode default, its first prompt tainted and proposed by Atlas", async () => {
    const eventId = await taintedAsk("atlas");
    const r = await start("atlas", eventId);
    expect(r.body.kind, JSON.stringify(r.body)).toBe("proposed");
    const approvalId = r.body.approvalId as string;

    const review = ApprovalDetail.parse(await ok(ana.request("GET", `/api/v1/approvals/${approvalId}`)));
    expect(review.view).toMatchObject({ type: "work_zone_proposal", mode: "default", prompt: PROMPT });
    const decided = await ana.request("POST", `/api/v1/approvals/${approvalId}/decision`, {
      outcome: "approved",
      actionHash: review.actionHash,
    });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(ApprovalSummary.parse(decided.body).status).toBe("applied");

    const { proposal } = await proposalOf(eventId);
    const workSessionId = proposal!.work_session_id as string;
    expect(workSessionId).toBeTruthy();
    // The person's session: not started by a bot, not tainted (only its first prompt is).
    expect(await sessionRow(workSessionId)).toEqual({
      created_by: anaId,
      started_by_agent_id: null,
      permission_mode: "default",
      tainted_at: null,
    });
    expect(
      (await promptsOf(workSessionId)).map((p) => [
        p.author_user_id,
        p.author_agent_id,
        p.proposed_by_agent_id,
        p.tainted,
      ]),
    ).toEqual([[anaId, null, atlasId, true]]);
    const cmd = await server.command("session.start", workSessionId);
    expect(cmd.payload.permissionMode).toBe("default");
    server.ack(cmd.id as string);
  });

  it("a proposal the asker cannot make (Bob may not use the server) answers outside_content, its code in the audit", async () => {
    const eventId = await taintedAsk("atlas", bob);
    const before = await counts();
    await refusedWith(start("atlas", eventId), "outside_content");
    expect(await counts()).toEqual(before);
    const refusal = await auditsOf("bot.work_session_refused", eventId);
    expect(refusal).toHaveLength(1);
    expect(refusal[0]!.metadata).toMatchObject({
      outcome: "outside_content",
      outsideContent: true,
      proposalRefusal: "device_not_shared",
    });
    expect(await auditsOf("bot.work_session_proposed", eventId)).toEqual([]);
  });

  it("organization B's cell token with organization A's tainted event → 404 unknown_turn, no proposal", async () => {
    const orgB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
      orgB,
      `evil-${orgB}`,
    ]);
    const tokenB = `ocw_cell_${randomUUID()}${randomUUID()}`;
    await su.query(
      "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
      [orgB, createHash("sha256").update(tokenB).digest("hex")],
    );
    const eventId = await taintedAsk("atlas");
    const before = await counts();
    const r = await start("atlas", eventId, {}, tokenB);
    expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect(r.body.error.code).toBe("unknown_turn");
    expect(await counts()).toEqual(before);
    expect(await toolCallsOf(eventId, "ocw_work_session_start")).toEqual([]);
  });
});

// ---------------------------------------------------------------- with the flag (D-04, D-08, PD-08, PD-15, E11, E12)

/** `bot` starts a session from an untainted ask and its device takes it; the first prompt has reached the device. */
async function untaintedSession(bot: BotName, over: Json = {}, mode = "default") {
  const body = await started(bot, await ask(bot), over);
  const first = await take(BOTS()[bot].device, body.workSessionId, mode);
  return { workSessionId: body.workSessionId, first, mode: body.mode };
}

/** The answer of a prompt that must have been queued. */
async function queued(bot: BotName, eventId: string, workSessionId: string, prompt = FOLLOW_UP) {
  const r = await promptCall(bot, eventId, workSessionId, prompt);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.kind, JSON.stringify(r.body)).toBe("queued");
  return r.body as { workSessionId: string; promptId: string };
}

describe("with the admin's flag the bot acts on outside content, never in bypass off an isolated server", () => {
  it("desktop: an explicit fullAccess answers outside_content_bypass and creates nothing (E11)", async () => {
    const eventId = await taintedAsk("echo");
    const before = await counts();
    await refusedWith(start("echo", eventId, { permissionMode: "fullAccess" }), "outside_content_bypass");
    expect(await counts()).toEqual(before);
    // Refused before the claim: a denied call that does not count, audited with the outside-content mark.
    expect(await toolCallsOf(eventId, "ocw_work_session_start")).toEqual([
      { decision: "denied", reason: "outside_content_bypass" },
    ]);
    expect(
      (await rowsOf("select tool_calls from app.agent_turns where event_id = $1", [eventId]))[0],
    ).toEqual({
      tool_calls: 1,
    });
    const refusal = await auditsOf("bot.work_session_refused", eventId);
    expect(refusal.map((a) => a.metadata)).toEqual([
      expect.objectContaining({ outcome: "outside_content_bypass", outsideContent: true }),
    ]);
  });

  it("desktop: without a mode the start runs at the highest mode below Full access, tainted for good", async () => {
    const eventId = await taintedAsk("echo");
    const body = await started("echo", eventId);
    expect(body.mode).toBe(BELOW_FULL);
    const s = await sessionRow(body.workSessionId);
    expect(s).toMatchObject({ started_by_agent_id: echoId, permission_mode: BELOW_FULL });
    expect(s.tainted_at).not.toBeNull();
    expect((await promptsOf(body.workSessionId)).map((p) => [p.author_agent_id, p.tainted])).toEqual([
      [echoId, true],
    ]);
    const first = await take(laptop, body.workSessionId, BELOW_FULL);
    expect(first.payload.permissionMode).toBe(BELOW_FULL);
    // The claim and the start say they acted on outside content.
    const [claimed] = (await auditsOf("bot.tool_call", eventId)).filter(
      (a) => a.metadata.tool === "ocw_work_session_start",
    );
    expect(claimed!.metadata).toMatchObject({ outsideContent: true });
    expect(claimed!.metadata).not.toHaveProperty("fallback");
    const [audit] = await auditsOf("bot.work_session_started", eventId);
    expect(audit!.metadata).toMatchObject({ outcome: "started", outsideContent: true, mode: BELOW_FULL });
    expect(await rowsOf("select 1 from app.work_zone_proposals where event_id = $1", [eventId])).toEqual([]);
  });

  it("isolated server: with the consent's Full access a tainted start runs in Full access, still tainted", async () => {
    const eventId = await taintedAsk("iris");
    const body = await started("iris", eventId, { permissionMode: "fullAccess" });
    expect(body.mode).toBe("fullAccess");
    const s = await sessionRow(body.workSessionId);
    expect(s).toMatchObject({ started_by_agent_id: irisId, permission_mode: "fullAccess" });
    expect(s.tainted_at).not.toBeNull();
    expect((await promptsOf(body.workSessionId)).map((p) => p.tainted)).toEqual([true]);
    const first = await take(server, body.workSessionId, "fullAccess");
    expect(first.payload.permissionMode).toBe("fullAccess");
  });

  it("a tainted prompt without the flag answers outside_content and queues nothing", async () => {
    const { workSessionId, first } = await untaintedSession("atlas");
    await finishTurn(server, workSessionId, first);
    const eventId = await taintedAsk("atlas");
    const r = await refusedWith(promptCall("atlas", eventId, workSessionId), "outside_content");
    expect(r).not.toHaveProperty("reason");
    expect(await promptsOf(workSessionId)).toHaveLength(1);
    expect((await sessionRow(workSessionId)).tainted_at).toBeNull();
    const [audit] = await auditsOf("bot.work_session_refused", eventId);
    expect(audit!.metadata).toMatchObject({ outcome: "outside_content", outsideContent: true });
  });

  it("a tainted prompt with the flag is queued tainted and taints the session once (tainted_at kept)", async () => {
    const { workSessionId, first } = await untaintedSession("echo", {}, "fullAccess");
    expect((await sessionRow(workSessionId)).tainted_at).toBeNull();
    await finishTurn(laptop, workSessionId, first);
    const eventId = await taintedAsk("echo");
    const q = await queued("echo", eventId, workSessionId);
    const prompts = await promptsOf(workSessionId);
    expect(prompts.map((p) => [p.id, p.author_agent_id, p.tainted])).toEqual([
      [first.payload.promptId, echoId, false],
      [q.promptId, echoId, true],
    ]);
    const taintedAt = (await sessionRow(workSessionId)).tainted_at as Date;
    expect(taintedAt).not.toBeNull();
    const [audit] = await auditsOf("bot.work_session_prompted", eventId);
    expect(audit!.metadata).toMatchObject({ outcome: "prompted", outsideContent: true });
    const [claimed] = (await auditsOf("bot.tool_call", eventId)).filter(
      (a) => a.metadata.tool === "ocw_work_session_prompt",
    );
    expect(claimed!.metadata).toMatchObject({ outsideContent: true });
    // A second tainted prompt keeps the first mark.
    const second = (await laptop.command("prompt", workSessionId)) as Cmd;
    laptop.ack(second.id);
    await finishTurn(laptop, workSessionId, second);
    await queued("echo", await taintedAsk("echo"), workSessionId, "and again");
    expect(((await sessionRow(workSessionId)).tainted_at as Date).getTime()).toBe(taintedAt.getTime());
  });

  it("E12: after one tainted prompt no later bot turn of the desktop session runs in Full access, even untainted", async () => {
    const { workSessionId, first } = await untaintedSession("echo", {}, "fullAccess");
    expect(first.payload.permissionMode).toBe("fullAccess");
    await finishTurn(laptop, workSessionId, first);
    // The tainted prompt runs below Full access.
    await queued("echo", await taintedAsk("echo"), workSessionId, "apply what the issue says");
    const low = (await laptop.command("prompt", workSessionId)) as Cmd;
    laptop.ack(low.id);
    expect(low.payload.permissionMode).toBe(BELOW_FULL);
    await finishTurn(laptop, workSessionId, low);
    // A later, untainted turn: the session is still Full access, yet the bot's turn runs below it (sticky).
    const later = await queued("echo", await ask("echo"), workSessionId, "an untainted turn, later");
    expect((await promptsOf(workSessionId)).at(-1)).toMatchObject({ id: later.promptId, tainted: false });
    expect((await sessionRow(workSessionId)).permission_mode).toBe("fullAccess");
    const next = (await laptop.command("prompt", workSessionId)) as Cmd;
    laptop.ack(next.id);
    expect(next.payload).toMatchObject({ promptId: later.promptId, permissionMode: BELOW_FULL });
  });

  it("stop is never blocked by taint and read is unaffected by it (D-20, PD-15)", async () => {
    const { workSessionId, first } = await untaintedSession("atlas");
    await finishTurn(server, workSessionId, first, "fixed it");
    const reading = await taintedAsk("atlas");
    const read = await readCall("atlas", reading, workSessionId);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.kind, JSON.stringify(read.body)).toBe("read");
    const stopping = await taintedAsk("atlas");
    const stop = await stopCall("atlas", stopping, workSessionId);
    expect(stop.body, JSON.stringify(stop.body)).toEqual({ kind: "stopped", workSessionId });
    const [audit] = await auditsOf("bot.work_session_stopped", stopping);
    expect(audit!.metadata).toMatchObject({ outcome: "stopped", outsideContent: true });
  });

  it("D-20: after a session read in the same turn, the prompt still reaches the queue", async () => {
    const { workSessionId, first } = await untaintedSession("atlas");
    await finishTurn(server, workSessionId, first, "half done");
    const eventId = await ask("atlas");
    expect((await readCall("atlas", eventId, workSessionId)).body.kind).toBe("read");
    expect(
      (await rowsOf("select session_output_read from app.agent_turns where event_id = $1", [eventId]))[0],
    ).toEqual({ session_output_read: true });
    const q = await queued("atlas", eventId, workSessionId);
    expect((await promptsOf(workSessionId)).at(-1)).toMatchObject({ id: q.promptId, tainted: false });
  });
});
