// Phase 07.11 (D-03, D-08, PD-11): the update runner on fake CLI trees in temp homes. Every run executes the fake CLI
// (`fake-cli/fake-cli.mjs`) copied into a scratch home, never a real `claude update`, `codex update` or `npm install
// -g` (PD-19); `assertScratch` refuses any resolution whose real path is outside the test's temp directory.

import { execFileSync, type SpawnOptions, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type InstallResolution, resolveInstall } from "./install-method.js";
import { InstallLock, type RunProgress, runUpdate, sanitizeUpdateOutput } from "./runner.js";

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

  it("reports unchanged when the installer says it is up to date and the version did not move", async () => {
    // The installer finds nothing newer than what is installed (its channel lags the registry's answer).
    installFake("claude-native", home, "2.1.290");
    writeFileSync(join(nativeRoot(), "fake-update.json"), JSON.stringify({ next: "2.1.290" }));
    const result = await runUpdate({
      resolution: resolveClaude(),
      candidate: "2.1.300",
      lockDir: lockDir(),
      home,
      env,
    });
    expect(result).toMatchObject({ outcome: "unchanged", fromVersion: "2.1.290", toVersion: "2.1.290" });
    expect(result.output).toContain("Claude Code is up to date (2.1.290)");
  });

  it("never runs a candidate at or below the installed version (no downgrade): unchanged, nothing run (07.11 review HI-01)", async () => {
    installFake("claude-native", home, "2.1.305");
    writeFileSync(join(nativeRoot(), "fake-update.json"), JSON.stringify({ next: "2.1.300" }));
    const result = await runUpdate({
      resolution: resolveClaude(),
      candidate: "2.1.300",
      lockDir: lockDir(),
      home,
      env,
    });
    expect(result).toMatchObject({ outcome: "unchanged", fromVersion: "2.1.305", toVersion: "2.1.305" });
    expect(claudeVersion()).toBe("2.1.305 (Claude Code)");
    // The fake installer never ran: it would have left its env report in the install root.
    expect(existsSync(join(nativeRoot(), "fake-update-env.json"))).toBe(false);
  });

  it("never downgrades an npm install that moved past the pending candidate (07.11 review HI-01)", async () => {
    const prefix = join(tmp, "prefix");
    installFake("claude-npm", prefix, "2.1.305");
    const bin = join(prefix, "bin");
    const resolution = assertScratch(
      resolveInstall("claude-code", { home, env: { ...env, PATH: bin }, which: scratchWhich([bin]) }),
    );
    const result = await runUpdate({ resolution, candidate: "2.1.300", lockDir: lockDir(), home, env });
    expect(result).toMatchObject({ outcome: "unchanged", fromVersion: "2.1.305", toVersion: "2.1.305" });
    const pkg = JSON.parse(
      readFileSync(
        join(prefix, "lib", "node_modules", "@anthropic-ai", "claude-code", "package.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(pkg.version).toBe("2.1.305");
    expect(existsSync(join(prefix, "fake-update-env.json"))).toBe(false);
  });

  it("fails on a non-zero exit and keeps the installer's error line", async () => {
    installFake("claude-native", home, "2.1.290");
    writeFileSync(join(nativeRoot(), "fake-update.json"), JSON.stringify({ next: "2.1.300", exitCode: 2 }));
    const result = await runUpdate({
      resolution: resolveClaude(),
      candidate: "2.1.300",
      lockDir: lockDir(),
      home,
      env,
    });
    expect(result.outcome).toBe("failed");
    expect(result.error).toMatch(/exited with code 2/);
    expect(result.output).toContain("fake update failed with code 2");
    expect(result.output).not.toContain(realTmp);
    expect(claudeVersion()).toBe("2.1.290 (Claude Code)");
  });

  it("kills the whole process group on timeout, fails `timed out` and releases the lock", async () => {
    installFake("claude-native", home, "2.1.290");
    writeFileSync(join(nativeRoot(), "fake-update.json"), JSON.stringify({ next: "2.1.300", delayMs: 5000 }));
    const pids: number[] = [];
    const spawnFn = ((file: string, args: readonly string[], options: SpawnOptions) => {
      const child = spawn(file, args, options);
      if (child.pid) pids.push(child.pid);
      return child;
    }) as typeof spawn;
    const started = Date.now();
    const result = await runUpdate({
      resolution: resolveClaude(),
      candidate: "2.1.300",
      lockDir: lockDir(),
      home,
      env,
      timeoutMs: 300,
      killGraceMs: 200,
      spawnFn,
    });
    expect(result.outcome).toBe("failed");
    expect(result.error).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(pids).toHaveLength(1);
    expect(() => process.kill(pids[0] ?? 0, 0)).toThrow();
    expect(readdirSync(lockDir())).toEqual([]);
    expect(claudeVersion()).toBe("2.1.290 (Claude Code)");
  });

  it("queues behind a second updater of the same install and then finds nothing left to do", async () => {
    installFake("claude-native", home, "2.1.290");
    writeFileSync(join(nativeRoot(), "fake-update.json"), JSON.stringify({ next: "2.1.300", delayMs: 600 }));
    const first = runUpdate({
      resolution: resolveClaude(),
      candidate: "2.1.300",
      lockDir: lockDir(),
      home,
      env,
    });
    await waitFor(() => existsSync(lockDir()) && readdirSync(lockDir()).length === 1);
    const progress: RunProgress[] = [];
    const second = runUpdate({
      resolution: resolveClaude(),
      candidate: "2.1.300",
      lockDir: lockDir(),
      home,
      env,
      lockRetryMs: 50,
      onProgress: (p) => progress.push(p),
    });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ outcome: "succeeded", fromVersion: "2.1.290", toVersion: "2.1.300" });
    expect(progress[0]).toEqual({
      state: "queued",
      message: "Waiting for another update of this install to finish",
    });
    expect(b).toMatchObject({ outcome: "unchanged", fromVersion: "2.1.300", toVersion: "2.1.300" });
    expect(readdirSync(lockDir())).toEqual([]);
  });

  it("gives up waiting for the lock after the limit and fails", async () => {
    installFake("claude-native", home, "2.1.290");
    const resolution = resolveClaude();
    const held = await new InstallLock(lockDir()).acquire(resolution.installRoot ?? "");
    expect(held).not.toBe("busy");
    const result = await runUpdate({
      resolution,
      candidate: "2.1.300",
      lockDir: lockDir(),
      home,
      env,
      lockRetryMs: 20,
      lockGiveUpMs: 150,
    });
    expect(result.outcome).toBe("failed");
    expect(result.error).toMatch(/another update of this install/);
    if (held !== "busy") await held.release();
  });

  it("takes over a lock file left by a process that is gone", async () => {
    installFake("claude-native", home, "2.1.290");
    writeFileSync(join(nativeRoot(), "fake-update.json"), JSON.stringify({ next: "2.1.300" }));
    const resolution = resolveClaude();
    mkdirSync(lockDir(), { recursive: true, mode: 0o700 });
    const file = join(
      lockDir(),
      `${createHash("sha256")
        .update(resolution.installRoot ?? "")
        .digest("hex")}.lock`,
    );
    writeFileSync(file, JSON.stringify({ pid: 99_999_999, startedAt: "2026-10-27T00:00:00.000Z" }), {
      mode: 0o600,
    });
    const result = await runUpdate({ resolution, candidate: "2.1.300", lockDir: lockDir(), home, env });
    expect(result.outcome).toBe("succeeded");
    expect(readdirSync(lockDir())).toEqual([]);
  });

  it("keeps the lock in a 0700 directory as a 0600 file and refuses a second holder", async () => {
    const lock = new InstallLock(lockDir());
    const held = await lock.acquire("/some/install/root");
    expect(held).not.toBe("busy");
    expect(statSync(lockDir()).mode & 0o777).toBe(0o700);
    const [file] = readdirSync(lockDir());
    expect(file).toMatch(/^[0-9a-f]{64}\.lock$/);
    expect(statSync(join(lockDir(), file ?? "")).mode & 0o777).toBe(0o600);
    expect(await lock.acquire("/some/install/root")).toBe("busy");
    if (held !== "busy") await held.release();
    expect(readdirSync(lockDir())).toEqual([]);
  });

  it("fails `install method changed` when the binary moved to another method after the check, without running", async () => {
    installFake("claude-native", home, "2.1.290");
    writeFileSync(join(nativeRoot(), "fake-update.json"), JSON.stringify({ next: "2.1.300" }));
    const resolution = resolveClaude();
    const prefix = join(tmp, "prefix");
    installFake("claude-npm", prefix, "2.1.290");
    rmSync(join(home, ".local", "bin", "claude"));
    symlinkSync(realpathSync(join(prefix, "bin", "claude")), join(home, ".local", "bin", "claude"));
    const result = await runUpdate({ resolution, candidate: "2.1.300", lockDir: lockDir(), home, env });
    expect(result.outcome).toBe("failed");
    expect(result.error).toMatch(/install method changed/);
    expect(existsSync(join(nativeRoot(), "fake-update-env.json"))).toBe(false);
    expect(existsSync(join(prefix, "fake-update-env.json"))).toBe(false);
  });

  it("gives the installer no OCW_* variable, API key or device token", async () => {
    installFake("claude-native", home, "2.1.290");
    writeFileSync(join(nativeRoot(), "fake-update.json"), JSON.stringify({ next: "2.1.300" }));
    const result = await runUpdate({
      resolution: resolveClaude(),
      candidate: "2.1.300",
      lockDir: lockDir(),
      home,
      env: {
        ...env,
        OPENAI_API_KEY: "sk-openai",
        CODEX_API_KEY: "sk-codex",
        OCW_HOME: "/x",
        ANTHROPIC_AUTH_TOKEN: "t",
      },
    });
    expect(result.outcome).toBe("succeeded");
    const report = JSON.parse(readFileSync(join(nativeRoot(), "fake-update-env.json"), "utf8")) as {
      names: string[];
      noColor: string | null;
    };
    expect(report.names).toEqual([]);
    expect(report.noColor).toBe("1");
  });

  it("updates an npm prefix to the exact candidate with the prefix's npm and scrubs the prefix from the output", async () => {
    const prefix = join(tmp, "prefix");
    installFake("claude-npm", prefix, "2.1.290");
    const bin = join(prefix, "bin");
    const resolution = assertScratch(
      resolveInstall("claude-code", { home, env: { ...env, PATH: bin }, which: scratchWhich([bin]) }),
    );
    expect(resolution.method).toBe("npm");
    const result = await runUpdate({ resolution, candidate: "2.1.300", lockDir: lockDir(), home, env });
    expect(result).toMatchObject({ outcome: "succeeded", fromVersion: "2.1.290", toVersion: "2.1.300" });
    expect(result.output).toContain("added 1 package");
    expect(result.output).toContain("<path>");
    expect(result.output).not.toContain(tmp);
    expect(result.output).not.toContain(realTmp);
    const report = JSON.parse(readFileSync(join(prefix, "fake-update-env.json"), "utf8")) as {
      pathHead: string;
    };
    expect(report.pathHead).toBe(join(realpathSync(prefix), "bin"));
  });

  it("caps the kept output at 10 KB and throttles sanitised progress lines", async () => {
    installFake("claude-native", home, "2.1.290");
    writeFileSync(join(nativeRoot(), "fake-update.json"), JSON.stringify({ next: "2.1.300", noise: 400 }));
    const progress: RunProgress[] = [];
    const result = await runUpdate({
      resolution: resolveClaude(),
      candidate: "2.1.300",
      lockDir: lockDir(),
      home,
      env,
      onProgress: (p) => progress.push(p),
    });
    expect(result.outcome).toBe("succeeded");
    expect(Buffer.byteLength(result.output)).toBeLessThan(10 * 1024 + 100);
    expect(result.output).toMatch(/…\[truncated \d+ bytes\]$/);
    expect(progress.length).toBeLessThanOrEqual(4);
    for (const p of progress) {
      expect(p.message.length).toBeLessThanOrEqual(200);
      expect(p.message).not.toContain(realTmp);
    }
  });
});

describe("sanitizeUpdateOutput (Phase 07.11, Pitfall 9)", () => {
  it("strips ANSI, maps the home to ~, scrubs other absolute paths and redacts secrets", () => {
    const raw = [
      "\u001b[32madded 1 package\u001b[0m in 1s",
      `wrote ${home}/.local/share/claude/versions/2.1.300`,
      "npm error path /usr/lib/node_modules/@anthropic-ai/claude-code",
      "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH",
    ].join("\r\n");
    const out = sanitizeUpdateOutput(raw, [], home);
    expect(out).toContain("added 1 package in 1s");
    expect(out).not.toContain("\u001b");
    expect(out).toContain("wrote ~/.local/share/claude/versions/2.1.300");
    expect(out).toContain("npm error path <path>");
    expect(out).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
    expect(out).not.toContain("\r");
  });

  it("truncates above 10 KB with the marker", () => {
    const out = sanitizeUpdateOutput("x".repeat(20_000), [], home);
    expect(out).toMatch(/^x{10240}\n…\[truncated 9760 bytes\]$/);
  });
});

function lockDir(): string {
  return join(home, ".cache", "ocw", "runtime-updates");
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}
