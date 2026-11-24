import { randomUUID } from "node:crypto";
import { claudeTokenProfileId, poolProfileId } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCellPlugin } from "../../../../../e2e/support/fake-cell-plugin";
import { sha256Hex } from "../../lib/crypto";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { applySubscriptionConnected } from "../agent";
import { type CellPoolView, cellAccountPool } from "./cell-pool";

/**
 * Bots draw from the account pool (Phase 07.18-14; D-02, D-04, D-12, D-15, PD-12, PD-13, PD-18, A-05) on a real
 * PostgreSQL + Redis and the full API: `GET /agent-channel/v1/cell` carries the pool (Claude tokens with their env
 * names and the strategy's order, the org key last; ChatGPT profiles with their order), and the config-read audit lists
 * account ids, never a token.
 */

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Json | null };

const CELL_TOKEN = "ocw-test-cell-token-account-pool-0123456789abcdef";
/** Token-shaped values joined at runtime, so no credential-shaped literal sits whole in the repository. */
const setupToken = (fill: string) => ["sk", "ant", "oat01", fill.repeat(48)].join("-");
const TA = setupToken("A");
const TB = setupToken("B");
const TC = setupToken("C");
const ORG_KEY = ["sk", "ant", "api03", "K".repeat(48)].join("-");
const SECRETS = [TA, TB, TC, ORG_KEY];

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let orgA = "";
let cell: FakeCellPlugin;

async function ok(res: Promise<Res>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const inOrgA = <T>(fn: Parameters<TestStack["built"]["core"]["db"]["withTenant"]>[1]) =>
  stack.built.core.db.withTenant({ organizationId: orgA, userId: null }, fn) as Promise<T>;

const snapshot = async (): Promise<Json> => {
  const res = await cell.request<Json>("GET", "/cell");
  if (res.status !== 200) throw new Error(`GET /cell → ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};

const addToken = async (label: string, token: string) =>
  (await ok(admin.request("POST", "/api/v1/account-pool/claude/accounts", { label, token }))).id as string;

const setPolicy = (provider: "claude" | "chatgpt", body: Json) =>
  ok(admin.request("PUT", `/api/v1/account-pool/${provider}/policy`, body));

const patchAccount = (id: string, body: Json) =>
  ok(admin.request("PATCH", `/api/v1/account-pool/accounts/${id}`, body));

/** A ChatGPT account for bots as the cell holds it (Task 1 builds the state directly; Task 2 signs it in). */
async function insertProfile(label: string, opts: { enabled?: boolean; priority?: number } = {}) {
  const id = randomUUID();
  await su.query(
    `insert into app.account_pool_accounts (id, organization_id, provider, kind, label, enabled, priority, cell_profile_id)
     values ($1, $2, 'chatgpt', 'cell_profile', $3, $4, $5, $6)`,
    [id, orgA, label, opts.enabled ?? true, opts.priority ?? 0, poolProfileId(id)],
  );
  return id;
}

/** Every pool row and policy of org A goes (secrets of removed tokens stay; nothing reads them). */
async function resetPool() {
  await su.query("delete from app.account_pool_accounts where organization_id = $1", [orgA]);
  await su.query("delete from app.account_pool_policies where organization_id = $1", [orgA]);
}

const configReads = async () =>
  (
    await su.query(
      "select metadata from app.audit_events where organization_id = $1 and action = 'agent_cell.config_read' order by occurred_at, id",
      [orgA],
    )
  ).rows.map((r: { metadata: Json }) => r.metadata);

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(
    admin.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgA = setup.organization.id;
  cell = new FakeCellPlugin({ apiUrl: stack.baseUrl, token: CELL_TOKEN });
}, 240_000);

afterAll(async () => {
  await cell?.stop();
  await su?.end();
  await stack?.stop();
});

describe("the cell receives the pool with its order (07.18-14 T1)", () => {
  beforeEach(resetPool);

  it("without pool rows the snapshot has no accountPool (the 07.17 snapshot) and the audit lists none", async () => {
    const snap = await snapshot();
    expect(snap).not.toHaveProperty("accountPool");
    expect((await configReads()).at(-1)).toMatchObject({ poolAccounts: [] });
  });

  it("failover: two Claude tokens with OCW_POOL_TOKEN_<n> in priority order, the org key last; ids only in the audit", async () => {
    await ok(
      admin.request("POST", "/api/v1/model-providers", {
        provider: "anthropic",
        apiKey: ORG_KEY,
        allowedModels: ["claude-sonnet-5-5"],
      }),
    );
    const a = await addToken("ana@acme", TA);
    const b = await addToken("bo@acme", TB);
    const snap = await snapshot();
    expect(snap.accountPool).toEqual({
      claude: {
        order: [claudeTokenProfileId(a), claudeTokenProfileId(b)],
        tokens: [
          { accountId: a, profileId: claudeTokenProfileId(a), envName: "OCW_POOL_TOKEN_1", token: TA },
          { accountId: b, profileId: claudeTokenProfileId(b), envName: "OCW_POOL_TOKEN_2", token: TB },
        ],
        apiKeyLast: true,
      },
      chatgpt: { order: null, profiles: [] },
    });
    const meta = (await configReads()).at(-1);
    expect(meta?.poolAccounts).toEqual([a, b]);
    const audits = (
      await su.query("select metadata::text as m from app.audit_events where organization_id = $1", [orgA])
    ).rows.map((r: { m: string }) => r.m);
    for (const m of audits) for (const s of SECRETS) expect(m).not.toContain(s);
    // The org key leaves the pool's audit and stays the provider's (deleted for the next cases).
    await ok(admin.request("DELETE", "/api/v1/model-providers/anthropic"));
  });

  it("round-robin: no order while every token is enabled; a disabled token leaves the tokens and the order", async () => {
    const a = await addToken("ana@acme", TA);
    const b = await addToken("bo@acme", TB);
    await setPolicy("claude", { strategy: "round_robin" });
    let pool = (await snapshot()).accountPool;
    expect(pool.claude.order).toBeNull();
    expect(pool.claude.tokens.map((t: Json) => t.accountId)).toEqual([a, b]);
    expect(pool.claude.apiKeyLast).toBe(false);

    await patchAccount(b, { enabled: false });
    pool = (await snapshot()).accountPool;
    expect(pool.claude.tokens.map((t: Json) => t.accountId)).toEqual([a]);
    expect(pool.claude.order).toEqual([claudeTokenProfileId(a)]);
  });

  it("a cooling token is still sent; a token that needs a new sign-in is left out; scope work_zone sends none", async () => {
    const a = await addToken("ana@acme", TA);
    const b = await addToken("bo@acme", TB);
    const c = await addToken("cy@acme", TC);
    await su.query(
      "update app.account_pool_accounts set cooldown_until = now() + interval '1 hour', limit_reason = 'five_hour' where id = $1",
      [a],
    );
    await su.query("update app.account_pool_accounts set credential_state = 'needs_sign_in' where id = $1", [
      b,
    ]);
    let pool = (await snapshot()).accountPool;
    expect(pool.claude.tokens.map((t: Json) => [t.accountId, t.envName])).toEqual([
      [a, "OCW_POOL_TOKEN_1"],
      [c, "OCW_POOL_TOKEN_2"],
    ]);
    expect(pool.claude.order).toEqual([claudeTokenProfileId(a), claudeTokenProfileId(c)]);

    await setPolicy("claude", { scope: "work_zone" });
    pool = (await snapshot()).accountPool;
    expect(pool.claude).toEqual({ order: null, tokens: [], apiKeyLast: false });
    expect((await configReads()).at(-1)?.poolAccounts).toEqual([]);
  });

  it("ChatGPT profiles: both listed with enabled, failover orders the enabled one; weighted reads as round-robin", async () => {
    const p = await insertProfile("bots@acme", { priority: 0 });
    const q = await insertProfile("ops@acme", { priority: 1, enabled: false });
    let pool = (await snapshot()).accountPool;
    expect(pool.chatgpt).toEqual({
      order: [poolProfileId(p)],
      profiles: [
        { accountId: p, profileId: poolProfileId(p), enabled: true },
        { accountId: q, profileId: poolProfileId(q), enabled: false },
      ],
    });
    expect(pool.claude).toEqual({ order: null, tokens: [], apiKeyLast: false });

    // Weighted is round-robin for bots (PD-13): an explicit order while one profile is disabled, else none.
    await setPolicy("chatgpt", { strategy: "weighted" });
    pool = (await snapshot()).accountPool;
    expect(pool.chatgpt.order).toEqual([poolProfileId(p)]);
    await patchAccount(q, { enabled: true });
    pool = (await snapshot()).accountPool;
    expect(pool.chatgpt.order).toBeNull();
    expect((await configReads()).at(-1)?.poolAccounts).toEqual([p, q]);
  });

  it("every ChatGPT pool account disabled or removed keeps bots off the subscription (an empty order cannot hold)", async () => {
    await inOrgA((tx) =>
      applySubscriptionConnected(
        stack.built.core,
        tx,
        "openai-codex",
        { email: "bots@acme", planType: "plus" },
        {
          flowId: null,
        },
      ),
    );
    // No pool rows: the pre-07.18 sign-in serves bots as before.
    expect((await snapshot()).subscriptions.map((s: Json) => s.id)).toEqual(["openai-codex"]);

    const p = await insertProfile("bots@acme");
    expect((await snapshot()).subscriptions.map((s: Json) => s.id)).toEqual(["openai-codex"]);

    expect((await snapshot()).accountPool.withheldByPool).toBeUndefined();

    await patchAccount(p, { enabled: false });
    let snap = await snapshot();
    expect(snap.subscriptions).toEqual([]);
    expect(snap.accountPool.chatgpt.order).toBeNull();
    // 07.18 gap: the cell is told the pool withholds it (keep the sign-ins), not that it was disconnected.
    expect(snap.accountPool.withheldByPool).toEqual(["openai-codex"]);

    await patchAccount(p, { enabled: true });
    snap = await snapshot();
    expect(snap.subscriptions.map((s: Json) => s.id)).toEqual(["openai-codex"]);
    expect(snap.accountPool.withheldByPool).toBeUndefined();

    await ok(admin.request("DELETE", `/api/v1/account-pool/accounts/${p}`));
    snap = await snapshot();
    expect(snap.subscriptions).toEqual([]);
    expect(snap.accountPool.chatgpt).toEqual({ order: null, profiles: [] });
    expect(snap.accountPool.withheldByPool).toEqual(["openai-codex"]);

    // A real disconnect: the provider is gone, so nothing is withheld (the cell signs out what it holds).
    await ok(admin.request("DELETE", "/api/v1/model-providers/openai-codex"));
    snap = await snapshot();
    expect(snap.subscriptions).toEqual([]);
    expect(snap.accountPool.withheldByPool).toBeUndefined();
  });

  it("with CELL_CLAUDE_TOKENS false (A-05 failed) the cell gets no Claude tokens", async () => {
    await addToken("ana@acme", TA);
    const pool = await inOrgA<CellPoolView>((tx) =>
      cellAccountPool(tx, stack.built.core, { anthropicKey: true, claudeTokens: false }),
    );
    expect(pool.accountPool?.claude).toEqual({ order: null, tokens: [], apiKeyLast: true });
    expect(pool.accountIds).toEqual([]);
  });
});

// ---------------------------------------------------------------- Task 2: sign-in per pool account, adoption

const CODEX = "/api/v1/model-providers/openai-codex/auth";

/** The payload of the latest `provider.auth.start` on org A's cell stream. */
const lastStart = async (): Promise<Json> =>
  (
    await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'provider.auth.start' order by seq desc limit 1",
      [`cell:${orgA}`],
    )
  ).rows[0]?.payload as Json;

const poolRows = async (org = orgA): Promise<Json[]> =>
  (
    await su.query(
      "select * from app.account_pool_accounts where organization_id = $1 and kind = 'cell_profile' order by priority, created_at, id",
      [org],
    )
  ).rows as Json[];

const poolAudits = async () =>
  (
    await su.query(
      "select action, resource_id, user_id, metadata from app.audit_events where organization_id = $1 and action like 'account_pool.%' order by occurred_at, id",
      [orgA],
    )
  ).rows as Json[];

const codexProvider = async (): Promise<Json | undefined> =>
  (await ok(admin.request("GET", "/api/v1/model-providers"))).providers.find(
    (p: Json) => p.provider === "openai-codex",
  );

/** A connected report from the cell for the flow the admin just started. */
const connected = (flowId: string, body: Json) =>
  cell.reportAuth({ provider: "openai-codex", flowId, state: "connected", ...body });

describe("each ChatGPT account for bots signs in as its own profile; the old sign-in is adopted (07.18-14 T2)", () => {
  let auditsBefore = 0;
  beforeAll(async () => {
    await resetPool();
    auditsBefore = (await poolAudits()).length;
    await cell.start();
  });

  it("“ChatGPT for bots” asks the cell for openai:pool-<id>; connected adds an enabled admin row, audited", async () => {
    const started = await ok(admin.request("POST", CODEX, { poolAccount: { label: "bots@acme" } }));
    const ev = await lastStart();
    expect(ev.flowId).toBe(started.flowId);
    const accountId = String(ev.profileId).replace(/^openai:pool-/, "");
    expect(accountId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ev.profileId).toBe(poolProfileId(accountId));
    // Nothing is in the pool until the cell holds the sign-in.
    expect(await poolRows()).toEqual([]);

    const body = { account: { email: "bots@acme.test", planType: "Plus" }, profileId: ev.profileId };
    const res = await connected(started.flowId, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = await poolRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: accountId,
      provider: "chatgpt",
      kind: "cell_profile",
      label: "bots@acme",
      origin: "admin",
      enabled: true,
      credential_state: "ok",
      plan_type: "plus",
      cell_profile_id: ev.profileId,
      removed_at: null,
    });
    const audits = (await poolAudits()).slice(auditsBefore);
    expect(audits.map((a) => a.action)).toEqual([
      "account_pool.sign_in_started",
      "account_pool.account_added",
      "account_pool.signed_in",
    ]);
    expect(audits.every((a) => a.resource_id === accountId)).toBe(true);
    expect(await codexProvider()).toMatchObject({
      account: { email: "bots@acme.test", planType: "plus", needsReconnect: false },
    });
    expect((await snapshot()).accountPool.chatgpt).toEqual({
      order: [ev.profileId],
      profiles: [{ accountId, profileId: ev.profileId, enabled: true }],
    });

    // The same report again writes nothing more.
    expect((await connected(started.flowId, body)).status).toBe(200);
    expect(await poolRows()).toHaveLength(1);
    expect(await poolAudits()).toHaveLength(auditsBefore + 3);
  });

  it("a second sign-in while one runs is refused unless restarted; the same request is idempotent", async () => {
    const first = await ok(admin.request("POST", CODEX, { poolAccount: { label: "ops@acme" } }));
    const again = await ok(admin.request("POST", CODEX, { poolAccount: { label: "ops@acme" } }));
    expect(again.flowId).toBe(first.flowId);
    const other = await admin.request("POST", CODEX, { poolAccount: { label: "sales@acme" } });
    expect(other.status).toBe(409);
    expect((other.body as Json).error.code).toBe("sign_in_in_progress");
    expect((await admin.request("POST", CODEX, {})).status).toBe(409);
    await ok(admin.request("DELETE", CODEX));
  });

  it("A-03 fallback: a connected report with another profile id stores the id the cell reports", async () => {
    const started = await ok(admin.request("POST", CODEX, { poolAccount: { label: "ops@acme" } }));
    const accountId = String((await lastStart()).profileId).replace(/^openai:pool-/, "");
    const res = await connected(started.flowId, {
      account: { email: "ops@acme.test", planType: "pro" },
      profileId: "openai:ops-chosen",
    });
    expect(res.status).toBe(200);
    expect((await poolRows()).find((r) => r.id === accountId)).toMatchObject({
      label: "ops@acme",
      origin: "admin",
      cell_profile_id: "openai:ops-chosen",
    });
  });

  it("the Models page card works as before; its connected report lands in the pool (adopted when new)", async () => {
    let started = await ok(admin.request("POST", CODEX, {}));
    expect((await lastStart()).profileId).toBeUndefined();
    const res = await connected(started.flowId, {
      account: { email: "legacy@acme.test", planType: "plus" },
      profileId: "openai:default",
    });
    expect(res.status).toBe(200);
    expect((await poolRows()).find((r) => r.cell_profile_id === "openai:default")).toMatchObject({
      label: "legacy@acme.test",
      origin: "adopted",
      enabled: true,
    });

    // An older plugin's report without a profile id: today's behaviour, no row (the cell's profile list adopts it).
    const before = (await poolRows()).length;
    started = await ok(admin.request("POST", CODEX, {}));
    const legacy = await connected(started.flowId, {
      account: { email: "legacy@acme.test", planType: "plus" },
    });
    expect(legacy.status).toBe(200);
    expect((await ok(admin.request("GET", CODEX))).state).toBe("connected");
    expect(await poolRows()).toHaveLength(before);
  });
});

describe("the cell's profile list keeps the pool in step (07.18-14 T2)", () => {
  beforeAll(resetPool);

  const stateReport = (state: "connected" | "disconnected", profiles: Json[]) =>
    cell.reportAuth({
      provider: "openai-codex",
      flowId: null,
      state,
      ...(state === "connected" ? { account: { email: "ana@acme", planType: "plus" } } : {}),
      profiles,
    });
  const P1 = { profileId: "openai:p1", email: "ana@acme", planType: "Plus", usable: true };
  const P2 = { profileId: "openai:p2", email: null, planType: null, usable: true };
  const P3 = { profileId: "openai:p3", email: "cy@acme", planType: "plus", usable: true };
  const live = async () => (await poolRows()).filter((r) => r.removed_at === null);

  it("the pre-07.18 sign-in becomes the first ChatGPT pool account; the same report twice writes nothing more", async () => {
    expect((await stateReport("connected", [P1, P2])).status).toBe(200);
    expect(
      (await poolRows()).map((r) => [
        r.cell_profile_id,
        r.label,
        r.origin,
        r.enabled,
        r.priority,
        r.plan_type,
      ]),
    ).toEqual([
      ["openai:p1", "ana@acme", "adopted", true, 0, "plus"],
      ["openai:p2", "ChatGPT account", "adopted", true, 1, null],
    ]);
    const audits = (await poolAudits()).length;
    expect((await stateReport("connected", [P1, P2])).status).toBe(200);
    expect(await poolRows()).toHaveLength(2);
    expect(await poolAudits()).toHaveLength(audits);
    // The adopted accounts reach the cell (failover: both, in order).
    expect((await snapshot()).accountPool.chatgpt.order).toEqual(["openai:p1", "openai:p2"]);
  });

  it("a profile the cell no longer holds leaves the pool; an unusable one needs a sign-in", async () => {
    expect((await stateReport("connected", [P1])).status).toBe(200);
    const p2 = (await poolRows()).find((r) => r.cell_profile_id === "openai:p2");
    expect(p2?.removed_at).not.toBeNull();
    expect((await poolAudits()).at(-1)).toMatchObject({
      action: "account_pool.account_removed",
      resource_id: p2?.id,
    });

    // One usable profile left keeps the provider connected.
    expect((await stateReport("disconnected", [{ ...P1, usable: false }, P3])).status).toBe(200);
    expect((await live()).map((r) => [r.cell_profile_id, r.credential_state])).toEqual([
      ["openai:p1", "needs_sign_in"],
      ["openai:p3", "ok"],
    ]);
    expect((await codexProvider())?.account.needsReconnect).toBe(false);

    // None usable: the provider needs a reconnect (bots keep their model).
    const none = [
      { ...P1, usable: false },
      { ...P3, usable: false },
    ];
    expect((await stateReport("disconnected", none)).status).toBe(200);
    expect((await codexProvider())?.account.needsReconnect).toBe(true);
    expect((await live()).map((r) => r.credential_state)).toEqual(["needs_sign_in", "needs_sign_in"]);

    // Usable again: the credential is ok again.
    expect((await stateReport("connected", [P1, P3])).status).toBe(200);
    expect((await live()).map((r) => r.credential_state)).toEqual(["ok", "ok"]);
  });

  it("another organization's cell report creates rows only in that organization", async () => {
    const orgB = randomUUID();
    const tokenB = `ocw_cell_${randomUUID()}${randomUUID()}`;
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Org B', $2)", [
      orgB,
      `b-${orgB}`,
    ]);
    await su.query(
      "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
      [orgB, sha256Hex(tokenB)],
    );
    await stack.built.core.db.withTenant({ organizationId: orgB, userId: null }, (tx) =>
      applySubscriptionConnected(
        stack.built.core,
        tx,
        "openai-codex",
        { email: "b@b.test", planType: "plus" },
        { flowId: null },
      ),
    );
    const before = await poolRows();
    const cellB = new FakeCellPlugin({ apiUrl: stack.baseUrl, token: tokenB });
    const res = await cellB.reportAuth({
      provider: "openai-codex",
      flowId: null,
      state: "connected",
      account: { email: "b@b.test", planType: "plus" },
      profiles: [{ profileId: "openai:p1", email: "b@b.test", planType: "plus", usable: true }],
    });
    expect(res.status).toBe(200);
    expect((await poolRows(orgB)).map((r) => [r.organization_id, r.cell_profile_id])).toEqual([
      [orgB, "openai:p1"],
    ]);
    expect(await poolRows()).toEqual(before);
  });
});

// ---------------------------------------------------------------- Task 3: pool changes reach the cell

/** The cell stream's events of these types, oldest first. */
const cellEvents = async (type: string): Promise<Json[]> =>
  (
    await su.query("select payload from app.stream_events where stream_id = $1 and type = $2 order by seq", [
      `cell:${orgA}`,
      type,
    ])
  ).rows.map((r: { payload: Json }) => r.payload);

/** How many `cell.config.changed` events `fn` appends to org A's cell stream. */
async function configChanges(fn: () => Promise<unknown>): Promise<number> {
  const before = (await cellEvents("cell.config.changed")).length;
  await fn();
  return (await cellEvents("cell.config.changed")).length - before;
}

describe("pool changes reach the cell (07.18-14 T3)", () => {
  beforeEach(resetPool);

  it("every Claude token change and either policy tells the cell once; with scope work_zone a token change does not", async () => {
    let a = "";
    let b = "";
    expect(
      await configChanges(async () => {
        a = await addToken("ana@acme", TA);
      }),
    ).toBe(1);
    expect(
      await configChanges(async () => {
        b = await addToken("bo@acme", TB);
      }),
    ).toBe(1);
    expect(await configChanges(() => patchAccount(b, { enabled: false }))).toBe(1);
    expect(await configChanges(() => patchAccount(b, { enabled: true }))).toBe(1);
    expect(
      await configChanges(() =>
        ok(admin.request("PUT", "/api/v1/account-pool/claude/order", { accountIds: [b, a] })),
      ),
    ).toBe(1);
    expect((await snapshot()).accountPool.claude.order).toEqual([
      claudeTokenProfileId(b),
      claudeTokenProfileId(a),
    ]);
    expect(await configChanges(() => setPolicy("claude", { strategy: "round_robin" }))).toBe(1);
    expect(await configChanges(() => setPolicy("chatgpt", { strategy: "round_robin" }))).toBe(1);
    expect(await configChanges(() => ok(admin.request("DELETE", `/api/v1/account-pool/accounts/${a}`)))).toBe(
      1,
    );

    // Work Zone only: the cell never had these tokens, so their changes do not concern it.
    expect(await configChanges(() => setPolicy("claude", { scope: "work_zone" }))).toBe(1);
    let c = "";
    expect(
      await configChanges(async () => {
        c = await addToken("cy@acme", TC);
      }),
    ).toBe(0);
    expect(await configChanges(() => patchAccount(c, { label: "cy@acme.test" }))).toBe(0);
    expect(
      await configChanges(() =>
        ok(admin.request("PUT", "/api/v1/account-pool/claude/order", { accountIds: [c, b] })),
      ),
    ).toBe(0);
    expect(await configChanges(() => ok(admin.request("DELETE", `/api/v1/account-pool/accounts/${c}`)))).toBe(
      0,
    );
  });

  it("a ChatGPT device slot change does not concern the cell", async () => {
    const owner = (
      await su.query("select user_id from app.org_members where organization_id = $1 limit 1", [orgA])
    ).rows[0].user_id as string;
    const deviceId = randomUUID();
    await su.query(
      "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash) values ($1, $2, $3, 'mac', 'darwin', $4)",
      [deviceId, orgA, owner, `hash-${deviceId}`],
    );
    const slot = (
      await su.query(
        "insert into app.account_pool_accounts (organization_id, provider, kind, label, device_id, slot_id) values ($1, 'chatgpt', 'device_slot', 'ops@acme', $2, $3) returning id",
        [orgA, deviceId, randomUUID()],
      )
    ).rows[0].id as string;
    expect(await configChanges(() => patchAccount(slot, { enabled: false }))).toBe(0);
    expect(await configChanges(() => patchAccount(slot, { label: "ops@acme.test" }))).toBe(0);
    expect(
      await configChanges(() =>
        ok(admin.request("PUT", "/api/v1/account-pool/chatgpt/order", { accountIds: [slot] })),
      ),
    ).toBe(0);
    expect(
      await configChanges(() => ok(admin.request("DELETE", `/api/v1/account-pool/accounts/${slot}`))),
    ).toBe(0);
  });

  it("disabling a bot account leaves it out of the order; removing one signs only that profile out", async () => {
    const p = await insertProfile("bots@acme", { priority: 0 });
    const q = await insertProfile("ops@acme", { priority: 1 });
    expect((await snapshot()).accountPool.chatgpt.order).toEqual([poolProfileId(p), poolProfileId(q)]);

    expect(await configChanges(() => patchAccount(p, { enabled: false }))).toBe(1);
    expect((await snapshot()).accountPool.chatgpt.order).toEqual([poolProfileId(q)]);
    expect(await configChanges(() => patchAccount(p, { enabled: true }))).toBe(1);
    expect(
      await configChanges(() =>
        ok(admin.request("PUT", "/api/v1/account-pool/chatgpt/order", { accountIds: [q, p] })),
      ),
    ).toBe(1);

    const revokes = (await cellEvents("provider.auth.revoke")).length;
    expect(await configChanges(() => ok(admin.request("DELETE", `/api/v1/account-pool/accounts/${q}`)))).toBe(
      1,
    );
    const revoked = (await cellEvents("provider.auth.revoke")).slice(revokes);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({ provider: "openai-codex", profileIds: [poolProfileId(q)] });
    // The other profile stays in the pool and in the cell's order.
    const snap = await snapshot();
    expect(snap.accountPool.chatgpt.profiles.map((x: Json) => x.accountId)).toEqual([p]);
    expect(snap.accountPool.chatgpt.order).toEqual([poolProfileId(p)]);
    expect(snap.subscriptions.map((s: Json) => s.id)).toEqual(["openai-codex"]);
  });
});

// ---------------------------------------------------------------- 07.18 gap: a disconnect clears the bot accounts

describe("a disconnect on Settings › Models removes the provider's ChatGPT bot accounts (07.18 gap)", () => {
  beforeEach(resetPool);

  const connectCodex = (org: string) =>
    stack.built.core.db.withTenant({ organizationId: org, userId: null }, (tx) =>
      applySubscriptionConnected(
        stack.built.core,
        tx,
        "openai-codex",
        { email: "bots@acme", planType: "plus" },
        { flowId: null },
      ),
    );

  it("live cell_profile rows get removed_at and one audited account_removed each; nothing else moves; org B untouched", async () => {
    await connectCodex(orgA);
    const p = await insertProfile("bots@acme", { priority: 0 });
    const q = await insertProfile("ops@acme", { enabled: false, priority: 1 });
    // Already removed earlier: keeps its removal, no second audit.
    const gone = await insertProfile("old@acme", { priority: 2 });
    const goneAt = "2026-01-02T03:04:05.000Z";
    await su.query("update app.account_pool_accounts set removed_at = $2 where id = $1", [gone, goneAt]);
    // Neither the Claude pool nor a Work Zone device's ChatGPT slot belongs to the cell's sign-in.
    const token = await addToken("ana@acme", TA);
    const owner = (
      await su.query("select user_id from app.org_members where organization_id = $1 limit 1", [orgA])
    ).rows[0].user_id as string;
    const deviceId = randomUUID();
    await su.query(
      "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash) values ($1, $2, $3, 'mac', 'darwin', $4)",
      [deviceId, orgA, owner, `hash-${deviceId}`],
    );
    const slot = (
      await su.query(
        "insert into app.account_pool_accounts (organization_id, provider, kind, label, device_id, slot_id) values ($1, 'chatgpt', 'device_slot', 'dev@acme', $2, $3) returning id",
        [orgA, deviceId, randomUUID()],
      )
    ).rows[0].id as string;

    // Another organization with its own ChatGPT bot account.
    const orgB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Org B', $2)", [
      orgB,
      `b-${orgB}`,
    ]);
    await connectCodex(orgB);
    const otherId = randomUUID();
    await su.query(
      `insert into app.account_pool_accounts (id, organization_id, provider, kind, label, cell_profile_id)
       values ($1, $2, 'chatgpt', 'cell_profile', 'b@b.test', $3)`,
      [otherId, orgB, poolProfileId(otherId)],
    );

    const auditsBefore = (await poolAudits()).length;
    await ok(admin.request("DELETE", "/api/v1/model-providers/openai-codex"));

    const orgRows = await su.query(
      "select id, removed_at from app.account_pool_accounts where organization_id = $1",
      [orgA],
    );
    const removedAt = new Map(orgRows.rows.map((r: Json) => [r.id as string, r.removed_at]));
    expect(removedAt.get(p)).not.toBeNull();
    expect(removedAt.get(q)).not.toBeNull();
    expect(new Date(removedAt.get(gone)).toISOString()).toBe(goneAt);
    expect(removedAt.get(token)).toBeNull();
    expect(removedAt.get(slot)).toBeNull();

    const removed = (await poolAudits()).slice(auditsBefore);
    expect(removed.map((r) => `${r.action} ${r.resource_id}`).sort()).toEqual(
      [`account_pool.account_removed ${p}`, `account_pool.account_removed ${q}`].sort(),
    );
    for (const r of removed) {
      expect(r.metadata).toEqual({
        provider: "chatgpt",
        kind: "cell_profile",
        origin: "admin",
        label: r.resource_id === p ? "bots@acme" : "ops@acme",
        reason: "provider_disconnected",
      });
      expect(JSON.stringify(r.metadata)).not.toMatch(/sk-|token/u);
    }

    // Settings › Account pool no longer lists them; the cell gets an empty ChatGPT pool and nothing withheld.
    const view = await ok(admin.request("GET", "/api/v1/account-pool"));
    expect(view.chatgpt.accounts.map((a: Json) => a.id)).toEqual([slot]);
    const snap = await snapshot();
    expect(snap.accountPool.chatgpt).toEqual({ order: null, profiles: [] });
    expect(snap.accountPool.withheldByPool).toBeUndefined();

    // Tenant isolation: org B's bot account stays live and unaudited.
    const other = (
      await su.query("select removed_at from app.account_pool_accounts where id = $1", [otherId])
    ).rows[0];
    expect(other.removed_at).toBeNull();
    const otherAudits = await su.query(
      "select 1 from app.audit_events where organization_id = $1 and action = 'account_pool.account_removed'",
      [orgB],
    );
    expect(otherAudits.rowCount).toBe(0);
  });

  it("a provider that is not connected is a 404 and removes nothing", async () => {
    await su.query(
      "delete from app.model_providers where organization_id = $1 and provider = 'openai-codex'",
      [orgA],
    );
    const p = await insertProfile("bots@acme");
    const res = await admin.request("DELETE", "/api/v1/model-providers/openai-codex");
    expect(res.status).toBe(404);
    const row = (await su.query("select removed_at from app.account_pool_accounts where id = $1", [p]))
      .rows[0];
    expect(row.removed_at).toBeNull();
  });
});

// ---------------------------------------------------------------- 07.18-19 R2.1: Claude bots without an API key

describe("Claude bots run on the pool's tokens with no Anthropic API key (07.18-19 R2.1, D-15)", () => {
  beforeEach(async () => {
    await resetPool();
    await su.query("delete from app.model_providers where organization_id = $1 and provider = 'anthropic'", [
      orgA,
    ]);
  });

  const anthropicOf = (snap: Json): Json[] => snap.providers.filter((p: Json) => p.kind === "anthropic");
  const claudeModels = async (): Promise<Json[]> =>
    (await ok(admin.request("GET", "/api/v1/models"))).models.filter((m: Json) => m.provider === "anthropic");
  const createClaudeBot = (modelId: string) =>
    admin.request("POST", "/api/v1/agents", {
      name: `Claude ${modelId}`,
      instructions: "Helpful.",
      modelProvider: "anthropic",
      modelId,
    });

  it("a token for bots renders a keyless anthropic provider, lists Claude models and lets a bot use one", async () => {
    // Nothing for Claude yet: no provider, no model.
    expect(anthropicOf(await snapshot())).toEqual([]);
    expect(await claudeModels()).toEqual([]);
    expect((await createClaudeBot("claude-sonnet-5-5")).status).toBe(400);

    const a = await addToken("ana@acme", TA);
    const snap = await snapshot();
    expect(anthropicOf(snap)).toEqual([
      expect.objectContaining({
        id: "anthropic",
        kind: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        apiKey: null,
        models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"],
      }),
    ]);
    // No key: nothing to put last, and the audit lists the provider id only.
    expect(snap.accountPool.claude).toMatchObject({ order: [claudeTokenProfileId(a)], apiKeyLast: false });
    expect((await configReads()).at(-1)?.providers).toContain("anthropic");

    const models = await claudeModels();
    expect(models.map((m) => m.modelId)).toEqual([
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-haiku-4-5",
    ]);
    // Subscriptions first: the recommended default is Claude, and it is the only default.
    expect(models.find((m) => m.modelId === "claude-sonnet-5-5")?.isDefault).toBe(true);
    const all = (await ok(admin.request("GET", "/api/v1/models"))).models as Json[];
    expect(all.filter((m) => m.isDefault)).toHaveLength(1);

    const bot = await ok(createClaudeBot("claude-sonnet-5-5"));
    const cellBot = (await snapshot()).agents.find((x: Json) => x.id === bot.id);
    expect(cellBot?.modelRef).toBe("anthropic/claude-sonnet-5-5");
    await ok(admin.request("DELETE", `/api/v1/agents/${bot.id}`));

    // AI chats never draw from the pool (ADR-0017): no organization Claude model appears there.
    const aiModels = (await ok(admin.request("GET", "/api/v1/ai-chat/models"))).models as Json[];
    expect(aiModels.some((m) => m.ref?.backend === "org_key" && m.ref?.provider === "anthropic")).toBe(false);
  });

  it("no Claude for bots when no token serves them: scope work_zone, needs a new sign-in, or disabled", async () => {
    const a = await addToken("ana@acme", TA);
    await setPolicy("claude", { scope: "work_zone" });
    expect(anthropicOf(await snapshot())).toEqual([]);
    expect(await claudeModels()).toEqual([]);

    await setPolicy("claude", { scope: "all" });
    await su.query("update app.account_pool_accounts set credential_state = 'needs_sign_in' where id = $1", [
      a,
    ]);
    expect(anthropicOf(await snapshot())).toEqual([]);
    expect(await claudeModels()).toEqual([]);

    await su.query("update app.account_pool_accounts set credential_state = 'ok' where id = $1", [a]);
    await patchAccount(a, { enabled: false });
    expect(anthropicOf(await snapshot())).toEqual([]);
    expect(await claudeModels()).toEqual([]);
  });

  it("an organization key keeps its own provider entry (one only) and stays last; the admin's models win", async () => {
    await ok(
      admin.request("POST", "/api/v1/model-providers", {
        provider: "anthropic",
        apiKey: ORG_KEY,
        allowedModels: ["claude-haiku-4-5"],
      }),
    );
    await addToken("ana@acme", TA);
    const snap = await snapshot();
    expect(anthropicOf(snap)).toHaveLength(1);
    expect(anthropicOf(snap)[0]).toMatchObject({ apiKey: ORG_KEY, models: ["claude-haiku-4-5"] });
    expect(snap.accountPool.claude.apiKeyLast).toBe(true);
    expect((await claudeModels()).map((m) => m.modelId)).toEqual(["claude-haiku-4-5"]);

    // The key switched off on Settings › Models: the tokens still serve bots, with the admin's model list.
    await ok(
      admin.request("POST", "/api/v1/model-providers", {
        provider: "anthropic",
        enabled: false,
        allowedModels: ["claude-haiku-4-5"],
      }),
    );
    const off = await snapshot();
    expect(anthropicOf(off)).toEqual([
      expect.objectContaining({ apiKey: null, models: ["claude-haiku-4-5"] }),
    ]);
    expect(off.accountPool.claude.apiKeyLast).toBe(false);
    expect((await claudeModels()).map((m) => m.modelId)).toEqual(["claude-haiku-4-5"]);
  });
});
