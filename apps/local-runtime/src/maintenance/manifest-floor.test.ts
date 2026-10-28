// Phase 07.11 (D-04, PD-12): the bundled compatibility manifest's `supported` floor tracks the oldest committed
// adapter fixture per runtime. Recording a fixture for an older CLI, or dropping the oldest one, must move the floor
// in `packages/contracts/src/runtime-maintenance.ts` in the same change.

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compareRuntimeVersions, RUNTIME_COMPATIBILITY_MANIFEST, type RuntimeId } from "@ocw/contracts";
import { describe, expect, it } from "vitest";

const FIXTURES: Record<RuntimeId, { dir: URL; pattern: RegExp }> = {
  "claude-code": {
    dir: new URL("../claude/__fixtures__/", import.meta.url),
    pattern: /^claude-code-(\d+\.\d+\.\d+)\./,
  },
  codex: { dir: new URL("../codex/__fixtures__/", import.meta.url), pattern: /^codex-(\d+\.\d+\.\d+)\./ },
};

function oldestFixtureVersion(runtime: RuntimeId): string {
  const { dir, pattern } = FIXTURES[runtime];
  const versions = readdirSync(fileURLToPath(dir)).flatMap((name) => {
    const v = pattern.exec(name)?.[1];
    return v ? [v] : [];
  });
  expect(versions.length).toBeGreaterThan(0);
  return versions.reduce((lo, v) => (compareRuntimeVersions(v, lo) < 0 ? v : lo));
}

function supportedFloor(runtime: RuntimeId): string | undefined {
  return RUNTIME_COMPATIBILITY_MANIFEST.runtimes[runtime].ranges.find((r) => r.status === "supported")?.bounds
    .min;
}

describe("compatibility manifest floor (Phase 07.11, PD-12)", () => {
  it.each(["claude-code", "codex"] as const)(
    "%s: supported from the oldest committed adapter fixture",
    (runtime) => {
      expect(supportedFloor(runtime)).toBe(oldestFixtureVersion(runtime));
    },
  );
});
