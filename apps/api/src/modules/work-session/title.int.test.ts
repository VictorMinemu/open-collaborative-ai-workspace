import { createHash, randomUUID } from "node:crypto";
import type { ServerFrame } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice, sleep } from "../../testing-device";
import { CLAUDE_CATALOG, CODEX_CATALOG, model, pairDevice } from "../../testing-workzone";

/**
 * Automatic session titles (Phase 03.2 Plan 12, D-18 … D-20, P-14 … P-18) against a real PostgreSQL + Redis and a
 * contracts-level fake device: the `session.title` request on a session's first prompt, the `title.result`
 * answer (own device, own tenant, requested model, `SessionTitle`), the protected typed title and the audits.
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };
const PROMPT = "Please fix the login redirect bug on the settings page when the session expires";
const TITLE = "Fix login redirect bug settings";

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let adminId: string;
let device: FakeDevice;
let deviceId: string;
let projectId: string;

type SessionDto = {
  id: string;
  conversationId: string;
  title: string;
  titleSource: string;
  status: string;
  lastError: string | null;
};

async function detail(id: string): Promise<SessionDto> {
  const res = await admin.request("GET", `/api/v1/work-sessions/${id}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { session: SessionDto }).session;
}

async function create(body: Record<string, unknown>) {
  const res = await admin.request("POST", "/api/v1/work-sessions", { projectId, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as unknown as SessionDto;
}

async function audits(action: string, sessionId: string) {
  const r = await su.query(
    "select metadata, result, actor_kind from app.audit_events where action = $1 and session_id = $2 order by occurred_at",
    [action, sessionId],
  );
  return r.rows as Array<{ metadata: Record<string, unknown>; result: string; actor_kind: string }>;
}

async function conversationName(conversationId: string) {
  const r = await su.query("select name from app.conversations where id = $1", [conversationId]);
  return r.rows[0]?.name as string | undefined;
}

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
  expect(setup.status).toBe(200);
  adminId = (setup.body!.user as { id: string }).id;
  const paired = await pairDevice(stack, admin, "Víctor's MacBook");
  deviceId = paired.deviceId;
  device = await FakeDevice.connect(stack.baseUrl, paired.token, undefined, { codexLoggedIn: true });
  device.send({
    type: "projects.sync",
    projects: [{ localId: "lp_demo", name: "ocw", gitRemote: null, defaultBranch: "main" }],
  });
  await device.next((f) => f.type === "projects.ack");
  projectId = ((await admin.request("GET", "/api/v1/projects")).body!.projects as Array<{ id: string }>)[0]!
    .id;
  device.capabilities([CLAUDE_CATALOG, CODEX_CATALOG]);
  await eventually(async () => {
    const r = await su.query("select runtime_catalog from app.devices where id = $1", [deviceId]);
    return (r.rows[0].runtime_catalog as unknown[]).length === 2;
  });
}, 180_000);

afterAll(async () => {
  await device?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

describe("automatic title on the first prompt (D-18, D-20)", () => {
  let session: SessionDto;
  let request: Awaited<ReturnType<FakeDevice["command"]>>;

  it("(a) an untitled session keeps its first line as a heuristic title and asks its device for a title", async () => {
    session = await create({ prompt: PROMPT });
    expect(session.title).toBe(PROMPT);
    expect(session.titleSource).toBe("heuristic");
    request = await device.command("session.title", session.id);
    expect(request.payload).toEqual({ runtime: "claude-code", model: "haiku", prompt: PROMPT });
    const requested = await audits("work_session.title_requested", session.id);
    expect(requested).toHaveLength(1);
    expect(requested[0]!.metadata).toEqual({
      runtime: "claude-code",
      model: "haiku",
      promptLength: PROMPT.length,
    });
    expect(JSON.stringify(requested[0]!.metadata)).not.toContain("login");
  });

  it("(b) the device's title.result renames the session and its conversation, live and audited", async () => {
    // 07.9-07 (D-08): the session list learns the new title on its reader's own `user:` topic, never on `org:`.
    const mine: ServerFrame[] = [];
    const stopMine = await stack.built.core.realtime.listen(`user:${adminId}`, (f) => mine.push(f));
    device.titleResult(request.id, session.id, TITLE, "haiku");
    device.ack(request.id);
    const s = await eventually(async () => {
      const d = await detail(session.id);
      return d.titleSource === "auto" ? d : undefined;
    });
    expect(s.title).toBe(TITLE);
    expect(await conversationName(session.conversationId)).toBe(TITLE);
    const updated = await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'work_session.updated' order by seq desc limit 1",
      [`ws:${session.id}`],
    );
    expect(updated.rows[0].payload).toMatchObject({ title: TITLE, titleSource: "auto" });
    const listed = await eventually(async () =>
      mine.find(
        (f) =>
          f.op === "eph" &&
          f.type === "work_session.updated" &&
          (f.data as SessionDto).id === session.id &&
          (f.data as SessionDto).title === TITLE,
      ),
    );
    expect(listed).toMatchObject({
      op: "eph",
      topic: `user:${adminId}`,
      data: { title: TITLE, titleSource: "auto" },
    });
    await stopMine();
    const org = await su.query(
      "select payload from app.stream_events where stream_id like 'org:%' and type = 'work_session.updated' and payload->>'id' = $1",
      [session.id],
    );
    expect(org.rows).toEqual([]);
    const generated = await audits("work_session.title_generated", session.id);
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({
      actor_kind: "device",
      metadata: { model: "haiku", length: TITLE.length },
    });
  });

  it("(d) a second title.result for the same request changes nothing", async () => {
    device.titleResult(request.id, session.id, "Another generated title here", "haiku");
    await sleep(400);
    const s = await detail(session.id);
    expect([s.title, s.titleSource]).toEqual([TITLE, "auto"]);
    expect(await audits("work_session.title_generated", session.id)).toHaveLength(1);
  });

  it("(c) a typed title is never replaced and never asks for a title", async () => {
    const typed = await create({ title: "Typed by me", prompt: PROMPT });
    expect(typed.titleSource).toBe("user");
    const start = await device.command("session.start", typed.id);
    device.ack(start.id);
    device.event(typed.id, { type: "session.state", status: "idle" });
    const prompt = await device.command("prompt", typed.id);
    expect(prompt.payload.text).toBe(PROMPT);
    await sleep(300);
    expect(device.pending("session.title").filter((f) => f.sessionId === typed.id)).toEqual([]);
    expect(await audits("work_session.title_requested", typed.id)).toEqual([]);
    const s = await detail(typed.id);
    expect([s.title, s.titleSource]).toEqual(["Typed by me", "user"]);
  });
});

describe("refused title results (D-20, T-03.2-12-02)", () => {
  async function untitled() {
    const s = await create({ prompt: PROMPT });
    const cmd = await device.command("session.title", s.id);
    return { s, cmd };
  }

  it("(e) another device of the same org cannot answer this device's request", async () => {
    const { s, cmd } = await untitled();
    const other = await pairDevice(stack, admin, "Second Mac");
    const intruder = await FakeDevice.connect(stack.baseUrl, other.token);
    intruder.titleResult(cmd.id, s.id, TITLE, "haiku");
    await sleep(400);
    const after = await detail(s.id);
    expect([after.title, after.titleSource]).toEqual([PROMPT, "heuristic"]);
    await intruder.close();
  });

  it("(f) a title out of shape is refused and audited as invalid_title", async () => {
    const { s, cmd } = await untitled();
    device.titleResult(cmd.id, s.id, "Fix the login redirect bug on settings", "haiku");
    device.titleResult(cmd.id, s.id, "Fix login\nredirect bug", "haiku");
    // 36 characters: the old 48-character cap allowed it; it no longer fits a 1440 sidebar row (D-20).
    device.titleResult(cmd.id, s.id, "Fix login redirect bug settings page", "haiku");
    await eventually(async () => (await audits("work_session.title_failed", s.id)).length === 3);
    const failed = await audits("work_session.title_failed", s.id);
    expect(failed.map((f) => f.metadata)).toEqual([
      { reason: "invalid_title", model: "haiku" },
      { reason: "invalid_title", model: "haiku" },
      { reason: "invalid_title", model: "haiku" },
    ]);
    const after = await detail(s.id);
    expect([after.title, after.titleSource, after.lastError]).toEqual([PROMPT, "heuristic", null]);
  });

  it("(g) a title from another model than the requested one is refused as model_mismatch", async () => {
    const { s, cmd } = await untitled();
    device.titleResult(cmd.id, s.id, TITLE, "opus");
    await eventually(async () => (await audits("work_session.title_failed", s.id)).length === 1);
    expect((await audits("work_session.title_failed", s.id))[0]!.metadata).toEqual({
      reason: "model_mismatch",
      model: "haiku",
    });
    const after = await detail(s.id);
    expect([after.title, after.titleSource]).toEqual([PROMPT, "heuristic"]);
  });

  it("(h) a device of another organization cannot title this session", async () => {
    const { s, cmd } = await untitled();
    const orgB = randomUUID();
    const userB = randomUUID();
    const devB = randomUUID();
    const tokenB = `ocwd_${randomUUID()}`;
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
      orgB,
      `o-${orgB}`,
    ]);
    await su.query("insert into auth.user (id, name, email) values ($1, 'B', $2)", [
      userB,
      `${userB}@b.test`,
    ]);
    await su.query(
      "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash, shared, status, runtime_info) values ($1, $2, $3, 'B mac', 'darwin', $4, true, 'online', '[]')",
      [devB, orgB, userB, createHash("sha256").update(tokenB).digest("hex")],
    );
    const intruder = await FakeDevice.connect(stack.baseUrl, tokenB);
    intruder.titleResult(cmd.id, s.id, TITLE, "haiku");
    await sleep(400);
    const after = await detail(s.id);
    expect([after.title, after.titleSource]).toEqual([PROMPT, "heuristic"]);
    expect(await audits("work_session.title_failed", s.id)).toEqual([]);
    await intruder.close();
  });
});

// ---------------------------------------------------------------- Task 3: fallbacks (D-19)

/** Create a session and bring it to idle through the fake device; returns its id. */
async function started(body: Record<string, unknown>): Promise<SessionDto> {
  const s = await create(body);
  const start = await device.command("session.start", s.id);
  device.ack(start.id);
  device.event(s.id, {
    type: "session.started",
    runtime: (body.runtime as string | undefined) ?? "claude-code",
    runtimeSessionId: `rt-${s.id}`,
    permissionMode: "default",
  });
  device.event(s.id, { type: "session.state", status: "idle" });
  await eventually(async () => (await detail(s.id)).status !== "provisioning");
  return s;
}

/** Ack a dispatched prompt and report it running and completed. */
async function finishPrompt(sessionId: string) {
  const cmd = await device.command("prompt", sessionId);
  device.ack(cmd.id);
  const promptId = cmd.payload.promptId as string;
  device.event(sessionId, { type: "prompt.started", promptId });
  device.event(sessionId, { type: "assistant.message", messageId: `m-${promptId}`, text: "done" });
  device.event(sessionId, { type: "prompt.completed", promptId, usage: { inputTokens: 1, outputTokens: 1 } });
  await eventually(async () => {
    const res = await admin.request("GET", `/api/v1/work-sessions/${sessionId}`);
    const prompts = (res.body as { prompts: Array<{ id: string; status: string }> }).prompts;
    return prompts.find((p) => p.id === promptId)?.status === "completed";
  });
}

const titleCommands = (sessionId: string) =>
  device.pending("session.title").filter((f) => f.sessionId === sessionId);

describe("fallbacks never block the session (D-19)", () => {
  it("(i) an org policy that leaves haiku out asks for no title; the first line stays after the turn", async () => {
    const put = await admin.request("PUT", "/api/v1/work-zone-policy", {
      allowedModels: { "claude-code": ["opus", "sonnet"], codex: [] },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    try {
      const s = await started({ prompt: PROMPT });
      await finishPrompt(s.id);
      await sleep(300);
      expect(titleCommands(s.id)).toEqual([]);
      expect(await audits("work_session.title_requested", s.id)).toEqual([]);
      const after = await detail(s.id);
      expect([after.title, after.titleSource, after.lastError]).toEqual([PROMPT, "heuristic", null]);
    } finally {
      const restore = await admin.request("PUT", "/api/v1/work-zone-policy", {
        allowedModels: { "claude-code": [], codex: [] },
      });
      expect(restore.status).toBe(200);
    }
  });

  it("(ii) a codex session asks for gpt-6-luna only when its device's codex catalog lists it", async () => {
    const without = await create({ runtime: "codex", prompt: PROMPT });
    await device.command("session.start", without.id);
    await sleep(300);
    expect(titleCommands(without.id)).toEqual([]);
    expect(await audits("work_session.title_requested", without.id)).toEqual([]);

    const withLuna = {
      ...CODEX_CATALOG,
      models: [...CODEX_CATALOG.models, model("gpt-6-luna", "GPT-6-Luna")],
    };
    device.capabilities([CLAUDE_CATALOG, withLuna]);
    await eventually(async () => {
      const r = await su.query("select runtime_catalog from app.devices where id = $1", [deviceId]);
      return JSON.stringify(r.rows[0].runtime_catalog).includes("gpt-6-luna");
    });
    const codex = await create({ runtime: "codex", prompt: PROMPT });
    const cmd = await device.command("session.title", codex.id);
    expect(cmd.payload).toEqual({ runtime: "codex", model: "gpt-6-luna", prompt: PROMPT });
    expect((await audits("work_session.title_requested", codex.id))[0]!.metadata).toMatchObject({
      runtime: "codex",
      model: "gpt-6-luna",
    });
  });

  it("(iii) a failed title ack is audited with its code; the session, its prompt and lastError are untouched", async () => {
    const s = await started({ prompt: PROMPT });
    const cmd = await device.command("session.title", s.id);
    device.ack(cmd.id, false, "title_timeout: no answer in 20s");
    await eventually(async () => (await audits("work_session.title_failed", s.id)).length === 1);
    const failed = await audits("work_session.title_failed", s.id);
    expect(failed[0]!.metadata).toEqual({ reason: "title_timeout", model: "haiku" });
    await finishPrompt(s.id);
    await eventually(async () => (await detail(s.id)).status === "idle");
    const after = await detail(s.id);
    expect([after.title, after.titleSource, after.lastError, after.status]).toEqual([
      PROMPT,
      "heuristic",
      null,
      "idle",
    ]);
    const events = await su.query(
      "select count(*)::int as n from app.stream_events where stream_id = $1 and payload->'event'->>'type' = 'session.error'",
      [`ws:${s.id}`],
    );
    expect(events.rows[0].n).toBe(0);
  });

  it("(iii-b) a failed ack without a code is audited as title_failed", async () => {
    const s = await create({ prompt: PROMPT });
    const cmd = await device.command("session.title", s.id);
    device.ack(cmd.id, false, "the device went away");
    await eventually(async () => (await audits("work_session.title_failed", s.id)).length === 1);
    expect((await audits("work_session.title_failed", s.id))[0]!.metadata).toEqual({
      reason: "title_failed",
      model: "haiku",
    });
  });
});

describe("a session created without a prompt (D-19)", () => {
  const BODY =
    "Add a dark mode toggle to the account settings page\nKeep the current colors as the light theme.";
  const FIRST = "Add a dark mode toggle to the account settings page";

  it("(iv) starts as '<project> · Claude Code'; its first prompt sets the first line and asks for a title", async () => {
    const s = await started({});
    expect([s.title, s.titleSource]).toEqual(["ocw · Claude Code", "heuristic"]);
    const res = await admin.request("POST", `/api/v1/work-sessions/${s.id}/prompts`, { body: BODY });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await detail(s.id);
    expect([after.title, after.titleSource]).toEqual([FIRST, "heuristic"]);
    expect(await conversationName(s.conversationId)).toBe(FIRST);
    const updated = await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'work_session.updated' order by seq desc limit 1",
      [`ws:${s.id}`],
    );
    expect(updated.rows[0].payload).toMatchObject({ title: FIRST });
    const cmd = await device.command("session.title", s.id);
    expect(cmd.payload).toEqual({ runtime: "claude-code", model: "haiku", prompt: BODY });

    // (vi) a second prompt never asks again
    const second = await admin.request("POST", `/api/v1/work-sessions/${s.id}/prompts`, {
      body: "And a test",
    });
    expect(second.status).toBe(200);
    await sleep(300);
    expect(titleCommands(s.id)).toEqual([]);
    expect(await audits("work_session.title_requested", s.id)).toHaveLength(1);
    expect((await detail(s.id)).title).toBe(FIRST);
  });

  it("(v) a first prompt that is a passthrough command (/compact) asks for no title and keeps the title; (vi) nor does the next one", async () => {
    const s = await started({});
    const res = await admin.request("POST", `/api/v1/work-sessions/${s.id}/commands`, { text: "/compact" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ kind: "prompt" });
    const next = await admin.request("POST", `/api/v1/work-sessions/${s.id}/prompts`, { body: BODY });
    expect(next.status).toBe(200);
    await sleep(300);
    expect(titleCommands(s.id)).toEqual([]);
    expect(await audits("work_session.title_requested", s.id)).toEqual([]);
    const after = await detail(s.id);
    expect([after.title, after.titleSource]).toEqual(["ocw · Claude Code", "heuristic"]);
  });
});
