// node --test scripts/gate/compose-gate.test.mjs
//
// `pnpm gate:compose` stage selection (no Docker): the default run, --steps subsets in canonical order, the profile
// flags appending their stages (--with-sandbox after compose and Playwright), and unknown names refused before anything starts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_STAGES, STAGES, selectStages, stackOptions } from "./compose-gate.mjs";

describe("selectStages", () => {
  it("runs compose, playwright, proxy, schema-refusal and backup by default", () => {
    assert.deepEqual(selectStages(), ["compose", "playwright", "proxy", "schema-refusal", "backup"]);
    assert.deepEqual(selectStages(), DEFAULT_STAGES);
  });

  it("--with-observability and --with-vault add their stages after the default ones", () => {
    assert.deepEqual(
      selectStages({ withObservability: true, withVault: true }),
      STAGES.filter((s) => s !== "sandbox"),
    );
    assert.deepEqual(selectStages({ withVault: true }).slice(-2), ["vault", "vault-backup"]);
  });

  it("--steps picks a subset and always runs it in canonical order", () => {
    assert.deepEqual(selectStages({ steps: "playwright" }), ["playwright"]);
    assert.deepEqual(selectStages({ steps: "backup, proxy,compose" }), ["compose", "proxy", "backup"]);
    assert.deepEqual(selectStages({ steps: "playwright", withVault: true }), [
      "playwright",
      "vault",
      "vault-backup",
    ]);
  });

  it("--with-sandbox adds the sandbox stage after compose and Playwright's first-run setup (07.8-24)", () => {
    assert.deepEqual(selectStages({ withSandbox: true }), [
      "compose",
      "playwright",
      "sandbox",
      "proxy",
      "schema-refusal",
      "backup",
    ]);
    assert.deepEqual(selectStages({ steps: "compose,sandbox", withSandbox: true }), ["compose", "sandbox"]);
    assert.deepEqual(selectStages({ steps: "compose", withSandbox: true }), ["compose", "sandbox"]);
    assert.deepEqual(selectStages({ withObservability: true, withVault: true, withSandbox: true }), STAGES);
    assert.ok(!selectStages().includes("sandbox"), "not in the default run");
  });

  it("the sandbox stage needs the sandbox profile: --steps sandbox without --with-sandbox is refused", () => {
    assert.throws(() => selectStages({ steps: "compose,sandbox" }), /--with-sandbox/);
  });

  it("the stack runs the sandbox profile (and the broker URL) only with --with-sandbox", () => {
    assert.deepEqual(stackOptions({ withSandbox: false }), { profiles: [], extra: {} });
    assert.deepEqual(stackOptions({ withSandbox: true }), {
      profiles: ["sandbox"],
      extra: { OCW_SANDBOX_URL: "http://sandboxd:8090" },
    });
  });

  it("refuses an unknown stage name", () => {
    assert.throws(() => selectStages({ steps: "playwright,scenario-c" }), /unknown stage.*scenario-c/);
  });
});
