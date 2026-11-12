import { randomBytes, randomUUID } from "node:crypto";
import {
  AgentChannelWorkSessionStartResponse,
  type BotFileLimit,
  type BotWorkZoneProfileInput,
  transferDeadlineMs,
} from "@ocw/contracts";
import { agentTurns, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice, type Frame } from "../../testing-device";
import { startTestStorage, type TestStorage } from "../../testing-storage";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  createBotProfile,
  freshBotTurn,
  grantBotConsent,
  invite,
  pairDevice,
} from "../../testing-workzone";
import { loadBotProfile } from "./bot-profile";
import { ownBotSession } from "./bot-sessions";

/**
 * 07.17.1.1-11 (D-02 … D-07, D-13; PD-06 … PD-08, PD-12, PD-13, PD-15 … PD-18): the work-session module's file service.
 * `botFiles.prepareDownload|prepareUpload` decide one move for a bot's own session in its sponsor's transaction (the
 * session's state, the sponsor's rights, the budgets under the bot's lock), write one ledger row and enqueue one
 * `session.file.read|write` whose id is the transfer id; `waitForAck` waits for the device's ack through the hub;
 * `finish` maps it to the bot's answer. Real PostgreSQL + Redis + Garage; the device is a service FakeDevice with the
 * isolated mark that serves the transfer routes for real.
 */

const CELL_TOKEN = "ocw-test-cell-token-bot-work-session-files-0123456789";
const FIRST = "fix the failing invoice test";
const MIB = 1024 * 1024;
/** The organization's default per-file limit (the server allows 64 MiB in this stack). */
const ORG_LIMIT: BotFileLimit = { bytes: 25 * MIB, source: "organization" };
/** This stack's injected transfer deadline (`botFileDeadlineMs`, PD-18). */
const STACK_DEADLINE_MS = 8_000;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Cmd = { id: string; kind: string; payload: Record<string, unknown>; sessionId: string };
type TurnRow = typeof agentTurns.$inferSelect;

let storage: TestStorage;
let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let ana: TestClient;
let orgId: string;
let victorId: string;
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

async function cell(path: string, body: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${stack.baseUrl}/agent-channel/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${CELL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

const rowsOf = async (q: string, args: unknown[] = []) => (await su.query(q, args)).rows as Json[];

const botFiles = () => stack.built.workSession.botFiles;

/** The sponsor's (Víctor's) tenant transaction: where the routes call `prepare*` and `finish`. */
const asSponsor = <T>(fn: (tx: Tx) => Promise<T>) =>
  stack.built.core.db.withTenant({ organizationId: orgId, userId: victorId }, fn);

/** Ana asks Atlas in #eng; the delivered turn's event id. */
const ask = (text = "please fix the invoice test") =>
  freshBotTurn(su, ana, engId, `@atlas ${text} ${randomUUID().slice(0, 6)}`);

/** What the routes hand the service: the turn, the bot's profile and its own session (read user-less, as tx0). */
async function callContext(eventId: string, workSessionId: string) {
  return stack.built.core.db.withTenant({ organizationId: orgId, userId: null }, async (tx) => {
    const [turn] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, eventId));
    const profile = await loadBotProfile(tx, atlasId);
    const own = await ownBotSession(tx, { agentId: atlasId, workSessionId });
    if (!turn || !profile || !own) throw new Error("no turn, profile or own session");
    return { turn: turn as TurnRow, profile, own };
  });
}

/** Atlas starts a session on billing-api from a fresh ask; the device takes it and its first prompt. */
async function botSession(): Promise<{ workSessionId: string; first: Cmd }> {
  const eventId = await ask();
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
  return { workSessionId: id, first };
}

/** The runtime finishes the turn of `cmd` and the session is idle with nothing in its queue. */
async function finishTurn(workSessionId: string, cmd: Cmd) {
  server.emitTurn(workSessionId, { promptId: cmd.payload.promptId as string, text: "done" });
  await eventually(async () => {
    const [p] = await rowsOf("select status from app.work_prompts where id = $1", [cmd.payload.promptId]);
    const [s] = await rowsOf("select status from app.work_sessions where id = $1", [workSessionId]);
    return p?.status === "completed" && s?.status === "idle";
  });
}

/** An idle session of Atlas after one finished turn, and a fresh turn of Atlas in its origin conversation. */
async function idleSession() {
  const { workSessionId, first } = await botSession();
  await finishTurn(workSessionId, first);
  const eventId = await ask();
  return { workSessionId, eventId, ...(await callContext(eventId, workSessionId)) };
}

/** The command the device received for `transferId` (the transfer id is the command id). */
const fileCommand = (transferId: string) =>
  server.next((f) => f.type === "command" && f.id === transferId) as Promise<Frame & Cmd>;

const ledgerOf = (id: string) =>
  rowsOf(
    `select direction, status, failure, attachment_id, max_bytes, limit_source, size_bytes, sha256, path_length,
            event_id, conversation_id, device_id,
            extract(epoch from (expires_at - created_at)) * 1000 as deadline_ms
       from app.bot_work_session_files where id = $1`,
    [id],
  );

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

/** A bot's profile on the build server: billing-api, Claude Code, Opus only. */
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

beforeAll(async () => {
  storage = await startTestStorage();
  stack = await startTestStack({
    env: {
      ...storage.env,
      OCW_CELL_TOKEN: CELL_TOKEN,
      OCW_MODEL_PROVIDER: "mock",
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
  let anaId: string;
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

// ---------------------------------------------------------------- tracer: a download (D-03, D-04, D-08, PD-17)

describe("tracer: a download prepared as the sponsor reaches the device, which PUTs the file, and finishes downloaded", () => {
  it("writes one from_device row, enqueues session.file.read, and finish answers the pending attachment", async () => {
    const { workSessionId, eventId, turn, profile: prof, own } = await idleSession();
    const transferId = randomUUID();
    const wait = botFiles().waitForAck(transferId, 20_000);
    const prepared = await asSponsor((tx) =>
      botFiles().prepareDownload(tx, {
        turn,
        profile: prof,
        own,
        path: "README.md",
        limit: ORG_LIMIT,
        transferId,
      }),
    );
    expect(prepared).toEqual({ kind: "enqueued", transferId });

    const [row] = await ledgerOf(transferId);
    expect(row).toMatchObject({
      direction: "from_device",
      status: "pending",
      max_bytes: String(ORG_LIMIT.bytes),
      limit_source: "organization",
      path_length: 9,
      event_id: eventId,
      conversation_id: engId,
      device_id: serverId,
    });
    const cmd = await fileCommand(transferId);
    expect(cmd.kind).toBe("session.file.read");
    expect(cmd.sessionId).toBe(workSessionId);
    expect(cmd.payload).toEqual({ path: "README.md", maxBytes: ORG_LIMIT.bytes });

    const bytes = randomBytes(64);
    await server.serveFileCommand(cmd, { body: bytes });
    const ack = await wait;
    expect(ack).toEqual({ ok: true, error: null });

    const finished = await asSponsor((tx) =>
      botFiles().finish(tx, { transferId, direction: "from_device", ack }),
    );
    expect(finished.answer).toEqual({
      kind: "downloaded",
      workSessionId,
      attachmentId: row!.attachment_id,
      name: "README.md",
      sizeBytes: 64,
      contentType: expect.any(String),
    });
    expect(finished.audit).toMatchObject({
      attachmentId: row!.attachment_id,
      bytes: 64,
      direction: "from_device",
      pathLength: 9,
    });
    expect(finished.audit?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const [done] = await ledgerOf(transferId);
    expect(done!.status).toBe("done");
    const [att] = await rowsOf(
      "select status, event_id, uploader_id, message_id from app.attachments where id = $1",
      [row!.attachment_id],
    );
    expect(att).toEqual({ status: "pending", event_id: eventId, uploader_id: atlasId, message_id: null });
  });

  it("an aborted wait resolves null at once and leaves no Redis subscription", async () => {
    const transferId = randomUUID();
    const channel = `ocw:file:${transferId}`;
    const numsub = async () => {
      const r = (await stack.built.core.bus.pub.sendCommand(["PUBSUB", "NUMSUB", channel])) as [
        string,
        number,
      ];
      return Number(r[1]);
    };
    const ac = new AbortController();
    const wait = botFiles().waitForAck(transferId, 20_000, ac.signal);
    await eventually(async () => (await numsub()) === 1);
    const started = Date.now();
    ac.abort();
    expect(await wait).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    await eventually(async () => (await numsub()) === 0);
    // A signal already aborted never subscribes.
    expect(await botFiles().waitForAck(randomUUID(), 20_000, ac.signal)).toBeNull();
  });

  it("the session handler's onCommandResult is not called for a file command", async () => {
    const { turn, profile: prof, own } = await idleSession();
    const handler = stack.built.deviceHub.sessionHandler!;
    const spy = vi.spyOn(handler, "onCommandResult");
    try {
      const transferId = randomUUID();
      const wait = botFiles().waitForAck(transferId, 20_000);
      await asSponsor((tx) =>
        botFiles().prepareDownload(tx, {
          turn,
          profile: prof,
          own,
          path: "README.md",
          limit: ORG_LIMIT,
          transferId,
        }),
      );
      const cmd = await fileCommand(transferId);
      await server.serveFileCommand(cmd, { ackAs: "not_found" });
      expect(await wait).toEqual({ ok: false, error: "not_found" });
      const [command] = await rowsOf("select status, error from app.device_commands where id = $1", [
        transferId,
      ]);
      expect(command).toEqual({ status: "failed", error: "not_found" });
      expect(spy.mock.calls.filter((c) => c[1].id === transferId)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("a running session still downloads (D-13 binds uploads only)", async () => {
    const { workSessionId, first } = await botSession();
    // The runtime holds the first turn: the session is running.
    server.event(workSessionId, { type: "prompt.started", promptId: first.payload.promptId });
    await eventually(async () => {
      const [s] = await rowsOf("select status from app.work_sessions where id = $1", [workSessionId]);
      return s?.status === "running";
    });
    const eventId = await ask();
    const { turn, profile: prof, own } = await callContext(eventId, workSessionId);
    const transferId = randomUUID();
    const wait = botFiles().waitForAck(transferId, 20_000);
    const prepared = await asSponsor((tx) =>
      botFiles().prepareDownload(tx, {
        turn,
        profile: prof,
        own,
        path: "src/a.ts",
        limit: ORG_LIMIT,
        transferId,
      }),
    );
    expect(prepared).toEqual({ kind: "enqueued", transferId });
    await server.serveFileCommand(await fileCommand(transferId), { body: randomBytes(10) });
    const ack = await wait;
    const finished = await asSponsor((tx) =>
      botFiles().finish(tx, { transferId, direction: "from_device", ack }),
    );
    expect(finished.answer).toMatchObject({ kind: "downloaded", workSessionId, name: "a.ts", sizeBytes: 10 });
  });

  it("the stack's botFileDeadlineMs sets deadlineFor and the row's expires_at", async () => {
    expect(botFiles().deadlineFor(10)).toBe(STACK_DEADLINE_MS);
    expect(botFiles().deadlineFor(500 * MIB)).toBe(STACK_DEADLINE_MS);
    const { turn, profile: prof, own } = await idleSession();
    const transferId = randomUUID();
    await asSponsor((tx) =>
      botFiles().prepareDownload(tx, {
        turn,
        profile: prof,
        own,
        path: "README.md",
        limit: ORG_LIMIT,
        transferId,
      }),
    );
    const [row] = await ledgerOf(transferId);
    expect(Number(row!.deadline_ms)).toBeGreaterThanOrEqual(STACK_DEADLINE_MS - 50);
    expect(Number(row!.deadline_ms)).toBeLessThan(STACK_DEADLINE_MS + 2_000);
    // Production default: the contract's deadline (checked on a stack without the option, below).
    expect(transferDeadlineMs(10)).toBeGreaterThan(STACK_DEADLINE_MS);
  });
});
