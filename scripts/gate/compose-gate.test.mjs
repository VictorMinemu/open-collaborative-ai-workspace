// node --test scripts/gate/compose-gate.test.mjs
//
// `pnpm gate:compose` stage selection (no Docker): the default run, --steps subsets in canonical order, the profile
// flags appending their stages, and unknown names refused before anything starts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_STAGES, STAGES, selectStages } from "./compose-gate.mjs";

describe("selectStages", () => {
  it("runs compose, playwright, proxy, schema-refusal and backup by default", () => {
    assert.deepEqual(selectStages(), ["compose", "playwright", "proxy", "schema-refusal", "backup"]);
    assert.deepEqual(selectStages(), DEFAULT_STAGES);
  });

  it("--with-observability and --with-vault add their stages after the default ones", () => {
    assert.deepEqual(selectStages({ withObservability: true, withVault: true }), STAGES);
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

  it("refuses an unknown stage name", () => {
    assert.throws(() => selectStages({ steps: "playwright,scenario-c" }), /unknown stage.*scenario-c/);
  });
});
