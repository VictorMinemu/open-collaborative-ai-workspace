#!/usr/bin/env node
// Turn on the `observability` profile (Collector, Tempo, Prometheus, Loki, Grafana) for an existing install.
//   pnpm ocw enable observability                 # .env of this checkout, then `docker compose up -d --wait`
//   --dir <dir> | --env-file <path>               # another install's env file
//   --no-up                                       # only write the env file (start it later with up -d --wait)
// Writes OCW_OTEL_ENDPOINT (the profile's collector), OCW_GRAFANA_ADMIN_PASSWORD (generated once, never rotated) and
// adds `observability` to COMPOSE_PROFILES. `up -d --wait` then recreates only the api (new endpoint) and starts the
// profile: data volumes are untouched and nothing is rebuilt. Prints key names, never a value.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertNotDemoEnvFile,
  gen,
  parseArgs,
  REPO_ROOT,
  readEnv,
  reportWritten,
  resolveEnvFile,
  runCompose,
  updateEnvText,
  usageError,
  writePrivate,
} from "./env-file.mjs";

export const PROFILE = "observability";
/** The collector as the api sees it on the compose network (infra/observability/compose.yaml). */
export const COLLECTOR_ENDPOINT = "http://otel-collector:4318";
export const DEFAULT_GRAFANA_PORT = "3301";
const SPEC = { boolean: ["no-up", "help"], string: ["dir", "env-file"] };

function help() {
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
}

const shellQuote = (s) => (/^[A-Za-z0-9_./:=@-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

/**
 * The env-file changes enabling the profile needs, from the current values: `{ entries, replacedEndpoint }`.
 * Pure (exported for tests); never returns a value read from the file except the kept profile list.
 */
export function plan(values) {
  const entries = {};
  const endpoint = values.get("OCW_OTEL_ENDPOINT") ?? "";
  if (endpoint !== COLLECTOR_ENDPOINT) entries.OCW_OTEL_ENDPOINT = COLLECTOR_ENDPOINT;
  // Grafana applies it only when it creates its database: rotating it here would not change the real password.
  if (!values.get("OCW_GRAFANA_ADMIN_PASSWORD")) entries.OCW_GRAFANA_ADMIN_PASSWORD = gen.password();
  const profiles = (values.get("COMPOSE_PROFILES") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!profiles.includes(PROFILE)) entries.COMPOSE_PROFILES = [...profiles, PROFILE].join(",");
  return { entries, replacedEndpoint: endpoint !== "" && endpoint !== COLLECTOR_ENDPOINT };
}

export function main(argv) {
  const { opts, positionals } = parseArgs(argv, SPEC);
  if (opts.help) {
    help();
    return 0;
  }
  if (positionals.length > 0) throw usageError(`Unexpected argument: ${positionals[0]}`);
  const file = resolveEnvFile(opts);
  assertNotDemoEnvFile(file);
  let current;
  try {
    current = readEnv(file);
  } catch (err) {
    if (err.code === "ENOENT") throw new Error(`${file} does not exist: run \`pnpm ocw setup\` first.`);
    throw err;
  }

  const { entries, replacedEndpoint } = plan(current.values);
  const keys = Object.keys(entries);
  if (keys.length === 0) {
    console.log(`Observability is already enabled in ${file}; nothing changed.`);
  } else {
    // Template lines (`# KEY=`) are filled in place; keys with no line at all are appended under a header.
    writePrivate(
      file,
      updateEnvText(current.text, entries, {
        header: "Added by pnpm ocw enable observability",
        uncomment: true,
      }),
    );
    reportWritten(keys, file);
    if (replacedEndpoint) {
      console.log(
        "OCW_OTEL_ENDPOINT was replaced: it pointed at another collector; the API now sends to this profile's.",
      );
    }
  }

  const values = readEnv(file).values;
  const port = values.get("OCW_GRAFANA_PORT") || DEFAULT_GRAFANA_PORT;
  const isDefaultFile = file === path.join(REPO_ROOT, ".env");
  const compose = isDefaultFile ? "docker compose" : `docker compose --env-file ${shellQuote(file)}`;

  let status = 0;
  if (opts["no-up"]) {
    console.log(`\nStart it with: ${compose} up -d --wait`);
  } else {
    console.log("\nStarting the profile (docker compose up -d --wait); only the api is recreated.");
    status = runCompose(file, ["up", "-d", "--wait"]);
    if (status !== 0) console.error(`docker compose up -d --wait exited ${status}.`);
  }
  console.log(
    `\nGrafana: http://127.0.0.1:${port} (user admin; loopback only, use an SSH tunnel from elsewhere).`,
  );
  console.log(`The admin password is OCW_GRAFANA_ADMIN_PASSWORD in ${file}. Read it with:`);
  console.log(`  grep '^OCW_GRAFANA_ADMIN_PASSWORD=' ${shellQuote(file)}`);
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = err.usage ? 2 : 1;
  }
}
