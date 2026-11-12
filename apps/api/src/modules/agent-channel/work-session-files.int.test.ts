import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  AgentChannelWorkSessionStartResponse,
  AgentChannelWorkSessionUploadResponse,
  BOT_WORK_SESSION_SENTENCES,
  type BotWorkSessionRefusal,
  type BotWorkZoneProfileInput,
} from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
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
const FIRST = "fix the failing invoice test";
const MIB = 1024 * 1024;
/** This stack's transfer deadline (`botFileDeadlineMs`, PD-18): enough for every file here, short for 13's timeout. */
const STACK_DEADLINE_MS = 5_000;

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

/** Atlas's delivered turn for one message: its event id. */
async function turnOf(messageId: string): Promise<string> {
  const rows = await eventually(async () => {
    const r = await rowsOf(
      "select payload from app.stream_events where type = 'agent.mention.v1' and payload->'message'->>'id' = $1 and payload->'agent'->>'id' = $2",
      [messageId, atlasId],
    );
    return r.length > 0 ? r : undefined;
  });
  expect(rows).toHaveLength(1);
  return rows[0]!.payload.eventId as string;
}

/** Ana asks Atlas in #eng (a thread reply when `threadRootId` is set); the message and the turn's event id. */
async function ask(
  text: string,
  opts: { threadRootId?: string; attachmentIds?: string[] } = {},
): Promise<{ messageId: string; eventId: string }> {
  // The bot's daily usage budget never stops a turn of this suite.
  await su.query("delete from app.agent_usage_daily");
  const messageId = await post(ana, engId, `@atlas ${text} ${randomUUID().slice(0, 6)}`, opts);
  return { messageId, eventId: await turnOf(messageId) };
}

/** Ana's file in `conv`, uploaded and ready, not yet sent with a message. */
async function chatFile(bytes: Uint8Array = randomBytes(2048), name = "spec.pdf", conv = engId) {
  const id = await uploadAttachment(ana, conv, { name, type: "application/pdf", bytes });
  const [row] = await rowsOf("select size_bytes, sha256 from app.attachments where id = $1", [id]);
  return { id, sizeBytes: Number(row!.size_bytes), sha256: row!.sha256 as string, bytes };
}

/** The command the device received for `transferId` (the transfer id is the command id). */
const commandOf = (id: string) =>
  server.next((f) => f.type === "command" && f.id === id) as Promise<Frame & Cmd>;

/**
 * Atlas starts a session on billing-api from Ana's thread root in #eng; the device takes it and its first prompt, the
 * runtime finishes that turn and the session is idle with nothing in its queue.
 */
async function idleSession(): Promise<{ workSessionId: string; rootId: string }> {
  const { messageId: rootId, eventId } = await ask("please fix the invoice test");
  const r = await cell("/work-sessions/start", {
    eventId,
    agentId: atlasId,
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

/**
 * An upload the device serves: the route call starts, the FakeDevice receives `session.file.write`, GETs the bytes
 * from the transfer route and acks; then the route's answer.
 */
async function uploadServed(body: Parameters<typeof uploadCall>[0]) {
  const pending = uploadCall(body);
  const [transfer] = await eventually(async () => {
    const r = await rowsOf(
      "select id from app.bot_work_session_files where event_id = $1 order by created_at desc",
      [body.eventId],
    );
    return r.length > 0 ? r : undefined;
  });
  const cmd = await commandOf(transfer!.id as string);
  const ack = await server.serveFileCommand(cmd);
  const r = await pending;
  return { r, cmd, ack, transferId: transfer!.id as string };
}

const turnRow = async (eventId: string) =>
  (await rowsOf("select tool_calls, tainted from app.agent_turns where event_id = $1", [eventId]))[0]!;

const toolCallsOf = (eventId: string) =>
  rowsOf(
    "select tool, decision, reason, target from app.agent_tool_calls where event_id = $1 and tool = $2 order by created_at",
    [eventId, UPLOAD],
  );

const ledgerOfTurn = (eventId: string) =>
  rowsOf("select id, status, path_length from app.bot_work_session_files where event_id = $1", [eventId]);

const fileCommandsOf = (workSessionId: string) =>
  rowsOf("select id from app.device_commands where work_session_id = $1 and kind = 'session.file.write'", [
    workSessionId,
  ]);

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
 * A refusal decided before the claim: one denied `agent_tool_calls` row with the code, `bot.work_session_refused`, the
 * turn not counted, no ledger row and no device command.
 */
async function refusedBeforeClaim(eventId: string, workSessionId: string, code: BotWorkSessionRefusal) {
  expect(await toolCallsOf(eventId)).toEqual([
    { tool: UPLOAD, decision: "denied", reason: code, target: workSessionId },
  ]);
  const [refusal] = await auditsOf("bot.work_session_refused", eventId);
  expect(refusal?.metadata).toMatchObject({ tool: UPLOAD, outcome: code, workSessionId });
  expect((await turnRow(eventId)).tool_calls).toBe(0);
  expect(await ledgerOfTurn(eventId)).toEqual([]);
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

beforeAll(async () => {
  storage = await startTestStorage();
  stack = await startTestStack({
    env: {
      ...storage.env,
      OCW_CELL_TOKEN: CELL_TOKEN,
      OCW_MODEL_PROVIDER: "mock",
      // The server allows 64 MiB, so the organization's default (25 MiB) is the limit that applies.
      OCW_ATTACHMENT_MAX_BYTES: String(64 * MIB),
    },
    botFileDeadlineMs: () => STACK_DEADLINE_MS,
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
  await ok(victor.request("POST", `/api/v1/channels/${engId}/members`, { kind: "agent", id: atlasId }));
  await ok(victor.request("POST", `/api/v1/channels/${engId}/members`, { kind: "user", id: anaId }));

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
  await grantBotConsent(victor, serverId, atlasId, { allowFullAccess: true });
}, 240_000);

afterAll(async () => {
  await server?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
  await storage?.stop();
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
    expect(await ledgerOfTurn(eventId)).toEqual([{ id: transferId, status: "done", path_length: 13 }]);

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
