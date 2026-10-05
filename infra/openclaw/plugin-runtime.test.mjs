// node --test 'infra/**/*.test.mjs'
//
// The cell image installs the channel plugin's runtime dependencies with `npm ci` from infra/openclaw/plugin-runtime
// (03.1-12; closes the 03.1-10 "no lockfile" item). This keeps that manifest and lock honest: same top-level pins as
// the plugin, every tarball from the npm registry with a sha512 integrity, overrides actually applied.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const plugin = read("../../apps/openclaw-channel/package.json");
const manifest = read("./plugin-runtime/package.json");
const lock = read("./plugin-runtime/package-lock.json");

describe("plugin runtime lock", () => {
  it("pins exactly the plugin's runtime dependencies", () => {
    assert.deepEqual(manifest.dependencies, plugin.dependencies);
    assert.deepEqual(lock.packages[""].dependencies, plugin.dependencies);
    for (const [name, version] of Object.entries(plugin.dependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+$/u, `${name} must be an exact version`);
      assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `${name} locked at ${version}`);
    }
  });

  it("every locked tarball comes from the npm registry with a sha512 integrity", () => {
    const entries = Object.entries(lock.packages).filter(([key]) => key !== "");
    assert.ok(entries.length > 0);
    for (const [key, entry] of entries) {
      assert.match(
        entry.resolved ?? "",
        /^https:\/\/registry\.npmjs\.org\//u,
        `${key} resolved from the registry`,
      );
      assert.match(entry.integrity ?? "", /^sha512-/u, `${key} has a sha512 integrity`);
    }
  });

  it("transitive overrides are applied in the lock", () => {
    for (const [name, version] of Object.entries(manifest.overrides ?? {})) {
      const locked = Object.entries(lock.packages).filter(([key]) => key.endsWith(`node_modules/${name}`));
      assert.ok(locked.length > 0, `${name} is in the lock`);
      for (const [key, entry] of locked) assert.equal(entry.version, version, `${key} pinned to ${version}`);
    }
  });
});
