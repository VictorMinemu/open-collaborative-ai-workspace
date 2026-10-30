import { checkSchema, describeSchemaMismatch } from "@ocw/db";
import closeWithGrace from "close-with-grace";
import { buildApp } from "./app";
import { type Env, EnvError, loadConfig } from "./config/env";
import { JobsSchemaError } from "./lib/jobs";

// Configuration first (SELF-02): env/file secrets, plus openbao:// references resolved from OpenBao when present.
let env: Env;
try {
  env = await loadConfig();
} catch (err) {
  if (err instanceof EnvError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

// Schema-version guard (SELF-03): never serve against a database migrated by another release, or not at all.
const schema = await checkSchema(env.DATABASE_URL);
if (schema.status !== "ok") {
  console.error(describeSchemaMismatch(schema));
  process.exit(1);
}

const built = await buildApp(env);
closeWithGrace({ delay: 10_000 }, async ({ err }) => {
  if (err) built.app.log.error({ err }, "shutting down after error");
  await built.close();
});
try {
  await built.app.listen({ host: env.HOST, port: env.PORT });
} catch (err) {
  // Phase 07.6 (Pitfall 10): pg-boss's schema is the migrate service's, like the drizzle schema above.
  if (err instanceof JobsSchemaError) {
    console.error(err.message);
    await built.close().catch(() => {});
    process.exit(1);
  }
  throw err;
}
