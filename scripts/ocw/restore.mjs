#!/usr/bin/env node
// Restore a backup made by `ocw backup` (DESTRUCTIVE: replaces the database, the objects and the cell state).
//   pnpm ocw restore DIR --yes [--env-file F | --dir D]
// Checks every checksum and refuses a backup made by a newer release before changing anything. Then: stop api, web
// and openclaw → start postgres, redis, garage → migrate (roles) → drop schemas app, auth, drizzle, pgboss (07.6's job
// queue, which migrate just installed) and pg_restore in one transaction as ocw_migrator → migrate (upgrades an older
// backup, re-installs pgboss when the backup predates it, re-applies grants and policies) → objects → cell state →
// [vault profile: secrets/ seal key and recovery material, then OpenBao's volume, then OpenBao] → start everything.
// Uses the current .env (keys, passwords, AppRole credentials); the backup never carries it.
// docs/self-hosting/backup-restore.md
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  asMigrator,
  CELL_STATE,
  CELL_STATE_DIR,
  composeRunner,
  DB_DUMP,
  FORMAT,
  hostUser,
  KNOWN_FILES,
  MANIFEST,
  MIGRATOR,
  must,
  OBJECTS_INDEX,
  OPENBAO,
  OPENBAO_DATA_DIR,
  OPENBAO_INIT,
  OPENBAO_STATE,
  SEAL_KEY,
  sha256File,
  vaultEnabled,
  vaultFiles,
  WRITERS,
} from "./backup.mjs";
import { composeArgs, parseArgs, REPO_ROOT, readEnv, resolveEnvFile, usageError } from "./env-file.mjs";

const SPEC = { boolean: ["yes", "help"], string: ["env-file", "dir"] };
const OBJECT_FILE = /^objects\/[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{64}$/;

/** Migration folder names of this checkout (what `migrate` would apply), sorted. */
export function localMigrations(projectDir = REPO_ROOT) {
  const dir = path.join(projectDir, "packages", "db", "drizzle");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Everything that must hold before a restore changes anything: a known format, only known files, every checksum
 * (each object against objects.json too) and no migration this checkout does not have. Returns the manifest.
 */
export async function verifyBackup(dir, { migrations }) {
  const manifestFile = path.join(dir, MANIFEST);
  if (!existsSync(manifestFile)) throw new Error(`${dir} has no ${MANIFEST}: not a complete ocw backup`);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (manifest?.format !== FORMAT) {
    throw new Error(
      `unsupported backup format ${JSON.stringify(manifest?.format)} (this release reads format ${FORMAT})`,
    );
  }
  const files = manifest.files ?? {};
  if (!files[DB_DUMP]) throw new Error(`the manifest lists no ${DB_DUMP}`);
  for (const [name, sum] of Object.entries(files)) {
    if (!KNOWN_FILES.includes(name) || typeof sum !== "string" || !SHA.test(sum)) {
      throw new Error(`the manifest names an unknown file or checksum: ${JSON.stringify(name)}`);
    }
    const file = path.join(dir, name);
    if (!existsSync(file)) throw new Error(`missing file ${name}`);
    if ((await sha256File(file)) !== sum) throw new Error(`checksum mismatch: ${name}`);
  }
  if (files[OBJECTS_INDEX]) {
    const index = JSON.parse(readFileSync(path.join(dir, OBJECTS_INDEX), "utf8"));
    if (!Array.isArray(index)) throw new Error(`${OBJECTS_INDEX} is not a list`);
    for (const o of index) {
      if (typeof o?.file !== "string" || !OBJECT_FILE.test(o.file) || !SHA.test(o?.sha256 ?? "")) {
        throw new Error(`${OBJECTS_INDEX} has an invalid entry`);
      }
      const file = path.join(dir, o.file);
      if (!existsSync(file)) throw new Error(`missing file ${o.file}`);
      if (statSync(file).size !== o.size || (await sha256File(file)) !== o.sha256) {
        throw new Error(`checksum mismatch: ${o.file}`);
      }
    }
  }
  if (!Array.isArray(manifest.migrations) || manifest.migrations.some((m) => typeof m !== "string")) {
    throw new Error("the manifest has no migration list");
  }
  const known = new Set(migrations);
  const unknown = manifest.migrations.filter((m) => !known.has(m));
  if (unknown.length > 0) {
    throw new Error(
      `this backup was made by a newer release (unknown migrations: ${unknown.join(", ")}). ` +
        "Restore it with that release (or newer), not this one.",
    );
  }
  return manifest;
}

function fromFile(run, label, args, file, opts = {}) {
  const fd = openSync(file, "r");
  try {
    return must(run, label, args, { ...opts, stdin: fd });
  } finally {
    closeSync(fd);
  }
}

/** `deps`: { runner, log, projectDir } (tests inject a fake runner). Returns the exit code. */
export async function main(argv, deps = {}) {
  const log = deps.log ?? console.log;
  const { opts, positionals } = parseArgs(argv, SPEC);
  if (opts.help) {
    log(
      readFileSync(new URL(import.meta.url), "utf8")
        .split("\n")
        .slice(1, 8)
        .join("\n")
        .replace(/^\/\/ ?/gm, ""),
    );
    return 0;
  }
  if (positionals.length !== 1) throw usageError("Usage: pnpm ocw restore DIR --yes [--env-file F]");
  if (!opts.yes) {
    throw usageError(
      "Restore replaces this install's database, objects and cell state with the backup's. " +
        "Nothing was changed; re-run with --yes to proceed.",
    );
  }
  const projectDir = deps.projectDir ?? REPO_ROOT;
  const envFile = resolveEnvFile(opts);
  composeArgs(envFile, { projectDir }); // refuses the demo and a missing file before anything else
  const dir = path.resolve(positionals[0]);
  const manifest = await verifyBackup(dir, { migrations: localMigrations(projectDir) });
  const { values } = readEnv(envFile);
  const withVault = Boolean(manifest.files[OPENBAO_STATE]);
  const vault = withVault ? vaultFiles(values, envFile) : null;
  if (withVault && (!vaultEnabled(values) || !vault || !manifest.files[SEAL_KEY])) {
    throw new Error(
      "this backup holds OpenBao's data (vault profile), but the env file does not turn the vault profile on " +
        "(COMPOSE_PROFILES with vault, OCW_OPENBAO_SEAL_KEY_FILE): restore the env file saved with this backup first. " +
        "Nothing was changed.",
    );
  }
  const pgEnv = { PGPASSWORD: values.get("OCW_DB_MIGRATOR_PASSWORD") ?? "" };
  const run = deps.runner ?? composeRunner(envFile, { projectDir });
  const step = (text) => log(`- ${text}`);
  const stopped = withVault ? [...WRITERS, OPENBAO] : WRITERS;

  log(
    `Restoring ${dir} (made ${manifest.createdAt}, ${manifest.migrations.length} migrations); checksums verified`,
  );
  step(`stopping ${stopped.join(", ")}`);
  must(run, "stop", ["stop", ...stopped]);
  step("starting postgres, redis, garage");
  must(run, "up", ["up", "-d", "--wait", "postgres", "redis", "garage"]);
  step("migrate (database roles)");
  must(run, "migrate", ["run", "--rm", "migrate"]);
  step(`dropping schemas app, auth, drizzle, pgboss and restoring ${DB_DUMP} as ${MIGRATOR} (one transaction)`);
  must(
    run,
    "drop schemas",
    asMigrator("psql", [
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "SET client_min_messages = warning; DROP SCHEMA IF EXISTS app, auth, drizzle, pgboss CASCADE",
    ]),
    { env: pgEnv },
  );
  fromFile(
    run,
    "pg_restore",
    asMigrator("pg_restore", ["--exit-on-error", "--single-transaction"]),
    path.join(dir, DB_DUMP),
    { env: pgEnv },
  );
  step("migrate (upgrades an older backup, re-applies grants and policies)");
  must(run, "migrate", ["run", "--rm", "migrate"]);
  if (manifest.files[OBJECTS_INDEX]) {
    step("objects: import through the S3 API; objects not in the backup are removed");
    must(run, "object import", [
      "run",
      "--rm",
      "--no-deps",
      "-T",
      ...hostUser(),
      "-v",
      `${dir}:/backup:ro`,
      "api",
      "node",
      "--import",
      "tsx",
      "src/cli/object-store.ts",
      "import",
      "/backup",
      "--delete-extra",
    ]);
  }
  if (manifest.files[CELL_STATE]) {
    step(`cell state: replacing ${CELL_STATE_DIR}`);
    fromFile(
      run,
      "cell state restore",
      [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "--user",
        "0",
        "--entrypoint",
        "sh",
        "openclaw",
        "-c",
        `find ${CELL_STATE_DIR} -mindepth 1 -delete && tar -C ${CELL_STATE_DIR} -xf -`,
      ],
      path.join(dir, CELL_STATE),
    );
  }
  if (vault) {
    // The seal key file first: compose bind-mounts it into every openbao container, and Docker would create a
    // directory in its place if it were missing. The restored data only unseals with the backup's key.
    step("secrets/: the OpenBao seal key and recovery material");
    const secretsDir = path.dirname(vault.seal);
    if (existsSync(vault.seal) && statSync(vault.seal).isDirectory()) rmdirSync(vault.seal);
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    chmodSync(secretsDir, 0o700);
    copyFileSync(path.join(dir, SEAL_KEY), vault.seal);
    chmodSync(vault.seal, 0o600);
    if (manifest.files[OPENBAO_INIT]) {
      copyFileSync(path.join(dir, OPENBAO_INIT), vault.init);
      chmodSync(vault.init, 0o600);
    }
    step(`OpenBao: replacing ${OPENBAO_DATA_DIR}`);
    fromFile(
      run,
      "OpenBao data restore",
      [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "--user",
        "0",
        "--entrypoint",
        "sh",
        OPENBAO,
        "-c",
        `find ${OPENBAO_DATA_DIR} -mindepth 1 -delete && tar -C ${OPENBAO_DATA_DIR} -xf -`,
      ],
      path.join(dir, OPENBAO_STATE),
    );
    // The api reads its secrets from OpenBao at boot: OpenBao must be unsealed before the api starts.
    step("starting OpenBao (auto-unseal with the restored key)");
    must(run, "up openbao", ["up", "-d", "--wait", OPENBAO]);
  }
  step("starting the stack (up -d --wait)");
  must(run, "up", ["up", "-d", "--wait"]);
  log("Restore complete.");
  return 0;
}

export async function runMain(argv, deps) {
  try {
    process.exitCode = await main(argv, deps);
  } catch (err) {
    console.error(`ocw restore: ${err.message}`);
    process.exitCode = err.usage ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMain(process.argv.slice(2));
}
