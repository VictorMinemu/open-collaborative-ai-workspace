import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { runMigrations } from "./migrate";

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  superuserUrl: string;
  migratorUrl: string;
  appUrl: string;
  authUrl: string;
  stop(): Promise<void>;
}

const PW = { migrator: "migrator-test-pw", app: "app-test-pw", auth: "auth-test-pw" };

/** Anything a test starts that must be stopped (a started container, a test database, a stack). */
export interface Stoppable {
  stop(): Promise<unknown>;
}

/**
 * Starts several containers at once. If any start fails, the ones that did start are stopped before the first failure
 * is rethrown, so a half-built stack never leaks a container (WINDOWS #213: the shared Ryuk reaper only prunes once
 * every process on the host has disconnected from it, which parallel test runs never allow).
 */
export async function startAllOrNone<const T extends readonly Stoppable[]>(
  starts: {
    readonly [K in keyof T]: Promise<T[K]>;
  },
): Promise<T> {
  const settled = await Promise.allSettled(starts as unknown as readonly Promise<Stoppable>[]);
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) {
    await Promise.allSettled(settled.flatMap((r) => (r.status === "fulfilled" ? [r.value.stop()] : [])));
    throw failed.reason;
  }
  return settled.map((r) => (r as PromiseFulfilledResult<Stoppable>).value) as unknown as T;
}

/** Ephemeral postgres:18 with roles bootstrapped and all migrations + post-migrate applied. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer("postgres:18")
    .withDatabase("ocw")
    .withUsername("postgres")
    .withPassword("postgres")
    .start();
  const host = container.getHost();
  const port = container.getPort();
  const url = (user: string, pw: string) => `postgres://${user}:${pw}@${host}:${port}/ocw`;
  const superuserUrl = url("postgres", "postgres");
  const migratorUrl = url("ocw_migrator", PW.migrator);
  try {
    await runMigrations({ superuserUrl, migratorUrl, passwords: PW, log: () => {} });
  } catch (err) {
    // A failed migration (a full disk, a broken migration) never leaves the container running (WINDOWS #213).
    await container.stop().catch(() => {});
    throw err;
  }
  return {
    container,
    superuserUrl,
    migratorUrl,
    appUrl: url("ocw_app", PW.app),
    authUrl: url("ocw_auth", PW.auth),
    stop: async () => {
      await container.stop();
    },
  };
}
