import { randomUUID } from "node:crypto";
import {
  AgentChannelEventTypes,
  AgentChannelWorkSessionStartResponse,
  AgentWorkSessionEvent,
  type BotWorkZoneProfileInput,
  WORK_SESSION_CARD_LABELS,
  WORK_SESSION_TOOL_NAMES,
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
 * Phase 07.16-20 (D-09, D-10, D-12, D-17, D-21; PD-12, PD-16, PD-22; E6, E7, E8; BWZ-03, BWZ-04): the bot orchestrates
 * without polling. Every meaningful transition of a session it started flips `bot_work_sessions.wake_pending` and
 * enqueues one ids-only `work_session.bot_sync` job; its handler refreshes the live card and wakes the bot in the card's
 * thread as the person who asked (`agent.work_session.v1`), bounded and idempotent. Real PostgreSQL + Redis + pg-boss;
 * the device is a FakeDevice reporting a `service` host with the isolated-server mark. Workers are off in tests: every
 * job runs through `core.jobs.drain`.
 */

const CELL_TOKEN = "ocw-test-cell-token-bot-work-session-wakes-0123456789";
const FIRST = "fix the failing invoice test";
const QUEUE = "work_session.bot_sync";

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
let engId: string;
let server: FakeDevice;
let serverId: string;
let billingId: string;

const core = () => stack.built.core;

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

/** Atlas's profile on the build server (Víctor, admin, is its sponsor). */
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
  maxConcurrent: 2,
  promptsPerHour: 30,
  wakesPerSessionDay: 20,
  actOnOutsideContent: false,
  ...over,
});

const rowsOf = async (q: string, args: unknown[] = []) => (await su.query(q, args)).rows as Json[];

interface BotSession {
  workSessionId: string;
  first: Cmd;
  /** Ana's message (the thread root the card answers). */
  askedMessageId: string;
  cardMessageId: string;
}

/**
 * Atlas starts a session on billing-api from a fresh ask of Ana in #eng and the device takes it: `session.start` acked,
 * the runtime reports the session idle, and the start's own prompt reaches the device (the session is `running`).
 */
async function botSession(prompt = FIRST): Promise<BotSession> {
  const eventId = await freshBotTurn(
    su,
    ana,
    engId,
    `@atlas please fix the invoice test ${randomUUID().slice(0, 6)}`,
  );
  const [turn] = await rowsOf("select message_id from app.agent_turns where event_id = $1", [eventId]);
  const r = await cell("/work-sessions/start", { eventId, agentId: atlasId, projectId: billingId, prompt });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const body = AgentChannelWorkSessionStartResponse.parse(r.body);
  if (body.kind !== "started") throw new Error(`not started: ${JSON.stringify(body)}`);
  const id = body.workSessionId;
  const start = await server.command("session.start", id);
  server.ack(start.id as string);
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
  await eventually(async () => (await statusOf(id)) === "running");
  return {
    workSessionId: id,
    first,
    askedMessageId: turn!.message_id as string,
    cardMessageId: body.cardMessageId as string,
  };
}

const statusOf = async (workSessionId: string) =>
  (await rowsOf("select status from app.work_sessions where id = $1", [workSessionId]))[0]?.status as string;

/** The runtime finishes the turn of `cmd` (started → output → completed) and the prompt is completed. */
async function finishTurn(workSessionId: string, cmd: Cmd, text = "done") {
  server.emitTurn(workSessionId, { promptId: cmd.payload.promptId as string, text });
  await eventually(async () => {
    const [p] = await rowsOf("select status from app.work_prompts where id = $1", [cmd.payload.promptId]);
    return p?.status === "completed";
  });
}

/** This session's queued wake jobs (pg-boss's own table: ids only). */
const jobsOf = (workSessionId: string) =>
  rowsOf(
    `select id, data, state, extract(epoch from (start_after - created_on))::float as delay
       from pgboss.job where name = $1 and data->>'workSessionId' = $2 order by created_on`,
    [QUEUE, workSessionId],
  );

/** Runs every wake job now (the 3 s debounce is the job's `startAfter`; tests do not wait it out). */
async function drainWakes(): Promise<number> {
  await su.query(
    "update pgboss.job set start_after = now() where name = $1 and state in ('created', 'retry')",
    [QUEUE],
  );
  return core().jobs.drain(QUEUE);
}

const botRowOf = async (workSessionId: string) =>
  (
    await rowsOf(
      "select wake_pending, wakes_day::text as wakes_day, wakes_used, last_woken_status, last_woken_prompt_id, stopped_by_agent from app.bot_work_sessions where work_session_id = $1",
      [workSessionId],
    )
  )[0]!;

const cardOf = async (messageId: string) =>
  (
    await rowsOf(
      "select status, status_label, fields, notices, version, updated_at from app.message_cards where message_id = $1",
      [messageId],
    )
  )[0]!;

const fieldOf = (card: Json, label: string) =>
  (card.fields as Array<{ label: string; value: string }>).find((f) => f.label === label)?.value;

/** The `agent.work_session.v1` events of this session on `cell:<org>`, oldest first. */
const wakesOf = async (workSessionId: string) =>
  (
    await rowsOf(
      `select payload from app.stream_events
        where stream_id = $1 and type = $2 and payload->'workSession'->>'workSessionId' = $3 order by seq`,
      [`cell:${orgId}`, AgentChannelEventTypes.workSession, workSessionId],
    )
  ).map((r) => r.payload as Json);

const auditsFor = (action: string, workSessionId: string) =>
  rowsOf(
    "select actor_kind, actor_id, agent_id, user_id, device_id, session_id, result, metadata from app.audit_events where action = $1 and metadata->>'workSessionId' = $2 order by occurred_at",
    [action, workSessionId],
  );

/**
 * Every session of these tests ends before the next test (archived directly, so no wake follows), the hour's prompts
 * are forgotten and no wake job of an earlier case is left in the queue.
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
  await su.query("delete from pgboss.job where name = $1", [QUEUE]);
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
  // Public #eng: Víctor and Ana read it; Atlas is a member.
  engId = (await ok(victor.request("POST", "/api/v1/channels", { name: "eng", visibility: "public" })))
    .id as string;
  await ok(victor.request("POST", `/api/v1/channels/${engId}/members`, { kind: "agent", id: atlasId }));
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

  await createBotProfile(victor, atlasId, profile());
  await grantBotConsent(victor, serverId, atlasId, { allowFullAccess: true });
}, 180_000);

afterAll(async () => {
  await server?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

beforeEach(async () => {
  await quiesce();
});

// ---------------------------------------------------------------- tracer: a finished turn wakes the bot (PD-16)

describe("tracer: a finished turn wakes Atlas in its card's thread and the card says so", () => {
  it("a completed turn with nothing queued flips wake_pending and enqueues one ids-only job, about 3 s later", async () => {
    const s = await botSession();
    // The start's own transitions (idle → running) enqueued one job: it refreshes the card and wakes nobody.
    expect(await drainWakes()).toBe(1);
    expect(await wakesOf(s.workSessionId)).toEqual([]);
    expect(await botRowOf(s.workSessionId)).toMatchObject({ wake_pending: false, wakes_used: 0 });
    const running = await cardOf(s.cardMessageId);
    expect(running.status).toBe("running");
    expect(fieldOf(running, WORK_SESSION_CARD_LABELS.step)).toBe("Working · turn 1");
    await su.query("delete from pgboss.job where name = $1", [QUEUE]);

    await finishTurn(s.workSessionId, s.first);
    await eventually(async () => (await statusOf(s.workSessionId)) === "idle");
    expect((await botRowOf(s.workSessionId)).wake_pending).toBe(true);
    const jobs = await jobsOf(s.workSessionId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toEqual({ organizationId: orgId, workSessionId: s.workSessionId });
    expect(jobs[0]!.delay).toBeGreaterThan(2);
    expect(jobs[0]!.delay).toBeLessThan(4);
  });

  it("the job refreshes the card: Idle, Turn 1 done, a later Updated, one message.updated on conv:", async () => {
    const s = await botSession();
    await drainWakes();
    const before = await cardOf(s.cardMessageId);
    const [{ last }] = (await rowsOf(
      "select coalesce(max(seq), 0)::int as last from app.stream_events where stream_id = $1",
      [`conv:${engId}`],
    )) as [{ last: number }];

    await finishTurn(s.workSessionId, s.first);
    await eventually(async () => (await statusOf(s.workSessionId)) === "idle");
    expect(await drainWakes()).toBe(1);

    const after = await cardOf(s.cardMessageId);
    expect(after.status).toBe("info");
    expect(after.status_label).toBe("Idle");
    expect(fieldOf(after, WORK_SESSION_CARD_LABELS.step)).toBe("Turn 1 done");
    expect(Date.parse(fieldOf(after, WORK_SESSION_CARD_LABELS.updated)!)).toBeGreaterThan(
      Date.parse(fieldOf(before, WORK_SESSION_CARD_LABELS.updated)!),
    );
    expect(after.version).toBeGreaterThan(before.version);
    const updates = await rowsOf(
      "select payload from app.stream_events where stream_id = $1 and seq > $2 and type = 'message.updated' and payload->'message'->>'id' = $3",
      [`conv:${engId}`, last, s.cardMessageId],
    );
    expect(updates).toHaveLength(1);
  });

  it("the cell gets one agent.work_session.v1 for Atlas, as Ana, with the four tools; the row and the audit follow", async () => {
    const s = await botSession();
    await drainWakes();
    await finishTurn(s.workSessionId, s.first);
    await eventually(async () => (await statusOf(s.workSessionId)) === "idle");
    await drainWakes();

    const wakes = await wakesOf(s.workSessionId);
    expect(wakes).toHaveLength(1);
    const ev = AgentWorkSessionEvent.parse({ ...wakes[0], seq: 1 });
    expect(ev.agent.id).toBe(atlasId);
    expect(ev.message.id).toBe(s.cardMessageId);
    expect(ev.thread.rootMessageId).toBe(s.askedMessageId);
    expect(ev.message.author).toMatchObject({ kind: "user", id: anaId });
    expect(ev.workSession).toMatchObject({
      workSessionId: s.workSessionId,
      transition: "turn_done",
      status: "idle",
      pendingApprovals: 0,
      deciders: [],
    });
    expect(ev.workSession.summary).toContain("billing-api");
    expect(ev.workSession.summary.length).toBeLessThanOrEqual(500);
    expect(ev.message.text).toBe(ev.workSession.summary);
    expect(ev.turn?.tools).toEqual(expect.arrayContaining([...WORK_SESSION_TOOL_NAMES]));

    // The wake is a recorded turn of Atlas for Ana on the card message (the bot may answer it in the thread).
    const [turn] = await rowsOf(
      "select user_id, agent_id, message_id, conversation_id, session_output_read from app.agent_turns where event_id = $1",
      [ev.eventId],
    );
    expect(turn).toMatchObject({
      user_id: anaId,
      agent_id: atlasId,
      message_id: s.cardMessageId,
      conversation_id: engId,
      session_output_read: false,
    });

    expect(await botRowOf(s.workSessionId)).toMatchObject({
      wake_pending: false,
      wakes_used: 1,
      last_woken_status: "idle",
      last_woken_prompt_id: s.first.payload.promptId,
    });
    const audits = await auditsFor("bot.work_session_woken", s.workSessionId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      agent_id: atlasId,
      user_id: anaId,
      device_id: serverId,
      result: "success",
    });
    expect(audits[0]!.metadata).toEqual({
      eventId: ev.eventId,
      workSessionId: s.workSessionId,
      transition: "turn_done",
      sponsorUserId: victorId,
      requesterUserId: anaId,
      wakesUsed: 1,
    });
  });
});
