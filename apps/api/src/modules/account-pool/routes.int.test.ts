import { randomUUID } from "node:crypto";
import { ClaudeSetupToken } from "@ocw/contracts";
import { accountPoolAccounts } from "@ocw/db";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import {
  addClaudeToken,
  openPoolToken,
  type PoolAccountRow,
  type PoolChange,
  poolTokenAad,
  removePoolAccount,
  reorderPool,
  updatePoolAccount,
  updatePoolPolicy,
} from "./index";

/**
 * The account pool's admin routes (Phase 07.18-05; D-01, D-02, D-10, D-13; PD-19 … PD-22, PD-25) on a real PostgreSQL +
 * Redis and the full API: an admin adds a Claude setup-token, sees it in the pool and never the token again; every
 * write is audited `account_pool.*`; members get 403; another organization's admin sees and changes nothing.
 */

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Json | null };

/** Token-shaped values joined at runtime, so no credential-shaped literal sits whole in the repository. */
const setupToken = (fill: string) => ["sk", "ant", "oat01", fill.repeat(48)].join("-");
const T1 = setupToken("A");
const T2 = setupToken("B");
const T3 = setupToken("C");
const API_KEY = ["sk", "ant", "api03", "Z".repeat(48)].join("-");
const T4 = setupToken("D");
const T5 = setupToken("E");
const TOKENS = [T1, T2, T3, T4, T5];

let stack: TestStack;
let su: pg.Client;
let victor: TestClient; // admin of org A
let sam: TestClient; // member of org A
let eve: TestClient; // admin of org B
let orgA = "";
let orgB = "";
let victorId = "";

async function ok(res: Promise<Res>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}
async function fails(res: Promise<Res>, status: number, code?: string): Promise<Json> {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  if (code) expect((r.body?.error as Json | undefined)?.code, JSON.stringify(r.body)).toBe(code);
  return r.body as Json;
}

/** The raw answer (headers and text), for cache-control and token scans. */
async function raw(client: TestClient, method: string, path: string, body?: unknown) {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    method,
    headers: {
      origin: "http://localhost:3999",
      cookie: client.cookieHeader,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

async function joinAs(email: string, name: string) {
  const inv = await ok(victor.request("POST", "/api/v1/invitations", { email, role: "standard" }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

const auditRows = async (org: string, actions: string[]) =>
  (
    await su.query(
      "select action, resource_id, user_id, metadata from app.audit_events where organization_id = $1 and action = any($2) order by occurred_at, id",
      [org, actions],
    )
  ).rows as Json[];

const accountRow = async (id: string) =>
  (await su.query("select * from app.account_pool_accounts where id = $1", [id])).rows[0] as Json | undefined;

const addToken = (client: TestClient, label: string, token: string) =>
  client.request("POST", "/api/v1/account-pool/claude/accounts", { label, token });

/** A transaction of org A as the system (no user). */
const inOrgA = <T>(fn: Parameters<TestStack["built"]["core"]["db"]["withTenant"]>[1]) =>
  stack.built.core.db.withTenant({ organizationId: orgA, userId: null }, fn) as Promise<T>;

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
  orgA = setup.organization.id;
  victorId = setup.user.id;
  [sam] = await joinAs("sam@example.test", "Sam Lee");
  let eveId: string;
  [eve, eveId] = await joinAs("eve@example.test", "Eve Black");

  // Org B: Eve moves into her own organization as its admin.
  orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    orgB,
    `evil-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [eveId]);
  await su.query("delete from app.org_members where user_id = $1", [eveId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    eveId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, eveId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, eveId]);
  expect((await ok(eve.request("GET", "/api/v1/me/permissions"))).role).toBe("admin");
}, 240_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

let first = ""; // ana@acme, T1
let second = ""; // bo@acme, T2

describe("an admin adds a Claude setup-token (07.18-05 T1)", () => {
  it("answers the pool account without any token and seals the token to the account", async () => {
    const res = await raw(victor, "POST", "/api/v1/account-pool/claude/accounts", {
      label: "ana@acme",
      token: T1,
    });
    expect(res.status, res.text).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.text).not.toContain(T1);
    const acc = JSON.parse(res.text) as Json;
    expect(acc).toMatchObject({
      provider: "claude",
      kind: "token",
      label: "ana@acme",
      enabled: true,
      priority: 0,
      weight: 1,
      status: "ready",
      origin: "admin",
      device: null,
      cooldownUntil: null,
      usage: null,
    });
    for (const key of ["token", "secretId", "slotId", "cellProfileId", "email"])
      expect(acc).not.toHaveProperty(key);
    first = acc.id;

    const row = await accountRow(first);
    expect(row?.organization_id).toBe(orgA);
    const [secret] = (
      await su.query("select kind, provider, name from app.secrets where id = $1", [row?.secret_id])
    ).rows as Json[];
    expect(secret).toEqual({ kind: "pool_token", provider: "anthropic", name: `account_pool:${first}` });

    // Opens only with the account's own AAD; the organization-only AAD does not.
    const core = stack.built.core;
    expect(poolTokenAad(orgA, first)).toBe(`${orgA}:account_pool:${first}`);
    await expect(
      inOrgA((tx) => core.secrets.revealSealed(tx, row?.secret_id, `${orgA}:account_pool:${first}`)),
    ).resolves.toBe(T1);
    await expect(inOrgA((tx) => core.secrets.reveal(tx, row?.secret_id))).rejects.toThrow();
    await expect(
      inOrgA((tx) => core.secrets.revealSealed(tx, row?.secret_id, `${orgA}:account_pool:${randomUUID()}`)),
    ).rejects.toThrow();
  });

  it("openPoolToken opens a live token row and answers null for a removed or secret-less one", async () => {
    const core = stack.built.core;
    const [row] = await inOrgA<PoolAccountRow[]>((tx) =>
      tx.select().from(accountPoolAccounts).where(eq(accountPoolAccounts.id, first)),
    );
    if (!row) throw new Error("no row");
    await expect(inOrgA((tx) => openPoolToken(tx, core.secrets, row))).resolves.toBe(T1);
    await expect(
      inOrgA((tx) => openPoolToken(tx, core.secrets, { ...row, removedAt: new Date().toISOString() })),
    ).resolves.toBeNull();
    await expect(
      inOrgA((tx) => openPoolToken(tx, core.secrets, { ...row, secretId: null })),
    ).resolves.toBeNull();
    // A row pointed at another account's ciphertext does not open (the AAD binds the account id).
    await expect(
      inOrgA((tx) => openPoolToken(tx, core.secrets, { ...row, id: randomUUID() })),
    ).resolves.toBeNull();
  });

  it("lists it under claude with the default policies, chatgpt empty, no-store", async () => {
    const res = await raw(victor, "GET", "/api/v1/account-pool");
    expect(res.status, res.text).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.text).not.toContain(T1);
    const view = JSON.parse(res.text) as Json;
    expect(view.claude.policy).toEqual({
      provider: "claude",
      strategy: "failover",
      scope: "all",
      fallbackToDeviceLogin: true,
      updatedAt: null,
    });
    expect(view.claude.accounts.map((a: Json) => a.id)).toEqual([first]);
    expect(view.chatgpt).toEqual({
      policy: {
        provider: "chatgpt",
        strategy: "failover",
        scope: "all",
        fallbackToDeviceLogin: true,
        updatedAt: null,
      },
      accounts: [],
    });
  });

  it("audits account_pool.account_added without the token anywhere", async () => {
    const rows = await auditRows(orgA, ["account_pool.account_added"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resource_id: first,
      user_id: victorId,
      metadata: { provider: "claude", kind: "token", origin: "admin", label: "ana@acme" },
    });
    const all = (await su.query("select metadata::text as m from app.audit_events")).rows as Json[];
    for (const r of all) for (const t of TOKENS) expect(r.m).not.toContain(t);
  });

  it("gives a second token the next priority", async () => {
    const acc = await ok(addToken(victor, "bo@acme", T2));
    expect(acc.priority).toBe(1);
    second = acc.id;
  });

  it("refuses an Anthropic API key with api_key_not_allowed and the contract's sentence", async () => {
    const sentence = ClaudeSetupToken.safeParse(API_KEY).error?.issues.at(-1)?.message;
    expect(sentence).toBe("This is an API key. Add it in Settings › Models.");
    const body = await fails(addToken(victor, "key", API_KEY), 400, "api_key_not_allowed");
    expect(body.error.message).toBe(sentence);
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it("refuses a member (no provider.manage) with 403, even with an API key in the body", async () => {
    await fails(sam.request("GET", "/api/v1/account-pool"), 403);
    await fails(addToken(sam, "sam", T3), 403);
    await fails(addToken(sam, "sam", API_KEY), 403);
  });

  it("refuses a malformed token and an unknown key", async () => {
    await fails(addToken(victor, "short", "sk-ant-short"), 400);
    await fails(
      victor.request("POST", "/api/v1/account-pool/claude/accounts", { label: "x", token: T3, extra: 1 }),
      400,
    );
  });
});

describe("admins run the whole pool, only in their organization (07.18-05 T2)", () => {
  let deviceId = "";
  let slot = ""; // a ChatGPT device slot (seeded)
  let profile = ""; // a ChatGPT cell profile (seeded)
  let removed = "";

  const patch = (client: TestClient, id: string, body: Json) =>
    client.request("PATCH", `/api/v1/account-pool/accounts/${id}`, body);
  const order = (client: TestClient, provider: string, accountIds: string[]) =>
    client.request("PUT", `/api/v1/account-pool/${provider}/order`, { accountIds });
  const policy = (client: TestClient, provider: string, body: Json) =>
    client.request("PUT", `/api/v1/account-pool/${provider}/policy`, body);
  const remove = (client: TestClient, id: string) =>
    client.request("DELETE", `/api/v1/account-pool/accounts/${id}`);
  const claudeIds = async (client: TestClient) =>
    ((await ok(client.request("GET", "/api/v1/account-pool"))).claude.accounts as Json[]).map((a) => a.id);
  const insertReturningId = async (text: string, values: unknown[]) =>
    ((await su.query(text, values)).rows[0] as Json).id as string;

  beforeAll(async () => {
    deviceId = await insertReturningId(
      "insert into app.devices (organization_id, owner_user_id, name, platform, token_hash) values ($1, $2, 'Build box', 'linux', $3) returning id",
      [orgA, victorId, `hash-${randomUUID()}`],
    );
    slot = await insertReturningId(
      "insert into app.account_pool_accounts (organization_id, provider, kind, label, device_id, slot_id) values ($1, 'chatgpt', 'device_slot', 'ops@acme', $2, $3) returning id",
      [orgA, deviceId, randomUUID()],
    );
    profile = await insertReturningId(
      "insert into app.account_pool_accounts (organization_id, provider, kind, label, cell_profile_id, priority) values ($1, 'chatgpt', 'cell_profile', 'bots@acme', 'openai:pool-x', 1) returning id",
      [orgA],
    );
  });

  it("disables, re-enables, weights and renames an account, each audited with the changed keys", async () => {
    expect((await ok(patch(victor, first, { enabled: false }))).status).toBe("disabled");
    expect((await ok(patch(victor, first, { enabled: true }))).status).toBe("ready");
    expect((await ok(patch(victor, first, { weight: 7 }))).weight).toBe(7);
    expect((await accountRow(first))?.weight).toBe(7);
    expect((await ok(patch(victor, first, { label: "ana@acme.example" }))).label).toBe("ana@acme.example");
    expect((await accountRow(first))?.label).toBe("ana@acme.example");
    const rows = await auditRows(orgA, ["account_pool.account_updated"]);
    expect(rows.map((r) => r.metadata.changed)).toEqual([["enabled"], ["enabled"], ["weight"], ["label"]]);
    expect(rows[0]).toMatchObject({
      resource_id: first,
      user_id: victorId,
      metadata: { provider: "claude" },
    });
  });

  it("replaces a token in the same secret row and clears needs_sign_in, never echoing it", async () => {
    await su.query("update app.account_pool_accounts set credential_state = 'needs_sign_in' where id = $1", [
      first,
    ]);
    const before = await accountRow(first);
    const res = await raw(victor, "PATCH", `/api/v1/account-pool/accounts/${first}`, { token: T3 });
    expect(res.status, res.text).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.text).not.toContain(T3);
    expect((JSON.parse(res.text) as Json).status).toBe("ready");
    const after = await accountRow(first);
    expect(after?.secret_id).toBe(before?.secret_id);
    expect(after?.credential_state).toBe("ok");
    await expect(
      inOrgA((tx) => stack.built.core.secrets.revealSealed(tx, after?.secret_id, poolTokenAad(orgA, first))),
    ).resolves.toBe(T3);
    const [last] = (await auditRows(orgA, ["account_pool.account_updated"])).slice(-1);
    expect(last?.metadata).toMatchObject({ changed: ["token"], tokenReplaced: true });
    await fails(patch(victor, first, { token: API_KEY }), 400, "api_key_not_allowed");
  });

  it("answers wrong_kind for a token on a slot or a cell profile, and maps a slot with its device", async () => {
    await fails(patch(victor, slot, { token: T4 }), 409, "wrong_kind");
    await fails(patch(victor, profile, { token: T4 }), 409, "wrong_kind");
    const s = await ok(patch(victor, slot, { weight: 3 }));
    expect(s).toMatchObject({
      kind: "device_slot",
      weight: 3,
      device: { id: deviceId, name: "Build box", online: false },
    });
    for (const key of ["secretId", "slotId", "cellProfileId"]) expect(s).not.toHaveProperty(key);
  });

  it("reorders a provider's accounts and refuses a foreign, a removed or a missing id", async () => {
    const view = await ok(order(victor, "claude", [second, first]));
    expect((view.claude.accounts as Json[]).map((a) => [a.id, a.priority])).toEqual([
      [second, 0],
      [first, 1],
    ]);
    expect(await claudeIds(victor)).toEqual([second, first]);
    await fails(order(victor, "claude", [second, first, slot]), 400);
    await fails(order(victor, "claude", [second]), 400);
    await fails(order(victor, "claude", [second, first, randomUUID()]), 400);
    const rows = await auditRows(orgA, ["account_pool.reordered"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toEqual({ provider: "claude", accountIds: [second, first] });
  });

  it("sets the strategy (fill_first is stored as failover) and the fallback, audited before and after", async () => {
    const p1 = await ok(policy(victor, "claude", { strategy: "fill_first" }));
    expect(p1).toMatchObject({
      provider: "claude",
      strategy: "failover",
      scope: "all",
      fallbackToDeviceLogin: true,
    });
    expect(p1.updatedAt).not.toBeNull();
    const p2 = await ok(policy(victor, "claude", { strategy: "weighted", fallbackToDeviceLogin: false }));
    expect(p2).toMatchObject({ strategy: "weighted", fallbackToDeviceLogin: false });
    const view = await ok(victor.request("GET", "/api/v1/account-pool"));
    expect(view.claude.policy).toMatchObject({ strategy: "weighted", fallbackToDeviceLogin: false });
    expect(view.chatgpt.policy.updatedAt).toBeNull();
    const rows = await auditRows(orgA, ["account_pool.policy_changed"]);
    const defaults = { strategy: "failover", scope: "all", fallbackToDeviceLogin: true };
    expect(rows.map((r) => r.metadata)).toEqual([
      { provider: "claude", before: defaults, after: defaults },
      {
        provider: "claude",
        before: defaults,
        after: { strategy: "weighted", scope: "all", fallbackToDeviceLogin: false },
      },
    ]);
  });

  it("removes an account softly: removed_at, the secret gone, out of the list, a second delete 404", async () => {
    removed = (await ok(addToken(victor, "cy@acme", T4))).id;
    const secretId = (await accountRow(removed))?.secret_id;
    expect(await ok(remove(victor, removed))).toEqual({ ok: true });
    const row = await accountRow(removed);
    expect(row?.removed_at).not.toBeNull();
    expect(row?.secret_id).toBeNull();
    expect((await su.query("select 1 from app.secrets where id = $1", [secretId])).rowCount).toBe(0);
    expect(await claudeIds(victor)).not.toContain(removed);
    await fails(remove(victor, removed), 404, "account_not_found");
    await fails(patch(victor, removed, { enabled: false }), 404, "account_not_found");
    await fails(order(victor, "claude", [second, first, removed]), 400);
    const rows = await auditRows(orgA, ["account_pool.account_removed"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resource_id: removed,
      metadata: { provider: "claude", kind: "token", label: "cy@acme" },
    });
  });

  it("calls onChange once per successful write with the provider, the reason and the row", async () => {
    const changes: Array<{ provider: string; reason: string; account: string | null }> = [];
    const onChange = async (_tx: unknown, c: PoolChange) => {
      changes.push({ provider: c.provider, reason: c.reason, account: c.account?.id ?? null });
    };
    const core = stack.built.core;
    const ports = { audit: core.audit, secrets: core.secrets, onChange };
    const asVictor = <T>(fn: Parameters<typeof core.db.withTenant>[1]) =>
      core.db.withTenant({ organizationId: orgA, userId: victorId }, fn) as Promise<T>;
    const added = await asVictor<Json>((tx) => addClaudeToken(tx, ports, { label: "spy@acme", token: T5 }));
    await asVictor((tx) => updatePoolAccount(tx, ports, added.id, { weight: 2 }));
    await asVictor((tx) => reorderPool(tx, ports, "claude", [added.id, second, first]));
    await asVictor((tx) => updatePoolPolicy(tx, ports, "claude", { scope: "work_zone" }));
    await asVictor((tx) => removePoolAccount(tx, ports, added.id));
    // A refused write calls nothing.
    await expect(asVictor((tx) => removePoolAccount(tx, ports, added.id))).rejects.toThrow();
    expect(changes).toEqual([
      { provider: "claude", reason: "added", account: added.id },
      { provider: "claude", reason: "updated", account: added.id },
      { provider: "claude", reason: "reordered", account: null },
      { provider: "claude", reason: "policy", account: null },
      { provider: "claude", reason: "removed", account: added.id },
    ]);
  });

  it("refuses a member with 403 on every route", async () => {
    await fails(sam.request("GET", "/api/v1/account-pool"), 403);
    await fails(addToken(sam, "sam", T4), 403);
    await fails(patch(sam, first, { enabled: false }), 403);
    await fails(order(sam, "claude", [first, second]), 403);
    await fails(policy(sam, "claude", { strategy: "round_robin" }), 403);
    await fails(remove(sam, first), 403);
    expect((await accountRow(first))?.enabled).toBe(true);
  });

  it("shows another organization's admin none of A's accounts and lets them change nothing", async () => {
    const view = await ok(eve.request("GET", "/api/v1/account-pool"));
    expect(view.claude.accounts).toEqual([]);
    expect(view.chatgpt.accounts).toEqual([]);
    expect(view.claude.policy.strategy).toBe("failover");
    await fails(patch(eve, first, { enabled: false }), 404, "account_not_found");
    await fails(patch(eve, slot, { token: T4 }), 404, "account_not_found");
    await fails(remove(eve, first), 404, "account_not_found");
    await fails(order(eve, "claude", [second, first]), 400);
    const mine = await ok(addToken(eve, "eve@evil", T4));
    expect(mine.priority).toBe(0);
    expect(await claudeIds(victor)).not.toContain(mine.id);
    const a = await accountRow(first);
    expect(a?.enabled).toBe(true);
    expect(a?.removed_at).toBeNull();
    expect(await auditRows(orgB, ["account_pool.account_added"])).toHaveLength(1);
  });

  it("refuses the 21st Claude account with too_many_accounts", async () => {
    const live = (await claudeIds(victor)).length;
    for (let i = live; i < 20; i++) {
      await ok(addToken(victor, `n${i}@acme`, setupToken(String.fromCharCode(70 + i))));
    }
    expect(await claudeIds(victor)).toHaveLength(20);
    await fails(addToken(victor, "n20@acme", setupToken("z")), 409, "too_many_accounts");
    expect(await claudeIds(victor)).toHaveLength(20);
  });
});
