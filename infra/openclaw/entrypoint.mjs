#!/usr/bin/env node
// OCW cell entrypoint: render the locked-down OpenClaw base config, then hand over to the image's
// own entrypoint (doctor --fix + gateway). Bots and model providers (keys included) are provisioned
// at runtime by the ocw channel plugin from GET /agent-channel/v1/cell.
//
// Env (see infra/openclaw/README.md):
//   OCW_API_URL                    Agent Channel API base, e.g. http://api:4000          (required)
//   OCW_CELL_TOKEN_FILE            file with the cell bearer token (or OCW_CELL_TOKEN)    (required)
//   OPENCLAW_GATEWAY_TOKEN[_FILE]  operator token (random per boot when unset; port is loopback-only)
//   OCW_BUNDLED_PLUGINS            bundled search plugins to load (default duckduckgo,searxng; none)
//   OCW_SEARXNG_URL                SearXNG base URL (compose profile `search`); switches the provider
//
// Marketplace plugins (03.1-12, D-14): OpenClaw keeps installed plugins in the state volume, but this file is
// re-rendered every boot, so the installed ids are asked from the API (`GET /agent-channel/v1/plugins`, cell token,
// 5 s) and re-added to the restrictive allowlist with their hook restrictions. Only when the API cannot be reached
// the boot cache written by the plugin (`<state>/ocw-plugins.json`) is used: it can only re-enable plugins that are
// already on disk (inside the in-process residual risk of T-03.1-12-10) and is never used to approve an install.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUNDLED_PLUGINS_DIR, renderConfig } from "./render-config.mjs";

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
// Marketplace installs (03.1-12): OpenClaw plans each plugin's `openclaw` peer with npm against the registry. A cell
// without registry egress (the offline smoke, air-gapped deployments) would wait ~8 minutes per install on npm's
// default retries; bound them (an operator's own npm_config_* wins). No telemetry to ClawHub from this process tree.
const NPM_BOUNDS = {
  npm_config_fetch_retries: "1",
  npm_config_fetch_retry_mintimeout: "2000",
  npm_config_fetch_retry_maxtimeout: "5000",
  npm_config_fetch_timeout: "30000",
};
for (const [key, value] of Object.entries(NPM_BOUNDS)) process.env[key] ??= value;
process.env.CLAWHUB_DISABLE_TELEMETRY = "1";

const stateDir = process.env.OPENCLAW_STATE_DIR ?? "/home/node/.openclaw";
const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = configPath;

/** The cell token, as the plugin reads it (file first). */
function cellToken() {
  if (process.env.OCW_CELL_TOKEN_FILE) {
    try {
      return readFileSync(process.env.OCW_CELL_TOKEN_FILE, "utf8").trim();
    } catch {
      return "";
    }
  }
  return (process.env.OCW_CELL_TOKEN ?? "").trim();
}

/** Installed marketplace plugin ids: the API's answer, else the boot cache (one log line). */
async function installedPlugins() {
  const api = (process.env.OCW_API_URL ?? "").trim().replace(/\/+$/u, "");
  let why;
  if (api) {
    try {
      const res = await fetch(`${api}/agent-channel/v1/plugins`, {
        headers: { authorization: `Bearer ${cellToken()}`, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const body = await res.json();
        const list = Array.isArray(body?.plugins) ? body.plugins : [];
        return list
          .filter((p) => p?.status === "installed" && typeof p.pluginId === "string")
          .map((p) => ({ id: p.pluginId }));
      }
      why = `HTTP ${res.status}`;
    } catch (error) {
      why = error instanceof Error ? error.name : "error";
    }
  } else {
    why = "no OCW_API_URL";
  }
  let cached = [];
  try {
    const cache = JSON.parse(readFileSync(path.join(stateDir, "ocw-plugins.json"), "utf8"));
    cached = (Array.isArray(cache?.installed) ? cache.installed : [])
      .filter((p) => typeof p?.pluginId === "string")
      .map((p) => ({ id: p.pluginId }));
  } catch {
    /* missing or malformed cache: no marketplace plugin enabled until the API answers */
  }
  console.log(
    `[ocw-cell] marketplace plugins: API unreachable at boot (${why}); boot cache lists ${cached.length} installed plugin(s)`,
  );
  return cached;
}

// An image built without a bundled plugin (or a local bind-mount setup) must still boot: skip it.
const bundledPresent = (id) => existsSync(path.join(BUNDLED_PLUGINS_DIR, id, "openclaw.plugin.json"));
const marketplace = await installedPlugins();
const { config, errors, skipped } = renderConfig(process.env, {
  bundledPresent,
  installedPlugins: marketplace,
});
if (errors.length > 0) fail(`invalid configuration:\n  - ${errors.join("\n  - ")}`);
for (const id of skipped) console.log(`[ocw-cell] bundled plugin ${id} missing from the image; skipped`);

mkdirSync(path.dirname(configPath), { recursive: true });
// The rendered config is authoritative on every boot. OpenClaw otherwise sees it as a suspicious
// "size drop" versus its last known good config (which also holds the previous run's provisioned
// bots) and auto-restores `openclaw.json.bak`, silently undoing base-config changes such as the
// plugin allowlist. Without a `.bak` there is nothing to restore (OpenClaw 2026.9.7
// planSuspiciousConfigRead); bots and providers are re-provisioned by the plugin in about a second.
for (const stale of [`${configPath}.bak`, `${configPath}.last-good`]) rmSync(stale, { force: true });
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(
  `[ocw-cell] base config rendered (plugins.allow=${config.plugins.allow.join(",")}, web search=${config.tools.web.search.provider}, install gate=${config.security.installPolicy.exec.args[0]}); bots + providers come from the Agent Channel API`,
);

const argv = process.argv.slice(2);
const command = argv.length > 0 ? argv : ["node", "openclaw.mjs", "gateway"];
// Same hand-off as the upstream image: /app/docker-entrypoint.mjs runs `doctor --fix` then execs.
process.execve(process.execPath, [process.execPath, "/app/docker-entrypoint.mjs", ...command], process.env);
