import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice } from "../../testing-device";
import { invite, pairDevice } from "../../testing-workzone";

/**
 * Phase 07.18-10, the phase's API end to end (D-06, D-07, D-08, D-13; PD-05, PD-08, PD-14, PD-15, PD-16, PD-20; E4,
 * E11, E12, E17) on a real PostgreSQL + Redis and the full API: a pool account that reaches its limit mid-turn cools
 * until its reset, and the same turn (same prompt id) re-runs on the next usable account, at most three times, shown in
 * the session and audited. A device acts only on the account its own live session uses.
 */

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

/** Token-shaped values joined at runtime, so no credential-shaped literal sits whole in the repository. */
const setupToken = (fill: string) => ["sk", "ant", "oat01", fill.repeat(48)].join("-");
const TA = setupToken("A");
const TB = setupToken("B");
const TC = setupToken("C");
const TD = setupToken("D");
const TOKENS = [TA, TB, TC, TD];

let stack: TestStack;
let su: pg.Client;
let victor: TestClient; // admin
let sam: TestClient; // developer, owner of the devices

interface Dev {
  device: FakeDevice;
  deviceId: string;
  projectId: string;
}
let pool: Dev; // hello.accountPool = 1, Claude signed in
let other: Dev; // hello.accountPool = 1, Claude signed in (another device of Sam's)
let noLogin: Dev; // hello.accountPool = 1, Claude not signed in

async function ok(res: Promise<{ status: number; body: Json | null }>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function connectDevice(
  name: string,
  project: string,
  opts: Parameters<typeof FakeDevice.connect>[3],
): Promise<Dev> {
  const paired = await pairDevice(stack, sam, name);
  const device = await FakeDevice.connect(stack.baseUrl, paired.token, undefined, opts);
  device.send({
    type: "projects.sync",
    projects: [{ localId: `lp_${project}`, name: project, gitRemote: null, defaultBranch: "main" }],
  });
  await device.next((f) => f.type === "projects.ack");
  const projects = (await ok(sam.request("GET", "/api/v1/projects"))).projects as Json[];
  return { device, deviceId: paired.deviceId, projectId: projects.find((p) => p.name === project)!.id };
}

const addToken = async (label: string, token: string) =>
  (await ok(victor.request("POST", "/api/v1/account-pool/claude/accounts", { label, token }))).id as string;

const setPolicy = (body: Json) => ok(victor.request("PUT", "/api/v1/account-pool/claude/policy", body));

const startOn = (dev: Dev) =>
  sam.request("POST", "/api/v1/work-sessions", { projectId: dev.projectId, runtime: "claude-code" });

/** Start on `dev`, take its `session.start` frame, and bring the session to idle as the daemon does. */
async function startIdle(dev: Dev) {
  const session = await ok(startOn(dev));
  const id = session.id as string;
  const frame = await dev.device.command("session.start", id);
  dev.device.ack(frame.id);
  dev.device.event(id, {
    type: "session.started",
    runtime: "claude-code",
    runtimeSessionId: `rt-${id}`,
    model: "claude-opus-5-5",
    permissionMode: "default",
  });
  dev.device.event(id, { type: "session.state", status: "idle" });
  await eventually(async () => (await sessionOf(id)).status === "idle");
  return { id, session, frame };
}

const sessionOf = async (id: string) =>
  (await ok(sam.request("GET", `/api/v1/work-sessions/${id}`))).session as Json;

const sessionRow = async (id: string) =>
  (await su.query("select pool_account_id, last_error, status from app.work_sessions where id = $1", [id]))
    .rows[0] as Json;

const accountRow = async (id: string) =>
  (await su.query("select * from app.account_pool_accounts where id = $1", [id])).rows[0] as Json;

const promptRow = async (id: string) =>
  (await su.query("select status, account_switches from app.work_prompts where id = $1", [id]))
    .rows[0] as Json;

const auditOf = async (action: string, sessionId: string) =>
  (
    await su.query(
      "select metadata, device_id, actor_kind from app.audit_events where action = $1 and session_id = $2 order by occurred_at, id",
      [action, sessionId],
    )
  ).rows as Array<{ metadata: Json; device_id: string | null; actor_kind: string }>;

const switchedEvents = async (id: string) =>
  (
    await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'work_session.event' and payload->'event'->>'type' = 'account.switched' order by seq",
      [`ws:${id}`],
    )
  ).rows.map((r) => r.payload.event as Json);

const prompt = async (id: string, body = "Fix the rounding error") =>
  (await ok(sam.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body }))).id as string;

/** The device reports that the session's account reached its limit (PD-05: before the turn's `prompt.completed`). */
function limited(
  dev: Dev,
  sessionId: string,
  f: { promptId: string | null; accountId: string | null; reason?: string; resetsAt?: Date | null },
) {
  dev.device.send({
    type: "session.account_limited",
    sessionId,
    promptId: f.promptId,
    accountId: f.accountId,
    reason: f.reason ?? "five_hour",
    resetsAt: f.resetsAt === undefined || f.resetsAt === null ? null : f.resetsAt.toISOString(),
    at: new Date().toISOString(),
  });
}

/** The turn's end as the device reports it after a limit: the prompt failed. */
function failTurn(dev: Dev, sessionId: string, promptId: string) {
  dev.device.event(sessionId, {
    type: "prompt.completed",
    promptId,
    usage: { inputTokens: 1, outputTokens: 0 },
    isError: true,
  });
}

/** Answer the prompt's turn as the daemon does, so the session is idle again. */
async function finishTurn(dev: Dev, id: string, frame: { id: string; payload: Json }) {
  dev.device.ack(frame.id);
  dev.device.event(id, { type: "prompt.started", promptId: frame.payload.promptId });
  dev.device.event(id, {
    type: "prompt.completed",
    promptId: frame.payload.promptId,
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  await eventually(async () => (await promptRow(frame.payload.promptId as string)).status === "completed");
}

/** The prompt was dispatched with `frame`; the device starts it, then its account reaches the limit. */
async function limitTurn(
  dev: Dev,
  id: string,
  frame: { id: string; payload: Json },
  f: { accountId: string | null; reason?: string; resetsAt?: Date | null },
) {
  const promptId = frame.payload.promptId as string;
  dev.device.ack(frame.id);
  dev.device.event(id, { type: "prompt.started", promptId });
  limited(dev, id, { promptId, ...f });
  failTurn(dev, id, promptId);
}

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  victor = new TestClient(stack.baseUrl);
  await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  ({ client: sam } = await invite(stack, victor, "sam@example.test", "Sam", "developer"));
  pool = await connectDevice("Pool Mac", "pool-repo", { accountPool: 1 });
  other = await connectDevice("Other Mac", "other-repo", { accountPool: 1 });
  noLogin = await connectDevice("Fresh Mac", "fresh-repo", { accountPool: 1, claudeLoggedIn: false });
}, 180_000);

afterAll(async () => {
  for (const d of [pool, other, noLogin]) await d?.device.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

/** Every test starts from an empty pool with the default policy. */
beforeEach(async () => {
  await su.query("update app.account_pool_accounts set removed_at = now() where removed_at is null");
  await su.query("delete from app.account_pool_policies");
});

describe("a limit mid-turn cools the account and the same turn re-runs on the next one (D-07, D-08, PD-05, PD-14)", () => {
  it("A reaches its limit: A cools until its reset, P is sent again with B's token, shown and audited", async () => {
    const a = await addToken("A", TA);
    const b = await addToken("B", TB);
    const { id } = await startIdle(pool);
    expect((await sessionRow(id)).pool_account_id).toBe(a);
    const p = await prompt(id);
    const first = await pool.device.command("prompt", id);
    expect(first.payload).toMatchObject({ promptId: p, account: { accountId: a, oauthToken: TA } });

    const resetsAt = new Date(Date.now() + 2 * 3_600_000);
    await limitTurn(pool, id, first, { accountId: a, resetsAt });

    const again = await pool.device.command("prompt", id);
    expect(again.payload.promptId).toBe(p);
    expect(again.payload.account).toEqual({ kind: "token", accountId: b, label: "B", oauthToken: TB });
    const row = await accountRow(a);
    expect(new Date(row.cooldown_until).toISOString()).toBe(resetsAt.toISOString());
    expect(row.limit_reason).toBe("five_hour");
    expect(await promptRow(p)).toMatchObject({ account_switches: 1 });
    expect((await sessionRow(id)).pool_account_id).toBe(b);
    expect(await switchedEvents(id)).toEqual([
      {
        type: "account.switched",
        fromLabel: "A",
        toLabel: "B",
        reason: "limit",
        until: resetsAt.toISOString(),
      },
    ]);
    const s = await sessionOf(id);
    expect(s.poolAccount).toEqual({ id: b, label: "B", provider: "claude" });
    expect(s.lastError).toBeNull();

    const [lim, ...moreLimited] = await auditOf("account_pool.limited", id);
    expect(moreLimited).toHaveLength(0);
    expect(lim!.device_id).toBe(pool.deviceId);
    expect(lim!.metadata).toMatchObject({
      accountId: a,
      reason: "five_hour",
      cooldownUntil: resetsAt.toISOString(),
    });
    const [sw, ...moreSwitched] = await auditOf("account_pool.switched", id);
    expect(moreSwitched).toHaveLength(0);
    expect(sw!.metadata).toMatchObject({ fromAccountId: a, toAccountId: b, reason: "limit" });

    await finishTurn(pool, id, again);
    expect((await promptRow(p)).status).toBe("completed");
  });

  it("the same frame replayed (offline log) changes nothing more", async () => {
    const a = await addToken("A", TA);
    await addToken("B", TB);
    const { id } = await startIdle(pool);
    await prompt(id);
    const first = await pool.device.command("prompt", id);
    const p = first.payload.promptId as string;
    const resetsAt = new Date(Date.now() + 3_600_000);
    await limitTurn(pool, id, first, { accountId: a, resetsAt });
    const again = await pool.device.command("prompt", id);

    limited(pool, id, { promptId: p, accountId: a, resetsAt });
    await finishTurn(pool, id, again);
    expect(await promptRow(p)).toMatchObject({ status: "completed", account_switches: 1 });
    expect(await switchedEvents(id)).toHaveLength(1);
    expect(await auditOf("account_pool.limited", id)).toHaveLength(1);
    expect(await auditOf("account_pool.switched", id)).toHaveLength(1);
    expect(pool.device.pending("prompt").filter((f) => f.sessionId === id)).toHaveLength(0);
  });
});

const hours = (n: number) => new Date(Date.now() + n * 3_600_000);
const setEnabled = (id: string, enabled: boolean) =>
  ok(victor.request("PATCH", `/api/v1/account-pool/accounts/${id}`, { enabled }));

describe("every limit case ends in a defined outcome (D-06, D-08, PD-15, PD-16, E3, E4, E17)", () => {
  it("three switches at most: A → B → C → D, the fourth limit cools D and the turn fails (E4)", async () => {
    const ids = [
      await addToken("A", TA),
      await addToken("B", TB),
      await addToken("C", TC),
      await addToken("D", TD),
    ];
    const resets = [hours(1), hours(2), hours(3), hours(4)];
    const { id } = await startIdle(pool);
    const p = await prompt(id);
    for (let i = 0; i < 4; i++) {
      const frame = await pool.device.command("prompt", id);
      expect(frame.payload.promptId).toBe(p);
      expect((frame.payload.account as Json).accountId).toBe(ids[i]);
      await limitTurn(pool, id, frame, { accountId: ids[i]!, resetsAt: resets[i]! });
    }
    await eventually(async () => (await promptRow(p)).status === "failed");
    expect(await promptRow(p)).toMatchObject({ account_switches: 3 });
    expect(new Date((await accountRow(ids[3]!)).cooldown_until).toISOString()).toBe(resets[3]!.toISOString());
    expect((await sessionRow(id)).pool_account_id).toBe(ids[3]);
    expect((await switchedEvents(id)).map((e) => [e.fromLabel, e.toLabel])).toEqual([
      ["A", "B"],
      ["B", "C"],
      ["C", "D"],
    ]);
    expect(await auditOf("account_pool.limited", id)).toHaveLength(4);
    expect(await auditOf("account_pool.switched", id)).toHaveLength(3);
    expect((await sessionOf(id)).lastError).toBe(
      `Every pool account reached its limit for this turn. The earliest resets at ${resets[0]!.toISOString()}.`,
    );
    expect(pool.device.pending("prompt").filter((f) => f.sessionId === id)).toHaveLength(0);
  });

  it("no usable account after a limit, fallback on: the turn re-runs on the device's own login", async () => {
    const a = await addToken("A", TA);
    const b = await addToken("B", TB);
    const { id } = await startIdle(pool);
    const p = await prompt(id);
    await limitTurn(pool, id, await pool.device.command("prompt", id), { accountId: a, resetsAt: hours(1) });
    const onB = await pool.device.command("prompt", id);
    const untilB = hours(2);
    await limitTurn(pool, id, onB, { accountId: b, resetsAt: untilB });
    const onLogin = await pool.device.command("prompt", id);
    expect(onLogin.payload.promptId).toBe(p);
    expect(onLogin.payload.account).toBeNull();
    expect((await switchedEvents(id))[1]).toEqual({
      type: "account.switched",
      fromLabel: "B",
      toLabel: null,
      reason: "limit",
      until: untilB.toISOString(),
    });
    expect((await sessionOf(id)).poolAccount).toBeNull();
    await finishTurn(pool, id, onLogin);
    expect(await promptRow(p)).toMatchObject({ status: "completed", account_switches: 2 });
  });

  it("no usable account after a limit, fallback off: the turn fails with the no_account sentence", async () => {
    const a = await addToken("A", TA);
    const b = await addToken("B", TB);
    await setPolicy({ fallbackToDeviceLogin: false });
    const { id } = await startIdle(pool);
    const p = await prompt(id);
    const untilA = hours(1);
    await limitTurn(pool, id, await pool.device.command("prompt", id), { accountId: a, resetsAt: untilA });
    await limitTurn(pool, id, await pool.device.command("prompt", id), { accountId: b, resetsAt: hours(2) });
    await eventually(async () => (await promptRow(p)).status === "failed");
    expect((await sessionOf(id)).lastError).toBe(
      `No account in the pool is ready. The earliest resets at ${untilA.toISOString()}.`,
    );
    expect(await switchedEvents(id)).toHaveLength(1);
    expect(pool.device.pending("prompt").filter((f) => f.sessionId === id)).toHaveLength(0);
  });

  it("auth_failed: A needs a new sign-in (no cooldown) and the turn re-runs on B", async () => {
    const a = await addToken("A", TA);
    const b = await addToken("B", TB);
    const { id } = await startIdle(pool);
    const p = await prompt(id);
    await limitTurn(pool, id, await pool.device.command("prompt", id), {
      accountId: a,
      reason: "auth_failed",
      resetsAt: null,
    });
    const again = await pool.device.command("prompt", id);
    expect(again.payload).toMatchObject({ promptId: p, account: { accountId: b, oauthToken: TB } });
    const row = await accountRow(a);
    expect(row.credential_state).toBe("needs_sign_in");
    expect(row.cooldown_until).toBeNull();
    expect(await switchedEvents(id)).toEqual([
      { type: "account.switched", fromLabel: "A", toLabel: "B", reason: "unavailable", until: null },
    ]);
    const [lim] = await auditOf("account_pool.limited", id);
    expect(lim!.metadata).toMatchObject({ accountId: a, reason: "auth_failed", cooldownUntil: null });
    const view = await ok(victor.request("GET", "/api/v1/account-pool"));
    expect((view.claude.accounts as Json[]).find((x) => x.id === a)?.status).toBe("needs_sign_in");
    await finishTurn(pool, id, again);
  });

  it("a limit on the device's own login moves the session to a ready pool account (E17)", async () => {
    const b = await addToken("B", TB);
    await setEnabled(b, false);
    const { id } = await startIdle(pool);
    expect((await sessionRow(id)).pool_account_id).toBeNull();
    await setEnabled(b, true);
    const p = await prompt(id);
    const first = await pool.device.command("prompt", id);
    expect(first.payload.account).toBeNull();
    const resetsAt = hours(1);
    await limitTurn(pool, id, first, { accountId: null, resetsAt });
    const again = await pool.device.command("prompt", id);
    expect(again.payload).toMatchObject({ promptId: p, account: { accountId: b, oauthToken: TB } });
    expect(await switchedEvents(id)).toEqual([
      {
        type: "account.switched",
        fromLabel: null,
        toLabel: "B",
        reason: "limit",
        until: resetsAt.toISOString(),
      },
    ]);
    expect(await auditOf("account_pool.limited", id)).toHaveLength(0);
    await finishTurn(pool, id, again);
  });

  it("a limit without a reset cools the account for 5 minutes (E3)", async () => {
    const a = await addToken("A", TA);
    await addToken("B", TB);
    const { id } = await startIdle(pool);
    await prompt(id);
    const before = Date.now();
    await limitTurn(pool, id, await pool.device.command("prompt", id), { accountId: a, resetsAt: null });
    const again = await pool.device.command("prompt", id);
    const until = new Date((await accountRow(a)).cooldown_until).getTime();
    expect(until).toBeGreaterThanOrEqual(before + 300_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 300_000);
    await finishTurn(pool, id, again);
  });
});

describe("frames that may not act change nothing (D-13, E10, E11, E12)", () => {
  /** A session on `dev` on account A with its prompt running. */
  async function inFlightOnA(dev: Dev = pool) {
    const a = await addToken("A", TA);
    const b = await addToken("B", TB);
    const { id } = await startIdle(dev);
    const p = await prompt(id);
    const frame = await dev.device.command("prompt", id);
    dev.device.ack(frame.id);
    dev.device.event(id, { type: "prompt.started", promptId: p });
    await eventually(async () => (await promptRow(p)).status === "running");
    return { a, b, id, p, frame };
  }

  /** Nothing happened to the session, its prompt or the accounts; nothing audited. */
  async function expectUntouched(id: string, p: string, accounts: string[]) {
    expect(await promptRow(p)).toMatchObject({ status: "running", account_switches: 0 });
    for (const acc of accounts) {
      const row = await accountRow(acc);
      expect(row.cooldown_until).toBeNull();
      expect(row.credential_state).toBe("ok");
    }
    expect(await switchedEvents(id)).toHaveLength(0);
    expect(await auditOf("account_pool.limited", id)).toHaveLength(0);
  }

  /** Wait until the link applied every frame sent before a marker event (one link, frames in order). */
  async function settle(dev: Dev, id: string) {
    const marker = `marker-${Math.random().toString(36).slice(2)}`;
    dev.device.event(id, { type: "assistant.message", messageId: marker, text: marker });
    await eventually(async () => {
      const r = await su.query(
        "select 1 from app.stream_events where stream_id = $1 and payload->'event'->>'messageId' = $2",
        [`ws:${id}`, marker],
      );
      return r.rows.length > 0;
    });
  }

  it("a frame naming account B while the session uses A", async () => {
    const { a, b, id, p, frame } = await inFlightOnA();
    limited(pool, id, { promptId: p, accountId: b, resetsAt: hours(1) });
    await settle(pool, id);
    await expectUntouched(id, p, [a, b]);
    await finishTurn(pool, id, frame);
  });

  it("a frame for a session of another device", async () => {
    const { a, b, id, p, frame } = await inFlightOnA(other);
    const own = await startIdle(pool);
    limited(pool, id, { promptId: p, accountId: a, resetsAt: hours(1) });
    // The frame went on the pool device's link: a marker on one of its own sessions comes after it.
    await settle(pool, own.id);
    await expectUntouched(id, p, [a, b]);
    await finishTurn(other, id, frame);
  });

  it("a frame naming an account of another organization", async () => {
    const { a, b, id, p, frame } = await inFlightOnA();
    const orgB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
      orgB,
      `other-${orgB}`,
    ]);
    const foreign = (
      await su.query(
        "insert into app.account_pool_accounts (organization_id, provider, kind, label, cell_profile_id) values ($1, 'chatgpt', 'cell_profile', 'Theirs', 'openai:theirs') returning id",
        [orgB],
      )
    ).rows[0].id as string;
    limited(pool, id, { promptId: p, accountId: foreign, resetsAt: hours(1) });
    await settle(pool, id);
    await expectUntouched(id, p, [a, b]);
    expect((await accountRow(foreign)).cooldown_until).toBeNull();
    await finishTurn(pool, id, frame);
  });

  it("a frame for a completed prompt cools the account and switches nothing", async () => {
    const a = await addToken("A", TA);
    await addToken("B", TB);
    const { id } = await startIdle(pool);
    const p = await prompt(id);
    await finishTurn(pool, id, await pool.device.command("prompt", id));
    const resetsAt = hours(1);
    limited(pool, id, { promptId: p, accountId: a, resetsAt });
    await settle(pool, id);
    expect(new Date((await accountRow(a)).cooldown_until).toISOString()).toBe(resetsAt.toISOString());
    expect(await auditOf("account_pool.limited", id)).toHaveLength(1);
    expect(await promptRow(p)).toMatchObject({ status: "completed", account_switches: 0 });
    expect(await switchedEvents(id)).toHaveLength(0);
    expect((await sessionRow(id)).pool_account_id).toBe(a);
    expect(pool.device.pending("prompt").filter((f) => f.sessionId === id)).toHaveLength(0);
  });

  it("an account.switched event a device sends is dropped (E12)", async () => {
    await addToken("A", TA);
    const { id } = await startIdle(pool);
    pool.device.event(id, {
      type: "account.switched",
      fromLabel: "A",
      toLabel: "Mallory",
      reason: "limit",
      until: null,
    });
    await settle(pool, id);
    expect(await switchedEvents(id)).toHaveLength(0);
  });
});

// Kept last: every scenario above has run, so the scan covers them all.
describe("E8: the tokens never reach the database outside the secret store", () => {
  it("no device command, audit row or stream event contains a token", async () => {
    for (const token of TOKENS) {
      const like = `%${token}%`;
      const counts = await Promise.all(
        [
          "select count(*)::int as n from app.device_commands where payload::text like $1",
          "select count(*)::int as n from app.audit_events where metadata::text like $1",
          "select count(*)::int as n from app.stream_events where payload::text like $1",
        ].map(async (q) => (await su.query(q, [like])).rows[0].n as number),
      );
      expect(counts).toEqual([0, 0, 0]);
    }
  });
});
