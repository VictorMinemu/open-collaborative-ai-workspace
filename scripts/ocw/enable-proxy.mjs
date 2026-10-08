#!/usr/bin/env node
// Put the instance behind Caddy (profile `proxy`) on one HTTPS origin: web, API, WebSockets and attachments.
//   pnpm ocw enable proxy --site-address <host>   # e.g. ocw.example.com (DNS A/AAAA to this host, ports 80/443 open)
//   --tls internal                                # Caddy's own CA instead of ACME (internal names; trust its root)
//   --dir <dir> | --env-file <path>               # the install's env file (default: the repository's .env)
//   --no-up                                       # only write the env file; do not run `docker compose up`
// Writes OCW_SITE_ADDRESS; OCW_PUBLIC_WEB_URL = OCW_PUBLIC_API_URL = OCW_S3_PUBLIC_URL = https://<host>[:<port>]
// (the port only when OCW_PROXY_HTTPS_PORT is not 443); OCW_TRUST_PROXY=1 (the API trusts this one proxy hop);
// OCW_PUBLISH_ADDRESS=127.0.0.1 (api and web reachable from the network only through Caddy); adds `proxy` to
// COMPOSE_PROFILES; then `docker compose up -d --wait`. Prints key names and the public URL, never a secret.
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  assertNotDemoEnvFile,
  parseArgs,
  parseEnvText,
  reportWritten,
  resolveEnvFile,
  runCompose,
  updateEnvText,
  usageError,
  writePrivate,
} from "./env-file.mjs";

const SPEC = { boolean: ["no-up", "help"], string: ["site-address", "tls", "dir", "env-file"] };
const TLS_MODES = ["auto", "internal"];
/** A DNS name or IPv4 address: no scheme, port, path, wildcard or whitespace (Caddy reads it as the site address). */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);

/** `https://<host>` plus `:<port>` when the published https port is not the default. */
export function publicOrigin(host, httpsPort) {
  const port = String(httpsPort ?? "").trim();
  return port === "" || port === "443" ? `https://${host}` : `https://${host}:${port}`;
}

/** The env keys `enable proxy` writes for `host` given the file's current values. */
export function proxySettings(values, host, { tls } = {}) {
  const origin = publicOrigin(host, values.get("OCW_PROXY_HTTPS_PORT"));
  const profiles = (values.get("COMPOSE_PROFILES") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!profiles.includes("proxy")) profiles.push("proxy");
  return {
    origin,
    entries: {
      OCW_SITE_ADDRESS: host,
      OCW_PUBLIC_WEB_URL: origin,
      OCW_PUBLIC_API_URL: origin,
      OCW_S3_PUBLIC_URL: origin,
      OCW_TRUST_PROXY: "1",
      OCW_PUBLISH_ADDRESS: "127.0.0.1",
      ...(tls ? { OCW_PROXY_TLS: tls } : {}),
      COMPOSE_PROFILES: profiles.join(","),
    },
  };
}

function validate(opts) {
  const raw = opts["site-address"];
  if (raw === undefined) throw usageError("--site-address <host> is required (e.g. ocw.example.com)");
  const host = raw.toLowerCase();
  if (!HOST.test(host)) {
    throw usageError(
      `--site-address takes a bare host name or IPv4 address (no scheme, port, path or wildcard): ${JSON.stringify(raw)}`,
    );
  }
  if (opts.tls !== undefined && !TLS_MODES.includes(opts.tls)) {
    throw usageError(`--tls takes ${TLS_MODES.join(" or ")}: ${JSON.stringify(opts.tls)}`);
  }
  return host;
}

export function main(argv) {
  const { opts, positionals } = parseArgs(argv, SPEC);
  if (opts.help) {
    const help = readFileSync(new URL(import.meta.url), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("//"))
      .map((l) => l.replace(/^\/\/ ?/, ""));
    console.log(help.join("\n"));
    return 0;
  }
  if (positionals.length) throw usageError(`Unexpected argument: ${positionals[0]}`);
  const host = validate(opts);
  const file = resolveEnvFile(opts);
  assertNotDemoEnvFile(file);
  if (!existsSync(file)) throw usageError(`${file} does not exist: run \`pnpm ocw setup\` first.`);

  const current = readFileSync(file, "utf8");
  const { origin, entries } = proxySettings(parseEnvText(current), host, { tls: opts.tls });
  // Settings land on their documented (commented) template line when there is one; every other byte is kept.
  const next = updateEnvText(current, entries, {
    uncomment: true,
    header: "Written by pnpm ocw enable proxy",
  });
  if (next !== current) writePrivate(file, next);
  reportWritten(Object.keys(entries), file);
  console.log(`Public URL: ${origin} (web, API, WebSockets and attachments through Caddy)`);

  if (opts["no-up"]) {
    console.log("Not started (--no-up). Apply with: docker compose up -d --wait");
    return 0;
  }
  const status = runCompose(file, ["up", "-d", "--wait"]);
  if (status !== 0) {
    console.error(`docker compose up exited ${status}; the env file is already updated, re-run to retry.`);
    return status;
  }
  console.log(`Proxy enabled: open ${origin}`);
  return 0;
}

export function runMain(argv = process.argv.slice(2)) {
  try {
    process.exitCode = main(argv);
  } catch (err) {
    console.error(err.message);
    process.exitCode = err.usage ? 2 : 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) runMain();
