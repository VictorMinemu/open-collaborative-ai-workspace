import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeMcpOAuth } from "../../../../../infra/fake-model/fake-mcp-oauth.mjs";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { createPermissionService } from "../organization";
import {
  effectiveVaultItems,
  findVaultItemByHandle,
  KeychainError,
  prepareInjection,
  privateAllowFor,
  recordSecretUsed,
} from "./index";

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

// ---------------------------------------------------------------- Task 2

describe("unit keys, permissions, private hosts and grants", () => {
  let victorKey: Json;
  let samKey: Json;
  let backendKey: Json;
  let orgKey: Json;

  beforeAll(async () => {
    victorKey = (await ok(victor.request("GET", "/api/v1/keychain"))).personal.find(
      (i: Json) => i.name === "CRM",
    );
    samKey = await ok(
      sam.request("POST", "/api/v1/keychain", personalKey({ name: "Sam CRM", value: SAM_CANARY })),
      201,
    );
  });

  it("a standard member cannot create unit keys; a lead only for the units they lead; an admin for the organization", async () => {
    const unitKey = (unitId: string | null, extra: Json = {}) =>
      personalKey({ scope: "unit", unitId, name: "ERP", value: UNIT_CANARY, ...extra });
    await fails(sam.request("POST", "/api/v1/keychain", unitKey(null)), 403);
    await fails(sam.request("POST", "/api/v1/keychain", unitKey(backend)), 403);
    backendKey = await ok(riley.request("POST", "/api/v1/keychain", unitKey(backend)), 201);
    expect(backendKey).toMatchObject({ scope: "unit", unitId: backend, ownerUserId: null });
    await fails(riley.request("POST", "/api/v1/keychain", unitKey(frontend)), 403);
    await fails(riley.request("POST", "/api/v1/keychain", unitKey(null)), 403);
    orgKey = await ok(victor.request("POST", "/api/v1/keychain", unitKey(null, { name: "Org ERP" })), 201);
    expect(orgKey).toMatchObject({ scope: "unit", unitId: null });
    // A unit id that does not exist in this organization.
    await fails(victor.request("POST", "/api/v1/keychain", unitKey(randomUUID())), 404, "unit_not_found");
  });

  it("GET /keychain lists the caller's own keys and the unit keys they manage, never a value or the private hosts", async () => {
    const mine = await ok(victor.request("GET", "/api/v1/keychain"));
    expect(Object.keys(mine).sort()).toEqual(["manageableUnits", "personal", "unit"]);
    expect(mine.personal.map((i: Json) => i.ownerUserId)).toEqual(mine.personal.map(() => victorId));
    expect(mine.unit.map((i: Json) => i.id).sort()).toEqual([backendKey.id, orgKey.id].sort());
    expect(mine.manageableUnits[0]).toEqual({ unitId: null, name: "Whole organization" });
    const lead = await ok(riley.request("GET", "/api/v1/keychain"));
    expect(lead.personal).toEqual([]);
    expect(lead.unit.map((i: Json) => i.id)).toEqual([backendKey.id]);
    expect(lead.manageableUnits).toEqual([{ unitId: backend, name: "Backend" }]);
    const member = await ok(sam.request("GET", "/api/v1/keychain"));
    expect(member.personal.map((i: Json) => i.id)).toEqual([samKey.id]);
    expect(member.unit).toEqual([]);
    expect(member.manageableUnits).toEqual([]);
    for (const list of [mine, lead, member]) {
      for (const c of ALL_CANARIES) expect(JSON.stringify(list)).not.toContain(c);
    }
  });

  it("another member's personal key is 404 on every route, admins included", async () => {
    for (const c of [sam, victor]) {
      const target = c === sam ? victorKey.id : samKey.id;
      await fails(c.request("GET", `/api/v1/keychain/${target}`), 404, "vault_item_not_found");
      await fails(c.request("PATCH", `/api/v1/keychain/${target}`, { name: "Mine now" }), 404);
      await fails(c.request("PUT", `/api/v1/keychain/${target}/agents`, { agentIds: [] }), 404);
      await fails(c.request("DELETE", `/api/v1/keychain/${target}`), 404);
    }
    // A unit key outside the units a person manages is 404 too.
    await fails(sam.request("GET", `/api/v1/keychain/${backendKey.id}`), 404);
    await fails(riley.request("PATCH", `/api/v1/keychain/${orgKey.id}`, { name: "x" }), 404);
    expect((await su.query("select name from app.vault_items where id = $1", [samKey.id])).rows[0].name).toBe(
      "Sam CRM",
    );
  });

  it("the database hides a personal key from an admin of the same organization (owner-only RLS as ocw_app)", async () => {
    const as = async (userId: string, sql: string, params: unknown[] = []) => {
      await appRole.query("begin");
      try {
        await appRole.query(
          "select set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)",
          [orgA, userId],
        );
        return await appRole.query(sql, params);
      } finally {
        await appRole.query("rollback");
      }
    };
    const count = "select count(*)::int as n from app.vault_items where id = $1";
    expect((await as(victorId, count, [samKey.id])).rows[0].n).toBe(0);
    expect((await as("", count, [samKey.id])).rows[0].n).toBe(0);
    expect((await as(samId, count, [samKey.id])).rows[0].n).toBe(1);
    // Unit keys stay visible under tenant isolation.
    expect((await as(victorId, count, [backendKey.id])).rows[0].n).toBe(1);
    expect(
      (await as(victorId, "update app.vault_items set name = 'x' where id = $1", [samKey.id])).rowCount,
    ).toBe(0);
    expect((await as(victorId, "delete from app.vault_items where id = $1", [samKey.id])).rowCount).toBe(0);
    await expect(
      as(
        victorId,
        `insert into app.vault_items (organization_id, scope, owner_user_id, name, handle, kind, injection, allowed_hosts, secret_ref)
         values ($1, 'personal', $2, 'Planted', 'k_plantedaaa', 'api_key', '{"header":"Authorization","scheme":"bearer"}', '{a.example}', $3::jsonb)`,
        [orgA, samId, JSON.stringify({ provider: "db", secretId: randomUUID(), organizationId: orgA })],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("personal keys never target private hosts; the private-host allowlist is admin-only and feeds unit keys only", async () => {
    for (const hosts of [
      ["10.0.0.5"],
      ["192.168.1.10:8080"],
      ["127.0.0.1"],
      ["169.254.169.254"],
      ["localhost:8080"],
    ]) {
      await fails(
        sam.request("POST", "/api/v1/keychain", personalKey({ allowedHosts: hosts })),
        400,
        "private_host_personal",
      );
    }
    await fails(sam.request("GET", "/api/v1/keychain/private-hosts"), 403);
    await fails(sam.request("PUT", "/api/v1/keychain/private-hosts", { hosts: ["erp.lan:8443"] }), 403);
    await fails(riley.request("PUT", "/api/v1/keychain/private-hosts", { hosts: ["erp.lan:8443"] }), 403);
    await fails(
      victor.request("PUT", "/api/v1/keychain/private-hosts", { hosts: ["postgres:5432"] }),
      400,
      "platform_host",
    );
    expect(
      await ok(victor.request("PUT", "/api/v1/keychain/private-hosts", { hosts: ["erp.lan:8443"] })),
    ).toEqual({
      hosts: ["erp.lan:8443"],
    });
    expect(await ok(victor.request("GET", "/api/v1/keychain/private-hosts"))).toEqual({
      hosts: ["erp.lan:8443"],
    });
    // A host the admin listed as private is refused on a personal key, with or without a port.
    for (const hosts of [["erp.lan:8443"], ["erp.lan"]]) {
      await fails(
        sam.request("POST", "/api/v1/keychain", personalKey({ allowedHosts: hosts })),
        400,
        "private_host_personal",
      );
    }
    await fails(
      victor.request("PATCH", `/api/v1/keychain/${victorKey.id}`, { allowedHosts: ["10.1.2.3"] }),
      400,
      "private_host_personal",
    );
    const erp = await ok(
      riley.request(
        "POST",
        "/api/v1/keychain",
        personalKey({
          scope: "unit",
          unitId: backend,
          name: "LAN ERP",
          allowedHosts: ["erp.lan:8443", "other.lan"],
        }),
      ),
      201,
    );
    const allow = await asUser<string[][]>(victorId, async (tx) => {
      const unitItem = await findVaultItemByHandle(tx, erp.handle);
      const personal = await findVaultItemByHandle(tx, victorKey.handle);
      return [await privateAllowFor(tx, unitItem!), await privateAllowFor(tx, personal!)];
    });
    expect(allow).toEqual([["erp.lan:8443"], []]);
    await ok(riley.request("DELETE", `/api/v1/keychain/${erp.id}`));
    await ok(victor.request("PUT", "/api/v1/keychain/private-hosts", { hosts: [] }));
  });

  it("grants: a personal key goes to bots its owner can see; a unit key needs bot.configure on every bot", async () => {
    await fails(sam.request("PUT", `/api/v1/keychain/${samKey.id}/agents`, { agentIds: [victorBot] }), 404);
    await fails(
      sam.request("PUT", `/api/v1/keychain/${samKey.id}/agents`, { agentIds: [randomUUID()] }),
      404,
      "agent_not_found",
    );
    await ok(sam.request("PUT", `/api/v1/keychain/${samKey.id}/agents`, { agentIds: [samBot] }));
    await ok(riley.request("PUT", `/api/v1/keychain/${backendKey.id}/agents`, { agentIds: [backendBot] }));
    await fails(
      riley.request("PUT", `/api/v1/keychain/${backendKey.id}/agents`, { agentIds: [orgBot] }),
      403,
    );
    await ok(
      victor.request("PUT", `/api/v1/keychain/${orgKey.id}/agents`, { agentIds: [orgBot, backendBot] }),
    );
  });

  it("effectiveVaultItems: grant ∩ owner ∩ unit audience ∩ vault.use for the agent acting for the human", async () => {
    // No grant: Sam's bot holds only Sam's key.
    expect(await effective(samBot, samId)).toEqual([samKey.handle]);
    expect(await effective(orgBot, samId)).toEqual([orgKey.handle]);
    // A personal key never serves another human, not even through its own bot.
    expect(await effective(samBot, victorId)).toEqual([]);
    expect(
      await asUser(samId, (tx) =>
        effectiveVaultItems(tx, perms(), { agentId: victorBot, humanUserId: samId }),
      ),
    ).toEqual([]);
    // The API's owner rule holds even in a session that can see the key (its owner's).
    expect(
      await asUser(victorId, (tx) =>
        effectiveVaultItems(tx, perms(), { agentId: victorBot, humanUserId: samId }),
      ),
    ).toEqual([]);
    // A unit key serves the unit's audience: Alex (member), Riley (lead), Víctor (admin); never Jo (Frontend).
    expect(await effective(backendBot, alexId)).toEqual(
      [backendKey.handle, orgKey.handle].sort(byName(backendKey, orgKey)),
    );
    expect(await effective(backendBot, joId)).toEqual([orgKey.handle]);
    expect((await effective(backendBot, victorId)).sort()).toEqual([backendKey.handle, orgKey.handle].sort());

    // A deny rule on vault.use for the agent removes everything; for the human, it removes it for that human only.
    const denyAgent = await ok(
      victor.request("POST", "/api/v1/permission-rules", {
        subjectKind: "agent",
        subjectId: backendBot,
        permission: "vault.use",
        effect: "deny",
      }),
    );
    expect(await effective(backendBot, alexId)).toEqual([]);
    await ok(victor.request("DELETE", `/api/v1/permission-rules/${denyAgent.id}`));
    const denyHuman = await ok(
      victor.request("POST", "/api/v1/permission-rules", {
        subjectKind: "user",
        subjectId: alexId,
        permission: "vault.use",
        effect: "deny",
      }),
    );
    expect(await effective(backendBot, alexId)).toEqual([]);
    expect((await effective(backendBot, victorId)).length).toBe(2);
    await ok(victor.request("DELETE", `/api/v1/permission-rules/${denyHuman.id}`));
    expect((await effective(backendBot, alexId)).length).toBe(2);
  });

  it("PATCH with a new value re-seals in place and moves valueUpdatedAt; name, hosts and grants do not", async () => {
    const before = (
      await su.query("select secret_ref, value_updated_at from app.vault_items where id = $1", [victorKey.id])
    ).rows[0];
    const renamed = await ok(
      victor.request("PATCH", `/api/v1/keychain/${victorKey.id}`, {
        name: "CRM prod",
        allowedHosts: ["api.crm.example", "*.crm.example"],
      }),
    );
    expect(renamed.valueUpdatedAt).toBe(victorKey.valueUpdatedAt);
    expect(renamed.allowedHosts).toEqual(["api.crm.example", "*.crm.example"]);
    await ok(victor.request("PUT", `/api/v1/keychain/${victorKey.id}/agents`, { agentIds: [] }));
    await ok(victor.request("PUT", `/api/v1/keychain/${victorKey.id}/agents`, { agentIds: [victorBot] }));
    expect((await ok(victor.request("GET", `/api/v1/keychain/${victorKey.id}`))).valueUpdatedAt).toBe(
      victorKey.valueUpdatedAt,
    );
    await fails(
      victor.request("PATCH", `/api/v1/keychain/${victorKey.id}`, {
        secret: { kind: "basic", username: "u", password: "p" },
      }),
      400,
      "secret_kind_mismatch",
    );
    const replaced = await ok(
      victor.request("PATCH", `/api/v1/keychain/${victorKey.id}`, {
        secret: { kind: "api_key", value: CANARY_NEW },
      }),
    );
    expect(Date.parse(replaced.valueUpdatedAt)).toBeGreaterThan(Date.parse(victorKey.valueUpdatedAt));
    expect(JSON.stringify(replaced)).not.toContain(CANARY_NEW);
    const after = (await su.query("select secret_ref from app.vault_items where id = $1", [victorKey.id]))
      .rows[0];
    expect(after.secret_ref).toEqual(before.secret_ref);
    expect(
      (
        await su.query("select count(*)::int as n from app.secrets where id = $1", [
          after.secret_ref.secretId,
        ])
      ).rows[0].n,
    ).toBe(1);
    expect((await injectionFor(victorKey.handle, victorId)).headerValue).toBe(`Bearer ${CANARY_NEW}`);
    const audit = (await auditRows(["vault_item.updated"])).filter((r) => r.resource_id === victorKey.id);
    expect(audit.map((r) => r.metadata.valueChanged)).toEqual([false, true]);
    expect(audit[0]?.metadata.changed).toEqual(["name", "allowedHosts"]);
  });

  it("DELETE removes the key, its grants and its sealed value", async () => {
    const tmp = await ok(
      sam.request("POST", "/api/v1/keychain", personalKey({ name: "Tmp", value: "tmp-value" })),
      201,
    );
    await ok(sam.request("PUT", `/api/v1/keychain/${tmp.id}/agents`, { agentIds: [samBot] }));
    const ref = (await su.query("select secret_ref from app.vault_items where id = $1", [tmp.id])).rows[0]
      .secret_ref;
    await ok(sam.request("DELETE", `/api/v1/keychain/${tmp.id}`));
    expect(
      (await su.query("select count(*)::int as n from app.vault_items where id = $1", [tmp.id])).rows[0].n,
    ).toBe(0);
    expect(
      (
        await su.query("select count(*)::int as n from app.agent_vault_grants where vault_item_id = $1", [
          tmp.id,
        ])
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await su.query("select count(*)::int as n from app.secrets where id = $1", [ref.secretId])).rows[0].n,
    ).toBe(0);
    expect(await effective(samBot, samId)).toEqual([samKey.handle]);
  });

  it("every change is audited with ids, handle, scope, kind and hosts, never a value", async () => {
    const rows = await auditRows([
      "vault_item.created",
      "vault_item.updated",
      "vault_item.deleted",
      "vault_item.agents_changed",
      "keychain.private_hosts_updated",
      "secret.created",
      "secret.deleted",
    ]);
    const actions = new Set(rows.map((r) => r.action));
    for (const a of [
      "vault_item.created",
      "vault_item.updated",
      "vault_item.deleted",
      "vault_item.agents_changed",
      "keychain.private_hosts_updated",
    ]) {
      expect(actions, a).toContain(a);
    }
    const created = rows.find((r) => r.action === "vault_item.created" && r.resource_id === backendKey.id);
    expect(Object.keys(created!.metadata).sort()).toEqual([
      "handle",
      "hosts",
      "kind",
      "ownerUserId",
      "scope",
      "unitId",
    ]);
    const all = JSON.stringify(
      (await su.query("select * from app.audit_events where organization_id = $1", [orgA])).rows,
    );
    for (const c of ALL_CANARIES) expect(all).not.toContain(c);
  });

  it("recordSecretUsed audits secret.used with the host only and stamps last_used_at", async () => {
    await asUser(victorId, async (tx) => {
      const item = await findVaultItemByHandle(tx, victorKey.handle);
      await recordSecretUsed(stack.built.core, tx, {
        item: item!,
        agentId: victorBot,
        userId: victorId,
        eventId: randomUUID(),
        host: "api.crm.example/v1/secret-path?token=q",
        method: "get",
        status: 200,
        bytes: 42,
        durationMs: 12,
        result: "success",
      });
    });
    const [row] = await auditRows(["secret.used"]);
    expect(row).toMatchObject({
      resource_id: victorKey.id,
      agent_id: victorBot,
      user_id: victorId,
      result: "success",
    });
    expect(row!.metadata).toMatchObject({
      handle: victorKey.handle,
      host: "api.crm.example",
      method: "GET",
      status: 200,
    });
    expect(JSON.stringify(row)).not.toContain("secret-path");
    expect((await ok(victor.request("GET", `/api/v1/keychain/${victorKey.id}`))).lastUsedAt).not.toBeNull();
  });

  // ------------------------------------------------------------ cross-tenant (C-02)

  const routeKey = (key: string) => {
    const [method, path] = key.split(" ") as [string, string];
    return `${method} ${path.replace(/\/:[^/]+/g, "/:p")}`;
  };

  it("every keychain route has an org-B case, and org B never reaches org A's keys", async () => {
    const eveKey = await ok(
      eve.request("POST", "/api/v1/keychain", personalKey({ name: "Eve key", value: "eve-v" })),
      201,
    );
    const before = (
      await su.query("select * from app.vault_items where organization_id = $1 order by id", [orgA])
    ).rows;
    const cases: Record<string, () => Promise<void>> = {
      "GET /api/v1/keychain": async () => {
        const list = await ok(eve.request("GET", "/api/v1/keychain"));
        expect(list.personal.map((i: Json) => i.id)).toEqual([eveKey.id]);
        expect(list.unit).toEqual([]);
      },
      "POST /api/v1/keychain": async () => {
        await fails(
          eve.request("POST", "/api/v1/keychain", personalKey({ scope: "unit", unitId: backend, name: "X" })),
          404,
          "unit_not_found",
        );
      },
      "GET /api/v1/keychain/:p": async () => {
        await fails(eve.request("GET", `/api/v1/keychain/${backendKey.id}`), 404);
        await fails(eve.request("GET", `/api/v1/keychain/${victorKey.id}`), 404);
      },
      "PATCH /api/v1/keychain/:p": async () => {
        await fails(eve.request("PATCH", `/api/v1/keychain/${orgKey.id}`, { name: "Owned" }), 404);
      },
      "DELETE /api/v1/keychain/:p": async () => {
        await fails(eve.request("DELETE", `/api/v1/keychain/${orgKey.id}`), 404);
      },
      "PUT /api/v1/keychain/:p/agents": async () => {
        await fails(eve.request("PUT", `/api/v1/keychain/${orgKey.id}/agents`, { agentIds: [] }), 404);
        // Org A's bot id on org B's own key: not found in org B.
        await fails(
          eve.request("PUT", `/api/v1/keychain/${eveKey.id}/agents`, { agentIds: [orgBot] }),
          404,
          "agent_not_found",
        );
      },
      "GET /api/v1/keychain/private-hosts": async () => {
        expect(await ok(eve.request("GET", "/api/v1/keychain/private-hosts"))).toEqual({ hosts: [] });
      },
      "PUT /api/v1/keychain/private-hosts": async () => {
        await ok(eve.request("PUT", "/api/v1/keychain/private-hosts", { hosts: ["evil.lan"] }));
        const a = await su.query(
          "select egress_private_hosts from app.bot_policies where organization_id = $1",
          [orgA],
        );
        expect(a.rows[0]?.egress_private_hosts ?? []).toEqual([]);
      },
    };
    const registered = [...stack.built.authz.routes.keys()]
      .filter((k) => k.split(" ")[1]?.startsWith("/api/v1/keychain"))
      .map(routeKey)
      .sort();
    expect(registered).toEqual(Object.keys(cases).sort());
    for (const [key, mode] of stack.built.authz.routes) {
      if (key.split(" ")[1]?.startsWith("/api/v1/keychain")) expect(mode, key).toBe("user");
    }
    for (const run of Object.values(cases)) await run();
    const after = (
      await su.query("select * from app.vault_items where organization_id = $1 order by id", [orgA])
    ).rows;
    expect(after).toEqual(before);
    // The org-B effective view of an org-A bot is empty.
    const bView = await stack.built.core.db.withTenant({ organizationId: orgB, userId: null }, (tx) =>
      effectiveVaultItems(tx, perms(), { agentId: orgBot, humanUserId: victorId }),
    );
    expect(bView).toEqual([]);
  });
});

/** Expected order of two items in `effectiveVaultItems` (by name, then handle). */
function byName(a: Json, b: Json) {
  const name = new Map([
    [a.handle, a.name],
    [b.handle, b.name],
  ]);
  return (x: string, y: string) => String(name.get(x)).localeCompare(String(name.get(y)));
}
