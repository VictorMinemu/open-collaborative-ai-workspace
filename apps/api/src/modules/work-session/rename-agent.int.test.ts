import { createHash, randomUUID } from "node:crypto";
import {
  SESSION_RENAME_DECIDE_WITHIN_MS,
  SESSION_RENAME_TIMEOUT_MS,
  SessionRenameResultFrame,
} from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice, sleep } from "../../testing-device";
import { CLAUDE_CATALOG, CODEX_CATALOG, invite, pairDevice, settled } from "../../testing-workzone";

/**
 * Phase 07.13.1.1-03 Task 1 (D-07, D-14, PD-09, PD-11, PD-12): the session's agent renames its session through
 * `ocw_session` › `rename`, which the device sends as `session.rename` on the Device Link. The API alone decides it: the
 * device that runs the session, a turn of that session in flight, a title nobody typed, one rename per turn, the
 * generated-title shape. The answer `session.rename.result` goes on the requesting socket only. Real PostgreSQL + Redis.
 *
 * Organization A: Víctor (admin), Pia (developer) owns "Pia's Mac" (the session's device), Ana (developer) owns
 * "Ana's Mac" (another device of the same organization). Organization B: one device inserted directly.
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };
const TITLE = "Fix login redirect";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

let stack: TestStack;
let su: pg.Client;
let orgId: string;
let admin: TestClient;
let pia: TestClient;
let piaId: string;
let anaId: string;
let pias: FakeDevice;
let piasId: string;
let anas: FakeDevice;
let intruder: FakeDevice;
let projectId: string;

/** Create an untitled session (heuristic title) and bring it to idle. */
async function started(): Promise<string> {
  const res = await pia.request("POST", "/api/v1/work-sessions", { projectId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const id = res.body!.id as string;
  const start = await pias.command("session.start", id);
  pias.ack(start.id);
  pias.event(id, {
    type: "session.started",
    runtime: "claude-code",
    runtimeSessionId: `rt-${id}`,
    permissionMode: "default",
  });
  pias.event(id, { type: "session.state", status: "idle" });
  await eventually(async () => (await sessionRow(id)).status === "idle");
  return id;
}

/** Pia sends a prompt; the device receives it (`dispatched`) and, with `running`, reports it started. */
async function inFlight(sessionId: string, running = false): Promise<string> {
  const res = await pia.request("POST", `/api/v1/work-sessions/${sessionId}/prompts`, { body: "go on" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const promptId = res.body!.id as string;
  const cmd = await pias.command("prompt", sessionId);
  expect(cmd.payload.promptId).toBe(promptId);
  pias.ack(cmd.id);
  if (running) pias.event(sessionId, { type: "prompt.started", promptId });
  await eventually(async () => (await promptStatus(promptId)) === (running ? "running" : "dispatched"));
  return promptId;
}

function complete(sessionId: string, promptId: string) {
  pias.event(sessionId, { type: "prompt.started", promptId });
  pias.event(sessionId, { type: "prompt.completed", promptId, usage: { inputTokens: 1, outputTokens: 1 } });
  return eventually(async () => (await promptStatus(promptId)) === "completed");
}

async function rename(
  dev: FakeDevice,
  sessionId: string,
  promptId: string,
  title: string,
): Promise<SessionRenameResultFrame["result"]> {
  const requestId = randomUUID();
  dev.send({ type: "session.rename", requestId, sessionId, promptId, title });
  const frame = await dev.next((f) => f.type === "session.rename.result" && f.requestId === requestId);
  return SessionRenameResultFrame.parse(frame).result;
}

const refused = async (dev: FakeDevice, sessionId: string, promptId: string, title = TITLE) => {
  const result = await rename(dev, sessionId, promptId, title);
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
  return result.reason;
};

const sessionRow = async (id: string) =>
  (
    await su.query(
      "select s.status, s.title, s.title_source, c.name as conversation_name from app.work_sessions s join app.conversations c on c.id = s.conversation_id where s.id = $1",
      [id],
    )
  ).rows[0] as { status: string; title: string; title_source: string; conversation_name: string };

const promptStatus = async (id: string) =>
  ((await su.query("select status from app.work_prompts where id = $1", [id])).rows[0] as Json)
    .status as string;

const renamedAudits = async (id: string) =>
  (
    await su.query(
      "select actor_kind, actor_id, user_id, agent_id, device_id, metadata, row_to_json(a)::text as row from app.audit_events a where action = 'work_session.renamed' and resource_id = $1 order by occurred_at, id",
      [id],
    )
  ).rows as Json[];

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await admin.request("POST", "/api/v1/setup", {
    token: TEST_SETUP_TOKEN,
    ...ADMIN,
    orgName: "Autofy Labs",
  });
  expect(setup.status, JSON.stringify(setup.body)).toBe(200);
  orgId = (setup.body!.organization as Json).id as string;
  ({ client: pia, userId: piaId } = await invite(stack, admin, "pia@example.test", "Pia Paz", "developer"));
  const anaInvite = await invite(stack, admin, "ana@example.test", "Ana Alvarez", "developer");
  const ana = anaInvite.client;
  anaId = anaInvite.userId;

  const paired = await pairDevice(stack, pia, "Pia's Mac");
  piasId = paired.deviceId;
  pias = await FakeDevice.connect(stack.baseUrl, paired.token);
  pias.send({
    type: "projects.sync",
    projects: [{ localId: "lp_web", name: "web", gitRemote: null, defaultBranch: "main" }],
  });
  await pias.next((f) => f.type === "projects.ack");
  pias.capabilities([CLAUDE_CATALOG, CODEX_CATALOG]);
  await eventually(async () => {
    const r = await su.query("select runtime_catalog from app.devices where id = $1", [piasId]);
    return (r.rows[0].runtime_catalog as unknown[]).length === 2;
  });
  projectId = (await su.query("select id from app.projects where device_id = $1", [piasId])).rows[0]
    .id as string;

  anas = await FakeDevice.connect(stack.baseUrl, (await pairDevice(stack, ana, "Ana's Mac")).token);

  // Organization B: a device of its own, inserted directly (the title test's pattern).
  const orgB = randomUUID();
  const userB = randomUUID();
  const tokenB = `ocwd_${randomUUID()}`;
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
    orgB,
    `o-${orgB}`,
  ]);
  await su.query("insert into auth.user (id, name, email) values ($1, 'B', $2)", [userB, `${userB}@b.test`]);
  await su.query(
    "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash, shared, status, runtime_info) values ($1, $2, $3, 'B mac', 'darwin', $4, true, 'online', '[]')",
    [randomUUID(), orgB, userB, createHash("sha256").update(tokenB).digest("hex")],
  );
  intruder = await FakeDevice.connect(stack.baseUrl, tokenB);
}, 240_000);

afterAll(async () => {
  try {
    for (const d of [pias, anas, intruder]) await d?.close().catch(() => {});
    await su?.end();
  } finally {
    await stack?.stop();
  }
});

describe("the session's agent renames it (D-07, D-14, PD-09)", () => {
  it("sets an automatic title, renames the conversation, audits the turn without the text and goes live", async () => {
    const id = await started();
    const promptId = await inFlight(id);
    expect(await rename(pias, id, promptId, TITLE)).toEqual({ ok: true, title: TITLE });
    expect(await sessionRow(id)).toMatchObject({
      title: TITLE,
      title_source: "auto",
      conversation_name: TITLE,
    });

    const rows = await renamedAudits(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_kind: "device",
      actor_id: piasId,
      device_id: piasId,
      user_id: piaId,
      agent_id: null,
      metadata: { by: "agent", promptId, length: 18 },
    });
    expect(rows[0]!.row).not.toContain("login redirect");

    const updated = await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'work_session.updated' order by seq desc limit 1",
      [`ws:${id}`],
    );
    expect(updated.rows[0].payload).toMatchObject({ title: TITLE, titleSource: "auto" });

    // One rename per turn; the next turn may rename again.
    expect(await refused(pias, id, promptId, "Fix login loop")).toBe("already_renamed");
    expect((await sessionRow(id)).title).toBe(TITLE);
    await complete(id, promptId);
    const next = await inFlight(id, true);
    expect(await rename(pias, id, next, "Fix login loop")).toEqual({ ok: true, title: "Fix login loop" });
    expect((await renamedAudits(id)).map((r) => r.metadata.promptId)).toEqual([promptId, next]);
  });

  it("a late title.result never replaces the agent's title (PD-12)", async () => {
    const id = await started();
    const res = await pia.request("POST", `/api/v1/work-sessions/${id}/prompts`, {
      body: "Find why the login redirect loops forever",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const promptId = res.body!.id as string;
    const title = await pias.command("session.title", id);
    const cmd = await pias.command("prompt", id);
    pias.ack(cmd.id);
    await eventually(async () => (await promptStatus(promptId)) === "dispatched");
    expect(await rename(pias, id, promptId, TITLE)).toEqual({ ok: true, title: TITLE });
    pias.titleResult(title.id, id, "Login loop fix", "haiku");
    pias.ack(title.id);
    await settled(stack, orgId);
    await sleep(300);
    expect(await sessionRow(id)).toMatchObject({ title: TITLE, title_source: "auto" });
  });

  it("names the bot that wrote the turn in the audit", async () => {
    const id = await started();
    const promptId = await inFlight(id);
    const botId = (
      await su.query(
        "insert into app.agents (organization_id, name, username, instructions, model_provider, model_id) values ($1, 'Scout', 'scout', 'Help', 'mock', 'mock-1') returning id",
        [orgId],
      )
    ).rows[0].id as string;
    await su.query("update app.work_prompts set author_agent_id = $2 where id = $1", [promptId, botId]);
    expect((await rename(pias, id, promptId, TITLE)).ok).toBe(true);
    expect((await renamedAudits(id))[0]).toMatchObject({ user_id: piaId, agent_id: botId });
  });
});

describe("refused renames change nothing (D-07, PD-11, T-07.13.1.1-03-01)", () => {
  it("another device of the organization and a device of another organization: not_available", async () => {
    const id = await started();
    const promptId = await inFlight(id);
    const before = await sessionRow(id);
    expect(await refused(anas, id, promptId)).toBe("not_available");
    expect(await refused(intruder, id, promptId)).toBe("not_available");
    // An unknown session, and a prompt of another session.
    expect(await refused(pias, randomUUID(), promptId)).toBe("not_available");
    expect(await sessionRow(id)).toEqual(before);
    expect(await renamedAudits(id)).toEqual([]);
    expect(
      (await su.query("select title_renamed_at from app.work_prompts where id = $1", [promptId])).rows[0],
    ).toEqual({ title_renamed_at: null });
    // The answers went only to the sockets that asked: Pia's device never got the others'.
    expect(await rename(pias, id, promptId, TITLE)).toEqual({ ok: true, title: TITLE });
    await sleep(200);
    expect(anas.frames.filter((f) => f.type === "session.rename.result")).toHaveLength(0);
    expect(intruder.frames.filter((f) => f.type === "session.rename.result")).toHaveLength(0);
  });

  it("no turn in flight: a finished prompt, another session's prompt and an archived session", async () => {
    const id = await started();
    const promptId = await inFlight(id);
    await complete(id, promptId);
    expect(await refused(pias, id, promptId)).toBe("no_turn");

    const other = await started();
    const otherPrompt = await inFlight(other);
    expect(await refused(pias, id, otherPrompt)).toBe("no_turn");
    expect(await refused(pias, id, "not-a-prompt-id")).toBe("no_turn");

    const archived = await started();
    const archivedPrompt = await inFlight(archived);
    const res = await pia.request("POST", `/api/v1/work-sessions/${archived}/archive`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await eventually(async () => (await sessionRow(archived)).status === "archived");
    expect(await refused(pias, archived, archivedPrompt)).toBe("no_turn");
    for (const s of [id, other, archived]) expect(await renamedAudits(s)).toEqual([]);
  });

  it("a person's title is locked (T-07.13.1.1-03-02)", async () => {
    const id = await started();
    const promptId = await inFlight(id);
    expect(
      (await pia.request("PATCH", `/api/v1/work-sessions/${id}`, { title: "Pia's own name" })).status,
    ).toBe(200);
    expect(await refused(pias, id, promptId)).toBe("title_locked");
    expect(await sessionRow(id)).toMatchObject({ title: "Pia's own name", title_source: "user" });
    expect((await renamedAudits(id)).map((r) => r.metadata.by)).toEqual(["user"]);
  });

  it("a title out of shape is refused and does not use up the turn's rename (T-07.13.1.1-03-04)", async () => {
    const id = await started();
    const promptId = await inFlight(id, true);
    const before = await sessionRow(id);
    for (const title of [
      "Fix",
      "A title that is far longer than thirty two characters",
      "Fix /Users/ana/app",
    ]) {
      expect(await refused(pias, id, promptId, title)).toBe("invalid_title");
    }
    expect(await sessionRow(id)).toEqual(before);
    expect(await renamedAudits(id)).toEqual([]);
    expect(await rename(pias, id, promptId, TITLE)).toEqual({ ok: true, title: TITLE });
  });

  it("IN-03: a rename the API reaches only after the device stopped waiting changes nothing", async () => {
    const id = await started();
    const promptId = await inFlight(id, true);
    const before = await sessionRow(id);
    // Another transaction holds the session's row past the API's budget, so the decision starts too late.
    const locker = new pg.Client({ connectionString: stack.db.superuserUrl });
    await locker.connect();
    try {
      await locker.query("begin");
      await locker.query("select id from app.work_sessions where id = $1 for update", [id]);
      const requestId = randomUUID();
      pias.send({ type: "session.rename", requestId, sessionId: id, promptId, title: TITLE });
      await sleep(SESSION_RENAME_DECIDE_WITHIN_MS + 300);
      await locker.query("rollback");
      const frame = await pias.next((f) => f.type === "session.rename.result" && f.requestId === requestId);
      expect(SessionRenameResultFrame.parse(frame).result).toEqual({ ok: false, reason: "not_available" });
    } finally {
      await locker.end();
    }
    expect(await sessionRow(id)).toEqual(before);
    expect(await renamedAudits(id)).toEqual([]);
    const claim = await su.query("select title_renamed_at from app.work_prompts where id = $1", [promptId]);
    expect(claim.rows[0].title_renamed_at).toBeNull();
    // In time, the same turn renames the session.
    expect(await rename(pias, id, promptId, TITLE)).toEqual({ ok: true, title: TITLE });
    expect(SESSION_RENAME_DECIDE_WITHIN_MS).toBeLessThan(SESSION_RENAME_TIMEOUT_MS);
  }, 30_000);

  it("IN-02: a turn whose author no longer reads the session cannot rename it", async () => {
    const id = await started();
    const promptId = await inFlight(id, true);
    // The turn keeps running (no cut turn, D-05) while its author is outside the audience: Ana, who reads nothing
    // of Pia's owner-only session, stands in for an author an Assign to me or an audience change removed.
    await su.query("update app.work_prompts set author_user_id = $2 where id = $1", [promptId, anaId]);
    const before = await sessionRow(id);
    expect(await refused(pias, id, promptId)).toBe("not_available");
    expect(await sessionRow(id)).toEqual(before);
    expect(await renamedAudits(id)).toEqual([]);
    const claim = await su.query("select title_renamed_at from app.work_prompts where id = $1", [promptId]);
    expect(claim.rows[0].title_renamed_at).toBeNull();
  });
});
