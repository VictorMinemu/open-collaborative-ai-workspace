import { createHash, randomUUID } from "node:crypto";
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

// ---------------------------------------------------------------- bounds, cursor, relative paths, redaction (E9, E10)

/**
 * A row the API stored without its ingestion filters (written as `appendEvent` writes it): the read's own filters must
 * hold even then (defense in depth over the device's `contain()` and the ingestion's `onlyRelativePaths`).
 */
async function appendRaw(workSessionId: string, type: string, payload: unknown) {
  const topic = `ws:${workSessionId}`;
  const [row] = await rowsOf(
    "insert into app.streams (id, organization_id, last_seq) values ($1, $2, 1) on conflict (id) do update set last_seq = app.streams.last_seq + 1 returning last_seq",
    [topic, orgId],
  );
  await su.query(
    "insert into app.stream_events (stream_id, seq, organization_id, type, payload) values ($1, $2, $3, $4, $5::jsonb)",
    [topic, row!.last_seq, orgId, type, JSON.stringify(payload)],
  );
}

/** The runtime reports one turn of `cmd` with several assistant messages (and optional tool events) in order. */
async function turnWith(workSessionId: string, cmd: Cmd, events: Array<Record<string, unknown>>) {
  const promptId = cmd.payload.promptId as string;
  server.event(workSessionId, { type: "prompt.started", promptId });
  for (const ev of events) server.event(workSessionId, ev);
  server.event(workSessionId, {
    type: "prompt.completed",
    promptId,
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  await eventually(async () => {
    const [p] = await rowsOf("select status from app.work_prompts where id = $1", [promptId]);
    return p?.status === "completed";
  });
}

const message = (text: string) => ({ type: "assistant.message", messageId: randomUUID(), text });

describe("what the bot reads is bounded, relative and scrubbed (PD-14, principle 7)", () => {
  it("E9: a session with no output yet → no texts, no tools, no changes, not truncated, the snapshot cursor", async () => {
    const { workSessionId } = await botSession();
    const body = await read(await ask(), workSessionId);
    expect(body.output).toEqual({ texts: [], truncated: false });
    expect(body.tools).toEqual([]);
    expect(body.changes).toBeNull();
    expect(body.queue).toMatchObject({ running: 1, completed: 0 });
    expect(body.cursor).toBe(await lastSeqOf(workSessionId));
  });

  it("E10: 6 001 characters of output → the last 6 000, the newest message whole, truncated; the returned cursor reads nothing new", async () => {
    const { workSessionId, first } = await botSession();
    const [a, b, c] = ["a".repeat(2001), "b".repeat(2000), "c".repeat(2000)];
    await turnWith(workSessionId, first, [message(a), message(b), message(c)]);

    const eventId = await ask();
    const body = await read(eventId, workSessionId);
    const texts = body.output.texts.map((t) => t.text);
    expect(texts.join("").length).toBe(6000);
    expect(texts).toEqual(["a".repeat(2000), b, c]);
    expect(body.output.truncated).toBe(true);
    // Newest last, in stream order.
    const seqs = body.output.texts.map((t) => t.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    const [audit] = await auditsOf("bot.work_session_read", eventId);
    expect(audit!.metadata).toMatchObject({ chars: 6000, truncated: true, cursor: body.cursor });

    const again = await read(await ask(), workSessionId, body.cursor);
    expect(again.output).toEqual({ texts: [], truncated: false });
    expect(again.cursor).toBe(body.cursor);
    // A cursor between the messages returns only the newer ones.
    const later = await read(await ask(), workSessionId, seqs[1]);
    expect(later.output.texts.map((t) => t.text)).toEqual([c]);
  });

  it("tools: names, ok and summaries of the latest uses, never their output", async () => {
    const { workSessionId, first } = await botSession();
    const OUT = "OCW-tool-output-never-returned";
    await turnWith(workSessionId, first, [
      { type: "tool.started", toolUseId: "t1", name: "Bash", summary: "npm test" },
      { type: "tool.completed", toolUseId: "t1", ok: true, summary: "12 passed", output: OUT },
      { type: "tool.started", toolUseId: "t2", name: "Edit", summary: "src/invoice.ts" },
    ]);
    const body = await read(await ask(), workSessionId);
    expect(body.tools).toEqual([
      { name: "Bash", ok: true, summary: "npm test" },
      { name: "Edit", ok: null, summary: "src/invoice.ts" },
    ]);
    expect(JSON.stringify(body)).not.toContain(OUT);
  });

  it("changes and approvals carry repo-relative paths only, from the device and from a raw stored row", async () => {
    const { workSessionId, first } = await botSession();
    await finishTurn(workSessionId, first);
    // The FakeDevice sends the absolute path raw (no device-side filtering).
    await answerChanges(workSessionId, [
      { path: "/Users/ana/repo/secret.ts", status: "modified", additions: 1, deletions: 0 },
      { path: "src/a.ts", status: "added", additions: 4, deletions: 0 },
    ]);
    server.emitApproval(workSessionId, {
      approvalId: randomUUID(),
      tool: "Edit",
      paths: ["/etc/passwd", "src/b.ts"],
      summary: "Edit two files",
    });
    await eventually(async () => {
      const [s] = await rowsOf("select status from app.work_sessions where id = $1", [workSessionId]);
      return s?.status === "waiting_approval";
    });

    const body = await read(await ask(), workSessionId);
    expect(body.changes!.files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(body.approvals).toEqual([
      { id: expect.any(String), tool: "Edit", paths: ["src/b.ts"], summary: "Edit two files" },
    ]);
    const text = JSON.stringify(body);
    expect(text).not.toContain("/Users/ana");
    expect(text).not.toContain("/etc/passwd");

    // Rows stored without the ingestion filters (an older row, a bypass): the read filters them itself.
    await appendRaw(workSessionId, "work_session.changes", {
      files: [
        { path: "/Users/ana/repo/secret.ts", status: "modified", additions: 1, deletions: 0 },
        { path: "~/notes.md", status: "modified", additions: 1, deletions: 0 },
        { path: "../outside.ts", status: "modified", additions: 1, deletions: 0 },
        { path: "src/c.ts", status: "modified", additions: 2, deletions: 1 },
      ],
      branch: "ocw/raw",
      headSha: null,
      truncated: false,
      at: new Date().toISOString(),
    });
    await su.query(
      "insert into app.work_approvals (id, organization_id, work_session_id, request) values ($1, $2, $3, $4::jsonb)",
      [
        randomUUID(),
        orgId,
        workSessionId,
        JSON.stringify({
          tool: "Write",
          summary: "Write a file",
          paths: ["/etc/passwd", "C:\\x.ts", "src/d.ts"],
        }),
      ],
    );
    const raw = await read(await ask(), workSessionId);
    expect(raw.changes).toEqual({
      files: [{ path: "src/c.ts", status: "modified", additions: 2, deletions: 1 }],
      branch: "ocw/raw",
      truncated: false,
    });
    expect(raw.approvals.map((a) => a.paths)).toEqual([["src/b.ts"], ["src/d.ts"]]);
    const rawText = JSON.stringify(raw);
    for (const leak of ["/Users/ana", "/etc/passwd", "~/notes", "../outside", "C:\\\\x"]) {
      expect(rawText).not.toContain(leak);
    }
  });

  it("a secret in the output, a tool summary or the error is redacted before it is returned", async () => {
    // Fake, built at runtime so secret scanners do not read it as a real key; it still matches redactSecrets.
    const KEY = ["sk", "proj", "FAKE0716readNotASecret01"].join("-");
    const { workSessionId, first } = await botSession();
    await turnWith(workSessionId, first, [
      { type: "tool.started", toolUseId: "t1", name: "Bash", summary: `export OPENAI_API_KEY=${KEY}` },
      message(`I used the key ${KEY} to call the API.`),
    ]);
    const body = await read(await ask(), workSessionId);
    const text = JSON.stringify(body);
    expect(text).not.toContain(KEY);
    expect(body.output.texts[0]!.text).toContain("[REDACTED:api-key]");
    expect(body.tools[0]!.summary).toContain("[REDACTED");
  });

  it("a failed session → its error, redacted and cut to 500 characters", async () => {
    const KEY = ["sk", "proj", "FAKE0716errorNotASecret02"].join("-");
    const { workSessionId } = await botSession();
    await su.query("update app.work_sessions set status = 'failed', last_error = $2 where id = $1", [
      workSessionId,
      `The runtime crashed with ${KEY}. ${"x".repeat(900)}`,
    ]);
    const body = await read(await ask(), workSessionId);
    expect(body.session.status).toBe("failed");
    expect(body.error).not.toBeNull();
    expect(body.error!.length).toBe(500);
    expect(body.error).toContain("[REDACTED:api-key]");
    expect(body.error).not.toContain(KEY);
  });

  it("a person's prompt in the queue never appears: only counts and the bot's own prompts", async () => {
    const SECRET = "my password is hunter2";
    const { workSessionId, first } = await botSession();
    // Víctor (the sponsor, in the session's audience) queues his own prompt behind the running turn.
    const res = await victor.request("POST", `/api/v1/work-sessions/${workSessionId}/prompts`, {
      body: SECRET,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = await read(await ask(), workSessionId);
    expect(body.queue).toMatchObject({ queued: 1, running: 1 });
    expect(body.queue.mine.map((p) => p.id)).toEqual([first.payload.promptId]);
    const text = JSON.stringify(body);
    expect(text).not.toContain("hunter2");
    // The bot's own prompts are listed by id, status and position: no prompt text at all.
    expect(Object.keys(body.queue.mine[0]!).sort()).toEqual(["id", "position", "status"]);
  });
});

// ---------------------------------------------------------------- who may read, what a read blocks (D-06, D-20, PD-15)

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

/** A person's session on the build server (Víctor's own, through the human route). */
async function personSession(): Promise<string> {
  const res = await victor.request("POST", "/api/v1/work-sessions", { projectId: billingId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const id = res.body!.id as string;
  const start = await server.command("session.start", id);
  server.ack(start.id);
  return id;
}

describe("the bot reads only the sessions it started (D-06, PD-13, E15)", () => {
  it("a person's session, another bot's and organization B's → not_your_session; recorded without counting, no mark", async () => {
    const personal = await personSession();
    const echo = (await botSession({ id: echoId, handle: "echo" })).workSessionId;
    const foreign = await orgBSession();
    for (const workSessionId of [personal, echo, foreign]) {
      const eventId = await ask();
      await refusedWith(readCall(eventId, workSessionId), "not_your_session");
      // A refused read leaves the turn as it was: not counted, not marked.
      expect(await turnRow(eventId)).toMatchObject({ tool_calls: 0, session_output_read: false });
      expect(
        await rowsOf("select tool, decision, reason from app.agent_tool_calls where event_id = $1", [
          eventId,
        ]),
      ).toEqual([{ tool: "ocw_work_session_read", decision: "denied", reason: "not_your_session" }]);
      const audits = await auditsOf("bot.work_session_refused", eventId);
      expect(audits.map((a) => a.metadata)).toEqual([
        {
          eventId,
          tool: "ocw_work_session_read",
          sponsorUserId: null,
          workSessionId,
          outcome: "not_your_session",
        },
      ]);
      expect(await auditsOf("bot.work_session_read", eventId)).toEqual([]);
    }
  });

  it("the read tool not on the turn → not_in_turn, without the mark", async () => {
    const { workSessionId } = await botSession();
    const eventId = await ask();
    await su.query(
      "update app.agent_turns set tools = array_remove(tools, 'ocw_work_session_read') where event_id = $1",
      [eventId],
    );
    await refusedWith(readCall(eventId, workSessionId), "not_in_turn");
    expect(await turnRow(eventId)).toMatchObject({ tool_calls: 0, session_output_read: false });
  });

  it("with the consent revoked (profile inactive) the bot still reads its own session", async () => {
    const { workSessionId, first } = await botSession();
    await finishTurn(workSessionId, first);
    // The turn was delivered with the tools; the device's owner revokes the consent while it runs.
    const eventId = await ask();
    await ok(victor.request("DELETE", `/api/v1/devices/${serverId}/bot-consents/${atlasId}`));
    try {
      const body = await read(eventId, workSessionId);
      expect(body.output.texts.map((t) => t.text)).toEqual([OUTPUT]);
      expect((await turnRow(eventId)).session_output_read).toBe(true);
    } finally {
      await grantBotConsent(victor, serverId, atlasId, { allowFullAccess: true });
    }
  });
});

describe("after a read the turn's other side effects stay blocked (D-20, PD-15)", () => {
  let dmId: string;

  beforeAll(async () => {
    await ok(victor.request("PATCH", `/api/v1/agents/${atlasId}/capabilities`, { memory: true }));
    dmId = (await ok(ana.request("POST", `/api/v1/agents/${atlasId}/dm`))).dmId as string;
  });

  /** Ana's turn with Atlas in her DM, offered memory and the session read. */
  async function dmTurn(): Promise<string> {
    const eventId = await freshBotTurn(su, ana, dmId, `how is it going ${randomUUID().slice(0, 6)}`);
    const [turn] = await rowsOf("select tools from app.agent_turns where event_id = $1", [eventId]);
    expect(turn!.tools).toContain("ocw_memory_save");
    expect(turn!.tools).toContain("ocw_work_session_read");
    return eventId;
  }

  const save = (eventId: string, text = "Ana ships on Fridays") =>
    cell("/memories", { eventId, agentId: atlasId, text });

  it("ocw_memory_save in the same turn → refused tainted; a new turn that did not read saves as before", async () => {
    const { workSessionId, first } = await botSession();
    await finishTurn(workSessionId, first);
    const eventId = await dmTurn();
    await read(eventId, workSessionId);
    const refused = await save(eventId);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("tainted");
    // The turn's own taint is untouched: only the session-output flag refuses.
    expect(await turnRow(eventId)).toMatchObject({ tainted: false, session_output_read: true });

    const fresh = await dmTurn();
    const saved = await save(fresh, "Ana reviews on Mondays");
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  });

  it("ocw_work_session_start in the same turn → session_output; a refused read does not mark the turn", async () => {
    const { workSessionId } = await botSession();
    const eventId = await ask();
    await read(eventId, workSessionId);
    await refusedWith(
      cell("/work-sessions/start", { eventId, agentId: atlasId, projectId: billingId, prompt: FIRST }),
      "session_output",
    );

    // A turn whose only read was refused starts a session as before.
    const other = await ask();
    await refusedWith(readCall(other, await personSession()), "not_your_session");
    expect((await turnRow(other)).session_output_read).toBe(false);
    const started = await cell("/work-sessions/start", {
      eventId: other,
      agentId: atlasId,
      projectId: billingId,
      prompt: FIRST,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.kind).toBe("started");
  });
});

// ---------------------------------------------------------------- tenant isolation and the leak sweep (D-14, P1, E15)

describe("tenant isolation: organization B's cell cannot read organization A's sessions (E15)", () => {
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

  it("organization B's token with organization A's event → 404 unknown_turn; nothing claimed, the turn not marked", async () => {
    const { workSessionId, first } = await botSession();
    await finishTurn(workSessionId, first);
    const eventId = await ask();
    const r = await readCall(eventId, workSessionId, { token: tokenB });
    expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect(r.body.error.code).toBe("unknown_turn");
    expect(JSON.stringify(r.body)).not.toContain(OUTPUT);
    expect(await rowsOf("select 1 from app.agent_tool_calls where event_id = $1", [eventId])).toEqual([]);
    expect(await turnRow(eventId)).toMatchObject({ tool_calls: 0, session_output_read: false });
    const unknown = await rowsOf(
      "select organization_id, metadata from app.audit_events where action = 'bot.tool_call' and metadata->>'eventId' = $1",
      [eventId],
    );
    expect(unknown.map((u) => [u.metadata.tool, u.metadata.reason])).toEqual([
      ["ocw_work_session_read", "unknown_turn"],
    ]);
    expect(unknown.every((u) => u.organization_id !== orgId)).toBe(true);
  });

  it("another bot's event naming Atlas → 404 unknown_turn", async () => {
    const { workSessionId } = await botSession();
    const r = await readCall(await ask("echo"), workSessionId);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("unknown_turn");
  });
});

describe("the output is in no record: audit, tool calls or a log line (P1)", () => {
  it("an output holding OCW-MARKER-0716-output is returned by the read and stored nowhere else", async () => {
    const MARKER = "OCW-MARKER-0716-output";
    const { workSessionId, first } = await botSession();
    await turnWith(workSessionId, first, [
      { type: "tool.started", toolUseId: "t1", name: "Bash", summary: `echo ${MARKER}` },
      { type: "tool.completed", toolUseId: "t1", ok: true, summary: MARKER, output: MARKER },
      message(`Done: ${MARKER}`),
    ]);
    const body = await read(await ask(), workSessionId);
    expect(body.output.texts.map((t) => t.text)).toEqual([`Done: ${MARKER}`]);
    expect(body.tools[0]!.summary).toContain(MARKER);

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
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.filter((l) => l.includes(MARKER))).toEqual([]);
  });
});
