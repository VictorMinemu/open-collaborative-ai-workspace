import { createHash, randomUUID } from "node:crypto";
import {
  AgentCard,
  AgentChannelWorkSessionStartResponse,
  BOT_WORK_SESSION_SENTENCES,
  type BotWorkZoneProfileInput,
  BUILTIN_TOOLS,
  type TurnToolFlags,
  WORK_SESSION_CARD_LABELS,
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
  createTeamProject,
  freshBotTurn,
  grantBotConsent,
  invite,
  linkRepo,
  pairDevice,
  startSession,
} from "../../testing-workzone";
import { claimToolCall } from "./claim";

/**
 * Phase 07.16-15 (D-01 … D-08, D-12, D-14, D-15, D-20; PD-03, PD-08 … PD-12, PD-15, PD-21; BWZ-01, BWZ-02, BWZ-04,
 * BWZ-05): `POST /agent-channel/v1/work-sessions/start`, the phase's API end to end. A member asks a team bot in a
 * channel; the bot starts a Work Zone session itself, in its sponsor's name, within its profile's caps, with the
 * audience the server decides and a live platform card in the asker's thread. Nobody presses Start. Real PostgreSQL +
 * Redis; the device is a FakeDevice reporting a `service` host with the isolated-server mark.
 */

const CELL_TOKEN = "ocw-test-cell-token-bot-work-sessions-0123456789";
const PROMPT = "fix the failing invoice test";
const START = "ocw_work_session_start";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

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
let scratchId: string;
let notesId: string;

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

/** A channel of `visibility` holding `botIds` and `userIds` (Víctor creates it, so he is a member). */
async function channel(
  name: string,
  botIds: string[],
  userIds: string[],
  visibility: "public" | "private" = "public",
): Promise<string> {
  const id = (await ok(victor.request("POST", "/api/v1/channels", { name, visibility }))).id as string;
  for (const botId of botIds) {
    await ok(victor.request("POST", `/api/v1/channels/${id}/members`, { kind: "agent", id: botId }));
  }
  for (const userId of userIds) {
    await ok(victor.request("POST", `/api/v1/channels/${id}/members`, { kind: "user", id: userId }));
  }
  return id;
}

/** Atlas's profile on the build server: two repositories, Claude Code, Opus only, up to Full access. */
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
  maxConcurrent: 2,
  promptsPerHour: 30,
  wakesPerSessionDay: 20,
  actOnOutsideContent: false,
  ...over,
});

/** `as` asks Atlas in `conversationId` (a mention in a channel, plain text in a DM); the delivered turn's event id. */
const askAtlas = (as = ana, conversationId = engId, text = "please fix the invoice test") =>
  freshBotTurn(su, as, conversationId, `@atlas ${text} ${randomUUID().slice(0, 6)}`);

const start = (eventId: string, over: Json = {}, token = CELL_TOKEN) =>
  cell(
    "/work-sessions/start",
    { eventId, agentId: atlasId, projectId: billingId, prompt: PROMPT, ...over },
    token,
  );

/** The answer of a start that must have started. */
async function started(eventId: string, over: Json = {}) {
  const r = await start(eventId, over);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const body = AgentChannelWorkSessionStartResponse.parse(r.body);
  if (body.kind !== "started") throw new Error(`not started: ${JSON.stringify(body)}`);
  return body;
}

/** The answer of a start that must have been refused with `code`. */
async function refused(eventId: string, code: string, over: Json = {}) {
  const r = await start(eventId, over);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.kind, JSON.stringify(r.body)).toBe("refused");
  expect(r.body.code).toBe(code);
  expect(r.body.sentence).toBe(BOT_WORK_SESSION_SENTENCES[code as keyof typeof BOT_WORK_SESSION_SENTENCES]);
  return r.body;
}

const rowsOf = async (q: string, args: unknown[] = []) => (await su.query(q, args)).rows as Json[];

const auditsOf = (action: string, eventId: string) =>
  rowsOf(
    "select actor_kind, actor_id, agent_id, user_id, device_id, session_id, result, metadata from app.audit_events where action = $1 and metadata->>'eventId' = $2 order by occurred_at",
    [action, eventId],
  );

/**
 * Every bot session of these tests ends before the next test, and the hour's prompts are forgotten, so each case
 * starts from zero active sessions and an empty prompt budget (the caps are what some cases test).
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
  engId = await channel("eng", [atlasId, echoId], [anaId]);

  // Full access allowed by the organization; Víctor's build server is a service host with the isolated-server mark
  // and its own Full access opt-in.
  await ok(victor.request("PUT", "/api/v1/work-zone-policy", { allowFullAccess: true, allowFastMode: true }));
  const paired = await pairDevice(stack, victor, "billing-server");
  serverId = paired.deviceId;
  server = await FakeDevice.connect(stack.baseUrl, paired.token, undefined, {
    host: "service",
    isolatedServer: true,
  });
  server.send({
    type: "projects.sync",
    // billing-api says it is in git, ledger and scratch come from an older device (no `git`), notes has no git
    // repository (quick 261113-hu7).
    projects: [
      { name: "billing-api", git: true },
      { name: "ledger" },
      { name: "scratch" },
      { name: "notes", git: false },
    ].map((p) => ({
      localId: `lp_${p.name}`,
      name: p.name,
      gitRemote: null,
      defaultBranch: "main",
      ...(p.git !== undefined ? { git: p.git } : {}),
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
    return (
      (d.runtime_catalog as unknown[]).length === 2 &&
      d.full_access_opt_in === true &&
      d.host_kind === "service" &&
      d.isolated_server === true
    );
  });
  const list = (await ok(victor.request("GET", "/api/v1/projects"))).projects as Json[];
  billingId = list.find((p) => p.name === "billing-api")!.id as string;
  ledgerId = list.find((p) => p.name === "ledger")!.id as string;
  scratchId = list.find((p) => p.name === "scratch")!.id as string;
  notesId = list.find((p) => p.name === "notes")!.id as string;

  // The admin gives Atlas its profile (he becomes its sponsor); the device allows Atlas with Full access.
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

// ---------------------------------------------------------------- the phase's API end to end (success criterion 1)

describe("tracer: Ana asks Atlas in #eng and Atlas starts the session itself, as its sponsor", () => {
  it("answers started; the session is the sponsor's, started by Atlas in Full access, and the device runs the prompt", async () => {
    const eventId = await askAtlas();
    const [turn] = await rowsOf(
      "select message_id, conversation_id, tools from app.agent_turns where event_id = $1",
      [eventId],
    );
    expect(turn!.tools).toContain(START);

    const body = await started(eventId, { permissionMode: "fullAccess" });
    expect(body).toMatchObject({
      kind: "started",
      mode: "fullAccess",
      model: "opus",
      projectName: "billing-api",
    });
    expect(body.cardMessageId).not.toBeNull();

    const [s] = await rowsOf(
      "select created_by, started_by_agent_id, permission_mode, project_id, device_id, worktree, tainted_at from app.work_sessions where id = $1",
      [body.workSessionId],
    );
    expect(s).toMatchObject({
      created_by: victorId,
      started_by_agent_id: atlasId,
      permission_mode: "fullAccess",
      project_id: billingId,
      device_id: serverId,
      worktree: true,
      tainted_at: null,
    });
    const prompts = await rowsOf(
      "select author_user_id, author_agent_id, body, tainted from app.work_prompts where work_session_id = $1",
      [body.workSessionId],
    );
    expect(prompts).toEqual([
      { author_user_id: victorId, author_agent_id: atlasId, body: PROMPT, tainted: false },
    ]);

    // Dispatched to the device without anyone pressing Start: session.start, then the bot's prompt.
    const cmd = await server.command("session.start", body.workSessionId);
    server.ack(cmd.id as string);
    server.event(body.workSessionId, {
      type: "session.started",
      runtime: "claude-code",
      runtimeSessionId: `rt-${body.workSessionId}`,
      model: "opus",
      permissionMode: "fullAccess",
    });
    server.event(body.workSessionId, { type: "session.state", status: "idle" });
    const prompt = (await server.command("prompt", body.workSessionId)) as Json;
    expect(prompt.payload).toMatchObject({ text: PROMPT, permissionMode: "fullAccess" });
  });

  it("writes one bot_work_sessions row and posts one platform work_zone card in Ana's thread, without the prompt", async () => {
    const eventId = await askAtlas();
    const [turn] = await rowsOf("select message_id from app.agent_turns where event_id = $1", [eventId]);
    const body = await started(eventId);

    const bots = await rowsOf("select * from app.bot_work_sessions where work_session_id = $1", [
      body.workSessionId,
    ]);
    expect(bots).toHaveLength(1);
    expect(bots[0]).toMatchObject({
      agent_id: atlasId,
      sponsor_user_id: victorId,
      requester_user_id: anaId,
      origin_conversation_id: engId,
      origin_thread_root_id: turn!.message_id,
      origin_message_id: turn!.message_id,
      origin_event_id: eventId,
      card_message_id: body.cardMessageId,
    });
    expect(bots[0]!.profile_id).not.toBeNull();

    const [msg] = await rowsOf(
      "select conversation_id, thread_id, author_kind, author_id from app.messages where id = $1",
      [body.cardMessageId],
    );
    expect(msg).toMatchObject({
      conversation_id: engId,
      thread_id: turn!.message_id,
      author_kind: "agent",
      author_id: atlasId,
    });

    const card = AgentCard.parse(await ok(ana.request("GET", `/api/v1/cards/${body.cardMessageId}`)));
    expect(card.kind).toBe("work_zone");
    expect(card.platformOwned).toBe(true);
    expect(card.title).toBe("Work Zone · billing-api");
    expect(card.status).toBe("running");
    expect(card.fields.map((f) => f.label)).toEqual(Object.values(WORK_SESSION_CARD_LABELS));
    const field = (label: string) => card.fields.find((f) => f.label === label)?.value;
    expect(field("Runtime")).toBe("Claude Code");
    expect(field("Project")).toBe("billing-api");
    expect(field("Device")).toBe("billing-server");
    expect(field("Model")).toBe("opus");
    expect(field("Mode")).toBe("Supervised");
    expect(field("Step")).toBe("Starting");
    expect(Number.isNaN(Date.parse(field("Updated") ?? ""))).toBe(false);
    expect(card.actions).toEqual([
      { kind: "open", label: "Open session", target: `/work-zone/${body.workSessionId}` },
      { kind: "follow", label: "Follow" },
    ]);
    // Viewer-neutral (ADR-0031): never the prompt, the title or a team project name.
    expect(JSON.stringify(card)).not.toContain("invoice");
  });

  it("audits bot.work_session_started with ids, mode, model and promptChars, and claims one tool call for Ana", async () => {
    const eventId = await askAtlas();
    const body = await started(eventId, { permissionMode: "fullAccess" });
    const audits = await auditsOf("bot.work_session_started", eventId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_kind: "agent",
      actor_id: atlasId,
      agent_id: atlasId,
      user_id: anaId,
      device_id: serverId,
      result: "success",
    });
    expect(audits[0]!.metadata).toEqual({
      eventId,
      sponsorUserId: victorId,
      projectId: billingId,
      workSessionId: body.workSessionId,
      mode: "fullAccess",
      model: "opus",
      outcome: "started",
      promptChars: PROMPT.length,
    });
    const calls = await rowsOf(
      "select tool, user_id, decision, target from app.agent_tool_calls where event_id = $1",
      [eventId],
    );
    expect(calls).toEqual([{ tool: START, user_id: anaId, decision: "allowed", target: billingId }]);
  });
});

// ---------------------------------------------------------------- caps, settings and one executor per tree

/** Re-saves Atlas's profile (Víctor stays its sponsor); every case restores the default one afterwards. */
const saveProfile = (over: Partial<BotWorkZoneProfileInput> = {}) =>
  createBotProfile(victor, atlasId, profile(over));

const putPolicy = (body: Json) => ok(victor.request("PUT", "/api/v1/work-zone-policy", body));

/** What a refused start must not have written: sessions, prompts, bot rows, started audits. */
async function counts() {
  const [r] = await rowsOf(
    `select (select count(*)::int from app.work_sessions) as sessions,
            (select count(*)::int from app.work_prompts) as prompts,
            (select count(*)::int from app.bot_work_sessions) as bots,
            (select count(*)::int from app.audit_events where action = 'bot.work_session_started') as started`,
  );
  return r;
}

describe("caps under concurrency (D-15, PD-10, E1)", () => {
  it("max_concurrent 2 with one active session: two parallel starts give one started and one too_many_sessions", async () => {
    await started(await askAtlas());
    const a = await askAtlas();
    const b = await askAtlas();
    const answers = await Promise.all([start(a), start(b)]);
    const kinds = answers.map((r) => (r.body.kind === "refused" ? r.body.code : r.body.kind)).sort();
    expect(kinds).toEqual(["started", "too_many_sessions"]);
    const [n] = await rowsOf(
      "select count(*)::int as n from app.work_sessions where started_by_agent_id = $1 and status <> 'archived'",
      [atlasId],
    );
    expect(n!.n).toBe(2);
    const loser = answers[0]!.body.kind === "refused" ? a : b;
    const audit = await auditsOf("bot.work_session_refused", loser);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ outcome: "too_many_sessions", projectId: billingId });
  });

  it("the organization's cap: one active session of another bot and botSessionsMax 1 → org_limit", async () => {
    const other = await started(await askAtlas());
    // That session now counts as Echo's: Atlas has none of its own, the organization has one.
    await su.query("update app.work_sessions set started_by_agent_id = $1 where id = $2", [
      echoId,
      other.workSessionId,
    ]);
    await putPolicy({ botSessionsMax: 1 });
    try {
      const before = await counts();
      await refused(await askAtlas(), "org_limit");
      expect(await counts()).toEqual(before);
    } finally {
      await putPolicy({ botSessionsMax: 10 });
    }
  });

  it("prompts_per_hour 2: the start's own prompt counts; the third start in the hour → prompt_rate", async () => {
    await saveProfile({ promptsPerHour: 2 });
    try {
      for (let i = 0; i < 2; i++) {
        await started(await askAtlas());
        // The sessions end (the concurrency cap is not what refuses); the hour's prompts stay.
        await su.query("update app.work_sessions set status = 'archived' where started_by_agent_id = $1", [
          atlasId,
        ]);
      }
      await refused(await askAtlas(), "prompt_rate");
    } finally {
      await saveProfile();
    }
  });
});

describe("the bot chooses only what its profile allows (PD-09, PD-10)", () => {
  it("a model outside the profile → setting_not_allowed with field model; nothing is written", async () => {
    const before = await counts();
    const r = await refused(await askAtlas(), "setting_not_allowed", { model: "haiku" });
    expect(r.field).toBe("model");
    expect(await counts()).toEqual(before);
  });

  it("an effort outside the profile → setting_not_allowed with field effort", async () => {
    const r = await refused(await askAtlas(), "setting_not_allowed", { effort: "max" });
    expect(r.field).toBe("effort");
  });

  it("a mode above the profile → mode_not_allowed", async () => {
    await saveProfile({ maxMode: "acceptEdits" });
    try {
      await refused(await askAtlas(), "mode_not_allowed", { permissionMode: "fullAccess" });
    } finally {
      await saveProfile();
    }
  });

  it("a project of the same device outside the profile → project_not_allowed", async () => {
    await refused(await askAtlas(), "project_not_allowed", { projectId: scratchId });
  });

  it("no model → the profile's default; an allowed effort is used", async () => {
    const body = await started(await askAtlas(), { effort: "high" });
    expect(body.model).toBe("opus");
    const [s] = await rowsOf("select model, settings from app.work_sessions where id = $1", [
      body.workSessionId,
    ]);
    expect(s!.model).toBe("opus");
    expect(JSON.stringify(s!.settings)).toContain("high");
  });

  it("WR-03: allowed models without a default → the first allowed model, never the runtime's default outside the set", async () => {
    // The device's default model is opus; the profile allows sonnet only and names no default.
    await saveProfile({ defaultModel: null, allowedModels: ["sonnet"] });
    try {
      const body = await started(await askAtlas());
      expect(body.model).toBe("sonnet");
      const [s] = await rowsOf("select model from app.work_sessions where id = $1", [body.workSessionId]);
      expect(s!.model).toBe("sonnet");
    } finally {
      await saveProfile();
    }
  });

  it("WR-03: allowed efforts without a default, the model's own default outside them → setting_not_allowed effort", async () => {
    // opus's default effort is medium; the profile allows high only.
    await saveProfile({ defaultEffort: null, allowedEfforts: ["high"] });
    try {
      const before = await counts();
      const r = await refused(await askAtlas(), "setting_not_allowed");
      expect(r.field).toBe("effort");
      expect(await counts()).toEqual(before);
      // An allowed effort asked for starts.
      await started(await askAtlas(), { effort: "high" });
    } finally {
      await saveProfile();
    }
  });
});

describe("one executor per tree (D-15, PD-10)", () => {
  it("worktree false and a person's active session on the same tree → tree_busy; worktree true → started", async () => {
    await startSession(victor, server, billingId);
    await saveProfile({ worktree: false });
    try {
      const before = await counts();
      await refused(await askAtlas(), "tree_busy");
      expect(await counts()).toEqual(before);
    } finally {
      await saveProfile();
    }
    const body = await started(await askAtlas());
    const [s] = await rowsOf("select worktree from app.work_sessions where id = $1", [body.workSessionId]);
    expect(s!.worktree).toBe(true);
  });
});

// ---------------------------------------------------------------- worktree only in git projects (quick 261113-hu7)

describe("an isolated worktree only where the project is in git (quick 261113-hu7)", () => {
  it("stores what the device announced: git true, git false, absent → null; GET /projects carries it", async () => {
    const rows = await rowsOf("select name, git from app.projects where device_id = $1 order by name", [
      serverId,
    ]);
    expect(rows).toEqual([
      { name: "billing-api", git: true },
      { name: "ledger", git: null },
      { name: "notes", git: false },
      { name: "scratch", git: null },
    ]);
    const list = (await ok(victor.request("GET", "/api/v1/projects"))).projects as Json[];
    expect(list.find((p) => p.id === billingId)!.git).toBe(true);
    expect(list.find((p) => p.id === notesId)!.git).toBe(false);
    expect(list.find((p) => p.id === ledgerId)!.git).toBeUndefined();
  });

  it("profile worktree on, a project without git → the session runs on the checkout; a second start → tree_busy", async () => {
    await saveProfile({ projectIds: [billingId, ledgerId, notesId] });
    try {
      const body = await started(await askAtlas(), { projectId: notesId });
      const [s] = await rowsOf("select worktree, branch from app.work_sessions where id = $1", [
        body.workSessionId,
      ]);
      expect(s).toEqual({ worktree: false, branch: "main" });
      const cmd = (await server.command("session.start", body.workSessionId)) as Json;
      expect(cmd.payload.worktree).toBeUndefined();
      server.ack(cmd.id as string);

      // One executor per tree (principle 4, D-15): the checkout is busy, so a second start there is refused.
      const before = await counts();
      await refused(await askAtlas(), "tree_busy", { projectId: notesId });
      expect(await counts()).toEqual(before);
    } finally {
      await saveProfile();
    }
  });

  it("a project in git, or from a device that does not say, keeps the profile's worktree", async () => {
    const inGit = await started(await askAtlas());
    const unknown = await started(await askAtlas(), { projectId: ledgerId });
    const rows = await rowsOf("select id, worktree from app.work_sessions where id = any($1::uuid[])", [
      [inGit.workSessionId, unknown.workSessionId],
    ]);
    expect(rows.map((r) => r.worktree)).toEqual([true, true]);
    const cmd = (await server.command("session.start", unknown.workSessionId)) as Json;
    expect(cmd.payload.worktree).toBe(true);
  });
});

// ---------------------------------------------------------------- audience (D-07, PD-11)

describe("the audience is the server's: readers of the conversation ∩ people of the project (PD-11)", () => {
  let boId: string;
  let cyId: string;
  let deeId: string;
  let billingChannelId: string;
  let anaDmId: string;

  beforeAll(async () => {
    ({ userId: boId } = await invite(stack, victor, "bo@example.test", "Bo Lin", "developer"));
    ({ userId: cyId } = await invite(stack, victor, "cy@example.test", "Cy Mar", "developer"));
    ({ userId: deeId } = await invite(stack, victor, "dee@example.test", "Dee Ong", "developer"));
    // ledger belongs to the team project Ledger: Víctor (lead), Ana, Bo and Dee. Cy is not in it.
    const { unitId } = await createTeamProject(stack, victor, {
      name: "Ledger",
      members: [{ userId: victorId, role: "lead" }, { userId: anaId }, { userId: boId }, { userId: deeId }],
    });
    await linkRepo(stack, {
      organizationId: orgId,
      unitId,
      projectId: ledgerId,
      deviceId: serverId,
      linkedBy: victorId,
    });
    // Private #billing: Víctor, Ana, Bo and Cy (Dee is not in it).
    billingChannelId = await channel("billing", [atlasId], [anaId, boId, cyId], "private");
    const dm = await ok(
      ana.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: atlasId }] }),
    );
    anaDmId = dm.id as string;
  });

  const audienceOf = async (workSessionId: string) => {
    const [s] = await rowsOf("select visibility from app.work_sessions where id = $1", [workSessionId]);
    const grants = await rowsOf(
      "select subject_id from app.work_session_grants where work_session_id = $1 and subject_kind = 'user' and revoked_at is null",
      [workSessionId],
    );
    return { kind: s!.visibility as string, userIds: grants.map((g) => g.subject_id as string).sort() };
  };

  it("public #eng read by every project member → project", async () => {
    const body = await started(await askAtlas(), { projectId: ledgerId });
    expect(await audienceOf(body.workSessionId)).toEqual({ kind: "project", userIds: [] });
  });

  it("private #billing: its members with project access, the sponsor excluded → people [Ana, Bo]", async () => {
    const body = await started(await askAtlas(ana, billingChannelId), { projectId: ledgerId });
    expect(await audienceOf(body.workSessionId)).toEqual({ kind: "people", userIds: [anaId, boId].sort() });
  });

  it("WR-06: a private channel holding every project member → a people snapshot, never the growing project audience", async () => {
    // Private #ledger-all: Víctor, Ana, Bo and Dee, every person of Ledger today (P ⊆ R, but R is bounded).
    const allId = await channel("ledger-all", [atlasId], [anaId, boId, deeId], "private");
    const body = await started(await askAtlas(ana, allId), { projectId: ledgerId });
    // Someone who joins Ledger later never reads #ledger-all, so never sees the session either.
    expect(await audienceOf(body.workSessionId)).toEqual({
      kind: "people",
      userIds: [anaId, boId, deeId].sort(),
    });
  });

  it("Ana's DM with Atlas: people [Ana] when she has project access, owner when she has none", async () => {
    const inProject = await started(await askAtlas(ana, anaDmId), { projectId: ledgerId });
    expect(await audienceOf(inProject.workSessionId)).toEqual({ kind: "people", userIds: [anaId] });
    // billing-api is a personal repository of Víctor's unshared server: only he may use it, so only he sees it.
    await quiesce();
    const outside = await started(await askAtlas(ana, anaDmId));
    expect(await audienceOf(outside.workSessionId)).toEqual({ kind: "owner", userIds: [] });
  });

  it("the bot cannot pass an audience, a device, a user or a worktree (strict body: 400)", async () => {
    const eventId = await askAtlas();
    for (const extra of [
      { visibility: { kind: "project" } },
      { deviceId: serverId },
      { userId: anaId },
      { worktree: false },
    ]) {
      const r = await start(eventId, extra);
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    expect(await rowsOf("select 1 from app.agent_tool_calls where event_id = $1", [eventId])).toEqual([]);
  });
});

// ---------------------------------------------------------------- outside content and session output (D-08, D-20)

const SIDE: TurnToolFlags = { untrustedOutput: false, sideEffecting: true };
const READ_ONLY: TurnToolFlags = { untrustedOutput: false, sideEffecting: false };
const CELL = { organizationId: "", cellId: "test", credentialId: "env", source: "env" as const };

/** `claimToolCall` on `eventId`'s turn, as the turn's human (what the routes do), with `opts`. */
async function claimOn(
  eventId: string,
  tool: string,
  flags: TurnToolFlags,
  opts: { outsideContent?: boolean; sessionOutputExempt?: boolean; grantApprovalId?: string } = {},
) {
  return stack.built.core.db.withTenant({ organizationId: orgId, userId: anaId }, async (tx: Tx) => {
    const [turn] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, eventId));
    return claimToolCall(tx, stack.built.core, {
      cell: { ...CELL, organizationId: orgId },
      turn: turn!,
      tool,
      flags,
      web: false,
      sourceKind: "builtin",
      sourceId: null,
      target: null,
      reason: null,
      metadata: { eventId },
      ...opts,
    });
  });
}

const toolAudit = async (eventId: string, tool: string) =>
  (
    await rowsOf(
      "select result, metadata from app.audit_events where action = 'bot.tool_call' and metadata->>'eventId' = $1 and metadata->>'tool' = $2 order by occurred_at",
      [eventId, tool],
    )
  ).at(-1);

const turnRow = async (eventId: string) =>
  (
    await rowsOf("select tool_calls, tainted, session_output_read from app.agent_turns where event_id = $1", [
      eventId,
    ])
  )[0]!;

describe("the claim's outside-content and session-output options (D-08, D-20, PD-15)", () => {
  it("outsideContent claims a side-effecting call on a tainted turn and audits outsideContent: true; without it, tainted", async () => {
    const eventId = await askAtlas();
    await su.query("update app.agent_turns set tainted = true where event_id = $1", [eventId]);
    const refusedClaim = await claimOn(eventId, "ocw_board_move", SIDE);
    expect(refusedClaim).toMatchObject({ allowed: false, reason: "tainted" });
    const allowed = await claimOn(eventId, "ocw_board_move", SIDE, { outsideContent: true });
    expect(allowed).toMatchObject({ allowed: true, reason: null });
    expect((await toolAudit(eventId, "ocw_board_move"))!.metadata).toMatchObject({ outsideContent: true });
  });

  it("after a session read every other side-effecting call is refused tainted, prompt and stop are exempt", async () => {
    const eventId = await askAtlas();
    await su.query("update app.agent_turns set session_output_read = true where event_id = $1", [eventId]);
    expect(await claimOn(eventId, BUILTIN_TOOLS.memorySave, SIDE)).toMatchObject({
      allowed: false,
      reason: "tainted",
    });
    expect(
      await claimOn(eventId, BUILTIN_TOOLS.workSessionPrompt, SIDE, { sessionOutputExempt: true }),
    ).toMatchObject({ allowed: true });
    // A read-only call is not a side effect: unaffected.
    expect(await claimOn(eventId, BUILTIN_TOOLS.workZoneProjects, READ_ONLY)).toMatchObject({
      allowed: true,
    });
    // A person's one-use grant lifts it exactly as it lifts the taint (ADR-0026).
    expect(
      await claimOn(eventId, BUILTIN_TOOLS.memorySave, SIDE, { grantApprovalId: randomUUID() }),
    ).toMatchObject({ allowed: true });
    // The turn's own taint is untouched: only the session-output flag refuses.
    expect(await turnRow(eventId)).toMatchObject({ tainted: false, session_output_read: true });
  });

  it("a start on a turn that read a session's output answers session_output, recorded without counting the call", async () => {
    const eventId = await askAtlas();
    await su.query("update app.agent_turns set session_output_read = true where event_id = $1", [eventId]);
    const before = await counts();
    await refused(eventId, "session_output");
    expect(await counts()).toEqual(before);
    expect((await turnRow(eventId)).tool_calls).toBe(0);
    expect(
      await rowsOf("select decision, reason from app.agent_tool_calls where event_id = $1", [eventId]),
    ).toEqual([{ decision: "denied", reason: "session_output" }]);
    const audit = await auditsOf("bot.work_session_refused", eventId);
    expect(audit.map((a) => a.metadata.outcome)).toEqual(["session_output"]);
  });

  it("a start on a tainted turn whose asker may not use the device answers outside_content (07.16-19's fallback)", async () => {
    const eventId = await askAtlas();
    await su.query("update app.agent_turns set tainted = true where event_id = $1", [eventId]);
    const before = await counts();
    await refused(eventId, "outside_content");
    expect(await counts()).toEqual(before);
    const audit = await auditsOf("bot.work_session_refused", eventId);
    expect(audit.map((a) => a.metadata.outcome)).toEqual(["outside_content"]);
    // The proposal fallback ran for Ana, who may not use the server (work-session-taint.int.test.ts covers it).
    expect(audit[0]!.metadata).toMatchObject({ outsideContent: true, proposalRefusal: "device_not_shared" });
  });
});

// ---------------------------------------------------------------- tenant and identity (D-14, E15)

describe("tenant and identity: a start only for a live turn of this bot in this organization", () => {
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

  const expectUnknown = async (r: { status: number; body: Json }, eventId: string) => {
    expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect(r.body.error.code).toBe("unknown_turn");
    expect(await rowsOf("select 1 from app.agent_tool_calls where event_id = $1", [eventId])).toEqual([]);
    expect(await rowsOf("select 1 from app.bot_work_sessions where origin_event_id = $1", [eventId])).toEqual(
      [],
    );
  };

  it("organization B's cell token with organization A's event → 404 unknown_turn, nothing claimed or started", async () => {
    const eventId = await askAtlas();
    await expectUnknown(await start(eventId, {}, tokenB), eventId);
  });

  it("another bot's event → 404 unknown_turn", async () => {
    const eventId = await freshBotTurn(su, ana, engId, `@echo please look ${randomUUID().slice(0, 6)}`);
    await expectUnknown(await start(eventId), eventId);
  });

  it("a turn whose asker no longer reads the conversation → 404 unknown_turn", async () => {
    const opsId = await channel(`ops-${randomUUID().slice(0, 4)}`, [atlasId], [anaId], "private");
    const eventId = await askAtlas(ana, opsId);
    await su.query("delete from app.conversation_members where conversation_id = $1 and member_id = $2", [
      opsId,
      anaId,
    ]);
    await expectUnknown(await start(eventId), eventId);
  });

  it("a profile deleted after delivery → profile_inactive; a disabled bot → profile_inactive with its reason", async () => {
    const eventId = await askAtlas();
    await ok(victor.request("DELETE", `/api/v1/agents/${atlasId}/work-zone-profile`));
    try {
      const r = await refused(eventId, "profile_inactive");
      expect(r).not.toHaveProperty("reason");
    } finally {
      await saveProfile();
    }
    const again = await askAtlas();
    await su.query("update app.agents set status = 'disabled' where id = $1", [atlasId]);
    try {
      const r = await start(again);
      expect(r.body).toMatchObject({ kind: "refused", code: "profile_inactive", reason: "bot_disabled" });
      expect(r.body.sentence).toContain(BOT_WORK_SESSION_SENTENCES.profile_inactive);
    } finally {
      await su.query("update app.agents set status = 'ready' where id = $1", [atlasId]);
    }
  });
});

// ---------------------------------------------------------------- leak sweep (D-14, PD-21, P1)

describe("the prompt is in no record: audit, tool calls, the card or a log line (P1)", () => {
  it("a prompt holding OCW-MARKER-0716-start is stored only as the prompt", async () => {
    const MARKER = "OCW-MARKER-0716-start";
    const eventId = await askAtlas();
    const body = await started(eventId, { prompt: `please ${MARKER} fix it` });
    const [prompt] = await rowsOf("select body from app.work_prompts where work_session_id = $1", [
      body.workSessionId,
    ]);
    expect(prompt!.body).toContain(MARKER);
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
      await rowsOf("select id from app.messages where id = $1 and to_jsonb(messages)::text like $2", [
        body.cardMessageId,
        like,
      ]),
    ).toEqual([]);
    expect(
      await rowsOf(
        "select 1 from app.message_cards where message_id = $1 and to_jsonb(message_cards)::text like $2",
        [body.cardMessageId, like],
      ),
    ).toEqual([]);
    expect(
      await rowsOf("select 1 from app.bot_work_sessions where to_jsonb(bot_work_sessions)::text like $1", [
        like,
      ]),
    ).toEqual([]);
    const card = await ok(ana.request("GET", `/api/v1/cards/${body.cardMessageId}`));
    expect(JSON.stringify(card)).not.toContain(MARKER);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.filter((l) => l.includes(MARKER))).toEqual([]);
  });
});
