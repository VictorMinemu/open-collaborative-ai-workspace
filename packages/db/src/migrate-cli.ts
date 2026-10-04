import { readEnvOrFile } from "./env";
import { runMigrations } from "./migrate";

function required(name: string): string {
  const v = readEnvOrFile(name);
  if (!v) {
    console.error(`migrate: missing required env ${name} (or ${name}_FILE). See .env.example.`);
    process.exit(1);
  }
  return v;
}

const superuserUrl = readEnvOrFile("MIGRATE_SUPERUSER_URL");
await runMigrations({
  migratorUrl: required("MIGRATOR_DATABASE_URL"),
  ...(superuserUrl
    ? {
        superuserUrl,
        passwords: {
          migrator: required("OCW_DB_MIGRATOR_PASSWORD"),
          app: required("OCW_DB_APP_PASSWORD"),
          auth: required("OCW_DB_AUTH_PASSWORD"),
        },
      }
    : {}),
}).catch((err: unknown) => {
  console.error("migrate failed:", err);
  process.exit(1);
});
