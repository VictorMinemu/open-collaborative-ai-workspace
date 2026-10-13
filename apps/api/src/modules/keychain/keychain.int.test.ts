import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeMcpOAuth } from "../../../../../infra/fake-model/fake-mcp-oauth.mjs";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { createPermissionService } from "../organization";
import { effectiveVaultItems, findVaultItemByHandle, KeychainError, prepareInjection } from "./index";

/**
 * Keychain (Phase 07.4-07; D-04, D-06, D-07 items 1-3; CONN-05) on a real PostgreSQL + Redis and the full API. Keys are
 * written once and sealed to their item; GET never returns a value; bots use them only through `effectiveVaultItems`
 * (grant ∩ owner ∩ unit audience ∩ `vault.use` for the agent acting for the human); `prepareInjection` builds the header
 * server-side. The /kc targets of the fake OAuth server (07.4-04) run in-process on loopback, reached through the
 * egress guard as the test host `fake-kc`.
 */

const CELL_TOKEN = "ocw-test-cell-token-keychain-0123456789abcdefgh";
const CANARY = "KC-VALUE-CANARY";
const CANARY_2 = "KC-SECOND-CANARY";
const CANARY_NEW = "KC-REPLACED-CANARY";
const SAM_CANARY = "KC-SAM-CANARY";
const UNIT_CANARY = "KC-UNIT-CANARY";
const PASSWORD = "kcpass";
const ALL_CANARIES = [CANARY, CANARY_2, CANARY_NEW, SAM_CANARY, UNIT_CANARY, "kc-secret", "fake-kc-token"];

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Json | null };

let stack: TestStack;
let su: pg.Client;
let appRole: pg.Client;
let fake: Server;
let oauth: ReturnType<typeof createFakeMcpOAuth>;
let fakePort = 0;
let tokenRequests = 0;
let kcHost = "";

let victor: TestClient; // admin
let sam: TestClient; // standard
let riley: TestClient; // lead of Backend
let eve: TestClient; // admin of org B
let orgA = "";
let orgB = "";
let victorId = "";
let samId = "";
let alexId = "";
let joId = "";
let victorBot = "";
let samBot = "";
let backendBot = "";
let orgBot = "";
let backend = "";
let frontend = "";

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

async function joinAs(email: string, name: string, role: "standard" | "lead") {
  const inv = await ok(victor.request("POST", "/api/v1/invitations", { email, role }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

const unit = async (kind: string, name: string, parentId: string | null) =>
  (await ok(victor.request("POST", "/api/v1/units", { kind, name, parentId }))).id as string;

const perms = () => createPermissionService(stack.built.core);

/** A transaction of org A with `userId` as the session's user (the turn's human for agent paths). */
const asUser = <T>(
  userId: string | null,
  fn: Parameters<TestStack["built"]["core"]["db"]["withTenant"]>[1],
) => stack.built.core.db.withTenant({ organizationId: orgA, userId }, fn) as Promise<T>;

const effective = (agentId: string, humanUserId: string) =>
  asUser<Array<{ handle: string }>>(humanUserId, (tx) =>
    effectiveVaultItems(tx, perms(), { agentId, humanUserId }),
  ).then((items) => items.map((i) => i.handle));

async function injectionFor(handle: string, userId: string | null) {
  return asUser<{ headerName: string; headerValue: string; secretParts: string[] }>(userId, async (tx) => {
    const item = await findVaultItemByHandle(tx, handle);
    if (!item) throw new Error(`no item ${handle}`);
    return prepareInjection(stack.built.core, tx, item);
  });
}

const personalKey = (extra: Json = {}) => ({
  scope: "personal",
  kind: "api_key",
  name: "CRM",
  value: CANARY,
  allowedHosts: ["api.crm.example"],
  ...extra,
});

const auditRows = async (actions: string[]) =>
  (
    await su.query(
      "select action, resource_id, user_id, agent_id, result, metadata from app.audit_events where organization_id = $1 and action = any($2) order by occurred_at",
      [orgA, actions],
    )
  ).rows as Json[];

beforeAll(async () => {
  oauth = createFakeMcpOAuth();
  fake = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake-kc");
    if (req.method === "POST" && url.pathname === "/kc/token") tokenRequests += 1;
    if (!oauth.handle(req, res, url)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  fakePort = (fake.address() as AddressInfo).port;
  kcHost = `fake-kc:${fakePort}`;

  stack = await startTestStack({
    env: {
      OCW_CELL_TOKEN: CELL_TOKEN,
      OCW_MODEL_PROVIDER: "mock",
      OCW_EGRESS_TEST_HOSTS: "fake-kc=127.0.0.1",
    },
  });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  appRole = new pg.Client({ connectionString: stack.db.appUrl });
  await appRole.connect();

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
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee", "standard");
  let rileyId: string;
  [riley, rileyId] = await joinAs("riley@example.test", "Riley Park", "lead");
  [, alexId] = await joinAs("alex@example.test", "Alex Kim", "standard");
  [, joId] = await joinAs("jo@example.test", "Jo Diaz", "standard");
  let eveId: string;
  [eve, eveId] = await joinAs("eve@example.test", "Eve Black", "standard");

  const eng = await unit("department", "Engineering", null);
  backend = await unit("team", "Backend", eng);
  frontend = await unit("team", "Frontend", eng);
  await ok(victor.request("POST", `/api/v1/units/${backend}/members`, { userId: rileyId, role: "lead" }));
  await ok(victor.request("POST", `/api/v1/units/${backend}/members`, { userId: alexId }));
  await ok(victor.request("POST", `/api/v1/units/${frontend}/members`, { userId: joId }));

  victorBot = (await ok(victor.request("POST", "/api/v1/agents/personal", {}))).agent.id;
  samBot = (await ok(sam.request("POST", "/api/v1/agents/personal", {}))).agent.id;
  const bot = (extra: Json) => ({
    instructions: "You help.",
    modelProvider: "mock",
    modelId: "mock-1",
    ...extra,
  });
  backendBot = (
    await ok(
      victor.request("POST", "/api/v1/agents", bot({ name: "Deploy", username: "deploy", unitId: backend })),
    )
  ).id;
  orgBot = (await ok(victor.request("POST", "/api/v1/agents", bot({ name: "Archie", username: "archie" }))))
    .id;

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
  await appRole?.end();
  await su?.end();
  await stack?.stop();
  await new Promise<void>((resolve) => (fake ? fake.close(() => resolve()) : resolve()));
});

// ---------------------------------------------------------------- Task 1 (tracer)

describe("a personal key: sealed to its item, granted to a bot, resolved and injected server-side", () => {
  let item: Json;

  it("POST /keychain → 201 with a k_ handle and hasValue, and no value anywhere in the answer", async () => {
    item = await ok(victor.request("POST", "/api/v1/keychain", personalKey()), 201);
    expect(item).toMatchObject({
      scope: "personal",
      ownerUserId: victorId,
      unitId: null,
      kind: "api_key",
      hasValue: true,
      injection: { header: "Authorization", scheme: "bearer" },
      allowedHosts: ["api.crm.example"],
      agentIds: [],
      lastUsedAt: null,
    });
    expect(item.handle).toMatch(/^k_[a-z2-7]{10}$/);
    expect(item.valueUpdatedAt).toBe(item.createdAt);
    expect(JSON.stringify(item)).not.toContain(CANARY);
    expect(Object.keys(item)).not.toContain("value");
  });

  it("stores one sealed vault_item secret and a db SecretReference of its own organization", async () => {
    const row = (await su.query("select * from app.vault_items where id = $1", [item.id])).rows[0];
    expect(row.secret_ref).toEqual({ provider: "db", secretId: expect.any(String), organizationId: orgA });
    const secret = (await su.query("select * from app.secrets where id = $1", [row.secret_ref.secretId]))
      .rows[0];
    expect(secret.kind).toBe("vault_item");
    const stored = JSON.stringify(secret);
    expect(stored).not.toContain(CANARY);
    expect(stored).not.toContain(Buffer.from(CANARY).toString("base64"));
    // A db reference only (D-07 item 1): a pasted `secretRef` in the body is not a field and is ignored.
    const other = await ok(
      victor.request(
        "POST",
        "/api/v1/keychain",
        personalKey({
          name: "Ref attempt",
          value: CANARY_2,
          secretRef: { provider: "env", key: "OCW_SETUP_TOKEN" },
        }),
      ),
      201,
    );
    const ref = (await su.query("select secret_ref from app.vault_items where id = $1", [other.id])).rows[0];
    expect(ref.secret_ref.provider).toBe("db");
    await ok(victor.request("DELETE", `/api/v1/keychain/${other.id}`));
  });

  it("grants it to the owner's bot; effectiveVaultItems resolves the handle and prepareInjection the header", async () => {
    const granted = await ok(
      victor.request("PUT", `/api/v1/keychain/${item.id}/agents`, { agentIds: [victorBot] }),
    );
    expect(granted.agentIds).toEqual([victorBot]);
    expect(await effective(victorBot, victorId)).toEqual([item.handle]);
    const inj = await injectionFor(item.handle, victorId);
    expect(inj.headerName).toBe("Authorization");
    expect(inj.headerValue).toBe(`Bearer ${CANARY}`);
    expect(inj.secretParts).toContain(CANARY);
    expect(inj.secretParts).toContain(`Bearer ${CANARY}`);
  });

  it("a value moved onto another item does not open (AAD bound to the item id)", async () => {
    const second = await ok(
      victor.request("POST", "/api/v1/keychain", personalKey({ name: "Second", value: CANARY_2 })),
      201,
    );
    expect((await injectionFor(second.handle, victorId)).headerValue).toBe(`Bearer ${CANARY_2}`);
    await su.query(
      "update app.vault_items set secret_ref = (select secret_ref from app.vault_items where id = $1) where id = $2",
      [item.id, second.id],
    );
    const err = await injectionFor(second.handle, victorId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeychainError);
    expect((err as KeychainError).code).toBe("value_unavailable");
    expect(String(err)).not.toContain(CANARY);
    // The original still opens.
    expect((await injectionFor(item.handle, victorId)).headerValue).toBe(`Bearer ${CANARY}`);
  });

  it("a non-db reference is never resolved (D-07 item 1)", async () => {
    const third = await ok(
      victor.request("POST", "/api/v1/keychain", personalKey({ name: "Env ref", value: "unused-value" })),
      201,
    );
    await su.query(
      `update app.vault_items set secret_ref = '{"provider":"env","key":"OCW_SETUP_TOKEN"}'::jsonb where id = $1`,
      [third.id],
    );
    const err = await injectionFor(third.handle, victorId).catch((e: unknown) => e);
    expect((err as KeychainError).code).toBe("value_unavailable");
    expect(String(err)).not.toContain(TEST_SETUP_TOKEN);
  });
});
