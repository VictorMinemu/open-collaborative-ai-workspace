import { randomUUID } from "node:crypto";
import {
  AgentChannelWorkSessionStartResponse,
  type BotWorkZoneProfileInput,
  WorkSessionDetail,
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
 * Phase 07.16-18 (D-06, D-08, D-13; PD-19, PD-20; E13, E14; BWZ-04, BWZ-05): the session page's way back to the
 * conversation a bot started the session from, and the marks of who wrote each prompt.
 *
 * `GET /api/v1/work-sessions/:id` answers the per-viewer `origin` only when the session has a `bot_work_sessions` row
 * and the viewer reads the origin conversation (`isReadable`; a thread through its channel). It is null for every
 * other viewer and for every person-started session, and it never rides the shared `ws:` stream or the session list
 * (the `user:` frames carry that DTO). No client return URL exists: the link is built from these ids.
 *
 * The DTO names a bot's prompts (`authorAgent`, the sponsor stays `authorUserId`), their taint, and the bot that
 * started the session (`startedByAgent`). Real PostgreSQL + Redis; the device is a FakeDevice on a `service` host.
 */

const CELL_TOKEN = "ocw-test-cell-token-bot-origin-0123456789abcdef";
const FIRST = "fix the failing invoice test";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let ana: TestClient;
let bob: TestClient;
let eve: TestClient;
let orgId: string;
let victorId: string;
let anaId: string;
let bobId: string;
let eveId: string;
let atlasId: string;
let echoId: string;
let engId: string;
let anaDmId: string;
let server: FakeDevice;
let serverId: string;
let billingId: string;
let ledgerId: string;

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

/** Organization B: Eve leaves A and becomes the admin of her own organization (the 07.9-04 matrix pattern). */
async function moveToOrgB(userId: string): Promise<string> {
  const id = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [id, `o-${id}`]);
  await su.query("delete from auth.member where user_id = $1", [userId]);
  await su.query("delete from app.org_members where user_id = $1", [userId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    id,
    userId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [id, userId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [id, userId]);
  return id;
}

/** Atlas's profile on the build server: both repositories, Claude Code, Opus only. */
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
  maxConcurrent: 10,
  promptsPerHour: 120,
  wakesPerSessionDay: 20,
  actOnOutsideContent: false,
  ...over,
});

/** Ana writes `text` in the thread rooted at `rootId` of `conversationId`; the delivered bot turn's event id. */
async function threadTurn(conversationId: string, rootId: string, text: string): Promise<string> {
  await su.query("delete from app.agent_usage_daily");
  const msg = await ok(
    ana.request("POST", `/api/v1/conversations/${conversationId}/messages`, {
      body: text,
      threadRootId: rootId,
    }),
  );
  const rows = await eventually(async () => {
    const r = (
      await su.query(
        "select payload from app.stream_events where type = 'agent.mention.v1' and payload->'message'->>'id' = $1",
        [msg.id],
      )
    ).rows as Array<{ payload: { eventId: string } }>;
    return r.length > 0 ? r : undefined;
  });
  return rows[0]!.payload.eventId;
}

/** Atlas starts a session on `projectId` from the turn `eventId`; the device takes it and reports it idle. */
async function startedFrom(eventId: string, projectId = ledgerId, agentId = atlasId): Promise<string> {
  const r = await cell("/work-sessions/start", { eventId, agentId, projectId, prompt: FIRST });
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
  const first = await server.command("prompt", id);
  server.ack(first.id);
  return id;
}

/** Ana asks Atlas in `conversationId` (top level) and Atlas starts a session from that turn. */
const botSession = async (conversationId = engId, projectId = ledgerId) =>
  startedFrom(
    await freshBotTurn(su, ana, conversationId, `@atlas please fix it ${randomUUID().slice(0, 6)}`),
    projectId,
  );

const detail = async (as: TestClient, id: string) =>
  WorkSessionDetail.parse(await ok(as.request("GET", `/api/v1/work-sessions/${id}`)));

const botRow = async (workSessionId: string) =>
  (
    await su.query(
      "select origin_conversation_id, origin_thread_root_id, origin_message_id, card_message_id from app.bot_work_sessions where work_session_id = $1",
      [workSessionId],
    )
  ).rows[0] as Json;

/** Every session of these tests ends before the next one, so the profile's caps never decide a case. */
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

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
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
  ({ client: ana, userId: anaId } = await invite(
    stack,
    victor,
    "ana@example.test",
    "Ana Pérez",
    "developer",
  ));
  ({ client: bob, userId: bobId } = await invite(stack, victor, "bob@example.test", "Bob Ros", "developer"));
  ({ client: eve, userId: eveId } = await invite(stack, victor, "eve@example.test", "Eve Moss", "developer"));
  atlasId = await teamBot("Atlas", "atlas");
  echoId = await teamBot("Echo", "echo");

  // Private #eng: Atlas, Ana and Bob. Víctor (admin, Atlas's sponsor) creates it and leaves: he does not read it.
  engId = (await ok(victor.request("POST", "/api/v1/channels", { name: "eng", visibility: "private" })))
    .id as string;
  for (const botId of [atlasId, echoId]) {
    await ok(victor.request("POST", `/api/v1/channels/${engId}/members`, { kind: "agent", id: botId }));
  }
  for (const userId of [anaId, bobId]) {
    await ok(victor.request("POST", `/api/v1/channels/${engId}/members`, { kind: "user", id: userId }));
  }
  await ok(victor.request("POST", `/api/v1/channels/${engId}/leave`));
  anaDmId = (await ok(ana.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: atlasId }] })))
    .id as string;

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
    const r = await su.query("select runtime_catalog, host_kind from app.devices where id = $1", [serverId]);
    const d = r.rows[0];
    return (d.runtime_catalog as unknown[]).length === 2 && d.host_kind === "service";
  });
  const list = (await ok(victor.request("GET", "/api/v1/projects"))).projects as Json[];
  billingId = list.find((p) => p.name === "billing-api")!.id as string;
  ledgerId = list.find((p) => p.name === "ledger")!.id as string;
  // ledger belongs to the team project Ledger: Víctor (lead), Ana and Bob.
  const { unitId } = await createTeamProject(stack, victor, {
    name: "Ledger",
    members: [{ userId: victorId, role: "lead" }, { userId: anaId }, { userId: bobId }],
  });
  await linkRepo(stack, {
    organizationId: orgId,
    unitId,
    projectId: ledgerId,
    deviceId: serverId,
    linkedBy: victorId,
  });

  for (const botId of [atlasId, echoId]) {
    await createBotProfile(victor, botId, profile());
    await grantBotConsent(victor, serverId, botId, { allowFullAccess: true });
  }
  await moveToOrgB(eveId);
}, 180_000);

afterAll(async () => {
  await server?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

beforeEach(async () => {
  await quiesce();
});

// ---------------------------------------------------------------- tracer: the way back (D-13, PD-19)

describe("tracer: Ana opens Atlas's session from the card and finds her way back to #eng", () => {
  it("answers origin { #eng, channel, 'eng', her message as thread root, the card } to Ana", async () => {
    const id = await botSession();
    const row = await botRow(id);
    expect(row.card_message_id).toBeTruthy();
    const { origin } = await detail(ana, id);
    expect(origin).toEqual({
      conversationId: engId,
      kind: "channel",
      name: "eng",
      threadRootId: row.origin_message_id,
      messageId: row.card_message_id,
    });
    // The card sits in the thread of Ana's message: the link opens that thread on the card.
    const [card] = (await su.query("select thread_id from app.messages where id = $1", [row.card_message_id]))
      .rows as Json[];
    expect(card!.thread_id).toBe(row.origin_message_id);
  });

  it("answers the same origin to Bob, who reads #eng and is in the session's audience", async () => {
    const id = await botSession();
    const row = await botRow(id);
    expect((await detail(bob, id)).origin).toMatchObject({
      conversationId: engId,
      messageId: row.card_message_id,
    });
  });
});

// ---------------------------------------------------------------- per viewer (E14, T-07.16-18-01)

describe("origin only for readers of the conversation (E14)", () => {
  it("is null for the sponsor, an admin outside the private #eng, who still reads the session", async () => {
    const id = await botSession();
    const d = await detail(victor, id);
    expect(d.session.id).toBe(id);
    expect(d.origin).toBeNull();
  });

  it("is null for Bob once he leaves #eng, though the session's audience still holds him", async () => {
    const id = await botSession();
    expect((await detail(bob, id)).origin).not.toBeNull();
    await ok(bob.request("POST", `/api/v1/channels/${engId}/leave`));
    try {
      const d = await detail(bob, id);
      expect(d.session.id).toBe(id);
      expect(d.origin).toBeNull();
    } finally {
      // Bob back in #eng for the next cases (Víctor left it, so the fixture writes the row).
      await su.query(
        "insert into app.conversation_members (conversation_id, organization_id, member_kind, member_id) values ($1, $2, 'user', $3) on conflict do nothing",
        [engId, orgId, bobId],
      );
    }
  });

  it("is null on every person-started session", async () => {
    const id = await startSession(victor, server, ledgerId);
    expect((await detail(victor, id)).origin).toBeNull();
  });

  it("another organization's member gets a 404 and nothing of the origin (tenant isolation)", async () => {
    const id = await botSession();
    const r = await eve.request("GET", `/api/v1/work-sessions/${id}`);
    expect(r.status).toBe(404);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(engId);
    expect(text).not.toContain("origin");
  });
});

// ---------------------------------------------------------------- the other conversation kinds

describe("origin in a thread, a DM, and without the card", () => {
  it("a thread reply: the thread root of the reply, the card in that thread", async () => {
    const root = await ok(
      ana.request("POST", `/api/v1/conversations/${engId}/messages`, { body: "release notes for 4.2" }),
    );
    const id = await startedFrom(
      await threadTurn(engId, root.id as string, `@atlas fix the build ${randomUUID()}`),
    );
    const row = await botRow(id);
    expect((await detail(ana, id)).origin).toEqual({
      conversationId: engId,
      kind: "channel",
      name: "eng",
      threadRootId: root.id,
      messageId: row.card_message_id,
    });
  });

  it("Ana's DM with Atlas: kind dm, named as her DM list names it", async () => {
    const id = await botSession(anaDmId);
    const row = await botRow(id);
    const { origin } = await detail(ana, id);
    expect(origin).toMatchObject({
      conversationId: anaDmId,
      kind: "dm",
      name: "Atlas",
      messageId: row.card_message_id,
    });
  });

  it("points at the asker's message when the card is gone", async () => {
    const id = await botSession();
    const row = await botRow(id);
    await su.query("update app.bot_work_sessions set card_message_id = null where work_session_id = $1", [
      id,
    ]);
    expect((await detail(ana, id)).origin).toMatchObject({
      conversationId: engId,
      messageId: row.origin_message_id,
    });
  });
});

// ---------------------------------------------------------------- shared surfaces (PD-19)

describe("origin never rides a shared surface", () => {
  it("the ws: stream and the session list (the user: frames' DTO) carry no origin", async () => {
    const id = await botSession();
    expect((await detail(ana, id)).origin).not.toBeNull();
    const events = (
      await su.query("select type, payload from app.stream_events where stream_id = $1", [`ws:${id}`])
    ).rows as Json[];
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(JSON.stringify(e.payload), e.type).not.toMatch(/"origin"\s*:/);
    const listed = ((await ok(ana.request("GET", "/api/v1/work-sessions"))).sessions as Json[]).find(
      (s) => s.id === id,
    );
    expect(listed).toBeDefined();
    expect(JSON.stringify(listed)).not.toMatch(/"origin"\s*:/);
  });
});

// ---------------------------------------------------------------- who wrote each prompt (D-06, D-08, PD-20)

const ATLAS = () => ({ agentId: atlasId, displayName: "Atlas", handle: "atlas" });

describe("the DTO names a bot's prompts, their taint and the bot that started the session", () => {
  it("Atlas's prompt: authorAgent Atlas (the sponsor stays the author), not tainted; the session's startedByAgent", async () => {
    const id = await botSession();
    const d = await detail(ana, id);
    expect(d.session.startedByAgent).toEqual(ATLAS());
    expect(d.prompts).toHaveLength(1);
    expect(d.prompts[0]).toMatchObject({
      authorUserId: victorId,
      authorAgent: ATLAS(),
      tainted: false,
      body: FIRST,
    });
    // The shared surfaces carry the same viewer-neutral marks: the ws: prompt frames and the list row.
    const frames = (
      await su.query(
        "select payload from app.stream_events where stream_id = $1 and type = 'prompt.updated'",
        [`ws:${id}`],
      )
    ).rows as Json[];
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) expect(f.payload).toMatchObject({ authorAgent: ATLAS(), tainted: false });
    const listed = ((await ok(ana.request("GET", "/api/v1/work-sessions"))).sessions as Json[]).find(
      (s) => s.id === id,
    );
    expect(listed!.startedByAgent).toEqual(ATLAS());
  });

  it("a person's prompt in the same session: authorAgent null, tainted false", async () => {
    const id = await botSession();
    const mine = await ok(
      ana.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body: "also check the CSV export" }),
    );
    const d = await detail(ana, id);
    const p = d.prompts.find((x) => x.id === mine.id)!;
    expect(p).toMatchObject({ authorUserId: anaId, authorAgent: null, tainted: false });
  });

  it("a person-started session: startedByAgent null, its prompts authorAgent null", async () => {
    const id = await startSession(victor, server, ledgerId);
    await ok(victor.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body: "run the tests" }));
    const d = await detail(victor, id);
    expect(d.session.startedByAgent).toBeNull();
    for (const p of d.prompts) expect(p).toMatchObject({ authorAgent: null, tainted: false });
  });

  it("taint as stored: a prompt sent after outside content reads tainted", async () => {
    const id = await botSession();
    await su.query("update app.work_prompts set tainted = true where work_session_id = $1", [id]);
    const [p] = (await detail(ana, id)).prompts;
    expect(p).toMatchObject({ authorAgent: ATLAS(), tainted: true });
  });

  it("a deleted bot names nothing: soft-deleted, or its column cleared by the hard delete", async () => {
    const id = await startedFrom(
      await freshBotTurn(su, ana, engId, `@echo please fix it ${randomUUID().slice(0, 6)}`),
      ledgerId,
      echoId,
    );
    const echo = { agentId: echoId, displayName: "Echo", handle: "echo" };
    expect((await detail(ana, id)).prompts[0]!.authorAgent).toEqual(echo);
    await su.query("update app.agents set deleted_at = now() where id = $1", [echoId]);
    try {
      const gone = await detail(ana, id);
      expect(gone.prompts[0]).toMatchObject({ authorUserId: victorId, authorAgent: null });
      expect(gone.session.startedByAgent).toBeNull();
    } finally {
      await su.query("update app.agents set deleted_at = null where id = $1", [echoId]);
    }
    // A hard delete sets the column null (ON DELETE SET NULL): the prompt then names no bot either.
    await su.query("update app.work_prompts set author_agent_id = null where work_session_id = $1", [id]);
    expect((await detail(ana, id)).prompts[0]!.authorAgent).toBeNull();
  });
});
