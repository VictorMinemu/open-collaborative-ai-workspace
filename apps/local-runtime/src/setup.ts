// `ocw-runtime setup` (07.12-08, HSR-02, D-02, D-06, D-14, PD-13): one command turns an installed runtime into a paired,
// running, checked Work Zone device. The order follows RESEARCH Pitfall 7 (an unpaired daemon never picks up a later
// token): server URL → pairing → projects → service → doctor → the Settings › Devices link. Every step is idempotent, so
// re-running it on a paired device changes nothing and says so. Every dependency is injected (`SetupDeps`);
// `defaultSetupDeps` composes the real ones from 03 (pairing), 04 (service manager) and 05 (doctor). Sharing the device
// stays in the web (D-06): setup only prints where to do it.

import { readFile, realpath } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { ensureOcwHome, type LocalProject, loadConfig, loadDeviceToken, ProjectRegistry } from "./config.js";
import { controlRequest, controlSocketPath } from "./control-socket.js";
import { toDeviceTokenUrl } from "./daemon.js";
import {
  createDoctorDeps,
  type DoctorReport,
  type DoctorServiceProbes,
  formatDoctorText,
  runDoctor,
} from "./doctor.js";
import { type EnrollResult, normalizeServerUrl, proposedDeviceName } from "./enroll.js";
import { type RuntimeInstallInfo, readInstallInfo } from "./install-info.js";
import { errorMessage, silentLogger } from "./logger.js";
import { PairingCancelledError, PairingError, pairByDeviceCode } from "./pair.js";
import { SUPERVISOR_FALLBACK } from "./service/detect.js";
import { createServiceManager, defaultServiceDeps, type ServiceManager } from "./service/index.js";
import { applyServiceEnv, readServiceEnv } from "./service-env.js";

// ---------------------------------------------------------------- arguments

export type SetupServiceChoice = "user" | "system" | "none";

export interface SetupArgs {
  /** Accept every default and never prompt (a script). */
  yes: boolean;
  server?: string;
  name?: string;
  /** Repository directories to register (repeatable `--project`). */
  projects: string[];
  service?: SetupServiceChoice;
  /** The account a system unit runs as (`--service system` only). */
  userName?: string;
  help?: boolean;
}

/** A missing or malformed flag: the CLI prints it with the usage and exits 2. */
export class SetupUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupUsageError";
  }
}

export const SETUP_USAGE = [
  "usage: ocw-runtime setup [--server <url>] [--name <name>] [--project <dir>]… [--service user|system|none]",
  "                         [--user-name <account>] [--yes]",
  "  Pairs this machine with your workspace, registers repositories, keeps the runtime running as a service and",
  "  checks everything with the doctor. Prompts only on a terminal; every prompt has a flag; safe to re-run.",
];

const SERVICE_CHOICES: readonly SetupServiceChoice[] = ["user", "system", "none"];

export function parseSetupArgs(argv: string[]): SetupArgs {
  const args: SetupArgs = { yes: false, projects: [] };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i] ?? "";
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
    const value = (): string => {
      const v = inline ?? argv[++i];
      if (v === undefined || v === "" || (inline === undefined && v.startsWith("--"))) {
        throw new SetupUsageError(`${flag} needs a value`);
      }
      return v;
    };
    switch (flag) {
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--server":
        args.server = value();
        break;
      case "--name":
        args.name = value();
        break;
      case "--project":
        args.projects.push(value());
        break;
      case "--service": {
        const v = value();
        if (!SERVICE_CHOICES.includes(v as SetupServiceChoice)) {
          throw new SetupUsageError(`--service takes user|system|none, not ${JSON.stringify(v)}`);
        }
        args.service = v as SetupServiceChoice;
        break;
      }
      case "--user-name":
        args.userName = value();
        break;
      default:
        throw new SetupUsageError(`unknown option ${raw}`);
    }
  }
  if (args.service === "system" && !args.userName) {
    throw new SetupUsageError(
      "--service system needs --user-name <account>, the non-root account it runs as",
    );
  }
  if (args.userName && args.service !== "system") {
    throw new SetupUsageError("--user-name goes with --service system");
  }
  return args;
}

// ---------------------------------------------------------------- dependencies

/** The pairing as the server sees it: the token is accepted, refused (revoked or unknown), or nobody answered. */
export type TokenState = "valid" | "revoked" | "unreachable";

/** What runtime.json says about the current pairing (absent keys when never paired). */
export interface PairedState {
  serverUrl?: string;
  deviceName?: string;
  webUrl?: string;
  pairedWith?: { organization: string; owner: string };
}

/** The daemon's own view, when one answers on the control socket. */
export interface DaemonView {
  paired: boolean;
  sessions: number;
}

export interface SetupDeps {
  /** OCW_HOME. */
  home: string;
  /** The OS home: paths under it print as `~/…`. */
  userHome: string;
  env: NodeJS.ProcessEnv;
  /** Both stdin and stdout are a terminal: only then does setup prompt. */
  isTTY: boolean;
  /** The account running setup and its uid (0 = root). */
  account: string;
  uid: number;
  hostname: () => string;
  /** Asks one question on the terminal and returns the answer as typed. Only called when `isTTY`. */
  prompt: (question: string) => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
  installInfo: () => Promise<RuntimeInstallInfo | null>;
  pairedState: () => Promise<PairedState>;
  /** The device token, or null when not paired. Never printed. */
  token: () => Promise<string | null>;
  /** `POST <server>/api/v1/devices/token` with the token (the doctor's call); the answer body is never read. */
  tokenCheck: (serverUrl: string, token: string) => Promise<TokenState>;
  /** Terminal pairing by device code (03): prints the link and the code, waits, saves the token. */
  pair: (opts: { serverUrl: string; name: string }) => Promise<EnrollResult>;
  /** Registers a repository; `added: false` when it already was (idempotent). */
  registry: { add: (path: string) => Promise<{ project: LocalProject; added: boolean }> };
  service: Pick<ServiceManager, "detect" | "install" | "restart">;
  doctor: () => Promise<DoctorReport>;
  /** The running daemon's status, or null when none answers. */
  daemonStatus: () => Promise<DaemonView | null>;
  /** Aborted by Ctrl-C (the CLI): a pending prompt or pairing ends with exit 130. */
  signal?: AbortSignal;
  /** Releases the terminal (the prompt interface) once setup ends. */
  close?: () => void;
}

// ---------------------------------------------------------------- the command

/** A step failed (exit 1) or a value is missing without a terminal (exit 2); the message is already printed. */
class SetupStop extends Error {
  constructor(readonly code: number) {
    super(`setup stopped (${code})`);
  }
}

/** `~/…` under the OS home, else the path as is (this terminal only; nothing here leaves the device). */
function tilde(path: string, userHome: string): string {
  if (path === userHome) return "~";
  return userHome && path.startsWith(`${userHome}/`) ? `~/${path.slice(userHome.length + 1)}` : path;
}

function isCancel(err: unknown, signal: AbortSignal | undefined): boolean {
  return (
    err instanceof PairingCancelledError ||
    (err as { name?: unknown } | null)?.name === "AbortError" ||
    signal?.aborted === true
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Runs setup (see the file comment) and returns the exit code: 0 done (whatever the doctor found), 1 a step failed,
 * 2 a value is missing without a terminal, 130 cancelled.
 */
export async function runSetup(args: SetupArgs, deps: SetupDeps): Promise<number> {
  try {
    return await setupSteps(args, deps);
  } catch (err) {
    if (err instanceof SetupStop) return err.code;
    if (isCancel(err, deps.signal)) {
      deps.err(err instanceof PairingCancelledError ? err.message : "Setup cancelled.");
      return 130;
    }
    deps.err(`ocw-runtime setup: ${errorMessage(err)}`);
    return 1;
  } finally {
    deps.close?.();
  }
}

async function setupSteps(args: SetupArgs, deps: SetupDeps): Promise<number> {
  const stop = (code: number, message: string): never => {
    deps.err(message);
    throw new SetupStop(code);
  };
  const before = await deps.pairedState();

  // 1. The server URL: flag, OCW_SERVER_URL, install.json, runtime.json.
  const fallback =
    deps.env.OCW_SERVER_URL || (await deps.installInfo())?.serverUrl || before.serverUrl || undefined;
  const rawServer = args.server ?? fallback;
  if (!rawServer) stop(2, "ocw-runtime setup: no server URL: pass --server <url>");
  // 2 (checked up front so a script never pairs and then stops): how the runtime keeps running.
  if (!args.service && !args.yes) {
    stop(2, "ocw-runtime setup: pass --service user|system|none (or --yes)");
  }
  let server: string;
  try {
    server = normalizeServerUrl(rawServer as string);
  } catch {
    return stop(2, `ocw-runtime setup: not a URL: ${JSON.stringify(rawServer)}`);
  }

  // 2. Pairing: skipped when the server accepts this device's token.
  const token = await deps.token();
  let paired: PairedState = before;
  let pairedNow = false;
  if (token) {
    const at = before.serverUrl ? normalizeServerUrl(before.serverUrl) : server;
    const state = await deps.tokenCheck(at, token);
    if (state === "valid") {
      const name = before.deviceName ?? deps.hostname();
      const owner = before.pairedWith
        ? ` (${before.pairedWith.organization}, owned by ${before.pairedWith.owner})`
        : "";
      deps.out(`Already paired as "${name}" with ${at}${owner}.`);
    } else if (state === "unreachable") {
      stop(
        1,
        `Could not reach ${at} to check this device's pairing: check the URL and the network, then re-run setup.`,
      );
    } else {
      pairedNow = true;
    }
  } else {
    pairedNow = true;
  }
  if (pairedNow) {
    const name = proposedDeviceName(args.name ?? deps.hostname());
    let result: EnrollResult;
    try {
      result = await deps.pair({ serverUrl: server, name });
    } catch (err) {
      if (err instanceof PairingError) stop(1, err.message);
      throw err;
    }
    deps.out(
      result.pairedWith
        ? `Paired "${result.name}" with ${result.pairedWith.organization} as ${result.pairedWith.owner}.`
        : `Paired "${result.name}" with ${result.serverUrl}.`,
    );
    paired = {
      serverUrl: result.serverUrl,
      deviceName: result.name,
      ...(result.webUrl ? { webUrl: result.webUrl } : {}),
    };
  }

  // 3. Projects (idempotent).
  for (const dir of args.projects) {
    let added: { project: LocalProject; added: boolean };
    try {
      added = await deps.registry.add(dir);
    } catch (err) {
      return stop(1, `Could not register ${dir}: ${errorMessage(err)}`);
    }
    const where = tilde(added.project.path, deps.userHome);
    deps.out(
      added.added
        ? `Registered "${added.project.name}" (${where}).`
        : `${where} is already registered as "${added.project.name}".`,
    );
  }

  // 4. Service.
  deps.out(`No service installed: ${SUPERVISOR_FALLBACK}.`);

  // 5. Doctor: printed; its findings never change setup's exit code.
  await runDoctorStep(deps);

  // 6. Where to share the device (D-06).
  const webUrl = paired.webUrl ?? (await deps.pairedState()).webUrl;
  deps.out("");
  if (webUrl) {
    deps.out(`Settings › Devices: ${webUrl}/settings/devices`);
    deps.out("Share it with members and teams there.");
  } else {
    deps.out("Share it with members and teams in your workspace's Settings › Devices.");
  }
  return 0;
}

async function runDoctorStep(deps: SetupDeps): Promise<void> {
  let report: DoctorReport;
  try {
    report = await deps.doctor();
  } catch (err) {
    deps.err(
      `The doctor could not run (${errorMessage(err)}); run \`ocw-runtime doctor\` to check this device.`,
    );
    return;
  }
  deps.out("");
  for (const line of formatDoctorText(report).replace(/\n$/, "").split("\n")) deps.out(line);
  if (report.counts.fail > 0) {
    deps.out(
      `The doctor found ${plural(report.counts.fail, "failure")}: fix ${report.counts.fail === 1 ? "it" : "them"} with the lines above, then run \`ocw-runtime doctor\`.`,
    );
  }
}

// ---------------------------------------------------------------- production wiring

/** The doctor's service probes, read the same way the service would (05's contract). Shared with `ocw-runtime doctor`. */
export function doctorProbes(home: string): DoctorServiceProbes {
  return {
    service: () => createServiceManager(defaultServiceDeps(home)).status(),
    serviceEnv: async () => (await readServiceEnv(home)).summary,
  };
}

/** The doctor as `ocw-runtime doctor` runs it: service.env applied first so local probes see what the service sees. */
export async function localDoctorReport(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DoctorReport> {
  await applyServiceEnv(home, env, silentLogger);
  return runDoctor(createDoctorDeps(home, doctorProbes(home), env));
}

function daemonDown(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

async function readPairedState(home: string): Promise<PairedState> {
  const config = await loadConfig(home, {}).catch(() => null);
  if (!config) return {};
  // loadConfig defaults the server URL; only a recorded one counts as the paired server.
  const raw = await readFile(join(home, "runtime.json"), "utf8")
    .then((t) => JSON.parse(t) as { serverUrl?: unknown } | null)
    .catch(() => null);
  return {
    ...(typeof raw?.serverUrl === "string" ? { serverUrl: config.serverUrl } : {}),
    ...(config.deviceName ? { deviceName: config.deviceName } : {}),
    ...(config.webUrl ? { webUrl: config.webUrl } : {}),
    ...(config.pairedWith
      ? { pairedWith: { organization: config.pairedWith.organization, owner: config.pairedWith.owner } }
      : {}),
  };
}

/** The real dependencies; `cancel()` aborts a pending pairing (the CLI calls it on SIGINT). */
export function defaultSetupDeps(home: string): SetupDeps & { cancel: () => void } {
  const controller = new AbortController();
  const env = process.env;
  const socket = controlSocketPath(home);
  return {
    home,
    userHome: homedir(),
    env,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    account: userInfo().username,
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    hostname: () => hostname().replace(/\.local$/, ""),
    prompt: async () => {
      throw new Error("prompts need a terminal");
    },
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    installInfo: () => readInstallInfo(home),
    pairedState: () => readPairedState(home),
    token: async () => loadDeviceToken(home, await loadConfig(home, {}), { ...env }),
    tokenCheck: async (serverUrl, token) => {
      try {
        const res = await fetch(toDeviceTokenUrl(serverUrl), {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5_000),
        });
        // The answer carries a device JWT: never read, never printed.
        await res.body?.cancel();
        if (res.status >= 200 && res.status < 300) return "valid";
        return res.status === 401 || res.status === 403 ? "revoked" : "unreachable";
      } catch {
        return "unreachable";
      }
    },
    pair: ({ serverUrl, name }) => pairByDeviceCode({ home, serverUrl, name, signal: controller.signal }),
    registry: {
      add: async (dir) => {
        const abs = await realpath(resolve(dir)).catch(() => {
          throw new Error("the directory does not exist");
        });
        const registry = new ProjectRegistry(home);
        await registry.load();
        const existing = registry.list().find((p) => p.path === abs);
        if (existing) return { project: existing, added: false };
        try {
          // A running daemon registers it and tells the server at once.
          const res = await controlRequest(socket, { cmd: "addProject", path: abs });
          if (!res.ok) throw new Error(res.error ?? "the runtime refused the project");
          return { project: res.result as LocalProject, added: true };
        } catch (err) {
          if (!daemonDown(err)) throw err;
          await ensureOcwHome(home);
          return { project: await registry.add(abs), added: true };
        }
      },
    },
    service: createServiceManager(defaultServiceDeps(home)),
    doctor: () => localDoctorReport(home, env),
    daemonStatus: async () => {
      try {
        const res = await controlRequest(socket, { cmd: "status" });
        if (!res.ok) return null;
        const r = res.result as { paired?: unknown; sessions?: unknown };
        return { paired: r.paired === true, sessions: Array.isArray(r.sessions) ? r.sessions.length : 0 };
      } catch {
        return null;
      }
    },
    signal: controller.signal,
    cancel: () => controller.abort(),
  };
}
