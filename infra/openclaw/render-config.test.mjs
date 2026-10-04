// node --test 'infra/**/*.test.mjs'
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DENIED_TOOLS, renderConfig } from "./render-config.mjs";

const base = { OCW_API_URL: "http://api:4000", OCW_CELL_TOKEN_FILE: "/run/secrets/ocw_cell_token" };

describe("renderConfig", () => {
  it("locks the gateway down: loopback, no control UI, no mDNS, no update check, no memory, tools off", () => {
    const { config, errors } = renderConfig(base);
    assert.deepEqual(errors, []);
    assert.equal(config.gateway.bind, "loopback");
    assert.equal(config.gateway.controlUi.enabled, false);
    assert.equal(config.discovery.mdns.mode, "off");
    assert.equal(config.update.checkOnStart, false);
    assert.equal(config.plugins.slots.memory, "none");
    assert.deepEqual(config.plugins.allow, ["ocw", "openai"]);
    assert.deepEqual(config.plugins.entries.openai, { enabled: true, config: { personality: "off" } });
    assert.deepEqual(config.plugins.deny, ["codex"]);
    assert.equal(config.tools.profile, "minimal");
    assert.equal(config.tools.toolSearch, false);
    assert.equal(config.tools.elevated.enabled, false);
    assert.deepEqual(config.tools.deny, DENIED_TOOLS);
    assert.equal(config.agents.defaults.heartbeat.every, "0m");
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
});
