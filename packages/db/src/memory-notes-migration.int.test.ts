import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "./migrate";
import { startTestDatabase, type TestDatabase } from "./testing";

/**
 * D-02 / D-08 / MEM-07 / T-07.2-02-05: the per-(bot, human) notes of `app.agent_memories` become that human's personal
 * `MEMORY.md` with that bot (`origin = legacy_notes`, owner set, revision 1 by `system`), idempotently, without ever
 * touching `agent_memories`; the documented rollback, executed here verbatim, removes exactly the untouched backfilled
 * scopes. Runs the exact SQL of the migration folder against notes seeded on a fresh ephemeral PostgreSQL (every
 * migration and post-migrate applied, so the owner triggers are live too), as the superuser like the migrator would.
 */

let tdb: TestDatabase;
let su: pg.Client;
const notices: string[] = [];

function migrationDir(suffix: string): string {
  const dirs = readdirSync(MIGRATIONS_DIR).filter((d) => d.endsWith(suffix));
  expect(dirs, `exactly one *${suffix} migration`).toHaveLength(1);
  return dirs[0] as string;
}

function migrationSql(suffix: string): string {
  return readFileSync(join(MIGRATIONS_DIR, migrationDir(suffix), "migration.sql"), "utf8");
}

/**
 * The rollback exactly as the migration header documents it: the first run of `--   ` indented comment lines after
 * the `-- Rollback:` line.
 */
function rollbackSql(sql: string): string {
  const lines = sql.split("\n");
  const start = lines.findIndex((l) => l.startsWith("-- Rollback:"));
  expect(start, "the migration header documents its rollback").toBeGreaterThanOrEqual(0);
  const first = lines.findIndex((l, i) => i > start && l.startsWith("--   "));
  const body: string[] = [];
  for (const line of lines.slice(first)) {
    if (!line.startsWith("--   ")) break;
    body.push(line.slice(5));
  }
  expect(first > start && body.length > 0, "the rollback block follows the header line").toBe(true);
  return body.join("\n");
}

/** The backfill statements (drizzle splits on its breakpoint marker; so do we). */
function backfillStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.replace(/^--.*$/gm, "").trim() !== "");
}

async function runBackfill(): Promise<void> {
  for (const stmt of backfillStatements(migrationSql("_memory_notes_backfill"))) await su.query(stmt);
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  su = new pg.Client({ connectionString: tdb.superuserUrl });
  await su.connect();
  su.on("notice", (n) => notices.push(n.message ?? ""));
});

afterAll(async () => {
  await su?.end();
  await tdb?.stop();
});

interface Fixture {
  org: string;
  u1: string;
  u2: string;
  teamBot: string;
  personalBot: string;
  otherBot: string;
  unit: string;
}

async function seed(): Promise<Fixture> {
  const org = randomUUID();
  const f: Fixture = {
    org,
    u1: randomUUID(),
    u2: randomUUID(),
    teamBot: randomUUID(),
    personalBot: randomUUID(),
    otherBot: randomUUID(),
    unit: randomUUID(),
  };
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Acme', $2)", [
    org,
    `acme-${org}`,
  ]);
  for (const u of [f.u1, f.u2]) {
    await su.query("insert into auth.user (id, name, email) values ($1, 'U', $2)", [u, `${u}@example.test`]);
  }
  const bot = (id: string, scope: string, owner: string | null) =>
    su.query(
      "insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, scope, owner_user_id) values ($1, $2, 'Bot', $3, 'x', 'mock', 'mock-1', $4, $5)",
      [id, org, `bot-${id.slice(0, 8)}`, scope, owner],
    );
  await bot(f.teamBot, "team", null);
  await bot(f.personalBot, "personal", f.u1);
  await bot(f.otherBot, "team", null);
  await su.query(
    "insert into app.org_units (id, organization_id, kind, name, path) values ($1, $2, 'team', 'Ops', ARRAY[$1]::uuid[])",
    [f.unit, org],
  );
  return f;
}

async function note(f: Fixture, agent: string, user: string, text: string, at: string): Promise<void> {
  await su.query(
    "insert into app.agent_memories (organization_id, agent_id, user_id, text, created_at) values ($1, $2, $3, $4, $5)",
    [f.org, agent, user, text, at],
  );
}

/** Row count and an ordered checksum of `agent_memories`: must never change. */
async function legacySnapshot() {
  return (
    await su.query(
      "select count(*)::int as n, md5(coalesce(string_agg(id::text || text, ',' order by id), '')) as sum from app.agent_memories",
    )
  ).rows[0];
}

async function scopeOf(f: Fixture, agent: string, user: string) {
  return (
    await su.query(
      "select id, origin, personal_owner_user_id from app.memory_scopes where organization_id = $1 and kind = 'personal' and agent_id = $2 and owner_user_id = $3",
      [f.org, agent, user],
    )
  ).rows;
}

async function filesOf(scopeId: string) {
  return (
    await su.query(
      "select id, path, content, version, bytes, updated_by_kind, personal_owner_user_id, deleted_at from app.memory_files where scope_id = $1 order by path",
      [scopeId],
    )
  ).rows;
}

async function revisionsOf(scopeId: string) {
  return (
    await su.query(
      "select version, op, path, content, lines_added, lines_removed, author_kind, author_id, personal_owner_user_id from app.memory_file_revisions where scope_id = $1 order by version",
      [scopeId],
    )
  ).rows;
}

async function memoryCounts(org: string) {
  const n = async (tbl: string) =>
    (await su.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [org])).rows[0].n;
  return {
    scopes: await n("app.memory_scopes"),
    files: await n("app.memory_files"),
    revisions: await n("app.memory_file_revisions"),
  };
}

describe("memory_notes_backfill data migration", () => {
  it("sorts right after the memory_files schema migration and never alters the legacy notes table", () => {
    const dirs = readdirSync(MIGRATIONS_DIR).sort();
    const schema = dirs.indexOf(migrationDir("_memory_files"));
    const backfill = dirs.indexOf(migrationDir("_memory_notes_backfill"));
    expect(schema).toBeGreaterThanOrEqual(0);
    expect(backfill).toBe(schema + 1);
    const code = migrationSql("_memory_notes_backfill").replace(/^--.*$/gm, "");
    // agent_memories is only read: never dropped, altered, updated, deleted from or truncated (D-02).
    expect(code).toMatch(/from app\.agent_memories/);
    expect(code).not.toMatch(/(drop|alter|truncate)\s+table/i);
    expect(code).not.toMatch(/(update|delete\s+from|insert\s+into)\s+app\.agent_memories/i);
  });

  it("turns each (bot, human) pair's notes into that human's MEMORY.md, idempotently, and rolls back only untouched scopes", async () => {
    const backfill = migrationSql("_memory_notes_backfill");
    const rollback = rollbackSql(backfill);
    expect(rollback).toMatch(/^DO \$rollback\$/);

    await su.query("begin");
    try {
      const f = await seed();
      // Inserted out of order on purpose: the file lists notes by created_at, then id.
      await note(f, f.teamBot, f.u1, "Prefers metric units", "2026-09-02T10:00:00Z");
      await note(f, f.teamBot, f.u1, "Works on the billing team", "2026-09-01T10:00:00Z");
      await note(f, f.teamBot, f.u1, "Birthday on 3 May\n  (do not announce it)", "2026-09-03T10:00:00Z");
      await note(f, f.teamBot, f.u2, "Speaks Spanish", "2026-09-01T11:00:00Z");
      await note(f, f.personalBot, f.u1, "Drinks tea", "2026-09-04T10:00:00Z");
      const legacy = await legacySnapshot();
      expect(legacy.n).toBe(5);

      await runBackfill();

      const pairs = [
        [f.teamBot, f.u1],
        [f.teamBot, f.u2],
        [f.personalBot, f.u1],
      ] as const;
      for (const [agent, user] of pairs) {
        const scopes = await scopeOf(f, agent, user);
        expect(scopes, `${agent}/${user}`).toHaveLength(1);
        expect(scopes[0]).toMatchObject({ origin: "legacy_notes", personal_owner_user_id: user });
      }
      const [u1Scope] = await scopeOf(f, f.teamBot, f.u1);
      const content =
        "# Memory\n\n- Works on the billing team\n- Prefers metric units\n- Birthday on 3 May (do not announce it)\n";
      expect(await filesOf(u1Scope.id)).toEqual([
        {
          id: expect.any(String),
          path: "MEMORY.md",
          content,
          version: 1,
          bytes: Buffer.byteLength(content),
          updated_by_kind: "system",
          personal_owner_user_id: f.u1,
          deleted_at: null,
        },
      ]);
      expect(await revisionsOf(u1Scope.id)).toEqual([
        {
          version: 1,
          op: "create",
          path: "MEMORY.md",
          content,
          lines_added: 5,
          lines_removed: 0,
          author_kind: "system",
          author_id: null,
          personal_owner_user_id: f.u1,
        },
      ]);
      const [u2Scope] = await scopeOf(f, f.teamBot, f.u2);
      expect((await filesOf(u2Scope.id))[0].content).toBe("# Memory\n\n- Speaks Spanish\n");
      expect(await memoryCounts(f.org)).toEqual({ scopes: 3, files: 3, revisions: 3 });

      // Idempotent: a second run creates nothing and changes nothing.
      const firstFiles = await filesOf(u1Scope.id);
      await runBackfill();
      expect(await memoryCounts(f.org)).toEqual({ scopes: 3, files: 3, revisions: 3 });
      expect(await filesOf(u1Scope.id)).toEqual(firstFiles);
      expect(await legacySnapshot()).toEqual(legacy);

      // After the upgrade: an app-origin personal scope and a unit scope that the rollback must never touch, and the
      // owner's edit of one backfilled file (version 2) that the rollback must keep.
      const appScope = (
        await su.query(
          "insert into app.memory_scopes (organization_id, kind, agent_id, owner_user_id) values ($1, 'personal', $2, $3) returning id",
          [f.org, f.otherBot, f.u2],
        )
      ).rows[0].id as string;
      const appFile = (
        await su.query(
          "insert into app.memory_files (organization_id, scope_id, path, content, bytes, updated_by_kind, updated_by_id) values ($1, $2, 'MEMORY.md', '# Memory\n', 9, 'user', $3) returning id",
          [f.org, appScope, f.u2],
        )
      ).rows[0].id as string;
      await su.query(
        "insert into app.memory_file_revisions (organization_id, file_id, scope_id, version, op, path, content, author_kind, author_id) values ($1, $2, $3, 1, 'create', 'MEMORY.md', '# Memory\n', 'user', $4)",
        [f.org, appFile, appScope, f.u2],
      );
      const unitScope = (
        await su.query(
          "insert into app.memory_scopes (organization_id, kind, unit_id) values ($1, 'unit', $2) returning id",
          [f.org, f.unit],
        )
      ).rows[0].id as string;
      const [editedScope] = await scopeOf(f, f.personalBot, f.u1);
      const [editedFile] = await filesOf(editedScope.id);
      const edited = `${editedFile.content}- Moved to Lisbon\n`;
      await su.query(
        "update app.memory_files set content = $2, bytes = octet_length($2), version = 2, updated_by_kind = 'user', updated_by_id = $3 where id = $1",
        [editedFile.id, edited, f.u1],
      );
      await su.query(
        "insert into app.memory_file_revisions (organization_id, file_id, scope_id, version, op, path, content, lines_added, author_kind, author_id) values ($1, $2, $3, 2, 'append', 'MEMORY.md', $4, 1, 'user', $5)",
        [f.org, editedFile.id, editedScope.id, edited, f.u1],
      );
      const beforeRollback = { app: await filesOf(appScope), unit: unitScope };

      notices.length = 0;
      await su.query(rollback);
      expect(
        notices.some((n) => /kept 1 edited/.test(n)),
        notices.join(" | "),
      ).toBe(true);

      // The two untouched backfilled scopes are gone with their files and revisions…
      expect(await scopeOf(f, f.teamBot, f.u1)).toEqual([]);
      expect(await scopeOf(f, f.teamBot, f.u2)).toEqual([]);
      for (const gone of [u1Scope.id, u2Scope.id]) {
        expect(await filesOf(gone)).toEqual([]);
        expect(await revisionsOf(gone)).toEqual([]);
      }
      // …the edited one is kept at version 2, and nothing created by the app is touched.
      expect(await scopeOf(f, f.personalBot, f.u1)).toEqual([editedScope]);
      expect((await filesOf(editedScope.id))[0]).toMatchObject({ version: 2, content: edited });
      expect(await revisionsOf(editedScope.id)).toHaveLength(2);
      expect(await filesOf(appScope)).toEqual(beforeRollback.app);
      expect(
        (await su.query("select id from app.memory_scopes where id = $1", [beforeRollback.unit])).rows,
      ).toHaveLength(1);
      expect(await legacySnapshot()).toEqual(legacy);
      expect(await memoryCounts(f.org)).toEqual({ scopes: 3, files: 2, revisions: 3 });

      // Re-applying the backfill recreates exactly the two removed scopes and nothing else.
      await runBackfill();
      expect(await memoryCounts(f.org)).toEqual({ scopes: 5, files: 4, revisions: 5 });
      const [again] = await scopeOf(f, f.teamBot, f.u1);
      expect((await filesOf(again.id))[0].content).toBe(content);
      expect(await scopeOf(f, f.teamBot, f.u2)).toHaveLength(1);
      expect((await filesOf(editedScope.id))[0]).toMatchObject({ version: 2, content: edited });
      expect(await legacySnapshot()).toEqual(legacy);
    } finally {
      await su.query("rollback");
    }
  });

  it("leaves a pair whose personal scope already exists untouched (no duplicate, no overwrite)", async () => {
    await su.query("begin");
    try {
      const f = await seed();
      const existing = (
        await su.query(
          "insert into app.memory_scopes (organization_id, kind, agent_id, owner_user_id) values ($1, 'personal', $2, $3) returning id",
          [f.org, f.teamBot, f.u1],
        )
      ).rows[0].id as string;
      await su.query(
        "insert into app.memory_files (organization_id, scope_id, path, content, bytes, updated_by_kind) values ($1, $2, 'MEMORY.md', '# Mine\n', 7, 'user')",
        [f.org, existing],
      );
      const before = await filesOf(existing);
      await note(f, f.teamBot, f.u1, "Likes tea", "2026-09-01T10:00:00Z");
      await note(f, f.teamBot, f.u2, "Likes coffee", "2026-09-01T10:00:00Z");

      await runBackfill();

      expect(await scopeOf(f, f.teamBot, f.u1)).toEqual([
        { id: existing, origin: "app", personal_owner_user_id: f.u1 },
      ]);
      expect(await filesOf(existing)).toEqual(before);
      expect(await revisionsOf(existing)).toEqual([]);
      // The other human's notes still migrate.
      const [u2] = await scopeOf(f, f.teamBot, f.u2);
      expect((await filesOf(u2.id))[0].content).toBe("# Memory\n\n- Likes coffee\n");
    } finally {
      await su.query("rollback");
    }
  });
});
