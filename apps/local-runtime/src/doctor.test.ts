import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNTIME_COMPATIBILITY_MANIFEST,
  type RuntimeCompatibilityManifest,
  type RuntimeDistManifest,
  type RuntimeInfo,
} from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { ProjectRegistry, RuntimeConfigSchema } from "./config.js";
import {
  createDoctorDeps,
  type DaemonStatusView,
  DOCTOR_CHECK_IDS,
  type DoctorCheck,
  type DoctorCheckId,
  type DoctorDeps,
  DoctorReport,
  doctorExitCode,
  formatDoctorJson,
  formatDoctorText,
  runDoctor,
  safeLine,
} from "./doctor.js";
import type { RuntimeInstallInfo } from "./install-info.js";
import type { ServiceEnvSummary, ServiceStatus } from "./service/types.js";

// ---------------------------------------------------------------- a protocol-faithful fake server

const SERVER = "https://ocw.example.com";
const HOME = "/home/build";
const TOKEN = "ocwd_SECRET123abcdefghijklmnop";
const SHA = "a".repeat(64);

const manifest = (sha = SHA, version = "0.1.0"): RuntimeDistManifest => ({
  version,
  sha256: sha,
  bytes: 1_500_000,
  file: "ocw-runtime.mjs",
  minNode: 24,
  external: [{ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.282" }],
  externalLockSha256: "b".repeat(64),
  bundled: [],
  source: { repository: "https://github.com/example/ocw", commit: null },
  builtAt: "2026-10-29T10:00:00.000Z",
});

type Recorded = { method: string; path: string; authorization: string | null; body: unknown };

interface FakeServer {
  health?: number | "refused";
  version?: RuntimeDistManifest | number | "refused";
  token?: number | "refused";
}

function fakeFetch(server: FakeServer = {}): { fetch: DoctorDeps["fetch"]; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const refused = (): never => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
  };
  const fetch: DoctorDeps["fetch"] = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    requests.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      authorization: headers.get("authorization"),
      body: init?.body ?? null,
    });
    if (url.pathname === "/health") {
      const h = server.health ?? 200;
      if (h === "refused") return refused();
      return Response.json(
        {
          status: h === 200 ? "ok" : "error",
          version: "0.9.0",
          checks: { db: h === 200 ? "ok" : "error", redis: "ok" },
        },
        { status: h },
      );
    }
    if (url.pathname === "/api/v1/runtime/version") {
      const v = server.version ?? manifest();
      if (v === "refused") return refused();
      if (typeof v === "number") return Response.json({ code: "not_found" }, { status: v });
      return Response.json(v);
    }
    if (url.pathname === "/api/v1/devices/token" && init?.method === "POST") {
      const t = server.token ?? 200;
      if (t === "refused") return refused();
      if (t === 200 && headers.get("authorization") === `Bearer ${TOKEN}`) {
        return Response.json({
          token: "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJkZXYifQ.c2lnbmF0dXJlLXNlY3JldA",
          expiresAt: "2026-10-29T10:10:00.000Z",
        });
      }
      return Response.json(
        { code: "invalid_device_token", message: "Invalid device token" },
        { status: t === 200 ? 401 : t },
      );
    }
    return Response.json({ code: "not_found" }, { status: 404 });
  };
  return { fetch, requests };
}

// ---------------------------------------------------------------- injected probes (no real CLI, server or ~/.ocw)

const install: RuntimeInstallInfo = {
  serverUrl: SERVER,
  version: "0.1.0",
  sha256: SHA,
  installedAt: "2026-10-29T09:00:00.000Z",
  nodePath: `${HOME}/.nvm/versions/node/v24.22.1/bin/node`,
};

const serviceActive: ServiceStatus = {
  manager: "systemd-user",
  installed: true,
  enabled: true,
  active: true,
  linger: true,
  account: "build",
  unitPath: "~/.config/systemd/user/ocw-runtime.service",
  nodePathExists: true,
  bundlePathExists: true,
  reason: null,
};

const claudeReady: RuntimeInfo = { id: "claude-code", installed: true, version: "2.1.300", loggedIn: true };
const codexReady: RuntimeInfo = { id: "codex", installed: true, version: "0.170.0", loggedIn: true };

function deps(
  over: Partial<DoctorDeps> = {},
  server: FakeServer = {},
): DoctorDeps & { requests: Recorded[] } {
  const { fetch, requests } = fakeFetch(server);
  const base: DoctorDeps = {
    nodeVersion: () => "24.22.1",
    account: () => "build",
    config: async () =>
      RuntimeConfigSchema.parse({
        serverUrl: SERVER,
        deviceName: "build-01",
        webUrl: "https://ocw.example.com",
        deviceId: "0b9f1c3e-8a7d-4e2b-9c1f-5d6e7f8a9b0c",
        pairedWith: { organization: "Acme", owner: "Dana Ruiz", at: "2026-10-29T09:30:00.000Z" },
      }),
    token: async () => TOKEN,
    installInfo: async () => install,
    bundleSha256: async () => SHA,
    fetch,
    controlStatus: async () => ({
      paired: true,
      connected: true,
      serverUrl: SERVER,
      deviceName: "build-01",
      runtimes: [claudeReady, codexReady],
      projects: 1,
      // A 07.11+ daemon with real runtimes always runs maintenance and reports its levels.
      runtimeUpdates: {
        localLevel: "automatic",
        localLevelSource: "config",
        effectiveLevel: "automatic",
        runtimes: [],
      },
      sessions: [],
    }),
    service: async () => serviceActive,
    serviceEnv: async (): Promise<ServiceEnvSummary> => ({ status: "absent", keys: [], invalidLines: 0 }),
    detectClaude: async () => claudeReady,
    detectCodex: async () => codexReady,
    git: async () => "2.47.0",
    projects: async () => [{ name: "app", path: `${HOME}/src/app`, exists: true, isGitRepo: true }],
    updatesLevel: async () => ({ level: "automatic", source: "config" }),
    homeDir: () => HOME,
    now: () => new Date("2026-10-29T10:00:00.000Z"),
  };
  return { ...base, ...over, fetch: over.fetch ?? fetch, requests };
}

function check(report: DoctorReport, id: DoctorCheckId): DoctorCheck {
  const found = report.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no ${id} check`);
  return found;
}

// ---------------------------------------------------------------- Task 1

describe("ocw-runtime doctor: node, runtime, pairing, server (07.12, D-05, D-06, PD-12)", () => {
  it("is all ok against a matching server, names the device, the organization and the owner, and links Settings › Devices", async () => {
    const report = await runDoctor(deps());
    for (const id of ["node", "runtime", "pairing", "server"] as const) {
      expect(check(report, id), id).toMatchObject({ status: "ok", fix: null });
    }
    expect(check(report, "pairing").summary).toContain("build-01");
    expect(check(report, "pairing").summary).toContain("Acme");
    expect(check(report, "pairing").summary).toContain("Dana Ruiz");
    expect(check(report, "node").summary).toContain("24.22.1");
    expect(report.link).toBe("https://ocw.example.com/settings/devices");
    expect(report.account).toBe("build");
    expect(report.device).toBe("build-01");
    expect(DoctorReport.parse(report)).toEqual(report);
  });

  it("fails Node below 24", async () => {
    const report = await runDoctor(deps({ nodeVersion: () => "22.12.0" }));
    expect(check(report, "node")).toMatchObject({ status: "fail" });
    expect(check(report, "node").fix).toContain("Install Node 24 or later");
    expect(doctorExitCode(report)).toBe(1);
  });

  it("warns when the installed bundle differs from the server's, with the re-install and restart fix", async () => {
    const report = await runDoctor(deps({}, { version: manifest("b".repeat(64), "0.1.1") }));
    const runtime = check(report, "runtime");
    expect(runtime.status).toBe("warn");
    expect(runtime.summary).toContain("0.1.0");
    expect(runtime.summary).toContain("0.1.1");
    expect(runtime.fix).toContain("re-run the install command");
    expect(runtime.fix).toContain("`ocw-runtime service restart`");
  });

  it("warns when the version route is unreachable or missing", async () => {
    for (const version of ["refused", 404] as const) {
      const runtime = check(await runDoctor(deps({}, { version })), "runtime");
      expect(runtime.status).toBe("warn");
      expect(runtime.summary).toContain("could not compare with the server");
    }
  });

  it("is ok in a development checkout (no install record) and asks the server nothing about versions", async () => {
    const d = deps({ installInfo: async () => null, bundleSha256: async () => null });
    const runtime = check(await runDoctor(d), "runtime");
    expect(runtime).toMatchObject({ status: "ok", fix: null });
    expect(runtime.summary).toContain("development checkout");
    expect(d.requests.some((r) => r.path === "/api/v1/runtime/version")).toBe(false);
  });

  it("fails pairing without a token, and with a revoked or unknown one", async () => {
    const none = check(await runDoctor(deps({ token: async () => null })), "pairing");
    expect(none.status).toBe("fail");
    expect(none.summary).toContain("Not paired");
    expect(none.fix).toContain("run `ocw-runtime setup`");

    const revoked = check(await runDoctor(deps({}, { token: 401 })), "pairing");
    expect(revoked.status).toBe("fail");
    expect(revoked.fix).toContain("revoked or unknown: run `ocw-runtime setup` to pair again");
  });

  it("fails the server check naming the URL when /health is refused", async () => {
    const report = await runDoctor(deps({}, { health: "refused", token: "refused", version: "refused" }));
    const server = check(report, "server");
    expect(server.status).toBe("fail");
    expect(server.summary).toContain(SERVER);
    expect(doctorExitCode(report)).toBe(1);
  });

  it("turns a probe that throws into that check's fail, never a crash", async () => {
    const report = await runDoctor(
      deps({
        nodeVersion: () => {
          throw new Error("boom");
        },
      }),
    );
    expect(check(report, "node")).toMatchObject({ status: "fail" });
    expect(check(report, "node").summary).toContain("boom");
  });

  it("prints a header, one line per check with its status word, the fix under it, the link and the counts", async () => {
    const report = await runDoctor(deps({ nodeVersion: () => "22.12.0" }, { version: 404 }));
    const text = formatDoctorText(report);
    const lines = text.split("\n");
    expect(lines[0]).toBe('ocw-runtime doctor · account build · device "build-01"');
    const nodeLine = lines.findIndex((l) => /^\s*fail\s+node\s/.test(l));
    expect(nodeLine).toBeGreaterThan(0);
    expect(lines[nodeLine + 1]).toMatch(/^\s{4,}.*Install Node 24 or later/);
    expect(lines.some((l) => /^\s*warn\s+runtime\s/.test(l))).toBe(true);
    expect(lines.some((l) => /^\s*ok\s+pairing\s/.test(l))).toBe(true);
    expect(text).toContain("https://ocw.example.com/settings/devices");
    expect(text).toContain(`${report.counts.warn} warning`);
    expect(text).toMatch(/\d+ warnings?, \d+ failures?/);
  });

  it("JSON output parses through the report schema; the exit code is 0 without a fail", async () => {
    const report = await runDoctor(deps());
    const parsed = DoctorReport.parse(JSON.parse(JSON.stringify(report)));
    expect(parsed.counts.fail).toBe(0);
    expect(doctorExitCode(parsed)).toBe(0);
    expect(parsed.counts.ok + parsed.counts.warn + parsed.counts.fail).toBe(parsed.checks.length);
  });
});

// ---------------------------------------------------------------- Task 2

const notRunning = { controlStatus: async () => null };

function brokenAround(version: string): RuntimeCompatibilityManifest {
  return {
    ...RUNTIME_COMPATIBILITY_MANIFEST,
    runtimes: {
      ...RUNTIME_COMPATIBILITY_MANIFEST.runtimes,
      "claude-code": {
        ...RUNTIME_COMPATIBILITY_MANIFEST.runtimes["claude-code"],
        ranges: [
          { bounds: { min: version, maxExclusive: "9.9.9" }, status: "broken", note: "known bad" },
          ...RUNTIME_COMPATIBILITY_MANIFEST.runtimes["claude-code"].ranges,
        ],
      },
    },
  };
}

describe("ocw-runtime doctor: every other check with its fix line (07.12, D-05, D-12, PD-12)", () => {
  it("reports all thirteen checks in the PD-12 order, all ok on a ready server", async () => {
    const report = await runDoctor(deps());
    expect(report.checks.map((c) => c.id)).toEqual([...DOCTOR_CHECK_IDS]);
    expect(report.checks.filter((c) => c.status !== "ok")).toEqual([]);
    expect(report.counts).toEqual({ ok: 13, warn: 0, fail: 0 });
  });

  it("daemon: connected ok, not connected warn, not running fail with a service and warn without", async () => {
    expect(check(await runDoctor(deps()), "daemon").status).toBe("ok");
    const disconnected = check(
      await runDoctor(
        deps({
          controlStatus: async () => ({ paired: true, connected: false, runtimes: [], sessions: [] }),
        }),
      ),
      "daemon",
    );
    expect(disconnected.status).toBe("warn");

    const withService = check(await runDoctor(deps(notRunning)), "daemon");
    expect(withService.status).toBe("fail");
    expect(withService.fix).toContain(
      "not running: `ocw-runtime service status`, then `ocw-runtime service logs`",
    );

    const noService = check(
      await runDoctor(
        deps({
          ...notRunning,
          service: async () => ({ ...serviceActive, installed: false, active: null, unitPath: null }),
        }),
      ),
      "daemon",
    );
    expect(noService.status).toBe("warn");
    expect(noService.fix).toContain("not running: `ocw-runtime run` or `ocw-runtime service install`");
  });

  it("service: from ServiceStatus, each state with its fix", async () => {
    const svc = async (s: Partial<ServiceStatus>) =>
      check(await runDoctor(deps({ service: async () => ({ ...serviceActive, ...s }) })), "service");

    const none = await svc({
      manager: "none",
      installed: false,
      enabled: null,
      active: null,
      linger: null,
      unitPath: null,
      nodePathExists: null,
      bundlePathExists: null,
      reason: "no systemd in this container",
    });
    expect(none.status).toBe("warn");
    expect(none.fix).toContain("`ocw-runtime run` under your own supervisor");

    expect((await svc({})).status).toBe("ok");
    expect((await svc({ active: false })).status).toBe("fail");

    const nodeGone = await svc({ nodePathExists: false });
    expect(nodeGone.status).toBe("fail");
    expect(nodeGone.fix).toBe(
      "the service's Node was removed (an nvm upgrade?): re-run `ocw-runtime service install`",
    );

    const linger = await svc({ linger: false });
    expect(linger.status).toBe("warn");
    expect(linger.fix).toContain("`sudo loginctl enable-linger build` so it runs without a login session");
  });

  it("claude-code: not installed, unsupported, broken, signed out, the env token and a system account", async () => {
    const claude = async (info: Partial<RuntimeInfo>, over: Partial<DoctorDeps> = {}) =>
      check(
        await runDoctor(
          deps({ ...notRunning, detectClaude: async () => ({ ...claudeReady, ...info }), ...over }),
        ),
        "claude-code",
      );

    const missing = await claude({ installed: false, version: null, loggedIn: false });
    expect(missing.status).toBe("warn");
    expect(missing.fix).toBe("Install Claude Code as build: see the native installer in SERVER.md");

    const old = await claude({ version: "2.1.200" });
    expect(old.status).toBe("warn");
    expect(old.summary).toContain("older than supported");

    const broken = await claude({ version: "2.1.300" }, { compatibility: () => brokenAround("2.1.299") });
    expect(broken.status).toBe("fail");

    const signedOut = await claude({ loggedIn: false });
    expect(signedOut.status).toBe("warn");
    expect(signedOut.fix).toContain("as build");
    expect(signedOut.fix).toContain("`claude auth login`");
    expect(signedOut.fix).toContain("press c to copy the login URL");
    expect(signedOut.fix).toContain("`claude setup-token`");
    expect(signedOut.fix).toContain("CLAUDE_CODE_OAUTH_TOKEN");

    const envToken = await claude(
      { loggedIn: false },
      {
        serviceEnv: async () => ({ status: "loaded", keys: ["CLAUDE_CODE_OAUTH_TOKEN"], invalidLines: 0 }),
      },
    );
    expect(envToken.status).toBe("warn");
    expect(envToken.summary).toContain(
      "CLAUDE_CODE_OAUTH_TOKEN is set in ~/.ocw/service.env (not verifiable without a request)",
    );

    const system = await runDoctor(
      deps({
        ...notRunning,
        account: () => "root",
        detectClaude: async () => ({ ...claudeReady, loggedIn: false }),
        detectCodex: async () => ({ ...codexReady, loggedIn: false }),
        service: async () => ({
          ...serviceActive,
          manager: "systemd-system",
          account: "build",
          linger: null,
        }),
      }),
    );
    const claudeFix = check(system, "claude-code").fix ?? "";
    expect(claudeFix).toContain("`sudo -u build -i claude auth login`");
    expect(claudeFix).toContain("as build");
    expect(claudeFix).not.toContain("`claude auth login`");
    expect(check(system, "codex").fix).toContain("`sudo -u build -i codex login --device-auth`");
    expect(check(system, "codex").fix).toContain("`sudo -u build -i codex login`");
  });

  it("codex: signed out gets the device-auth line and the SSH port forward", async () => {
    const codex = check(
      await runDoctor(deps({ ...notRunning, detectCodex: async () => ({ ...codexReady, loggedIn: false }) })),
      "codex",
    );
    expect(codex.status).toBe("warn");
    expect(codex.fix).toContain("`codex login --device-auth`");
    expect(codex.fix).toContain("enable device code login in your ChatGPT security settings");
    expect(codex.fix).toContain("`ssh -L 1455:localhost:1455 build@<this server>`");
    expect(codex.fix).toContain("as build");
  });

  it("takes runtime facts from a running daemon's status without running the detectors", async () => {
    let detected = 0;
    const report = await runDoctor(
      deps({
        controlStatus: async () => ({
          paired: true,
          connected: true,
          runtimes: [{ ...claudeReady, loggedIn: false }, codexReady],
          sessions: [],
        }),
        detectClaude: async () => {
          detected += 1;
          return claudeReady;
        },
        detectCodex: async () => {
          detected += 1;
          return codexReady;
        },
      }),
    );
    expect(detected).toBe(0);
    expect(check(report, "claude-code").status).toBe("warn");
    expect(check(report, "runtimes")).toMatchObject({ status: "ok" });
    expect(check(report, "runtimes").summary).toContain("Codex");
  });

  it("uses the daemon's installed compatibility when it reports one", async () => {
    const report = await runDoctor(
      deps({
        controlStatus: async () => ({
          paired: true,
          connected: true,
          runtimes: [claudeReady, codexReady],
          runtimeUpdates: {
            localLevel: "automatic",
            effectiveLevel: "automatic",
            runtimes: [{ runtime: "claude-code", installedCompatibility: "broken" }],
          },
          sessions: [],
        }),
      }),
    );
    expect(check(report, "claude-code").status).toBe("fail");
  });

  it("updates: reports what the running daemon does, not this shell's environment (07.12-11)", async () => {
    const running = (runtimeUpdates?: DaemonStatusView["runtimeUpdates"]) =>
      deps({
        controlStatus: async () => ({
          paired: true,
          connected: true,
          runtimes: [claudeReady, codexReady],
          ...(runtimeUpdates ? { runtimeUpdates } : {}),
          sessions: [],
        }),
        // This shell would say "automatic"; the daemon's answer must win.
        updatesLevel: async () => ({ level: "automatic", source: "config" }),
      });

    // A daemon that manages no updates (fake runtime, or a runtime older than 07.11) updates nothing.
    const none = check(await runDoctor(running()), "updates");
    expect(none.status).toBe("warn");
    expect(none.summary).toContain("The running runtime does not manage CLI updates");
    expect(none.fix).toContain("`ocw-runtime service restart`");

    // The daemon got OCW_RUNTIME_UPDATES=off from its own environment (supervisor or service.env).
    const offFromEnv = check(
      await runDoctor(
        running({ localLevel: "off", localLevelSource: "env", effectiveLevel: "off", runtimes: [] }),
      ),
      "updates",
    );
    expect(offFromEnv.status).toBe("warn");
    expect(offFromEnv.summary).toBe("Runtime CLI updates are off (from OCW_RUNTIME_UPDATES)");
    expect(offFromEnv.fix).toContain("OCW_RUNTIME_UPDATES");

    const automatic = check(
      await runDoctor(
        running({
          localLevel: "automatic",
          localLevelSource: "config",
          effectiveLevel: "automatic",
          runtimes: [],
        }),
      ),
      "updates",
    );
    expect(automatic).toMatchObject({ status: "ok", summary: "Runtime CLI updates: automatic", fix: null });
  });

  it("runtimes: fails when nothing is installed and signed in", async () => {
    const report = await runDoctor(
      deps({
        ...notRunning,
        detectClaude: async () => ({ ...claudeReady, loggedIn: false }),
        detectCodex: async () => ({ id: "codex", installed: false, version: null, loggedIn: false }),
      }),
    );
    expect(check(report, "runtimes").status).toBe("fail");
    expect(doctorExitCode(report)).toBe(1);
  });

  it("git, projects, updates and service-env", async () => {
    const git = check(await runDoctor(deps({ git: async () => null })), "git");
    expect(git.status).toBe("fail");
    expect(git.fix).toContain("Install git");

    const none = check(await runDoctor(deps({ projects: async () => [] })), "projects");
    expect(none.status).toBe("warn");
    expect(none.fix).toBe("Register a repository: `ocw-runtime add-project <dir>`");

    const gone = check(
      await runDoctor(
        deps({
          projects: async () => [
            { name: "app", path: `${HOME}/src/app`, exists: true, isGitRepo: true },
            { name: "payments", path: "/srv/repos/payments", exists: false, isGitRepo: false },
          ],
        }),
      ),
      "projects",
    );
    expect(gone.status).toBe("fail");
    expect(gone.fix).toContain("payments:");
    expect(gone.fix).toContain("`ocw-runtime remove-project payments`");

    const off = check(
      await runDoctor(
        deps({ ...notRunning, updatesLevel: async () => ({ level: "off", source: "config" }) }),
      ),
      "updates",
    );
    expect(off.status).toBe("warn");
    expect(off.fix).toContain("`ocw-runtime updates automatic`");
    const notify = check(
      await runDoctor(
        deps({ ...notRunning, updatesLevel: async () => ({ level: "notify", source: "env" }) }),
      ),
      "updates",
    );
    expect(notify.status).toBe("ok");
    expect(notify.summary).toContain("notify");

    const env = async (s: ServiceEnvSummary) =>
      check(await runDoctor(deps({ serviceEnv: async () => s })), "service-env");
    const absent = await env({ status: "absent", keys: [], invalidLines: 0 });
    expect(absent.status).toBe("ok");
    expect(absent.summary).toContain("not used");
    const loaded = await env({
      status: "loaded",
      keys: ["CLAUDE_CODE_OAUTH_TOKEN", "HTTPS_PROXY"],
      invalidLines: 0,
    });
    expect(loaded.status).toBe("ok");
    expect(loaded.summary).toContain("CLAUDE_CODE_OAUTH_TOKEN, HTTPS_PROXY");
    const refused = await env({ status: "refused_mode", keys: [], invalidLines: 0 });
    expect(refused.status).toBe("fail");
    expect(refused.fix).toContain("chmod 600 ~/.ocw/service.env");
    expect((await env({ status: "loaded", keys: ["A"], invalidLines: 2 })).status).toBe("warn");
  });
});

describe("createDoctorDeps (07.12, PD-12)", () => {
  it("builds the real probes over a temp home with no daemon and yields a full report", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocw-doctor-"));
    const repo = mkdtempSync(join(tmpdir(), "ocw-doctor-repo-"));
    try {
      writeFileSync(
        join(home, "runtime.json"),
        JSON.stringify({ serverUrl: SERVER, deviceName: "temp-box", webUrl: "https://ocw.example.com" }),
      );
      writeFileSync(join(home, "device-token"), `${TOKEN}\n`, { mode: 0o600 });
      execFileSync("git", ["init", "-q", repo]);
      const registry = new ProjectRegistry(home);
      await registry.load();
      await registry.add(repo, "temp-repo");

      const { fetch, requests } = fakeFetch();
      const d = createDoctorDeps(home, {
        service: async () => ({
          ...serviceActive,
          manager: "none",
          installed: false,
          active: null,
          reason: "test",
        }),
        serviceEnv: async () => ({ status: "absent", keys: [], invalidLines: 0 }),
        detectClaude: async () => claudeReady,
        detectCodex: async () => codexReady,
        fetch,
      });
      const report = await runDoctor(d);
      expect(report.checks.map((c) => c.id)).toEqual([...DOCTOR_CHECK_IDS]);
      expect(report.device).toBe("temp-box");
      expect(check(report, "pairing").status).toBe("ok");
      expect(check(report, "runtime").summary).toContain("development checkout");
      expect(check(report, "daemon").status).toBe("warn");
      expect(check(report, "git").status).toBe("ok");
      expect(check(report, "projects")).toMatchObject({ status: "ok" });
      expect(check(report, "projects").summary).toContain("temp-repo");
      expect(requests.map((r) => r.path).sort()).toEqual(["/api/v1/devices/token", "/health"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- Task 3

describe("doctor output is safe to paste (07.12, D-05, principle 7, T-07.12-05-01..03)", () => {
  const ENV_VALUE = "sk-ant-oat01-SECRETvalue123";
  const JWT = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJkZXZpY2UifQ.c2lnbmF0dXJlLXNlY3JldA";

  function planted(): DoctorDeps & { requests: Recorded[] } {
    return deps({
      controlStatus: async () => null,
      projects: async () => [
        { name: "payments", path: "/srv/repos/payments", exists: true, isGitRepo: true },
        { name: "app", path: `${HOME}/src/app`, exists: true, isGitRepo: true },
      ],
      git: async () => {
        throw new Error(`spawn failed at /opt/secret/path/git with ${TOKEN}`);
      },
      detectClaude: async () => {
        throw new Error(
          `auth status said CLAUDE_CODE_OAUTH_TOKEN=${ENV_VALUE} in ${HOME}/.claude/.credentials.json`,
        );
      },
      detectCodex: async () => {
        throw new Error(`proxy replied Authorization: Bearer ${JWT}`);
      },
      service: async () => ({
        ...serviceActive,
        manager: "none",
        installed: false,
        active: null,
        unitPath: null,
        reason: `no systemd; tried /run/systemd/system and ${HOME}/.config/systemd/user`,
      }),
      serviceEnv: async () => ({ status: "loaded", keys: ["CLAUDE_CODE_OAUTH_TOKEN"], invalidLines: 0 }),
    });
  }

  it("never prints a token, a JWT, a service.env value or an absolute path outside the home", async () => {
    const report = await runDoctor(planted());
    const text = formatDoctorText(report);
    const json = formatDoctorJson(report);
    for (const out of [text, json]) {
      for (const forbidden of [
        "ocwd_SECRET",
        "sk-ant-oat01-SECRET",
        "/srv/repos",
        "/opt/secret",
        "/run/systemd",
        `${HOME}/`,
        "Bearer ey",
        "eyJhbGciOiJFZERTQSJ9",
      ]) {
        expect(out, forbidden).not.toContain(forbidden);
      }
    }
    const projects = check(report, "projects").summary;
    expect(projects).toContain("payments (<outside home>)");
    expect(projects).toContain("app (~/src/app)");
    expect(check(report, "claude-code").summary).toContain("~/.claude/.credentials.json");
    expect(DoctorReport.parse(JSON.parse(json))).toEqual(report);
  });

  it("asks the server exactly three things: health, the version and the token exchange (bearer only, no body)", async () => {
    const d = planted();
    await runDoctor(d);
    expect(d.requests.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      "GET /api/v1/runtime/version",
      "GET /health",
      "POST /api/v1/devices/token",
    ]);
    for (const r of d.requests) {
      expect(r.body).toBeNull();
      expect(r.authorization).toBe(r.path === "/api/v1/devices/token" ? `Bearer ${TOKEN}` : null);
    }
  });

  it("safeLine redacts, keeps the home relative, hides other absolute paths, keeps URLs and is idempotent", () => {
    const line =
      `token ${TOKEN} at /srv/repos/x (see ${HOME}/src/app and '/opt/a b'), ` +
      "https://ocw.example.com/settings/devices, http://127.0.0.1:4290/health, ~/.ocw/service.env, src/app, " +
      `Bearer ${JWT} /etc/systemd/system/ocw-runtime.service`;
    const once = safeLine(line, HOME);
    expect(once).not.toContain("ocwd_SECRET");
    expect(once).not.toContain("/srv/repos");
    expect(once).not.toContain("/opt/a");
    expect(once).not.toContain(HOME);
    expect(once).toContain("~/src/app");
    expect(once).toContain("<outside home>");
    expect(once).toContain("https://ocw.example.com/settings/devices");
    expect(once).toContain("http://127.0.0.1:4290/health");
    expect(once).toContain("~/.ocw/service.env");
    expect(once).toContain(" src/app");
    expect(once).toContain("/etc/systemd/system/ocw-runtime.service");
    expect(once).not.toContain(JWT);
    expect(safeLine(once, HOME)).toBe(once);
  });
});
