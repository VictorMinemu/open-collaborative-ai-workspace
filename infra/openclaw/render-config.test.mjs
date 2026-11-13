// node --test 'infra/**/*.test.mjs'
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { BUNDLED_PLUGINS_DIR, DANGEROUS_TOOLS, INSTALL_POLICY_PATH, renderConfig } from "./render-config.mjs";

const base = { OCW_API_URL: "http://api:4000", OCW_CELL_TOKEN_FILE: "/run/secrets/ocw_cell_token" };

describe("renderConfig", () => {
  it("locks the gateway down: loopback, no control UI, no mDNS, no update check, no memory slot", () => {
    const { config, errors } = renderConfig(base);
    assert.deepEqual(errors, []);
    assert.equal(config.gateway.bind, "loopback");
    assert.equal(config.gateway.controlUi.enabled, false);
    assert.equal(config.discovery.mdns.mode, "off");
    assert.equal(config.update.checkOnStart, false);
    assert.equal(config.plugins.slots.memory, "none");
    assert.deepEqual(config.plugins.entries.openai, { enabled: true, config: { personality: "off" } });
    assert.deepEqual(config.plugins.deny, ["codex"]);
    assert.equal(config.agents.defaults.heartbeat.every, "0m");
  });

  it("OpenClaw's own automations stay off (07.6 C-01): no cron scheduler, no webhook ingress, no sessions_send", () => {
    const { config } = renderConfig(base);
    // Automations are scheduled, verified and audited by the Control Plane; the cell only answers delivered turns.
    assert.deepEqual(config.cron, { enabled: false });
    assert.deepEqual(config.hooks, { enabled: false });
    assert.equal(config.tools.deny.includes("group:sessions"), true);
    assert.equal(config.tools.deny.includes("group:automation"), true);
  });

  it("OpenClaw's own agent-to-agent stays off (07.7 C-01, D-02): no cross-agent session access, sessions see only themselves", () => {
    const { config } = renderConfig(base);
    // Bots consult each other only through ocw_consult_agent and the Agent Channel API (resolver, RLS, audit). The
    // pinned image defaults agentToAgent to on (an omitted allow permits every pair): pinned off as defence in depth.
    assert.deepEqual(config.tools.agentToAgent, { enabled: false });
    assert.equal(config.tools.sessions.visibility, "self");
    assert.equal(config.tools.profile, "minimal");
    assert.equal(config.tools.deny.includes("group:sessions"), true);
    assert.equal(config.tools.deny.includes("group:messaging"), true);
    // 07.6's pins still hold next to them.
    assert.deepEqual(config.cron, { enabled: false });
    assert.deepEqual(config.hooks, { enabled: false });
  });

  it("tools are an allowlist: minimal profile + explicit dangerous denies, never the wildcard or a web tool", () => {
    const { config } = renderConfig(base);
    assert.equal(config.tools.profile, "minimal");
    assert.equal(config.tools.toolSearch, false);
    assert.equal(config.tools.elevated.enabled, false);
    // Code Mode hides every tool behind `exec`, which is denied: a bot would be offered nothing it can call.
    assert.equal(config.tools.codeMode, false);
    assert.deepEqual(config.tools.deny, DANGEROUS_TOOLS);
    assert.equal(config.tools.deny.includes("*"), false);
    for (const t of ["web_search", "web_fetch", "ocw_memory_save"])
      assert.equal(config.tools.deny.includes(t), false);
    for (const t of [
      "exec",
      "process",
      "read",
      "write",
      "edit",
      "apply_patch",
      "browser",
      "canvas",
      "gateway",
    ]) {
      assert.ok(config.tools.deny.includes(t), `${t} must be denied`);
    }
    for (const t of [
      "openclaw",
      "message",
      "nodes",
      "x_search",
      "code_execution",
      "group:runtime",
      "group:fs",
    ]) {
      assert.ok(config.tools.deny.includes(t), `${t} must be denied`);
    }
    for (const g of [
      "group:ui",
      "group:automation",
      "group:nodes",
      "group:sessions",
      "group:messaging",
      "group:media",
    ]) {
      assert.ok(config.tools.deny.includes(g), `${g} must be denied`);
    }
  });

  it("search is managed and hookable: provider pinned, hosted Codex search off, fetch capped", () => {
    const { config } = renderConfig(base);
    assert.deepEqual(config.tools.web.search, {
      enabled: true,
      provider: "duckduckgo",
      maxResults: 5,
      openaiCodex: { enabled: false },
    });
    assert.deepEqual(config.tools.web.fetch, { enabled: true, maxCharsCap: 20000, maxRedirects: 3 });
  });

  it("bundles DuckDuckGo and SearXNG plugins by default; SearXNG URL switches the provider", () => {
    const { config, skipped } = renderConfig(base);
    assert.deepEqual(skipped, []);
    assert.deepEqual(config.plugins.allow, ["ocw", "openai", "duckduckgo", "searxng"]);
    assert.ok(config.plugins.load.paths.includes(`${BUNDLED_PLUGINS_DIR}/duckduckgo`));
    assert.ok(config.plugins.load.paths.includes(`${BUNDLED_PLUGINS_DIR}/searxng`));
    assert.equal(config.plugins.entries.searxng, undefined);

    const withSearx = renderConfig({ ...base, OCW_SEARXNG_URL: "http://searxng:8080" }).config;
    assert.equal(withSearx.tools.web.search.provider, "searxng");
    assert.deepEqual(withSearx.plugins.entries.searxng, {
      enabled: true,
      config: { webSearch: { baseUrl: `$${"{"}OCW_SEARXNG_URL}` } }, // an env reference
    });
    // The URL itself never lands in the file (env reference only).
    assert.equal(JSON.stringify(withSearx).includes("searxng:8080"), false);
  });

  it("OCW_BUNDLED_PLUGINS=none removes the bundled plugins from allow and paths", () => {
    const { config, skipped } = renderConfig({
      ...base,
      OCW_BUNDLED_PLUGINS: "none",
      OCW_SEARXNG_URL: "http://s:8080",
    });
    assert.deepEqual(config.plugins.allow, ["ocw", "openai"]);
    assert.equal(
      config.plugins.load.paths.some((p) => p.startsWith(BUNDLED_PLUGINS_DIR)),
      false,
    );
    assert.equal(config.plugins.entries.searxng, undefined);
    assert.deepEqual(skipped, []);
  });

  it("no search provider is pinned until one is loaded: none bundled and none installed leaves it unset", () => {
    // OCW_BUNDLED_PLUGINS=none, DuckDuckGo not installed yet: pinning `duckduckgo` would name a missing plugin.
    const none = renderConfig({ ...base, OCW_BUNDLED_PLUGINS: "none" }).config;
    assert.equal("provider" in none.tools.web.search, false);
    assert.equal(none.tools.web.search.enabled, true);
    assert.deepEqual(none.tools.web.search.openaiCodex, { enabled: false });
    // SearXNG bundled without a URL cannot serve either.
    const noUrl = renderConfig({ ...base, OCW_BUNDLED_PLUGINS: "searxng" }).config;
    assert.equal("provider" in noUrl.tools.web.search, false);
    // Installed from the marketplace (re-allowed at boot): DuckDuckGo is loaded, so it is pinned again.
    const installed = renderConfig(
      { ...base, OCW_BUNDLED_PLUGINS: "none" },
      { installedPlugins: [{ id: "duckduckgo" }] },
    ).config;
    assert.equal(installed.tools.web.search.provider, "duckduckgo");
  });

  it("a bundled plugin missing from the image is skipped (allow, paths, entries), never an error", () => {
    const { config, errors, skipped } = renderConfig(
      { ...base, OCW_SEARXNG_URL: "http://searxng:8080" },
      { bundledPresent: (id) => id !== "searxng" },
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(skipped, ["searxng"]);
    assert.deepEqual(config.plugins.allow, ["ocw", "openai", "duckduckgo"]);
    assert.equal(config.plugins.load.paths.includes(`${BUNDLED_PLUGINS_DIR}/searxng`), false);
    assert.equal(config.plugins.entries.searxng, undefined);
    // Falls back to the plugin that is actually there.
    assert.equal(config.tools.web.search.provider, "duckduckgo");
  });

  it("DMs never share a session; dates are deterministic; no background memory flush", () => {
    const { config } = renderConfig(base);
    assert.deepEqual(config.session, { dmScope: "per-channel-peer" });
    assert.equal(config.agents.defaults.userTimezone, "UTC");
    assert.equal(config.agents.defaults.compaction.memoryFlush.enabled, false);
  });

  it("long conversations are summarized leniently from boot, before the first snapshot (quick 261113-id6)", () => {
    const { config } = renderConfig(base);
    // OpenClaw 2026.9.7 runs the safeguard quality guard unless it is set to false (`qualityGuardCfg?.enabled ?? true`)
    // and keeps identifiers strict by default: a long conversation could get stuck on its summary. The plugin then
    // applies the organization's choice (BotPolicy.conversations).
    assert.deepEqual(config.agents.defaults.compaction, {
      mode: "safeguard",
      qualityGuard: { enabled: false },
      identifierPolicy: "off",
      keepRecentTokens: 20000,
      memoryFlush: { enabled: false },
    });
  });

  it("OpenClaw's own sandbox is pinned off; its exec, file, process and browser tools stay denied (07.8 D-11, F-1)", () => {
    for (const env of [
      base,
      { ...base, OCW_BUNDLED_PLUGINS: "none" },
      { ...base, OCW_SEARXNG_URL: "http://x:8080" },
    ]) {
      const { config } = renderConfig(env);
      // Nothing else under sandbox: no backend, no scope, no browser, no docker settings.
      assert.deepEqual(config.agents.defaults.sandbox, { mode: "off" });
      for (const t of [
        "exec",
        "read",
        "write",
        "process",
        "browser",
        "canvas",
        "group:runtime",
        "group:fs",
      ]) {
        assert.ok(config.tools.deny.includes(t), `${t} must stay denied`);
      }
    }
    // DANGEROUS_TOOLS is not shortened: every core exec, file and browser name is still there (the contracts parity test
    // in apps/openclaw-channel/src/reconciler.test.ts holds it equal to DANGEROUS_TOOL_NAMES).
    for (const t of ["exec", "read", "write", "process", "browser", "canvas", "apply_patch", "edit", "ls"]) {
      assert.ok(DANGEROUS_TOOLS.includes(t), `${t} must stay in DANGEROUS_TOOLS`);
    }
    // The confined tools are never denied: they are the only way to a sandbox or a browser.
    const { config } = renderConfig(base);
    for (const t of ["ocw_sandbox_exec", "ocw_browser_open"])
      assert.equal(config.tools.deny.includes(t), false);
  });

  it("MCP: no server at boot (the plugin renders them from GET /cell), idle runtimes evicted after 10 minutes", () => {
    const { config } = renderConfig(base);
    assert.deepEqual(config.mcp, { sessionIdleTtlMs: 600000 });
  });

  it("never writes secrets: no token, no provider keys, no providers or bots at all", () => {
    const { config } = renderConfig({
      ...base,
      OCW_CELL_TOKEN: "cell-SECRET",
      ANTHROPIC_API_KEY: "sk-ant-SECRET",
    });
    const serialized = JSON.stringify(config);
    assert.equal(serialized.includes("SECRET"), false);
    assert.equal(config.models, undefined);
    assert.equal(config.agents.entries, undefined);
  });

  it("fails fast on missing required inputs", () => {
    const { errors } = renderConfig({});
    assert.equal(errors.length, 2);
  });

  // ---------------------------------------------------------------- marketplace (03.1-12, D-14)

  it("every plugin install goes through the install gate: absolute node + /opt/ocw/install-policy.mjs, two env names", () => {
    const { config } = renderConfig(base, { nodePath: "/usr/local/bin/node" });
    assert.deepEqual(config.security.installPolicy, {
      enabled: true,
      targets: ["plugin"],
      exec: {
        source: "exec",
        command: "/usr/local/bin/node",
        args: [INSTALL_POLICY_PATH],
        timeoutMs: 10000,
        passEnv: ["OCW_API_URL", "OCW_CELL_TOKEN_FILE"],
        // OpenClaw checks the command AND the script argument against trustedDirs.
        trustedDirs: ["/usr/local/bin", "/opt/ocw"],
      },
    });
    assert.equal(INSTALL_POLICY_PATH, "/opt/ocw/install-policy.mjs");
    assert.ok(path.isAbsolute(config.security.installPolicy.exec.command));
    // Default: the node running the entrypoint (the gateway's own node).
    assert.equal(renderConfig(base).config.security.installPolicy.exec.command, process.execPath);
  });

  it("installedPlugins are re-allowed at boot with conversation access and prompt injection off", () => {
    const env = { ...base, OCW_BUNDLED_PLUGINS: "searxng" };
    const { config } = renderConfig(env, { installedPlugins: [{ id: "duckduckgo" }] });
    assert.ok(config.plugins.allow.includes("duckduckgo"));
    assert.deepEqual(config.plugins.entries.duckduckgo, {
      enabled: true,
      hooks: { allowConversationAccess: false, allowPromptInjection: false },
    });
    // A bundled copy wins: the same id is never allowed twice nor re-rendered as a marketplace entry.
    const bundled = renderConfig(base, { installedPlugins: [{ id: "duckduckgo" }] }).config;
    assert.deepEqual(bundled.plugins.allow, ["ocw", "openai", "duckduckgo", "searxng"]);
    assert.equal(bundled.plugins.entries.duckduckgo, undefined);
  });

  it("with OCW_BUNDLED_PLUGINS=none an installed DuckDuckGo is allowed once and never loaded from the image path", () => {
    const { config } = renderConfig(
      { ...base, OCW_BUNDLED_PLUGINS: "none" },
      { installedPlugins: [{ id: "duckduckgo" }, { id: "duckduckgo" }, { id: "ocw-echo" }] },
    );
    assert.deepEqual(config.plugins.allow, ["ocw", "openai", "duckduckgo", "ocw-echo"]);
    assert.deepEqual(config.plugins.load.paths, ["/opt/ocw/openclaw-channel"]);
    assert.deepEqual(config.plugins.entries["ocw-echo"].hooks, {
      allowConversationAccess: false,
      allowPromptInjection: false,
    });
  });

  it("an installed plugin never overrides our own plugins or the deny list; malformed ids are ignored", () => {
    const { config } = renderConfig(base, {
      installedPlugins: [{ id: "ocw" }, { id: "openai" }, { id: "codex" }, { id: "../x" }, { id: "" }, {}],
    });
    assert.deepEqual(config.plugins.allow, ["ocw", "openai", "duckduckgo", "searxng"]);
    assert.deepEqual(config.plugins.entries.openai, { enabled: true, config: { personality: "off" } });
    assert.equal(config.plugins.entries.codex, undefined);
    assert.deepEqual(config.plugins.deny, ["codex"]);
  });

  it("no installed plugin changes nothing else", () => {
    assert.deepEqual(renderConfig(base, { installedPlugins: [] }).config, renderConfig(base, {}).config);
  });
});
