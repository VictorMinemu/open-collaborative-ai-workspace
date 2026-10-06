import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const BIN = join(import.meta.dirname, "..", "bin", "ocw-runtime");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function cli(home: string, args: string[], env: Record<string, string> = {}): string {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("OCW_")),
  ) as Record<string, string>;
  return execFileSync(process.execPath, [BIN, ...args], {
    env: { ...base, OCW_HOME: home, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("ocw-runtime full-access (headless opt-in, ADR-0012)", () => {
  it("on / off write runtime.json (0600) with no daemon running; status prints the value and its source", () => {
    const home = mkdtempSync(join(tmpdir(), "ocw-cli-"));
    dirs.push(home);
    expect(JSON.parse(cli(home, ["full-access", "status"]))).toEqual({
      fullAccessOptIn: false,
      fullAccessSource: "config",
      daemon: "stopped",
    });
    cli(home, ["full-access", "on"]);
    const file = join(home, "runtime.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ fullAccess: { optIn: true } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(cli(home, ["full-access", "status"]))).toMatchObject({ fullAccessOptIn: true });
    expect(JSON.parse(cli(home, ["full-access", "status"], { OCW_ALLOW_FULL_ACCESS: "0" }))).toMatchObject({
      fullAccessOptIn: false,
      fullAccessSource: "env",
    });
    cli(home, ["full-access", "off"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ fullAccess: { optIn: false } });
  }, 30_000);
});
