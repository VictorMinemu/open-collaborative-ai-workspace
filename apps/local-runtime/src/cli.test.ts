import { execFile, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
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
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeId } from "@ocw/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "./daemon.js";
import { DoctorReport } from "./doctor.js";
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
      // The first version probe runs after start resolves; under load it can still be pending on the first status.
      let parsed: { runtimes: Array<Record<string, unknown>> } = { runtimes: [] };
      await vi.waitFor(
        async () => {
          const status = await cliAsync(home, ["updates", "status"], env);
          expect(status.code).toBe(0);
          parsed = JSON.parse(status.stdout) as typeof parsed;
          expect(parsed.runtimes.find((r) => r.runtime === "claude-code")?.installedVersion).toBe("2.1.290");
        },
        { timeout: 20_000, interval: 250 },
      );
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
      // What `setup` and `doctor` also ask (07.12-08): health, the served runtime (none here) and the token check.
      if (req.method === "GET" && path === "/health") return answer(res, 200, { status: "ok" });
      if (req.method === "GET" && path === "/api/v1/runtime/version") {
        return answer(res, 404, { error: { code: "runtime_unavailable", message: "no runtime bundle" } });
      }
      if (req.method !== "POST") return answer(res, 405, { error: { code: "method", message: "POST only" } });
      if (path === "/api/v1/devices/token") {
        return req.headers.authorization === `Bearer ${STUB_TOKEN}`
          ? answer(res, 200, { token: "eyJ.stub.jwt", expiresIn: 900 })
          : answer(res, 401, { error: { code: "unauthorized", message: "unknown device" } });
      }
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

describe("ocw-runtime add-project: projects without git", () => {
  /** An OCW home and a scratch user home (HOME) inside one temp root. */
  function scratch(): { home: string; userHome: string; env: Record<string, string> } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ocw-cli-")));
    dirs.push(root);
    const userHome = join(root, "user");
    mkdirSync(userHome);
    return {
      home: join(root, "ocw"),
      userHome,
      env: { HOME: userHome, OCW_RUNTIME_REGISTRY_URL: "http://127.0.0.1:9" },
    };
  }
  const registered = (home: string): unknown[] =>
    existsSync(join(home, "projects.json"))
      ? (JSON.parse(readFileSync(join(home, "projects.json"), "utf8")) as { projects: unknown[] }).projects
      : [];

  it("a folder without git is registered as it is, nothing created in it, with one line saying so", async () => {
    const { home, userHome, env } = scratch();
    const dir = join(userHome, "notes");
    mkdirSync(dir);
    writeFileSync(join(dir, "todo.md"), "- one\n");
    const r = await cliAsync(home, ["add-project", dir], env);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      name: "notes",
      path: dir,
      gitRemote: null,
      defaultBranch: null,
      git: false,
    });
    expect(r.stderr.trim()).toBe(
      "notes has no git repository: sessions work; changes and worktrees are off.",
    );
    expect(readdirSync(dir)).toEqual(["todo.md"]);
  }, 30_000);

  it("the home folder and the OCW home are refused, with or without git, and nothing is registered", async () => {
    const { home, userHome, env } = scratch();
    const atHome = await cliAsync(home, ["add-project", userHome], env);
    expect(atHome.code).toBe(1);
    expect(atHome.stderr).toContain("home folder");
    mkdirSync(home, { recursive: true });
    const atState = await cliAsync(home, ["add-project", home], env);
    expect(atState.code).toBe(1);
    expect(atState.stderr).toContain("OCW");
    expect(registered(home)).toEqual([]);
    expect(existsSync(join(userHome, ".git"))).toBe(false);
  }, 30_000);

  it("a repository is registered as before, with no line on stderr", async () => {
    const { home, userHome, env } = scratch();
    const repo = join(userHome, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    const r = await cliAsync(home, ["add-project", repo], env);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toMatchObject({ name: "repo", defaultBranch: "main", git: true });
  }, 30_000);
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

// ---------------------------------------------------------------------------------------------
// 07.12-03 `~/.ocw/service.env` (D-12, PD-10): `ocw-runtime run` reads it before the daemon is created. PD-19: a scratch
// HOME and PATH, updates off and a dead registry, so nothing real is ever run or updated.

describe("ocw-runtime run reads ~/.ocw/service.env (07.12-03, D-12)", () => {
  /** Starts `run`, waits for the control socket, stops it with SIGTERM and returns its stderr. */
  async function runDaemon(env: Record<string, string>, socket: string): Promise<string> {
    const base = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("OCW_")),
    ) as Record<string, string>;
    const child = spawn(process.execPath, [BIN, "run"], {
      env: { ...base, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout.on("data", (d: Buffer) => {
      logs += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      logs += d.toString();
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    try {
      const deadline = Date.now() + 20_000;
      while (!existsSync(socket)) {
        if (child.exitCode !== null) throw new Error(`daemon exited early: ${logs}`);
        if (Date.now() > deadline) throw new Error(`no control socket after 20 s: ${logs}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      child.kill("SIGTERM");
    }
    expect(await exited).toBe(0);
    return logs;
  }

  function scratch(): { userHome: string; home: string; env: Record<string, string> } {
    const userHome = realpathSync(mkdtempSync(join(tmpdir(), "ocw-cli-")));
    dirs.push(userHome);
    const home = join(userHome, ".ocw");
    mkdirSync(home, { mode: 0o700 });
    return {
      userHome,
      home,
      env: {
        HOME: userHome,
        OCW_HOME: home,
        PATH: "/usr/bin:/bin",
        OCW_RUNTIME_UPDATES: "off",
        OCW_RUNTIME_REGISTRY_URL: "http://127.0.0.1:9",
      },
    };
  }

  it("a 0600 file is applied before the daemon is created (it switches the fake runtime on)", async () => {
    const { home, env } = scratch();
    const file = join(home, "service.env");
    writeFileSync(file, "# service secrets\nOCW_RUNTIME_FAKE=1\nSECRET_PROBE=probe-value-71\n", {
      mode: 0o600,
    });
    const logs = await runDaemon(env, join(home, "runtime.sock"));
    expect(logs).toContain("OCW_RUNTIME_FAKE=1: using the fake runtime");
    expect(logs).toContain("SECRET_PROBE");
    expect(logs).not.toContain("probe-value-71");
  }, 60_000);

  it("a group- or world-readable file is refused with the chmod line and no value", async () => {
    const { home, env } = scratch();
    const file = join(home, "service.env");
    writeFileSync(file, "SECRET_PROBE=probe-value-72\n", { mode: 0o644 });
    chmodSync(file, 0o644);
    const logs = await runDaemon({ ...env, OCW_RUNTIME_FAKE: "1" }, join(home, "runtime.sock"));
    expect(logs).toContain("chmod 600 ~/.ocw/service.env");
    expect(logs).not.toContain("probe-value-72");
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// 07.12-08 `ocw-runtime setup` (D-02, D-06, PD-13) against the pairing stub. PD-19: a scratch HOME, OCW_HOME and PATH,
// runtime.json pointing Claude Code and Codex at missing files (the doctor never runs the real CLIs), the fake runtime,
// updates off, a dead registry and `--service none` (no service manager is touched).

describe("ocw-runtime setup (07.12-08, D-02)", () => {
  const stubs: PairingStub[] = [];
  afterEach(async () => {
    for (const s of stubs.splice(0)) await s.close();
  });

  async function scratch(): Promise<{
    userHome: string;
    home: string;
    repo: string;
    env: Record<string, string>;
    stub: PairingStub;
  }> {
    const userHome = realpathSync(mkdtempSync(join(tmpdir(), "ocw-cli-")));
    dirs.push(userHome);
    const home = join(userHome, ".ocw");
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(
      join(home, "runtime.json"),
      JSON.stringify({
        claude: { path: join(userHome, "no-claude") },
        codex: { path: join(userHome, "no-codex") },
      }),
      { mode: 0o600 },
    );
    const repo = join(userHome, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    const stub = await pairingStub();
    stubs.push(stub);
    return {
      userHome,
      home,
      repo,
      stub,
      env: {
        HOME: userHome,
        OCW_HOME: home,
        PATH: "/usr/bin:/bin",
        OCW_RUNTIME_FAKE: "1",
        OCW_RUNTIME_UPDATES: "off",
        OCW_RUNTIME_REGISTRY_URL: "http://127.0.0.1:9",
      },
    };
  }

  it("--yes --service none pairs, registers the repo, skips the service, runs the doctor and prints the link; a re-run changes nothing", async () => {
    const { home, repo, env, stub } = await scratch();
    const args = [
      "setup",
      "--yes",
      "--server",
      stub.url,
      "--name",
      "rack-1",
      "--project",
      repo,
      "--service",
      "none",
    ];
    const first = await cliAsync(home, args, env);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain("ABCD-EFGH");
    expect(first.stdout).toContain('Paired "rack-1" with Acme as Ada.');
    expect(first.stdout).toContain('Registered "repo" (~/repo).');
    expect(first.stdout).toContain("run `ocw-runtime run` under your own supervisor");
    expect(first.stdout).toContain("ocw-runtime doctor · account");
    expect(first.stdout).toContain(`Settings › Devices: ${STUB_WEB}/settings/devices`);
    expect(first.stdout.trimEnd().endsWith("Share it with members and teams there.")).toBe(true);
    for (const secret of [STUB_DEVICE_CODE, STUB_TOKEN]) {
      expect(first.stdout).not.toContain(secret);
      expect(first.stderr).not.toContain(secret);
    }
    const projects = JSON.parse(readFileSync(join(home, "projects.json"), "utf8")) as {
      projects: Array<{ path: string; name: string }>;
    };
    expect(projects.projects).toMatchObject([{ path: repo, name: "repo" }]);

    const pairingsBefore = stub.requests.filter((q) => q.path === "/api/v1/devices/pairings").length;
    const second = await cliAsync(home, args, env);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toContain(`Already paired as "rack-1" with ${stub.url}`);
    expect(second.stdout).toContain("~/repo is already registered");
    expect(stub.requests.filter((q) => q.path === "/api/v1/devices/pairings")).toHaveLength(pairingsBefore);
    expect(second.stdout).not.toContain(STUB_TOKEN);
  }, 60_000);

  it("a usage error exits 2 with the usage; without a terminal a missing value names its flag", async () => {
    const { home, env } = await scratch();
    const bad = await cliAsync(home, ["setup", "--frobnicate"], env);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("unknown option --frobnicate");
    expect(bad.stderr).toContain("usage: ocw-runtime setup");
    const noServer = await cliAsync(home, ["setup", "--yes"], env);
    expect(noServer.code).toBe(2);
    expect(noServer.stderr).toContain("pass --server <url>");
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
// 07.12-08 `ocw-runtime doctor [--json]` and `ocw-runtime service …` (D-04, D-05, D-12, PD-12, PD-19). Scratch HOME and
// OCW_HOME; the server is a dead loopback port; Claude Code and Codex point at missing files. The spawned CLI inherits
// VITEST, so the PD-19 guard refuses systemctl/launchctl/loginctl/journalctl in the child: fakes of all four sit first on
// PATH and would leave a marker if anything ever ran them.

describe("ocw-runtime doctor and service (07.12-08, D-04, D-05)", () => {
  function scratch(): { userHome: string; home: string; env: Record<string, string> } {
    const userHome = realpathSync(mkdtempSync(join(tmpdir(), "ocw-cli-")));
    dirs.push(userHome);
    const home = join(userHome, ".ocw");
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(
      join(home, "runtime.json"),
      JSON.stringify({
        serverUrl: "http://127.0.0.1:9",
        claude: { path: join(userHome, "no-claude") },
        codex: { path: join(userHome, "no-codex") },
      }),
      { mode: 0o600 },
    );
    return {
      userHome,
      home,
      env: {
        HOME: userHome,
        OCW_HOME: home,
        PATH: "/usr/bin:/bin",
        OCW_RUNTIME_UPDATES: "off",
        OCW_RUNTIME_REGISTRY_URL: "http://127.0.0.1:9",
      },
    };
  }

  it("doctor --json (not paired, no daemon): a DoctorReport with pairing fail, exit 1; the text has the header and counts", async () => {
    expect(process.env.VITEST).toBeTruthy(); // reaches the child: the PD-19 guard is active there
    const { home, env } = scratch();
    const json = await cliAsync(home, ["doctor", "--json"], env);
    expect(json.code, json.stderr).toBe(1);
    const report = DoctorReport.parse(JSON.parse(json.stdout));
    expect(report.checks.find((c) => c.id === "pairing")?.status).toBe("fail");
    const text = await cliAsync(home, ["doctor"], env);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain("ocw-runtime doctor · account");
    expect(text.stdout).toMatch(/\d+ warnings?, \d+ failures?/);
    const bad = await cliAsync(home, ["doctor", "--yaml"], env);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("usage: ocw-runtime doctor [--json]");
  }, 60_000);

  it("doctor reads service.env as the service would: 0644 is a fail, a 0600 key is named and its value never shown", async () => {
    const { home, env } = scratch();
    const file = join(home, "service.env");
    writeFileSync(file, "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-doctor-secret-value-1234\n", { mode: 0o644 });
    chmodSync(file, 0o644);
    const loose = await cliAsync(home, ["doctor", "--json"], env);
    const looseReport = DoctorReport.parse(JSON.parse(loose.stdout));
    expect(looseReport.checks.find((c) => c.id === "service-env")?.status).toBe("fail");
    expect(loose.stdout).not.toContain("doctor-secret-value");

    chmodSync(file, 0o600);
    const tight = await cliAsync(home, ["doctor", "--json"], env);
    const tightReport = DoctorReport.parse(JSON.parse(tight.stdout));
    const check = tightReport.checks.find((c) => c.id === "service-env");
    expect(check?.status).toBe("ok");
    expect(check?.summary).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(tight.stdout).not.toContain("doctor-secret-value");
    expect(tight.stderr).not.toContain("doctor-secret-value");
  }, 60_000);

  it("service status --json names the manager and no real service manager ever runs (PD-19)", async () => {
    const { userHome, home, env } = scratch();
    const fakes = join(userHome, "fake-bin");
    const markers = join(userHome, "markers");
    mkdirSync(fakes);
    mkdirSync(markers);
    for (const tool of ["systemctl", "launchctl", "loginctl", "journalctl"]) {
      writeFileSync(join(fakes, tool), `#!/bin/sh\necho "$@" > "${markers}/${tool}"\nexit 0\n`, {
        mode: 0o755,
      });
    }
    // An installed unit and LaunchAgent, so status would ask the manager about them.
    const unitDir = join(userHome, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(
      join(unitDir, "ocw-runtime.service"),
      '[Service]\nExecStart="/usr/bin/node" "/x.mjs" run\n',
    );
    const agents = join(userHome, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "org.ocw.runtime.plist"), "<plist><dict></dict></plist>\n");

    const r = await cliAsync(home, ["service", "status", "--json"], {
      ...env,
      PATH: `${fakes}:/usr/bin:/bin`,
    });
    if (process.getuid?.() === 0) {
      // CI containers run as root, where every `service` command stops before touching a manager (HI-01).
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("ocw-runtime does not run as root");
    } else {
      expect([0, 1]).toContain(r.code);
      const status = JSON.parse(r.stdout) as { manager: string; active: boolean | null };
      expect(["systemd-user", "systemd-system", "launchd", "none"]).toContain(status.manager);
      expect(status.active).not.toBe(true);
    }
    expect(readdirSync(markers)).toEqual([]);

    const usage = await cliAsync(home, ["service"], env);
    expect(usage.code).toBe(1);
    expect(usage.stdout).toContain("usage: ocw-runtime service");
  }, 60_000);
});
