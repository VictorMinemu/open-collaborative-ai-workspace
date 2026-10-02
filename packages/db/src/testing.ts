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
  await runMigrations({ superuserUrl, migratorUrl, passwords: PW, log: () => {} });
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
