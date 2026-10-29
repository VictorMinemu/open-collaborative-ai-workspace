// `ocw-runtime doctor [--json]` (07.12, HSR-05, D-05, D-06, PD-12): one command that tells a server admin everything
// between this machine and a working Work Zone device, each check `ok | warn | fail` with one fix line. Every probe is
// injected (`DoctorDeps`); `createDoctorDeps` composes the real ones. The output is safe to paste into an issue: no
// token, no device JWT, no service.env value and no absolute path outside the home (principle 7). The doctor sends the
// server nothing beyond `GET /health`, `GET /api/v1/runtime/version` and the device-token exchange.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import {
  compatibilityOf,
  RUNTIME_COMPATIBILITY_MANIFEST,
  RUNTIME_ROUTES,
  RuntimeCompatibility,
  type RuntimeCompatibilityManifest,
  type RuntimeId,
  type RuntimeInfo,
  RuntimeUpdatesLevel,
  type RuntimeUpdatesLevelSource,
} from "@ocw/contracts";
import { z } from "zod";
import { detectClaudeCode } from "./claude/detect.js";
import { detectCodex } from "./codex/detect.js";
import {
  deviceName as configDeviceName,
  loadConfig,
  loadDeviceToken,
  ProjectRegistry,
  type RuntimeConfig,
  resolveRuntimeUpdates,
} from "./config.js";
import { controlRequest, controlSocketPath } from "./control-socket.js";
import { toDeviceTokenUrl } from "./daemon.js";
import { findExecutable } from "./exec-path.js";
import { isGitRepo } from "./git.js";
import { installedBundlePath, type RuntimeInstallInfo, readInstallInfo } from "./install-info.js";
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
  /** The 07.11 compatibility manifest used when no daemon reports one (default: the bundled copy). */
  compatibility?: () => RuntimeCompatibilityManifest;
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

/** A POSIX account name, safe to print inside a shell command line. */
const ACCOUNT_RE = /^[a-z_][a-z0-9_-]*\$?$/;

const RUNTIME_LABEL: Readonly<Record<RuntimeId, string>> = { "claude-code": "Claude Code", codex: "Codex" };

// ---- headless sign-in lines (D-05, RESEARCH §5, Pitfall 12): one place, so SERVER.md (07.12-11) can quote them

/** Claude Code's sign-in over SSH, as `account` (with `sudo -u <account> -i ` when the service is a system unit). */
export function claudeSignInLine(account: string, prefix = ""): string {
  return (
    `Sign in as ${account}: \`${prefix}claude auth login\` (press c to copy the login URL, open it on any computer, ` +
    "paste the code back), or run `claude setup-token` on any computer and put CLAUDE_CODE_OAUTH_TOKEN=… in " +
    "~/.ocw/service.env (0600)"
  );
}

/** Codex's sign-in over SSH: the device-code login, or the localhost callback through an SSH port forward. */
export function codexSignInLine(account: string, prefix = ""): string {
  return (
    `Sign in as ${account}: \`${prefix}codex login --device-auth\` (enable device code login in your ChatGPT ` +
    `security settings first), or from your computer \`ssh -L 1455:localhost:1455 ${account}@<this server>\` and ` +
    `then \`${prefix}codex login\` on the server`
  );
}

/** Where to install a missing CLI: SERVER.md, rather than a vendor URL that may change. */
export function runtimeInstallLine(runtime: RuntimeId, account: string): string {
  return runtime === "claude-code"
    ? `Install Claude Code as ${account}: see the native installer in SERVER.md`
    : `Install Codex as ${account}: see SERVER.md`;
}

/** The account whose sign-ins count (the service's) and the prefix that runs a command as it. */
interface SignInAccount {
  account: string;
  prefix: string;
}

interface Context {
  deps: DoctorDeps;
  config: () => Promise<RuntimeConfig>;
  token: () => Promise<string | null>;
  daemon: () => Promise<DaemonStatusView | null>;
  service: () => Promise<ServiceStatus>;
  serviceEnv: () => Promise<ServiceEnvSummary>;
  runtime: (id: RuntimeId) => Promise<RuntimeInfo>;
  compatibility: (id: RuntimeId, info: RuntimeInfo) => Promise<RuntimeCompatibility>;
  signIn: () => Promise<SignInAccount>;
}

function createContext(deps: DoctorDeps): Context {
  const daemon = once(deps.controlStatus);
  const service = once(deps.service);
  const detected: Record<RuntimeId, () => Promise<RuntimeInfo>> = {
    "claude-code": once(deps.detectClaude),
    codex: once(deps.detectCodex),
  };
  // A running daemon answers with the same facts the web sees; the detectors run only without one.
  const runtime = async (id: RuntimeId): Promise<RuntimeInfo> => {
    const status = await daemon().catch(() => null);
    if (!status) return detected[id]();
    return (
      status.runtimes.find((r) => r.id === id) ?? { id, installed: false, version: null, loggedIn: false }
    );
  };
  const compatibility = async (id: RuntimeId, info: RuntimeInfo): Promise<RuntimeCompatibility> => {
    const status = await daemon().catch(() => null);
    const reported = status?.runtimeUpdates?.runtimes.find((r) => r.runtime === id)?.installedCompatibility;
    const parsed = RuntimeCompatibility.safeParse(reported);
    if (parsed.success) return parsed.data;
    return compatibilityOf(deps.compatibility?.() ?? RUNTIME_COMPATIBILITY_MANIFEST, id, info.version);
  };
  const signIn = once(async (): Promise<SignInAccount> => {
    const svc = await service().catch(() => null);
    if (svc?.installed && ACCOUNT_RE.test(svc.account)) {
      return {
        account: svc.account,
        prefix: svc.manager === "systemd-system" ? `sudo -u ${svc.account} -i ` : "",
      };
    }
    return { account: deps.account(), prefix: "" };
  });
  return {
    deps,
    config: once(deps.config),
    token: once(deps.token),
    daemon,
    service,
    serviceEnv: once(deps.serviceEnv),
    runtime,
    compatibility,
    signIn,
  };
}

/** `~/…` under the home, `~` for the home itself, `<outside home>` for anything else (principle 7). */
export function displayPath(path: string, home: string): string {
  const h = home.length > 1 ? home.replace(/\/+$/, "") : home;
  if (!h || h === "/") return "<outside home>";
  if (path === h) return "~";
  if (path.startsWith(`${h}/`)) return `~/${path.slice(h.length + 1)}`;
  return "<outside home>";
}

/** A project name as a shell argument: bare when it is plain, single-quoted otherwise. */
function shellArg(name: string): string {
  return /^[A-Za-z0-9._@+-]+$/.test(name) ? name : `'${name.replace(/'/g, "'\\''")}'`;
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

async function checkDaemon(ctx: Context): Promise<Finding> {
  const status = await ctx.daemon();
  if (!status) {
    const svc = await ctx.service().catch(() => null);
    if (svc?.installed) {
      return fail(
        "The runtime is not running although its service is installed",
        "not running: `ocw-runtime service status`, then `ocw-runtime service logs`",
      );
    }
    return warn(
      "The runtime is not running",
      "not running: `ocw-runtime run` or `ocw-runtime service install`",
    );
  }
  if (!status.connected) {
    return status.paired
      ? warn(
          "The runtime is running but not connected to the server",
          "`ocw-runtime service logs` says why; the pairing and server checks above usually do too",
        )
      : warn(
          "The runtime is running but not paired",
          "run `ocw-runtime setup`, then `ocw-runtime service restart`",
        );
  }
  return ok(`The runtime is running and connected (${plural(status.sessions.length, "session")} running)`);
}

const SERVICE_LABEL: Readonly<Record<ServiceStatus["manager"], string>> = {
  "systemd-user": "systemd user service",
  "systemd-system": "systemd system service",
  launchd: "LaunchAgent",
  none: "service",
};

async function checkService(ctx: Context): Promise<Finding> {
  const s = await ctx.service();
  const label = SERVICE_LABEL[s.manager];
  if (!s.installed) {
    if (s.manager === "none") {
      return warn(
        `No service manager on this machine${s.reason ? ` (${s.reason})` : ""}`,
        "run `ocw-runtime run` under your own supervisor (Docker restart policy, tmux, supervisord)",
      );
    }
    return warn(
      `The ${label} is not installed`,
      "`ocw-runtime service install` so the runtime starts at boot and restarts on failure",
    );
  }
  if (s.nodePathExists === false) {
    return fail(
      `The ${label} names a Node binary that no longer exists`,
      "the service's Node was removed (an nvm upgrade?): re-run `ocw-runtime service install`",
    );
  }
  if (s.bundlePathExists === false) {
    return fail(
      `The ${label} names a runtime bundle that no longer exists`,
      "re-run the install command from Settings › Devices, then `ocw-runtime service install`",
    );
  }
  if (s.active === false) {
    return fail(
      `The ${label} is installed but not running`,
      "`ocw-runtime service restart`, then `ocw-runtime service logs` if it stops again",
    );
  }
  if (s.linger === false && ACCOUNT_RE.test(s.account)) {
    return warn(
      `The ${label} runs only while ${s.account} is logged in`,
      `\`sudo loginctl enable-linger ${s.account}\` so it runs without a login session`,
    );
  }
  const where = s.unitPath ? ` (${s.unitPath})` : "";
  return ok(`The ${label} is ${s.active ? "active" : "installed"} as ${s.account}${where}`);
}

async function hasEnvClaudeToken(ctx: Context): Promise<boolean> {
  const env = await ctx.serviceEnv().catch(() => null);
  return env?.status === "loaded" && env.keys.includes("CLAUDE_CODE_OAUTH_TOKEN");
}

async function checkCodingRuntime(ctx: Context, id: RuntimeId): Promise<Finding> {
  const label = RUNTIME_LABEL[id];
  const info = await ctx.runtime(id);
  const { account, prefix } = await ctx.signIn();
  if (!info.installed)
    return warn(`${label} is not installed for ${account}`, runtimeInstallLine(id, account));
  const version = info.version ?? "(unknown version)";
  const compat = await ctx.compatibility(id, info);
  if (compat === "broken") {
    return fail(
      `${label} ${version} is a known-broken release for the Work Zone`,
      `Update it: \`ocw-runtime updates now ${id}\`, or update it yourself as ${account}`,
    );
  }
  const signInLine =
    id === "claude-code" ? claudeSignInLine(account, prefix) : codexSignInLine(account, prefix);
  if (!info.loggedIn) {
    // RESEARCH A2: `claude auth status` may not count the env token, so a set token is a warn, never a fail.
    if (id === "claude-code" && (await hasEnvClaudeToken(ctx))) {
      return warn(
        `${label} ${version}: CLAUDE_CODE_OAUTH_TOKEN is set in ~/.ocw/service.env (not verifiable without a request)`,
        `If a session fails to sign in: ${signInLine}`,
      );
    }
    return warn(`${label} ${version} is installed but not signed in as ${account}`, signInLine);
  }
  if (compat === "unsupported") {
    return warn(
      `${label} ${version} is older than supported`,
      `Update it: \`ocw-runtime updates now ${id}\`, or update it yourself as ${account}`,
    );
  }
  return ok(`${label} ${version}, signed in as ${account}`);
}

async function checkRuntimes(ctx: Context): Promise<Finding> {
  const ready: string[] = [];
  let claudeByEnvToken = false;
  for (const id of ["claude-code", "codex"] as const) {
    const info = await ctx.runtime(id);
    if (!info.installed || (await ctx.compatibility(id, info)) === "broken") continue;
    if (info.loggedIn) ready.push(RUNTIME_LABEL[id]);
    else if (id === "claude-code" && (await hasEnvClaudeToken(ctx))) claudeByEnvToken = true;
  }
  if (ready.length > 0) return ok(`Ready for Work Zone sessions: ${ready.join(", ")}`);
  const { account } = await ctx.signIn();
  if (claudeByEnvToken) {
    return warn(
      "No runtime is confirmed signed in; Claude Code may run on CLAUDE_CODE_OAUTH_TOKEN",
      "Start a session from the web to confirm, or sign in as shown under claude-code",
    );
  }
  return fail(
    "No coding runtime is installed and signed in",
    `Install and sign in to Claude Code or Codex as ${account} (see the two checks above)`,
  );
}

async function checkGit(ctx: Context): Promise<Finding> {
  const version = await ctx.deps.git();
  if (!version) {
    return fail(
      "git is not installed",
      "Install git with your package manager (apt, dnf, brew), then re-run `ocw-runtime doctor`",
    );
  }
  return ok(`git ${version}`);
}

async function checkProjects(ctx: Context): Promise<Finding> {
  const projects = await ctx.deps.projects();
  if (projects.length === 0) {
    return warn("No repository is registered", "Register a repository: `ocw-runtime add-project <dir>`");
  }
  const home = ctx.deps.homeDir();
  const shown = (p: DoctorProject) => `${p.name} (${displayPath(p.path, home)})`;
  const bad = projects.filter((p) => !p.exists || !p.isGitRepo);
  const first = bad[0];
  if (first) {
    const why = (p: DoctorProject) => (p.exists ? "is not a git repository" : "is missing");
    return fail(
      bad.map((p) => `${shown(p)} ${why(p)}`).join("; "),
      `${first.name}: the directory ${first.exists ? "is not a git repository" : "is gone"}; restore it, or ` +
        `\`ocw-runtime remove-project ${shellArg(first.name)}\``,
    );
  }
  return ok(`${projects.length} registered: ${projects.map(shown).join(", ")}`);
}

async function checkUpdates(ctx: Context): Promise<Finding> {
  const status = await ctx.daemon().catch(() => null);
  let level: RuntimeUpdatesLevel;
  let orgLowered = false;
  let note = "";
  if (status?.runtimeUpdates) {
    const { localLevel, effectiveLevel } = status.runtimeUpdates;
    level = effectiveLevel ?? localLevel;
    orgLowered = level !== localLevel;
    if (orgLowered) note = ` (this device says ${localLevel}; the organization lowers it)`;
  } else {
    const local = await ctx.deps.updatesLevel();
    level = local.level;
    if (local.source === "env") note = " (from OCW_RUNTIME_UPDATES)";
  }
  if (level === "off") {
    return warn(
      `Runtime CLI updates are off${note}`,
      orgLowered
        ? "Your organization turned them off; ask a workspace admin"
        : "`ocw-runtime updates automatic` (or `notify`) so Claude Code and Codex stay supported",
    );
  }
  return ok(`Runtime CLI updates: ${level}${note}`);
}

async function checkServiceEnv(ctx: Context): Promise<Finding> {
  const s = await ctx.serviceEnv();
  switch (s.status) {
    case "absent":
      return ok("not used (~/.ocw/service.env does not exist)");
    case "refused_mode":
      return fail(
        "~/.ocw/service.env is readable by other users, so the runtime refuses it",
        "chmod 600 ~/.ocw/service.env",
      );
    case "refused_owner": {
      const { account } = await ctx.signIn();
      return fail(
        `~/.ocw/service.env is not owned by ${account}, so the runtime refuses it`,
        `As root: \`chown ${account} ~/.ocw/service.env\`, then \`chmod 600 ~/.ocw/service.env\``,
      );
    }
    case "loaded": {
      // Names only, never values (D-12).
      const keys = s.keys.length > 0 ? s.keys.join(", ") : "no variables";
      if (s.invalidLines > 0) {
        return warn(
          `loaded ${keys}; ${plural(s.invalidLines, "invalid line")} skipped`,
          "Each line must be NAME=value or a # comment; fix or remove the others in ~/.ocw/service.env",
        );
      }
      return ok(`loaded: ${keys}`);
    }
  }
}

type CheckFn = (ctx: Context) => Finding | Promise<Finding>;

const CHECKS: ReadonlyArray<readonly [DoctorCheckId, CheckFn]> = [
  ["node", checkNode],
  ["runtime", checkRuntime],
  ["pairing", checkPairing],
  ["server", checkServer],
  ["daemon", checkDaemon],
  ["service", checkService],
  ["claude-code", (ctx) => checkCodingRuntime(ctx, "claude-code")],
  ["codex", (ctx) => checkCodingRuntime(ctx, "codex")],
  ["runtimes", checkRuntimes],
  ["git", checkGit],
  ["projects", checkProjects],
  ["updates", checkUpdates],
  ["service-env", checkServiceEnv],
];

/** Runs every check in order. A probe that throws becomes its check's `fail`; the doctor itself never throws. */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const ctx = createContext(deps);
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

// ---------------------------------------------------------------- production probes

/** The control socket answers within 3 s or the daemon counts as not answering. */
const CONTROL_TIMEOUT_MS = 3_000;
const GIT_TIMEOUT_MS = 5_000;

/** The probes the service module (07.12-04) and the service.env reader (07.12-03) provide; 08 passes them in. */
export interface DoctorServiceProbes {
  service: () => Promise<ServiceStatus>;
  serviceEnv: () => Promise<ServiceEnvSummary>;
}

async function sha256File(path: string): Promise<string | null> {
  try {
    if (!(await stat(path)).isFile()) return null;
  } catch {
    return null;
  }
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function readDaemonStatus(socketPath: string): Promise<DaemonStatusView | null> {
  let answer: { ok: boolean; result?: unknown; error?: string };
  try {
    answer = await controlRequest(socketPath, { cmd: "status" }, CONTROL_TIMEOUT_MS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ECONNREFUSED") return null;
    throw err;
  }
  if (!answer.ok) throw new Error(`the runtime answered with an error: ${answer.error ?? "unknown"}`);
  return DaemonStatusView.parse(answer.result);
}

function gitVersion(env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["--version"], { timeout: GIT_TIMEOUT_MS, env }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(/git version (\S+)/.exec(String(stdout))?.[1] ?? "(unknown version)");
    });
  });
}

function osAccount(env: NodeJS.ProcessEnv): string {
  try {
    return userInfo().username;
  } catch {
    return env.USER ?? env.LOGNAME ?? "unknown";
  }
}

/**
 * The real probes over `<home>` (the OCW home): runtime.json, the device token, the install record and bundle, the
 * control socket (3 s), the CLIs at their `findExecutable` paths (a service's PATH may miss `~/.local/bin`), git, the
 * project registry and the 07.11 level. `service` and `serviceEnv` come from 08's wiring; any other probe may be
 * overridden (tests inject the detectors and `fetch`).
 */
export function createDoctorDeps(
  home: string,
  probes: DoctorServiceProbes & Partial<DoctorDeps>,
  env: NodeJS.ProcessEnv = process.env,
): DoctorDeps {
  const config = once(() => loadConfig(home, env));
  const base: DoctorDeps = {
    nodeVersion: () => process.versions.node,
    account: () => osAccount(env),
    config,
    // A copy: `loadDeviceToken` deletes OCW_DEVICE_TOKEN from the environment it reads.
    token: async () => loadDeviceToken(home, await config(), { ...env }),
    installInfo: () => readInstallInfo(home),
    bundleSha256: () => sha256File(installedBundlePath(home)),
    fetch: (input, init) => fetch(input, init),
    controlStatus: () => readDaemonStatus(controlSocketPath(home)),
    service: probes.service,
    serviceEnv: probes.serviceEnv,
    detectClaude: async () => {
      const c = await config();
      const claudePath = c.claude.path ?? findExecutable("claude", env);
      return detectClaudeCode({ ...(claudePath ? { claudePath } : {}), env, useApiKey: c.claude.useApiKey });
    },
    detectCodex: async () => {
      const c = await config();
      const codexPath = c.codex.path ?? findExecutable("codex", env);
      return detectCodex({ ...(codexPath ? { codexPath } : {}), useApiKey: c.codex.useApiKey });
    },
    git: () => gitVersion(env),
    projects: async () => {
      const registry = new ProjectRegistry(home);
      await registry.load();
      return Promise.all(
        registry.list().map(async (p): Promise<DoctorProject> => {
          const exists = await stat(p.path).then(
            (s) => s.isDirectory(),
            () => false,
          );
          return { name: p.name, path: p.path, exists, isGitRepo: exists && (await isGitRepo(p.path)) };
        }),
      );
    },
    updatesLevel: async () => resolveRuntimeUpdates(await config(), env),
    homeDir: () => homedir(),
    now: () => new Date(),
  };
  return { ...base, ...probes };
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
