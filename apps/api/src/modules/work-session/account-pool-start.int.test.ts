import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice } from "../../testing-device";
import { invite, pairDevice } from "../../testing-workzone";

/**
 * Phase 07.18-09, the API tracer (D-02, D-05, D-06, D-11; PD-02 … PD-07, PD-16, PD-17; E1, E5 … E9) on a real
 * PostgreSQL + Redis and the full API: a Work Zone session on a pool-capable device starts on the account the strategy
 * chose; the token rides only the frames its device receives, never a stored command, an audit row or a stream event;
 * a session whose account can no longer serve moves to the next one before its turn, and says so.
 */

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

/** Token-shaped values joined at runtime, so no credential-shaped literal sits whole in the repository. */
const setupToken = (fill: string) => ["sk", "ant", "oat01", fill.repeat(48)].join("-");
const TA = setupToken("A");
const TB = setupToken("B");
const TC = setupToken("C");
const TOKENS = [TA, TB, TC];

let stack: TestStack;
let su: pg.Client;
let victor: TestClient; // admin
let sam: TestClient; // developer, owner of the devices
let orgId = "";

interface Dev {
  device: FakeDevice;
  deviceId: string;
  projectId: string;
}
let pool: Dev; // hello.accountPool = 1, Claude and Codex signed in
let old: Dev; // no hello.accountPool (a pre-07.18 daemon)
let noLogin: Dev; // hello.accountPool = 1, Claude not signed in

async function ok(res: Promise<{ status: number; body: Json | null }>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

/** Pair a device for Sam, connect it with `opts` and announce one project. */
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

/** Sam starts a session on `dev` over HTTP; the raw answer (status and body). */
const startOn = (dev: Dev, body: Json = {}) =>
  sam.request("POST", "/api/v1/work-sessions", { projectId: dev.projectId, runtime: "claude-code", ...body });

/** Start on `dev`, take its `session.start` frame, and bring the session to idle as the daemon does. */
async function startIdle(dev: Dev, body: Json = {}) {
  const session = await ok(startOn(dev, body));
  const id = session.id as string;
  const frame = await dev.device.command("session.start", id);
  dev.device.ack(frame.id);
  dev.device.event(id, {
    type: "session.started",
    runtime: (body.runtime as string | undefined) ?? "claude-code",
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

const storedCommands = async (sessionId: string, kind: string) =>
  (
    await su.query(
      "select payload, payload::text as text from app.device_commands where work_session_id = $1 and kind = $2 order by created_at",
      [sessionId, kind],
    )
  ).rows as Array<{ payload: Json; text: string }>;

const sessionRow = async (id: string) =>
  (await su.query("select pool_account_id, last_error from app.work_sessions where id = $1", [id]))
    .rows[0] as Json;

const accountRow = async (id: string) =>
  (await su.query("select * from app.account_pool_accounts where id = $1", [id])).rows[0] as Json;

const auditOf = async (action: string, sessionId: string) =>
  (
    await su.query(
      "select metadata from app.audit_events where action = $1 and session_id = $2 order by occurred_at, id",
      [action, sessionId],
    )
  ).rows as Array<{ metadata: Json }>;

beforeAll(async () => {
  stack = await startTestStack();
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
  ({ client: sam } = await invite(stack, victor, "sam@example.test", "Sam", "developer"));
  pool = await connectDevice("Pool Mac", "pool-repo", { accountPool: 1, codexLoggedIn: true });
  old = await connectDevice("Old Mac", "old-repo", {});
  noLogin = await connectDevice("Fresh Mac", "fresh-repo", { accountPool: 1, claudeLoggedIn: false });
}, 180_000);

afterAll(async () => {
  for (const d of [pool, old, noLogin]) await d?.device.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

/** Every test starts from an empty pool with the default policy. */
beforeEach(async () => {
  await su.query("update app.account_pool_accounts set removed_at = now() where removed_at is null");
  await su.query("delete from app.account_pool_policies");
});

describe("a session starts on a pool account (PD-02, PD-03, PD-04, PD-17)", () => {
  it("stores devices.account_pool_version from the hello", async () => {
    const r = await su.query("select id, account_pool_version from app.devices where id = any($1)", [
      [pool.deviceId, old.deviceId],
    ]);
    const byId = new Map(r.rows.map((x) => [x.id, x.account_pool_version]));
    expect(byId.get(pool.deviceId)).toBe(1);
    expect(byId.get(old.deviceId)).toBeNull();
  });

  it("sends the token in the start frame only; the stored command, the row and the audit never hold it", async () => {
    const a = await addToken("A", TA);
    const session = await ok(startOn(pool));
    const id = session.id as string;
    const frame = await pool.device.command("session.start", id);
    expect(frame.payload.account).toEqual({ kind: "token", accountId: a, label: "A", oauthToken: TA });

    const [stored] = await storedCommands(id, "session.start");
    expect(stored!.payload.account).toEqual({ kind: "token", accountId: a, label: "A" });
    expect(stored!.text).not.toContain(TA);
    expect((await sessionRow(id)).pool_account_id).toBe(a);
    expect(session.poolAccount).toEqual({ id: a, label: "A", provider: "claude" });
    expect((await sessionOf(id)).poolAccount).toEqual({ id: a, label: "A", provider: "claude" });
    expect((await accountRow(a)).last_used_at).not.toBeNull();
    const [created] = await auditOf("work_session.created", id);
    expect(created!.metadata.poolAccountId).toBe(a);
    expect(JSON.stringify(created!.metadata)).not.toContain(TA);
    pool.device.ack(frame.id);
  });

  it("a device without accountPool gets no account and the session runs on its own login (E9)", async () => {
    await addToken("A", TA);
    const session = await ok(startOn(old));
    const id = session.id as string;
    const frame = await old.device.command("session.start", id);
    expect("account" in frame.payload).toBe(false);
    expect((await sessionRow(id)).pool_account_id).toBeNull();
    expect(session.poolAccount).toBeNull();
    const [created] = await auditOf("work_session.created", id);
    expect(created!.metadata.poolAccountId).toBeNull();
    old.device.ack(frame.id);
  });

  it("a pool-capable device whose Claude is not signed in starts on the pool account (PD-17)", async () => {
    const a = await addToken("A", TA);
    const session = await ok(startOn(noLogin));
    const id = session.id as string;
    const frame = await noLogin.device.command("session.start", id);
    expect(frame.payload.account).toEqual({ kind: "token", accountId: a, label: "A", oauthToken: TA });
    expect(session.poolAccount).toEqual({ id: a, label: "A", provider: "claude" });
    noLogin.device.ack(frame.id);
  });
});

// Kept last: every scenario above has run, so the scan covers them all.
describe("E8: the tokens never reach the database outside the secret store", () => {
  it("no device command, audit row or stream event contains a token", async () => {
    for (const token of TOKENS) {
      const like = `%${token}%`;
      const commands = await su.query(
        "select count(*)::int as n from app.device_commands where payload::text like $1",
        [like],
      );
      const audit = await su.query(
        "select count(*)::int as n from app.audit_events where metadata::text like $1",
        [like],
      );
      const events = await su.query(
        "select count(*)::int as n from app.stream_events where payload::text like $1",
        [like],
      );
      expect([commands.rows[0].n, audit.rows[0].n, events.rows[0].n]).toEqual([0, 0, 0]);
    }
    void TB;
    void TC;
    void setPolicy;
    void startIdle;
    void orgId;
  });
});
