import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * Superuser access for the few e2e steps no API can do (moving an approval's expiry into the past, reading a stored
 * column). It may only ever reach a disposable database:
 *  - the isolated runner's `ocw_e2e` (scripts/e2e-isolated.sh exports MIGRATE_SUPERUSER_URL pointing at it), or
 *  - in CI (Woodpecker or GitHub Actions), the ephemeral compose postgres on loopback, database `ocw`, read from the
 *    environment or the `.env` that `pnpm setup:env` wrote for that run.
 * Everything else is refused, above all the demo's `ocw` database on a developer machine: outside CI the `.env` (the
 * demo's) is never read. The URL carries a password, so no message ever includes it.
 */

type Env = Readonly<Record<string, string | undefined>>;

const ISOLATED_DB = "ocw_e2e";
const CI_DB = "ocw";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * True only on a real CI runner, identified by the runner's own variables (Woodpecker: `CI=woodpecker` or
 * `CI_PIPELINE_NUMBER`; GitHub Actions: `GITHUB_ACTIONS=true`). A bare `CI=true` is not enough, so `CI=true pnpm e2e`
 * on a developer machine can never reach the demo's database.
 */
export function isCi(env: Env): boolean {
  return (
    (env.CI ?? "").trim().toLowerCase() === "woodpecker" ||
    Boolean(env.CI_PIPELINE_NUMBER) ||
    (env.GITHUB_ACTIONS ?? "").trim().toLowerCase() === "true"
  );
}

/** One variable from the repo's `.env`, or undefined. */
export function fromRepoDotEnv(name: string): string | undefined {
  const file = join(import.meta.dirname, "..", "..", ".env");
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${name}=`));
  return line
    ?.slice(name.length + 1)
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2");
}

/**
 * The superuser URL the e2e may use, or throws saying why not (without the URL). `dotEnv` is consulted only in CI.
 */
export function superuserUrl(
  env: Env,
  dotEnv: (name: string) => string | undefined = fromRepoDotEnv,
): string {
  const ci = isCi(env);
  const raw = env.MIGRATE_SUPERUSER_URL || (ci ? dotEnv("MIGRATE_SUPERUSER_URL") : undefined) || "";
  const refuse = (why: string): never => {
    throw new Error(
      `superuser access refused: ${why}. Run through scripts/e2e-isolated.sh (database ${ISOLATED_DB}) or in CI ` +
        `(loopback database ${CI_DB})`,
    );
  };
  if (raw === "") return refuse("MIGRATE_SUPERUSER_URL is not set");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("MIGRATE_SUPERUSER_URL is not a URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return refuse("MIGRATE_SUPERUSER_URL is not a postgres URL");
  }
  const db = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (db === ISOLATED_DB) return raw;
  if (!ci) return refuse(`database "${db}" outside CI`);
  if (db !== CI_DB) return refuse(`database "${db}" in CI`);
  if (!LOOPBACK.has(url.hostname)) return refuse(`CI database on a non-loopback host "${url.hostname}"`);
  return raw;
}

/** Runs one statement as the superuser on the guarded e2e database. */
export async function asSuperuser<T = Record<string, unknown>>(
  sql: string,
  params: unknown[],
): Promise<{ rows: T[]; rowCount: number }> {
  const connectionString = superuserUrl(process.env);
  const requireDb = createRequire(join(import.meta.dirname, "..", "..", "packages", "db", "package.json"));
  const { Client } = requireDb("pg") as {
    Client: new (o: {
      connectionString: string;
    }) => {
      connect(): Promise<void>;
      query(text: string, values: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
      end(): Promise<void>;
    };
  };
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const res = await client.query(sql, params);
    return { rows: res.rows, rowCount: res.rowCount ?? 0 };
  } finally {
    await client.end();
  }
}
