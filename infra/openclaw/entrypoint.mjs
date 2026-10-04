#!/usr/bin/env node
// OCW cell entrypoint: render the locked-down OpenClaw base config, then hand over to the image's
// own entrypoint (doctor --fix + gateway). Bots and model providers (keys included) are provisioned
// at runtime by the ocw channel plugin from GET /agent-channel/v1/cell.
//
// Env (see infra/openclaw/README.md):
//   OCW_API_URL                    Agent Channel API base, e.g. http://api:4000          (required)
//   OCW_CELL_TOKEN_FILE            file with the cell bearer token (or OCW_CELL_TOKEN)    (required)
//   OPENCLAW_GATEWAY_TOKEN[_FILE]  operator token (random per boot when unset; port is loopback-only)
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderConfig } from "./render-config.mjs";

function fail(message) {
  console.error(`[ocw-cell] ${message}`);
  process.exit(78); // EX_CONFIG
}

if (process.env.OPENCLAW_GATEWAY_TOKEN_FILE) {
  try {
    process.env.OPENCLAW_GATEWAY_TOKEN = readFileSync(process.env.OPENCLAW_GATEWAY_TOKEN_FILE, "utf8").trim();
  } catch (error) {
    fail(
      `cannot read OPENCLAW_GATEWAY_TOKEN_FILE: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  delete process.env.OPENCLAW_GATEWAY_TOKEN_FILE;
}
if (process.env.OCW_CELL_TOKEN_FILE && !existsSync(process.env.OCW_CELL_TOKEN_FILE)) {
  fail(`OCW_CELL_TOKEN_FILE does not exist: ${process.env.OCW_CELL_TOKEN_FILE}`);
}
if (!process.env.OPENCLAW_GATEWAY_TOKEN) {
  // The gateway listens on loopback inside the container only; nobody outside needs this token.
  process.env.OPENCLAW_GATEWAY_TOKEN = randomBytes(32).toString("hex");
}
process.env.OPENCLAW_NO_AUTO_UPDATE = "1";
process.env.OPENCLAW_DISABLE_BONJOUR = "1";

const stateDir = process.env.OPENCLAW_STATE_DIR ?? "/home/node/.openclaw";
const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = configPath;

const { config, errors } = renderConfig(process.env);
if (errors.length > 0) fail(`invalid configuration:\n  - ${errors.join("\n  - ")}`);

mkdirSync(path.dirname(configPath), { recursive: true });
// The rendered config is authoritative on every boot. OpenClaw otherwise sees it as a suspicious
// "size drop" versus its last known good config (which also holds the previous run's provisioned
// bots) and auto-restores `openclaw.json.bak`, silently undoing base-config changes such as the
// plugin allowlist. Without a `.bak` there is nothing to restore (OpenClaw 2026.9.7
// planSuspiciousConfigRead); bots and providers are re-provisioned by the plugin in about a second.
for (const stale of [`${configPath}.bak`, `${configPath}.last-good`]) rmSync(stale, { force: true });
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(
  `[ocw-cell] base config rendered (plugins.allow=${config.plugins.allow.join(",")}); bots + providers come from the Agent Channel API`,
);

const argv = process.argv.slice(2);
const command = argv.length > 0 ? argv : ["node", "openclaw.mjs", "gateway"];
// Same hand-off as the upstream image: /app/docker-entrypoint.mjs runs `doctor --fix` then execs.
process.execve(process.execPath, [process.execPath, "/app/docker-entrypoint.mjs", ...command], process.env);
