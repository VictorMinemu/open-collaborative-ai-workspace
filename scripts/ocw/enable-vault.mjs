#!/usr/bin/env node
// Turn on the `vault` profile: OpenBao holds the API-only secrets, .env keeps openbao:// references (no reinstall).
//   pnpm ocw enable vault                  # the repository's .env
//   --dir <dir> | --env-file <path>        # another install's env file (its secrets/ directory sits next to it)
//   --no-up                                # leave the api running on its old values (restart it yourself later)
// What it does, once: generates the 32-byte static seal key (secrets/openbao-seal.key), starts OpenBao in server mode,
// initialises it with one recovery share (secrets/openbao-init.json), enables KV v2 at secret/ and AppRole, writes the
// read-only policy and role `ocw-api`, moves the set values of BETTER_AUTH_SECRET, OCW_ENCRYPTION_KEY, OCW_SETUP_TOKEN
// and OCW_SMTP_URL into secret/ocw/api, rewrites those .env lines to openbao:// references, revokes the root token and
// restarts the stack. Prints key names and file paths only. A second run changes nothing.
// docs/self-hosting/secrets.md. Database passwords, OCW_CELL_TOKEN and the S3 keys stay in .env (D-16).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  addProfile,
  assertNotDemoEnvFile,
  composeArgs,
  parseArgs,
  REPO_ROOT,
  readEnv,
  reportWritten,
  resolveEnvFile,
  setKeys,
  usageError,
  writePrivate,
} from "./env-file.mjs";

/** The secrets only the API reads (apps/api/src/config/env.ts OPENBAO_ALLOWED). */
export const MOVABLE = ["BETTER_AUTH_SECRET", "OCW_SETUP_TOKEN", "OCW_ENCRYPTION_KEY", "OCW_SMTP_URL"];
export const OPENBAO_ADDR = "http://openbao:8200";
const MOUNT = "secret";
const KV_PATH = "ocw/api";
const ref = (key) => `openbao://${MOUNT}/${KV_PATH}#${key}`;
const isRef = (v) => typeof v === "string" && v.startsWith("openbao://");
const POLICY = `path "${MOUNT}/data/ocw/*" { capabilities = ["read"] }\n`;
/** Reads the token from the first stdin line so it never appears in argv; the rest of stdin goes to `bao`. */
const WITH_TOKEN = 'IFS= read -r BAO_TOKEN && export BAO_TOKEN && exec bao "$@"';
const SPEC = { boolean: ["no-up", "help"], string: ["dir", "env-file"] };

/** `docker compose <install args> <args>`, stdin from `input`; returns { status, stdout, stderr } (nothing printed). */
export function defaultCompose(envFile, args, { input } = {}) {
  const res = spawnSync("docker", ["compose", ...composeArgs(envFile), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    input: input ?? "",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

class StepError extends Error {}

/** Last stderr line of a failed call, without anything that looks like a value we hold. */
function failure(step, res, secrets) {
  let tail = (res.stderr || "").trim().split("\n").slice(-3).join(" ").slice(0, 300);
  for (const s of secrets) if (s) tail = tail.replaceAll(s, "<redacted>");
  return new StepError(`${step} failed (exit ${res.status})${tail ? `: ${tail}` : ""}`);
}

function parseJson(text, step) {
  try {
    return JSON.parse(text);
  } catch {
    throw new StepError(`${step}: unexpected output from OpenBao`);
  }
}

/** Returns the exit code: 0 done or already enabled, 1 a step failed (message on `error`). Usage errors throw. */
export async function main(argv, deps = {}) {
  const error = deps.error ?? console.error;
  try {
    return await enableVault(argv, deps);
  } catch (err) {
    if (!(err instanceof StepError)) throw err;
    error(err.message);
    return 1;
  }
}

async function enableVault(argv, deps) {
  const compose = deps.compose ?? defaultCompose;
  const log = deps.log ?? console.log;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const { opts } = parseArgs(argv, SPEC);
  if (opts.help) {
    const lines = readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n")
      .slice(1);
    const end = lines.findIndex((l) => !l.startsWith("//"));
    log(
      `ocw enable vault\n${lines
        .slice(0, end)
        .map((l) => l.replace(/^\/\/ ?/, ""))
        .join("\n")}`,
    );
    return 0;
  }

  const envFile = resolveEnvFile(opts);
  assertNotDemoEnvFile(envFile);
  if (!existsSync(envFile)) throw usageError(`${envFile} does not exist: run \`pnpm ocw setup\` first.`);
  const before = readEnv(envFile).values;
  const plain = MOVABLE.filter((k) => (before.get(k) ?? "") !== "" && !isRef(before.get(k)));
  if (before.get("OCW_OPENBAO_ROLE_ID") && before.get("OCW_OPENBAO_SECRET_ID") && plain.length === 0) {
    log(`OpenBao is already enabled for ${envFile}: nothing changed.`);
    return 0;
  }

  // 1. Seal key (kept when a previous run created it: the data is encrypted with it) and the OpenBao settings.
  const secretsDir = path.join(path.dirname(envFile), "secrets");
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  chmodSync(secretsDir, 0o700);
  const sealFile = path.join(secretsDir, "openbao-seal.key");
  const initFile = path.join(secretsDir, "openbao-init.json");
  const written = [];
  if (!existsSync(sealFile)) {
    writeFileSync(sealFile, randomBytes(32), { mode: 0o600 });
    written.push(sealFile);
  }
  chmodSync(sealFile, 0o600);
  setKeys(
    envFile,
    { OCW_OPENBAO_ADDR: OPENBAO_ADDR, OCW_OPENBAO_SEAL_KEY_FILE: sealFile },
    { header: "OpenBao (vault profile), written by pnpm ocw enable vault" },
  );
  addProfile(envFile, "vault");

  const secrets = plain.map((k) => before.get(k));
  const run = (step, args, input) => {
    const res = compose(envFile, args, { input });
    if (res.status !== 0) throw failure(step, res, secrets);
    return res;
  };

  // 2. Start OpenBao and wait until it answers (`bao status`: 0 unsealed, 2 sealed or not initialised).
  run("docker compose up -d openbao", ["up", "-d", "openbao"]);
  let status;
  for (let i = 0; ; i++) {
    const res = compose(envFile, ["exec", "-T", "openbao", "bao", "status", "-format=json"]);
    if ((res.status === 0 || res.status === 2) && res.stdout.trim().startsWith("{")) {
      status = parseJson(res.stdout, "bao status");
      break;
    }
    if (i >= 60) {
      // OpenBao's own log says why (a seal or storage error); it never contains the seal key or a secret.
      const logs = compose(envFile, ["logs", "--no-color", "--tail", "5", "openbao"]);
      const err = failure("waiting for OpenBao to answer", res, secrets);
      const tail = (logs.stdout || "").trim();
      if (tail) err.message += `\nLast lines of the openbao log:\n${tail}`;
      throw err;
    }
    await sleep(1000);
  }

  // 3. Initialise once; the output (root token, recovery key) goes straight to a 0600 file.
  if (!status.initialized) {
    if (existsSync(initFile)) {
      throw new StepError(
        `OpenBao has no data but ${initFile} exists (from an earlier OpenBao). Move that file away to initialise a new one.`,
      );
    }
    const res = run("bao operator init", [
      "exec",
      "-T",
      "openbao",
      "bao",
      "operator",
      "init",
      "-recovery-shares=1",
      "-recovery-threshold=1",
      "-format=json",
    ]);
    parseJson(res.stdout, "bao operator init");
    writePrivate(initFile, res.stdout);
    written.push(initFile);
  } else if (!existsSync(initFile)) {
    throw new StepError(
      `OpenBao is already initialised but ${initFile} is missing: without its root token it cannot be configured (docs/self-hosting/secrets.md, "Recovery").`,
    );
  }
  const material = parseJson(readFileSync(initFile, "utf8"), initFile);
  const rootToken = material.root_token;
  if (typeof rootToken !== "string" || !rootToken) {
    throw new StepError(
      `${initFile} holds no root token (already revoked): configure OpenBao by hand (docs/self-hosting/secrets.md).`,
    );
  }
  secrets.push(rootToken);
  run("docker compose up -d --wait openbao", ["up", "-d", "--wait", "openbao"]);

  // 4. Configure with the root token, given on stdin only.
  const bao = (step, args, stdin = "") =>
    run(step, ["exec", "-T", "openbao", "sh", "-c", WITH_TOKEN, "sh", ...args], `${rootToken}\n${stdin}`);
  const mounts = parseJson(
    bao("bao secrets list", ["secrets", "list", "-format=json"]).stdout,
    "secrets list",
  );
  if (!mounts[`${MOUNT}/`]) bao("enable KV v2", ["secrets", "enable", `-path=${MOUNT}`, "-version=2", "kv"]);
  const auths = parseJson(bao("bao auth list", ["auth", "list", "-format=json"]).stdout, "auth list");
  if (!auths["approle/"]) bao("enable AppRole", ["auth", "enable", "approle"]);
  bao("write policy ocw-api", ["policy", "write", "ocw-api", "-"], POLICY);
  // The API logs in at boot, reads once and revokes its token: short TTLs, a secret id that does not expire.
  bao("write role ocw-api", [
    "write",
    "auth/approle/role/ocw-api",
    "token_policies=ocw-api",
    "token_ttl=5m",
    "token_max_ttl=15m",
    "secret_id_ttl=0",
    "secret_id_num_uses=0",
  ]);
  const roleId = parseJson(
    bao("read role id", ["read", "-format=json", "auth/approle/role/ocw-api/role-id"]).stdout,
    "role id",
  )?.data?.role_id;
  const secretId = parseJson(
    bao("create secret id", ["write", "-f", "-format=json", "auth/approle/role/ocw-api/secret-id"]).stdout,
    "secret id",
  )?.data?.secret_id;
  if (typeof roleId !== "string" || typeof secretId !== "string" || !roleId || !secretId) {
    throw new StepError("OpenBao returned no AppRole role id or secret id");
  }
  secrets.push(secretId);

  // 5. Values into KV (JSON on stdin), then one .env write: references + AppRole credentials.
  if (plain.length > 0) {
    const data = Object.fromEntries(plain.map((k) => [k, before.get(k)]));
    const op = MOVABLE.some((k) => isRef(before.get(k))) ? "patch" : "put";
    bao(`write ${MOUNT}/${KV_PATH}`, ["kv", op, `-mount=${MOUNT}`, KV_PATH, "-"], JSON.stringify(data));
  }
  setKeys(envFile, {
    ...Object.fromEntries(plain.map((k) => [k, ref(k)])),
    OCW_OPENBAO_ROLE_ID: roleId,
    OCW_OPENBAO_SECRET_ID: secretId,
  });

  // 6. Revoke the root token and keep only the recovery material (a new root token needs the recovery key).
  bao("revoke the root token", ["token", "revoke", "-self"]);
  const { root_token: _revoked, ...rest } = material;
  writePrivate(initFile, `${JSON.stringify({ ...rest, root_token_revoked: true }, null, 2)}\n`);

  if (plain.length > 0)
    log(
      `Moved ${plain.join(", ")} into OpenBao (${MOUNT}/${KV_PATH}); .env now holds openbao:// references.`,
    );
  reportWritten(
    [
      ...plain,
      "OCW_OPENBAO_ADDR",
      "OCW_OPENBAO_ROLE_ID",
      "OCW_OPENBAO_SECRET_ID",
      "OCW_OPENBAO_SEAL_KEY_FILE",
      "COMPOSE_PROFILES",
    ],
    envFile,
    { log },
  );
  for (const f of [...new Set([...written, initFile])]) log(`Wrote ${f} (mode 0600)`);
  log("The root token was revoked.");
  log(
    `Back up ${secretsDir} and ${envFile} together and keep them private: without secrets/openbao-seal.key the OpenBao data cannot be unsealed.`,
  );

  if (opts["no-up"]) {
    log("--no-up: restart the stack to apply it: docker compose up -d --wait");
    return 0;
  }
  run("docker compose up -d --wait", ["up", "-d", "--wait"]);
  log("The stack was restarted; the api now reads these secrets from OpenBao.");
  return 0;
}

/** Run `main` as a CLI: usage errors exit 2, other failures exit 1, messages only (no stack, no values). */
export async function runMain(argv) {
  try {
    process.exitCode = await main(argv);
  } catch (err) {
    console.error(err.message);
    process.exitCode = err.usage ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runMain(process.argv.slice(2));
}
