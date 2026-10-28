// Phase 07.11 (D-03, D-08, PD-11): the update runner on fake CLI trees in temp homes. Every run executes the fake CLI
// (`fake-cli/fake-cli.mjs`) copied into a scratch home, never a real `claude update`, `codex update` or `npm install
// -g` (PD-19); `assertScratch` refuses any resolution whose real path is outside the test's temp directory.

import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type InstallResolution, resolveInstall } from "./install-method.js";
import { runUpdate } from "./runner.js";

const FAKE = fileURLToPath(new URL("./fake-cli/fake-cli.mjs", import.meta.url));

function installFake(layout: string, dir: string, version: string, extra?: string): void {
  execFileSync(process.execPath, [FAKE, "install-fake", layout, dir, version, ...(extra ? [extra] : [])]);
}

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
let realTmp: string;
let home: string;
/** The child's base environment: node for the fake's shebang, plus secrets that must never reach the child. */
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ocw-runner-"));
  realTmp = realpathSync(tmp);
  home = join(tmp, "home");
  env = {
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: home,
    OCW_DEVICE_TOKEN: "ocw_dev_secret",
    ANTHROPIC_API_KEY: "sk-ant-secret",
  };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** PD-19: a run only ever touches a tree inside this test's temp directory. */
function assertScratch(r: InstallResolution): InstallResolution {
  if (!r.realPath?.startsWith(`${realTmp}/`) || !r.installRoot?.startsWith(`${realTmp}/`)) {
    throw new Error("refusing to run an update outside the scratch home");
  }
  return r;
}

function resolveClaude(): InstallResolution {
  const bin = join(home, ".local", "bin");
  return assertScratch(
    resolveInstall("claude-code", { home, env: { ...env, PATH: bin }, which: scratchWhich([bin]) }),
  );
}

function nativeRoot(): string {
  return join(home, ".local", "share", "claude");
}

function claudeVersion(): string {
  return execFileSync(join(home, ".local", "bin", "claude"), ["--version"], { env })
    .toString()
    .trim();
}

describe("runUpdate (Phase 07.11, PD-11)", () => {
  it("updates a native Claude Code install under the lock, re-detects the new version and ends succeeded", async () => {
    installFake("claude-native", home, "2.1.290");
    writeFileSync(join(nativeRoot(), "fake-update.json"), JSON.stringify({ next: "2.1.300" }));
    const lockDir = join(home, ".cache", "ocw", "runtime-updates");
    const resolution = resolveClaude();

    const result = await runUpdate({ resolution, candidate: "2.1.300", lockDir, home, env });

    expect(result).toMatchObject({ outcome: "succeeded", fromVersion: "2.1.290", toVersion: "2.1.300" });
    expect(claudeVersion()).toBe("2.1.300 (Claude Code)");
    expect(result.output).toContain("Successfully updated from 2.1.290 to version 2.1.300");
    expect(result.output).not.toContain(tmp);
    expect(result.output).not.toContain(realTmp);
    expect(result.output).not.toMatch(/(^|\s)\/[A-Za-z]/m);
    expect(existsSync(lockDir) ? readdirSync(lockDir) : []).toEqual([]);
  });
});
