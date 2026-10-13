import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSchema, createTenantDb, localMigrations } from "@ocw/db";
import { bootstrapRoles, runMigrations } from "@ocw/db/migrate";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { loadEnv } from "./config/env";
import { open } from "./lib/crypto";

/**
 * SELF-03 / D-06 / D-18 (plan 07-02): N-1 → N upgrade. N-1 is the Phase 5 merge `3bbcbd9`; its schema and synthetic
 * data are the committed golden dump (regenerate: `pnpm --filter @ocw/db upgrade:baseline 3bbcbd9`). The dump is
 * restored as ocw_migrator with psql inside a fresh postgres:18 testcontainer, HEAD's migrations upgrade it, and the
 * data, tenant isolation, sealed secrets and the API itself must survive. From v0.1.0 on, N-1 = the previous release tag.
 */

const DUMP_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/test/upgrade/phase-5-3bbcbd9.sql",
);
const DUMP = readFileSync(DUMP_PATH, "utf8");
const PW = { migrator: "upgrade-migrator-pw", app: "upgrade-app-pw", auth: "upgrade-auth-pw" };
const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000001";
const SECRET_ID = "aaaaaaaa-0000-4000-8000-000000000301";
/** The dump's team bot and its non-admin member: their notes become the member's personal MEMORY.md (Phase 07.2). */
const HELPER_BOT = "aaaaaaaa-0000-4000-8000-000000000321";
const ADA_ADMIN = "aaaaaaaa-0000-4000-8000-000000000101";
const MAX_MEMBER = "aaaaaaaa-0000-4000-8000-000000000102";
/** Two MCP servers registered at N-1 (Phase 07.4: both must come out as `org_secret`). */
const MCP_HTTP = "aaaaaaaa-0000-4000-8000-000000000701";
const MCP_STDIO = "aaaaaaaa-0000-4000-8000-000000000702";
/** The seed's fixed test key (32 bytes of 0x07) and plaintext; see packages/db/test/upgrade/seed-phase-5.sql. */
const TEST_KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const SECRET_PLAINTEXT = "sk-upgrade-baseline-fake-provider-key";
/** HEAD's migrations after 3bbcbd9, in order. */
const HEAD_ONLY = [
  "20261007073058_multiplayer_ai",
  "20261007163629_work_prompt_images",
  "20261007173205_work_prompt_image_order",
  "20261010010825_board_channels",
  "20261013025212_memory_files",
  "20261013031658_memory_notes_backfill",
  "20261013095705_memory_scope_immutable",
  "20261013221007_connectors_keychain_templates",
  "20261013233856_agent_template_versions_immutable",
];
/** Tables the seed fills; each must keep its exact row count. */
const SEEDED = [
  "auth.organization",
  'auth."user"',
  "auth.account",
  "auth.member",
  "app.org_members",
  "app.secrets",
  "app.model_providers",
  "app.agents",
  "app.conversations",
  "app.conversation_members",
  "app.ai_chats",
  "app.messages",
  "app.message_versions",
  "app.ai_generations",
  "app.ai_usage_records",
  "app.attachments",
  "app.streams",
  "app.stream_events",
  "app.audit_events",
];

/** `COPY <table> (<cols>) FROM stdin;` blocks of the plain dump → rows per table. */
function dumpCopies(dump: string): Map<string, { columns: string[]; rows: string[][] }> {
  const out = new Map<string, { columns: string[]; rows: string[][] }>();
  const lines = dump.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const head = /^COPY (\S+) \((.*)\) FROM stdin;$/.exec(lines[i] ?? "");
    if (!head?.[1] || head[2] === undefined) continue;
    const rows: string[][] = [];
    for (i++; i < lines.length && lines[i] !== "\\."; i++) rows.push((lines[i] ?? "").split("\t"));
    out.set(head[1], { columns: head[2].split(", "), rows });
  }
  return out;
}

const COPIES = dumpCopies(DUMP);

describe("N-1 golden dump (3bbcbd9)", () => {
  it("names its git ref and regeneration command in the header", () => {
    const header = DUMP.split("\n").slice(0, 5).join("\n");
    expect(header).toContain("3bbcbd9");
    expect(header).toContain("pnpm --filter @ocw/db upgrade:baseline 3bbcbd9");
  });

  it("holds only append-only history: every migration applied at N-1 is byte-identical at HEAD", () => {
    const copy = COPIES.get("drizzle.__drizzle_migrations");
    expect(copy, "the dump carries the migrations table").toBeDefined();
    const nameIdx = copy?.columns.indexOf("name") ?? -1;
    const hashIdx = copy?.columns.indexOf("hash") ?? -1;
    const applied = (copy?.rows ?? []).map((r) => ({ name: r[nameIdx], hash: r[hashIdx] }));
    const head = new Map(localMigrations().map((m) => [m.name, m.hash]));
    expect(applied.length).toBe(head.size - HEAD_ONLY.length);
    for (const m of applied) {
      expect(head.has(m.name ?? ""), `${m.name} still ships at HEAD`).toBe(true);
      expect(head.get(m.name ?? ""), `${m.name} unchanged since it was applied`).toBe(m.hash);
    }
    expect([...head.keys()].filter((n) => !applied.some((a) => a.name === n))).toEqual(HEAD_ONLY);
  });

  it("contains the seeded data and no real e-mail domain", () => {
    for (const t of SEEDED) expect(COPIES.get(t)?.rows.length ?? 0, t).toBeGreaterThan(0);
    expect(DUMP).not.toMatch(/@(gmail|autofylabs)\./);
  });
});

describe("N-1 → N upgrade on a real PostgreSQL 18", () => {
  let pgc: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let urls: { superuser: string; migrator: string; app: string; auth: string };
  let before: Map<string, number>;

  async function counts(): Promise<Map<string, number>> {
    const c = new pg.Client({ connectionString: urls.migrator }); // the migrator role sees every row: real row counts
    await c.connect();
    try {
      const m = new Map<string, number>();
      for (const t of SEEDED) m.set(t, (await c.query(`select count(*)::int as n from ${t}`)).rows[0].n);
      return m;
    } finally {
      await c.end();
    }
  }

  beforeAll(async () => {
    [pgc, redis] = await Promise.all([
      new PostgreSqlContainer("postgres:18")
        .withDatabase("ocw")
        .withUsername("postgres")
        .withPassword("postgres")
        .start(),
      new RedisContainer("redis:8").start(),
    ]);
    const url = (u: string, p: string) => `postgres://${u}:${p}@${pgc.getHost()}:${pgc.getPort()}/ocw`;
    urls = {
      superuser: url("postgres", "postgres"),
      migrator: url("ocw_migrator", PW.migrator),
      app: url("ocw_app", PW.app),
      auth: url("ocw_auth", PW.auth),
    };
    await bootstrapRoles(urls.superuser, PW);
    // Plain PG18 dumps carry psql meta-commands (\restrict): psql inside the container, never node-pg.
    await pgc.copyContentToContainer([{ content: DUMP, target: "/tmp/baseline.sql" }]);
    const restore = await pgc.exec(
      [
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "--single-transaction",
        "-q",
        "-U",
        "ocw_migrator",
        "-d",
        "ocw",
        "-f",
        "/tmp/baseline.sql",
      ],
      { env: { PGPASSWORD: PW.migrator } },
    );
    expect(restore.exitCode, restore.stderr).toBe(0);
    // Phase 07.2 (D-02): the N-1 dump has no notes; two notes of Max with the helper bot, written at N-1.
    const seed = new pg.Client({ connectionString: urls.migrator });
    await seed.connect();
    try {
      await seed.query(
        "insert into app.agent_memories (organization_id, agent_id, user_id, text, created_at) values ($1, $2, $3, 'Prefers short answers', '2026-10-06 10:00:00+00'), ($1, $2, $3, 'Owns the billing\nrunbook', '2026-10-06 10:05:00+00')",
        [ORG_A, HELPER_BOT, MAX_MEMBER],
      );
      // Phase 07.4 (D-01): the N-1 dump has no MCP servers; an HTTP one and a stdio-sandbox one registered at N-1.
      await seed.query(
        "insert into app.mcp_servers (id, organization_id, name, safe_name, transport, url, sandbox_server, status) values ($1, $3, 'Docs', 'm0a0a0a01', 'streamable-http', 'https://mcp.example.test', null, 'ready'), ($2, $3, 'Files', 'm0a0a0a02', 'sandboxed-stdio', null, 'filesystem', 'ready')",
        [MCP_HTTP, MCP_STDIO, ORG_A],
      );
    } finally {
      await seed.end();
    }
    before = await counts();
  });

  afterAll(async () => {
    await Promise.allSettled([pgc?.stop(), redis?.stop()]);
  });

  it("restores the dump with every seeded row (row counts equal the dump's)", () => {
    for (const t of SEEDED) expect(before.get(t), t).toBe(COPIES.get(t)?.rows.length);
  });

  it("is behind by exactly HEAD_ONLY's migrations before the upgrade", async () => {
    const res = await checkSchema(urls.migrator);
    expect(res).toEqual({ status: "behind", pending: HEAD_ONLY, unknown: [], modified: [] });
    // N-1 had no read grant for ocw_app: an N-1 database is "never migrated" to the guard until `migrate` runs.
    expect((await checkSchema(urls.app)).status).toBe("missing");
  });

  describe("after HEAD's migrations", () => {
    beforeAll(async () => {
      await runMigrations({
        superuserUrl: urls.superuser,
        migratorUrl: urls.migrator,
        passwords: PW,
        log: () => {},
      });
    });

    it("is ok for the API's own role", async () => {
      expect(await checkSchema(urls.app)).toEqual({ status: "ok", pending: [], unknown: [], modified: [] });
    });

    it("keeps every seeded row", async () => {
      expect(await counts()).toEqual(before);
    });

    it("turns every restored conversation into a text conversation (Phase 07.1 D-01)", async () => {
      const c = new pg.Client({ connectionString: urls.migrator });
      await c.connect();
      try {
        const { rows } = await c.query(
          "select layout, count(*)::int as n from app.conversations group by layout order by layout",
        );
        expect(rows).toEqual([{ layout: "text", n: before.get("app.conversations") }]);
      } finally {
        await c.end();
      }
    });

    it("moves legacy bot notes into the member's personal MEMORY.md, owner-only, notes kept (Phase 07.2 D-02)", async () => {
      const c = new pg.Client({ connectionString: urls.migrator });
      await c.connect();
      try {
        const { rows } = await c.query(
          `select s.origin, s.personal_owner_user_id as owner, f.path, f.content, f.version
             from app.memory_scopes s join app.memory_files f on f.scope_id = s.id
            where s.kind = 'personal' and s.agent_id = $1 and s.owner_user_id = $2`,
          [HELPER_BOT, MAX_MEMBER],
        );
        expect(rows).toEqual([
          {
            origin: "legacy_notes",
            owner: MAX_MEMBER,
            path: "MEMORY.md",
            content: "# Memory\n\n- Prefers short answers\n- Owns the billing runbook\n",
            version: 1,
          },
        ]);
        const notes = await c.query("select count(*)::int as n from app.agent_memories where agent_id = $1", [
          HELPER_BOT,
        ]);
        expect(notes.rows[0].n).toBe(2);
      } finally {
        await c.end();
      }
      // As the API's role: Max reads his file, Ada (an admin of the same organization) does not.
      const db = createTenantDb(urls.app, { max: 1 });
      try {
        const read = (userId: string) =>
          db.withTenant({ organizationId: ORG_A, userId }, async (tx) => {
            const r = await tx.execute("select count(*)::int as n from app.memory_files");
            return (r.rows[0] as { n: number }).n;
          });
        expect(await read(MAX_MEMBER)).toBe(1);
        expect(await read(ADA_ADMIN)).toBe(0);
      } finally {
        await db.close();
      }
    });

    it("keeps every existing MCP server on the organization's credential, with no member state (Phase 07.4 D-01)", async () => {
      const c = new pg.Client({ connectionString: urls.migrator });
      await c.connect();
      try {
        const { rows } = await c.query(
          "select id, transport, auth_mode, oauth_status, member_header_name from app.mcp_servers order by id",
        );
        expect(rows).toEqual([
          {
            id: MCP_HTTP,
            transport: "streamable-http",
            auth_mode: "org_secret",
            oauth_status: null,
            member_header_name: null,
          },
          {
            id: MCP_STDIO,
            transport: "sandboxed-stdio",
            auth_mode: "org_secret",
            oauth_status: null,
            member_header_name: null,
          },
        ]);
        const empty = await c.query(
          `select (select count(*)::int from app.connector_connections) + (select count(*)::int from app.vault_items)
                + (select count(*)::int from app.agent_templates) + (select count(*)::int from app.member_account_shares) as n,
                  (select count(*)::int from app.agents where template_id is not null) as linked`,
        );
        expect(empty.rows).toEqual([{ n: 0, linked: 0 }]);
      } finally {
        await c.end();
      }
    });

    it("keeps tenant isolation: org A reads its rows, never org B's, and nothing without a tenant", async () => {
      const db = createTenantDb(urls.app, { max: 1 });
      try {
        const read = (org: string) =>
          db.withTenant({ organizationId: org }, async (tx) => {
            const r = await tx.execute(
              "select id::text as id, organization_id::text as org from app.messages order by id",
            );
            return r.rows as { id: string; org: string }[];
          });
        const a = await read(ORG_A);
        expect(a).toHaveLength(6);
        expect(a.every((r) => r.org === ORG_A)).toBe(true);
        const b = await read(ORG_B);
        expect(b.map((r) => r.id)).toEqual(["bbbbbbbb-0000-4000-8000-000000000501"]);
        expect((await db.pool.query("select count(*)::int as n from app.messages")).rows[0].n).toBe(0);
        const cross = await db.withTenant({ organizationId: ORG_B }, async (tx) => {
          const r = await tx.execute(
            `select count(*)::int as n from app.secrets where organization_id = '${ORG_A}'`,
          );
          return (r.rows[0] as { n: number }).n;
        });
        expect(cross).toBe(0);
      } finally {
        await db.close();
      }
    });

    it("has RLS enabled and FORCED, with the tenant policy, on every organization-scoped table", async () => {
      const c = new pg.Client({ connectionString: urls.migrator });
      await c.connect();
      try {
        const { rows } = await c.query<{ tbl: string; rls: boolean; force: boolean; policy: boolean }>(`
          select c.oid::regclass::text as tbl, c.relrowsecurity as rls, c.relforcerowsecurity as force,
                 exists (select 1 from pg_policies p where p.schemaname = 'app' and p.tablename = c.relname
                         and p.policyname = 'tenant_isolation') as policy
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
          where c.relkind in ('r', 'p') and n.nspname = 'app'
          order by 1`);
        expect(rows.length).toBeGreaterThan(40);
        expect(rows.map((r) => r.tbl)).toEqual(
          expect.arrayContaining(["app.ai_chat_grants", "app.message_cards"]),
        );
        expect(rows.filter((r) => !(r.rls && r.force && r.policy))).toEqual([]);
      } finally {
        await c.end();
      }
    });

    it("still decrypts the sealed secret with the test key, inside its tenant", async () => {
      const db = createTenantDb(urls.app, { max: 1 });
      try {
        const row = await db.withTenant({ organizationId: ORG_A }, async (tx) => {
          const r = await tx.execute(`select ciphertext, iv, tag from app.secrets where id = '${SECRET_ID}'`);
          return r.rows[0] as { ciphertext: string; iv: string; tag: string } | undefined;
        });
        expect(row).toBeDefined();
        if (!row) return;
        expect(open(Buffer.from(TEST_KEY_B64, "base64"), row, ORG_A)).toBe(SECRET_PLAINTEXT);
      } finally {
        await db.close();
      }
    });

    it("boots the API against the upgraded database: /health 200", async () => {
      const env = loadEnv({
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        DATABASE_URL: urls.app,
        AUTH_DATABASE_URL: urls.auth,
        REDIS_URL: redis.getConnectionUrl(),
        BETTER_AUTH_SECRET: "upgrade-test-better-auth-secret-0123456789",
        OCW_SETUP_TOKEN: "upgrade-test-setup-token",
        OCW_ENCRYPTION_KEY: TEST_KEY_B64,
        OCW_PUBLIC_WEB_URL: "http://localhost:3999",
        OCW_PUBLIC_API_URL: "http://localhost:4999",
      });
      const built = await buildApp(env, { logger: false });
      try {
        const res = await built.app.inject({ method: "GET", url: "/health" });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ status: "ok", checks: { db: "ok", redis: "ok" } });
      } finally {
        await built.close();
      }
    });
  });
});
