import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTenantDb, type TenantDb } from "./tenant";
import { startTestDatabase, type TestDatabase } from "./testing";

/**
 * FOUND-02/03: every org-scoped table in schema `app` has RLS + FORCE + a policy, cross-tenant reads return
 * 0 rows and cross-tenant writes fail when connected as ocw_app; ocw_app cannot touch schema `auth`.
 * A new table without a fixture below FAILS this test (new tables cannot dodge it).
 */

let tdb: TestDatabase;
let migrator: pg.Client;
let app: pg.Client;

const A = randomUUID();
const B = randomUUID();

async function seedOrg(c: pg.Client, org: string) {
  const user = randomUUID();
  const conv = randomUUID();
  const msg = randomUUID();
  const agent = randomUUID();
  const secret = randomUUID();
  const device = randomUUID();
  const project = randomUUID();
  const ws = randomUUID();
  const q = (text: string, values: unknown[]) => c.query(text, values);
  await q("insert into auth.organization (id, name, slug) values ($1, $2, $3)", [
    org,
    `Org ${org}`,
    `org-${org}`,
  ]);
  await q("insert into auth.user (id, name, email) values ($1, 'U', $2)", [user, `${user}@example.test`]);
  await q(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'U', 'admin')",
    [org, user],
  );
  const unit = randomUUID();
  await q(
    "insert into app.org_units (id, organization_id, kind, name, path) values ($1, $2, 'department', 'Engineering', ARRAY[$1]::uuid[])",
    [unit, org],
  );
  await q("insert into app.unit_memberships (organization_id, unit_id, user_id) values ($1, $2, $3)", [
    org,
    unit,
    user,
  ]);
  await q(
    "insert into app.permission_rules (organization_id, subject_kind, permission, effect) values ($1, 'everyone', 'channel.create', 'deny')",
    [org],
  );
  await q(
    "insert into app.audit_events (organization_id, actor_kind, actor_id, resource_type, action, result) values ($1, 'user', $2, 'org', 'test.seed', 'success')",
    [org, user],
  );
  await q("insert into app.streams (id, organization_id, last_seq) values ($1, $2, 1)", [
    `conv:${conv}`,
    org,
  ]);
  await q(
    "insert into app.stream_events (stream_id, seq, organization_id, type, payload) values ($1, 1, $2, 'test', '{}')",
    [`conv:${conv}`, org],
  );
  await q(
    "insert into app.conversations (id, organization_id, kind, name, slug, created_by) values ($1, $2, 'channel', 'general', $3, $4)",
    [conv, org, `general-${conv}`, user],
  );
  await q(
    "insert into app.conversation_members (conversation_id, organization_id, member_kind, member_id, role) values ($1, $2, 'user', $3, 'owner')",
    [conv, org, user],
  );
  await q(
    "insert into app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body) values ($1, $2, $3, 1, 'user', $4, 'hi')",
    [msg, org, conv, user],
  );
  await q(
    "insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id) values ($1, $2, 'Bot', $3, 'be nice', 'mock', 'mock-1')",
    [agent, org, `bot-${agent.slice(0, 8)}`],
  );
  await q(
    "insert into app.agent_credentials (organization_id, agent_id, kind, token_hash) values ($1, $2, 'channel_plugin', $3)",
    [org, agent, `hash-${agent}`],
  );
  await q(
    "insert into app.secrets (id, organization_id, name, kind, ciphertext, iv, tag) values ($1, $2, 'k', 'provider_api_key', 'c', 'i', 't')",
    [secret, org],
  );
  await q(
    "insert into app.model_providers (organization_id, provider, secret_id, allowed_models) values ($1, 'mock', $2, '{mock-1}')",
    [org, secret],
  );
  await q(
    "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash) values ($1, $2, $3, 'laptop', 'darwin', $4)",
    [device, org, user, `dev-${device}`],
  );
  await q(
    "insert into app.device_enrollments (code_hash, organization_id, user_id, expires_at) values ($1, $2, $3, now() + interval '10 minutes')",
    [`code-${device}`, org, user],
  );
  await q(
    "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, 'p1', 'repo')",
    [project, org, device],
  );
  const wsConv = randomUUID();
  await q(
    "insert into app.conversations (id, organization_id, kind, name) values ($1, $2, 'work_session', 'ws')",
    [wsConv, org],
  );
  await q(
    "insert into app.work_sessions (id, organization_id, conversation_id, project_id, device_id, title, created_by) values ($1, $2, $3, $4, $5, 'T', $6)",
    [ws, org, wsConv, project, device, user],
  );
  await q(
    "insert into app.work_prompts (organization_id, work_session_id, author_user_id, body, position) values ($1, $2, $3, 'do it', 1)",
    [org, ws, user],
  );
  await q(
    `insert into app.work_approvals (organization_id, work_session_id, request) values ($1, $2, '{"tool":"Edit","summary":"x","paths":["a.ts"]}')`,
    [org, ws],
  );
  await q(
    "insert into app.device_commands (organization_id, device_id, work_session_id, kind, payload) values ($1, $2, $3, 'prompt', '{}')",
    [org, device, ws],
  );

  // Phase 3.1 (personal bots and bot capabilities): one row per new table.
  const personal = randomUUID();
  const dm = randomUUID();
  const mcp = randomUUID();
  const plugin = randomUUID();
  await q(
    "insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, scope, owner_user_id) values ($1, $2, 'Mine', $3, 'x', 'mock', 'mock-1', 'personal', $4)",
    [personal, org, `mine-${personal.slice(0, 8)}`, user],
  );
  await q(
    "insert into app.conversations (id, organization_id, kind, visibility, dm_key) values ($1, $2, 'dm', 'private', $3)",
    [dm, org, `agent:${personal}|user:${user}`],
  );
  await q("insert into app.bot_policies (organization_id) values ($1)", [org]);
  const eventId = randomUUID();
  await q(
    "insert into app.agent_turns (event_id, organization_id, agent_id, user_id, conversation_id, conversation_kind, message_id) values ($1, $2, $3, $4, $5, 'dm', $6)",
    [eventId, org, personal, user, dm, randomUUID()],
  );
  await q(
    "insert into app.agent_tool_calls (organization_id, event_id, agent_id, user_id, tool, source_kind, decision) values ($1, $2, $3, $4, 'web_search', 'builtin', 'allowed')",
    [org, eventId, personal, user],
  );
  await q(
    "insert into app.agent_usage_daily (organization_id, agent_id, day, turns) values ($1, $2, current_date, 1)",
    [org, personal],
  );
  await q(
    "insert into app.agent_limit_notices (organization_id, agent_id, conversation_id, day) values ($1, $2, $3, current_date)",
    [org, personal, dm],
  );
  await q(
    "insert into app.agent_memories (organization_id, agent_id, user_id, text) values ($1, $2, $3, 'likes tea')",
    [org, personal, user],
  );
  await q(
    "insert into app.mcp_servers (id, organization_id, name, safe_name, transport, url) values ($1, $2, 'Docs', $3, 'streamable-http', 'https://mcp.example.test')",
    [mcp, org, `m${mcp.replace(/-/g, "").slice(0, 8)}`],
  );
  await q(
    "insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name) values ($1, $2, 'search', 'mx__search')",
    [org, mcp],
  );
  await q(
    "insert into app.cell_plugins (id, organization_id, package_name, version, channel, artifact_sha256, risk, status) values ($1, $2, '@openclaw/duckduckgo-plugin', '2026.9.7', 'official', 'abc', 'low', 'approved')",
    [plugin, org],
  );
  await q(
    "insert into app.cell_plugin_tools (organization_id, plugin_row_id, name) values ($1, $2, 'web_search')",
    [org, plugin],
  );
  await q(
    "insert into app.bot_tool_grants (organization_id, agent_id, source_kind, source_id, tool_name) values ($1, $2, 'mcp', $3, 'search')",
    [org, personal, mcp],
  );

  // Phase 03.2 (Work Zone session controls): one row per new table.
  await q(
    "insert into app.device_grants (organization_id, device_id, principal_kind, principal_id, max_mode, created_by) values ($1, $2, 'user', $3, 'acceptEdits', $3)",
    [org, device, user],
  );
  await q("insert into app.work_zone_policies (organization_id) values ($1)", [org]);
}

async function inTenant<T>(org: string, fn: () => Promise<T>): Promise<T> {
  await app.query("begin");
  try {
    await app.query("select set_config('app.organization_id', $1, true)", [org]);
    return await fn();
  } finally {
    await app.query("rollback");
  }
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  migrator = new pg.Client({ connectionString: tdb.migratorUrl });
  app = new pg.Client({ connectionString: tdb.appUrl });
  await migrator.connect();
  await app.connect();
  await seedOrg(migrator, A);
  await seedOrg(migrator, B);
});

afterAll(async () => {
  await migrator?.end();
  await app?.end();
  await tdb?.stop();
});

async function orgScopedTables(): Promise<
  Array<{ tbl: string; rls: boolean; force: boolean; policies: number }>
> {
  const res = await migrator.query(`
    SELECT c.oid::regclass::text AS tbl, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
           (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped
    WHERE c.relkind IN ('r','p') AND n.nspname = 'app' ORDER BY 1`);
  return res.rows;
}

describe("tenant isolation (RLS)", () => {
  it("Phase 3.1 schema constraints: personal bots need an owner, one DM per pair, bounded memory", async () => {
    const owner = randomUUID();
    await expect(
      migrator.query(
        "insert into app.agents (organization_id, name, username, instructions, model_provider, model_id, scope) values ($1, 'X', $2, 'x', 'mock', 'mock-1', 'personal')",
        [A, `x-${owner.slice(0, 8)}`],
      ),
    ).rejects.toThrow(/agents_owner_scope_check/);
    await expect(
      migrator.query(
        "insert into app.agents (organization_id, name, username, instructions, model_provider, model_id, scope, owner_user_id) values ($1, 'X', $2, 'x', 'mock', 'mock-1', 'team', $3)",
        [A, `y-${owner.slice(0, 8)}`, owner],
      ),
    ).rejects.toThrow(/agents_owner_scope_check/);
    const key = (
      await migrator.query(
        "select dm_key from app.conversations where organization_id = $1 and kind = 'dm'",
        [A],
      )
    ).rows[0].dm_key;
    await expect(
      migrator.query(
        "insert into app.conversations (organization_id, kind, visibility, dm_key) values ($1, 'dm', 'private', $2)",
        [A, key],
      ),
    ).rejects.toThrow(/conversations_org_dm_key_uq/);
    const agent = (
      await migrator.query("select id from app.agents where organization_id = $1 and scope = 'personal'", [A])
    ).rows[0].id;
    await expect(
      migrator.query(
        "insert into app.agent_memories (organization_id, agent_id, user_id, text) values ($1, $2, $3, $4)",
        [A, agent, owner, "x".repeat(501)],
      ),
    ).rejects.toThrow(/agent_memories_text_len_check/);
  });

  it("Phase 03.2 schema constraints: modes are the platform ladder, grants name a user or a unit", async () => {
    const device = (await migrator.query("select id from app.devices where organization_id = $1", [A]))
      .rows[0].id;
    for (const bad of ["bypassPermissions", "dontAsk", "danger-full-access"]) {
      await expect(
        migrator.query("update app.work_sessions set permission_mode = $2 where organization_id = $1", [
          A,
          bad,
        ]),
      ).rejects.toThrow(/work_sessions_permission_mode_ck/);
      await expect(
        migrator.query("update app.devices set share_max_mode = $2 where organization_id = $1", [A, bad]),
      ).rejects.toThrow(/devices_share_max_mode_ck/);
    }
    await expect(
      migrator.query(
        "insert into app.device_grants (organization_id, device_id, principal_kind, principal_id, max_mode) values ($1, $2, 'team', $3, 'plan')",
        [A, device, randomUUID()],
      ),
    ).rejects.toThrow(/device_grants_principal_kind_ck/);
    const policy = (
      await migrator.query(
        "select allowed_permission_modes, allow_full_access, allow_fast_mode from app.work_zone_policies where organization_id = $1",
        [A],
      )
    ).rows[0];
    expect(policy).toEqual({
      allowed_permission_modes: ["plan", "default", "acceptEdits", "auto"],
      allow_full_access: false,
      allow_fast_mode: false,
    });
  });

  it("app role is neither superuser nor BYPASSRLS", async () => {
    const r = await app.query("select rolsuper, rolbypassrls from pg_roles where rolname = current_user");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("every app table is org-scoped with RLS + FORCE + policy", async () => {
    const all = await migrator.query(
      "select c.oid::regclass::text as tbl from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind in ('r','p')",
    );
    const scoped = await orgScopedTables();
    expect(scoped.map((t) => t.tbl).sort()).toEqual(all.rows.map((r) => r.tbl).sort());
    for (const t of scoped) {
      expect(t, t.tbl).toMatchObject({ rls: true, force: true });
      expect(t.policies, t.tbl).toBeGreaterThan(0);
    }
  });

  it("cross-tenant reads return 0 rows and writes fail, for every org-scoped table", async () => {
    const tables = await orgScopedTables();
    expect(tables.length).toBeGreaterThanOrEqual(20);
    for (const { tbl } of tables) {
      const seeded = await migrator.query(
        `select count(*)::int as n from ${tbl} where organization_id = $1`,
        [A],
      );
      expect(seeded.rows[0].n, `${tbl} has no fixture row: add one to seedOrg()`).toBeGreaterThan(0);

      // Same tenant sees its rows (sanity) …
      const own = await inTenant(A, () => app.query(`select count(*)::int as n from ${tbl}`));
      expect(own.rows[0].n, `${tbl} own rows`).toBe(seeded.rows[0].n);

      // … another tenant sees none of A's rows.
      const cross = await inTenant(B, () =>
        app.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [A]),
      );
      expect(cross.rows[0].n, `${tbl} cross-tenant select`).toBe(0);

      // No context at all → zero rows, not an error (nullif on reused connections).
      const none = await app.query(`select count(*)::int as n from ${tbl}`);
      expect(none.rows[0].n, `${tbl} no-context select`).toBe(0);

      // UPDATE / DELETE of A's rows from B affect 0 rows (or are not even granted for append-only logs).
      for (const stmt of [
        `update ${tbl} set organization_id = organization_id where organization_id = $1`,
        `delete from ${tbl} where organization_id = $1`,
      ]) {
        const r = await inTenant(B, () =>
          app.query(stmt, [A]).then(
            (res) => res.rowCount,
            (err: Error) => (/permission denied/.test(err.message) ? 0 : Promise.reject(err)),
          ),
        );
        expect(r, `${tbl}: ${stmt}`).toBe(0);
      }

      // INSERT of a row belonging to A while in B's context → RLS violation.
      const row = await migrator.query(
        `select row_to_json(t) as j from ${tbl} t where organization_id = $1 limit 1`,
        [A],
      );
      await expect(
        inTenant(B, () =>
          app.query(`insert into ${tbl} select * from json_populate_record(null::${tbl}, $1::json)`, [
            JSON.stringify(row.rows[0].j),
          ]),
        ),
        `${tbl} cross-tenant insert`,
      ).rejects.toThrow(/row-level security/);
    }
  });

  it("app role is denied on schema auth", async () => {
    await expect(app.query("select * from auth.user")).rejects.toThrow(/permission denied/);
    await expect(app.query("select * from auth.session")).rejects.toThrow(/permission denied/);
  });

  it("survives Postgres dropping an idle pooled connection (no crash, next query reconnects)", async () => {
    const errors: Error[] = [];
    const db: TenantDb = createTenantDb(tdb.appUrl, { max: 1, onIdleError: (e) => errors.push(e) });
    try {
      const pid = (await db.pool.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      const su = new pg.Client({ connectionString: tdb.superuserUrl });
      await su.connect();
      try {
        await su.query("select pg_terminate_backend($1)", [pid]);
      } finally {
        await su.end();
      }
      await expect.poll(() => errors.length).toBeGreaterThan(0);
      const n = await db.withTenant({ organizationId: A }, async (tx) => {
        const r = await tx.execute("select count(*)::int as n from app.conversations");
        return (r.rows[0] as { n: number }).n;
      });
      expect(n).toBe(3); // channel + work-session conversation + the 3.1 DM fixture
    } finally {
      await db.close();
    }
  });

  it("survives Postgres killing a connection that is checked out mid-transaction (no crash)", async () => {
    const errors: Error[] = [];
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    const db: TenantDb = createTenantDb(tdb.appUrl, { max: 1, onIdleError: (e) => errors.push(e) });
    try {
      const attempt = db.withTenant({ organizationId: A }, async (tx) => {
        const pid = ((await tx.execute("select pg_backend_pid() as pid")).rows[0] as { pid: number }).pid;
        const su = new pg.Client({ connectionString: tdb.superuserUrl });
        await su.connect();
        try {
          await su.query("select pg_terminate_backend($1)", [pid]);
        } finally {
          await su.end();
        }
        await new Promise((r) => setTimeout(r, 200));
        await tx.execute("select 1");
      });
      await expect(attempt).rejects.toThrow();
      await expect.poll(() => errors.length).toBeGreaterThan(0);
      expect(uncaught).toEqual([]);
      const n = await db.withTenant({ organizationId: A }, async (tx) => {
        const r = await tx.execute("select count(*)::int as n from app.conversations");
        return (r.rows[0] as { n: number }).n;
      });
      expect(n).toBe(3); // channel + work-session conversation + the 3.1 DM fixture
    } finally {
      process.off("uncaughtException", onUncaught);
      await db.close();
    }
  });

  it("withTenant scopes queries and does not leak context to the pooled connection", async () => {
    const db: TenantDb = createTenantDb(tdb.appUrl, { max: 1 });
    try {
      const n = await db.withTenant({ organizationId: A }, async (tx) => {
        const r = await tx.execute("select count(*)::int as n from app.conversations");
        return (r.rows[0] as { n: number }).n;
      });
      expect(n).toBe(3); // channel + work-session conversation + the 3.1 DM fixture
      // Same single pooled connection, no tenant context now.
      const after = await db.pool.query("select count(*)::int as n from app.conversations");
      expect(after.rows[0].n).toBe(0);

      const hooks: string[] = [];
      await expect(
        db.withTenant({ organizationId: A }, async (_tx, afterCommit) => {
          afterCommit(() => {
            hooks.push("ran");
          });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(hooks).toEqual([]);

      const lookup = await db.lookups.deviceByTokenHash("nope");
      expect(lookup).toBeNull();
    } finally {
      await db.close();
    }
  });
});
