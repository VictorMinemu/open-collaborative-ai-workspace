import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installedBundlePath, installInfoPath, readInstallInfo, runtimeDir } from "./install-info.js";

const dirs: string[] = [];
function home(): string {
  const d = mkdtempSync(join(tmpdir(), "ocw-inst-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const record = {
  serverUrl: "https://ocw.example.com",
  version: "0.1.0",
  sha256: "b".repeat(64),
  installedAt: "2026-10-29T10:00:00.000Z",
  nodePath: "/usr/bin/node",
};

function write(h: string, content: string): void {
  mkdirSync(runtimeDir(h), { recursive: true });
  writeFileSync(installInfoPath(h), content);
}

describe("the install record (07.12, D-01, PD-04)", () => {
  it("lives under <home>/runtime", () => {
    const h = home();
    expect(runtimeDir(h)).toBe(join(h, "runtime"));
    expect(installInfoPath(h)).toBe(join(h, "runtime", "install.json"));
    expect(installedBundlePath(h)).toBe(join(h, "runtime", "current", "ocw-runtime.mjs"));
    expect(installedBundlePath(h).endsWith("runtime/current/ocw-runtime.mjs")).toBe(true);
  });

  it("is null when there is no file (a development checkout)", async () => {
    expect(await readInstallInfo(home())).toBeNull();
  });

  it("reads a valid record", async () => {
    const h = home();
    write(h, JSON.stringify(record));
    expect(await readInstallInfo(h)).toEqual(record);
  });

  it.each([
    ["invalid JSON", "{ not json"],
    ["a 63-character sha256", JSON.stringify({ ...record, sha256: "b".repeat(63) })],
    ["a server URL that is not a URL", JSON.stringify({ ...record, serverUrl: "ocw.example.com" })],
    ["a missing node path", JSON.stringify({ ...record, nodePath: undefined })],
  ])("is null for %s", async (_label, content) => {
    const h = home();
    write(h, content);
    expect(await readInstallInfo(h)).toBeNull();
  });
});
