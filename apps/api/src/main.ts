import { checkSchema, describeSchemaMismatch } from "@ocw/db";
import closeWithGrace from "close-with-grace";
import { buildApp } from "./app";
import { EnvError, loadEnv } from "./config/env";

let env: ReturnType<typeof loadEnv>;
try {
  env = loadEnv();
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
await built.app.listen({ host: env.HOST, port: env.PORT });
