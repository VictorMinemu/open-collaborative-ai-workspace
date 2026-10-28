import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIRequestContext } from "@playwright/test";
import type { RuntimeId } from "../../packages/contracts/src/session-events.ts";
import { asSuperuser } from "./superuser";

/**
 * Runtime CLI update helpers for the e2e specs (Phase 07.11-09, PD-19). Everything here stays inside scratch
 * directories and loopback: the CLIs are copies of the fake (`apps/local-runtime/src/maintenance/fake-cli`) in a temp
 * `HOME`, the npm registry is a 127.0.0.1 stub the daemon reaches through `OCW_RUNTIME_REGISTRY_URL`, and the device's
 * `PATH` starts with the scratch `~/.local/bin`. No helper ever resolves, runs or updates a real CLI or calls the real
 * registry.
 */

export const FAKE_CLI = fileURLToPath(
  new URL("../../apps/local-runtime/src/maintenance/fake-cli/fake-cli.mjs", import.meta.url),
);

/** The npm package each runtime is published as (the daemon's fixed table, `install-method.ts`). */
export const RUNTIME_PACKAGES: Readonly<Record<RuntimeId, string>> = {
  "claude-code": "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};

// ---------------------------------------------------------------- fake registry

export interface FakeRegistryRequest {
  /** The request path as received, e.g. `/@anthropic-ai%2Fclaude-code/latest`. */
  path: string;
  at: number;
}

export interface FakeRegistry {
  /** `http://127.0.0.1:<port>`; the device's `OCW_RUNTIME_REGISTRY_URL`. */
  url: string;
  /** What `GET /<pkg>/<tag>` answers from now on. */
  setLatest(pkg: string, tag: string, version: string): void;
  /** Every request received, oldest first; only those whose path starts with `pathPrefix` when given. */
  requests(pathPrefix?: string): FakeRegistryRequest[];
  stop(): Promise<void>;
}

/** The request path for a package's dist-tag, exactly as the daemon's `RegistryClient` builds it. */
export function registryPath(pkg: string, tag: string): string {
  return `/${encodeURIComponent(pkg).replace(/^%40/, "@")}/${encodeURIComponent(tag)}`;
}

/** A dist-tag stub of the npm registry on 127.0.0.1 (an ephemeral port): `{ version }` or 404. */
export async function startFakeRegistry(): Promise<FakeRegistry> {
  const latest = new Map<string, string>();
  const seen: FakeRegistryRequest[] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    seen.push({ path, at: Date.now() });
    const version = req.method === "GET" ? latest.get(path) : undefined;
    if (!version) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "fake", version }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    setLatest(pkg, tag, version) {
      latest.set(registryPath(pkg, tag), version);
    },
    requests(pathPrefix) {
      return seen.filter((r) => pathPrefix === undefined || r.path.startsWith(pathPrefix));
    },
    stop() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

// ---------------------------------------------------------------- scratch CLI home

export interface CliHome {
  /** The scratch `HOME` (real path, so the daemon's scratch-home checks see the same string). */
  home: string;
  /** Writes the fake's `fake-update.json` in that runtime's install root: `{ next?, delayMs?, exitCode? }`. */
  setNextUpdate(runtime: RuntimeId, control: Record<string, unknown>): void;
  /** `<runtime> --version` of the scratch install, with the scratch `PATH` only. */
  version(runtime: RuntimeId): string;
  remove(): void;
}

/** Where the fake keeps a runtime's install root under a scratch home (`install-fake` layouts). */
export function installRoot(home: string, runtime: RuntimeId): string {
  return runtime === "claude-code"
    ? join(home, ".local", "share", "claude")
    : join(home, ".codex", "packages", "standalone");
}

/**
 * A temp home with a native Claude Code (`~/.local/bin/claude` → `~/.local/share/claude/versions/<v>`) and a
 * standalone Codex (`~/.local/bin/codex` → `~/.codex/packages/standalone/current/bin/codex`), both copies of the fake.
 */
export function makeCliHome(versions: { claude: string; codex: string }): CliHome {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ocw-e2e-cli-")));
  const install = (layout: string, version: string) =>
    execFileSync(process.execPath, [FAKE_CLI, "install-fake", layout, home, version], { stdio: "pipe" });
  try {
    install("claude-native", versions.claude);
    install("codex-standalone", versions.codex);
  } catch (err) {
    rmSync(home, { recursive: true, force: true });
    throw err;
  }
  return {
    home,
    setNextUpdate(runtime, control) {
      writeFileSync(join(installRoot(home, runtime), "fake-update.json"), `${JSON.stringify(control)}\n`);
    },
    version(runtime) {
      const bin = join(home, ".local", "bin", runtime === "claude-code" ? "claude" : "codex");
      return execFileSync(bin, ["--version"], {
        env: { PATH: scratchPath(home), HOME: home },
        stdio: "pipe",
      })
        .toString("utf8")
        .trim();
    },
    remove() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** The scratch bin first, then Node (the fake CLIs are `#!/usr/bin/env node` scripts), then the system's basics. */
export function scratchPath(home: string): string {
  return [join(home, ".local", "bin"), dirname(process.execPath), "/usr/bin", "/bin"].join(":");
}

/** What `deviceEnv` returns. */
export interface DeviceEnv extends Record<string, string> {
  HOME: string;
  CODEX_HOME: string;
  PATH: string;
  OCW_RUNTIME_REGISTRY_URL: string;
  OCW_RUNTIME_FAKE_CLI: "1";
  OCW_RUNTIME_UPDATES: "automatic" | "notify" | "off";
}

/**
 * The daemon env for a device whose CLIs are the scratch ones (PD-19): scratch `HOME`, `CODEX_HOME` and `PATH`, the
 * fake registry, fake-CLI mode and the `automatic` local level (the org level still decides). Passed as
 * `startFakeDevice({ env })`, which overrides its `OCW_RUNTIME_UPDATES=off` default.
 */
export function deviceEnv(home: string, registry: Pick<FakeRegistry, "url">): DeviceEnv {
  return {
    HOME: home,
    CODEX_HOME: join(home, ".codex"),
    PATH: scratchPath(home),
    OCW_RUNTIME_REGISTRY_URL: registry.url,
    OCW_RUNTIME_FAKE_CLI: "1",
    OCW_RUNTIME_UPDATES: "automatic",
  };
}

// ---------------------------------------------------------------- what the API shows

export interface OwnerRuntimeStatus {
  runtime: RuntimeId;
  installedVersion: string | null;
  method: string;
  advisory: string;
  state: string;
  latestVersion: string | null;
  canUpdate: boolean;
  lastRun: { outcome: string; fromVersion: string | null; toVersion: string | null } | null;
}

interface DeviceView {
  id: string;
  runtimeMaintenance?: { runtimes: OwnerRuntimeStatus[]; effectiveLevel: string; localLevel: string };
  runtimeCompatibility?: Record<string, string>;
}

/** The device as `api`'s `GET /devices` lists it, or null. */
export async function deviceAs(api: APIRequestContext, deviceId: string): Promise<DeviceView | null> {
  const res = await api.get("/api/v1/devices");
  if (!res.ok()) throw new Error(`GET /devices: ${res.status()}`);
  const { devices } = (await res.json()) as { devices: DeviceView[] };
  return devices.find((d) => d.id === deviceId) ?? null;
}

/** One runtime's maintenance status as the owner (or an admin) sees it; null until the device reported it. */
export async function ownerRuntimeStatus(
  api: APIRequestContext,
  deviceId: string,
  runtime: RuntimeId,
): Promise<OwnerRuntimeStatus | null> {
  const device = await deviceAs(api, deviceId);
  return device?.runtimeMaintenance?.runtimes.find((r) => r.runtime === runtime) ?? null;
}

export interface AuditRow {
  action: string;
  actor_kind: string;
  result: string;
  metadata: Record<string, unknown>;
}

/** The device's runtime-update audit rows, oldest first (superuser read on the disposable e2e database). */
export async function auditActions(deviceId: string): Promise<AuditRow[]> {
  const { rows } = await asSuperuser<AuditRow>(
    `select action, actor_kind, result, metadata from app.audit_events
      where device_id = $1 and action like 'device.runtime_update%' order by occurred_at, id`,
    [deviceId],
  );
  return rows;
}

export interface StoredSessionEvent {
  seq: number;
  type: string;
  [key: string]: unknown;
}

/** A Work Zone session's stored device events (`ws:<id>`, `work_session.event`), in stream order. */
export async function sessionEvents(sessionId: string): Promise<StoredSessionEvent[]> {
  const { rows } = await asSuperuser<{ seq: string | number; event: Record<string, unknown> }>(
    `select seq, payload->'event' as event from app.stream_events
      where stream_id = $1 and type = 'work_session.event' order by seq`,
    [`ws:${sessionId}`],
  );
  return rows.map((r) => ({ ...r.event, seq: Number(r.seq), type: String(r.event.type) }));
}
