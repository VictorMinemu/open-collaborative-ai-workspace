import type { RuntimeDistManifest, RuntimeInfo } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { RuntimeConfigSchema } from "./config.js";
import {
  type DoctorCheck,
  type DoctorCheckId,
  type DoctorDeps,
  DoctorReport,
  doctorExitCode,
  formatDoctorText,
  runDoctor,
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
