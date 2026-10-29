import { execFile, execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeId } from "@ocw/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { Daemon } from "./daemon.js";
import { silentLogger } from "./logger.js";
import type { AgentRuntime } from "./runtime.js";

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

// ---------------------------------------------------------------------------------------------
// 07.11 `ocw-runtime updates status|check|now` (D-05, D-09, PD-08). PD-19: a fake CLI in a scratch HOME and PATH;
// the daemon-down report only resolves (it runs nothing); the in-process daemon has its level off.

const FAKE_CLI = fileURLToPath(new URL("./maintenance/fake-cli/fake-cli.mjs", import.meta.url));

function cliAsync(
  home: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("OCW_")),
  ) as Record<string, string>;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { env: { ...base, OCW_HOME: home, ...env }, encoding: "utf8" },
      (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }),
    );
  });
}

function stubRuntime(id: RuntimeId): AgentRuntime {
  return {
    id,
    capabilities: {
      supportsSteer: false,
      supportsResume: false,
      supportsPermissionModes: ["default"],
      supportsImages: false,
    },
    detect: async () => ({ id, installed: true, version: "9.9.9", loggedIn: true }),
    start: async () => undefined,
    prompt: async () => undefined,
    interrupt: async () => undefined,
    resolveApproval: () => false,
    activeTurns: () => 0,
    retireIdle: async () => 0,
    stop: async () => undefined,
    stopAll: async () => undefined,
  };
}

describe("ocw-runtime updates (07.11, D-09, PD-08)", () => {
  /** An OCW home plus a scratch user home with a native fake Claude Code 2.1.290. */
  function scratch(): { home: string; userHome: string; env: Record<string, string> } {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "ocw-cli-")));
    dirs.push(home);
    const userHome = join(home, "user");
    mkdirSync(userHome);
    execFileSync(process.execPath, [FAKE_CLI, "install-fake", "claude-native", userHome, "2.1.290"]);
    const nodeBin = join(userHome, "node-bin");
    mkdirSync(nodeBin);
    symlinkSync(process.execPath, join(nodeBin, "node"));
    return {
      home,
      userHome,
      env: {
        HOME: userHome,
        PATH: [join(userHome, ".local", "bin"), nodeBin].join(":"),
        // Never the public registry from a test, whatever runs.
        OCW_RUNTIME_REGISTRY_URL: "http://127.0.0.1:9",
      },
    };
  }

  it("daemon down: status is a local resolve-only report; check and now say the runtime is not running", async () => {
    const { home, env } = scratch();
    const status = await cliAsync(home, ["updates", "status"], env);
    expect(status.code).toBe(0);
    const report = JSON.parse(status.stdout) as {
      daemon: string;
      localLevel: string;
      runtimes: Array<Record<string, unknown>>;
    };
    expect(report).toMatchObject({ daemon: "stopped", localLevel: "automatic", localLevelSource: "config" });
    expect(report.runtimes.find((r) => r.runtime === "claude-code")).toMatchObject({
      method: "native",
      location: "~/.local/bin",
      canUpdate: true,
      updateCommand: "claude update",
    });
    expect(status.stdout).not.toContain(home);
    for (const args of [
      ["updates", "check"],
      ["updates", "now", "claude-code"],
    ]) {
      const out = await cliAsync(home, args, env);
      expect(out.code).toBe(1);
      expect(out.stdout.trim()).toBe("the runtime is not running");
    }
    const usage = await cliAsync(home, ["updates", "now", "opencode"], env);
    expect(usage.code).toBe(1);
    expect(usage.stderr).toContain("usage: ocw-runtime updates");
  }, 60_000);

  it("daemon running: status prints the levels and statuses; now prints the refusal and exits 1; check answers", async () => {
    const { home, userHome, env } = scratch();
    const claudeBin = join(userHome, ".local", "bin", "claude");
    const daemon = await Daemon.create({
      home,
      env: { ...env, OCW_RUNTIME_UPDATES: "off" },
      token: null,
      runtimes: [stubRuntime("claude-code")],
      logger: silentLogger,
      maintenance: { userHome, which: (name) => (name === "claude" ? claudeBin : null) },
    });
    try {
      await daemon.start();
      const status = await cliAsync(home, ["updates", "status"], env);
      expect(status.code).toBe(0);
      const parsed = JSON.parse(status.stdout) as { runtimes: Array<Record<string, unknown>> };
      expect(parsed).toMatchObject({
        daemon: "running",
        localLevel: "off",
        localLevelSource: "env",
        effectiveLevel: "off",
        orgLevelReceived: false,
      });
      expect(parsed.runtimes.find((r) => r.runtime === "claude-code")).toMatchObject({
        installedVersion: "2.1.290",
        method: "native",
        state: "idle",
        latestVersion: null,
      });
      const now = await cliAsync(home, ["updates", "now", "claude-code"], env);
      expect(now.code).toBe(1);
      expect(now.stdout.trim()).toBe("updates are off on this device");
      const check = await cliAsync(home, ["updates", "check"], env);
      expect(check.code).toBe(0);
      expect(JSON.parse(check.stdout)).toMatchObject({ effectiveLevel: "off" });
    } finally {
      await daemon.stop();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// 07.11-08 `ocw-runtime updates automatic|notify|off` (D-02): the device owner's level, written to runtime.json and
// applied by a running daemon through the value-less reloadConfig.

const ENV_NOTE = "Note: OCW_RUNTIME_UPDATES in the daemon's environment overrides runtime.json.";

describe("ocw-runtime updates automatic|notify|off (07.11-08, D-02)", () => {
  function plainHome(): string {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "ocw-cli-")));
    dirs.push(home);
    return home;
  }

  it("daemon down: writes runtime.json (0600, other keys kept) and prints the file's level; a bad level is a usage error", async () => {
    const home = plainHome();
    writeFileSync(join(home, "runtime.json"), JSON.stringify({ fullAccess: { optIn: true } }));
    const env = { OCW_RUNTIME_REGISTRY_URL: "http://127.0.0.1:9" };
    const notify = await cliAsync(home, ["updates", "notify"], env);
    expect(notify.code).toBe(0);
    expect(JSON.parse(notify.stdout)).toEqual({
      localLevel: "notify",
      localLevelSource: "config",
      daemon: "stopped",
    });
    expect(notify.stderr).toBe("");
    const file = join(home, "runtime.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      fullAccess: { optIn: true },
      runtimeUpdates: { level: "notify" },
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const overridden = await cliAsync(home, ["updates", "off"], { ...env, OCW_RUNTIME_UPDATES: "automatic" });
    expect(overridden.code).toBe(0);
    expect(JSON.parse(overridden.stdout)).toEqual({
      localLevel: "automatic",
      localLevelSource: "env",
      daemon: "stopped",
    });
    expect(overridden.stderr).toContain(ENV_NOTE);
    expect(JSON.parse(readFileSync(file, "utf8")).runtimeUpdates).toEqual({ level: "off" });

    const bad = await cliAsync(home, ["updates", "sometimes"], env);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("usage: ocw-runtime updates automatic|notify|off");
    expect(JSON.parse(readFileSync(file, "utf8")).runtimeUpdates).toEqual({ level: "off" });
  }, 60_000);

  it("daemon running: the daemon reloads the level at once; with OCW_RUNTIME_UPDATES in its env the change is overridden", async () => {
    const home = plainHome();
    const userHome = join(home, "user");
    mkdirSync(userHome);
    const daemonEnv = {
      HOME: userHome,
      PATH: "/usr/bin:/bin",
      OCW_RUNTIME_REGISTRY_URL: "http://127.0.0.1:9",
    };
    const opts = {
      home,
      token: null,
      runtimes: [stubRuntime("claude-code")],
      logger: silentLogger,
      maintenance: { userHome, which: () => null },
    };
    let daemon = await Daemon.create({ ...opts, env: daemonEnv });
    try {
      await daemon.start();
      const notify = await cliAsync(home, ["updates", "notify"]);
      expect(notify.code).toBe(0);
      expect(JSON.parse(notify.stdout)).toEqual({
        localLevel: "notify",
        localLevelSource: "config",
        effectiveLevel: "notify",
        daemon: "running",
      });
      expect(notify.stderr).toBe("");
      const status = (await daemon.status()) as { runtimeUpdates: Record<string, unknown> };
      expect(status.runtimeUpdates).toMatchObject({ localLevel: "notify", localLevelSource: "config" });
      const off = await cliAsync(home, ["updates", "off"]);
      expect(JSON.parse(off.stdout)).toMatchObject({ localLevel: "off", effectiveLevel: "off" });
    } finally {
      await daemon.stop();
    }

    daemon = await Daemon.create({ ...opts, env: { ...daemonEnv, OCW_RUNTIME_UPDATES: "automatic" } });
    try {
      await daemon.start();
      const off = await cliAsync(home, ["updates", "off"]);
      expect(off.code).toBe(0);
      expect(JSON.parse(off.stdout)).toEqual({
        localLevel: "automatic",
        localLevelSource: "env",
        effectiveLevel: "notify", // no org level yet (D-10)
        daemon: "running",
      });
      expect(off.stderr).toContain(ENV_NOTE);
      expect(JSON.parse(readFileSync(join(home, "runtime.json"), "utf8")).runtimeUpdates).toEqual({
        level: "off",
      });
    } finally {
      await daemon.stop();
    }
  }, 60_000);
});
