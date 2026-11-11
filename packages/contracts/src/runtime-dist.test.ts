import { describe, expect, it } from "vitest";
import {
  BUNDLE_LICENSE_ALLOWLIST,
  RUNTIME_BUNDLE_FILE,
  RUNTIME_EXTERNAL_LOCK_FILE,
  RUNTIME_ROUTES,
  RuntimeDistManifest,
  runtimeInstallCommand,
} from "./runtime-dist";

const manifest = {
  version: "0.1.0",
  sha256: "a".repeat(64),
  bytes: 2_644_493,
  file: "ocw-runtime.mjs",
  minNode: 24,
  external: [
    { name: "@anthropic-ai/claude-agent-sdk", version: "0.3.282" },
    { name: "@anthropic-ai/sdk", version: "0.128.0" },
    { name: "@modelcontextprotocol/sdk", version: "1.30.1" },
    { name: "zod", version: "4.6.5" },
  ],
  externalLockSha256: "b".repeat(64),
  bundled: [
    { name: "ws", version: "8.21.3", license: "MIT" },
    { name: "zod", version: "4.6.5", license: "MIT" },
  ],
  source: {
    repository: "https://github.com/VictorMinemu/open-collaborative-ai-workspace",
    commit: "0123456789abcdef0123456789abcdef01234567",
  },
  builtAt: "2026-10-29T10:00:00.000Z",
};

describe("RuntimeDistManifest (07.12, D-01, D-10, D-13)", () => {
  it("parses a manifest with every field, and one without a known commit", () => {
    expect(RuntimeDistManifest.parse(manifest)).toEqual(manifest);
    const noCommit = { ...manifest, source: { ...manifest.source, commit: null } };
    expect(RuntimeDistManifest.safeParse(noCommit).success).toBe(true);
  });

  it.each([
    ["a 63-character sha256", { sha256: "a".repeat(63) }],
    ["another file name", { file: "runtime.js" }],
    ["minNode 22", { minNode: 22 }],
    ["an empty external list", { external: [] }],
    ["an external list that does not start with the SDK", { external: [{ name: "zod", version: "4.6.5" }] }],
    [
      "a bundled Claude Agent SDK",
      { bundled: [{ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.282", license: "MIT" }] },
    ],
    ["a bundled GPL package", { bundled: [{ name: "left-pad", version: "1.0.0", license: "GPL-3.0" }] }],
    [
      "an external range instead of an exact version",
      { external: [{ name: "@anthropic-ai/claude-agent-sdk", version: "^0.3.0" }] },
    ],
    ["no lockfile sha256", { externalLockSha256: undefined }],
    ["a short lockfile sha256", { externalLockSha256: "b".repeat(63) }],
    ["an extra key", { extra: true }],
  ])("refuses %s", (_label, patch) => {
    expect(RuntimeDistManifest.safeParse({ ...manifest, ...patch }).success).toBe(false);
  });

  it("names the file, the routes and the install command", () => {
    expect(RUNTIME_BUNDLE_FILE).toBe("ocw-runtime.mjs");
    expect(RUNTIME_EXTERNAL_LOCK_FILE).toBe("npm-shrinkwrap.json");
    expect(RUNTIME_ROUTES).toEqual({
      installScript: "/api/v1/runtime/install.sh",
      bundle: "/api/v1/runtime/bundle",
      bundleSha256: "/api/v1/runtime/bundle.sha256",
      version: "/api/v1/runtime/version",
      externalLock: "/api/v1/runtime/npm-shrinkwrap.json",
    });
    expect(runtimeInstallCommand("https://ocw.example.com/")).toBe(
      "curl -fsSL https://ocw.example.com/api/v1/runtime/install.sh | sh",
    );
    expect(runtimeInstallCommand("http://localhost:4000")).toBe(
      "curl -fsSL http://localhost:4000/api/v1/runtime/install.sh | sh",
    );
  });

  it("allows only permissive licenses", () => {
    expect([...BUNDLE_LICENSE_ALLOWLIST]).toEqual([
      "MIT",
      "ISC",
      "Apache-2.0",
      "BSD-2-Clause",
      "BSD-3-Clause",
      "0BSD",
      "BlueOak-1.0.0",
    ]);
  });
});
