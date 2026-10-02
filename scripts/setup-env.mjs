#!/usr/bin/env node
// Generates a local .env with random secrets for development / self-hosting. Explicit command only
// (`pnpm setup:env`); nothing is ever generated at boot. Refuses to overwrite unless --force.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, ".env");
const force = process.argv.includes("--force");
if (existsSync(target) && !force) {
  console.error(".env already exists. Re-run with --force to overwrite (this rotates every secret).");
  process.exit(1);
}

const hex = (n) => randomBytes(n).toString("hex");
const values = {
  POSTGRES_PASSWORD: hex(24),
  OCW_DB_MIGRATOR_PASSWORD: hex(24),
  OCW_DB_APP_PASSWORD: hex(24),
  OCW_DB_AUTH_PASSWORD: hex(24),
  BETTER_AUTH_SECRET: hex(32),
  OCW_SETUP_TOKEN: hex(16),
  OCW_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

let text = readFileSync(join(root, ".env.example"), "utf8");
for (const [k, v] of Object.entries(values)) {
  text = text.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`);
}
// Local-dev URLs embed the generated role passwords.
const placeholder = (name) => ["$", "{", name, "}"].join("");
text = text.replaceAll(placeholder("OCW_DB_APP_PASSWORD"), values.OCW_DB_APP_PASSWORD);
text = text.replaceAll(placeholder("OCW_DB_AUTH_PASSWORD"), values.OCW_DB_AUTH_PASSWORD);
text = text.replaceAll(placeholder("OCW_DB_MIGRATOR_PASSWORD"), values.OCW_DB_MIGRATOR_PASSWORD);
text = text.replaceAll(placeholder("POSTGRES_PASSWORD"), values.POSTGRES_PASSWORD);
writeFileSync(target, text, { mode: 0o600 });
console.log(`Wrote ${target}`);
console.log(`Setup token (paste it on /setup): ${values.OCW_SETUP_TOKEN}`);
