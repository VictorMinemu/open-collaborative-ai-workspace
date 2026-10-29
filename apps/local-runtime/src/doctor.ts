// `ocw-runtime doctor [--json]` (07.12, HSR-05, D-05, D-06, PD-12): one command that tells a server admin everything
// between this machine and a working Work Zone device, each check `ok | warn | fail` with one fix line. Every probe is
// injected (`DoctorDeps`); `createDoctorDeps` composes the real ones. The output is safe to paste into an issue: no
// token, no device JWT, no service.env value and no absolute path outside the home (principle 7). The doctor sends the
// server nothing beyond `GET /health`, `GET /api/v1/runtime/version` and the device-token exchange.

import {
  RUNTIME_ROUTES,
  type RuntimeInfo,
  RuntimeUpdatesLevel,
  type RuntimeUpdatesLevelSource,
} from "@ocw/contracts";
import { z } from "zod";
import type { RuntimeConfig } from "./config.js";
import { deviceName as configDeviceName } from "./config.js";
import { toDeviceTokenUrl } from "./daemon.js";
import type { RuntimeInstallInfo } from "./install-info.js";
import { errorMessage } from "./logger.js";
import type { ServiceEnvSummary, ServiceStatus } from "./service/types.js";

// ---------------------------------------------------------------- report (local only, never sent anywhere)

/** The checks, in the order they run and print (PD-12). Fixed: later plans and `--json` readers rely on it. */
export const DOCTOR_CHECK_IDS = [
  "node",
  "runtime",
  "pairing",
  "server",
  "daemon",
  "service",
  "claude-code",
  "codex",
  "runtimes",
  "git",
  "projects",
  "updates",
  "service-env",
] as const;
export const DoctorCheckId = z.enum(DOCTOR_CHECK_IDS);
export type DoctorCheckId = z.infer<typeof DoctorCheckId>;

export const DoctorStatus = z.enum(["ok", "warn", "fail"]);
export type DoctorStatus = z.infer<typeof DoctorStatus>;

export const DoctorCheck = z.strictObject({
  id: DoctorCheckId,
  status: DoctorStatus,
  /** What was found, one line. */
  summary: z.string(),
  /** What to run or do about it, one line; null when the check is ok. */
  fix: z.string().nullable(),
});
export type DoctorCheck = z.infer<typeof DoctorCheck>;

export const DoctorReport = z.strictObject({
  /** The OS account whose sign-ins and files were checked (RESEARCH Pitfall 12). */
  account: z.string(),
  /** The device name from runtime.json (or the host name); null when runtime.json could not be read. */
  device: z.string().nullable(),
  checks: z.array(DoctorCheck),
  /** `<webUrl>/settings/devices`, where the owner shares the device (D-06); null before a 07.12 pairing. */
  link: z.string().nullable(),
  counts: z.strictObject({
    ok: z.number().int().min(0),
    warn: z.number().int().min(0),
    fail: z.number().int().min(0),
  }),
  checkedAt: z.string(),
});
export type DoctorReport = z.infer<typeof DoctorReport>;

// ---------------------------------------------------------------- probes

/** The daemon's `status` answer over the control socket, as far as the doctor reads it (unknown keys ignored). */
export const DaemonStatusView = z.object({
  paired: z.boolean(),
  connected: z.boolean(),
  serverUrl: z.string().optional(),
  deviceName: z.string().optional(),
  runtimes: z
    .array(
      z.object({
        id: z.enum(["claude-code", "codex"]),
        installed: z.boolean(),
        version: z.string().nullable(),
        loggedIn: z.boolean(),
      }),
    )
    .default([]),
  projects: z.number().optional(),
  runtimeUpdates: z
    .object({
      localLevel: RuntimeUpdatesLevel,
      effectiveLevel: RuntimeUpdatesLevel.optional(),
      runtimes: z
        .array(z.object({ runtime: z.string(), installedCompatibility: z.string() }).loose())
        .default([]),
    })
    .loose()
    .optional(),
  sessions: z.array(z.unknown()).default([]),
});
export type DaemonStatusView = z.infer<typeof DaemonStatusView>;

/** One registered project as the doctor sees it: the absolute path stays local and is only shown home-relative. */
export interface DoctorProject {
  name: string;
  path: string;
  exists: boolean;
  isGitRepo: boolean;
}

/** Every fact the doctor needs, each one function so tests inject them (no real server, CLI or `~/.ocw`). */
export interface DoctorDeps {
  /** `process.versions.node`. */
  nodeVersion: () => string;
  /** The OS account running the doctor. */
  account: () => string;
  config: () => Promise<RuntimeConfig>;
  /** The device token, or null when not paired. Only ever sent in the token exchange's authorization header. */
  token: () => Promise<string | null>;
  /** The install record; null in a development checkout. */
  installInfo: () => Promise<RuntimeInstallInfo | null>;
  /** sha256 of the installed bundle file; null when there is none. */
  bundleSha256: () => Promise<string | null>;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** The daemon's status; null when no daemon answers on the control socket. */
  controlStatus: () => Promise<DaemonStatusView | null>;
  service: () => Promise<ServiceStatus>;
  serviceEnv: () => Promise<ServiceEnvSummary>;
  detectClaude: () => Promise<RuntimeInfo>;
  detectCodex: () => Promise<RuntimeInfo>;
  /** `git --version`'s version, or null when git is missing. */
  git: () => Promise<string | null>;
  projects: () => Promise<DoctorProject[]>;
  /** This device's runtime CLI updates level (07.11), used when no daemon answers. */
  updatesLevel: () => Promise<{ level: RuntimeUpdatesLevel; source: RuntimeUpdatesLevelSource }>;
  /** The OS home directory: paths under it print as `~/…`, others as `<outside home>`. */
  homeDir: () => string;
  now: () => Date;
}

// ---------------------------------------------------------------- the checks

/** Network calls give up after 5 s (a hung server is a finding, not a hang). */
const NETWORK_TIMEOUT_MS = 5_000;

type Finding = { status: DoctorStatus; summary: string; fix: string | null };

const ok = (summary: string): Finding => ({ status: "ok", summary, fix: null });
const warn = (summary: string, fix: string): Finding => ({ status: "warn", summary, fix });
const fail = (summary: string, fix: string): Finding => ({ status: "fail", summary, fix });

/** One memoized probe call: each probe runs at most once per doctor run, whichever check asks first. */
function once<T>(fn: () => Promise<T> | T): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => {
    p ??= Promise.resolve().then(fn);
    return p;
  };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function fetchFailure(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : null;
  if ((err as { name?: unknown } | null)?.name === "TimeoutError") return "no answer within 5 s";
  return code ?? errorMessage(err);
}

const short = (sha: string) => sha.slice(0, 12);

interface Context {
  deps: DoctorDeps;
  config: () => Promise<RuntimeConfig>;
  token: () => Promise<string | null>;
}

function checkNode(ctx: Context): Finding {
  const version = ctx.deps.nodeVersion();
  const major = Number.parseInt(version.replace(/^v/, ""), 10);
  if (!Number.isFinite(major) || major < 24) {
    return fail(
      `Node ${version} is too old for the runtime`,
      "Install Node 24 or later, then re-run the install command from Settings › Devices",
    );
  }
  return ok(`Node ${version}`);
}

async function checkRuntime(ctx: Context): Promise<Finding> {
  const info = await ctx.deps.installInfo();
  if (!info) return ok("development checkout (no installed bundle to compare)");
  const installedSha = (await ctx.deps.bundleSha256()) ?? info.sha256;
  const config = await ctx.config();
  let served: { version: string; sha256: string } | null = null;
  try {
    const res = await ctx.deps.fetch(`${trimSlash(config.serverUrl)}${RUNTIME_ROUTES.version}`, {
      method: "GET",
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    if (res.ok) {
      const parsed = z
        .object({ version: z.string().max(64), sha256: z.string().regex(/^[0-9a-f]{64}$/) })
        .safeParse(await res.json().catch(() => null));
      if (parsed.success) served = parsed.data;
    } else {
      await res.body?.cancel();
    }
  } catch {
    served = null;
  }
  const installed = `ocw-runtime ${info.version} (${short(installedSha)})`;
  if (!served) {
    return warn(
      `${installed}; could not compare with the server`,
      "Check the server check below; the version route is `GET /api/v1/runtime/version`",
    );
  }
  if (served.sha256 !== installedSha) {
    return warn(
      `${installed} differs from the server's ${served.version} (${short(served.sha256)})`,
      "re-run the install command from Settings › Devices, then `ocw-runtime service restart` when no session runs",
    );
  }
  return ok(`${installed} matches the server`);
}

async function checkPairing(ctx: Context): Promise<Finding> {
  const config = await ctx.config();
  const token = await ctx.token();
  if (!token) return fail("Not paired: this machine has no device token", "run `ocw-runtime setup`");
  let status: number;
  try {
    const res = await ctx.deps.fetch(toDeviceTokenUrl(config.serverUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    status = res.status;
    // The answer carries a device JWT: never read, never printed.
    await res.body?.cancel();
  } catch (err) {
    return warn(
      `could not verify the device token: the server did not answer (${fetchFailure(err)})`,
      "Fix the server check below, then re-run `ocw-runtime doctor`",
    );
  }
  if (status === 401 || status === 403) {
    return fail(
      "The server refused this device's token",
      "revoked or unknown: run `ocw-runtime setup` to pair again",
    );
  }
  if (status === 404) {
    return warn(
      "the server has no device token exchange (an older server?)",
      "Update the workspace server, then re-run `ocw-runtime doctor`",
    );
  }
  if (status < 200 || status >= 300) {
    return warn(
      `the device token exchange answered HTTP ${status}`,
      "Re-run `ocw-runtime doctor` in a minute; if it persists, ask the workspace admin",
    );
  }
  const name = configDeviceName(config);
  const paired = config.pairedWith;
  const owner = paired ? ` with ${paired.organization}, owned by ${paired.owner}` : "";
  return ok(`Paired as "${name}"${owner}`);
}

async function checkServer(ctx: Context): Promise<Finding> {
  const config = await ctx.config();
  const base = trimSlash(config.serverUrl);
  let res: Response;
  try {
    res = await ctx.deps.fetch(`${base}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
  } catch (err) {
    return fail(
      `${base} is unreachable (${fetchFailure(err)})`,
      "Check the URL and the network from this machine; `ocw-runtime setup --server <url>` changes it",
    );
  }
  const body = z
    .object({ status: z.string().optional(), version: z.string().optional() })
    .safeParse(await res.json().catch(() => null));
  const version = body.success && body.data.version ? ` (API ${body.data.version})` : "";
  if (!res.ok) {
    return fail(
      `${base} answers but is not healthy (HTTP ${res.status})${version}`,
      "Ask the workspace admin to check the server (`docker compose ps`, its logs)",
    );
  }
  return ok(`${base} is reachable${version}`);
}

type CheckFn = (ctx: Context) => Finding | Promise<Finding>;

const CHECKS: ReadonlyArray<readonly [DoctorCheckId, CheckFn]> = [
  ["node", checkNode],
  ["runtime", checkRuntime],
  ["pairing", checkPairing],
  ["server", checkServer],
];

/** Runs every check in order. A probe that throws becomes its check's `fail`; the doctor itself never throws. */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const ctx: Context = { deps, config: once(deps.config), token: once(deps.token) };
  const checks: DoctorCheck[] = [];
  for (const [id, fn] of CHECKS) {
    let finding: Finding;
    try {
      finding = await fn(ctx);
    } catch (err) {
      finding = fail(
        `could not run this check: ${errorMessage(err)}`,
        "Re-run `ocw-runtime doctor`; if it persists, report this line",
      );
    }
    checks.push({ id, ...finding });
  }
  const config = await ctx.config().catch(() => null);
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[c.status] += 1;
  return {
    account: safeAccount(deps),
    device: config ? configDeviceName(config) : null,
    checks,
    link: config?.webUrl ? `${trimSlash(config.webUrl)}/settings/devices` : null,
    counts,
    checkedAt: deps.now().toISOString(),
  };
}

function safeAccount(deps: DoctorDeps): string {
  try {
    return deps.account();
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------- output

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The human report: a header naming the account and device, one line per check, its fix indented, the link, counts. */
export function formatDoctorText(report: DoctorReport): string {
  const device = report.device === null ? "unknown" : `"${report.device}"`;
  const lines = [`ocw-runtime doctor · account ${report.account} · device ${device}`, ""];
  const idWidth = Math.max(...DOCTOR_CHECK_IDS.map((id) => id.length));
  for (const c of report.checks) {
    lines.push(`  ${c.status.padEnd(4)}  ${c.id.padEnd(idWidth)}  ${c.summary}`);
    if (c.fix) lines.push(`        ${" ".repeat(idWidth)}  → ${c.fix}`);
  }
  lines.push("");
  lines.push(
    report.link
      ? `Share this device with members and teams in Settings › Devices: ${report.link}`
      : "Share this device with members and teams in your workspace's Settings › Devices",
  );
  lines.push(`${plural(report.counts.warn, "warning")}, ${plural(report.counts.fail, "failure")}`);
  return `${lines.join("\n")}\n`;
}

/** `ocw-runtime doctor --json`: the report itself, already safe. */
export function formatDoctorJson(report: DoctorReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** 1 when any check fails, else 0 (warnings do not fail the command). */
export function doctorExitCode(report: DoctorReport): 0 | 1 {
  return report.checks.some((c) => c.status === "fail") ? 1 : 0;
}
