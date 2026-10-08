#!/usr/bin/env node
// Write the install's .env with every secret generated now (never at boot); prints key names, never values.
//   pnpm ocw setup                         # fresh .env from .env.example with random secrets (refuses to overwrite)
//   pnpm ocw setup --force                 # overwrite: rotates EVERY secret, database passwords included
//   pnpm ocw setup --add-missing           # existing .env: append only the keys it lacks (never rotates anything)
//   --dir <dir> | --env-file <path>        # write <dir>/.env or <path> instead of the repository's .env
//                                          # (a new --env-file path needs `node -- scripts/ocw.mjs`: Node 24 checks it)
//   --ports <NN>                           # every published port in the NN00-NN99 block (second instance, gates)
//   --project <name>                       # COMPOSE_PROJECT_NAME (own containers and volumes)
//   --image-tag <tag>                      # OCW_IMAGE_TAG for the locally built images (default: local)
// `pnpm setup:env` is an alias (scripts/setup-env.mjs forwards its arguments here).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertNotDemoProject,
  gen,
  parseArgs,
  parseEnvText,
  REPO_ROOT,
  reportWritten,
  resolveEnvFile,
  setKeys,
  updateEnvText,
  writePrivate,
} from "./env-file.mjs";

const TEMPLATE = path.join(REPO_ROOT, ".env.example");
const SPEC = {
  boolean: ["force", "add-missing", "help"],
  string: ["dir", "env-file", "ports", "project", "image-tag"],
};

/** Every secret a fresh install needs, in the formats the services expect. */
function generateSecrets() {
  return {
    POSTGRES_PASSWORD: gen.password(),
    OCW_DB_MIGRATOR_PASSWORD: gen.password(),
    OCW_DB_APP_PASSWORD: gen.password(),
    OCW_DB_AUTH_PASSWORD: gen.password(),
    BETTER_AUTH_SECRET: gen.hex(32),
    OCW_SETUP_TOKEN: gen.hex(16),
    OCW_ENCRYPTION_KEY: gen.base64(32),
    OCW_CELL_TOKEN: `ocw_cell_${gen.base64url(32)}`,
    // Object storage (Garage, ADR-0015): RPC secret 32 bytes of hex, access key id `GK` + 12 bytes of hex, secret
    // 32 bytes of hex (Garage's formats). The same key pair is Garage's default key and the API's credentials.
    GARAGE_RPC_SECRET: gen.hex(32),
    OCW_S3_ACCESS_KEY_ID: `GK${gen.hex(12)}`,
    OCW_S3_SECRET_ACCESS_KEY: gen.hex(32),
  };
}

/** Never appended by --add-missing: a fresh value would not match the existing database or its URLs. */
const DB_PASSWORDS = [
  "POSTGRES_PASSWORD",
  "OCW_DB_MIGRATOR_PASSWORD",
  "OCW_DB_APP_PASSWORD",
  "OCW_DB_AUTH_PASSWORD",
];
const placeholder = (name) => ["$", "{", name, "}"].join("");

/** Port block NN (D-10, D-18): every port an install publishes, including the optional profiles'. */
export function portBlock(nn) {
  const p = (n) => String(nn * 100 + n);
  return {
    web: p(0),
    api: p(1),
    postgres: p(2),
    redis: p(3),
    s3: p(4),
    grafana: p(5),
    proxyHttps: p(43),
    proxyHttp: p(80),
  };
}

/** Port keys and the template URLs that point at each port (their host and credentials are kept). */
const PORT_KEYS = {
  web: ["OCW_WEB_PORT"],
  api: ["OCW_API_PORT"],
  postgres: ["OCW_POSTGRES_PORT"],
  redis: ["OCW_REDIS_PORT"],
  s3: ["OCW_S3_PORT"],
  grafana: ["OCW_GRAFANA_PORT"],
  proxyHttps: ["OCW_PROXY_HTTPS_PORT"],
  proxyHttp: ["OCW_PROXY_HTTP_PORT"],
};
const URL_KEYS = {
  web: ["OCW_PUBLIC_WEB_URL"],
  api: ["OCW_PUBLIC_API_URL"],
  postgres: ["DATABASE_URL", "AUTH_DATABASE_URL", "MIGRATOR_DATABASE_URL", "MIGRATE_SUPERUSER_URL"],
  redis: ["REDIS_URL"],
  s3: ["OCW_S3_PUBLIC_URL", "OCW_S3_ENDPOINT"],
};

function withPort(key, url, port) {
  const re = /^([a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?[^:/@]+):\d+/;
  if (!re.test(url)) throw new Error(`.env.example: ${key} has no host:port to move to the port block`);
  return url.replace(re, `$1:${port}`);
}

/** The full new .env text: the template with the generated secrets and the requested settings filled in. */
function render(template, secrets, settings) {
  let text = updateEnvText(template, secrets);
  // Local-dev URLs embed the generated role passwords.
  for (const name of DB_PASSWORDS) text = text.replaceAll(placeholder(name), secrets[name]);
  if (Object.keys(settings).length === 0) return text;
  // Settings land on their documented (commented) template line when there is one, else at the end.
  return updateEnvText(text, settings, { uncomment: true, header: "Written by pnpm ocw setup" });
}

/** COMPOSE_PROJECT_NAME / OCW_IMAGE_TAG / port block entries for the flags given (URLs from the rendered text). */
function settingsFor(opts, rendered) {
  const settings = {};
  if (opts.project) settings.COMPOSE_PROJECT_NAME = opts.project;
  if (opts["image-tag"]) settings.OCW_IMAGE_TAG = opts["image-tag"];
  if (opts.ports !== undefined) {
    const block = portBlock(Number(opts.ports));
    const current = parseEnvText(rendered);
    for (const [name, port] of Object.entries(block)) {
      for (const key of PORT_KEYS[name] ?? []) settings[key] = port;
      for (const key of URL_KEYS[name] ?? []) {
        if (current.has(key)) settings[key] = withPort(key, current.get(key), port);
      }
    }
  }
  return settings;
}

function validate(opts) {
  if (opts.ports !== undefined) {
    const nn = Number(opts.ports);
    // NN00..NN99 must stay within 1000..65535: blocks 10..654.
    if (!/^\d{2,3}$/.test(opts.ports) || nn < 10 || nn > 654) {
      throw Object.assign(new Error("--ports takes a block number from 10 to 654 (34 → ports 3400-3499)"), {
        usage: true,
      });
    }
  }
  if (opts.project !== undefined) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(opts.project)) {
      throw Object.assign(new Error("--project: lowercase letters, digits, '-' and '_' only"), {
        usage: true,
      });
    }
    assertNotDemoProject(opts.project);
  }
  if (opts["image-tag"] !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(opts["image-tag"])) {
    throw Object.assign(new Error("--image-tag: a Docker tag (letters, digits, '_', '.', '-')"), {
      usage: true,
    });
  }
  if (opts["add-missing"] && (opts.force || opts.ports || opts.project || opts["image-tag"])) {
    throw Object.assign(
      new Error(
        "--add-missing only appends missing keys; --force, --ports, --project and --image-tag need a fresh setup",
      ),
      { usage: true },
    );
  }
}

const shellQuote = (s) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

function addMissing(target, template) {
  if (!existsSync(target)) {
    console.error(`${target} does not exist; run without --add-missing to create it.`);
    return 1;
  }
  const current = readFileSync(target, "utf8");
  const have = parseEnvText(current);
  // Lines that embed a database password stay as they are: the database already has its passwords.
  const dependsOnDb = new Set(
    [...parseEnvText(template)]
      .filter(([, value]) => DB_PASSWORDS.some((n) => value.includes(placeholder(n))))
      .map(([key]) => key),
  );
  const added = [...parseEnvText(render(template, generateSecrets(), {}))].filter(
    ([key]) => !have.has(key) && !DB_PASSWORDS.includes(key) && !dependsOnDb.has(key),
  );
  if (added.length === 0) {
    console.log(`${target} already has every key.`);
    return 0;
  }
  setKeys(target, added, { header: "Added by pnpm ocw setup --add-missing" });
  reportWritten(
    added.map(([key]) => key),
    target,
  );
  return 0;
}

export function main(argv) {
  const { opts } = parseArgs(argv, SPEC);
  if (opts.help) {
    // The header comment block of this file is the help text.
    const lines = readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n")
      .slice(1);
    const end = lines.findIndex((l) => !l.startsWith("//"));
    console.log(
      lines
        .slice(0, end)
        .map((l) => l.replace(/^\/\/ ?/, ""))
        .join("\n"),
    );
    return 0;
  }
  validate(opts);
  const target = resolveEnvFile(opts);
  const template = readFileSync(TEMPLATE, "utf8");
  if (opts["add-missing"]) return addMissing(target, template);

  if (existsSync(target) && !opts.force) {
    console.error(
      `${target} already exists. Re-run with --add-missing to append new keys (keeps every value), or --force to overwrite (this rotates every secret).`,
    );
    return 1;
  }

  const secrets = generateSecrets();
  const base = render(template, secrets, {});
  const settings = settingsFor(opts, base);
  writePrivate(target, render(template, secrets, settings));

  console.log(`Wrote ${target} (mode 0600).`);
  console.log("Generated secrets:");
  reportWritten(Object.keys(secrets), target);
  if (Object.keys(settings).length > 0) {
    console.log("Settings:");
    reportWritten(Object.keys(settings), target);
  }
  if (opts.force) {
    // The JWT signing keys in auth.jwks are encrypted with BETTER_AUTH_SECRET (docs/adr/0008).
    console.log(
      "BETTER_AUTH_SECRET was rotated: delete the auth.jwks rows of an existing database and restart",
    );
    console.log("the API (outstanding JWTs become invalid; clients fetch new ones).");
    // Verified on v2.4.1: --default-bucket creates the new default key on the next start and grants it the bucket.
    console.log(
      "OCW_S3_* keys were rotated too: restart garage and api (docker compose up -d) to apply them.",
    );
  }
  // OCW_ACCEPT_LEGACY_DEVICE_TOKEN (default true, see .env.example) keeps pre-Phase-2 desktop apps connecting
  // with their raw device token; set it to false once every desktop app is rebuilt (docs/DEMO.md).

  const isDefaultFile = target === path.join(REPO_ROOT, ".env");
  const compose = isDefaultFile ? "docker compose" : `docker compose --env-file ${shellQuote(target)}`;
  const webUrl =
    parseEnvText(readFileSync(target, "utf8")).get("OCW_PUBLIC_WEB_URL") || "http://localhost:3000";
  console.log("\nNext steps:");
  console.log(`  1. ${compose} up -d --build --wait`);
  console.log(`  2. Open ${webUrl}/setup and create the first organization and admin.`);
  console.log(`  3. The setup token it asks for is OCW_SETUP_TOKEN in ${target}. Read it with:`);
  console.log(`       grep '^OCW_SETUP_TOKEN=' ${shellQuote(target)}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runMain(process.argv.slice(2));
}

/** Run `main` as a CLI: usage errors exit 2, other failures exit 1, messages only (no stack, no values). */
export function runMain(argv) {
  try {
    process.exitCode = main(argv);
  } catch (err) {
    console.error(err.message);
    process.exitCode = err.usage ? 2 : 1;
  }
}
