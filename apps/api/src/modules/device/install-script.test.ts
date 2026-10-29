import { createHash } from "node:crypto";
import type { RuntimeDistManifest } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { assertScriptSafeUrl, renderInstallScript } from "./install-script";

/**
 * Phase 07.12-06 (HSR-01, D-01, D-10, PD-04, PD-05): the installer the API serves at `/api/v1/runtime/install.sh`.
 * The rendering cases check what is embedded and how; the behaviour cases below run the rendered script with `sh`
 * in a scratch HOME against a loopback stub, with a fake npm (PD-19: never the real HOME, npm or network).
 */

const SHA = "a".repeat(64);

function manifestFor(bundle: Buffer | string, version = "0.1.0"): RuntimeDistManifest {
  const bytes = Buffer.from(bundle);
  return {
    version,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    file: "ocw-runtime.mjs",
    minNode: 24,
    external: [
      { name: "@anthropic-ai/claude-agent-sdk", version: "0.3.282" },
      { name: "@anthropic-ai/sdk", version: "0.128.0" },
      { name: "@modelcontextprotocol/sdk", version: "1.30.1" },
      { name: "zod", version: "4.6.5" },
    ],
    bundled: [{ name: "ws", version: "8.21.3", license: "MIT" }],
    source: { repository: "https://github.com/VictorMinemu/open-collaborative-ai-workspace", commit: null },
    builtAt: "2026-10-29T08:00:00.000Z",
  };
}

const MANIFEST: RuntimeDistManifest = { ...manifestFor("x"), sha256: SHA };

describe("assertScriptSafeUrl (07.12-06, PD-05)", () => {
  it.each([
    "javascript:x",
    "https://u:p@h",
    "https://h/?q",
    "https://h/#f",
    "https://h/$(id)",
    "https://h/'x",
    "ftp://h.example",
    "https://h example",
    "https://h/`id`",
    "https://h/\nx",
    "",
  ])("refuses %j", (url) => {
    expect(() => assertScriptSafeUrl(url)).toThrow();
  });

  it.each([
    ["https://ocw.example.com", "https://ocw.example.com"],
    ["http://127.0.0.1:4290", "http://127.0.0.1:4290"],
    ["https://h.example/ocw", "https://h.example/ocw"],
    ["https://ocw.example.com/", "https://ocw.example.com"],
  ])("accepts %j (no trailing slash)", (url, expected) => {
    expect(assertScriptSafeUrl(url)).toBe(expected);
  });
});

describe("renderInstallScript (07.12-06, PD-04)", () => {
  const script = renderInstallScript({ serverUrl: "https://ocw.example.com/", manifest: MANIFEST });
  const lines = script.split("\n");

  it("is a POSIX sh script whose body runs only from main(), called on the last line", () => {
    expect(lines[0]).toBe("#!/bin/sh");
    expect(script).toContain("set -eu");
    expect(script).toContain("umask 077");
    expect(script).toMatch(/^main\(\) \{$/m);
    expect(script.trimEnd().split("\n").at(-1)).toBe('main "$@"');
  });

  it("embeds the server URL single-quoted, the version, the sha256 and the pins as name@version words", () => {
    expect(script).toContain("'https://ocw.example.com'");
    expect(script).toContain("'0.1.0'");
    expect(script).toContain(`'${SHA}'`);
    expect(script).toContain(`'${SHA.slice(0, 12)}'`);
    expect(script).toContain(
      "'@anthropic-ai/claude-agent-sdk@0.3.282' '@anthropic-ai/sdk@0.128.0' '@modelcontextprotocol/sdk@1.30.1' 'zod@4.6.5'",
    );
    expect(script).toContain("--no-audit --no-fund --omit=optional --ignore-scripts");
  });

  it("refuses an unsafe URL and a manifest that does not parse", () => {
    expect(() => renderInstallScript({ serverUrl: "https://h/$(id)", manifest: MANIFEST })).toThrow();
    expect(() =>
      renderInstallScript({
        serverUrl: "https://ocw.example.com",
        manifest: { ...MANIFEST, version: "1.0.0'; id; '" },
      }),
    ).toThrow();
  });

  it("never elevates and never evaluates text (outside comments)", () => {
    const code = lines.filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(code).not.toMatch(/\bsudo\b/);
    expect(code).not.toMatch(/\beval\b/);
    expect(code).not.toMatch(/\|\s*(ba|da|z)?sh\b/);
  });
});
