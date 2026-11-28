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
//   ocw-runtime add-project <dir>  register a project (via the running daemon, or directly when stopped); a folder
//                                  without git is registered as it is (no changes view, no worktrees)
//   ocw-runtime projects           list registered projects (local only)
//   ocw-runtime full-access on|off|status
//                                  the device owner's Full access opt-in (ADR-0012); writes runtime.json and asks
//                                  a running daemon to reload it. OCW_ALLOW_FULL_ACCESS overrides it per process.
//   ocw-runtime isolated-server on|off|status
//                                  07.16 (D-19): mark this machine as an isolated server (bots that read outside
//                                  content may run Full access sessions here); honoured by the server only for a
//                                  headless service daemon. Writes runtime.json and asks a running daemon to reload
//                                  it. OCW_ISOLATED_SERVER overrides it per process.
//   ocw-runtime browser on|off|status
//                                  07.13 (D-10, PD-27): the device owner's Work Zone browser opt-in (default off);
//                                  writes runtime.json and asks a running daemon to reload it. OCW_ALLOW_BROWSER
//                                  overrides it per process. Prints `Browser: on|off (<source>) · installed <version>`.
//   ocw-runtime browser install [--from-zip <zip>]
//                                  07.13 (D-05, PD-19): fetch the pinned Chrome for Testing headless shell (or copy it
//                                  from a local zip), verify its sha256 and install it under ~/.ocw/browsers.
//   ocw-runtime updates status|check|now <claude-code|codex>
//                                  the runtime CLIs' versions and update state (07.11); `check` asks the registry
//                                  now, `now` updates one runtime when it is idle (local only, never from the server).
//   ocw-runtime updates automatic|notify|off
//                                  this device's runtime updates level (07.11, D-02; it can only lower the
//                                  organization's); writes runtime.json and asks a running daemon to reload it.
//                                  OCW_RUNTIME_UPDATES overrides it per process.
//   ocw-runtime setup [--server <url>] [--name <name>] [--project <dir>]… [--service user|system|none]
//                     [--user-name <account>] [--yes]
//                                  07.12 (D-02): pair, register repositories, install the service, run the doctor and
//                                  print the Settings › Devices link. Prompts only on a terminal; safe to re-run.
//   ocw-runtime service install|uninstall|status|logs|restart [--system --user-name <account>]
//                                  07.12 (D-04): the runtime as a systemd user/system unit or a macOS LaunchAgent.
//   ocw-runtime doctor [--json]    07.12 (D-05): every check between this machine and a working device, ok|warn|fail
//                                  with one fix line; reads ~/.ocw/service.env as the service does; exit 1 on any fail.
//   ocw-runtime remove-project <dir|name|id>
//                                  unregister a project (via the running daemon, or directly when stopped)
//   ocw-runtime account add codex [--label <label>]
//                                  07.18 (D-02, PD-11): sign a ChatGPT account in for Codex in a new account slot,
//                                  through Codex's own device-code login (prints the link and the code, waits). The
//                                  server lists it in Settings › Account pool, off until an admin turns it on.
//   ocw-runtime account list       the Codex account slots on this device (id, label, signed in, plan)
//   ocw-runtime account remove codex <slotId|label>
//                                  sign the slot out and remove it (the shared Codex history stays). After add and
//                                  remove a running daemon re-sends its slots (`reloadAccounts`). Runs as the user that
//                                  owns the OCW home; under a system service, as that service's user.

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { type DeviceHostKind, PoolLabel, RuntimeId, RuntimeUpdatesLevel } from "@ocw/contracts";
import {
  CodexLoginError,
  codexAccountSpawner,
  logoutCodex,
  runCodexDeviceLogin,
} from "./accounts/codex-login.js";
import { CodexSlotStore } from "./accounts/codex-slots.js";
import { BrowserInstallError, browsersRoot, installBrowser, installedBrowser } from "./browser/install.js";
import { CFT_VERSION } from "./browser/pins.js";
import { detectClaudeCode } from "./claude/detect.js";
import {
  ensureOcwHome,
  loadConfig,
  ocwHome,
  ProjectRegistry,
  resolveBrowser,
  resolveFullAccess,
  resolveHostKind,
  resolveIsolatedServer,
  resolveRuntimeUpdates,
  setBrowserOptIn,
  setFullAccessOptIn,
  setIsolatedServer,
  setRuntimeUpdatesLevel,
} from "./config.js";
import { type ControlRequest, controlRequest, controlSocketPath } from "./control-socket.js";
import { Daemon } from "./daemon.js";
import {
  createDoctorDeps,
  displayPath,
  doctorExitCode,
  formatDoctorJson,
  formatDoctorText,
  runDoctor,
} from "./doctor.js";
import { type EnrollResult, enroll } from "./enroll.js";
import { findExecutable } from "./exec-path.js";
import { readInstallInfo } from "./install-info.js";
import { createLogger, errorMessage, silentLogger } from "./logger.js";
import { publicInstallFields, resolveInstall } from "./maintenance/install-method.js";
import { PairingCancelledError, pairByDeviceCode } from "./pair.js";
import { assertProjectDirAllowed, noGitNotice } from "./project-dir.js";
import { createShutdownGuard, selfUpdateExit, stopSignal } from "./service/hand-over.js";
import { defaultServiceDeps, serviceCommand } from "./service/index.js";
import { applyServiceEnv } from "./service-env.js";
import {
  defaultSetupDeps,
  doctorProbes,
  parseSetupArgs,
  runSetup,
  SETUP_USAGE,
  type SetupArgs,
  SetupUsageError,
} from "./setup.js";
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

const ISOLATED_SERVER_WARNING =
  "Isolated server: bots that read outside content may run Full access sessions here. Turn this on only on a machine " +
  "that holds nothing else that matters.";

/**
 * 07.16 (D-19, PD-18) `isolated-server on|off|status`: local only, exactly like `full-access`; the server can never call
 * this. The server honours the mark only for a headless service daemon (`honoured`).
 */
async function isolatedServer(sub: string | undefined): Promise<void> {
  if (sub !== "on" && sub !== "off" && sub !== "status") {
    throw new Error("usage: ocw-runtime isolated-server on|off|status");
  }
  const home = ocwHome();
  if (sub !== "status") {
    if (sub === "on") process.stderr.write(`${ISOLATED_SERVER_WARNING}\n`);
    await setIsolatedServer(home, sub === "on");
  }
  let mark: { on: boolean; source: unknown; host: DeviceHostKind | null; daemon: "running" | "stopped" };
  try {
    const res = await controlRequest(controlSocketPath(home), {
      cmd: sub === "status" ? "status" : "reloadConfig",
    });
    if (!res.ok) throw new Error(res.error ?? "request failed");
    const r = res.result as {
      isolatedServer?: boolean;
      isolatedServerSource?: string;
      host?: DeviceHostKind | null;
    };
    mark = {
      on: r.isolatedServer === true,
      source: r.isolatedServerSource,
      host: r.host ?? null,
      daemon: "running",
    };
  } catch (err) {
    if (!daemonDown(err)) throw err;
    const local = resolveIsolatedServer(await loadConfig(home));
    const host = await resolveHostKind({ env: process.env, home, entry: process.argv[1] });
    mark = { on: local.on, source: local.source, host, daemon: "stopped" };
  }
  if (sub !== "status" && mark.on !== (sub === "on")) {
    process.stderr.write("Note: OCW_ISOLATED_SERVER in the daemon's environment overrides runtime.json.\n");
  }
  if (sub === "on" && mark.on && mark.host !== "service") {
    process.stderr.write(
      "Note: this runtime does not run as a headless service; the server ignores the mark here.\n",
    );
  }
  const out = {
    isolatedServer: mark.on,
    isolatedServerSource: mark.source,
    host: mark.host,
    honoured: mark.host === "service" && mark.on,
    daemon: mark.daemon,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

const BROWSER_USAGE = "usage: ocw-runtime browser on|off|status|install [--from-zip <zip>]";

/** A usage error of `browser`: stderr, exit 2, nothing written. */
function browserUsage(): void {
  process.stderr.write(`${BROWSER_USAGE}\n`);
  process.exitCode = 2;
}

/**
 * 07.13 (D-10, PD-27) `browser on|off|status`: local only, the `full-access` shape (write runtime.json, then the
 * value-less `reloadConfig` when a daemon answers; a stopped daemon reads the file on start); the server can never
 * call this. `browser install [--from-zip <zip>]` (D-05, PD-19): the pinned headless shell, verified, under
 * `browsersRoot()`; progress on stderr, the home-relative path on stdout.
 */
async function browserCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "install") {
    const fromZip = flag(rest, "from-zip");
    const known = rest.every(
      (a, i) => a === "--from-zip" || a.startsWith("--from-zip=") || rest[i - 1] === "--from-zip",
    );
    if (!known || (rest.length > 0 && !fromZip)) return browserUsage();
    return browserInstall(fromZip);
  }
  if ((sub !== "on" && sub !== "off" && sub !== "status") || rest.length > 0) return browserUsage();
  const home = ocwHome();
  if (sub !== "status") {
    await setBrowserOptIn(home, sub === "on");
    try {
      const res = await controlRequest(controlSocketPath(home), { cmd: "reloadConfig" });
      if (!res.ok)
        process.stderr.write(`Note: the running runtime did not reload its settings (${res.error}).\n`);
    } catch (err) {
      if (!daemonDown(err)) throw err;
    }
  }
  const state = resolveBrowser(await loadConfig(home));
  if (sub !== "status" && state.optIn !== (sub === "on")) {
    process.stderr.write("Note: OCW_ALLOW_BROWSER in the runtime's environment overrides runtime.json.\n");
  }
  const installed = await installedBrowser(browsersRoot()).catch(() => null);
  process.stdout.write(
    `Browser: ${state.optIn ? "on" : "off"} (${state.source}) · ${installed ? `installed ${installed.version}` : "not installed"}\n`,
  );
}

async function browserInstall(fromZip: string | undefined): Promise<void> {
  const verb = fromZip ? "Verifying" : "Downloading";
  let shown = -1;
  try {
    const installed = await installBrowser({
      root: browsersRoot(),
      ...(fromZip ? { fromZip: resolve(fromZip) } : {}),
      onProgress: ({ receivedBytes, totalBytes }) => {
        const pct = Math.floor((receivedBytes * 100) / totalBytes);
        if (pct >= shown + 5 || (pct === 100 && shown !== 100)) {
          shown = pct;
          process.stderr.write(`${verb} Chrome for Testing ${CFT_VERSION}: ${pct}%\n`);
        }
      },
    });
    process.stdout.write(
      `Chrome for Testing ${installed.version} is installed at ${displayPath(installed.executable, homedir())}\n`,
    );
  } catch (err) {
    if (!(err instanceof BrowserInstallError)) throw err;
    process.stderr.write(`ocw-runtime browser install: ${err.message} (${err.code})\n`);
    process.exitCode = 1;
  }
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

const ACCOUNT_USAGE =
  "usage: ocw-runtime account add codex [--label <label>] | account list | account remove codex <slotId|label>";

/** A usage error of `account`: stderr, exit 2. */
function accountUsage(line?: string): void {
  process.stderr.write(`${line ? `ocw-runtime account: ${line}\n` : ""}${ACCOUNT_USAGE}\n`);
  process.exitCode = 2;
}

/** 07.18 (PD-11): a running daemon re-sends its slots; a stopped one reports them on its next handshake. */
async function reloadDaemonAccounts(home: string): Promise<void> {
  try {
    const res = await controlRequest(controlSocketPath(home), { cmd: "reloadAccounts" });
    if (!res.ok)
      process.stderr.write(`Note: the running runtime did not reload its accounts (${res.error}).\n`);
  } catch (err) {
    if (!daemonDown(err)) throw err;
  }
}

async function codexAccountCall(home: string) {
  const config = await loadConfig(home);
  return {
    spawn: codexAccountSpawner(config.codex.path ?? findExecutable("codex"), silentLogger),
    env: process.env,
  };
}

/** `account add codex`: a new slot (`origin: "cli"`), Codex's device-code login on this terminal; Ctrl-C cancels (130). */
async function accountAdd(home: string, args: string[]): Promise<void> {
  await ensureOcwHome(home);
  const store = new CodexSlotStore(home, process.env);
  const typed = flag(args, "label");
  const label = PoolLabel.safeParse(typed ?? `Codex account ${(await store.list()).length + 1}`);
  if (!label.success) return accountUsage("the label must be 1 to 120 characters");
  const call = await codexAccountCall(home);
  const slot = await store.create({ label: label.data, origin: "cli" });
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  try {
    const { planType } = await runCodexDeviceLogin({
      ...call,
      home: store.homeOf(slot.slotId),
      signal: controller.signal,
      onCode: (code) =>
        process.stdout.write(
          `Open ${code.verificationUrl} and enter the code ${code.userCode} (it expires in 15 minutes).\n` +
            "Waiting for the sign-in…\n",
        ),
    });
    await store.setPlan(slot.slotId, planType);
    process.stdout.write(
      `Signed in (plan: ${planType ?? "unknown"}). The server lists it under Settings › Account pool; an admin turns it on.\n`,
    );
  } catch (err) {
    await store.remove(slot.slotId).catch(() => undefined);
    process.stderr.write(`${errorMessage(err)}\n`);
    process.exitCode = err instanceof CodexLoginError && err.code === "cancelled" ? 130 : 1;
    return;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
  await reloadDaemonAccounts(home);
}

/** `account list`: one line per slot (id, label, signed in, plan); never a path or anything from `auth.json`. */
async function accountList(home: string): Promise<void> {
  const slots = await new CodexSlotStore(home, process.env).report();
  if (slots.length === 0) {
    process.stdout.write("No Codex accounts on this device.\n");
    return;
  }
  for (const s of slots) {
    process.stdout.write(
      `${s.slotId}  ${s.label}  ${s.signedIn ? "signed in" : "not signed in"}  plan: ${s.planType ?? "-"}\n`,
    );
  }
}

/** `account remove codex <slotId|label>`: Codex signs it out (best effort), then the slot goes. */
async function accountRemove(home: string, ref: string | undefined): Promise<void> {
  if (!ref) return accountUsage();
  const store = new CodexSlotStore(home, process.env);
  const slots = await store.list();
  const byId = slots.find((s) => s.slotId === ref);
  const byLabel = slots.filter((s) => s.label === ref);
  if (!byId && byLabel.length > 1) {
    return accountUsage(`ambiguous: ${byLabel.map((s) => s.slotId).join(", ")}; use the slot id`);
  }
  const slot = byId ?? byLabel[0];
  if (!slot) return accountUsage(`no Codex account on this device matches "${ref}"`);
  try {
    await logoutCodex({ ...(await codexAccountCall(home)), home: store.homeOf(slot.slotId) });
  } catch (err) {
    process.stderr.write(`Note: Codex could not sign it out (${errorMessage(err)}); removing it anyway.\n`);
  }
  await store.remove(slot.slotId);
  process.stdout.write(`Removed "${slot.label}" (${slot.slotId}).\n`);
  await reloadDaemonAccounts(home);
}

/** 07.18 (D-02, PD-11) `account add|list|remove`: local only, over the same slot store the daemon reads. */
async function accountCommand(args: string[]): Promise<void> {
  const [sub, provider, ...rest] = args;
  const home = ocwHome();
  if (sub === "list" && provider === undefined) return accountList(home);
  if (provider !== "codex") return accountUsage();
  if (sub === "add") return accountAdd(home, rest);
  if (sub === "remove") return accountRemove(home, rest[0]);
  return accountUsage();
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
 * `setup` (07.12, D-02, PD-13): exit 0 done, 1 a step failed, 2 a usage error or a value missing without a terminal,
 * 130 cancelled (Ctrl-C aborts a pending prompt or pairing).
 */
async function setupCommand(argv: string[]): Promise<void> {
  let args: SetupArgs;
  try {
    args = parseSetupArgs(argv);
  } catch (err) {
    if (!(err instanceof SetupUsageError)) throw err;
    process.stderr.write(`ocw-runtime setup: ${err.message}\n${SETUP_USAGE.join("\n")}\n`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(`${SETUP_USAGE.join("\n")}\n`);
    return;
  }
  const deps = defaultSetupDeps(ocwHome());
  const onSigint = () => deps.cancel();
  process.on("SIGINT", onSigint);
  try {
    process.exitCode = await runSetup(args, deps);
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

/**
 * `doctor [--json]` (07.12, D-05, PD-12): service.env is applied to this process first (PD-10), so the local probes see
 * what the service sees; the service status comes from the same manager `service status` uses. Exit 1 on any fail.
 */
async function doctorCommand(argv: string[]): Promise<void> {
  const json = argv.includes("--json");
  const unknown = argv.find((a) => a !== "--json");
  if (unknown !== undefined) {
    process.stderr.write(
      `ocw-runtime doctor: unknown option ${unknown}\nusage: ocw-runtime doctor [--json]\n`,
    );
    process.exitCode = 2;
    return;
  }
  const home = ocwHome();
  await applyServiceEnv(home, process.env, silentLogger);
  const report = await runDoctor(createDoctorDeps(home, doctorProbes(home)));
  process.stdout.write(json ? formatDoctorJson(report) : formatDoctorText(report));
  process.exitCode = doctorExitCode(report);
}

/**
 * `run`: applies `~/.ocw/service.env` to this process's environment first (07.12, D-12: keys already set win, refused
 * unless 0600 and owned by this user, names logged, never values), then creates and starts the daemon. 07.17.1: the
 * daemon gets the self-update exit hook (`service/hand-over.ts`: stop, then exit 75); SIGTERM / SIGINT still stop and
 * exit 0. One stopping guard per run, shared by both, so only the first one exits.
 */
async function run(): Promise<void> {
  const home = ocwHome();
  const level = await loadConfig(home)
    .then((c) => c.logLevel)
    .catch(() => "info" as const);
  await applyServiceEnv(home, process.env, createLogger(level));
  let current: Daemon | null = null;
  const guard = createShutdownGuard();
  const exitForUpdate = selfUpdateExit({
    guard,
    stop: async () => {
      process.stderr.write("runtime updated, restarting\n");
      await current?.stop();
    },
    exit: (code) => process.exit(code),
  });
  // Review WR-03: the desktop app's `shutdown` control command takes the same path as SIGTERM (Windows cannot signal
  // the daemon's process tree). `shutdown` is defined below; the hook runs only once the socket answers.
  const daemon = await Daemon.create({ exitForUpdate, requestShutdown: () => shutdown("shutdown request") });
  current = daemon;
  // Handlers go in before start: the control socket exists before start() resolves, and a service manager (or a
  // test) may stop the daemon in that window. A signal then waits for start to settle and stops cleanly.
  let started: Promise<void> = Promise.resolve();
  const shutdown = (signal: string) => {
    if (!stopSignal(guard)) return;
    process.stderr.write(`received ${signal}, stopping\n`);
    started
      .catch(() => undefined)
      .then(() => daemon.stop())
      .catch(() => undefined)
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  started = daemon.start();
  await started;
}

/**
 * 07.13 (D-02): the hidden `browser-agent` child of a session's browser, started only by the daemon's `BrowserChild`
 * over pipes (not in the usage text). Refuses a terminal: it speaks frames, not text. Loaded lazily, so no other
 * command loads playwright-core. `--check` (07.13-20, PD-22, its only flag, fine from a terminal) is the build's
 * self-test: the bundle test and the desktop package check run it to prove this build loads the browser engine.
 */
async function browserAgentCommand(args: string[]): Promise<void> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    process.stderr.write("usage: ocw-runtime browser-agent [--check]\n");
    process.exitCode = 2;
    return;
  }
  if (args[0] === "--check") return browserAgentCheck();
  if (process.stdin.isTTY) {
    process.stderr.write("ocw-runtime: browser-agent is started by the daemon, not from a terminal\n");
    process.exitCode = 2;
    return;
  }
  const { runBrowserAgent } = await import("./browser/agent/main.js");
  runBrowserAgent(process.stdin, process.stdout);
}

/**
 * `browser-agent --check`: loads playwright-core and the engine's serializer the way the agent does, reads
 * playwright-core's version and prints `browser-agent ok <version>` (exit 0). Never launches a browser and needs none
 * installed. A missing playwright-core (an install without the externals, a desktop build that dropped it) prints
 * `browser-agent failed: playwright-core is not installed`; any other load error its first line; both exit 1.
 */
async function browserAgentCheck(): Promise<void> {
  try {
    await import("playwright-core");
    await import("@ocw/browser-engine/redact");
    // Resolved beside this file, like the import above: the bundle's or the packaged daemon's own node_modules.
    const { version } = createRequire(import.meta.url)("playwright-core/package.json") as { version: string };
    process.stdout.write(`browser-agent ok ${version}\n`);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    const message = errorMessage(err);
    const missing =
      (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") && message.includes("playwright-core");
    const reason = missing ? "playwright-core is not installed" : (message.split("\n")[0] ?? "");
    process.stdout.write(`browser-agent failed: ${reason}\n`);
    process.exitCode = 1;
  }
}

/**
 * 07.13 (D-08, PD-08): the hidden `browser-mcp` stdio MCP server of a Codex session's browser, started only by that
 * session's Codex app-server (`-c mcp_servers.ocw_browser.*`), not in the usage text. stdout is the MCP stream, so
 * nothing else may write there: console output goes to stderr. A missing or foreign token file exits non-zero before
 * serving. Loaded lazily, so no other command loads the MCP server.
 */
async function browserMcpCommand(): Promise<void> {
  if (process.stdin.isTTY) {
    process.stderr.write("ocw-runtime: browser-mcp is started by Codex, not from a terminal\n");
    process.exitCode = 2;
    return;
  }
  console.log = console.error;
  console.info = console.error;
  const { runBrowserMcpShim } = await import("./browser/mcp-shim.js");
  await runBrowserMcpShim({
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

/**
 * 07.13.1.1 (D-07, PD-08): the hidden `session-mcp` stdio MCP server of a Codex session's own tools (`ocw_session`,
 * the rename tool), started only by that session's Codex app-server (`-c mcp_servers.ocw_session.*`), not in the usage
 * text. stdout is the MCP stream, so console output goes to stderr. A missing or foreign token file, or a daemon that
 * does not know the session, exits non-zero before serving. Loaded lazily, so no other command loads the MCP server.
 */
async function sessionMcpCommand(): Promise<void> {
  if (process.stdin.isTTY) {
    process.stderr.write("ocw-runtime: session-mcp is started by Codex, not from a terminal\n");
    process.exitCode = 2;
    return;
  }
  console.log = console.error;
  console.info = console.error;
  const { runSessionMcpShim } = await import("./session-tools/mcp-shim.js");
  await runSessionMcpShim({
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
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
      const home = ocwHome();
      // The same folders the desktop refuses (home, system, OCW state), before anything is registered.
      const dir = await assertProjectDirAllowed(path, { forbidden: [home] });
      // stdout stays the project's JSON; the no-git note goes to stderr.
      const noGit = (p: unknown) => {
        const project = p as { git?: boolean; name?: string } | null;
        if (project?.git === false) process.stderr.write(`${noGitNotice(project.name ?? "this folder")}\n`);
      };
      try {
        const res = await controlRequest(controlSocketPath(home), {
          cmd: "addProject",
          path: dir,
          ...(name ? { name } : {}),
        });
        if (!res.ok) throw new Error(res.error ?? "request failed");
        process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
        noGit(res.result);
        return;
      } catch (err) {
        if (!daemonDown(err)) throw err;
        // Daemon not running: register directly; it is announced on the next connect.
        await ensureOcwHome(home);
        const registry = new ProjectRegistry(home);
        await registry.load();
        const project = await registry.add(dir, name);
        process.stdout.write(`${JSON.stringify(project, null, 2)}\n`);
        noGit(project);
        return;
      }
    }
    case "enroll":
      return enrollCommand(rest);
    case "full-access":
      return fullAccess(rest[0]);
    case "isolated-server":
      return isolatedServer(rest[0]);
    case "browser":
      return browserCommand(rest);
    case "updates":
      return updates(rest[0], rest[1]);
    case "remove-project":
      return removeProject(rest[0]);
    case "setup":
      return setupCommand(rest);
    case "service":
      process.exitCode = await serviceCommand(rest, defaultServiceDeps(ocwHome()));
      return;
    case "doctor":
      return doctorCommand(rest);
    case "account":
      return accountCommand(rest);
    case "browser-agent":
      return browserAgentCommand(rest);
    case "browser-mcp":
      return browserMcpCommand();
    case "session-mcp":
      return sessionMcpCommand();
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`ocw-runtime: ${errorMessage(err)}\n`);
  process.exit(1);
});
