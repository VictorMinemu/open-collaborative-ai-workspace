import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentChannelWorkSessionDownloadResponse,
  AgentChannelWorkSessionStartResponse,
  AgentChannelWorkSessionUploadResponse,
  BOT_WORK_SESSION_SENTENCES,
  type BotWorkSessionRefusal,
  type BotWorkZoneProfileInput,
} from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "../../testing";
import { eventually, FakeDevice, type Frame } from "../../testing-device";
import { startTestStorage, type TestStorage, uploadAttachment } from "../../testing-storage";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  createBotProfile,
  grantBotConsent,
  invite,
  pairDevice,
} from "../../testing-workzone";

/**
 * 07.17.1.1-12 (D-01, D-02, D-05, D-07, D-09, D-12; PD-06, PD-13, PD-14, PD-16, PD-18; E3, E5, E19, E20; BWF-01,
 * BWF-02, BWF-05, BWF-07): the phase's API end to end, upload. Ana attaches `spec.pdf` in a thread of #eng and asks the
 * team bot Atlas; the turn's `POST /agent-channel/v1/work-sessions/upload` moves it into the session Atlas started from
 * that thread: decided as Ana (the attachment rule), then as the session's sponsor (the session, the path, taint, the
 * claim, the move), bounded by the organization's limit and audited without the path. Real PostgreSQL + Redis + Garage;
 * the device is a service FakeDevice with the isolated mark that fetches the bytes from the transfer route for real.
 */

const CELL_TOKEN = "ocw-test-cell-token-bot-work-session-file-routes-0123456789";
const UPLOAD = "ocw_work_session_upload";
const DOWNLOAD = "ocw_work_session_download";
type FileTool = typeof UPLOAD | typeof DOWNLOAD;
const FIRST = "fix the failing invoice test";
const MIB = 1024 * 1024;
/**
 * This stack's transfer deadline (`botFileDeadlineMs`, PD-18): 5 s for a small file (short for 13's timeout case),
 * 60 s above 1 MiB so the 25 MiB case never races the deadline on a loaded runner.
 */
const STACK_DEADLINE_MS = 5_000;
const stackDeadlineMs = (bytes: number) => (bytes > MIB ? 60_000 : STACK_DEADLINE_MS);

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Cmd = { id: string; kind: string; payload: Record<string, unknown>; sessionId: string };

let storage: TestStorage;
let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let ana: TestClient;
let orgId: string;
let victorId: string;
let anaId: string;
let atlasId: string;
let engId: string;
let server: FakeDevice;
let serverId: string;
let billingId: string;
let echoId: string;
let opsId: string;
/** The device's scratch working tree (its absolute path must never reach the API, P1) and its 64-byte README. */
let scratch: string;
let readme: Uint8Array;
/** Every API log line (LOG_LEVEL debug): the record sweep reads them (P1). */
const logs: string[] = [];

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

const rowsOf = async (q: string, args: unknown[] = []) => (await su.query(q, args)).rows as Json[];

/** `who` posts in `conv` (a thread reply when `threadRootId` is set); returns the message id. */
async function post(
  who: TestClient,
  conv: string,
  body: string,
  opts: { threadRootId?: string; attachmentIds?: string[] } = {},
): Promise<string> {
  const msg = await ok(
    who.request("POST", `/api/v1/conversations/${conv}/messages`, {
      body,
      ...(opts.threadRootId ? { threadRootId: opts.threadRootId } : {}),
      ...(opts.attachmentIds ? { attachmentIds: opts.attachmentIds } : {}),
    }),
  );
  return msg.id as string;
}

/** The bot's (Atlas by default) delivered turn for one message: its event id. */
async function turnOf(messageId: string, agentId = atlasId): Promise<string> {
  const rows = await eventually(async () => {
    const r = await rowsOf(
      "select payload from app.stream_events where type = 'agent.mention.v1' and payload->'message'->>'id' = $1 and payload->'agent'->>'id' = $2",
      [messageId, agentId],
    );
    return r.length > 0 ? r : undefined;
  });
  expect(rows).toHaveLength(1);
  return rows[0]!.payload.eventId as string;
}

/** A bot of this suite: its id and its handle. */
type Bot = { id: string; handle: string };

/**
 * Ana asks a bot (Atlas unless `bot`) in `conv` (#eng unless given; a thread reply when `threadRootId` is set); the
 * message and the turn's event id.
 */
async function ask(
  text: string,
  opts: { threadRootId?: string; attachmentIds?: string[]; bot?: Bot; conv?: string } = {},
): Promise<{ messageId: string; eventId: string }> {
  // The bot's daily usage budget never stops a turn of this suite.
  await su.query("delete from app.agent_usage_daily");
  const bot = opts.bot ?? { id: atlasId, handle: "atlas" };
  const { threadRootId, attachmentIds } = opts;
  const messageId = await post(
    ana,
    opts.conv ?? engId,
    `@${bot.handle} ${text} ${randomUUID().slice(0, 6)}`,
    {
      ...(threadRootId ? { threadRootId } : {}),
      ...(attachmentIds ? { attachmentIds } : {}),
    },
  );
  return { messageId, eventId: await turnOf(messageId, bot.id) };
}

/** Ana's file in `conv`, uploaded and ready, not yet sent with a message. */
async function chatFile(
  bytes: Uint8Array = randomBytes(2048),
  name = "spec.pdf",
  conv = engId,
  type = "application/pdf",
) {
  const id = await uploadAttachment(ana, conv, { name, type, bytes });
  const [row] = await rowsOf("select size_bytes, sha256 from app.attachments where id = $1", [id]);
  return { id, sizeBytes: Number(row!.size_bytes), sha256: row!.sha256 as string, bytes };
}

/** The command the device received for `transferId` (the transfer id is the command id). */
const commandOf = (id: string) =>
  server.next((f) => f.type === "command" && f.id === id) as Promise<Frame & Cmd>;

/**
 * A bot (Atlas unless `bot`) starts a session on billing-api from Ana's message in `conv` (#eng unless given), the root
 * of the session's thread; the device takes it and its first prompt, the runtime finishes that turn and the session is
 * idle with nothing in its queue. With `running`, the runtime only starts that turn: the session stays `running`.
 */
async function idleSession(
  opts: { bot?: Bot; conv?: string; running?: boolean } = {},
): Promise<{ workSessionId: string; rootId: string }> {
  const bot = opts.bot ?? { id: atlasId, handle: "atlas" };
  const { messageId: rootId, eventId } = await ask("please fix the invoice test", {
    bot,
    ...(opts.conv ? { conv: opts.conv } : {}),
  });
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
  if (opts.running) {
    // The runtime is working on the first prompt: the session stays busy (the turn never completes here).
    server.event(id, { type: "prompt.started", promptId: first.payload.promptId as string });
    await eventually(async () => {
      const [s] = await rowsOf("select status from app.work_sessions where id = $1", [id]);
      return s?.status === "running";
    });
    return { workSessionId: id, rootId };
  }
  server.emitTurn(id, { promptId: first.payload.promptId as string, text: "done" });
  await eventually(async () => {
    const [p] = await rowsOf("select status from app.work_prompts where id = $1", [first.payload.promptId]);
    const [s] = await rowsOf("select status from app.work_sessions where id = $1", [id]);
    return p?.status === "completed" && s?.status === "idle";
  });
  return { workSessionId: id, rootId };
}

/** Ana attaches `file` in the session's thread and asks Atlas to put it in the session: that turn's event id. */
async function askWithFile(rootId: string, attachmentId: string): Promise<string> {
  return (await ask("put this file in the session", { threadRootId: rootId, attachmentIds: [attachmentId] }))
    .eventId;
}

const uploadCall = (
  body: { eventId: string; workSessionId: string; attachmentId: string; path: string; overwrite?: boolean },
  token = CELL_TOKEN,
) => cell("/work-sessions/upload", { agentId: atlasId, ...body }, token);

const downloadCall = (body: { eventId: string; workSessionId: string; path: string }, token = CELL_TOKEN) =>
  cell("/work-sessions/download", { agentId: atlasId, ...body }, token);

/**
 * A move the device handles: the route call starts, the transfer row it creates for the turn appears (a new one, so
 * several moves of one turn never mix), the FakeDevice receives its command and `serve`s it; then the route's answer.
 */
async function served(
  eventId: string,
  call: () => Promise<{ status: number; body: Json }>,
  serve: (cmd: Frame & Cmd) => Promise<{ ok: boolean; error: string | null }>,
) {
  const seen = new Set((await ledgerOfTurn(eventId)).map((r) => r.id as string));
  const pending = call();
  const transferId = await eventually(async () => {
    const fresh = (await ledgerOfTurn(eventId)).find((r) => !seen.has(r.id as string));
    return fresh?.id as string | undefined;
  });
  const cmd = await commandOf(transferId);
  const ack = await serve(cmd);
  const r = await pending;
  return { r, cmd, ack, transferId };
}

/**
 * An upload the device serves: the route call starts, the FakeDevice receives `session.file.write`, GETs the bytes
 * from the transfer route and acks; then the route's answer.
 */
const uploadServed = (body: Parameters<typeof uploadCall>[0]) =>
  served(
    body.eventId,
    () => uploadCall(body),
    (cmd) => server.serveFileCommand(cmd),
  );

/**
 * A download the device serves: the FakeDevice receives `session.file.read`, PUTs `bytes` (the session file, the
 * scratch tree's README by default) to the transfer route and acks; then the route's answer.
 */
const downloadServed = (body: Parameters<typeof downloadCall>[0], bytes: Uint8Array = readme) =>
  served(
    body.eventId,
    () => downloadCall(body),
    (cmd) => server.serveFileCommand(cmd, { body: bytes }),
  );

const turnRow = async (eventId: string) =>
  (await rowsOf("select tool_calls, tainted from app.agent_turns where event_id = $1", [eventId]))[0]!;

const toolCallsOf = (eventId: string, tool: FileTool = UPLOAD) =>
  rowsOf(
    "select tool, decision, reason, target from app.agent_tool_calls where event_id = $1 and tool = $2 order by created_at",
    [eventId, tool],
  );

function ledgerOfTurn(eventId: string) {
  return rowsOf(
    "select id, status, path_length, direction from app.bot_work_session_files where event_id = $1 order by created_at",
    [eventId],
  );
}

const fileCommandsOf = (workSessionId: string) =>
  rowsOf(
    "select id from app.device_commands where work_session_id = $1 and kind in ('session.file.write', 'session.file.read')",
    [workSessionId],
  );

const auditsOf = (action: string, eventId: string) =>
  rowsOf(
    "select actor_kind, actor_id, agent_id, user_id, device_id, resource_type, resource_id, result, metadata from app.audit_events where action = $1 and metadata->>'eventId' = $2 order by occurred_at",
    [action, eventId],
  );

/** An upload answer that must be the refusal `code` (its fixed sentence unless `sentence` is given). */
async function refusedWith(
  res: Promise<{ status: number; body: Json }>,
  code: BotWorkSessionRefusal,
  sentence: string = BOT_WORK_SESSION_SENTENCES[code],
) {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const body = AgentChannelWorkSessionUploadResponse.parse(r.body);
  expect(body, JSON.stringify(r.body)).toMatchObject({ kind: "refused", code, sentence });
  return r.body;
}

/**
 * `times` refusals decided before the claim: as many denied `agent_tool_calls` rows with the code and
 * `bot.work_session_refused` audits, the turn not counted, no ledger row and no device command. Returns the audits.
 */
async function refusedBeforeClaim(
  eventId: string,
  workSessionId: string,
  code: BotWorkSessionRefusal,
  times = 1,
  tool: FileTool = UPLOAD,
  sponsorUserId = victorId,
): Promise<Json[]> {
  expect(await toolCallsOf(eventId, tool)).toEqual(
    Array.from({ length: times }, () => ({
      tool,
      decision: "denied",
      reason: code,
      target: workSessionId,
    })),
  );
  const refusals = await auditsOf("bot.work_session_refused", eventId);
  expect(refusals).toHaveLength(times);
  for (const r of refusals) {
    expect(r.metadata).toMatchObject({ tool, outcome: code, workSessionId, sponsorUserId });
    expect(r.user_id).toBe(anaId);
  }
  expect((await turnRow(eventId)).tool_calls).toBe(0);
  expect(await ledgerOfTurn(eventId)).toEqual([]);
  expect(await fileCommandsOf(workSessionId)).toEqual([]);
  return refusals;
}

/** A bot's profile on the build server: billing-api, Claude Code, Opus only (the file limit is the organization's). */
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

/** Every session ends before the next test and the hour's prompts and moves are forgotten (budgets start at zero). */
async function quiesce() {
  await su.query(
    "update app.work_sessions set status = 'archived' where organization_id = $1 and status <> 'archived'",
    [orgId],
  );
  await su.query(
    "update app.work_prompts set created_at = now() - interval '2 hours' where organization_id = $1",
    [orgId],
  );
  await su.query(
    "update app.bot_work_session_files set created_at = now() - interval '2 hours' where organization_id = $1",
    [orgId],
  );
  await su.query(
    "update app.device_commands set status = 'failed', error = 'test' where organization_id = $1 and status in ('pending', 'sent')",
    [orgId],
  );
}

/** Víctor re-saves Atlas's profile (he stays its sponsor) with `over`; no argument restores the suite's profile. */
const saveProfile = (over: Partial<BotWorkZoneProfileInput> = {}) =>
  createBotProfile(victor, atlasId, profile(over));

beforeAll(async () => {
  // The device's working tree: the FakeDevice reads the session's README from here (only its bytes cross the wire).
  scratch = await mkdtemp(join(tmpdir(), "ocw-bot-files-"));
  await writeFile(
    join(scratch, "README.md"),
    `# billing-api\n\nInvoices, ledgers and the tests for all of them.\n`,
  );
  readme = new Uint8Array(await readFile(join(scratch, "README.md")));
  expect(readme.length).toBe(64);
  storage = await startTestStorage();
  stack = await startTestStack({
    env: {
      ...storage.env,
      OCW_CELL_TOKEN: CELL_TOKEN,
      OCW_MODEL_PROVIDER: "mock",
      // The server allows 64 MiB, so the organization's default (25 MiB) is the limit that applies.
      OCW_ATTACHMENT_MAX_BYTES: String(64 * MIB),
      LOG_LEVEL: "debug",
    },
    logStream: { write: (line: string) => void logs.push(line) },
    botFileDeadlineMs: stackDeadlineMs,
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
  const bot = await ok(
    victor.request("POST", "/api/v1/agents", {
      name: "Atlas",
      username: "atlas",
      instructions: "You are Atlas.",
      modelProvider: "mock",
      modelId: "mock-1",
    }),
  );
  atlasId = bot.id as string;
  await su.query("update app.agents set status = 'ready' where id = $1", [atlasId]);
  engId = (await ok(victor.request("POST", "/api/v1/channels", { name: "eng", visibility: "public" })))
    .id as string;
  // Echo: another team bot with its own profile on the same server (its sessions are never Atlas's).
  const echo = await ok(
    victor.request("POST", "/api/v1/agents", {
      name: "Echo",
      username: "echo",
      instructions: "You are Echo.",
      modelProvider: "mock",
      modelId: "mock-1",
    }),
  );
  echoId = echo.id as string;
  await su.query("update app.agents set status = 'ready' where id = $1", [echoId]);
  // #ops: another channel where Ana and Atlas meet (a session started there never takes #eng's files, D-12).
  opsId = (await ok(victor.request("POST", "/api/v1/channels", { name: "ops", visibility: "public" })))
    .id as string;
  for (const conv of [engId, opsId]) {
    await ok(victor.request("POST", `/api/v1/channels/${conv}/members`, { kind: "agent", id: atlasId }));
    await ok(victor.request("POST", `/api/v1/channels/${conv}/members`, { kind: "user", id: anaId }));
  }
  await ok(victor.request("POST", `/api/v1/channels/${engId}/members`, { kind: "agent", id: echoId }));

  await ok(victor.request("PUT", "/api/v1/work-zone-policy", { allowFullAccess: true }));
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
  // Víctor (admin) gives Atlas its profile (he is its sponsor); the server allows it.
  await createBotProfile(victor, atlasId, profile());
  await createBotProfile(victor, echoId, profile());
  await grantBotConsent(victor, serverId, atlasId, { allowFullAccess: true });
  await grantBotConsent(victor, serverId, echoId, { allowFullAccess: true });
}, 240_000);

afterAll(async () => {
  await server?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
  await storage?.stop();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  await quiesce();
});

// ---------------------------------------------------------------- tracer: the phase's API end to end, upload

describe("tracer: Ana's attachment reaches the bot's session through the upload route (D-01, D-02, D-05)", () => {
  it("the device fetches the bytes and acks; the answer is uploaded, one claimed call, one audit without the path", async () => {
    const { workSessionId, rootId } = await idleSession();
    const file = await chatFile();
    const eventId = await askWithFile(rootId, file.id);

    const { r, cmd, ack, transferId } = await uploadServed({
      eventId,
      workSessionId,
      attachmentId: file.id,
      path: "docs/spec.pdf",
    });
    expect(cmd.kind).toBe("session.file.write");
    expect(cmd.sessionId).toBe(workSessionId);
    expect(cmd.payload).toEqual({
      path: "docs/spec.pdf",
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      overwrite: false,
    });
    // The FakeDevice checked the bytes it fetched against the payload's size and sha256.
    expect(ack).toEqual({ ok: true, error: null });
    expect(createHash("sha256").update(file.bytes).digest("hex")).toBe(file.sha256);

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(AgentChannelWorkSessionUploadResponse.parse(r.body)).toEqual({
      kind: "uploaded",
      workSessionId,
      path: "docs/spec.pdf",
      sizeBytes: file.sizeBytes,
    });

    // One claimed call on the turn, its target the session.
    expect(await toolCallsOf(eventId)).toEqual([
      { tool: UPLOAD, decision: "allowed", reason: null, target: workSessionId },
    ]);
    expect((await turnRow(eventId)).tool_calls).toBe(1);
    // The ledger row is done; it stores the path's length only.
    expect(await ledgerOfTurn(eventId)).toEqual([
      { id: transferId, status: "done", path_length: 13, direction: "to_device" },
    ]);

    // One success audit: the bot, Ana, the device, the session, the attachment, its size and sha256, no path.
    const audits = await auditsOf("bot.work_session_upload", eventId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_kind: "agent",
      actor_id: atlasId,
      agent_id: atlasId,
      user_id: anaId,
      device_id: serverId,
      resource_type: "work_session",
      resource_id: workSessionId,
      result: "success",
    });
    expect(audits[0]!.metadata).toEqual({
      eventId,
      sponsorUserId: victorId,
      projectId: billingId,
      workSessionId,
      attachmentId: file.id,
      bytes: file.sizeBytes,
      sha256: file.sha256,
      direction: "to_device",
      pathLength: 13,
      outcome: "uploaded",
    });
    expect(await auditsOf("bot.work_session_refused", eventId)).toEqual([]);

    // P1: the path is in no audit row, tool call or ledger row.
    const like = "%docs/spec.pdf%";
    expect(
      await rowsOf("select action from app.audit_events where to_jsonb(audit_events)::text like $1", [like]),
    ).toEqual([]);
    expect(
      await rowsOf("select id from app.agent_tool_calls where to_jsonb(agent_tool_calls)::text like $1", [
        like,
      ]),
    ).toEqual([]);
    expect(
      await rowsOf(
        "select id from app.bot_work_session_files where to_jsonb(bot_work_session_files)::text like $1",
        [like],
      ),
    ).toEqual([]);
  });

  it("a body naming a device is a 400 (P6): nothing is recorded", async () => {
    const { workSessionId, rootId } = await idleSession();
    const file = await chatFile();
    const eventId = await askWithFile(rootId, file.id);
    const r = await cell("/work-sessions/upload", {
      eventId,
      agentId: atlasId,
      workSessionId,
      attachmentId: file.id,
      path: "docs/spec.pdf",
      deviceId: serverId,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(await toolCallsOf(eventId)).toEqual([]);
    expect(await ledgerOfTurn(eventId)).toEqual([]);
    expect(await fileCommandsOf(workSessionId)).toEqual([]);
  });

  it("organization B's cell token with organization A's event → 404 unknown_turn; nothing moves (E20)", async () => {
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
    const { workSessionId, rootId } = await idleSession();
    const file = await chatFile();
    const eventId = await askWithFile(rootId, file.id);
    const r = await uploadCall(
      { eventId, workSessionId, attachmentId: file.id, path: "docs/spec.pdf" },
      tokenB,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect(r.body.error.code).toBe("unknown_turn");
    expect(await toolCallsOf(eventId)).toEqual([]);
    expect(await ledgerOfTurn(eventId)).toEqual([]);
    expect(await fileCommandsOf(workSessionId)).toEqual([]);
    // Recorded as an unknown turn, in organization B, with ids only.
    const unknown = await rowsOf(
      "select organization_id, metadata from app.audit_events where action = 'bot.tool_call' and metadata->>'eventId' = $1",
      [eventId],
    );
    expect(unknown.map((u) => [u.organization_id, u.metadata.tool, u.metadata.reason])).toEqual([
      [orgB, UPLOAD, "unknown_turn"],
    ]);
  });
});

// ---------------------------------------------------------------- the upload's own refusals (Task 2)

describe("the attachment rule: only a file this turn reads (D-02, E19, T-07.17.1.1-12-01)", () => {
  /**
   * Ana's turn in the session's thread names `attachmentId` (prepared by `setup`, before the turn unless `afterTurn`):
   * `attachment_not_found` before the claim, with the id the bot sent and the path's length, never a file name.
   */
  async function notFoundFor(
    setup: (ctx: { workSessionId: string; rootId: string }) => Promise<string>,
    opts: { afterTurn?: boolean } = {},
  ) {
    const ctx = await idleSession();
    let attachmentId = "";
    if (!opts.afterTurn) attachmentId = await setup(ctx);
    const { eventId } = await ask("put that file in the session", { threadRootId: ctx.rootId });
    if (opts.afterTurn) attachmentId = await setup(ctx);
    await refusedWith(
      uploadCall({ eventId, workSessionId: ctx.workSessionId, attachmentId, path: "docs/spec.pdf" }),
      "attachment_not_found",
    );
    const [audit] = await refusedBeforeClaim(eventId, ctx.workSessionId, "attachment_not_found");
    expect(audit!.metadata).toMatchObject({ attachmentId, pathLength: 13 });
    expect(JSON.stringify(audit!.metadata)).not.toContain(".pdf");
  }

  it("a file posted in the thread after the turn's own message (a later turn's) → attachment_not_found", async () => {
    await notFoundFor(
      async ({ rootId }) => {
        const later = await chatFile(randomBytes(512), "later.pdf");
        await post(ana, engId, "here it is", { threadRootId: rootId, attachmentIds: [later.id] });
        return later.id;
      },
      { afterTurn: true },
    );
  });

  it("a file of another thread of the same channel → attachment_not_found", async () => {
    await notFoundFor(async () => {
      const elsewhere = await chatFile(randomBytes(512), "elsewhere.pdf");
      await post(ana, engId, "another topic", { attachmentIds: [elsewhere.id] });
      return elsewhere.id;
    });
  });

  it("the file of a deleted message of the thread → attachment_not_found", async () => {
    await notFoundFor(async ({ rootId }) => {
      const gone = await chatFile(randomBytes(512), "gone.pdf");
      const message = await post(ana, engId, "a file I take back", {
        threadRootId: rootId,
        attachmentIds: [gone.id],
      });
      await ok(ana.request("DELETE", `/api/v1/messages/${message}`));
      return gone.id;
    });
  });

  it("a file of another conversation Ana reads (#ops) → attachment_not_found", async () => {
    await notFoundFor(async () => {
      const opsId = (
        await ok(
          victor.request("POST", "/api/v1/channels", {
            name: `ops-${randomUUID().slice(0, 4)}`,
            visibility: "public",
          }),
        )
      ).id as string;
      await ok(victor.request("POST", `/api/v1/channels/${opsId}/members`, { kind: "user", id: anaId }));
      const other = await chatFile(randomBytes(512), "ops.pdf", opsId);
      await post(ana, opsId, "for ops", { attachmentIds: [other.id] });
      return other.id;
    });
  });

  it("a Work Zone prompt's image, even in the turn's conversation → attachment_not_found", async () => {
    await notFoundFor(async ({ workSessionId }) => {
      // Never sent with a message, linked to the session's first prompt (what a prompt image is).
      const image = await chatFile(randomBytes(512), "screen.png");
      const [firstPrompt] = await rowsOf(
        "select id from app.work_prompts where work_session_id = $1 order by created_at limit 1",
        [workSessionId],
      );
      await su.query("update app.attachments set work_prompt_id = $2 where id = $1", [
        image.id,
        firstPrompt!.id,
      ]);
      return image.id;
    });
  });
});

describe("the size limit before any byte moves (D-07, E5, T-07.17.1.1-12-03)", () => {
  it("a 30 MB file with the default limit → file_too_large naming the organization's limit; no ledger row", async () => {
    const { workSessionId, rootId } = await idleSession();
    const big = await chatFile(randomBytes(30 * MIB), "big.bin");
    const eventId = await askWithFile(rootId, big.id);
    const body = await refusedWith(
      uploadCall({ eventId, workSessionId, attachmentId: big.id, path: "data/big.bin" }),
      "file_too_large",
      "That file is 30 MB. This bot moves files up to 25 MB (the organization's limit).",
    );
    expect(body).toMatchObject({ limit: { bytes: 26_214_400, source: "organization" }, sizeBytes: 30 * MIB });
    const [audit] = await refusedBeforeClaim(eventId, workSessionId, "file_too_large");
    expect(audit!.metadata).toMatchObject({
      attachmentId: big.id,
      bytes: 30 * MIB,
      limitSource: "organization",
      pathLength: 12,
    });
  });

  it("a file of exactly 25 MiB moves", async () => {
    const { workSessionId, rootId } = await idleSession();
    const edge = await chatFile(randomBytes(25 * MIB), "edge.bin");
    const eventId = await askWithFile(rootId, edge.id);
    const { r, ack } = await uploadServed({
      eventId,
      workSessionId,
      attachmentId: edge.id,
      path: "data/edge.bin",
    });
    expect(ack).toEqual({ ok: true, error: null });
    expect(r.body, JSON.stringify(r.body)).toEqual({
      kind: "uploaded",
      workSessionId,
      path: "data/edge.bin",
      sizeBytes: 25 * MIB,
    });
    expect((await auditsOf("bot.work_session_upload", eventId))[0]!.metadata).toMatchObject({
      bytes: 25 * MIB,
      sha256: edge.sha256,
    });
  });
});

describe("the shared deny list before the claim (D-09, E3, T-07.17.1.1-12-02)", () => {
  // Secret-looking names are built at runtime (PD-03).
  const dotEnv = `.${"env"}`;

  it(".git/config, .claude/settings.json, .mcp.json, .env and deploy.pem → path_not_allowed, no transfer", async () => {
    const { workSessionId, rootId } = await idleSession();
    const file = await chatFile();
    const eventId = await askWithFile(rootId, file.id);
    const denied = [".git/config", ".claude/settings.json", ".mcp.json", dotEnv, `deploy${".pem"}`];
    for (const path of denied) {
      await refusedWith(
        uploadCall({ eventId, workSessionId, attachmentId: file.id, path }),
        "path_not_allowed",
      );
    }
    const audits = await refusedBeforeClaim(eventId, workSessionId, "path_not_allowed", denied.length);
    expect(audits.map((a) => a.metadata.pathLength)).toEqual(denied.map((p) => p.length));
  });

  it(".env.example is not a secrets file: it moves", async () => {
    const { workSessionId, rootId } = await idleSession();
    const file = await chatFile();
    const eventId = await askWithFile(rootId, file.id);
    const allowed = `${dotEnv}.example`;
    const { r, cmd } = await uploadServed({ eventId, workSessionId, attachmentId: file.id, path: allowed });
    expect(cmd.payload.path).toBe(allowed);
    expect(r.body).toEqual({ kind: "uploaded", workSessionId, path: allowed, sizeBytes: file.sizeBytes });
    expect((await turnRow(eventId)).tool_calls).toBe(1);
  });
});

describe("the device's ack and the transfer route's own record race (found by the 25 MiB case)", () => {
  /** The upload route call, its transfer row and the device's command (the device has not answered yet). */
  async function enqueued() {
    const { workSessionId, rootId } = await idleSession();
    const file = await chatFile();
    const eventId = await askWithFile(rootId, file.id);
    const pending = uploadCall({ eventId, workSessionId, attachmentId: file.id, path: "docs/spec.pdf" });
    const [transfer] = await eventually(async () => {
      const r = await ledgerOfTurn(eventId);
      return r.length > 0 ? r : undefined;
    });
    const cmd = await commandOf(transfer!.id as string);
    return { workSessionId, eventId, file, pending, transferId: transfer!.id as string, cmd };
  }

  it("an ok ack while the row is still streaming (the GET's `streamed` not yet recorded) is uploaded", async () => {
    const { workSessionId, eventId, file, pending, transferId, cmd } = await enqueued();
    // The device claimed the transfer and read every byte; the route's after-response record has not committed yet.
    await su.query("update app.bot_work_session_files set status = 'streaming' where id = $1", [transferId]);
    server.ack(cmd.id);
    const r = await pending;
    expect(r.body, JSON.stringify(r.body)).toEqual({
      kind: "uploaded",
      workSessionId,
      path: "docs/spec.pdf",
      sizeBytes: file.sizeBytes,
    });
    expect((await ledgerOfTurn(eventId))[0]!.status).toBe("done");
    expect(await auditsOf("bot.work_session_upload", eventId)).toHaveLength(1);
  });

  it("an ok ack for a transfer the device never fetched (still pending) is transfer_failed", async () => {
    const { eventId, pending, cmd } = await enqueued();
    server.ack(cmd.id);
    await refusedWith(pending, "transfer_failed");
    expect((await ledgerOfTurn(eventId))[0]!.status).toBe("failed");
    expect(await auditsOf("bot.work_session_upload", eventId)).toEqual([]);
    const [refusal] = await auditsOf("bot.work_session_refused", eventId);
    expect(refusal!.metadata).toMatchObject({ tool: UPLOAD, outcome: "transfer_failed", pathLength: 13 });
  });
});

// ---------------------------------------------------------------- 07.17.1.1-13 tracer: the download end to end

/** The attachment download as a reader asks for it (302 to a presigned URL, or 404); never followed. */
const personDownload = (who: TestClient, attachmentId: string) =>
  fetch(`${stack.baseUrl}/api/v1/attachments/${attachmentId}/download`, {
    redirect: "manual",
    headers: { origin: WEB_ORIGIN, cookie: who.cookieHeader },
  });

/** Atlas's reply for the turn `eventId` in the thread of `rootId` (it links the turn's pending files). */
const replyFor = (eventId: string, rootId: string) =>
  cell("/messages", {
    agentId: atlasId,
    conversationId: engId,
    threadRootMessageId: rootId,
    eventId,
    text: "Here is the file you asked for.",
    idempotencyKey: `reply-${randomUUID()}`,
  });

/** A download answer that must be `downloaded`. */
function downloadedBody(r: { status: number; body: Json }) {
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const body = AgentChannelWorkSessionDownloadResponse.parse(r.body);
  if (body.kind !== "downloaded") throw new Error(`not downloaded: ${JSON.stringify(r.body)}`);
  return body;
}

const attachmentRow = async (id: string) =>
  (
    await rowsOf(
      "select status, uploader_id, event_id, message_id, conversation_id, size_bytes, sha256, content_type, filename from app.attachments where id = $1",
      [id],
    )
  )[0];

/** Atlas's idle session and a turn of Ana in its thread asking for the README back. */
async function askForReadme(opts: { running?: boolean } = {}) {
  const { workSessionId, rootId } = await idleSession(opts);
  const { eventId } = await ask("send me the README back", { threadRootId: rootId });
  return { workSessionId, rootId, eventId };
}

describe("tracer: a session file comes back as the bot's reply attachment, which Ana downloads (D-03, PD-17)", () => {
  it("the device PUTs README.md and acks; the answer is downloaded with a new attachment; one audit without the path", async () => {
    const { workSessionId, eventId } = await askForReadme();
    const { r, cmd, ack, transferId } = await downloadServed({ eventId, workSessionId, path: "README.md" });
    expect(cmd.kind).toBe("session.file.read");
    expect(cmd.sessionId).toBe(workSessionId);
    // The repo-relative path and the bound only: no bytes, no URL, no absolute path (P2).
    expect(cmd.payload).toEqual({ path: "README.md", maxBytes: 26_214_400 });
    expect(ack).toEqual({ ok: true, error: null });

    const body = downloadedBody(r);
    const sha256 = createHash("sha256").update(readme).digest("hex");
    expect(body).toEqual({
      kind: "downloaded",
      workSessionId,
      attachmentId: expect.any(String),
      name: "README.md",
      sizeBytes: 64,
      contentType: expect.any(String),
    });
    // The bot's own pending file of this turn, in the turn's conversation, until its reply links it.
    expect(await attachmentRow(body.attachmentId)).toMatchObject({
      status: "pending",
      uploader_id: atlasId,
      event_id: eventId,
      message_id: null,
      conversation_id: engId,
      size_bytes: "64",
      sha256,
      filename: "README.md",
      content_type: body.contentType,
    });

    expect(await toolCallsOf(eventId, DOWNLOAD)).toEqual([
      { tool: DOWNLOAD, decision: "allowed", reason: null, target: workSessionId },
    ]);
    expect((await turnRow(eventId)).tool_calls).toBe(1);
    expect(await ledgerOfTurn(eventId)).toEqual([
      { id: transferId, status: "done", path_length: 9, direction: "from_device" },
    ]);

    const audits = await auditsOf("bot.work_session_download", eventId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_kind: "agent",
      actor_id: atlasId,
      agent_id: atlasId,
      user_id: anaId,
      device_id: serverId,
      resource_type: "work_session",
      resource_id: workSessionId,
      result: "success",
    });
    expect(audits[0]!.metadata).toEqual({
      eventId,
      sponsorUserId: victorId,
      projectId: billingId,
      workSessionId,
      attachmentId: body.attachmentId,
      bytes: 64,
      sha256,
      direction: "from_device",
      pathLength: 9,
      outcome: "downloaded",
    });
    expect(await auditsOf("bot.work_session_refused", eventId)).toEqual([]);
  });

  it("nobody reads it before the reply; the reply for the turn links it and Ana downloads its 64 bytes (E24)", async () => {
    const { workSessionId, rootId, eventId } = await askForReadme();
    const body = downloadedBody((await downloadServed({ eventId, workSessionId, path: "README.md" })).r);
    // Pending: Ana, who asked, cannot open it yet; neither can Víctor.
    expect((await personDownload(ana, body.attachmentId)).status).toBe(404);
    expect((await personDownload(victor, body.attachmentId)).status).toBe(404);

    const posted = await ok(replyFor(eventId, rootId));
    expect(await attachmentRow(body.attachmentId)).toMatchObject({
      status: "ready",
      message_id: posted.messageId,
    });
    const res = await personDownload(ana, body.attachmentId);
    expect(res.status).toBe(302);
    const bytes = new Uint8Array(await (await fetch(res.headers.get("location") as string)).arrayBuffer());
    expect(Buffer.from(bytes).equals(Buffer.from(readme))).toBe(true);
  });
});

describe("the download's own rules (D-07, D-13, PD-08, PD-12; E6, E14, E24)", () => {
  it("a running session still answers a download; an upload into it is session_busy (only uploads need idle)", async () => {
    const { workSessionId, rootId, eventId } = await askForReadme({ running: true });
    const { r } = await downloadServed({ eventId, workSessionId, path: "README.md" });
    expect(downloadedBody(r).sizeBytes).toBe(64);

    const file = await chatFile();
    const uploadTurn = await askWithFile(rootId, file.id);
    await refusedWith(
      uploadCall({ eventId: uploadTurn, workSessionId, attachmentId: file.id, path: "docs/spec.pdf" }),
      "session_busy",
    );
    expect(await ledgerOfTurn(uploadTurn)).toEqual([]);
    const [refusal] = await auditsOf("bot.work_session_refused", uploadTurn);
    expect(refusal!.metadata).toMatchObject({ tool: UPLOAD, outcome: "session_busy", pathLength: 13 });
  });

  it("the device reports 12 MB with the bot at 10 MB → file_too_large naming this bot's limit; no attachment", async () => {
    await saveProfile({ fileMaxBytes: 10 * MIB });
    try {
      const { workSessionId, eventId } = await askForReadme();
      const { r, cmd, ack } = await downloadServed(
        { eventId, workSessionId, path: "data/dump.bin" },
        new Uint8Array(12 * MIB),
      );
      expect(cmd.payload).toEqual({ path: "data/dump.bin", maxBytes: 10 * MIB });
      // The device refused before any byte moved (the FakeDevice, like the daemon, never PUTs).
      expect(ack).toEqual({ ok: false, error: `too_large: ${12 * MIB}` });
      const body = await refusedWith(
        Promise.resolve(r),
        "file_too_large",
        "That file is 12 MB. This bot moves files up to 10 MB (this bot's limit).",
      );
      expect(body).toMatchObject({ limit: { bytes: 10_485_760, source: "bot" }, sizeBytes: 12_582_912 });
      expect(await rowsOf("select id from app.attachments where event_id = $1", [eventId])).toEqual([]);
      const [refusal] = await auditsOf("bot.work_session_refused", eventId);
      expect(refusal!.metadata).toMatchObject({
        tool: DOWNLOAD,
        outcome: "file_too_large",
        bytes: 12 * MIB,
        limitSource: "bot",
        pathLength: 13,
      });
    } finally {
      await saveProfile();
    }
  });

  it("ten files already waiting for the turn's reply → file_cap_reached; no transfer, no command", async () => {
    const { workSessionId, eventId } = await askForReadme();
    // Ten files the bot shared in this turn (e.g. from its sandbox), all waiting for the reply.
    for (let i = 0; i < 10; i++) {
      await su.query(
        "insert into app.attachments (organization_id, conversation_id, uploader_id, filename, declared_type, size_bytes, status, event_id) values ($1, $2, $3, $4, 'text/csv', 10, 'pending', $5)",
        [orgId, engId, atlasId, `shared-${i}.csv`, eventId],
      );
    }
    await refusedWith(downloadCall({ eventId, workSessionId, path: "README.md" }), "file_cap_reached");
    expect(await ledgerOfTurn(eventId)).toEqual([]);
    expect(await fileCommandsOf(workSessionId)).toEqual([]);
  });
});
