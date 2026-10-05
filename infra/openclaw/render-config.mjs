// Renders the locked-down OpenClaw base config for an OCW cell (pure; unit-tested).
//
// Bots (`agents.entries.ocw-*`) and model providers (`models.providers.*`, keys included) are NOT
// configured here: the plugin provisions them at start from `GET /agent-channel/v1/cell` (runtime
// config mutation, hot-applied). Provider keys live only in the gateway process env, referenced from
// the config as `${OCW_PROVIDER_KEY_<ID>}`; those references cannot be resolved before the plugin
// runs, so plugin-owned entries are deliberately dropped at every boot and re-provisioned (~1 s).
//
// Tool lockdown v2 (Phase 3.1, D-08) is an ALLOWLIST with three independent guards:
//   1. config: global `tools.profile: "minimal"` + an explicit DANGEROUS deny list (no wildcard: a
//      global `*` deny would also kill the web tools, because deny always wins). Each bot gets
//      `profile: "minimal"` + `alsoAllow: <its effective tools>` + the same deny (reconciler.ts), so a
//      tool nobody granted is never configured, and a future OpenClaw tool never becomes reachable
//      just because it is not listed.
//   2. turn: every dispatch caps tools with `toolsAllow = turn.tools ∩ agent tools` (openclaw-port.ts).
//   3. call: the plugin's `before_tool_call` gate asks the Agent Channel API (tool-guard.ts).
// Search is a managed, hookable provider (DuckDuckGo by default, SearXNG when configured); OpenAI's
// hosted search is off so no search bypasses the hook and the audit.

import path from "node:path";

export const PLUGIN_DIR_DEFAULT = "/opt/ocw/openclaw-channel";
/** Official search plugins installed into the image at build time (install-bundled-plugins.sh). */
export const BUNDLED_PLUGINS_DIR = "/opt/ocw/plugins";
export const BUNDLED_PLUGIN_IDS = ["duckduckgo", "searxng"];
/** The install gate (03.1-12, D-14): OpenClaw's `security.installPolicy` exec, root-owned in the image. */
export const INSTALL_POLICY_PATH = "/opt/ocw/install-policy.mjs";
/** Plugin ids a marketplace install can never take over in the boot allowlist. */
const RESERVED_PLUGIN_IDS = new Set(["ocw", "openai", "codex"]);
const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/iu;

/**
 * Tools no bot may ever be offered. Mirrors `DANGEROUS_TOOL_NAMES` in
 * packages/contracts/src/bot-capabilities.ts (parity test: apps/openclaw-channel/src/reconciler.test.ts).
 * Never the wildcard, never `web_search` / `web_fetch` / `ocw_memory_save`.
 */
export const DANGEROUS_TOOLS = [
  "apply_patch",
  "edit",
  "exec",
  "ls",
  "openclaw",
  "process",
  "read",
  "write",
  "sessions_yield",
  "tool_call",
  "tool_describe",
  "tool_search",
  "presence",
  "session_status",
  "browser",
  "canvas",
  "message",
  "gateway",
  "nodes",
  "x_search",
  "code_execution",
  "group:runtime",
  "group:fs",
  "group:ui",
  "group:automation",
  "group:nodes",
  "group:sessions",
  "group:messaging",
  "group:media",
];

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** `OCW_BUNDLED_PLUGINS`: comma list (default every bundled plugin), `none` = nothing bundled. */
export function bundledPluginIds(env) {
  const raw = nonEmpty(env.OCW_BUNDLED_PLUGINS);
  if (raw === undefined) return [...BUNDLED_PLUGIN_IDS];
  if (raw.toLowerCase() === "none") return [];
  const wanted = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return BUNDLED_PLUGIN_IDS.filter((id) => wanted.has(id));
}

/**
 * Marketplace plugins installed in this cell (03.1-12): OpenClaw keeps their install records and package roots in
 * the state volume, but this file is re-rendered on every boot, so their allowlist entries come back from the API
 * (`GET /agent-channel/v1/plugins`, the boot cache only when the API is unreachable; Pitfall P-B1). Each gets
 * conversation access and prompt injection off (T-03.1-12-04). Our own plugins and denied ids are never taken over.
 */
function installedPluginIds(list, taken) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    const id = typeof p?.id === "string" ? p.id.trim() : "";
    if (!PLUGIN_ID.test(id) || RESERVED_PLUGIN_IDS.has(id) || taken.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * @param {Record<string, string | undefined>} env  process env AFTER *_FILE secrets were loaded
 * @param {{ bundledPresent?: (id: string) => boolean, installedPlugins?: Array<{ id: string }>, nodePath?: string }} [opts]
 *   `bundledPresent`: whether a bundled plugin directory exists in this image (the entrypoint checks the filesystem;
 *   default: assume present, keeps this pure). `installedPlugins`: marketplace plugins installed in this cell.
 *   `nodePath`: absolute node binary that runs the install gate (default: this process's).
 */
export function renderConfig(env, opts = {}) {
  const bundledPresent = opts.bundledPresent ?? (() => true);
  const nodePath = opts.nodePath ?? process.execPath;
  const errors = [];
  if (!nonEmpty(env.OCW_API_URL)) errors.push("OCW_API_URL is required (e.g. http://api:4000)");
  if (!nonEmpty(env.OCW_CELL_TOKEN_FILE) && !nonEmpty(env.OCW_CELL_TOKEN)) {
    errors.push("OCW_CELL_TOKEN_FILE (preferred) or OCW_CELL_TOKEN is required");
  }

  // A bundled plugin listed in allow/paths but missing on disk would break the boot: skip it instead.
  const skipped = [];
  const bundled = [];
  for (const id of bundledPluginIds(env)) {
    if (bundledPresent(id)) bundled.push(id);
    else skipped.push(id);
  }
  const searxngUrl = nonEmpty(env.OCW_SEARXNG_URL);
  const useSearxng = searxngUrl !== undefined && bundled.includes("searxng");

  const entries = {
    // No OpenAI "friendly personality" layer on top of each bot's own instructions.
    openai: { enabled: true, config: { personality: "off" } },
  };
  if (useSearxng) {
    // Env reference: the URL is resolved by OpenClaw from the gateway env, never written to the file.
    entries.searxng = { enabled: true, config: { webSearch: { baseUrl: `$${"{"}OCW_SEARXNG_URL}` } } };
  }
  const installed = installedPluginIds(opts.installedPlugins, new Set(bundled));
  for (const id of installed) {
    entries[id] = { enabled: true, hooks: { allowConversationAccess: false, allowPromptInjection: false } };
  }

  const config = {
    gateway: {
      mode: "local",
      port: Number(env.OPENCLAW_GATEWAY_PORT ?? 18789),
      // Loopback inside the container: the admin/operator surface is unreachable from the network.
      bind: "loopback",
      auth: { mode: "token" },
      controlUi: { enabled: false },
      tailscale: { mode: "off" },
    },
    discovery: { mdns: { mode: "off" } },
    update: { checkOnStart: false },
    plugins: {
      // Our channel, plus OpenClaw's bundled `openai` provider plugin: it owns the ChatGPT/Codex
      // device-code sign-in, the `openai` OAuth profile refresh and the Codex model catalog that the
      // "ChatGPT subscription" provider uses (ADR-0006). It must be loaded at boot: enabling it later
      // swaps plugin instances, which would abort a sign-in in progress. API-key providers stay plain
      // config entries (anthropic-messages / openai-completions). Then the bundled keyless search
      // providers (D-09).
      allow: ["ocw", "openai", ...bundled, ...installed],
      entries,
      // With no providers at boot, the implicit default model routes to the Codex runtime and
      // `doctor --fix` would add `codex` to the allowlist; an explicit deny blocks that repair. The
      // Codex plugin also owns OpenAI's hosted search, which would bypass our tool gate.
      deny: ["codex"],
      load: {
        paths: [
          nonEmpty(env.OCW_PLUGIN_DIR) ?? PLUGIN_DIR_DEFAULT,
          ...bundled.map((id) => `${BUNDLED_PLUGINS_DIR}/${id}`),
        ],
      },
      slots: { memory: "none" },
    },
    // Nothing installs itself (D-14): every plugin install or update, from the CLI or the Gateway, is staged and then
    // checked by our gate, which asks the API whether exactly this (package, version, sha256) is an admin-approved
    // install in flight; OpenClaw fails closed on a block, an error or a timeout. OpenClaw checks the command AND the
    // script argument against trustedDirs (root-owned, not group/world-writable, no symlinks).
    security: {
      installPolicy: {
        enabled: true,
        targets: ["plugin"],
        exec: {
          // Required by OpenClaw's schema (`security.installPolicy.exec.source: "exec"`).
          source: "exec",
          command: nodePath,
          args: [INSTALL_POLICY_PATH],
          timeoutMs: 10000,
          passEnv: ["OCW_API_URL", "OCW_CELL_TOKEN_FILE"],
          trustedDirs: [path.dirname(nodePath), path.dirname(INSTALL_POLICY_PATH)],
        },
      },
    },
    channels: { ocw: { enabled: true } },
    // MCP servers (D-13) are rendered by the plugin from GET /cell (only servers with a tool some bot may use).
    // MCP runtimes are per session (each DM, each thread): evict idle ones after 10 minutes (Pitfall P-B3).
    mcp: { sessionIdleTtlMs: 600000 },
    // Defence in depth: the plugin already routes one session per DM conversation (Pitfall 2).
    session: { dmScope: "per-channel-peer" },
    agents: {
      defaults: {
        skipBootstrap: true,
        contextInjection: "never",
        // No background model calls (metered): bots only speak when addressed.
        heartbeat: { every: "0m" },
        // OpenClaw always prints the current date; pin its zone (the asker's local time comes per turn).
        userTimezone: "UTC",
        compaction: { memoryFlush: { enabled: false } },
      },
    },
    tools: {
      profile: "minimal",
      toolSearch: false,
      elevated: { enabled: false },
      deny: DANGEROUS_TOOLS,
      web: {
        search: {
          enabled: true,
          // Key-free providers never auto-select: pin one so routing is deterministic and hookable.
          provider: useSearxng ? "searxng" : "duckduckgo",
          maxResults: 5,
          // ChatGPT-subscription hosted search would bypass before_tool_call and the audit.
          openaiCodex: { enabled: false },
        },
        fetch: { enabled: true, maxCharsCap: 20000, maxRedirects: 3 },
      },
    },
  };
  return { config, errors, skipped };
}
