// ocw-runtime CLI.
//   ocw-runtime enroll [--server <url>] [--code <code>] [--name <name>]
//                                  pair this machine (writes ~/.ocw). With --code: the code from Settings › Devices.
//                                  Without it (07.12, D-03): prints a link and a XXXX-XXXX code to approve signed in,
//                                  and waits. The server defaults to OCW_SERVER_URL, then the one install.sh recorded.
//   ocw-runtime [run]              start the daemon (default)
//   ocw-runtime version | --version
//                                  print this runtime's version (the bundle's package version; 0.0.0-dev under tsx)
//   ocw-runtime detect             print Claude Code detection
//   ocw-runtime status             query a running daemon over the control socket
//   ocw-runtime add-project <dir>  register a project (via the running daemon, or directly when stopped)
//   ocw-runtime projects           list registered projects (local only)
//   ocw-runtime full-access on|off|status
//                                  the device owner's Full access opt-in (ADR-0012); writes runtime.json and asks
//                                  a running daemon to reload it. OCW_ALLOW_FULL_ACCESS overrides it per process.
//   ocw-runtime updates status|check|now <claude-code|codex>
//                                  the runtime CLIs' versions and update state (07.11); `check` asks the registry
//                                  now, `now` updates one runtime when it is idle (local only, never from the server).
//   ocw-runtime updates automatic|notify|off
//                                  this device's runtime updates level (07.11, D-02; it can only lower the
//                                  organization's); writes runtime.json and asks a running daemon to reload it.
//                                  OCW_RUNTIME_UPDATES overrides it per process.

import { homedir } from "node:os";
import { RuntimeId, RuntimeUpdatesLevel } from "@ocw/contracts";
import { detectClaudeCode } from "./claude/detect.js";
import {
  ensureOcwHome,
  loadConfig,
  ocwHome,
  ProjectRegistry,
  resolveFullAccess,
  resolveRuntimeUpdates,
  setFullAccessOptIn,
  setRuntimeUpdatesLevel,
} from "./config.js";
import { type ControlRequest, controlRequest, controlSocketPath } from "./control-socket.js";
import { Daemon } from "./daemon.js";
import { type EnrollResult, enroll } from "./enroll.js";
import { readInstallInfo } from "./install-info.js";
import { createLogger, errorMessage } from "./logger.js";
import { publicInstallFields, resolveInstall } from "./maintenance/install-method.js";
import { PairingCancelledError, pairByDeviceCode } from "./pair.js";
import { applyServiceEnv } from "./service-env.js";
import { RUNTIME_VERSION } from "./version.js";

async function viaSocket(req: ControlRequest): Promise<void> {
  const res = await controlRequest(controlSocketPath(ocwHome()), req);
  if (!res.ok) throw new Error(res.error ?? "request failed");
  process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

function daemonDown(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

const FULL_ACCESS_WARNING =
  "Full access lets agents run any command and edit any file your user can reach on this computer, without asking.\n" +
  "Recommended only on a dedicated machine such as a server or VM. Your organization must also allow it.\n";

/** `full-access on|off|status`: local only; the server can never call this. */
async function fullAccess(sub: string | undefined): Promise<void> {
  if (sub !== "on" && sub !== "off" && sub !== "status") {
    throw new Error("usage: ocw-runtime full-access on|off|status");
  }
  const home = ocwHome();
  if (sub !== "status") {
    if (sub === "on") process.stderr.write(FULL_ACCESS_WARNING);
    await setFullAccessOptIn(home, sub === "on");
  }
  let out: Record<string, unknown>;
  try {
    const res = await controlRequest(controlSocketPath(home), {
      cmd: sub === "status" ? "status" : "reloadConfig",
    });
    if (!res.ok) throw new Error(res.error ?? "request failed");
    const r = res.result as { fullAccessOptIn?: boolean; fullAccessSource?: string };
    out = {
      fullAccessOptIn: r.fullAccessOptIn === true,
      fullAccessSource: r.fullAccessSource,
      daemon: "running",
    };
  } catch (err) {
    if (!daemonDown(err)) throw err;
    const local = resolveFullAccess(await loadConfig(home));
    out = { fullAccessOptIn: local.optIn, fullAccessSource: local.source, daemon: "stopped" };
  }
  if (sub !== "status" && out.fullAccessOptIn !== (sub === "on")) {
    process.stderr.write("Note: OCW_ALLOW_FULL_ACCESS in the daemon's environment overrides runtime.json.\n");
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

const UPDATES_USAGE =
  "usage: ocw-runtime updates automatic|notify|off|status|check, or ocw-runtime updates now <claude-code|codex>";
const RUNTIME_NOT_RUNNING = "the runtime is not running";
/** A check or an update waits for the registry and the install, so the socket gets longer than the default. */
const UPDATES_TIMEOUT_MS = 60_000;

/**
 * The daemon is stopped: what this machine has installed and how, from the install resolution only (no registry
 * request, no version probe: nothing is run).
 */
async function localUpdatesReport(home: string): Promise<Record<string, unknown>> {
  const config = await loadConfig(home);
  const level = resolveRuntimeUpdates(config);
  const paths: Record<RuntimeId, string | undefined> = {
    "claude-code": config.claude.path,
    codex: config.codex.path,
  };
  const runtimes = RuntimeId.options.map((runtime) => {
    const configuredPath = paths[runtime];
    const r = resolveInstall(runtime, {
      home: homedir(),
      env: process.env,
      ...(configuredPath ? { configuredPath } : {}),
    });
    const { display, ...fields } = publicInstallFields(r);
    return { runtime, ...fields, updateCommand: display };
  });
  return { daemon: "stopped", localLevel: level.level, localLevelSource: level.source, runtimes };
}

/**
 * `updates automatic|notify|off` (07.11, D-02): writes this device's level to runtime.json, then asks a running daemon
 * to re-read it (the value-less `reloadConfig`, like `full-access`); a stopped daemon reads it on start. Local only.
 */
async function updatesLevel(level: RuntimeUpdatesLevel): Promise<void> {
  const home = ocwHome();
  await setRuntimeUpdatesLevel(home, level);
  let out: Record<string, unknown>;
  try {
    const res = await controlRequest(controlSocketPath(home), { cmd: "reloadConfig" });
    if (!res.ok) throw new Error(res.error ?? "request failed");
    const r = res.result as {
      runtimeUpdatesLevel?: string;
      runtimeUpdatesSource?: string;
      runtimeUpdatesEffectiveLevel?: string;
    };
    out = {
      localLevel: r.runtimeUpdatesLevel,
      localLevelSource: r.runtimeUpdatesSource,
      ...(r.runtimeUpdatesEffectiveLevel ? { effectiveLevel: r.runtimeUpdatesEffectiveLevel } : {}),
      daemon: "running",
    };
  } catch (err) {
    if (!daemonDown(err)) throw err;
    const local = resolveRuntimeUpdates(await loadConfig(home));
    out = { localLevel: local.level, localLevelSource: local.source, daemon: "stopped" };
  }
  if (out.localLevelSource === "env") {
    process.stderr.write("Note: OCW_RUNTIME_UPDATES in the daemon's environment overrides runtime.json.\n");
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

/** `updates status|check|now <runtime>` (07.11, D-05, D-09, PD-08): local only; the server can never call this. */
async function updates(sub: string | undefined, arg: string | undefined): Promise<void> {
  const level = RuntimeUpdatesLevel.safeParse(sub);
  if (level.success) return updatesLevel(level.data);
  const home = ocwHome();
  const socket = controlSocketPath(home);
  const print = (value: unknown) =>
    process.stdout.write(typeof value === "string" ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`);
  let req: ControlRequest;
  if (sub === "status") req = { cmd: "status" };
  else if (sub === "check") req = { cmd: "runtimeCheck" };
  else if (sub === "now") {
    const runtime = RuntimeId.safeParse(arg);
    if (!runtime.success) throw new Error(UPDATES_USAGE);
    req = { cmd: "runtimeUpdate", runtime: runtime.data };
  } else throw new Error(UPDATES_USAGE);

  let res: { ok: boolean; result?: unknown; error?: string };
  try {
    res = await controlRequest(socket, req, UPDATES_TIMEOUT_MS);
  } catch (err) {
    if (!daemonDown(err)) throw err;
    if (sub === "status") {
      print(await localUpdatesReport(home));
      return;
    }
    print(RUNTIME_NOT_RUNNING);
    process.exitCode = 1;
    return;
  }
  if (!res.ok) throw new Error(res.error ?? "request failed");
  if (sub === "status") {
    const status = res.result as { runtimeUpdates?: Record<string, unknown> };
    if (!status.runtimeUpdates) throw new Error("runtime updates are not available on this device");
    print({ daemon: "running", ...status.runtimeUpdates });
    return;
  }
  if (sub === "check") {
    print(res.result);
    return;
  }
  const answer = res.result as { accepted?: boolean; reason?: string };
  if (answer.accepted === true) {
    print("accepted");
    return;
  }
  print(answer.reason ?? "refused");
  process.exitCode = 1;
}

/**
 * `remove-project <dir|name|id>` (07.12, D-07): resolved against projects.json, then removed through the running daemon
 * (which tells the server at once), or straight from projects.json when the daemon is down (the server learns it from
 * `projects.sync` on the next connect). An ambiguous or unknown name fails listing the candidates.
 */
async function removeProject(ref: string | undefined): Promise<void> {
  if (!ref) throw new Error("usage: ocw-runtime remove-project <dir|name|id>");
  const home = ocwHome();
  const registry = new ProjectRegistry(home);
  await registry.load();
  const project = await registry.resolveRef(ref);
  try {
    const res = await controlRequest(controlSocketPath(home), {
      cmd: "removeProject",
      localId: project.localId,
    });
    if (!res.ok) throw new Error(res.error ?? "request failed");
  } catch (err) {
    if (!daemonDown(err)) throw err;
    await registry.remove(project.localId);
  }
  process.stdout.write(`Removed "${project.name}" (${project.localId}).\n`);
}

const ENROLL_USAGE = "usage: ocw-runtime enroll [--server <url>] [--code <XXXX-XXXX>] [--name <name>]";

/**
 * `enroll` (07.12, D-03): the server is `--server`, else `OCW_SERVER_URL`, else the one `install.sh` recorded. With
 * `--code` the typed-code flow (unchanged); without it, terminal pairing by device code, cancelled by Ctrl-C (exit 130).
 */
async function enrollCommand(args: string[]): Promise<void> {
  const home = ocwHome();
  const server =
    flag(args, "server") ?? process.env.OCW_SERVER_URL ?? (await readInstallInfo(home))?.serverUrl;
  if (!server) throw new Error(ENROLL_USAGE);
  const code = flag(args, "code");
  const name = flag(args, "name");
  const print = (line: string) => process.stdout.write(`${line}\n`);

  if (code) {
    const out = await enroll({ home, serverUrl: server, code, ...(name ? { name } : {}) });
    print(`Paired "${out.name}" with ${out.serverUrl}.`);
    print(`Token saved to ${out.tokenPath} (0600).`);
    if (out.webUrl) print(`Settings › Devices: ${out.webUrl}/settings/devices`);
    print("Start the runtime with: ocw-runtime run");
    return;
  }

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  let out: EnrollResult;
  try {
    out = await pairByDeviceCode({
      home,
      serverUrl: server,
      signal: controller.signal,
      ...(name ? { name } : {}),
    });
  } catch (err) {
    if (err instanceof PairingCancelledError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 130; // 128 + SIGINT; the pending timer and request were aborted, so the process ends here
      return;
    }
    throw err;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
  print(
    out.pairedWith
      ? `Paired "${out.name}" with ${out.pairedWith.organization} as ${out.pairedWith.owner}.`
      : `Paired "${out.name}" with ${out.serverUrl}.`,
  );
  print(`Token saved to ${out.tokenPath} (0600).`);
  if (out.webUrl) print(`Settings › Devices: ${out.webUrl}/settings/devices`);
  print("Start the runtime with: ocw-runtime run (or install it as a service with: ocw-runtime setup)");
}

/**
 * `run`: applies `~/.ocw/service.env` to this process's environment first (07.12, D-12: keys already set win, refused
 * unless 0600 and owned by this user, names logged, never values), then creates and starts the daemon.
 */
async function run(): Promise<void> {
  const home = ocwHome();
  const level = await loadConfig(home)
    .then((c) => c.logLevel)
    .catch(() => "info" as const);
  await applyServiceEnv(home, process.env, createLogger(level));
  const daemon = await Daemon.create();
  await daemon.start();
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`received ${signal}, stopping\n`);
    daemon
      .stop()
      .catch(() => undefined)
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function main(argv: string[]): Promise<void> {
  const [cmd = "run", ...rest] = argv;
  switch (cmd) {
    case "run":
      return run();
    case "version":
    case "--version":
      process.stdout.write(`${RUNTIME_VERSION}\n`);
      return;
    case "detect":
      process.stdout.write(`${JSON.stringify(await detectClaudeCode(), null, 2)}\n`);
      return;
    case "status":
      return viaSocket({ cmd: "status" });
    case "projects":
      return viaSocket({ cmd: "listProjects" });
    case "add-project": {
      const path = rest[0];
      if (!path) throw new Error("usage: ocw-runtime add-project <dir> [--name <name>]");
      const name = flag(rest, "name");
      try {
        return await viaSocket({ cmd: "addProject", path, ...(name ? { name } : {}) });
      } catch (err) {
        if (!daemonDown(err)) throw err;
        // Daemon not running: register directly; it is announced on the next connect.
        const home = ocwHome();
        await ensureOcwHome(home);
        const registry = new ProjectRegistry(home);
        await registry.load();
        const project = await registry.add(path, name);
        process.stdout.write(`${JSON.stringify(project, null, 2)}\n`);
        return;
      }
    }
    case "enroll":
      return enrollCommand(rest);
    case "full-access":
      return fullAccess(rest[0]);
    case "updates":
      return updates(rest[0], rest[1]);
    case "remove-project":
      return removeProject(rest[0]);
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`ocw-runtime: ${errorMessage(err)}\n`);
  process.exit(1);
});
