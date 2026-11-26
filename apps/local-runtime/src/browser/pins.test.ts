// The Chrome for Testing pins (07.13 D-05, PD-19): one row per desktop platform, and the two Linux rows equal the brw
// image's `ADD --checksum` lines, so the bots' image and the Work Zone runtime cannot drift apart.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CFT_PINS,
  CFT_PLATFORMS,
  CFT_VERSION,
  cftPlatformOf,
  cftZipUrl,
  headlessShellRelativePath,
} from "./pins.js";

const DOCKERFILE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "infra",
  "sandbox",
  "browser",
  "Dockerfile",
);

describe("CfT pins (07.13 D-05)", () => {
  it("pins five platforms, each with a 64-hex sha256 and a positive size", () => {
    expect([...CFT_PLATFORMS].sort()).toEqual(["linux-arm64", "linux64", "mac-arm64", "mac-x64", "win64"]);
    for (const p of CFT_PLATFORMS) {
      expect(CFT_PINS[p].sha256, p).toMatch(/^[0-9a-f]{64}$/);
      expect(CFT_PINS[p].bytes, p).toBeGreaterThan(50_000_000);
    }
    expect(new Set(CFT_PLATFORMS.map((p) => CFT_PINS[p].sha256)).size).toBe(5);
  });

  it("the linux64 and linux-arm64 hashes are the brw Dockerfile's --checksum lines, for the same version", () => {
    const dockerfile = readFileSync(DOCKERFILE, "utf8");
    const checksums = [...dockerfile.matchAll(/--checksum=sha256:([0-9a-f]{64})\s*\\\s*\n\s*(\S+)/g)].map(
      (m) => ({ sha256: m[1], url: m[2] }),
    );
    expect(checksums).toContainEqual({ sha256: CFT_PINS.linux64.sha256, url: cftZipUrl("linux64") });
    expect(checksums).toContainEqual({
      sha256: CFT_PINS["linux-arm64"].sha256,
      url: cftZipUrl("linux-arm64"),
    });
  });

  it("maps Node's platform and arch, and has no 32-bit build", () => {
    expect(cftPlatformOf("darwin", "arm64")).toBe("mac-arm64");
    expect(cftPlatformOf("darwin", "x64")).toBe("mac-x64");
    expect(cftPlatformOf("linux", "x64")).toBe("linux64");
    expect(cftPlatformOf("linux", "arm64")).toBe("linux-arm64");
    expect(cftPlatformOf("win32", "x64")).toBe("win64");
    expect(cftPlatformOf("win32", "ia32")).toBeNull();
    expect(cftPlatformOf("freebsd", "x64")).toBeNull();
  });

  it("builds the fixed storage URL and the executable's place inside the extracted root", () => {
    expect(CFT_VERSION).toBe("156.0.8078.47");
    expect(cftZipUrl("mac-arm64")).toBe(
      "https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.47/mac-arm64/chrome-headless-shell-mac-arm64.zip",
    );
    expect(headlessShellRelativePath("linux64")).toBe("chrome-headless-shell");
    expect(headlessShellRelativePath("win64")).toBe("chrome-headless-shell.exe");
  });
});
