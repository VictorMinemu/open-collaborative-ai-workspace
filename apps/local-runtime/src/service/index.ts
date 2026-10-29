// `ocw-runtime service …` (07.12-04, HSR-04, D-04, D-14, PD-11, PD-19): keep the runtime running across logouts,
// crashes and reboots on a server, through a systemd user unit, a systemd system unit for a named non-root account, or
// a macOS LaunchAgent. Every command goes through the injected exec and every file through the injected root, so tests
// never touch a real service manager or the developer's home. `setup` (08) installs through `createServiceManager`;
// `doctor` (05) reads its `ServiceStatus`; 08 wires `serviceCommand` into the CLI.

import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { ocwHome as defaultOcwHome } from "../config.js";
import { type ControlRequest, controlRequest as defaultControlRequest } from "../control-socket.js";
import { findExecutable } from "../exec-path.js";
import { installedBundlePath, readInstallInfo } from "../install-info.js";
import { type DetectedManager, detectServiceManager } from "./detect.js";
import { defaultServiceExec, type ServiceExecFn, type ServiceExecResult } from "./exec.js";
import { parseSystemdExecStart, renderSystemdUnit, SYSTEMD_UNIT_NAME } from "./systemd.js";
import type { ServiceManagerKind, ServiceStatus } from "./types.js";

export type { DetectedManager } from "./detect.js";
export type { ServiceExecFn } from "./exec.js";
export type { ServiceManagerKind, ServiceStatus } from "./types.js";

export interface ServiceDeps {
  platform: NodeJS.Platform;
  /** The uid running this command (0 = root). */
  uid: number;
  /** The account running this command. */
  account: string;
  /** Its home directory. */
  home: string;
  /** Its OCW_HOME (default `<home>/.ocw`). */
  ocwHome: string;
  /** The installer's environment (PATH, XDG_CONFIG_HOME). Never written into a unit beyond PATH. */
  env: NodeJS.ProcessEnv;
  /** This node binary, used when the one install.json names is gone. */
  execPath: string;
  exec: ServiceExecFn;
  which: (name: string) => string | null;
  controlRequest: (
    path: string,
    req: ControlRequest,
    timeoutMs?: number,
  ) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  /** `process.kill(pid, 0)`: throws ESRCH when the process is gone. */
  kill: (pid: number, signal: 0) => void;
  sleep: (ms: number) => Promise<void>;
  /** Every absolute machine path is resolved under this root: "/" in production, a temp dir in tests (PD-19). */
  root: string;
  /** One line of user-facing output. */
  out: (line: string) => void;
}

export function defaultServiceDeps(home: string = defaultOcwHome()): ServiceDeps {
  const info = userInfo();
  return {
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    account: info.username,
    home: homedir(),
    ocwHome: home,
    env: process.env,
    execPath: process.execPath,
    exec: defaultServiceExec,
    which: (name) => findExecutable(name, process.env),
    controlRequest: defaultControlRequest,
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    root: "/",
    out: (line) => process.stdout.write(`${line}\n`),
  };
}

export const NOT_INSTALLED_BUNDLE = "install the runtime with the command from Settings › Devices first";

export type InstallOutcome = "installed" | "unchanged" | "updated" | "updated-restart-pending";

export type InstallResult =
  | {
      ok: true;
      manager: ServiceManagerKind;
      /** Display form (`~/…` or `/etc/systemd/system/…`). */
      unitPath: string;
      outcome: InstallOutcome;
      active: boolean | null;
      /** Notes to print (linger, sign-in account, restart hint). */
      lines: string[];
    }
  | { ok: false; error: string; lines: string[] };

export type ActionResult = { ok: true; lines: string[] } | { ok: false; error: string; lines: string[] };

export interface ServiceManager {
  detect(opts?: { system?: boolean }): Promise<DetectedManager>;
  install(opts?: { manager?: ServiceManagerKind; account?: string }): Promise<InstallResult>;
  uninstall(opts?: { system?: boolean }): Promise<ActionResult>;
  status(opts?: { system?: boolean }): Promise<ServiceStatus>;
  /** Prints through `deps.out` (or hands the terminal over with `follow`); returns an exit code. */
  logs(opts: { lines: number; follow: boolean; system?: boolean }): Promise<number>;
  restart(opts?: { system?: boolean }): Promise<ActionResult>;
}

class ServiceError extends Error {}

/** The unit a command acts on: whose it is, where its file lives, and how to drive it. */
interface Target {
  kind: "systemd-user" | "systemd-system";
  account: string;
  home: string;
  ocwHome: string;
  /** Machine path of the unit file. */
  unitPath: string;
  /** `systemctl --user` or `systemctl`. */
  ctl: string[];
  /** `journalctl --user` or `journalctl`. */
  journal: string[];
}

export function createServiceManager(deps: ServiceDeps): ServiceManager {
  const at = (p: string) => (deps.root === "/" ? p : join(deps.root, p));
  const exists = async (p: string) => {
    try {
      await stat(at(p));
      return true;
    } catch {
      return false;
    }
  };
  const isDir = async (p: string) => {
    try {
      return (await stat(at(p))).isDirectory();
    } catch {
      return false;
    }
  };
  const readText = async (p: string) => {
    try {
      return await readFile(at(p), "utf8");
    } catch {
      return null;
    }
  };
  const writeUnit = async (p: string, text: string, dirMode = 0o755) => {
    await mkdir(at(dirname(p)), { recursive: true, mode: dirMode });
    const tmp = `${at(p)}.tmp-${process.pid}`;
    await writeFile(tmp, text, { mode: 0o644 });
    await chmod(tmp, 0o644);
    await rename(tmp, at(p));
  };
  /** `~/…` under the running account's home; other paths as they are (never a host path that leaves the device). */
  const display = (p: string, home = deps.home) =>
    p === home ? "~" : p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p;
  const run = (argv: string[], opts?: { inherit?: boolean }): Promise<ServiceExecResult> =>
    deps.exec(argv[0]!, argv.slice(1), opts).catch((err: unknown) => ({
      code: null,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    }));
  const firstLine = (r: ServiceExecResult) =>
    (r.stderr || r.stdout)
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? `exit ${r.code ?? "?"}`;

  const detect = (opts: { system?: boolean } = {}) =>
    detectServiceManager(
      { platform: deps.platform, account: deps.account, exists, which: deps.which, exec: deps.exec },
      opts,
    );

  function userUnitPath(): string {
    const xdg = deps.env.XDG_CONFIG_HOME;
    const config = xdg && isAbsolute(xdg) ? xdg : join(deps.home, ".config");
    return join(config, "systemd", "user", SYSTEMD_UNIT_NAME);
  }

  function userTarget(): Target {
    return {
      kind: "systemd-user",
      account: deps.account,
      home: deps.home,
      ocwHome: deps.ocwHome,
      unitPath: userUnitPath(),
      ctl: ["systemctl", "--user"],
      journal: ["journalctl", "--user"],
    };
  }

  /** The node and PATH the unit runs with: install.json's node (else this one), then existing PATH entries, once. */
  async function serviceRuntime(
    ocwHome: string,
  ): Promise<{ nodePath: string; bundlePath: string; path: string; notes: string[] }> {
    const info = await readInstallInfo(at(ocwHome));
    const bundlePath = installedBundlePath(ocwHome);
    if (!info || !(await exists(bundlePath))) throw new ServiceError(NOT_INSTALLED_BUNDLE);
    const notes: string[] = [];
    let nodePath = info.nodePath;
    if (!isAbsolute(nodePath) || !(await exists(nodePath))) {
      nodePath = deps.execPath;
      notes.push(`the node binary the install recorded is gone; the service uses ${display(nodePath)}`);
    }
    const dirs: string[] = [];
    for (const dir of [dirname(nodePath), ...(deps.env.PATH ?? "").split(delimiter)]) {
      if (!dir || !isAbsolute(dir) || dirs.includes(dir)) continue;
      if (dir !== dirname(nodePath) && !(await isDir(dir))) continue;
      dirs.push(dir);
    }
    return { nodePath, bundlePath, path: dirs.join(delimiter), notes };
  }

  async function systemdActive(t: Target): Promise<boolean | null> {
    const r = await run([...t.ctl, "is-active", SYSTEMD_UNIT_NAME]);
    if (r.code === null && !r.stdout) return null;
    return r.stdout.trim() === "active";
  }

  async function linger(account: string): Promise<boolean | null> {
    const r = await run(["loginctl", "show-user", account, "--property=Linger"]);
    const m = /^Linger=(yes|no)$/m.exec(r.stdout);
    return m ? m[1] === "yes" : null;
  }

  async function installSystemd(t: Target): Promise<InstallResult> {
    const rt = await serviceRuntime(t.ocwHome);
    const unit = renderSystemdUnit({
      scope: t.kind === "systemd-user" ? "user" : "system",
      nodePath: rt.nodePath,
      bundlePath: rt.bundlePath,
      workingDirectory: t.home,
      path: rt.path,
      ...(t.ocwHome !== join(t.home, ".ocw") ? { ocwHome: t.ocwHome } : {}),
      ...(t.kind === "systemd-system" ? { account: t.account } : {}),
    });
    const lines = [...rt.notes];
    await writeUnit(t.unitPath, unit);
    for (const step of [
      [...t.ctl, "daemon-reload"],
      [...t.ctl, "enable", "--now", SYSTEMD_UNIT_NAME],
    ]) {
      const r = await run(step);
      if (r.code !== 0) throw new ServiceError(`${step.slice(0, 3).join(" ")} failed: ${firstLine(r)}`);
    }
    const active = await systemdActive(t);
    if (t.kind === "systemd-user" && (await linger(t.account)) === false) {
      lines.push(
        `Lingering is off: the runtime stops when ${t.account} logs out and does not start at boot. Turn it on with:`,
        `  sudo loginctl enable-linger ${t.account}`,
      );
    }
    return finishInstall(t, "installed", active, lines);
  }

  function finishInstall(
    t: Target,
    outcome: InstallOutcome,
    active: boolean | null,
    lines: string[],
  ): InstallResult {
    const unitPath = display(t.unitPath);
    if (active === false) {
      return {
        ok: false,
        error: `${SYSTEMD_UNIT_NAME} is installed (${unitPath}) but not running: see \`ocw-runtime service logs\``,
        lines,
      };
    }
    lines.push(`The service runs as ${t.account}: sign Claude Code and Codex in as ${t.account}.`);
    return { ok: true, manager: t.kind, unitPath, outcome, active, lines };
  }

  async function resolveInstallTarget(opts: {
    manager?: ServiceManagerKind;
    account?: string;
  }): Promise<Target> {
    const manager = opts.manager ?? (deps.platform === "darwin" ? "launchd" : "systemd-user");
    if (manager === "none") throw new ServiceError("no service requested");
    if (manager === "systemd-system" || manager === "launchd") {
      throw new ServiceError(`${manager} is not supported yet`);
    }
    if (deps.uid === 0) {
      throw new ServiceError(
        "the runtime never runs as root: install a system unit for a non-root account with `ocw-runtime service install --system --user-name <account>`",
      );
    }
    const detected = await detect();
    if (!detected.available) throw new ServiceError(detected.reason ?? "no service manager here");
    return userTarget();
  }

  /** The installed unit status/uninstall/restart/logs act on. */
  async function resolveExistingTarget(_opts: { system?: boolean } = {}): Promise<Target> {
    return userTarget();
  }

  function emptyStatus(manager: ServiceManagerKind, account: string, reason: string | null): ServiceStatus {
    return {
      manager,
      installed: false,
      enabled: null,
      active: null,
      linger: null,
      account,
      unitPath: null,
      nodePathExists: null,
      bundlePathExists: null,
      reason,
    };
  }

  async function systemdStatus(t: Target): Promise<ServiceStatus> {
    const text = await readText(t.unitPath);
    if (text === null) return emptyStatus(t.kind, t.account, null);
    const paths = parseSystemdExecStart(text);
    const enabledOut = (await run([...t.ctl, "is-enabled", SYSTEMD_UNIT_NAME])).stdout.trim();
    const enabled = ["enabled", "enabled-runtime"].includes(enabledOut)
      ? true
      : ["disabled", "masked"].includes(enabledOut)
        ? false
        : null;
    return {
      manager: t.kind,
      installed: true,
      enabled,
      active: await systemdActive(t),
      linger: t.kind === "systemd-user" ? await linger(t.account) : null,
      account: t.account,
      unitPath: display(t.unitPath),
      nodePathExists: paths ? await exists(paths.nodePath) : null,
      bundlePathExists: paths ? await exists(paths.bundlePath) : null,
      reason: null,
    };
  }

  return {
    detect,

    async install(opts = {}) {
      try {
        const t = await resolveInstallTarget(opts);
        return await installSystemd(t);
      } catch (err) {
        if (err instanceof ServiceError) return { ok: false, error: err.message, lines: [] };
        throw err;
      }
    },

    async uninstall(opts = {}) {
      const t = await resolveExistingTarget(opts);
      if (!(await exists(t.unitPath))) return { ok: true, lines: [`${SYSTEMD_UNIT_NAME} is not installed`] };
      const disable = await run([...t.ctl, "disable", "--now", SYSTEMD_UNIT_NAME]);
      await rm(at(t.unitPath), { force: true });
      await run([...t.ctl, "daemon-reload"]);
      const lines = [`Removed ${display(t.unitPath)}`];
      if (disable.code !== 0) lines.push(`systemctl disable reported: ${firstLine(disable)}`);
      return { ok: true, lines };
    },

    async status(opts = {}) {
      if (deps.platform !== "linux") {
        const d = await detect();
        return emptyStatus(d.kind, deps.account, d.reason);
      }
      const d = await detect(opts);
      if (d.kind === "none") return emptyStatus("none", deps.account, d.reason);
      const t = await resolveExistingTarget(opts);
      const s = await systemdStatus(t);
      if (s.installed && !d.available)
        return { ...s, enabled: null, active: null, linger: null, reason: d.reason };
      return s;
    },

    async logs({ lines, follow, ...opts }) {
      const t = await resolveExistingTarget(opts);
      const argv = [
        ...t.journal,
        "-u",
        SYSTEMD_UNIT_NAME,
        "-n",
        String(lines),
        "--no-pager",
        ...(follow ? ["-f"] : []),
      ];
      if (follow) {
        const r = await run(argv, { inherit: true });
        return r.code === 0 || r.code === null ? 0 : 1;
      }
      const r = await run(argv);
      for (const line of r.stdout.replace(/\n$/, "").split("\n")) if (line) deps.out(line);
      if (r.code !== 0) {
        deps.out(`journalctl failed: ${firstLine(r)}`);
        return 1;
      }
      return 0;
    },

    async restart(opts = {}) {
      const t = await resolveExistingTarget(opts);
      if (!(await exists(t.unitPath))) {
        return {
          ok: false,
          error: `${SYSTEMD_UNIT_NAME} is not installed: run \`ocw-runtime service install\``,
          lines: [],
        };
      }
      const r = await run([...t.ctl, "restart", SYSTEMD_UNIT_NAME]);
      if (r.code !== 0) return { ok: false, error: `restart failed: ${firstLine(r)}`, lines: [] };
      return { ok: true, lines: [`Restarted ${SYSTEMD_UNIT_NAME}`] };
    },
  };
}

const USAGE = [
  "usage: ocw-runtime service <command>",
  "  install [--system --user-name <account>]   install and start the runtime service",
  "  uninstall [--system]                       stop and remove it",
  "  status [--json] [--system]                 show its state",
  "  logs [-n <lines>] [--follow] [--system]    show its log",
  "  restart [--system]                         restart it",
];

interface ParsedArgs {
  system: boolean;
  json: boolean;
  follow: boolean;
  lines: number;
  userName: string | null;
}

function parseArgs(sub: string, args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { system: false, json: false, follow: false, lines: 200, userName: null };
  const allowed: Record<string, string[]> = {
    install: ["--system", "--user-name"],
    uninstall: ["--system"],
    status: ["--system", "--json"],
    logs: ["--system", "-n", "--lines", "-f", "--follow"],
    restart: ["--system"],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!allowed[sub]?.includes(arg)) throw new ServiceError(`unknown option ${arg} for \`service ${sub}\``);
    switch (arg) {
      case "--system":
        parsed.system = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "-f":
      case "--follow":
        parsed.follow = true;
        break;
      case "-n":
      case "--lines": {
        const value = args[++i];
        if (!value || !/^\d{1,6}$/.test(value) || Number(value) < 1) {
          throw new ServiceError(`${arg} needs a positive number of lines`);
        }
        parsed.lines = Number(value);
        break;
      }
      case "--user-name": {
        const value = args[++i];
        if (!value) throw new ServiceError("--user-name needs an account name");
        parsed.userName = value;
        break;
      }
    }
  }
  return parsed;
}

function yesNo(v: boolean | null): string {
  return v === null ? "unknown" : v ? "yes" : "no";
}

function statusText(s: ServiceStatus): string[] {
  if (!s.installed) {
    return [`Service: not installed (${s.manager})`, ...(s.reason ? [`  ${s.reason}`] : [])];
  }
  const lines = [
    `Service: ${s.manager} ${s.unitPath ?? ""}`.trimEnd(),
    `  account: ${s.account}`,
    `  enabled: ${yesNo(s.enabled)}, running: ${yesNo(s.active)}`,
  ];
  if (s.linger === false) lines.push(`  lingering: off (sudo loginctl enable-linger ${s.account})`);
  if (s.nodePathExists === false)
    lines.push("  the node binary it names is gone: re-run `ocw-runtime service install`");
  if (s.bundlePathExists === false)
    lines.push("  the runtime bundle it names is gone: re-run the install command");
  if (s.reason) lines.push(`  ${s.reason}`);
  return lines;
}

/** `ocw-runtime service <install|uninstall|status|logs|restart> …` → exit code (08 wires the CLI case). */
export async function serviceCommand(
  argv: string[],
  deps: ServiceDeps = defaultServiceDeps(),
): Promise<number> {
  const [sub, ...rest] = argv;
  const manager = createServiceManager(deps);
  const fail = (message: string) => {
    deps.out(`ocw-runtime service: ${message}`);
    return 1;
  };
  if (!sub || !["install", "uninstall", "status", "logs", "restart"].includes(sub)) {
    for (const line of USAGE) deps.out(line);
    return 1;
  }
  let args: ParsedArgs;
  try {
    args = parseArgs(sub, rest);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  switch (sub) {
    case "install": {
      if (args.userName && !args.system) return fail("--user-name goes with --system");
      const r = await manager.install(
        args.system
          ? { manager: "systemd-system", ...(args.userName ? { account: args.userName } : {}) }
          : {},
      );
      for (const line of r.lines) deps.out(line);
      if (!r.ok) return fail(r.error);
      const state =
        r.outcome === "unchanged" ? "already installed and running" : r.active ? "running" : "installed";
      deps.out(`ocw-runtime service: ${r.manager} ${r.unitPath}: ${state}`);
      return 0;
    }
    case "uninstall":
    case "restart": {
      const r =
        sub === "uninstall"
          ? await manager.uninstall({ system: args.system })
          : await manager.restart({ system: args.system });
      for (const line of r.lines) deps.out(line);
      return r.ok ? 0 : fail(r.error);
    }
    case "status": {
      const s = await manager.status({ system: args.system });
      if (args.json) deps.out(JSON.stringify(s, null, 2));
      else for (const line of statusText(s)) deps.out(line);
      return 0;
    }
    default:
      return manager.logs({ lines: args.lines, follow: args.follow, system: args.system });
  }
}
