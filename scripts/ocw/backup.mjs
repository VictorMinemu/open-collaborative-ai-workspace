#!/usr/bin/env node
// Back up an install: the whole database (as ocw_migrator), every stored object, the OpenClaw cell's state, a manifest.
//   pnpm ocw backup [--out DIR] [--env-file F | --dir D] [--consistent]
//   --out DIR        where to write (default backups/<UTC timestamp>); must not exist or be empty
//   --consistent     stop api, web and openclaw for the duration (default: online; pg_dump is one snapshot)
// The directory (0700, files 0600) holds sealed secrets and cell sign-ins: keep it private. It never holds .env and is
// useless without it (back it up separately). With the vault profile on it also holds OpenBao's data volume and
// secrets/ (seal key, recovery material), since the API-only secrets exist nowhere else: keep it as private as .env.
// Restore with `pnpm ocw restore DIR --yes`.
// docs/self-hosting/backup-restore.md
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { composeArgs, parseArgs, REPO_ROOT, readEnv, resolveEnvFile } from "./env-file.mjs";

export const FORMAT = 1;
export const MANIFEST = "manifest.json";
export const DB_DUMP = "db.dump";
export const OBJECTS_INDEX = "objects.json";
export const CELL_STATE = "openclaw-state.tar";
/** Vault profile (07-06): OpenBao's raft data, its static seal key and the init (recovery) material from secrets/. */
export const OPENBAO_STATE = "openbao-data.tar";
export const SEAL_KEY = "openbao-seal.key";
export const OPENBAO_INIT = "openbao-init.json";
/** The files a manifest may list (anything else is refused on restore). */
export const KNOWN_FILES = [DB_DUMP, OBJECTS_INDEX, CELL_STATE, OPENBAO_STATE, SEAL_KEY, OPENBAO_INIT];
/** Services that write state; `--consistent` (and restore) stop them. */
export const WRITERS = ["api", "web", "openclaw"];
export const MIGRATOR = "ocw_migrator";
/** Where the cell keeps its state (the `openclaw-state` volume in compose.yaml). */
export const CELL_STATE_DIR = "/home/node/.openclaw";
/** OpenBao's storage directory (the `openbao-data` volume in infra/openbao/compose.yaml). */
export const OPENBAO_DATA_DIR = "/openbao/file";
export const OPENBAO = "openbao";

/** True when the env file turns the `vault` profile on (COMPOSE_PROFILES). */
export function vaultEnabled(values) {
  return (values.get("COMPOSE_PROFILES") ?? "")
    .split(",")
    .map((p) => p.trim())
    .includes("vault");
}

/**
 * Where this install keeps its seal key and init material: OCW_OPENBAO_SEAL_KEY_FILE (relative paths against the env
 * file's directory, as `ocw enable vault` writes them next to it) and openbao-init.json beside it. Null when unset.
 */
export function vaultFiles(values, envFile) {
  const raw = values.get("OCW_OPENBAO_SEAL_KEY_FILE") ?? "";
  if (raw === "") return null;
  const seal = path.resolve(path.dirname(envFile), raw);
  return { seal, init: path.join(path.dirname(seal), OPENBAO_INIT) };
}
const OBJECT_STORE_CLI = ["node", "--import", "tsx", "src/cli/object-store.ts"];

const SPEC = { boolean: ["consistent", "help"], string: ["out", "env-file", "dir"] };

/**
 * `docker compose` for the install behind `envFile` (composeArgs refuses the demo's project and env files).
 * Returns `run(args, { stdin, stdout, capture, env }) → { status, stdout }`: `stdin`/`stdout` are file descriptors,
 * `capture` returns stdout as text, `env` adds variables to docker's environment (values never reach argv). Docker's
 * own output goes to stderr so the command's report stays on stdout.
 */
export function composeRunner(envFile, { projectDir = REPO_ROOT, env = process.env } = {}) {
  const base = composeArgs(envFile, { projectDir });
  return (args, { stdin, stdout, capture = false, env: extra } = {}) => {
    const res = spawnSync("docker", ["compose", ...base, ...args], {
      cwd: projectDir,
      env: extra ? { ...env, ...extra } : env,
      stdio: [stdin ?? "ignore", stdout ?? (capture ? "pipe" : 2), 2],
      encoding: capture ? "utf8" : undefined,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.error) throw res.error;
    return { status: res.status ?? 1, stdout: capture ? (res.stdout ?? "") : "" };
  };
}

/** Runs one compose call and throws `<label> failed (exit N)` on a non-zero exit. */
export function must(run, label, args, opts) {
  const res = run(args, opts);
  if (res.status !== 0) throw new Error(`${label} failed (docker compose exit ${res.status})`);
  return res;
}

/** `exec -T postgres <tool> -U ocw_migrator …` with the role's password in the container environment only. */
export function asMigrator(tool, args) {
  return ["exec", "-T", "-e", "PGPASSWORD", "postgres", tool, "-U", MIGRATOR, "-d", "ocw", ...args];
}

/** Services of this project that are running now. */
export function runningServices(run) {
  const res = must(run, "docker compose ps", ["ps", "--services", "--status", "running"], { capture: true });
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** Files 0600 and directories 0700 under `dir` (the object export may run as another uid). */
export function lockDown(dir) {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) lockDown(p);
    else chmodSync(p, 0o600);
  }
}

/**
 * `--user <uid>:<gid>` on Linux, so the api container (user `node`) can write and read a 0700 backup directory owned
 * by the operator. Docker Desktop (macOS, Windows) maps bind-mount ownership itself.
 */
export function hostUser() {
  return process.platform === "linux" ? ["--user", `${process.getuid()}:${process.getgid()}`] : [];
}

/** `ocw-api` version and the checkout's commit (best effort; a tarball install has no git). */
function versionInfo(projectDir) {
  let apiVersion = null;
  try {
    apiVersion =
      JSON.parse(readFileSync(path.join(projectDir, "apps/api/package.json"), "utf8")).version ?? null;
  } catch {
    apiVersion = null;
  }
  const git = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: projectDir, encoding: "utf8" });
  return { apiVersion, gitSha: git.status === 0 ? git.stdout.trim() : null };
}

const timestamp = (d) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

function prepareOut(out) {
  if (existsSync(out)) {
    if (!statSync(out).isDirectory() || readdirSync(out).length > 0) {
      throw Object.assign(new Error(`${out} already exists and is not empty`), { usage: true });
    }
  }
  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);
}

/** Streams one compose call's stdout into `file` (created 0600). */
function toFile(run, label, args, file, opts = {}) {
  const fd = openSync(file, "w", 0o600);
  try {
    must(run, label, args, { ...opts, stdout: fd });
  } finally {
    closeSync(fd);
  }
}

/**
 * `deps`: { runner, log, projectDir, now } (tests inject a fake runner; nothing else talks to Docker).
 * Returns the exit code.
 */
export async function main(argv, deps = {}) {
  const log = deps.log ?? console.log;
  const { opts } = parseArgs(argv, SPEC);
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
  const projectDir = deps.projectDir ?? REPO_ROOT;
  const envFile = resolveEnvFile(opts);
  composeArgs(envFile, { projectDir }); // refuses the demo and a missing file before anything else
  const { values } = readEnv(envFile);
  const project = values.get("COMPOSE_PROJECT_NAME") || path.basename(projectDir);
  const now = deps.now ?? new Date();
  const out = path.resolve(opts.out ?? path.join(projectDir, "backups", timestamp(now)));
  const run = deps.runner ?? composeRunner(envFile, { projectDir });
  const pgEnv = { PGPASSWORD: values.get("OCW_DB_MIGRATOR_PASSWORD") ?? "" };
  const objectsConfigured =
    Boolean(values.get("OCW_S3_ACCESS_KEY_ID")) &&
    Boolean(values.get("OCW_S3_SECRET_ACCESS_KEY") || values.get("OCW_S3_SECRET_ACCESS_KEY_FILE"));

  const vault = vaultEnabled(values) ? vaultFiles(values, envFile) : null;
  if (vaultEnabled(values) && (!vault || !existsSync(vault.seal))) {
    throw new Error(
      "the vault profile is on but OCW_OPENBAO_SEAL_KEY_FILE does not name an existing seal key file: " +
        "without it OpenBao's data cannot be unsealed (docs/self-hosting/secrets.md)",
    );
  }

  const running = runningServices(run);
  if (!running.includes("postgres")) throw new Error("postgres is not running: start the stack first");
  prepareOut(out);
  log(`Backing up ${project} into ${out}`);
  const stopped = opts.consistent ? WRITERS.filter((s) => running.includes(s)) : [];
  const files = {};
  let migrations = [];
  let objects = null;
  let cell = false;
  let vaultTaken = false;
  try {
    if (stopped.length > 0) {
      log(`- stopping ${stopped.join(", ")} (--consistent)`);
      must(run, "stop", ["stop", ...stopped]);
    }

    log(`- database: pg_dump as ${MIGRATOR} (whole database, custom format)`);
    const listed = must(
      run,
      "reading the applied migrations",
      asMigrator("psql", [
        "-X",
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        "select name from drizzle.__drizzle_migrations order by id",
      ]),
      { capture: true, env: pgEnv },
    );
    migrations = listed.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    toFile(run, "pg_dump", asMigrator("pg_dump", ["-Fc"]), path.join(out, DB_DUMP), { env: pgEnv });

    if (objectsConfigured) {
      log("- objects: export through the S3 API (api image)");
      must(run, "object export", [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        ...hostUser(),
        "-v",
        `${out}:/backup`,
        "api",
        ...OBJECT_STORE_CLI,
        "export",
        "/backup",
      ]);
      objects = JSON.parse(readFileSync(path.join(out, OBJECTS_INDEX), "utf8"));
    } else {
      log("- objects: skipped (object storage is not configured in the env file)");
    }

    const cellRunning = running.includes("openclaw");
    const pauseCell = cellRunning && !stopped.includes("openclaw");
    log(`- cell state: archive of ${CELL_STATE_DIR}${pauseCell ? " (openclaw stopped for the copy)" : ""}`);
    if (pauseCell) must(run, "stop openclaw", ["stop", "openclaw"]);
    try {
      toFile(
        run,
        "cell state archive",
        [
          "run",
          "--rm",
          "--no-deps",
          "-T",
          "--user",
          "0",
          "--entrypoint",
          "tar",
          "openclaw",
          "-C",
          CELL_STATE_DIR,
          "-cf",
          "-",
          ".",
        ],
        path.join(out, CELL_STATE),
      );
      cell = true;
    } finally {
      if (pauseCell) must(run, "start openclaw", ["start", "openclaw"]);
    }

    if (vault) {
      // The API-only secrets live only in OpenBao once the vault is on: without its data and seal key a restored
      // install cannot boot. Raft files are copied with OpenBao stopped (the api reads it only at boot).
      const pauseBao = running.includes(OPENBAO);
      log(`- OpenBao: archive of ${OPENBAO_DATA_DIR}${pauseBao ? " (openbao stopped for the copy)" : ""}`);
      if (pauseBao) must(run, "stop openbao", ["stop", OPENBAO]);
      try {
        toFile(
          run,
          "OpenBao data archive",
          [
            "run",
            "--rm",
            "--no-deps",
            "-T",
            "--user",
            "0",
            "--entrypoint",
            "tar",
            OPENBAO,
            "-C",
            OPENBAO_DATA_DIR,
            "-cf",
            "-",
            ".",
          ],
          path.join(out, OPENBAO_STATE),
        );
      } finally {
        if (pauseBao) must(run, "start openbao", ["start", OPENBAO]);
      }
      log("- secrets/: the OpenBao seal key and recovery material");
      copyFileSync(vault.seal, path.join(out, SEAL_KEY));
      if (existsSync(vault.init)) copyFileSync(vault.init, path.join(out, OPENBAO_INIT));
      vaultTaken = true;
    }
  } finally {
    if (stopped.length > 0) {
      log(`- starting ${stopped.join(", ")}`);
      must(run, "start", ["start", ...stopped]);
    }
  }

  const vaultNames = vaultTaken
    ? [OPENBAO_STATE, SEAL_KEY, ...(existsSync(path.join(out, OPENBAO_INIT)) ? [OPENBAO_INIT] : [])]
    : [];
  for (const name of [
    DB_DUMP,
    ...(objects ? [OBJECTS_INDEX] : []),
    ...(cell ? [CELL_STATE] : []),
    ...vaultNames,
  ]) {
    files[name] = await sha256File(path.join(out, name));
  }
  const manifest = {
    format: FORMAT,
    createdAt: now.toISOString(),
    ...versionInfo(projectDir),
    project,
    consistent: Boolean(opts.consistent),
    migrations,
    components: { database: true, objects: objects !== null, cellState: cell, vault: vaultTaken },
    files,
  };
  writeFileSync(path.join(out, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  lockDown(out);

  const size = (name) => statSync(path.join(out, name)).size;
  log(`Backup written to ${out} (private: 0700, files 0600):`);
  log(`  ${DB_DUMP}  ${size(DB_DUMP)} bytes, ${migrations.length} migrations applied`);
  if (objects) {
    const bytes = objects.reduce((n, o) => n + o.size, 0);
    log(`  ${OBJECTS_INDEX} + objects/  ${objects.length} objects, ${bytes} bytes`);
  }
  if (cell) log(`  ${CELL_STATE}  ${size(CELL_STATE)} bytes`);
  if (vaultTaken) {
    log(`  ${OPENBAO_STATE}  ${size(OPENBAO_STATE)} bytes (OpenBao data, vault profile)`);
    log(`  ${vaultNames.slice(1).join(", ")}  from secrets/ (the seal key unseals that data)`);
  }
  log(`  ${MANIFEST}  checksums of every file`);
  if (vaultTaken) {
    log(
      "Not included: .env (back it up separately). This backup holds OpenBao's data and its seal key: anyone with it " +
        "can read the API's secrets, so keep it as private as .env.",
    );
  } else {
    log("Not included: .env and secrets/ (back them up separately; the backup is useless without them).");
  }
  return 0;
}

export async function runMain(argv, deps) {
  try {
    process.exitCode = await main(argv, deps);
  } catch (err) {
    console.error(`ocw backup: ${err.message}`);
    process.exitCode = err.usage ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMain(process.argv.slice(2));
}
