// Phase 07.11 (D-03, D-08, PD-11): the update runner on fake CLI trees in temp homes. Every run executes the fake CLI
// (`fake-cli/fake-cli.mjs`) copied into a scratch home, never a real `claude update`, `codex update` or `npm install
// -g` (PD-19); `assertScratch` refuses any resolution whose real path is outside the test's temp directory.

import { execFileSync, type SpawnOptions, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
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
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type InstallResolution, resolveInstall } from "./install-method.js";
import { InstallLock, type RunProgress, runUpdate, sanitizeUpdateOutput, updateChildEnv } from "./runner.js";

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

  it("settles when the installer exits even if a process it left behind keeps its output open (07.11 review HI-03)", async () => {
    installFake("claude-native", home, "2.1.290");
    const pidFile = join(tmp, "escaped.pid");
    // The installer starts a helper in its own session (out of the installer's process group) that inherits stdout
    // and stderr and outlives it, then exits 0: `close` never fires while the helper lives.
    const script = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
      "c.unref();",
      "process.stdout.write('done\\n');",
    ].join("\n");
    const spawnFn = ((_file: string, _args: readonly string[], options: SpawnOptions) =>
      spawn(process.execPath, ["-e", script], options)) as typeof spawn;
    const started = Date.now();
    try {
      const result = await runUpdate({
        resolution: resolveClaude(),
        candidate: "2.1.300",
        lockDir: lockDir(),
        home,
        env,
        spawnFn,
        stdioGraceMs: 200,
      });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(result).toMatchObject({ outcome: "unchanged", fromVersion: "2.1.290", toVersion: "2.1.290" });
      expect(result.output).toContain("done");
      expect(readdirSync(lockDir())).toEqual([]);
    } finally {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  });

  it("settles at a hard deadline even when the installer never reports an exit (07.11 review HI-03)", async () => {
    installFake("claude-native", home, "2.1.290");
    const spawnFn = (() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        pid: undefined;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = undefined;
      return child;
    }) as unknown as typeof spawn;
    const started = Date.now();
    const result = await runUpdate({
      resolution: resolveClaude(),
      candidate: "2.1.300",
      lockDir: lockDir(),
      home,
      env,
      spawnFn,
      timeoutMs: 50,
      killGraceMs: 50,
      stdioGraceMs: 50,
    });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result.outcome).toBe("failed");
    expect(result.error).toMatch(/timed out/);
    expect(readdirSync(lockDir())).toEqual([]);
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

  it("two daemons judging the same stale lock: exactly one takes it over, the other's view never removes it (07.11 review ME-01)", async () => {
    const root = "/some/install/root";
    mkdirSync(lockDir(), { recursive: true, mode: 0o700 });
    const file = join(lockDir(), `${createHash("sha256").update(root).digest("hex")}.lock`);
    writeFileSync(file, JSON.stringify({ pid: 99_999_999, startedAt: "2026-10-27T00:00:00.000Z" }), {
      mode: 0o600,
    });
    let resume: () => void = () => undefined;
    let judged: () => void = () => undefined;
    const judgedStale = new Promise<void>((r) => {
      judged = r;
    });
    const slow = new InstallLock(lockDir(), {
      onStaleJudged: () =>
        new Promise<void>((r) => {
          resume = r;
          judged();
        }),
    });
    const a = slow.acquire(root);
    await judgedStale;
    // While A sits between its stale judgement and the takeover, B takes the lock over.
    const b = await new InstallLock(lockDir()).acquire(root);
    expect(b).not.toBe("busy");
    const bOwner = readFileSync(file, "utf8");
    resume();
    expect(await a).toBe("busy");
    expect(readFileSync(file, "utf8")).toBe(bOwner);
    expect(readdirSync(lockDir()).filter((f) => !f.endsWith(".lock"))).toEqual([]);
    if (b !== "busy") await b.release();
    expect(readdirSync(lockDir())).toEqual([]);
  });

  it("never takes over a lock whose daemon is gone while its installer still runs (07.11 review HI-04)", async () => {
    const installer = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      detached: true,
      stdio: "ignore",
    });
    try {
      const root = "/some/install/root";
      mkdirSync(lockDir(), { recursive: true, mode: 0o700 });
      const file = join(lockDir(), `${createHash("sha256").update(root).digest("hex")}.lock`);
      writeFileSync(
        file,
        JSON.stringify({
          pid: 99_999_999,
          installerPid: installer.pid,
          startedAt: "2026-10-27T00:00:00.000Z",
        }),
        { mode: 0o600 },
      );
      const lock = new InstallLock(lockDir());
      expect(await lock.acquire(root)).toBe("busy");
      installer.kill("SIGKILL");
      await waitFor(() => {
        try {
          process.kill(installer.pid ?? 0, 0);
          return false;
        } catch {
          return true;
        }
      });
      const held = await lock.acquire(root);
      expect(held).not.toBe("busy");
      if (held !== "busy") await held.release();
    } finally {
      installer.kill("SIGKILL");
    }
  });

  it("records the installer's pid in the lock while it runs, so a restarted daemon waits for it (07.11 review HI-04)", async () => {
    installFake("claude-native", home, "2.1.290");
    writeFileSync(join(nativeRoot(), "fake-update.json"), JSON.stringify({ next: "2.1.300", delayMs: 800 }));
    const pids: number[] = [];
    const spawnFn = ((file: string, args: readonly string[], options: SpawnOptions) => {
      const child = spawn(file, args, options);
      if (child.pid) pids.push(child.pid);
      return child;
    }) as typeof spawn;
    const run = runUpdate({
      resolution: resolveClaude(),
      candidate: "2.1.300",
      lockDir: lockDir(),
      home,
      env,
      spawnFn,
    });
    let recorded: { pid?: number; installerPid?: number } = {};
    await waitFor(() => {
      const [f] = existsSync(lockDir()) ? readdirSync(lockDir()) : [];
      if (!f?.endsWith(".lock")) return false;
      try {
        recorded = JSON.parse(readFileSync(join(lockDir(), f), "utf8"));
      } catch {
        return false;
      }
      return typeof recorded.installerPid === "number";
    });
    expect(recorded.pid).toBe(process.pid);
    expect(recorded.installerPid).toBe(pids[0]);
    expect(await run).toMatchObject({ outcome: "succeeded" });
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
    expect(result.output).toMatch(/^…\[truncated \d+ bytes\]\n/);
    expect(progress.length).toBeLessThanOrEqual(4);
    for (const p of progress) {
      expect(p.message.length).toBeLessThanOrEqual(200);
      expect(p.message).not.toContain(realTmp);
    }
  });
});

describe("updateChildEnv (07.11 review ME-03): an allowlist, never the daemon's whole environment", () => {
  it("keeps what installers need and drops every credential", () => {
    const daemonEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/u",
      USER: "u",
      LOGNAME: "u",
      SHELL: "/bin/bash",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TMPDIR: "/tmp/u",
      TZ: "UTC",
      HTTPS_PROXY: "http://proxy:3128",
      https_proxy: "http://proxy:3128",
      NO_PROXY: "localhost",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      CODEX_HOME: "/home/u/.codex",
      CLAUDE_CONFIG_DIR: "/home/u/.claude",
      XDG_CONFIG_HOME: "/home/u/.config",
      npm_config_registry: "https://registry.example",
      NPM_CONFIG_CAFILE: "/etc/ssl/corp.pem",
      HOMEBREW_PREFIX: "/opt/homebrew",
      // Never: credentials and anything else the daemon happens to carry.
      GH_TOKEN: "x",
      GITHUB_TOKEN: "x",
      AWS_SECRET_ACCESS_KEY: "x",
      AWS_SESSION_TOKEN: "x",
      CLAUDE_CODE_OAUTH_TOKEN: "x",
      DATABASE_URL: "postgres://u:p@h/db",
      SSH_AUTH_SOCK: "/tmp/ssh.sock",
      MY_SECRET: "x",
      DB_PASSWORD: "x",
      HOMEBREW_GITHUB_API_TOKEN: "x",
      npm_config__authToken: "x",
      "npm_config_//registry.npmjs.org/:_authToken": "x",
      NPM_CONFIG_PASSWORD: "x",
      OCW_DEVICE_TOKEN: "x",
      ANTHROPIC_API_KEY: "x",
      OPENAI_API_KEY: "x",
      NODE_OPTIONS: "--require /x.js",
    };
    const out = updateChildEnv(daemonEnv, { CODEX_HOME: "/scratch/.codex" });
    expect(Object.keys(out).sort()).toEqual(
      [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "TZ",
        "HTTPS_PROXY",
        "https_proxy",
        "NO_PROXY",
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
        "CODEX_HOME",
        "CLAUDE_CONFIG_DIR",
        "XDG_CONFIG_HOME",
        "npm_config_registry",
        "NPM_CONFIG_CAFILE",
        "HOMEBREW_PREFIX",
        "NO_COLOR",
        "npm_config_update_notifier",
        "npm_config_fund",
        "HOMEBREW_NO_ENV_HINTS",
        "HOMEBREW_NO_INSTALL_CLEANUP",
        "HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK",
      ].sort(),
    );
    expect(out.CODEX_HOME).toBe("/scratch/.codex");
    expect(out.NO_COLOR).toBe("1");
    // 07.11 review LO-02: `brew upgrade <cli>` touches nothing else (no cleanup, no dependents upgraded).
    expect(out.HOMEBREW_NO_INSTALL_CLEANUP).toBe("1");
    expect(out.HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK).toBe("1");
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

  it("truncates above 10 KB with the marker, keeping the tail where installers print their error (07.11 review LO-06)", () => {
    const out = sanitizeUpdateOutput(`${"x".repeat(20_000)}npm error code EACCES`, [], home);
    expect(out).toMatch(/^…\[truncated 9781 bytes\]\nx{10219}npm error code EACCES$/);
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
