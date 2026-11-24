import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./testing";

/**
 * Phase 07.18 (D-01, D-03, D-04, D-06, D-13, PD-04, PD-15, PD-21, PD-25; ADR-0044): the storage of the subscription
 * account pool. `app.account_pool_accounts` holds the organization's Claude setup-token accounts (the token itself is a
 * sealed `pool_token` secret, never a column), its ChatGPT sign-ins on a device (`device_slot`) and in the OpenClaw cell
 * (`cell_profile`); `app.account_pool_policies` holds one strategy per (organization, provider). Seeded and checked as
 * ocw_migrator on a fresh database with every migration applied; storage, tenant isolation and the TRUNCATE revoke are
 * proven as ocw_app.
 */

let tdb: TestDatabase;
let db: pg.Client;
let app: pg.Client;

type Q = pg.Client["query"];

interface Org {
  id: string;
  user: string;
  /** The device the org's work session runs on. */
  device: string;
  /** A second device, holding the ChatGPT slots whose cascade the tests prove. */
  slotDevice: string;
  project: string;
  session: string;
  conversation: string;
}

async function device(org: string, user: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash) values ($1, $2, $3, $4, 'linux', $5)",
    [id, org, user, name, `tok-${id}`],
  );
  return id;
}

async function seedOrg(): Promise<Org> {
  const id = randomUUID();
  await db.query("insert into auth.organization (id, name, slug) values ($1, 'O', $2)", [id, `o-${id}`]);
  const user = randomUUID();
  await db.query("insert into auth.user (id, name, email) values ($1, 'P', $2)", [user, `${user}@pool.test`]);
  await db.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'P', 'admin')",
    [id, user],
  );
  const dev = await device(id, user, "laptop");
  const slotDevice = await device(id, user, "build server");
  const project = randomUUID();
  await db.query(
    "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, $4, 'repo')",
    [project, id, dev, `l-${project}`],
  );
  const conversation = randomUUID();
  await db.query(
    "insert into app.conversations (id, organization_id, kind, name) values ($1, $2, 'work_session', 'ws')",
    [conversation, id],
  );
  const session = randomUUID();
  await db.query(
    "insert into app.work_sessions (id, organization_id, conversation_id, project_id, device_id, title, created_by) values ($1, $2, $3, $4, $5, 'T', $6)",
    [session, id, conversation, project, dev, user],
  );
  return { id, user, device: dev, slotDevice, project, session, conversation };
}

/** One sealed `pool_token` secret of `o` (fake ciphertext), as `q` (the migrator by default). */
async function poolSecret(o: Org, q: Q = db.query.bind(db) as Q): Promise<string> {
  const id = randomUUID();
  await q(
    "insert into app.secrets (id, organization_id, name, kind, provider, ciphertext, iv, tag) values ($1, $2, 'pool token', 'pool_token', 'claude', 'c', 'i', 't')",
    [id, o.id],
  );
  return id;
}

/** One account row of `o` (`cols` override or add columns; `undefined` leaves a column to its default), as `q`. */
async function account(
  o: Org,
  cols: Record<string, unknown>,
  q: Q = db.query.bind(db) as Q,
): Promise<string> {
  const base: Record<string, unknown> = { id: randomUUID(), organization_id: o.id, label: "Work", ...cols };
  const set = Object.entries(base).filter(([, v]) => v !== undefined);
  const res = await q(
    `insert into app.account_pool_accounts (${set.map(([k]) => k).join(", ")}) values (${set.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    set.map(([, v]) => v),
  );
  return res.rows[0].id as string;
}

/** A Claude token account of `o` with its own fresh secret. */
async function tokenAccount(o: Org, cols: Record<string, unknown> = {}, q?: Q): Promise<string> {
  const secret = await poolSecret(o, q);
  return account(o, { provider: "claude", kind: "token", secret_id: secret, ...cols }, q);
}

/** A ChatGPT sign-in slot of `o` on its slot device (a fresh slot id unless overridden). */
const slotAccount = (o: Org, cols: Record<string, unknown> = {}, q?: Q) =>
  account(
    o,
    { provider: "chatgpt", kind: "device_slot", device_id: o.slotDevice, slot_id: randomUUID(), ...cols },
    q,
  );

/** A ChatGPT sign-in profile of `o` in the OpenClaw cell (a fresh profile id unless overridden). */
const cellAccount = (o: Org, cols: Record<string, unknown> = {}, q?: Q) =>
  account(
    o,
    { provider: "chatgpt", kind: "cell_profile", cell_profile_id: `openai:pool-${randomUUID()}`, ...cols },
    q,
  );

async function refused(p: Promise<unknown>, named: { constraint: string }): Promise<void> {
  await expect(p, named.constraint).rejects.toMatchObject(named);
}

/** Runs `fn` as ocw_app with withTenant()'s two settings (`null` user = a user-less system transaction); rolled back. */
async function as<T>(org: string, userId: string | null, fn: (q: Q) => Promise<T>): Promise<T> {
  await app.query("begin");
  try {
    await app.query(
      "select set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)",
      [org, userId ?? ""],
    );
    return await fn(app.query.bind(app) as Q);
  } finally {
    await app.query("rollback");
  }
}

const TABLES = ["app.account_pool_accounts", "app.account_pool_policies"] as const;

let A: Org;
let B: Org;

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = new pg.Client({ connectionString: tdb.migratorUrl });
  app = new pg.Client({ connectionString: tdb.appUrl });
  await db.connect();
  await app.connect();
  A = await seedOrg();
  B = await seedOrg();
});

afterAll(async () => {
  await db?.end();
  await app?.end();
  await tdb?.stop();
});

describe("account pool storage (07.18, D-01, D-03, D-04, D-06)", () => {
  it("stores a Claude token, a ChatGPT device slot and a ChatGPT cell profile as ocw_app, with the defaults", async () => {
    await as(A.id, A.user, async (q) => {
      const token = await tokenAccount(A, { label: "Ana's Max" }, q);
      const slot = await slotAccount(A, { label: "Team Plus" }, q);
      const cell = await cellAccount(A, { label: "Bots Pro" }, q);
      const rows = await q(
        `select id, provider, kind, enabled, priority, weight, origin, credential_state, wrr_current, plan_type,
                cooldown_until, limit_reason, last_used_at, usage, usage_at, removed_at,
                created_at is not null as created, updated_at is not null as stamped
           from app.account_pool_accounts where id = any($1) order by kind`,
        [[token, slot, cell]],
      );
      const defaults = {
        enabled: true,
        priority: 0,
        weight: 1,
        origin: "admin",
        credential_state: "ok",
        wrr_current: 0,
        plan_type: null,
        cooldown_until: null,
        limit_reason: null,
        last_used_at: null,
        usage: null,
        usage_at: null,
        removed_at: null,
        created: true,
        stamped: true,
      };
      expect(rows.rows).toEqual([
        { id: cell, provider: "chatgpt", kind: "cell_profile", ...defaults },
        { id: slot, provider: "chatgpt", kind: "device_slot", ...defaults },
        { id: token, provider: "claude", kind: "token", ...defaults },
      ]);
    });
    // Rolled back with the tenant transaction.
    expect((await db.query("select count(*)::int as n from app.account_pool_accounts")).rows[0].n).toBe(0);
  });

  it("stores one policy per (organization, provider) with failover, all and the device-login fallback on", async () => {
    await as(A.id, A.user, async (q) => {
      await q("insert into app.account_pool_policies (organization_id, provider) values ($1, 'claude')", [
        A.id,
      ]);
      const row = await q(
        "select strategy, scope, fallback_to_device_login, updated_by, updated_at is not null as stamped from app.account_pool_policies where organization_id = $1",
        [A.id],
      );
      expect(row.rows).toEqual([
        {
          strategy: "failover",
          scope: "all",
          fallback_to_device_login: true,
          updated_by: null,
          stamped: true,
        },
      ]);
      await refused(
        q(
          "insert into app.account_pool_policies (organization_id, provider, strategy) values ($1, 'claude', 'weighted')",
          [A.id],
        ),
        { constraint: "account_pool_policies_pkey" },
      );
    });
    // The other provider is its own row.
    await db.query(
      "insert into app.account_pool_policies (organization_id, provider) values ($1, 'claude')",
      [A.id],
    );
    await db.query(
      "insert into app.account_pool_policies (organization_id, provider, strategy) values ($1, 'chatgpt', 'round_robin')",
      [A.id],
    );
    const both = await db.query(
      "select provider, strategy from app.account_pool_policies where organization_id = $1 order by provider",
      [A.id],
    );
    expect(both.rows).toEqual([
      { provider: "chatgpt", strategy: "round_robin" },
      { provider: "claude", strategy: "failover" },
    ]);
  });
});

describe("account pool tenant isolation (07.18, D-03, D-13)", () => {
  it("hides one organization's accounts and policies from another and refuses writes with its id", async () => {
    await tokenAccount(A);
    await slotAccount(A);
    await db.query(
      "insert into app.account_pool_policies (organization_id, provider) values ($1, 'chatgpt') on conflict do nothing",
      [A.id],
    );
    for (const tbl of TABLES) {
      const seeded = await db.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [
        A.id,
      ]);
      expect(seeded.rows[0].n, `${tbl} seeded`).toBeGreaterThan(0);
      const own = await as(A.id, A.user, (q) => q(`select count(*)::int as n from ${tbl}`));
      expect(own.rows[0].n, `${tbl} own`).toBe(seeded.rows[0].n);
      const cross = await as(B.id, B.user, (q) => q(`select count(*)::int as n from ${tbl}`));
      expect(cross.rows[0].n, `${tbl} cross-tenant select`).toBe(0);
      for (const stmt of [
        `update ${tbl} set organization_id = organization_id where organization_id = $1`,
        `delete from ${tbl} where organization_id = $1`,
      ]) {
        const r = await as(B.id, null, (q) => q(stmt, [A.id]));
        expect(r.rowCount, stmt).toBe(0);
      }
      // Without a tenant the app role sees nothing.
      expect((await app.query(`select count(*)::int as n from ${tbl}`)).rows[0].n, `${tbl} no tenant`).toBe(
        0,
      );
    }
    await expect(
      as(B.id, null, (q) =>
        account(A, { provider: "chatgpt", kind: "cell_profile", cell_profile_id: "openai:x" }, q),
      ),
      "cross-tenant account insert",
    ).rejects.toThrow(/row-level security/);
    await expect(
      as(B.id, null, (q) =>
        q("insert into app.account_pool_policies (organization_id, provider) values ($1, 'claude')", [A.id]),
      ),
      "cross-tenant policy insert",
    ).rejects.toThrow(/row-level security/);
  });

  it("both tables are ENABLE + FORCE RLS with the tenant policy, and the app role may not TRUNCATE them", async () => {
    const rls = await db.query(
      `select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as force,
              (select count(*)::int from pg_policies p where p.schemaname = 'app' and p.tablename = c.relname and p.policyname = 'tenant_isolation') as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relname in ('account_pool_accounts', 'account_pool_policies') order by c.relname`,
    );
    expect(rls.rows).toEqual([
      { relname: "account_pool_accounts", rls: true, force: true, policies: 1 },
      { relname: "account_pool_policies", rls: true, force: true, policies: 1 },
    ]);
    for (const tbl of TABLES) {
      await expect(
        as(A.id, null, (q) => q(`truncate ${tbl}`)),
        `truncate ${tbl}`,
      ).rejects.toMatchObject({ code: "42501" });
      const priv = await db.query("select has_table_privilege('ocw_app', $1, 'TRUNCATE') as t", [tbl]);
      expect(priv.rows[0].t, tbl).toBe(false);
    }
  });
});

describe("the session's account and the device cascade (07.18, PD-25)", () => {
  it("points a session at a pool account; deleting the slot's device deletes the slot and unlinks the session", async () => {
    const slot = await slotAccount(A);
    await as(A.id, A.user, async (q) => {
      const r = await q("update app.work_sessions set pool_account_id = $2 where id = $1", [A.session, slot]);
      expect(r.rowCount).toBe(1);
    });
    await db.query("update app.work_sessions set pool_account_id = $2 where id = $1", [A.session, slot]);
    await db.query("delete from app.devices where id = $1", [A.slotDevice]);
    expect(
      (await db.query("select count(*)::int as n from app.account_pool_accounts where id = $1", [slot]))
        .rows[0].n,
    ).toBe(0);
    const session = await db.query(
      "select organization_id, pool_account_id from app.work_sessions where id = $1",
      [A.session],
    );
    // The narrowed `SET NULL ("pool_account_id")` keeps the session's organization.
    expect(session.rows).toEqual([{ organization_id: A.id, pool_account_id: null }]);
    A.slotDevice = await device(A.id, A.user, "build server 2");
  });
});

describe("account pool checks and keys (07.18, D-01, D-03, PD-15, PD-25)", () => {
  it("refuses every malformed account, each by its named check", async () => {
    const secret = await poolSecret(A);
    const token = { provider: "claude", kind: "token", secret_id: secret };
    const slot = { provider: "chatgpt", kind: "device_slot", device_id: A.slotDevice, slot_id: randomUUID() };
    const cell = {
      provider: "chatgpt",
      kind: "cell_profile",
      cell_profile_id: `openai:pool-${randomUUID()}`,
    };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...token, secret_id: null }, "account_pool_accounts_shape_ck"],
      [{ ...token, provider: "chatgpt" }, "account_pool_accounts_shape_ck"],
      [{ ...token, device_id: A.slotDevice }, "account_pool_accounts_shape_ck"],
      [{ ...token, cell_profile_id: "openai:x" }, "account_pool_accounts_shape_ck"],
      [{ ...slot, slot_id: null }, "account_pool_accounts_shape_ck"],
      [{ ...slot, device_id: null }, "account_pool_accounts_shape_ck"],
      [{ ...slot, provider: "claude" }, "account_pool_accounts_shape_ck"],
      [{ ...cell, cell_profile_id: null }, "account_pool_accounts_shape_ck"],
      [{ ...cell, provider: "claude" }, "account_pool_accounts_shape_ck"],
      [{ ...cell, cell_profile_id: "" }, "account_pool_accounts_cell_profile_id_ck"],
      [{ ...cell, cell_profile_id: "p".repeat(121) }, "account_pool_accounts_cell_profile_id_ck"],
      [{ ...token, weight: 0 }, "account_pool_accounts_weight_ck"],
      [{ ...token, weight: 101 }, "account_pool_accounts_weight_ck"],
      [{ ...token, priority: -1 }, "account_pool_accounts_priority_ck"],
      [{ ...token, label: "" }, "account_pool_accounts_label_ck"],
      [{ ...token, label: "l".repeat(121) }, "account_pool_accounts_label_ck"],
      [{ ...token, plan_type: "p".repeat(65) }, "account_pool_accounts_plan_type_ck"],
      [{ ...token, limit_reason: "quota" }, "account_pool_accounts_limit_reason_ck"],
      [{ ...token, origin: "cli" }, "account_pool_accounts_origin_ck"],
      [{ ...token, credential_state: "expired" }, "account_pool_accounts_credential_state_ck"],
      [{ ...token, provider: "gemini" }, "account_pool_accounts_provider_ck"],
      [{ ...token, kind: "api_key" }, "account_pool_accounts_kind_ck"],
    ];
    for (const [cols, constraint] of cases) await refused(account(A, cols), { constraint });
    // The bounds themselves are accepted.
    const ok = await account(A, { ...token, weight: 100, label: "l".repeat(120), plan_type: "p".repeat(64) });
    const edge = await account(A, {
      ...cell,
      weight: 1,
      cell_profile_id: "p".repeat(120),
      limit_reason: "unknown",
    });
    const stored = await db.query(
      "select count(*)::int as n from app.account_pool_accounts where id = any($1)",
      [[ok, edge]],
    );
    expect(stored.rows[0].n).toBe(2);
  });

  it("accepts a removed token without its secret (soft removal)", async () => {
    const removed = await account(A, {
      provider: "claude",
      kind: "token",
      secret_id: null,
      removed_at: new Date().toISOString(),
    });
    const row = await db.query(
      "select secret_id, removed_at is not null as removed from app.account_pool_accounts where id = $1",
      [removed],
    );
    expect(row.rows).toEqual([{ secret_id: null, removed: true }]);
  });

  it("holds one live row per (device, slot) and per cell profile id; a removed row frees the key", async () => {
    const slotId = randomUUID();
    const first = await slotAccount(A, { slot_id: slotId });
    await refused(slotAccount(A, { slot_id: slotId }), { constraint: "account_pool_accounts_slot_uq" });
    await db.query("update app.account_pool_accounts set removed_at = now() where id = $1", [first]);
    const second = await slotAccount(A, { slot_id: slotId });
    expect(second).not.toBe(first);
    // The same slot id on another device is its own key.
    const otherDevice = await device(A.id, A.user, "desktop");
    await slotAccount(A, { slot_id: slotId, device_id: otherDevice });

    const profileId = `openai:pool-${randomUUID()}`;
    const cell = await cellAccount(A, { cell_profile_id: profileId });
    await refused(cellAccount(A, { cell_profile_id: profileId }), {
      constraint: "account_pool_accounts_profile_uq",
    });
    await db.query("update app.account_pool_accounts set removed_at = now() where id = $1", [cell]);
    await cellAccount(A, { cell_profile_id: profileId });
    // Another organization's cell may hold the same profile id.
    await cellAccount(B, { cell_profile_id: profileId });
  });

  it("stores a pool_token secret; deleting it unlinks the removed account and keeps its organization", async () => {
    const secret = await poolSecret(A);
    const acc = await account(A, { provider: "claude", kind: "token", secret_id: secret });
    // A live token must keep its secret: the shape check refuses the unlink, so the account is removed first.
    await refused(db.query("delete from app.secrets where id = $1", [secret]), {
      constraint: "account_pool_accounts_shape_ck",
    });
    await db.query("update app.account_pool_accounts set removed_at = now() where id = $1", [acc]);
    await db.query("delete from app.secrets where id = $1", [secret]);
    const row = await db.query(
      "select organization_id, secret_id from app.account_pool_accounts where id = $1",
      [acc],
    );
    expect(row.rows).toEqual([{ organization_id: A.id, secret_id: null }]);
    await refused(
      db.query(
        "insert into app.secrets (organization_id, name, kind, ciphertext, iv, tag) values ($1, 'k', 'pool_key', 'c', 'i', 't')",
        [A.id],
      ),
      { constraint: "secrets_kind_check" },
    );
  });

  it("refuses references into another organization: its device, its secret, its account", async () => {
    // Composite keys carry the organization (FKs bypass RLS).
    await refused(slotAccount(A, { device_id: B.slotDevice }), {
      constraint: "account_pool_accounts_device_fk",
    });
    const bSecret = await poolSecret(B);
    await refused(account(A, { provider: "claude", kind: "token", secret_id: bSecret }), {
      constraint: "account_pool_accounts_secret_fk",
    });
    const bAccount = await tokenAccount(B);
    await refused(
      db.query("update app.work_sessions set pool_account_id = $2 where id = $1", [A.session, bAccount]),
      { constraint: "work_sessions_pool_account_fk" },
    );
  });

  it("bounds the prompt's account switches, the device's pool version and the policy's strategy and scope", async () => {
    const prompt = await db.query(
      "insert into app.work_prompts (organization_id, work_session_id, author_user_id, body, position) values ($1, $2, $3, 'Fix the build', 1) returning id, account_switches",
      [A.id, A.session, A.user],
    );
    expect(prompt.rows[0].account_switches).toBe(0);
    const promptId = prompt.rows[0].id as string;
    for (const n of [-1, 4])
      await refused(
        db.query("update app.work_prompts set account_switches = $2 where id = $1", [promptId, n]),
        { constraint: "work_prompts_account_switches_ck" },
      );
    await db.query("update app.work_prompts set account_switches = 3 where id = $1", [promptId]);

    const dev = await db.query("select account_pool_version from app.devices where id = $1", [A.device]);
    expect(dev.rows).toEqual([{ account_pool_version: null }]);
    for (const v of [0, 101])
      await refused(
        db.query("update app.devices set account_pool_version = $2 where id = $1", [A.device, v]),
        { constraint: "devices_account_pool_version_ck" },
      );
    await db.query("update app.devices set account_pool_version = 1 where id = $1", [A.device]);

    const policy = (cols: Record<string, string>) => {
      const set = Object.entries({ organization_id: B.id, provider: "claude", ...cols });
      return db.query(
        `insert into app.account_pool_policies (${set.map(([k]) => k).join(", ")}) values (${set.map((_, i) => `$${i + 1}`).join(", ")})`,
        set.map(([, v]) => v),
      );
    };
    await refused(policy({ strategy: "random" }), { constraint: "account_pool_policies_strategy_ck" });
    await refused(policy({ scope: "ai_chats" }), { constraint: "account_pool_policies_scope_ck" });
    await refused(policy({ provider: "gemini" }), { constraint: "account_pool_policies_provider_ck" });
  });
});
