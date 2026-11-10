import { createHash, randomUUID } from "node:crypto";
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
let bea: TestClient;
let beaId: string;
let orgId: string;
let victorId: string;
let anaId: string;
let atlasId: string;
let engId: string;
let server: FakeDevice;
let serverId: string;
let serverToken: string;
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
async function botSession(
  opts: { prompt?: string; asker?: TestClient; conversationId?: string } = {},
): Promise<BotSession> {
  const prompt = opts.prompt ?? FIRST;
  const eventId = await freshBotTurn(
    su,
    opts.asker ?? ana,
    opts.conversationId ?? engId,
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

/** One wake-worthy step, then its job: the debounce collapses transitions that happen before the job runs. */
async function settle(workSessionId: string, status: string) {
  await eventually(async () => (await statusOf(workSessionId)) === status);
  return drainWakes();
}

/** Ana asks Atlas again in #eng: a fresh delivered turn the bot can call its tools from. */
const askAgain = (text = "how is it going") =>
  freshBotTurn(su, ana, engId, `@atlas ${text} ${randomUUID().slice(0, 6)}`);

/**
 * A person queues a prompt on the session over HTTP, with their own rights. Víctor (the sponsor) sees it; Ana does not
 * (billing-api is a personal repository of his device, so the audience is his), yet the wakes still run as her.
 */
const personPrompt = (client: TestClient, workSessionId: string, body = "also update the changelog") =>
  ok(client.request("POST", `/api/v1/work-sessions/${workSessionId}/prompts`, { body }));

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
  // The offline case: the hub marks the device offline 300 ms after it disconnects (10 s by default).
  process.env.OCW_DEVICE_OFFLINE_GRACE_MS = "300";
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
  ({ client: bea, userId: beaId } = await invite(stack, victor, "bea@example.test", "Bea Sol", "developer"));
  atlasId = await teamBot("Atlas", "atlas");
  // Public #eng: Víctor, Ana and Bea read it; Atlas is a member.
  engId = (await ok(victor.request("POST", "/api/v1/channels", { name: "eng", visibility: "public" })))
    .id as string;
  await ok(victor.request("POST", `/api/v1/channels/${engId}/members`, { kind: "agent", id: atlasId }));
  await ok(victor.request("POST", `/api/v1/channels/${engId}/members`, { kind: "user", id: anaId }));
  await ok(victor.request("POST", `/api/v1/channels/${engId}/members`, { kind: "user", id: beaId }));

  await ok(victor.request("PUT", "/api/v1/work-zone-policy", { allowFullAccess: true, allowFastMode: true }));
  const paired = await pairDevice(stack, victor, "billing-server");
  serverId = paired.deviceId;
  serverToken = paired.token;
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
  delete process.env.OCW_DEVICE_OFFLINE_GRACE_MS;
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

// ---------------------------------------------------------------- every transition (PD-16, D-09, D-10)

describe("every meaningful transition wakes Atlas once; the card always shows the session", () => {
  it("waiting_approval: the card says Approval, the deciders are named (sponsor first) and the bot can't approve", async () => {
    const s = await botSession();
    await drainWakes();
    server.emitApproval(s.workSessionId, {
      approvalId: randomUUID(),
      tool: "Bash",
      paths: ["scripts/test.sh"],
    });
    expect(await settle(s.workSessionId, "waiting_approval")).toBe(1);

    const card = await cardOf(s.cardMessageId);
    expect(card.status).toBe("pending");
    expect(card.status_label).toBe("Approval");
    expect(fieldOf(card, WORK_SESSION_CARD_LABELS.step)).toBe("Waiting for approval");
    const [ev] = await wakesOf(s.workSessionId);
    expect(ev!.workSession).toMatchObject({
      transition: "waiting_approval",
      status: "waiting_approval",
      pendingApprovals: 1,
    });
    const deciders = ev!.workSession.deciders as Json[];
    expect(deciders.length).toBeGreaterThanOrEqual(1);
    expect(deciders.length).toBeLessThanOrEqual(3);
    // The sponsor first (Víctor is also the device's owner), each with a handle the bot can @mention.
    expect(deciders[0]).toMatchObject({ id: victorId, displayName: "Víctor Ruiz" });
    for (const d of deciders) expect(d.handle).toMatch(/\S/);
    // WR-01: a count, never the runtime's tool name (the bot reads it with ocw_work_session_read).
    expect(ev!.workSession.summary).toContain("waiting for 1 approval.");
    expect(ev!.workSession.summary).not.toContain("Bash");
    expect(
      (ev!.workSession.summary as string).endsWith(
        "The bot can't approve it; mention one of the people listed.",
      ),
    ).toBe(true);
  });

  it("failed: a session.state failed frame wakes Atlas and the card says failed", async () => {
    const s = await botSession();
    await drainWakes();
    server.event(s.workSessionId, { type: "session.state", status: "failed" });
    expect(await settle(s.workSessionId, "failed")).toBe(1);
    expect((await cardOf(s.cardMessageId)).status).toBe("failed");
    const wakes = await wakesOf(s.workSessionId);
    expect(wakes.map((w) => w.workSession.transition)).toEqual(["failed"]);
  });

  it("completed: the device ends the session, Atlas hears ended and the card says succeeded", async () => {
    const s = await botSession();
    await finishTurn(s.workSessionId, s.first);
    await settle(s.workSessionId, "idle");
    server.event(s.workSessionId, { type: "session.state", status: "completed" });
    expect(await settle(s.workSessionId, "completed")).toBe(1);
    expect((await cardOf(s.cardMessageId)).status).toBe("succeeded");
    const wakes = await wakesOf(s.workSessionId);
    expect(wakes.map((w) => w.workSession.transition)).toEqual(["turn_done", "ended"]);
    expect(wakes[1]!.workSession.status).toBe("completed");
  });

  it("archived by a person: Víctor archives over HTTP, Atlas hears ended, the card says Stopped", async () => {
    const s = await botSession();
    await drainWakes();
    await ok(victor.request("POST", `/api/v1/work-sessions/${s.workSessionId}/archive`));
    expect(await settle(s.workSessionId, "archived")).toBe(1);
    const card = await cardOf(s.cardMessageId);
    expect(card.status).toBe("cancelled");
    expect(card.status_label).toBe("Stopped");
    const wakes = await wakesOf(s.workSessionId);
    expect(wakes.map((w) => [w.workSession.transition, w.workSession.status])).toEqual([
      ["ended", "archived"],
    ]);
  });

  it("the bot's own stop refreshes the card and wakes nobody", async () => {
    const s = await botSession();
    await drainWakes();
    const r = await cell("/work-sessions/stop", {
      eventId: await askAgain("stop it"),
      agentId: atlasId,
      workSessionId: s.workSessionId,
    });
    expect(r.body.kind, JSON.stringify(r.body)).toBe("stopped");
    expect(await settle(s.workSessionId, "archived")).toBe(1);
    const card = await cardOf(s.cardMessageId);
    expect(card.status).toBe("cancelled");
    expect(card.status_label).toBe("Stopped");
    expect(await wakesOf(s.workSessionId)).toEqual([]);
    expect(await auditsFor("bot.work_session_woken", s.workSessionId)).toEqual([]);
    expect((await botRowOf(s.workSessionId)).stopped_by_agent).toBe(true);
  });

  it("E6: a completed turn with another prompt queued goes straight back to running: no wake, Working · turn 2", async () => {
    const s = await botSession();
    await drainWakes();
    await personPrompt(victor, s.workSessionId);
    await finishTurn(s.workSessionId, s.first);
    const second = (await server.command("prompt", s.workSessionId)) as Cmd;
    server.ack(second.id);
    // idle → running happened in the prompt.completed transaction: one job, and it sees running.
    expect(await settle(s.workSessionId, "running")).toBe(1);
    expect(await wakesOf(s.workSessionId)).toEqual([]);
    const card = await cardOf(s.cardMessageId);
    expect(card.status).toBe("running");
    expect(fieldOf(card, WORK_SESSION_CARD_LABELS.step)).toBe("Working · turn 2");
    expect(await botRowOf(s.workSessionId)).toMatchObject({ wakes_used: 0, last_woken_status: null });
  });
});

// ---------------------------------------------------------------- debounce, idempotency, budget (E7, E8, PD-22)

describe("bounded and idempotent: one pending wake, one wake per state, a daily budget", () => {
  it("debounce: transitions before the job runs collapse into one job (the row flag)", async () => {
    const s = await botSession();
    // The start's idle → running already flipped the flag; the approval does not queue another job.
    server.emitApproval(s.workSessionId, { approvalId: randomUUID(), tool: "Edit", paths: ["src/a.ts"] });
    await eventually(async () => (await statusOf(s.workSessionId)) === "waiting_approval");
    expect(await jobsOf(s.workSessionId)).toHaveLength(1);
    expect(await drainWakes()).toBe(1);
    expect((await wakesOf(s.workSessionId)).map((w) => w.workSession.transition)).toEqual([
      "waiting_approval",
    ]);
  });

  it("E8: the same job run again, or its payload sent again, delivers no second wake", async () => {
    const s = await botSession();
    await drainWakes();
    await finishTurn(s.workSessionId, s.first);
    await settle(s.workSessionId, "idle");
    expect(await wakesOf(s.workSessionId)).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      await core().db.withTenant({ organizationId: orgId, userId: null }, (tx) =>
        core().jobs.sendInTx(tx, QUEUE, { organizationId: orgId, workSessionId: s.workSessionId }),
      );
    }
    expect(await drainWakes()).toBe(2);
    expect(await wakesOf(s.workSessionId)).toHaveLength(1);
    expect(await auditsFor("bot.work_session_woken", s.workSessionId)).toHaveLength(1);
    expect((await botRowOf(s.workSessionId)).wakes_used).toBe(1);
  });

  it("E8: a state that is not a finished turn (failed) is woken for once, whatever re-runs", async () => {
    const s = await botSession();
    await drainWakes();
    server.event(s.workSessionId, { type: "session.state", status: "failed" });
    await settle(s.workSessionId, "failed");
    for (let i = 0; i < 2; i++) {
      await core().db.withTenant({ organizationId: orgId, userId: null }, (tx) =>
        core().jobs.sendInTx(tx, QUEUE, { organizationId: orgId, workSessionId: s.workSessionId }),
      );
      expect(await drainWakes()).toBe(1);
    }
    expect((await wakesOf(s.workSessionId)).map((w) => w.workSession.transition)).toEqual(["failed"]);
    expect(await botRowOf(s.workSessionId)).toMatchObject({ wakes_used: 1, last_woken_status: "failed" });
  });

  it("a later approval inside the same prompt wakes Atlas again (keyed on the newest approval), once per approval", async () => {
    const s = await botSession();
    await drainWakes();
    const first = randomUUID();
    server.emitApproval(s.workSessionId, { approvalId: first, tool: "Bash", paths: ["scripts/test.sh"] });
    await settle(s.workSessionId, "waiting_approval");
    // The runtime's first request is decided on the device; the same prompt keeps running and asks again.
    server.event(s.workSessionId, { type: "approval.resolved", approvalId: first, decision: "once" });
    await settle(s.workSessionId, "running");
    const second = randomUUID();
    server.emitApproval(s.workSessionId, { approvalId: second, tool: "Edit", paths: ["src/invoice.ts"] });
    expect(await settle(s.workSessionId, "waiting_approval")).toBe(1);

    const wakes = await wakesOf(s.workSessionId);
    expect(wakes.map((w) => w.workSession.transition)).toEqual(["waiting_approval", "waiting_approval"]);
    expect(wakes[1]!.workSession.summary).not.toContain("Edit");
    expect((wakes[1]!.workSession.deciders as Json[])[0]).toMatchObject({ id: victorId });
    expect((await botRowOf(s.workSessionId)).wakes_used).toBe(2);

    // The same approval never wakes twice, whatever re-runs (the debounce and the budget are unchanged).
    await core().db.withTenant({ organizationId: orgId, userId: null }, (tx) =>
      core().jobs.sendInTx(tx, QUEUE, { organizationId: orgId, workSessionId: s.workSessionId }),
    );
    expect(await drainWakes()).toBe(1);
    expect(await wakesOf(s.workSessionId)).toHaveLength(2);
    expect(await auditsFor("bot.work_session_woken", s.workSessionId)).toHaveLength(2);

    // Once decided, the prompt finishes and the finished turn still wakes as before.
    server.event(s.workSessionId, { type: "approval.resolved", approvalId: second, decision: "once" });
    await settle(s.workSessionId, "running");
    await finishTurn(s.workSessionId, s.first);
    await settle(s.workSessionId, "idle");
    expect((await wakesOf(s.workSessionId)).map((w) => w.workSession.transition)).toEqual([
      "waiting_approval",
      "waiting_approval",
      "turn_done",
    ]);
    expect(await botRowOf(s.workSessionId)).toMatchObject({
      last_woken_status: "idle",
      last_woken_prompt_id: s.first.payload.promptId,
    });
  });

  it("E7: at the profile's daily budget the next wake is skipped with a card notice; the next day it resets", async () => {
    await su.query("update app.bot_work_zone_profiles set wakes_per_session_day = 2 where agent_id = $1", [
      atlasId,
    ]);
    try {
      const s = await botSession();
      await drainWakes();
      // Wake 1: the first turn is done.
      await finishTurn(s.workSessionId, s.first);
      await settle(s.workSessionId, "idle");
      // Wake 2: Víctor's prompt runs and asks for an approval.
      await personPrompt(victor, s.workSessionId);
      const second = (await server.command("prompt", s.workSessionId)) as Cmd;
      server.ack(second.id);
      await settle(s.workSessionId, "running");
      server.emitApproval(s.workSessionId, { approvalId: randomUUID(), tool: "Bash", paths: [] });
      await settle(s.workSessionId, "waiting_approval");
      expect(await wakesOf(s.workSessionId)).toHaveLength(2);
      expect((await botRowOf(s.workSessionId)).wakes_used).toBe(2);

      // The third wake-worthy transition the same day: skipped.
      server.event(s.workSessionId, { type: "session.state", status: "failed" });
      await settle(s.workSessionId, "failed");
      expect(await wakesOf(s.workSessionId)).toHaveLength(2);
      const card = await cardOf(s.cardMessageId);
      expect(card.status).toBe("failed");
      expect(card.notices).toEqual([{ tone: "neutral", text: "Wake-up limit reached for today." }]);
      const skipped = await auditsFor("bot.work_session_wake_skipped", s.workSessionId);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.metadata).toMatchObject({ reason: "budget", transition: "failed" });
      expect((await botRowOf(s.workSessionId)).wakes_used).toBe(2);

      // The next day the budget starts again: Víctor archives the session and Atlas hears it.
      await su.query(
        "update app.bot_work_sessions set wakes_day = current_date - 1 where work_session_id = $1",
        [s.workSessionId],
      );
      await ok(victor.request("POST", `/api/v1/work-sessions/${s.workSessionId}/archive`));
      await settle(s.workSessionId, "archived");
      const wakes = await wakesOf(s.workSessionId);
      expect(wakes.map((w) => w.workSession.transition)).toEqual(["turn_done", "waiting_approval", "ended"]);
      const row = await botRowOf(s.workSessionId);
      expect(row.wakes_used).toBe(1);
      expect(row.wakes_day).toBe(((await rowsOf("select current_date::text as d"))[0] as Json).d);
      // A delivered wake lifts yesterday's budget notice.
      expect((await cardOf(s.cardMessageId)).notices).toEqual([]);
    } finally {
      await su.query("update app.bot_work_zone_profiles set wakes_per_session_day = 20 where agent_id = $1", [
        atlasId,
      ]);
    }
  });
});

// ---------------------------------------------------------------- who the wake runs as, what it carries (D-17, D-21)

describe("the wake runs as the person who asked, carries what the bot may use, and is bounded by its limits", () => {
  it("Ana removed from the private channel: no wake, the card says the bot can't post here, the skip is audited", async () => {
    const opsId = (
      await ok(victor.request("POST", "/api/v1/channels", { name: "ops", visibility: "private" }))
    ).id as string;
    await ok(victor.request("POST", `/api/v1/channels/${opsId}/members`, { kind: "agent", id: atlasId }));
    await ok(victor.request("POST", `/api/v1/channels/${opsId}/members`, { kind: "user", id: anaId }));
    const s = await botSession({ conversationId: opsId });
    await drainWakes();
    await ok(victor.request("DELETE", `/api/v1/channels/${opsId}/members/user/${anaId}`));

    await finishTurn(s.workSessionId, s.first);
    await settle(s.workSessionId, "idle");
    expect(await wakesOf(s.workSessionId)).toEqual([]);
    const card = await cardOf(s.cardMessageId);
    expect(card.notices).toEqual([{ tone: "neutral", text: "The bot can't post here any more." }]);
    // The card still follows the session.
    expect(fieldOf(card, WORK_SESSION_CARD_LABELS.step)).toBe("Turn 1 done");
    const skipped = await auditsFor("bot.work_session_wake_skipped", s.workSessionId);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ agent_id: atlasId, user_id: anaId, result: "denied" });
    expect(skipped[0]!.metadata).toMatchObject({ reason: "requester_cannot_read", transition: "turn_done" });
    // Nothing of the day's budget was spent, and the same state is not tried again.
    expect(await botRowOf(s.workSessionId)).toMatchObject({ wakes_used: 0, last_woken_status: "idle" });
    await core().db.withTenant({ organizationId: orgId, userId: null }, (tx) =>
      core().jobs.sendInTx(tx, QUEUE, { organizationId: orgId, workSessionId: s.workSessionId }),
    );
    await drainWakes();
    expect(await auditsFor("bot.work_session_wake_skipped", s.workSessionId)).toHaveLength(1);
  });

  it("the wake turn is Ana's, unattended (no browser tools, no attachment listing) and tainted after outside content", async () => {
    const s = await botSession();
    await drainWakes();
    await su.query("update app.work_sessions set tainted_at = now() where id = $1", [s.workSessionId]);
    await finishTurn(s.workSessionId, s.first);
    await settle(s.workSessionId, "idle");
    const [ev] = await wakesOf(s.workSessionId);
    expect(ev).toBeDefined();
    const tools = (ev!.turn?.tools ?? []) as string[];
    expect(tools.filter((t) => t.startsWith("ocw_browser_"))).toEqual([]);
    expect(ev!.turn?.attachments).toBeUndefined();
    const [turn] = await rowsOf(
      "select user_id, tainted, session_output_read from app.agent_turns where event_id = $1",
      [ev!.eventId],
    );
    expect(turn).toEqual({ user_id: anaId, tainted: true, session_output_read: false });
  });

  it("with the consent revoked the wake still arrives (the bot can report) but carries none of the four tools", async () => {
    const s = await botSession();
    await drainWakes();
    await ok(victor.request("DELETE", `/api/v1/devices/${serverId}/bot-consents/${atlasId}`));
    try {
      await finishTurn(s.workSessionId, s.first);
      await settle(s.workSessionId, "idle");
      const [ev] = await wakesOf(s.workSessionId);
      expect(ev!.workSession.transition).toBe("turn_done");
      const tools = (ev!.turn?.tools ?? []) as string[];
      for (const name of WORK_SESSION_TOOL_NAMES) expect(tools).not.toContain(name);
      expect(ev!.turn?.workZone).toBeUndefined();
    } finally {
      await grantBotConsent(victor, serverId, atlasId, { allowFullAccess: true });
    }
  });

  it("at the bot's daily turn limit: no cell event, the limit is handled as for any turn, the wake is not spent", async () => {
    const s = await botSession();
    await drainWakes();
    // The ask that started the session counted today's first turn; the limit is now reached.
    await su.query("update app.agent_usage_daily set turns = 100000 where agent_id = $1", [atlasId]);
    try {
      await finishTurn(s.workSessionId, s.first);
      await settle(s.workSessionId, "idle");
      expect(await wakesOf(s.workSessionId)).toEqual([]);
      const limited = (
        await rowsOf(
          "select user_id, metadata from app.audit_events where action = 'agent.limit_reached' and agent_id = $1",
          [atlasId],
        )
      ).filter((a) => a.metadata.messageId === s.cardMessageId);
      expect(limited).toHaveLength(1);
      expect(limited[0]!.user_id).toBe(anaId);
      const skipped = await auditsFor("bot.work_session_wake_skipped", s.workSessionId);
      expect(skipped.map((a) => a.metadata.reason)).toEqual(["daily_limit"]);
      expect((await botRowOf(s.workSessionId)).wakes_used).toBe(0);
    } finally {
      await su.query("delete from app.agent_usage_daily");
    }
  });

  it("Bea deactivated: her session's next transition wakes nobody and the card says the bot can't post here", async () => {
    const s = await botSession({ asker: bea });
    await drainWakes();
    await ok(victor.request("POST", `/api/v1/members/${beaId}/deactivate`));
    server.event(s.workSessionId, { type: "session.state", status: "failed" });
    await settle(s.workSessionId, "failed");
    expect(await wakesOf(s.workSessionId)).toEqual([]);
    expect((await cardOf(s.cardMessageId)).notices).toEqual([
      { tone: "neutral", text: "The bot can't post here any more." },
    ]);
    const skipped = await auditsFor("bot.work_session_wake_skipped", s.workSessionId);
    expect(skipped.map((a) => [a.user_id, a.metadata.reason])).toEqual([[beaId, "requester_cannot_read"]]);
  });

  /**
   * Moves a session's origin (and its card) into `conversationId`: a stand-in card message of Atlas there, the bot row
   * pointing at it. The start route accepts AI chats and thread-kind conversations (`liveTurn`); so must the wake.
   */
  async function moveOrigin(s: BotSession, conversationId: string, threadRootId: string | null) {
    const messageId = randomUUID();
    await su.query(
      `insert into app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body, thread_id)
       values ($1, $2, $3, 1, 'agent', $4, 'Work Zone · billing-api', $5)`,
      [messageId, orgId, conversationId, atlasId, threadRootId],
    );
    await su.query(
      `update app.bot_work_sessions
          set origin_conversation_id = $2, origin_thread_root_id = $3, origin_message_id = $4, card_message_id = $4
        where work_session_id = $1`,
      [s.workSessionId, conversationId, threadRootId ?? messageId, messageId],
    );
    return messageId;
  }

  it("CR-01: a session started from an AI chat wakes the bot there, flat (the AI chat is read as an AI chat)", async () => {
    const s = await botSession();
    await drainWakes();
    const chatId = randomUUID();
    await su.query(
      `insert into app.conversations (id, organization_id, kind, visibility, name, created_by)
       values ($1, $2, 'ai_chat', 'private', 'Invoices', $3)`,
      [chatId, orgId, anaId],
    );
    await su.query(
      `insert into app.conversation_members (conversation_id, organization_id, member_kind, member_id, role)
       values ($1, $2, 'user', $3, 'owner'), ($1, $2, 'agent', $4, 'member')`,
      [chatId, orgId, anaId, atlasId],
    );
    await su.query(
      `insert into app.ai_chats (conversation_id, organization_id, owner_user_id, title_source, last_model)
       values ($1, $2, $3, 'auto', $4)`,
      [chatId, orgId, anaId, { backend: "org_key", provider: "anthropic", modelId: "claude-sonnet-5-5" }],
    );
    const card = await moveOrigin(s, chatId, null);

    await finishTurn(s.workSessionId, s.first);
    await settle(s.workSessionId, "idle");
    const wakes = await wakesOf(s.workSessionId);
    expect(wakes).toHaveLength(1);
    const ev = AgentWorkSessionEvent.parse({ ...wakes[0], seq: 1 });
    expect(ev.conversation).toMatchObject({ id: chatId, kind: "ai_chat" });
    // An AI chat is flat: the wake names the card message itself, never a thread under it.
    expect(ev.thread.rootMessageId).toBe(card);
    expect(await auditsFor("bot.work_session_wake_skipped", s.workSessionId)).toEqual([]);
  });

  it("CR-01: a session started from a thread-kind conversation is judged through its channel and wakes the bot", async () => {
    const s = await botSession();
    await drainWakes();
    const threadId = randomUUID();
    await su.query(
      `insert into app.conversations (id, organization_id, kind, visibility, parent_conversation_id, root_message_id)
       values ($1, $2, 'thread', 'public', $3, $4)`,
      [threadId, orgId, engId, s.askedMessageId],
    );
    await moveOrigin(s, threadId, s.askedMessageId);

    await finishTurn(s.workSessionId, s.first);
    await settle(s.workSessionId, "idle");
    const wakes = await wakesOf(s.workSessionId);
    expect(wakes).toHaveLength(1);
    expect(await auditsFor("bot.work_session_wake_skipped", s.workSessionId)).toEqual([]);
  });
});

// ---------------------------------------------------------------- isolation and the leak sweep (ADR-0028, P1)

describe("ids only, tenant-bound, and no content anywhere", () => {
  /** Organization B: a bot session with its own device, project, conversation, bot and a pending wake. */
  async function orgBBotSession(): Promise<{ orgB: string; wsB: string }> {
    const orgB = randomUUID();
    const userB = randomUUID();
    const devB = randomUUID();
    const projB = randomUUID();
    const convB = randomUUID();
    const wsB = randomUUID();
    const botB = randomUUID();
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
      "insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status) values ($1, $2, 'B bot', 'bbot', 'x', 'mock', 'mock-1', 'ready')",
      [botB, orgB],
    );
    await q(
      "insert into app.work_sessions (id, organization_id, conversation_id, project_id, device_id, title, created_by, status, started_by_agent_id) values ($1, $2, $3, $4, $5, 'B', $6, 'failed', $7)",
      [wsB, orgB, convB, projB, devB, userB, botB],
    );
    await q(
      "insert into app.bot_work_sessions (work_session_id, organization_id, agent_id, sponsor_user_id, requester_user_id, origin_conversation_id, origin_message_id, origin_event_id, wake_pending) values ($1, $2, $3, $4, $4, $5, $6, $7, true)",
      [wsB, orgB, botB, userB, convB, randomUUID(), randomUUID()],
    );
    return { orgB, wsB };
  }

  it("a job naming organization B's session under organization A (and the reverse) does nothing", async () => {
    const { orgB, wsB } = await orgBBotSession();
    const s = await botSession();
    await drainWakes();
    server.event(s.workSessionId, { type: "session.state", status: "failed" });
    await eventually(async () => (await statusOf(s.workSessionId)) === "failed");
    await su.query("delete from pgboss.job where name = $1", [QUEUE]);
    const cardBefore = await cardOf(s.cardMessageId);

    await core().db.withTenant({ organizationId: orgId, userId: null }, (tx) =>
      core().jobs.sendInTx(tx, QUEUE, { organizationId: orgId, workSessionId: wsB }),
    );
    await core().db.withTenant({ organizationId: orgB, userId: null }, (tx) =>
      core().jobs.sendInTx(tx, QUEUE, { organizationId: orgB, workSessionId: s.workSessionId }),
    );
    expect(await drainWakes()).toBe(2);

    // B's row is untouched (its wake stays pending), A's session is not woken from B, nothing is posted or audited.
    expect((await botRowOf(wsB)).wake_pending).toBe(true);
    expect(await wakesOf(wsB)).toEqual([]);
    expect(await wakesOf(s.workSessionId)).toEqual([]);
    expect((await cardOf(s.cardMessageId)).version).toBe(cardBefore.version);
    expect(await auditsFor("bot.work_session_woken", wsB)).toEqual([]);
    expect(await auditsFor("bot.work_session_wake_skipped", wsB)).toEqual([]);
    expect(await auditsFor("bot.work_session_woken", s.workSessionId)).toEqual([]);
    expect(await rowsOf("select 1 from app.stream_events where stream_id = $1", [`cell:${orgB}`])).toEqual(
      [],
    );
  });

  it("a prompt marker and an output marker appear in no job row, audit row, wake summary or API log line", async () => {
    const promptMarker = `OCW-MARKER-0720-prompt-${randomUUID().slice(0, 8)}`;
    const outputMarker = `OCW-MARKER-0720-output-${randomUUID().slice(0, 8)}`;
    const s = await botSession({ prompt: `fix it ${promptMarker}` });
    await drainWakes();
    await finishTurn(s.workSessionId, s.first, `all green ${outputMarker}`);
    await eventually(async () => (await statusOf(s.workSessionId)) === "idle");
    // The start's job (already run) and the finished turn's: each is exactly the two ids.
    const jobs = await jobsOf(s.workSessionId);
    expect(jobs).toHaveLength(2);
    for (const j of jobs) expect(j.data).toEqual({ organizationId: orgId, workSessionId: s.workSessionId });
    await drainWakes();
    server.event(s.workSessionId, { type: "session.state", status: "failed" });
    await settle(s.workSessionId, "failed");

    const wakes = await wakesOf(s.workSessionId);
    expect(wakes.map((w) => w.workSession.transition)).toEqual(["turn_done", "failed"]);
    for (const marker of [promptMarker, outputMarker]) {
      for (const w of wakes) {
        expect(w.workSession.summary).not.toContain(marker);
        expect(w.message.text).not.toContain(marker);
      }
      expect(
        await rowsOf("select 1 from pgboss.job where name = $1 and data::text like $2", [
          QUEUE,
          `%${marker}%`,
        ]),
      ).toEqual([]);
      expect(
        await rowsOf("select action from app.audit_events where metadata::text like $1", [`%${marker}%`]),
      ).toEqual([]);
      expect(logs.filter((line) => line.includes(marker))).toEqual([]);
    }
    // The card, read by every reader of the conversation, holds neither.
    const card = JSON.stringify(await cardOf(s.cardMessageId));
    expect(card).not.toContain(promptMarker);
    expect(card).not.toContain(outputMarker);
  });
});

// ---------------------------------------------------------------- the device goes offline (last: it reconnects)

describe("host_offline", () => {
  it("the device disconnects: Atlas hears offline and the card says Offline", async () => {
    const s = await botSession();
    await drainWakes();
    await server.close();
    try {
      expect(await settle(s.workSessionId, "host_offline")).toBe(1);
      const card = await cardOf(s.cardMessageId);
      expect(card.status).toBe("pending");
      expect(card.status_label).toBe("Offline");
      expect(fieldOf(card, WORK_SESSION_CARD_LABELS.step)).toBe("Device offline");
      const wakes = await wakesOf(s.workSessionId);
      expect(wakes.map((w) => [w.workSession.transition, w.workSession.status])).toEqual([
        ["offline", "host_offline"],
      ]);
    } finally {
      server = await FakeDevice.connect(stack.baseUrl, serverToken, undefined, {
        host: "service",
        isolatedServer: true,
      });
      server.capabilities([CLAUDE_CATALOG, CODEX_CATALOG], true, true);
    }
  });
});
