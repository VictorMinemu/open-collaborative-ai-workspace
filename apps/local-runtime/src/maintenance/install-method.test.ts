// Phase 07.11 (D-01, D-05, D-08, PD-09): the install-method resolver on fake trees in temp homes. Nothing here looks
// at the real home, the real PATH or a real CLI (PD-19): every lookup goes through `scratchWhich`.

import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInstall, updateCommandFor } from "./install-method.js";

const FAKE = fileURLToPath(new URL("./fake-cli/fake-cli.mjs", import.meta.url));

function installFake(layout: string, dir: string, version: string, extra?: string): void {
  execFileSync(process.execPath, [FAKE, "install-fake", layout, dir, version, ...(extra ? [extra] : [])]);
}

/** `which` limited to the given directories: never the real home's `~/.local/bin` or `/opt/homebrew/bin`. */
function scratchWhich(dirs: readonly string[]): (name: string) => string | null {
  return (name) => {
    for (const dir of dirs) {
      const candidate = join(dir, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
    return null;
  };
}

let tmp: string;
let home: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ocw-install-"));
  home = join(tmp, "home");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveInstall (Phase 07.11, PD-09)", () => {
  it("a native Claude Code install: native, ~/.local/bin, `claude update`, channel latest", () => {
    installFake("claude-native", home, "2.1.290");
    const bin = join(home, ".local", "bin");
    const r = resolveInstall("claude-code", { home, env: { PATH: bin }, which: scratchWhich([bin]) });
    expect(r).toMatchObject({
      runtime: "claude-code",
      method: "native",
      location: "~/.local/bin",
      canUpdate: true,
      reason: null,
      display: "claude update",
      channel: "latest",
      installRoot: realpathSync(join(home, ".local", "share", "claude")),
      binPath: join(bin, "claude"),
      realPath: realpathSync(join(home, ".local", "share", "claude", "versions", "2.1.290")),
    });
    expect(updateCommandFor(r, "2.1.300")).toEqual({ file: join(bin, "claude"), args: ["update"], env: {} });
  });

  it("refuses a candidate that is not a plain version (D-05: nothing from outside the device reaches an argument)", () => {
    installFake("claude-native", home, "2.1.290");
    const bin = join(home, ".local", "bin");
    const r = resolveInstall("claude-code", { home, env: { PATH: bin }, which: scratchWhich([bin]) });
    expect(updateCommandFor(r, "2.1.300 --force")).toBeNull();
    expect(updateCommandFor(r, "latest")).toBeNull();
    expect(updateCommandFor(r, `2.1.${"9".repeat(80)}`)).toBeNull();
  });
});
