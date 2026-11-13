import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSchema, createTenantDb, localMigrations } from "@ocw/db";
import { bootstrapRoles, JOB_QUEUE_NAMES, runMigrations } from "@ocw/db/migrate";
import { startAllOrNone } from "@ocw/db/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { loadEnv } from "./config/env";
import { open } from "./lib/crypto";
import { moduleStateOf } from "./modules/organization/module-access";
import { loadPrincipalFacts, loadRules } from "./modules/organization/permissions/facts";
import { orgResource } from "./modules/organization/permissions/policy";
import { decide } from "./modules/organization/permissions/resolve";

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
/** Phase 07.4 (WINDOWS #177): the Bots module's catalog patterns before 07.4 added `connector.connect` and `vault.use`. */
const OLD_BOTS_PATTERNS = [
  "bot.read",
  "bot.create_personal",
  "bot.configure",
  "bot.internet",
  "bot.tool.use",
];
const BEA_ADMIN = "bbbbbbbb-0000-4000-8000-000000000101";
/** Phase 07.5: a Work Zone session with one prompt and one tool-call ledger row, written at N-1. */
const N1_DEVICE = "aaaaaaaa-0000-4000-8000-000000000901";
const N1_PROJECT = "aaaaaaaa-0000-4000-8000-000000000902";
/** The dump's org A channel: a session only needs some conversation, and the dump's conversation count stays exact. */
const N1_SESSION_CONV = "aaaaaaaa-0000-4000-8000-000000000201";
const N1_SESSION = "aaaaaaaa-0000-4000-8000-000000000905";
const N1_PROMPT = "aaaaaaaa-0000-4000-8000-000000000906";
const N1_TOOL_CALL = "aaaaaaaa-0000-4000-8000-000000000907";
/** Phase 07.8: a bot turn delivered at N-1 (it must come out with no sandbox calls and no member data). */
const N1_TURN = "aaaaaaaa-0000-4000-8000-000000000908";
/** Phase 07.17: units and a notification written at N-1 (handles backfilled, no unit on the notification). */
const N1_DEPARTMENT = "aaaaaaaa-0000-4000-8000-000000000911";
const N1_TEAM = "aaaaaaaa-0000-4000-8000-000000000912";
const N1_B_TEAM = "bbbbbbbb-0000-4000-8000-000000000911";
const N1_NOTIFICATION = "aaaaaaaa-0000-4000-8000-000000000913";
/**
 * Phase 07.9 (D-08, D-13): before 07.9 every session update was also stored on the organization stream with the full
 * session DTO (title, branch, device name). One such event, next to an org-stream event of another type and the
 * session's own stream event, written at N-1.
 */
const N1_ORG_STREAM = `org:${ORG_A}`;
const N1_WS_STREAM = `ws:${N1_SESSION}`;
const N1_SESSION_DTO = {
  id: N1_SESSION,
  title: "Fix the build",
  branch: "fix/build",
  device: { id: N1_DEVICE, name: "laptop" },
  status: "idle",
};
const N1_UNITS_EVENT = { unitIds: [] as string[] };
/** Rows the N-1 seed adds to tables the dump already fills (their exact counts then include them). */
const N1_ADDED: Record<string, number> = { "app.streams": 2, "app.stream_events": 3 };
const BACKFILL_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/drizzle/20261014042429_bots_off_connector_vault_backfill/migration.sql",
);
/** Phase 07.6 (07.6-01, P-05): the same completion for the two automation grains that joined the Bots module (7 → 9). */
const AUTOMATION_BACKFILL_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/drizzle/20261030071644_bots_off_automation_backfill/migration.sql",
);
/**
 * Phase 07.7 (07.7-02, P-06, ADR-0027): the same completion for `agent.message`, which joined the Bots module (9 → 10).
 */
const AGENT_MESSAGE_BACKFILL_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/drizzle/20261103045700_bots_off_agent_message_backfill/migration.sql",
);
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
  "20261014020321_connector_oauth_use_cimd",
  "20261014042429_bots_off_connector_vault_backfill",
  "20261014125609_tool_approvals",
  "20261015141842_bot_sandboxes_browser",
  "20261015173538_share_attachment_turn",
  "20261015235124_sandbox_package_pins_immutable",
  "20261021200025_tool_call_requester_decides",
  "20261022040054_signin_card_kind",
  "20261022061052_browser_context_opened_host",
  "20261022070138_agent_member_data",
  "20261022213335_browser_takeover_abandoned",
  "20261023003251_work_zone_visibility",
  "20261028214642_runtime_updates",
  "20261030071129_automations",
  "20261030071644_bots_off_automation_backfill",
  "20261102201704_watched_write_lease",
  "20261102205627_automation_events_board_card_idx",
  "20261102205808_automation_events_purge_thread_key",
  "20261102210622_automation_events_full_message",
  "20261103043136_agent_chains",
  "20261103045700_bots_off_agent_message_backfill",
  "20261103182852_agent_turns_done_at",
  "20261103183214_agent_chains_active_idx",
  "20261103183523_agent_chain_hops_tick_attempts",
  "20261103183822_agent_chain_hops_parent_depth",
  "20261103184214_agent_chain_hops_question_org_fk",
  "20261106163356_org_connector_auth",
  "20261107092259_agent_turns_attachment_budget",
  "20261109173604_bot_work_zone",
  "20261110081210_automation_fan_out",
  "20261110124940_automation_item_waiting",
  "20261111194914_runtime_self_update",
  "20261111225544_bot_work_session_files",
  "20261112230733_bot_tasks",
  "20261113035112_bot_task_process_ends",
  "20261113175346_projects_git",
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

  /** The pgboss schema's catalog queues (pg-boss's own `__pgboss…` queues aside), or null when it is not installed. */
  async function pgbossQueues(): Promise<string[] | null> {
    const c = new pg.Client({ connectionString: urls.superuser });
    await c.connect();
    try {
      const ns = await c.query("select to_regnamespace('pgboss') is not null as installed");
      if (!ns.rows[0].installed) return null;
      const { rows } = await c.query<{ name: string }>(
        "select name from pgboss.queue where name not like '\\_\\_pgboss%' order by name",
      );
      return rows.map((r) => r.name);
    } finally {
      await c.end();
    }
  }

  beforeAll(async () => {
    [pgc, redis] = await startAllOrNone([
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
      // Phase 07.4 (WINDOWS #177): Bots turned off at N-1 with the old 5 patterns, for org A's everyone and for Max
      // in person (a duplicate row too, as a hand-written rule could be); org B holds only 3 of them (a custom set).
      for (const permission of [...OLD_BOTS_PATTERNS, "bot.read"])
        await seed.query(
          "insert into app.permission_rules (organization_id, scope_unit_id, subject_kind, subject_id, permission, effect) values ($1, null, 'everyone', null, $2, 'deny'), ($1, null, 'user', $3, $2, 'deny')",
          [ORG_A, permission, MAX_MEMBER],
        );
      for (const permission of OLD_BOTS_PATTERNS.slice(0, 3))
        await seed.query(
          "insert into app.permission_rules (organization_id, scope_unit_id, subject_kind, subject_id, permission, effect) values ($1, null, 'everyone', null, $2, 'deny')",
          [ORG_B, permission],
        );
      // Phase 07.5 (D-03, D-04): the N-1 dump has no Work Zone or tool-call ledger rows; a session with one prompt and
      // one ledger row written at N-1, which must come out with no proposer and no approval.
      await seed.query(
        "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash) values ($1, $2, $3, 'laptop', 'darwin', 'upgrade-device-token-hash')",
        [N1_DEVICE, ORG_A, ADA_ADMIN],
      );
      await seed.query(
        "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, 'p1', 'repo')",
        [N1_PROJECT, ORG_A, N1_DEVICE],
      );
      await seed.query(
        "insert into app.work_sessions (id, organization_id, conversation_id, project_id, device_id, title, created_by) values ($1, $2, $3, $4, $5, 'Fix the build', $6)",
        [N1_SESSION, ORG_A, N1_SESSION_CONV, N1_PROJECT, N1_DEVICE, ADA_ADMIN],
      );
      await seed.query(
        "insert into app.work_prompts (id, organization_id, work_session_id, author_user_id, body, position) values ($1, $2, $3, $4, 'Fix the build', 1)",
        [N1_PROMPT, ORG_A, N1_SESSION, ADA_ADMIN],
      );
      await seed.query(
        "insert into app.agent_tool_calls (id, organization_id, event_id, agent_id, user_id, tool, source_kind, target, decision, status) values ($1, $2, $3, $4, $5, 'web_search', 'builtin', 'example.test', 'allowed', 'ok')",
        [N1_TOOL_CALL, ORG_A, "aaaaaaaa-0000-4000-8000-000000000903", HELPER_BOT, MAX_MEMBER],
      );
      // Phase 07.8 (P-06, P-11): the N-1 dump has no bot turns; one delivered at N-1 with two tool calls.
      await seed.query(
        "insert into app.agent_turns (event_id, organization_id, agent_id, user_id, conversation_id, conversation_kind, message_id, tools, tool_calls, tainted) values ($1, $2, $3, $4, $5, 'channel', $6, '{web_search}', 2, true)",
        [N1_TURN, ORG_A, HELPER_BOT, MAX_MEMBER, N1_SESSION_CONV, "aaaaaaaa-0000-4000-8000-000000000909"],
      );
      // Phase 07.16 (D-15, D-16): the N-1 dump has no Work Zone policy row; org A's policy saved at N-1 (Full access on).
      await seed.query(
        "insert into app.work_zone_policies (organization_id, allow_full_access, updated_by) values ($1, true, $2)",
        [ORG_A, ADA_ADMIN],
      );
      // Phase 07.17 (D-11, D-14): the N-1 dump has no units, bot policy or notifications. Org A gets a department and a
      // team named like its live bot's username, org B a team; org A's bot policy saved at N-1 (no automation caps
      // existed yet: 07.6 added them with 15 / 96) and one mention notification of Max.
      await seed.query(
        "insert into app.org_units (id, organization_id, parent_id, kind, name, path, created_at) values ($1, $3, null, 'department', 'Logística Norte', ARRAY[$1]::uuid[], '2026-10-06 11:00:00+00'), ($2, $3, $1, 'team', 'Helper Bot', ARRAY[$1, $2]::uuid[], '2026-10-06 11:05:00+00')",
        [N1_DEPARTMENT, N1_TEAM, ORG_A],
      );
      await seed.query(
        "insert into app.org_units (id, organization_id, kind, name, path) values ($1, $2, 'team', 'Ops', ARRAY[$1]::uuid[])",
        [N1_B_TEAM, ORG_B],
      );
      await seed.query("insert into app.bot_policies (organization_id, updated_by) values ($1, $2)", [
        ORG_A,
        ADA_ADMIN,
      ]);
      await seed.query(
        "insert into app.notifications (id, organization_id, user_id, kind, conversation_id, message_id, actor_kind, actor_id) select $1, organization_id, $3, 'mention', conversation_id, id, 'user', $4 from app.messages where organization_id = $2 order by id limit 1",
        [N1_NOTIFICATION, ORG_A, MAX_MEMBER, ADA_ADMIN],
      );
      // Phase 07.9 (D-13): the session's DTO stored on the org stream and on its own stream, and a units event.
      await seed.query(
        "insert into app.streams (id, organization_id, last_seq) values ($1, $3, 2), ($2, $3, 1)",
        [N1_ORG_STREAM, N1_WS_STREAM, ORG_A],
      );
      await seed.query(
        "insert into app.stream_events (stream_id, seq, organization_id, type, payload, actor_user_id) values ($1, 1, $3, 'work_session.updated', $4, $5), ($1, 2, $3, 'units.updated', $6, $5), ($2, 1, $3, 'work_session.updated', $4, $5)",
        [
          N1_ORG_STREAM,
          N1_WS_STREAM,
          ORG_A,
          JSON.stringify(N1_SESSION_DTO),
          ADA_ADMIN,
          JSON.stringify(N1_UNITS_EVENT),
        ],
      );
    } finally {
      await seed.end();
    }
    before = await counts();
  });

  afterAll(async () => {
    await Promise.allSettled([pgc?.stop(), redis?.stop()]);
  });

  it("restores the dump with every seeded row (row counts equal the dump's, plus the N-1 seed's own rows)", () => {
    for (const t of SEEDED)
      expect(before.get(t), t).toBe((COPIES.get(t)?.rows.length ?? 0) + (N1_ADDED[t] ?? 0));
  });

  it("is behind by exactly HEAD_ONLY's migrations before the upgrade", async () => {
    const res = await checkSchema(urls.migrator);
    expect(res).toEqual({ status: "behind", pending: HEAD_ONLY, unknown: [], modified: [] });
    // N-1 had no read grant for ocw_app: an N-1 database is "never migrated" to the guard until `migrate` runs.
    expect((await checkSchema(urls.app)).status).toBe("missing");
    // Phase 07.6: N-1 has no job runtime.
    expect(await pgbossQueues()).toBeNull();
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

    it("installs pg-boss as the migrator, with every catalog queue, and lets ocw_app use it (Phase 07.6, D-07)", async () => {
      expect(await pgbossQueues()).toEqual([...JOB_QUEUE_NAMES].sort());
      // Phase 07.7 (D-11, ADR-0027): the hop timeouts' global tick queue is created on an upgraded database.
      expect(await pgbossQueues()).toContain("consult.tick");
      const c = new pg.Client({ connectionString: urls.app });
      await c.connect();
      try {
        const { rows } = await c.query(
          "select has_schema_privilege('pgboss', 'USAGE') as usage, has_schema_privilege('pgboss', 'CREATE') as create",
        );
        expect(rows[0]).toEqual({ usage: true, create: false });
      } finally {
        await c.end();
      }
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
          "select id, transport, auth_mode, oauth_status, member_header_name, oauth_use_cimd, auth_failure from app.mcp_servers order by id",
        );
        expect(rows).toEqual([
          {
            id: MCP_HTTP,
            transport: "streamable-http",
            auth_mode: "org_secret",
            oauth_status: null,
            member_header_name: null,
            // 07.4-10 (WINDOWS #179): existing servers keep the default (CIMD when it applies).
            oauth_use_cimd: true,
            // 07.14 D-15: no organization sign-in has ever failed on an existing server.
            auth_failure: null,
          },
          {
            id: MCP_STDIO,
            transport: "sandboxed-stdio",
            auth_mode: "org_secret",
            oauth_status: null,
            member_header_name: null,
            // 07.4-10 (WINDOWS #179): existing servers keep the default (CIMD when it applies).
            oauth_use_cimd: true,
            auth_failure: null,
          },
        ]);
        const empty = await c.query(
          `select (select count(*)::int from app.connector_connections) + (select count(*)::int from app.vault_items)
                + (select count(*)::int from app.agent_templates) + (select count(*)::int from app.member_account_shares) as n,
                  (select count(*)::int from app.agents where template_id is not null) as linked,
                  (select count(*)::int from app.connector_org_connections) as org_connections`,
        );
        // 07.14 D-12: the upgrade connects no organization account; every server keeps what it had.
        expect(empty.rows).toEqual([{ n: 0, linked: 0, org_connections: 0 }]);
      } finally {
        await c.end();
      }
    });

    it("completes the old Bots-off rule sets, so Bots reads off and denies connections, keys, automations and consults; a custom set is untouched (WINDOWS #177, 07.6-01, 07.7-02)", async () => {
      const db = createTenantDb(urls.app, { max: 1 });
      try {
        const view = (organizationId: string, userId: string) =>
          db.withTenant({ organizationId }, async (tx) => {
            const rules = await loadRules(tx);
            const facts = await loadPrincipalFacts(tx, { kind: "user", userId });
            const allowed = (
              p: "connector.connect" | "vault.use" | "bot.read" | "automation.create" | "automation.webhook",
            ) => decide(facts, orgResource(), rules, p).allowed;
            return {
              everyone: moduleStateOf(rules, "bots", null, { kind: "everyone" }),
              person: moduleStateOf(rules, "bots", null, { kind: "user", userId }),
              connect: allowed("connector.connect"),
              vault: allowed("vault.use"),
              botRead: allowed("bot.read"),
              automation: allowed("automation.create"),
              webhook: allowed("automation.webhook"),
              rows: rules.length,
            };
          });
        expect(await view(ORG_A, MAX_MEMBER)).toEqual({
          everyone: "off",
          person: "off",
          connect: false,
          vault: false,
          botRead: false,
          automation: false,
          webhook: false,
          // 5 + 1 duplicate per subject at N-1, plus the 2 added by 07.4-14, the 2 added by 07.6-01 and the
          // `agent.message` row added by 07.7-02 for each subject.
          rows: 22,
        });
        expect(await view(ORG_B, BEA_ADMIN)).toEqual({
          everyone: "custom",
          person: "on",
          connect: true,
          vault: true,
          botRead: false,
          // Bea is an admin: the custom set leaves her automation grains as they were.
          automation: true,
          webhook: true,
          rows: 3,
        });
        // Idempotent: running the backfill again adds nothing.
        const c = new pg.Client({ connectionString: urls.migrator });
        await c.connect();
        try {
          const n = async () =>
            (await c.query("select count(*)::int as n from app.permission_rules")).rows[0].n as number;
          const before = await n();
          await c.query(readFileSync(BACKFILL_DIR, "utf8"));
          await c.query(readFileSync(AUTOMATION_BACKFILL_DIR, "utf8"));
          await c.query(readFileSync(AGENT_MESSAGE_BACKFILL_DIR, "utf8"));
          expect(await n()).toBe(before);
          // 07.7-02 (ADR-0027): `agent.message` is denied for org A's everyone and for Max in person, by an authorless
          // deny row without tool or folder; Bea's custom set gets none. The backfill never writes an allow row. (The
          // resolver view above reads `off` for the 10-pattern Bots catalog once 07.7-01's grain is merged.)
          const consults = await c.query(
            "select organization_id, scope_unit_id, subject_kind, subject_id, effect, tool, path_prefix, created_by from app.permission_rules where permission = 'agent.message' order by subject_kind",
          );
          expect(consults.rows).toEqual([
            {
              organization_id: ORG_A,
              scope_unit_id: null,
              subject_kind: "everyone",
              subject_id: null,
              effect: "deny",
              tool: null,
              path_prefix: null,
              created_by: null,
            },
            {
              organization_id: ORG_A,
              scope_unit_id: null,
              subject_kind: "user",
              subject_id: MAX_MEMBER,
              effect: "deny",
              tool: null,
              path_prefix: null,
              created_by: null,
            },
          ]);
          const automations = await c.query(
            "select organization_id, subject_kind, permission, created_by from app.permission_rules where permission like 'automation.%' order by subject_kind, permission",
          );
          expect(automations.rows).toEqual([
            {
              organization_id: ORG_A,
              subject_kind: "everyone",
              permission: "automation.create",
              created_by: null,
            },
            {
              organization_id: ORG_A,
              subject_kind: "everyone",
              permission: "automation.webhook",
              created_by: null,
            },
            {
              organization_id: ORG_A,
              subject_kind: "user",
              permission: "automation.create",
              created_by: null,
            },
            {
              organization_id: ORG_A,
              subject_kind: "user",
              permission: "automation.webhook",
              created_by: null,
            },
          ]);
          const added = await c.query(
            "select subject_kind, permission, created_by from app.permission_rules where permission in ('connector.connect', 'vault.use') order by subject_kind, permission",
          );
          expect(added.rows).toEqual([
            { subject_kind: "everyone", permission: "connector.connect", created_by: null },
            { subject_kind: "everyone", permission: "vault.use", created_by: null },
            { subject_kind: "user", permission: "connector.connect", created_by: null },
            { subject_kind: "user", permission: "vault.use", created_by: null },
          ]);
        } finally {
          await c.end();
        }
      } finally {
        await db.close();
      }
    });

    it("keeps every bot turn outside any chain and adds no chain or hop (Phase 07.7, D-04, D-14)", async () => {
      const c = new pg.Client({ connectionString: urls.migrator });
      await c.connect();
      try {
        const turns = await c.query(
          "select event_id, chain_id, chain_depth, answering_hop_id, returning_hop_id, reply_message_id from app.agent_turns order by event_id",
        );
        expect(turns.rows).toEqual([
          {
            event_id: N1_TURN,
            chain_id: null,
            chain_depth: 0,
            answering_hop_id: null,
            returning_hop_id: null,
            reply_message_id: null,
          },
        ]);
        const empty = await c.query(
          "select (select count(*)::int from app.agent_chains) as chains, (select count(*)::int from app.agent_chain_hops) as hops",
        );
        expect(empty.rows).toEqual([{ chains: 0, hops: 0 }]);
      } finally {
        await c.end();
      }
    });

    it("keeps Work Zone prompts and tool-call ledger rows, with no proposer and no approval, and no approval data (Phase 07.5)", async () => {
      const c = new pg.Client({ connectionString: urls.migrator });
      await c.connect();
      try {
        const prompts = await c.query(
          "select id, body, author_user_id, proposed_by_agent_id from app.work_prompts order by id",
        );
        expect(prompts.rows).toEqual([
          { id: N1_PROMPT, body: "Fix the build", author_user_id: ADA_ADMIN, proposed_by_agent_id: null },
        ]);
        const calls = await c.query(
          "select id, tool, decision, approval_id from app.agent_tool_calls order by id",
        );
        expect(calls.rows).toEqual([
          { id: N1_TOOL_CALL, tool: "web_search", decision: "allowed", approval_id: null },
        ]);
        const empty = await c.query(
          `select (select count(*)::int from app.tool_approval_policies) as policies,
                  (select count(*)::int from app.tool_call_approvals) as approvals,
                  (select count(*)::int from app.work_zone_proposals) as proposals`,
        );
        expect(empty.rows).toEqual([{ policies: 0, approvals: 0, proposals: 0 }]);
      } finally {
        await c.end();
      }
    });

    it("keeps bot turns with no sandbox calls and no member data, adds no sandbox or browser data, and every secret passes the kind check (Phase 07.8)", async () => {
      const c = new pg.Client({ connectionString: urls.migrator });
      await c.connect();
      try {
        const turns = await c.query(
          "select event_id, tool_calls, tainted, sandbox_calls, member_data from app.agent_turns order by event_id",
        );
        expect(turns.rows).toEqual([
          { event_id: N1_TURN, tool_calls: 2, tainted: true, sandbox_calls: 0, member_data: false },
        ]);
        // No deny rule seeded and no backfill (D-12): every new table starts empty.
        const empty = await c.query(
          `select (select count(*)::int from app.sandbox_policies) as policies,
                  (select count(*)::int from app.bot_sandboxes) as sandboxes,
                  (select count(*)::int from app.sandbox_usage_daily) as usage,
                  (select count(*)::int from app.sandbox_event_cursor) as cursors,
                  (select count(*)::int from app.browser_contexts) as contexts,
                  (select count(*)::int from app.browser_sessions) as sessions,
                  (select count(*)::int from app.browser_signin_requests) as signins,
                  (select count(*)::int from app.bot_turn_activity) as activity,
                  (select count(*)::int from app.sandbox_packages) as packages,
                  (select count(*)::int from app.sandbox_package_installs) as installs,
                  (select count(*)::int from app.permission_rules where permission like 'sandbox.%' or permission like 'browser.%') as rules`,
        );
        expect(empty.rows).toEqual([
          {
            policies: 0,
            sandboxes: 0,
            usage: 0,
            cursors: 0,
            contexts: 0,
            sessions: 0,
            signins: 0,
            activity: 0,
            packages: 0,
            installs: 0,
            rules: 0,
          },
        ]);
        // The new kind check was validated against the restored secrets (it would have failed the migration otherwise).
        const kinds = await c.query(
          "select c.convalidated from pg_constraint c where c.conrelid = 'app.secrets'::regclass and c.conname = 'secrets_kind_check'",
        );
        expect(kinds.rows).toEqual([{ convalidated: true }]);
        expect(
          (await c.query("select count(*)::int as n from app.secrets where id = $1", [SECRET_ID])).rows,
        ).toEqual([{ n: 1 }]);
      } finally {
        await c.end();
      }
    });

    it("starts every bot turn with an empty attachment budget and keeps its other counters (Phase 07.15, D-11, D-17)", async () => {
      const c = new pg.Client({ connectionString: urls.migrator });
      await c.connect();
      try {
        const turns = await c.query(
          "select event_id, tool_calls, sandbox_calls, tainted, attachment_reads, attachment_chars from app.agent_turns order by event_id",
        );
        expect(turns.rows).toEqual([
          {
            event_id: N1_TURN,
            tool_calls: 2,
            sandbox_calls: 0,
            tainted: true,
            attachment_reads: 0,
            attachment_chars: 0,
          },
        ]);
      } finally {
        await c.end();
      }
    });

    it("starts every existing device, session, prompt, policy and turn with no bot facts, and adds no bot Work Zone rows (Phase 07.16, D-16)", async () => {
      const c = new pg.Client({ connectionString: urls.migrator });
      await c.connect();
      try {
        const devices = await c.query(
          "select id, name, full_access_opt_in, host_kind, isolated_server from app.devices order by id",
        );
        expect(devices.rows).toEqual([
          {
            id: N1_DEVICE,
            name: "laptop",
            full_access_opt_in: false,
            host_kind: null,
            isolated_server: false,
          },
        ]);
        const sessions = await c.query(
          "select id, title, created_by, started_by_agent_id, tainted_at from app.work_sessions order by id",
        );
        expect(sessions.rows).toEqual([
          {
            id: N1_SESSION,
            title: "Fix the build",
            created_by: ADA_ADMIN,
            started_by_agent_id: null,
            tainted_at: null,
          },
        ]);
        const prompts = await c.query(
          "select id, body, author_user_id, author_agent_id, tainted from app.work_prompts order by id",
        );
        expect(prompts.rows).toEqual([
          {
            id: N1_PROMPT,
            body: "Fix the build",
            author_user_id: ADA_ADMIN,
            author_agent_id: null,
            tainted: false,
          },
        ]);
        const policies = await c.query(
          "select organization_id, allow_full_access, bot_sessions_max from app.work_zone_policies order by organization_id",
        );
        expect(policies.rows).toEqual([
          { organization_id: ORG_A, allow_full_access: true, bot_sessions_max: 10 },
        ]);
        const turns = await c.query(
          "select event_id, tool_calls, tainted, session_output_read from app.agent_turns order by event_id",
        );
        expect(turns.rows).toEqual([
          { event_id: N1_TURN, tool_calls: 2, tainted: true, session_output_read: false },
        ]);
        // `work_zone_proposals` is newer than N-1 (none can exist there): its new column is NOT NULL DEFAULT false, so a
        // proposal stored by N-1 code against this schema reads untainted too.
        const proposalCol = await c.query(
          "select is_nullable, column_default from information_schema.columns where table_schema = 'app' and table_name = 'work_zone_proposals' and column_name = 'tainted'",
        );
        expect(proposalCol.rows).toEqual([{ is_nullable: "NO", column_default: "false" }]);
        const empty = await c.query(
          `select (select count(*)::int from app.bot_work_zone_profiles) as profiles,
                  (select count(*)::int from app.bot_work_zone_profile_projects) as projects,
                  (select count(*)::int from app.device_bot_consents) as consents,
                  (select count(*)::int from app.bot_work_sessions) as bot_sessions`,
        );
        expect(empty.rows).toEqual([{ profiles: 0, projects: 0, consents: 0, bot_sessions: 0 }]);
      } finally {
        await c.end();
      }
      expect(await pgbossQueues()).toContain("work_session.bot_sync");
    });

    it("starts every automation with fan-out off, gives every unit a handle, moves default caps to 5 / 288 and opens nothing (Phase 07.17, D-11, D-14)", async () => {
      const c = new pg.Client({ connectionString: urls.migrator });
      await c.connect();
      try {
        const units = await c.query("select id, handle from app.org_units order by id");
        expect(units.rows).toEqual([
          { id: N1_DEPARTMENT, handle: "logistica-norte" },
          // The dump's live team bot is `helper-bot`: a unit never takes a bot's username.
          { id: N1_TEAM, handle: "helper-bot-2" },
          { id: N1_B_TEAM, handle: "ops" },
        ]);
        const policies = await c.query(
          "select organization_id, min_schedule_minutes, max_runs_per_day_cap from app.bot_policies order by organization_id",
        );
        expect(policies.rows).toEqual([
          { organization_id: ORG_A, min_schedule_minutes: 5, max_runs_per_day_cap: 288 },
        ]);
        const notifications = await c.query("select id, kind, unit_id from app.notifications order by id");
        expect(notifications.rows).toEqual([{ id: N1_NOTIFICATION, kind: "mention", unit_id: null }]);
        // `automations` is newer than N-1 (none can exist there): its new columns are defaulted, so an automation stored
        // by N-1 code against this schema reads fan-out off, 10 / 100, no escalation and no run log.
        const cols = await c.query(
          "select column_name, is_nullable, column_default from information_schema.columns where table_schema = 'app' and table_name = 'automations' and column_name in ('fan_out_enabled','fan_out_per_run','fan_out_per_day','escalation_targets','run_log_message_id') order by column_name",
        );
        expect(cols.rows).toEqual([
          { column_name: "escalation_targets", is_nullable: "NO", column_default: "'[]'::jsonb" },
          { column_name: "fan_out_enabled", is_nullable: "NO", column_default: "false" },
          { column_name: "fan_out_per_day", is_nullable: "NO", column_default: "100" },
          { column_name: "fan_out_per_run", is_nullable: "NO", column_default: "10" },
          { column_name: "run_log_message_id", is_nullable: "YES", column_default: null },
        ]);
        const empty = await c.query(
          "select (select count(*)::int from app.automations where fan_out_enabled) as fan_out, (select count(*)::int from app.automation_conversations) as opened",
        );
        expect(empty.rows).toEqual([{ fan_out: 0, opened: 0 }]);
      } finally {
        await c.end();
      }
      expect(await pgbossQueues()).toContain("automation.item");
    });

    it("starts every policy at a 25 MiB bot file limit, every profile at the organization's and an empty file ledger (Phase 07.17.1.1, D-05, D-07)", async () => {
      const c = new pg.Client({ connectionString: urls.migrator });
      await c.connect();
      try {
        const policies = await c.query(
          "select organization_id, bot_file_max_bytes::text as bot_file_max_bytes from app.work_zone_policies order by organization_id",
        );
        expect(policies.rows).toEqual([{ organization_id: ORG_A, bot_file_max_bytes: "26214400" }]);
        // `bot_work_zone_profiles` is newer than N-1 (none can exist there): its new column is nullable with no default,
        // so a profile stored by N-1 code against this schema reads the organization's limit.
        const cols = await c.query(
          "select table_name, is_nullable, column_default from information_schema.columns where table_schema = 'app' and ((table_name = 'bot_work_zone_profiles' and column_name = 'file_max_bytes') or (table_name = 'work_zone_policies' and column_name = 'bot_file_max_bytes')) order by table_name",
        );
        expect(cols.rows).toEqual([
          { table_name: "bot_work_zone_profiles", is_nullable: "YES", column_default: null },
          { table_name: "work_zone_policies", is_nullable: "NO", column_default: "26214400" },
        ]);
        const empty = await c.query(
          "select (select count(*)::int from app.bot_work_zone_profiles where file_max_bytes is not null) as profile_limits, (select count(*)::int from app.bot_work_session_files) as transfers",
        );
        expect(empty.rows).toEqual([{ profile_limits: 0, transfers: 0 }]);
      } finally {
        await c.end();
      }
    });

    it("starts every policy at 40 turns, 8 hours and 10 running tasks, links no turn or session to a task, opens no task and accepts a task card (Phase 07.17.1.1.2, D-01, D-04, D-05)", async () => {
      const c = new pg.Client({ connectionString: urls.migrator });
      await c.connect();
      try {
        const policies = await c.query(
          "select organization_id, task_max_turns, task_max_hours, max_running_tasks from app.bot_policies order by organization_id",
        );
        expect(policies.rows).toEqual([
          { organization_id: ORG_A, task_max_turns: 40, task_max_hours: 8, max_running_tasks: 10 },
        ]);
        const cols = await c.query(
          "select table_name, is_nullable, column_default from information_schema.columns where table_schema = 'app' and column_name = 'task_id' and table_name in ('agent_turns','bot_work_sessions') order by table_name",
        );
        expect(cols.rows).toEqual([
          { table_name: "agent_turns", is_nullable: "YES", column_default: null },
          { table_name: "bot_work_sessions", is_nullable: "YES", column_default: null },
        ]);
        const empty = await c.query(
          "select (select count(*)::int from app.bot_tasks) as tasks, (select count(*)::int from app.bot_task_processes) as processes, (select count(*)::int from app.agent_turns where task_id is not null) as turns, (select count(*)::int from app.bot_work_sessions where task_id is not null) as sessions",
        );
        expect(empty.rows).toEqual([{ tasks: 0, processes: 0, turns: 0, sessions: 0 }]);
        // The widened kind check takes a platform-owned task card on an existing message (rolled back: the row counts
        // the other cases read stay the dump's).
        const msg = await c.query(
          "select m.id, m.conversation_id from app.messages m where m.organization_id = $1 and not exists (select 1 from app.message_cards k where k.message_id = m.id) order by m.id limit 1",
          [ORG_A],
        );
        expect(msg.rows).toHaveLength(1);
        await c.query("begin");
        try {
          const card = await c.query(
            "insert into app.message_cards (message_id, organization_id, conversation_id, agent_id, kind, title, status, platform_owned) values ($1, $2, $3, $4, 'task', 'Read the knowledge pack', 'running', true)",
            [msg.rows[0].id, ORG_A, msg.rows[0].conversation_id, HELPER_BOT],
          );
          expect(card.rowCount).toBe(1);
        } finally {
          await c.query("rollback");
        }
      } finally {
        await c.end();
      }
      const queues = await pgbossQueues();
      expect(queues).toContain("bot_task.continue");
      expect(queues).toContain("bot_task.tick");
    });

    it("narrows existing sessions to their personal audience and blanks stored org-stream session snapshots (Phase 07.9, D-06, D-13)", async () => {
      const c = new pg.Client({ connectionString: urls.migrator });
      await c.connect();
      try {
        const sessions = await c.query("select id, visibility from app.work_sessions order by id");
        expect(sessions.rows).toEqual([{ id: N1_SESSION, visibility: "project" }]);
        // The org-stream session event keeps its seq and loses its payload; every other event is untouched.
        const events = await c.query(
          "select stream_id, seq::int as seq, type, payload from app.stream_events where stream_id = any($1) order by stream_id, seq",
          [[N1_ORG_STREAM, N1_WS_STREAM]],
        );
        expect(events.rows).toEqual([
          { stream_id: N1_ORG_STREAM, seq: 1, type: "work_session.updated", payload: {} },
          { stream_id: N1_ORG_STREAM, seq: 2, type: "units.updated", payload: N1_UNITS_EVENT },
          { stream_id: N1_WS_STREAM, seq: 1, type: "work_session.updated", payload: N1_SESSION_DTO },
        ]);
        const streams = await c.query(
          "select id, last_seq::int as last_seq from app.streams where id = any($1) order by id",
          [[N1_ORG_STREAM, N1_WS_STREAM]],
        );
        expect(streams.rows).toEqual([
          { id: N1_ORG_STREAM, last_seq: 2 },
          { id: N1_WS_STREAM, last_seq: 1 },
        ]);
        // No team project links the repo: the session is personal. Its creator, the device owner and admins (Ada is
        // all three) see it; Max, a member with no relation to the device, no longer does (the deliberate narrowing).
        expect((await c.query("select count(*)::int as n from app.work_project_repos")).rows[0].n).toBe(0);
      } finally {
        await c.end();
      }
      const db = createTenantDb(urls.app, { max: 1 });
      try {
        const access = (org: string, user: string) =>
          db.withTenant({ organizationId: org }, async (tx) => {
            const r = await tx.execute(`select app.work_session_access('${N1_SESSION}', '${user}') as f`);
            return [...((r.rows[0] as { f: string[] }).f ?? [])].sort();
          });
        expect(await access(ORG_A, ADA_ADMIN)).toEqual(["admin", "creator", "device_owner", "viewer"]);
        expect(await access(ORG_A, MAX_MEMBER)).toEqual([]);
        expect(await access(ORG_B, BEA_ADMIN)).toEqual([]);
        expect(await access(ORG_A, BEA_ADMIN)).toEqual([]);
      } finally {
        await db.close();
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
        // 07.14 D-06: the organization connection table is covered by the same loop, with no code of its own.
        expect(rows.map((r) => r.tbl)).toContain("app.connector_org_connections");
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
        // Ready starts the job runtime as ocw_app (Phase 07.6): a missing or older pgboss schema would reject here.
        await built.app.ready();
        const res = await built.app.inject({ method: "GET", url: "/health" });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ status: "ok", checks: { db: "ok", redis: "ok" } });
      } finally {
        await built.close();
      }
    });
  });
});
