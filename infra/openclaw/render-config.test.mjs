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

  it("tools are an allowlist: minimal profile + explicit dangerous denies, never the wildcard or a web tool", () => {
    const { config } = renderConfig(base);
    assert.equal(config.tools.profile, "minimal");
    assert.equal(config.tools.toolSearch, false);
    assert.equal(config.tools.elevated.enabled, false);
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
