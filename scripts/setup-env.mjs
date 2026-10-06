#!/usr/bin/env node
// Generates a local .env with random secrets for development / self-hosting. Explicit command only
// (`pnpm setup:env`); nothing is ever generated at boot. Refuses to overwrite unless --force.
//   node scripts/setup-env.mjs                 # fresh .env from .env.example with random secrets
//   node scripts/setup-env.mjs --force         # overwrite (rotates EVERY secret)
//   node scripts/setup-env.mjs --add-missing   # existing .env: append only keys it lacks (never rotates)
//   --dir <path>                               # write <path>/.env instead of the repo's (tests)
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const dirIdx = args.indexOf("--dir");
const dir = dirIdx >= 0 ? resolve(args[dirIdx + 1] ?? ".") : root;
const target = join(dir, ".env");
const force = flag("--force");
const addMissing = flag("--add-missing");

const hex = (n) => randomBytes(n).toString("hex");
const values = {
  POSTGRES_PASSWORD: hex(24),
  OCW_DB_MIGRATOR_PASSWORD: hex(24),
  OCW_DB_APP_PASSWORD: hex(24),
  OCW_DB_AUTH_PASSWORD: hex(24),
  BETTER_AUTH_SECRET: hex(32),
  OCW_SETUP_TOKEN: hex(16),
  OCW_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  OCW_CELL_TOKEN: `ocw_cell_${randomBytes(32).toString("base64url")}`,
  // Object storage (Garage, ADR-0015): RPC secret 32 bytes of hex, access key id `GK` + 12 bytes of hex, secret
  // 32 bytes of hex (Garage's formats). The same key pair is Garage's default key and the API's credentials.
  GARAGE_RPC_SECRET: hex(32),
  OCW_S3_ACCESS_KEY_ID: `GK${hex(12)}`,
  OCW_S3_SECRET_ACCESS_KEY: hex(32),
};
/** Never appended by --add-missing: a fresh value would not match the existing database or its URLs. */
const DB_PASSWORDS = [
  "POSTGRES_PASSWORD",
  "OCW_DB_MIGRATOR_PASSWORD",
  "OCW_DB_APP_PASSWORD",
  "OCW_DB_AUTH_PASSWORD",
];
const placeholder = (name) => ["$", "{", name, "}"].join("");

/** The full generated .env text: the template with every generated value filled in. */
function render() {
  let text = readFileSync(join(root, ".env.example"), "utf8");
  for (const [k, v] of Object.entries(values)) {
    const line = new RegExp(`^${k}=.*$`, "m");
    if (line.test(text)) text = text.replace(line, `${k}=${v}`);
    else text = `${text.replace(/\n*$/, "\n")}${k}=${v}\n`; // a fresh .env always gets every generated key
  }
  // Local-dev URLs embed the generated role passwords.
  for (const name of DB_PASSWORDS) text = text.replaceAll(placeholder(name), values[name]);
  return text;
}

const keyOf = (line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1] ?? null;

if (addMissing) {
  if (!existsSync(target)) {
    console.error(`${target} does not exist; run without --add-missing to create it.`);
    process.exit(1);
  }
  const current = readFileSync(target, "utf8");
  const have = new Set(current.split("\n").map(keyOf).filter(Boolean));
  const template = readFileSync(join(root, ".env.example"), "utf8");
  // Lines that embed a database password stay as they are: the database already has its passwords.
  const dependsOnDb = new Set(
    template
      .split("\n")
      .filter((l) => DB_PASSWORDS.some((n) => l.includes(placeholder(n))))
      .map(keyOf)
      .filter(Boolean),
  );
  const added = [];
  for (const line of render().split("\n")) {
    const key = keyOf(line);
    if (!key || have.has(key) || DB_PASSWORDS.includes(key) || dependsOnDb.has(key)) continue;
    have.add(key);
    added.push(line);
  }
  if (added.length === 0) {
    console.log(`${target} already has every key.`);
    process.exit(0);
  }
  const lead = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  appendFileSync(target, `${lead}\n# Added by pnpm setup:env --add-missing\n${added.join("\n")}\n`);
  console.log(`Appended ${added.length} missing key(s) to ${target}: ${added.map(keyOf).join(", ")}`);
  process.exit(0);
}

if (existsSync(target) && !force) {
  console.error(
    ".env already exists. Re-run with --add-missing to append new keys (keeps every value), or --force to overwrite (this rotates every secret).",
  );
  process.exit(1);
}

writeFileSync(target, render(), { mode: 0o600 });
console.log(`Wrote ${target}`);
console.log(`Setup token (paste it on /setup): ${values.OCW_SETUP_TOKEN}`);
if (force) {
  // The JWT signing keys in auth.jwks are encrypted with BETTER_AUTH_SECRET (docs/adr/0008).
  console.log(
    "BETTER_AUTH_SECRET was rotated: delete the auth.jwks rows of an existing database and restart",
  );
  console.log("the API (outstanding JWTs become invalid; clients fetch new ones).");
  // Verified on v2.4.1: --default-bucket creates the new default key on the next start and grants it the bucket.
  console.log("OCW_S3_* keys were rotated too: restart garage and api (docker compose up -d) to apply them.");
}
// OCW_ACCEPT_LEGACY_DEVICE_TOKEN (default true, see .env.example) keeps pre-Phase-2 desktop apps connecting
// with their raw device token; set it to false once every desktop app is rebuilt (docs/DEMO.md).
