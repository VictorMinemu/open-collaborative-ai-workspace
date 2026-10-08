import { readMigrationFiles } from "drizzle-orm/migrator";
import pg from "pg";
import { MIGRATIONS_DIR } from "./migrate";

/**
 * Schema-version guard (SELF-03, D-06, D-18). Compares the migrations this build ships (folder names + sha256 of each
 * `migration.sql`, exactly what drizzle records) with `drizzle.__drizzle_migrations`, read as `ocw_app` through the
 * SELECT-only grant in post-migrate.sql. The API calls it at boot and refuses to start on any mismatch.
 */

export type SchemaStatus = "ok" | "behind" | "ahead" | "diverged" | "missing";

export interface SchemaCheck {
  status: SchemaStatus;
  /** Shipped migrations the database has not applied, oldest first. */
  pending: string[];
  /** Applied migrations this build does not ship (a newer release ran them). */
  unknown: string[];
  /** Migrations applied under the same name with a different hash. */
  modified: string[];
}

export interface MigrationEntry {
  name: string;
  hash: string;
}

/**
 * Severity order when several apply: diverged (history rewritten) > ahead (newer release; migrating with this one would
 * not help) > missing (nothing applied) > behind.
 */
export function compareMigrations(local: MigrationEntry[], applied: MigrationEntry[]): SchemaCheck {
  const localByName = new Map(local.map((m) => [m.name, m.hash]));
  const appliedByName = new Map(applied.map((m) => [m.name, m.hash]));
  const pending = local.filter((m) => !appliedByName.has(m.name)).map((m) => m.name);
  const unknown = applied.filter((m) => !localByName.has(m.name)).map((m) => m.name);
  const modified = applied
    .filter((m) => localByName.has(m.name) && localByName.get(m.name) !== m.hash)
    .map((m) => m.name);
  const status: SchemaStatus =
    modified.length > 0
      ? "diverged"
      : unknown.length > 0
        ? "ahead"
        : applied.length === 0
          ? "missing"
          : pending.length > 0
            ? "behind"
            : "ok";
  return { status, pending, unknown, modified };
}

export function localMigrations(migrationsDir: string = MIGRATIONS_DIR): MigrationEntry[] {
  return readMigrationFiles({ migrationsFolder: migrationsDir }).map((m) => ({ name: m.name, hash: m.hash }));
}

// undefined_table, invalid_schema_name, insufficient_privilege: the table is absent or ocw_app cannot read it.
const MISSING_CODES = new Set(["42P01", "3F000", "42501"]);

export async function checkSchema(
  databaseUrl: string,
  migrationsDir: string = MIGRATIONS_DIR,
): Promise<SchemaCheck> {
  const local = localMigrations(migrationsDir);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<MigrationEntry>(
      "select name, hash from drizzle.__drizzle_migrations order by id",
    );
    return compareMigrations(local, rows);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && MISSING_CODES.has(code)) {
      return { status: "missing", pending: local.map((m) => m.name), unknown: [], modified: [] };
    }
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}

const MIGRATE_HINT = "Run: docker compose run --rm migrate (from a source checkout: pnpm db:migrate)";

export function describeSchemaMismatch(c: SchemaCheck): string {
  switch (c.status) {
    case "ok":
      return "Database schema is up to date.";
    case "behind":
      return `Database schema is behind this API (${c.pending.length} pending, newest ${c.pending.at(-1)}). ${MIGRATE_HINT}`;
    case "ahead":
      return `Database was migrated by a newer release (unknown: ${c.unknown.join(", ")}). Restore a backup or run the newer image.`;
    case "diverged":
      return `Migration ${c.modified.join(", ")} was modified after it was applied. Restore a backup or run the image that applied it; never edit an applied migration.`;
    case "missing":
      return `Database has never been migrated (or ocw_app cannot read drizzle.__drizzle_migrations). ${MIGRATE_HINT}`;
  }
}
