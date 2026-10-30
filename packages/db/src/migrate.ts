import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { installJobSchema } from "./jobs-schema";

export { installJobSchema, JOB_QUEUE_NAMES, JOB_SCHEMA, type JobQueueName } from "./jobs-schema";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, "..", "drizzle");
const SQL_DIR = join(here, "..", "sql");

export interface MigrateOptions {
  /** Superuser URL; when present the idempotent role bootstrap runs first. */
  superuserUrl?: string;
  /** Connection URL for ocw_migrator. */
  migratorUrl: string;
  passwords?: { migrator: string; app: string; auth: string };
  log?: (msg: string) => void;
}

export async function bootstrapRoles(
  superuserUrl: string,
  passwords: { migrator: string; app: string; auth: string },
) {
  const client = new pg.Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    await client.query("begin");
    await client.query(
      "select set_config('ocw.migrator_password', $1, true), set_config('ocw.app_password', $2, true), set_config('ocw.auth_password', $3, true)",
      [passwords.migrator, passwords.app, passwords.auth],
    );
    await client.query(readFileSync(join(SQL_DIR, "bootstrap.sql"), "utf8"));
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

export async function runMigrations(opts: MigrateOptions): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(m));
  if (opts.superuserUrl) {
    if (!opts.passwords) throw new Error("role passwords are required when bootstrapping roles");
    log("bootstrap: roles");
    await bootstrapRoles(opts.superuserUrl, opts.passwords);
  }
  const pool = new pg.Pool({ connectionString: opts.migratorUrl, max: 1 });
  try {
    log("migrate: drizzle migrations");
    const result = await migrate(drizzle({ client: pool }), { migrationsFolder: MIGRATIONS_DIR });
    if (result && typeof result === "object" && "exitCode" in result) {
      throw new Error(`migrations failed: ${JSON.stringify(result)}`);
    }
    log("migrate: post-migrate (FORCE RLS, policies, grants)");
    await pool.query(readFileSync(join(SQL_DIR, "post-migrate.sql"), "utf8"));
  } finally {
    await pool.end();
  }
  // Phase 07.6 (D-07): pg-boss is installed and upgraded by this role only; the API runs it with migrate:false.
  await installJobSchema(opts.migratorUrl, log);
  log("migrate: done");
}
