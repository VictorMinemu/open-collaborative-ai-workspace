import { randomUUID } from "node:crypto";
import { claudeTokenProfileId, poolProfileId } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCellPlugin } from "../../../../../e2e/support/fake-cell-plugin";
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

    await patchAccount(p, { enabled: false });
    let snap = await snapshot();
    expect(snap.subscriptions).toEqual([]);
    expect(snap.accountPool.chatgpt.order).toBeNull();

    await patchAccount(p, { enabled: true });
    expect((await snapshot()).subscriptions.map((s: Json) => s.id)).toEqual(["openai-codex"]);

    await ok(admin.request("DELETE", `/api/v1/account-pool/accounts/${p}`));
    snap = await snapshot();
    expect(snap.subscriptions).toEqual([]);
    expect(snap.accountPool.chatgpt).toEqual({ order: null, profiles: [] });
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
