// Renders the locked-down OpenClaw base config for an OCW cell (pure; unit-tested).
//
// Bots (`agents.entries.ocw-*`) and model providers (`models.providers.*`, keys included) are NOT
// configured here: the plugin provisions them at start from `GET /agent-channel/v1/cell` (runtime
// config mutation, hot-applied). Provider keys live only in the gateway process env, referenced from
// the config as `${OCW_PROVIDER_KEY_<ID>}`; those references cannot be resolved before the plugin
// runs, so plugin-owned entries are deliberately dropped at every boot and re-provisioned (~1 s).

export const PLUGIN_DIR_DEFAULT = "/opt/ocw/openclaw-channel";

/** Tools the model must never see. `*` + the explicit 2026.9.7 default set (verified ⇒ 0 tools). */
export const DENIED_TOOLS = [
  "*",
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
];

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** @param {Record<string, string | undefined>} env  process env AFTER *_FILE secrets were loaded */
export function renderConfig(env) {
  const errors = [];
  if (!nonEmpty(env.OCW_API_URL)) errors.push("OCW_API_URL is required (e.g. http://api:4000)");
  if (!nonEmpty(env.OCW_CELL_TOKEN_FILE) && !nonEmpty(env.OCW_CELL_TOKEN)) {
    errors.push("OCW_CELL_TOKEN_FILE (preferred) or OCW_CELL_TOKEN is required");
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
      // Only our channel. Model providers are plain config entries (anthropic-messages /
      // openai-completions), so no provider plugin needs to load.
      allow: ["ocw"],
      // With no providers at boot, the implicit default model routes to the Codex runtime and
      // `doctor --fix` would add `codex` to the allowlist; an explicit deny blocks that repair.
      deny: ["codex"],
      load: { paths: [nonEmpty(env.OCW_PLUGIN_DIR) ?? PLUGIN_DIR_DEFAULT] },
      slots: { memory: "none" },
    },
    channels: { ocw: { enabled: true } },
    agents: {
      defaults: {
        skipBootstrap: true,
        contextInjection: "never",
        // No background model calls (metered): bots only speak when mentioned.
        heartbeat: { every: "0m" },
      },
    },
    tools: {
      profile: "minimal",
      toolSearch: false,
      elevated: { enabled: false },
      deny: DENIED_TOOLS,
    },
  };
  return { config, errors };
}
