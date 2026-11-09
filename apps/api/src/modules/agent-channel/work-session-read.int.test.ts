import { randomUUID } from "node:crypto";
import {
  AgentChannelWorkSessionReadResponse,
  AgentChannelWorkSessionStartResponse,
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
  freshBotTurn,
  grantBotConsent,
  invite,
  pairDevice,
} from "../../testing-workzone";

/**
 * Phase 07.16-17 (D-05, D-10, D-14, D-20; PD-14, PD-15, PD-21; E9, E10, E15; BWZ-02, BWZ-03, BWZ-05): a bot reads what
 * its own Work Zone session did. `POST /agent-channel/v1/work-sessions/read` answers `BotWorkSessionReadModel`: the
 * session's state, the queue's counts and the bot's own prompts (never a person's text), the `assistant.message` texts
 * after the cursor (bounded, tail kept), the latest tools without output, the latest changes and the pending approvals
 * (repo-relative paths only), up to three deciders, the error and the snapshot cursor; every text through
 * `redactSecrets`. A read marks the turn (`session_output_read`, D-20). Real PostgreSQL + Redis; the device is a
 * FakeDevice reporting a `service` host with the isolated mark.
 */

const CELL_TOKEN = "ocw-test-cell-token-bot-work-session-read-0123456789";
const FIRST = "fix the failing invoice test";
const OUTPUT = "Fixed the rounding; 3 tests pass";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Cmd = { id: string; payload: Record<string, unknown>; sessionId: string };
type DiffFile = { path: string; status: string; additions: number; deletions: number };

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

/** A bot's profile on the build server: one repository, Claude Code, Opus only, up to Full access. */
const profile = (over: Partial<BotWorkZoneProfileInput> = {}): BotWorkZoneProfileInput => ({
  deviceId: serverId,
  runtime: "claude-code",
  projectIds: [billingId],
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
  maxConcurrent: 10,
  promptsPerHour: 120,
  wakesPerSessionDay: 20,
  actOnOutsideContent: false,
  ...over,
});

/** Ana asks `bot` in #eng; the delivered turn's event id. */
const ask = (bot = "atlas", conversationId = engId, as = ana) =>
  freshBotTurn(su, as, conversationId, `@${bot} how is the invoice fix going? ${randomUUID().slice(0, 6)}`);

const readCall = (
  eventId: string,
  workSessionId: string,
  opts: { cursor?: number; agentId?: string; token?: string } = {},
) =>
  cell(
    "/work-sessions/read",
    {
      eventId,
      agentId: opts.agentId ?? atlasId,
      workSessionId,
      ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
    },
    opts.token,
  );

/** The answer of a read that must have read. */
async function read(eventId: string, workSessionId: string, cursor?: number) {
  const r = await readCall(eventId, workSessionId, cursor !== undefined ? { cursor } : {});
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const body = AgentChannelWorkSessionReadResponse.parse(r.body);
  if (body.kind !== "read") throw new Error(`not read: ${JSON.stringify(body)}`);
  return body;
}

/** A read answer that must be the refusal `code`, with its fixed sentence. */
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
    "select actor_kind, actor_id, agent_id, user_id, device_id, session_id, resource_type, resource_id, result, metadata from app.audit_events where action = $1 and metadata->>'eventId' = $2 order by occurred_at",
    [action, eventId],
  );

const turnRow = async (eventId: string) =>
  (
    await rowsOf("select tool_calls, tainted, session_output_read from app.agent_turns where event_id = $1", [
      eventId,
    ])
  )[0]!;

/** The last seq of the session's stream, as the snapshot cut reads it. */
const lastSeqOf = async (workSessionId: string) =>
  Number(
    (
      await rowsOf("select coalesce(max(seq), 0) as n from app.stream_events where stream_id = $1", [
        `ws:${workSessionId}`,
      ])
    )[0]!.n,
  );

/**
 * `bot` starts a session (from a fresh ask of Ana in #eng) and the device takes it: `session.start` acked, the runtime
 * reports the session idle, and the first prompt (the start's own) reaches the device.
 */
async function botSession(
  bot: { id: string; handle: string } = { id: atlasId, handle: "atlas" },
): Promise<{ workSessionId: string; first: Cmd }> {
  const eventId = await ask(bot.handle);
  const r = await cell("/work-sessions/start", {
    eventId,
    agentId: bot.id,
    projectId: billingId,
    prompt: FIRST,
  });
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

/** The runtime finishes the turn of `cmd` (started → `text` → completed) and the prompt is completed. */
async function finishTurn(workSessionId: string, cmd: Cmd, text = OUTPUT) {
  server.emitTurn(workSessionId, { promptId: cmd.payload.promptId as string, text });
  await eventually(async () => {
    const [p] = await rowsOf("select status from app.work_prompts where id = $1", [cmd.payload.promptId]);
    return p?.status === "completed";
  });
}

/**
 * The device answers the Changes refresh the server asks for after a turn (`diff.request`) with `files`, sent raw (no
 * device-side filtering), and the API persists its `work_session.changes`.
 */
async function answerChanges(workSessionId: string, files: DiffFile[], branch = "ocw/invoice-fix") {
  const req = await server.command("diff.request", workSessionId);
  const before = await changesCount(workSessionId);
  server.send({ type: "diff.result", requestId: req.id, files, patch: "", branch, headSha: "abc123" });
  server.ack(req.id);
  await eventually(async () => (await changesCount(workSessionId)) > before);
}

const changesCount = async (workSessionId: string) =>
  Number(
    (
      await rowsOf(
        "select count(*)::int as n from app.stream_events where stream_id = $1 and type = 'work_session.changes'",
        [`ws:${workSessionId}`],
      )
    )[0]!.n,
  );

/** Every session of these tests ends before the next one: each case starts from zero active sessions. */
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
  // Public #eng: Víctor and Ana read it.
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
    projects: [{ localId: "lp_billing-api", name: "billing-api", gitRemote: null, defaultBranch: "main" }],
  });
  await server.next((f) => f.type === "projects.ack");
  server.capabilities([CLAUDE_CATALOG, CODEX_CATALOG], true, true);
  await eventually(async () => {
    const r = await su.query(
      "select runtime_catalog, host_kind, isolated_server from app.devices where id = $1",
      [serverId],
    );
    const d = r.rows[0];
    return (d.runtime_catalog as unknown[]).length === 2 && d.host_kind === "service" && d.isolated_server;
  });
  const list = (await ok(victor.request("GET", "/api/v1/projects"))).projects as Json[];
  billingId = list.find((p) => p.name === "billing-api")!.id as string;

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

// ---------------------------------------------------------------- tracer: the read model and the turn's mark (PD-14)

describe("tracer: Atlas reads what its session did, and the turn is marked", () => {
  it("answers the session's state, its output, its changes, the bot's prompt, the deciders and the snapshot cursor", async () => {
    const { workSessionId, first } = await botSession();
    await finishTurn(workSessionId, first);
    await answerChanges(workSessionId, [
      { path: "src/invoice.ts", status: "modified", additions: 3, deletions: 1 },
    ]);

    const eventId = await ask();
    const body = await read(eventId, workSessionId);
    expect(body.session).toMatchObject({
      id: workSessionId,
      status: "idle",
      runtime: "claude-code",
      model: "opus",
      mode: "default",
      worktree: true,
      projectName: "billing-api",
    });
    expect(body.output.texts.map((t) => t.text)).toEqual([OUTPUT]);
    expect(body.output.truncated).toBe(false);
    expect(body.changes).toEqual({
      files: [{ path: "src/invoice.ts", status: "modified", additions: 3, deletions: 1 }],
      branch: "ocw/invoice-fix",
      truncated: false,
    });
    expect(body.queue).toMatchObject({ queued: 0, running: 0, completed: 1, failed: 0, cancelled: 0 });
    expect(body.queue.mine).toEqual([{ id: first.payload.promptId, status: "completed", position: 1 }]);
    expect(body.approvals).toEqual([]);
    expect(body.deciders[0]).toMatchObject({ id: victorId, displayName: "Víctor Ruiz" });
    expect(body.deciders[0]!.handle.length).toBeGreaterThan(0);
    expect(body.error).toBeNull();
    expect(body.cursor).toBe(await lastSeqOf(workSessionId));
  });

  it("sets session_output_read on the turn and audits bot.work_session_read with ids, the cursor, chars and truncated only", async () => {
    const { workSessionId, first } = await botSession();
    await finishTurn(workSessionId, first);
    const eventId = await ask();
    expect((await turnRow(eventId)).session_output_read).toBe(false);
    const body = await read(eventId, workSessionId);

    expect(await turnRow(eventId)).toMatchObject({
      session_output_read: true,
      tool_calls: 1,
      tainted: false,
    });
    const audits = await auditsOf("bot.work_session_read", eventId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_kind: "agent",
      actor_id: atlasId,
      agent_id: atlasId,
      user_id: anaId,
      device_id: serverId,
      session_id: workSessionId,
      resource_type: "work_session",
      resource_id: workSessionId,
      result: "success",
    });
    expect(audits[0]!.metadata).toEqual({
      eventId,
      sponsorUserId: victorId,
      workSessionId,
      cursor: body.cursor,
      chars: OUTPUT.length,
      truncated: false,
    });
    expect(
      await rowsOf("select tool, decision, target from app.agent_tool_calls where event_id = $1", [eventId]),
    ).toEqual([{ tool: "ocw_work_session_read", decision: "allowed", target: workSessionId }]);
  });
});
