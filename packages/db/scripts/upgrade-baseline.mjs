#!/usr/bin/env node
// Regenerates the N-1 upgrade baseline (SELF-03, D-06, D-18; plan 07-02):
//
//   pnpm --filter @ocw/db upgrade:baseline <git-ref> [--out FILE] [--seed FILE]
//
// 1. `git archive <ref> packages/db/drizzle packages/db/sql` into a temp dir (the migrations and SQL of that release),
// 2. a fresh, throwaway `postgres:18` testcontainer (removed at the end, never the dev or demo database),
// 3. role bootstrap + that release's migrations + its post-migrate step,
// 4. the synthetic seed (`test/upgrade/seed-phase-5.sql`) as ocw_migrator,
// 5. `pg_dump` plain format as ocw_migrator of the whole database (never `-n`: that drops the extensions), with a
//    fixed `--restrict-key` so regenerating an unchanged baseline yields the same file.
//
// The dump may contain psql meta-commands (`\restrict`), so it is loaded only with psql, never through node-pg.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = resolve(PKG_DIR, "..", "..");
// Test-only role passwords for the throwaway container; the dump never contains them (roles are not dumped).
const PW = { migrator: "baseline-migrator-pw", app: "baseline-app-pw", auth: "baseline-auth-pw" };
const RESTRICT_KEY = "ocwupgradebaseline";

function parseArgs(argv) {
  const args = { ref: undefined, out: undefined, seed: join(PKG_DIR, "test", "upgrade", "seed-phase-5.sql") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = resolve(argv[++i]);
    else if (a === "--seed") args.seed = resolve(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
    else if (!args.ref) args.ref = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.ref) {
  console.error("usage: pnpm --filter @ocw/db upgrade:baseline <git-ref> [--out FILE] [--seed FILE]");
  process.exit(args.help ? 0 : 2);
}
const ref = args.ref;
if (!/^[\w./-]+$/.test(ref)) throw new Error(`refusing an unusual git ref: ${ref}`);
const sha = execFileSync("git", ["rev-parse", "--short", `${ref}^{commit}`], {
  cwd: REPO_DIR,
  encoding: "utf8",
}).trim();
const out = args.out ?? join(PKG_DIR, "test", "upgrade", `phase-5-${sha}.sql`);

const work = mkdtempSync(join(tmpdir(), "ocw-upgrade-baseline-"));
let container;
try {
  const tar = execFileSync(
    "git",
    ["archive", "--format=tar", sha, "packages/db/drizzle", "packages/db/sql"],
    {
      cwd: REPO_DIR,
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  execFileSync("tar", ["-x", "-C", work], { input: tar });
  const migrationsFolder = join(work, "packages", "db", "drizzle");
  const sqlDir = join(work, "packages", "db", "sql");

  console.error(`baseline: starting a throwaway postgres:18 for ${sha}`);
  container = await new PostgreSqlContainer("postgres:18")
    .withDatabase("ocw")
    .withUsername("postgres")
    .withPassword("postgres")
    .start();
  const url = (user, pw) => `postgres://${user}:${pw}@${container.getHost()}:${container.getPort()}/ocw`;

  const su = new pg.Client({ connectionString: url("postgres", "postgres") });
  await su.connect();
  try {
    await su.query("begin");
    await su.query(
      "select set_config('ocw.migrator_password', $1, true), set_config('ocw.app_password', $2, true), set_config('ocw.auth_password', $3, true)",
      [PW.migrator, PW.app, PW.auth],
    );
    await su.query(readFileSync(join(sqlDir, "bootstrap.sql"), "utf8"));
    await su.query("commit");
  } finally {
    await su.end();
  }

  console.error(`baseline: migrations of ${sha} + post-migrate + seed (${relative(REPO_DIR, args.seed)})`);
  const pool = new pg.Pool({ connectionString: url("ocw_migrator", PW.migrator), max: 1 });
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder });
    await pool.query(readFileSync(join(sqlDir, "post-migrate.sql"), "utf8"));
    // Deterministic bookkeeping: applied_at = the migration's own folder timestamp instead of now().
    await pool.query(
      "update drizzle.__drizzle_migrations set applied_at = to_timestamp(created_at / 1000.0)",
    );
    await pool.query(readFileSync(args.seed, "utf8"));
  } finally {
    await pool.end();
  }

  console.error("baseline: pg_dump (plain, whole database, as ocw_migrator)");
  const dump = await container.exec(
    ["pg_dump", "-U", "ocw_migrator", "-d", "ocw", "-Fp", "--restrict-key", RESTRICT_KEY],
    { env: { PGPASSWORD: PW.migrator } },
  );
  if (dump.exitCode !== 0) throw new Error(`pg_dump failed (${dump.exitCode}): ${dump.stderr}`);
  const header = [
    `-- OCW upgrade baseline (N-1): schema + synthetic data at git ref ${sha} (${ref}).`,
    `-- Regenerate: pnpm --filter @ocw/db upgrade:baseline ${ref}`,
    "-- Synthetic data only (packages/db/test/upgrade/seed-phase-5.sql); fixed test keys; no real person, token or path.",
    "-- Plain pg_dump as ocw_migrator; load with psql as ocw_migrator after the role bootstrap (apps/api/src/upgrade.int.test.ts).",
    "",
  ].join("\n");
  writeFileSync(out, header + dump.stdout);
  console.error(
    `baseline: wrote ${relative(REPO_DIR, out)} (${Buffer.byteLength(header + dump.stdout)} bytes)`,
  );
} finally {
  await container?.stop().catch(() => {});
  rmSync(work, { recursive: true, force: true });
}
