import { randomUUID } from "node:crypto";
import { ClaudeSetupToken } from "@ocw/contracts";
import { accountPoolAccounts } from "@ocw/db";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { openPoolToken, type PoolAccountRow, poolTokenAad } from "./index";

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
const TOKENS = [T1, T2, T3];

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
    const second = await ok(addToken(victor, "bo@acme", T2));
    expect(second.priority).toBe(1);
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
