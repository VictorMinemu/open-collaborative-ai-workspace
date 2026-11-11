import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNTIME_BUNDLE_FILE, RUNTIME_EXTERNAL_LOCK_FILE, RuntimeDistManifest } from "@ocw/contracts";

/**
 * Test-only (07.17.1-03, PD-15, PD-16): a Local Runtime dist directory the API's `RuntimeDistStore` verifies, so an
 * integration test can serve a runtime without building the real bundle.
 *
 * `writeRuntimeDist(dir, opts)` writes `manifest.json`, `ocw-runtime.mjs` and `npm-shrinkwrap.json`, consistent with
 * each other (the manifest's `sha256`, `bytes` and `externalLockSha256` are computed over the files written), and
 * returns what it wrote. Defaults: version `0.3.1`, a tiny bundle, and the two-pin lockfile rooted at
 * `ocw-runtime-deps` that `runtimeExternalFiles` accepts. No network, no npm, nothing outside `dir`.
 */

export const TEST_RUNTIME_PINS = [
  { name: "@anthropic-ai/claude-agent-sdk", version: "0.3.282" },
  { name: "zod", version: "4.6.5" },
] as const;

/** The npm lockfile shape `build-bundle.mjs` writes, rooted at the pins (lockfile v3). */
export function testRuntimeLock(pins: readonly { name: string; version: string }[] = TEST_RUNTIME_PINS): string {
  return `${JSON.stringify(
    {
      name: "ocw-runtime-deps",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "ocw-runtime-deps",
          dependencies: Object.fromEntries(pins.map((p) => [p.name, p.version])),
        },
      },
    },
    null,
    2,
  )}\n`;
}

const sha256Hex = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export async function writeRuntimeDist(
  dir: string,
  opts: { version?: string; bundle?: Buffer; lock?: string } = {},
): Promise<{ manifest: RuntimeDistManifest; bundle: Buffer; lock: string }> {
  const bundle =
    opts.bundle ?? Buffer.from('#!/usr/bin/env node\nconsole.log("ocw-runtime test bundle");\n');
  const lock = opts.lock ?? testRuntimeLock();
  const manifest = RuntimeDistManifest.parse({
    version: opts.version ?? "0.3.1",
    sha256: sha256Hex(bundle),
    bytes: bundle.length,
    file: RUNTIME_BUNDLE_FILE,
    minNode: 24,
    external: TEST_RUNTIME_PINS.map((p) => ({ ...p })),
    externalLockSha256: sha256Hex(lock),
    bundled: [{ name: "ws", version: "8.21.3", license: "MIT" }],
    source: { repository: "https://github.com/VictorMinemu/open-collaborative-ai-workspace", commit: null },
    builtAt: "2026-11-11T08:00:00.000Z",
  });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(dir, RUNTIME_BUNDLE_FILE), bundle);
  await writeFile(join(dir, RUNTIME_EXTERNAL_LOCK_FILE), lock);
  return { manifest, bundle, lock };
}
