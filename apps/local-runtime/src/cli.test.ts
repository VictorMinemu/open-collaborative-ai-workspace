import { execFile, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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

// ---------------------------------------------------------------------------------------------
// 07.12-03 `ocw-runtime enroll` (D-03, D-06, PD-06, PD-09): terminal pairing by device code against an in-process HTTP
// stub that speaks the pairing protocol; the typed-code path is unchanged and saves the richer answer too.

const STUB_DEVICE_CODE = "dc_STUB_secret_device_code_0123456789abcdef";
const STUB_TOKEN = "dt_STUB_secret_device_token_0123456789";
const STUB_WEB = "http://web.test";

interface PairingStub {
  url: string;
  requests: Array<{ path: string; body: Record<string, unknown> }>;
  close: () => Promise<void>;
}

/** PD-06 in miniature: start, one `authorization_pending`, then approval; `/devices/enroll` for the typed code. */
async function pairingStub(): Promise<PairingStub> {
  const requests: PairingStub["requests"] = [];
  let polls = 0;
  const answer = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const enrolled = (name: string) => ({
    deviceId: "3f0c1a8e-6c55-4b8e-9d0e-0d3c6d8b9a11",
    organizationId: "7b3e2c51-41f4-4a3e-a5d8-9c1b2e4f6a70",
    deviceToken: STUB_TOKEN,
    name,
    webUrl: STUB_WEB,
    organizationName: "Acme",
    ownerName: "Ada",
  });
  let proposedName = "rack-1";
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      const path = req.url ?? "";
      requests.push({ path, body });
      if (req.method !== "POST") return answer(res, 405, { error: { code: "method", message: "POST only" } });
      if (path === "/api/v1/devices/pairings") {
        proposedName = String(body.name);
        return answer(res, 200, {
          deviceCode: STUB_DEVICE_CODE,
          userCode: "ABCD-EFGH",
          verificationUri: `${STUB_WEB}/settings/devices?add=server`,
          verificationUriComplete: `${STUB_WEB}/settings/devices?pair=ABCD-EFGH`,
          expiresIn: 600,
          interval: 1,
        });
      }
      if (path === "/api/v1/devices/pairings/token") {
        if (body.deviceCode !== STUB_DEVICE_CODE) {
          return answer(res, 400, { error: { code: "expired_token", message: "expired" } });
        }
        if (polls++ === 0) {
          return answer(res, 400, { error: { code: "authorization_pending", message: "pending" } });
        }
        return answer(res, 200, enrolled(proposedName));
      }
      if (path === "/api/v1/devices/enroll") return answer(res, 200, enrolled(String(body.name)));
      return answer(res, 404, { error: { code: "not_found", message: "not found" } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("ocw-runtime enroll (07.12-03, D-03)", () => {
  const stubs: PairingStub[] = [];
  afterEach(async () => {
    for (const s of stubs.splice(0)) await s.close();
  });
  async function setup(): Promise<{ home: string; stub: PairingStub }> {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "ocw-cli-")));
    dirs.push(home);
    const stub = await pairingStub();
    stubs.push(stub);
    return { home, stub };
  }

  it("without --code: prints the link and the code, pairs once approved, never prints the device code or token", async () => {
    const { home, stub } = await setup();
    const r = await cliAsync(home, ["enroll", "--server", stub.url, "--name", "rack-1"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`${STUB_WEB}/settings/devices?pair=ABCD-EFGH`);
    expect(r.stdout).toContain("ABCD-EFGH");
    expect(r.stdout).toContain('Paired "rack-1" with Acme as Ada');
    expect(r.stdout).toContain(`Settings › Devices: ${STUB_WEB}/settings/devices`);
    for (const secret of [STUB_DEVICE_CODE, STUB_TOKEN]) {
      expect(r.stdout).not.toContain(secret);
      expect(r.stderr).not.toContain(secret);
    }
    expect(stub.requests[0]).toMatchObject({ path: "/api/v1/devices/pairings", body: { name: "rack-1" } });
    expect(stub.requests.filter((q) => q.path === "/api/v1/devices/pairings/token")).toHaveLength(2);
    expect(readFileSync(join(home, "device-token"), "utf8").trim()).toBe(STUB_TOKEN);
    expect(statSync(join(home, "device-token")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(home, "runtime.json"), "utf8"))).toMatchObject({
      serverUrl: stub.url,
      deviceName: "rack-1",
      deviceId: "3f0c1a8e-6c55-4b8e-9d0e-0d3c6d8b9a11",
      webUrl: STUB_WEB,
      pairedWith: { organization: "Acme", owner: "Ada" },
    });
  }, 30_000);

  it("without --server: uses the server recorded by install.sh", async () => {
    const { home, stub } = await setup();
    mkdirSync(join(home, "runtime"), { recursive: true });
    writeFileSync(
      join(home, "runtime", "install.json"),
      JSON.stringify({
        serverUrl: stub.url,
        version: "0.1.0",
        sha256: "a".repeat(64),
        installedAt: new Date().toISOString(),
        nodePath: process.execPath,
      }),
    );
    const r = await cliAsync(home, ["enroll", "--name", "rack-2"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Paired "rack-2" with Acme as Ada');
    expect(stub.requests[0]?.path).toBe("/api/v1/devices/pairings");
  }, 30_000);

  it("with no server anywhere: a usage error", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "ocw-cli-")));
    dirs.push(home);
    const r = await cliAsync(home, ["enroll"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("usage: ocw-runtime enroll");
  });

  it("with --code: the typed-code enroll as before, and the answer's webUrl is saved too", async () => {
    const { home, stub } = await setup();
    const r = await cliAsync(home, [
      "enroll",
      "--server",
      stub.url,
      "--code",
      "ABCD-EFGH",
      "--name",
      "laptop",
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(stub.requests.map((q) => q.path)).toEqual(["/api/v1/devices/enroll"]);
    expect(stub.requests[0]?.body).toMatchObject({ code: "ABCD-EFGH", name: "laptop" });
    expect(r.stdout).toContain(`Paired "laptop" with ${stub.url}.`);
    expect(r.stdout).toContain(`${STUB_WEB}/settings/devices`);
    expect(r.stdout).not.toContain(STUB_TOKEN);
    expect(JSON.parse(readFileSync(join(home, "runtime.json"), "utf8"))).toMatchObject({
      serverUrl: stub.url,
      deviceName: "laptop",
      webUrl: STUB_WEB,
    });
  }, 30_000);

  it("Ctrl-C while waiting: 'Pairing cancelled.', exit 130, nothing written", async () => {
    const { home, stub } = await setup();
    const base = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("OCW_")),
    ) as Record<string, string>;
    const child = spawn(process.execPath, [BIN, "enroll", "--server", stub.url], {
      env: { ...base, OCW_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    const deadline = Date.now() + 20_000;
    while (!stdout.includes("Waiting for approval")) {
      if (Date.now() > deadline) throw new Error(`no prompt: ${stdout} ${stderr}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill("SIGINT");
    expect(await exited).toBe(130);
    expect(stderr).toContain("Pairing cancelled.");
    expect(existsSync(join(home, "device-token"))).toBe(false);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
// 07.12-03 `ocw-runtime remove-project <dir|name|id>` (D-07) with the daemon up or down, and the headless "not paired"
// line of an unpaired daemon.

describe("ocw-runtime remove-project (07.12-03, D-07)", () => {
  /** An OCW home plus three project directories; `api` exists twice. */
  function projectsHome(): { home: string; root: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ocw-cli-")));
    dirs.push(root);
    const home = join(root, "ocw");
    for (const d of ["one/api", "two/api", "web", "docs"]) mkdirSync(join(root, d), { recursive: true });
    return { home, root };
  }
  const env = { OCW_RUNTIME_REGISTRY_URL: "http://127.0.0.1:9" };
  async function add(home: string, dir: string): Promise<{ localId: string; name: string }> {
    const r = await cliAsync(home, ["add-project", dir], env);
    expect(r.code, r.stderr).toBe(0);
    return JSON.parse(r.stdout) as { localId: string; name: string };
  }
  const registered = (home: string) =>
    (
      JSON.parse(readFileSync(join(home, "projects.json"), "utf8")) as {
        projects: Array<{ localId: string }>;
      }
    ).projects;

  it("daemon down: removes by directory, by name and by id straight from projects.json (0600 kept)", async () => {
    const { home, root } = projectsHome();
    const api1 = await add(home, join(root, "one", "api"));
    const api2 = await add(home, join(root, "two", "api"));
    const web = await add(home, join(root, "web"));
    const docs = await add(home, join(root, "docs"));

    const byDir = await cliAsync(home, ["remove-project", join(root, "one", "api")], env);
    expect(byDir.code, byDir.stderr).toBe(0);
    expect(byDir.stdout).toContain(`Removed "api" (${api1.localId})`);
    const byName = await cliAsync(home, ["remove-project", "web"], env);
    expect(byName.code, byName.stderr).toBe(0);
    expect(byName.stdout).toContain(`Removed "web" (${web.localId})`);
    const byId = await cliAsync(home, ["remove-project", docs.localId], env);
    expect(byId.code, byId.stderr).toBe(0);
    expect(byId.stdout).toContain(`Removed "docs" (${docs.localId})`);

    expect(registered(home).map((p) => p.localId)).toEqual([api2.localId]);
    expect(statSync(join(home, "projects.json")).mode & 0o777).toBe(0o600);

    const unknown = await cliAsync(home, ["remove-project", "nope"], env);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('no registered project matches "nope"');
    expect(unknown.stderr).toContain(`api (${api2.localId})`);
    const usage = await cliAsync(home, ["remove-project"], env);
    expect(usage.code).toBe(1);
    expect(usage.stderr).toContain("usage: ocw-runtime remove-project <dir|name|id>");
  }, 60_000);

  it("an ambiguous name fails listing the candidates and removes nothing", async () => {
    const { home, root } = projectsHome();
    const api1 = await add(home, join(root, "one", "api"));
    const api2 = await add(home, join(root, "two", "api"));
    const r = await cliAsync(home, ["remove-project", "api"], env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      `ambiguous: api (${api1.localId}), api (${api2.localId}); use the id or the directory`,
    );
    expect(registered(home)).toHaveLength(2);
  }, 30_000);

  it("daemon up: the removal goes through the daemon, whose registry no longer lists it", async () => {
    const { home, root } = projectsHome();
    const userHome = join(root, "user");
    mkdirSync(userHome);
    const daemon = await Daemon.create({
      home,
      env: { HOME: userHome, PATH: "/usr/bin:/bin", ...env },
      token: null,
      runtimes: [stubRuntime("claude-code")],
      logger: silentLogger,
      maintenance: { userHome, which: () => null },
    });
    try {
      await daemon.start();
      const web = await add(home, join(root, "web"));
      const docs = await add(home, join(root, "docs"));
      const r = await cliAsync(home, ["remove-project", "web"], env);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain(`Removed "web" (${web.localId})`);
      const listed = await cliAsync(home, ["projects"], env);
      expect((JSON.parse(listed.stdout) as Array<{ localId: string }>).map((p) => p.localId)).toEqual([
        docs.localId,
      ]);
    } finally {
      await daemon.stop();
    }
  }, 60_000);
});

describe("an unpaired daemon (07.12-03)", () => {
  it("tells a headless owner to pair with ocw-runtime setup (or the desktop app)", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "ocw-cli-")));
    dirs.push(home);
    const warnings: string[] = [];
    const daemon = await Daemon.create({
      home,
      env: { HOME: home, PATH: "/usr/bin:/bin", OCW_RUNTIME_UPDATES: "off" },
      token: null,
      runtimes: [stubRuntime("claude-code")],
      logger: { ...silentLogger, warn: (msg) => warnings.push(msg) },
      controlSocket: false,
      maintenance: { userHome: home, which: () => null },
    });
    try {
      await daemon.start();
      expect(warnings).toContain(
        "no device token found; pair this device with `ocw-runtime setup` (or from the desktop app), then restart the runtime",
      );
    } finally {
      await daemon.stop();
    }
  });
});
