// `ocw-runtime service …` (07.12-04, HSR-04, D-04, D-14, PD-11, PD-19): keep the runtime running across logouts,
// crashes and reboots on a server, through a systemd user unit, a systemd system unit for a named non-root account, or
// a macOS LaunchAgent. Root never runs this code (07.12 review HI-01): every file of the runtime belongs to its account,
// which its sessions can change, so a system unit is printed here, as that account, with the only commands root runs
// (`install` and `systemctl`). Every command goes through the injected exec and every file through the injected root, so tests
// never touch a real service manager or the developer's home. `setup` (08) installs through `createServiceManager`;
// `doctor` (05) reads its `ServiceStatus`; 08 wires `serviceCommand` into the CLI.

import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { ocwHome as defaultOcwHome } from "../config.js";
import { type ControlRequest, controlRequest as defaultControlRequest } from "../control-socket.js";
import { findExecutable } from "../exec-path.js";
import { installedBundlePath, readInstallInfo } from "../install-info.js";
import { type DetectedManager, detectServiceManager } from "./detect.js";
import { defaultServiceExec, type ServiceExecFn, type ServiceExecResult } from "./exec.js";
import {
  LAUNCHD_LABEL,
  LAUNCHD_PLIST_FILE,
  parseLaunchctlPrint,
  parseLaunchdProgramArguments,
  renderLaunchdPlist,
} from "./launchd.js";
import { runtimeIdle, runtimeOwnerConflict } from "./owner.js";
import {
  isValidAccountName,
  parseSystemdExecStart,
  renderSystemdUnit,
  SYSTEMD_SYSTEM_UNIT_DIR,
  SYSTEMD_UNIT_NAME,
} from "./systemd.js";
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

/** `root-step`: a system unit, printed with the commands root runs; nothing was written or started. */
export type InstallOutcome = "installed" | "unchanged" | "updated" | "updated-restart-pending" | "root-step";

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

/** Above this the LaunchAgent's log is moved to `runtime.log.1` at install and restart (launchd holds it open). */
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
/** `logs` without follow reads at most this much of the end of the log file. */
const LOG_TAIL_READ_BYTES = 1024 * 1024;

/** The unit a command acts on: whose it is, and where its file lives. */
interface Target {
  kind: "systemd-user" | "systemd-system" | "launchd";
  account: string;
  home: string;
  ocwHome: string;
  /** Machine path of the unit or plist file. */
  unitPath: string;
}

const SYSTEM_UNIT_PATH = join(SYSTEMD_SYSTEM_UNIT_DIR, SYSTEMD_UNIT_NAME);

/** The heredoc delimiter of the printed root block; no unit line can equal it (each is a directive or a header). */
export const ROOT_BLOCK_MARKER = "OCW_UNIT";

/**
 * Root never runs `ocw-runtime` (HI-01): the launcher, the bundle and install.json belong to the runtime's account, so
 * anything that account (or a session running as it) writes would run as root. Every `service` command run as uid 0
 * stops with this line, which names the system binaries root uses instead.
 */
export const ROOT_REFUSAL =
  "ocw-runtime does not run as root: its files belong to the account that runs it, and that account's sessions can " +
  "change them. Run it as that account (`sudo -u <account> -i ocw-runtime service …`); for a system unit it prints " +
  `the only commands root runs. Root itself uses \`systemctl restart|status ${SYSTEMD_UNIT_NAME}\` and ` +
  `\`journalctl -u ${SYSTEMD_UNIT_NAME}\`.`;

/** The lines an admin runs as root to write a system unit: only `install` and `systemctl`, never a file of the account. */
export function systemUnitRootBlock(unitText: string, opts: { update: boolean }): string[] {
  const body = unitText.replace(/\n$/, "").split("\n");
  if (body.includes(ROOT_BLOCK_MARKER)) throw new Error("the unit cannot be printed as a root block");
  return [
    `sudo install -m 0644 /dev/stdin ${SYSTEM_UNIT_PATH} <<'${ROOT_BLOCK_MARKER}'`,
    ...body,
    ROOT_BLOCK_MARKER,
    "sudo systemctl daemon-reload",
    opts.update
      ? `sudo systemctl restart ${SYSTEMD_UNIT_NAME}`
      : `sudo systemctl enable --now ${SYSTEMD_UNIT_NAME}`,
  ];
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
  const writeUnit = async (p: string, text: string) => {
    await mkdir(at(dirname(p)), { recursive: true, mode: 0o755 });
    const tmp = `${at(p)}.tmp-${process.pid}`;
    await writeFile(tmp, text, { mode: 0o644 });
    await chmod(tmp, 0o644);
    await rename(tmp, at(p));
  };
  /** `~/…` under the running account's home; other paths as they are (local output only, AGENTS principle 7). */
  const display = (p: string) =>
    p === deps.home ? "~" : p.startsWith(`${deps.home}/`) ? `~/${p.slice(deps.home.length + 1)}` : p;
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

  // --- targets -------------------------------------------------------------------------------------------------

  function userTarget(): Target {
    const xdg = deps.env.XDG_CONFIG_HOME;
    const config = xdg && isAbsolute(xdg) ? xdg : join(deps.home, ".config");
    return {
      kind: "systemd-user",
      account: deps.account,
      home: deps.home,
      ocwHome: deps.ocwHome,
      unitPath: join(config, "systemd", "user", SYSTEMD_UNIT_NAME),
    };
  }

  function systemTarget(account: string, home: string, ocwHome = join(home, ".ocw")): Target {
    return { kind: "systemd-system", account, home, ocwHome, unitPath: SYSTEM_UNIT_PATH };
  }

  function launchdTarget(): Target {
    return {
      kind: "launchd",
      account: deps.account,
      home: deps.home,
      ocwHome: deps.ocwHome,
      unitPath: join(deps.home, "Library", "LaunchAgents", LAUNCHD_PLIST_FILE),
    };
  }

  const ctl = (t: Target) => (t.kind === "systemd-user" ? ["systemctl", "--user"] : ["systemctl"]);
  const journal = (t: Target) => (t.kind === "systemd-user" ? ["journalctl", "--user"] : ["journalctl"]);
  const unitName = (t: Target) => (t.kind === "launchd" ? LAUNCHD_LABEL : SYSTEMD_UNIT_NAME);
  const launchdDomain = () => `gui/${deps.uid}`;
  const launchdService = () => `${launchdDomain()}/${LAUNCHD_LABEL}`;
  const logFile = (t: Target) => join(t.ocwHome, "logs", "runtime.log");

  async function resolveInstallTarget(opts: {
    manager?: ServiceManagerKind;
    account?: string;
  }): Promise<Target> {
    const manager = opts.manager ?? (deps.platform === "darwin" ? "launchd" : "systemd-user");
    if (manager === "none") throw new ServiceError("no service manager was chosen");
    if (deps.uid === 0) throw new ServiceError(ROOT_REFUSAL);
    if (manager === "systemd-system") {
      const detected = await detect({ system: true });
      if (!detected.available) throw new ServiceError(detected.reason ?? "no service manager here");
      // Printed by the account it runs as, from that account's own install: root only writes the printed text.
      const account = opts.account ?? deps.account;
      if (!isValidAccountName(account))
        throw new ServiceError(`invalid account name: ${JSON.stringify(account)}`);
      if (account === "root")
        throw new ServiceError("the runtime never runs as root: name a non-root account");
      if (account !== deps.account) {
        throw new ServiceError(
          `a system unit is printed by the account it runs as: run \`sudo -u ${account} -i ocw-runtime service install --system\``,
        );
      }
      return systemTarget(deps.account, deps.home, deps.ocwHome);
    }
    const detected = await detect();
    if (!detected.available) throw new ServiceError(detected.reason ?? "no service manager here");
    if (detected.kind !== manager) throw new ServiceError(`${manager} is not available here`);
    return manager === "launchd" ? launchdTarget() : userTarget();
  }

  /** The installed unit that status, uninstall, restart and logs act on. */
  async function resolveExistingTarget(opts: { system?: boolean } = {}): Promise<Target> {
    if (deps.platform === "darwin") return launchdTarget();
    const user = userTarget();
    if (!opts.system && (await exists(user.unitPath))) return user;
    const text = await readText(SYSTEM_UNIT_PATH);
    if (text !== null) {
      const account = /^User=(.+)$/m.exec(text)?.[1] ?? deps.account;
      const home = /^WorkingDirectory=(.+)$/m.exec(text)?.[1]?.replaceAll("%%", "%") ?? deps.home;
      // The account itself knows its OCW_HOME (the unit names it only when it is not the default).
      return account === deps.account && home === deps.home
        ? systemTarget(account, home, deps.ocwHome)
        : systemTarget(account, home);
    }
    if (opts.system || deps.uid === 0) return systemTarget(deps.account, deps.home);
    return user;
  }

  // --- install -------------------------------------------------------------------------------------------------

  /** The node and PATH the unit runs with: install.json's node (else this one), then existing PATH entries, once. */
  async function serviceRuntime(
    t: Target,
  ): Promise<{ nodePath: string; bundlePath: string; path: string; notes: string[] }> {
    const info = await readInstallInfo(at(t.ocwHome));
    const bundlePath = installedBundlePath(t.ocwHome);
    if (!info || !(await exists(bundlePath))) {
      throw new ServiceError(NOT_INSTALLED_BUNDLE);
    }
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

  async function render(t: Target): Promise<{ text: string; notes: string[] }> {
    const rt = await serviceRuntime(t);
    try {
      return renderFor(t, rt);
    } catch (err) {
      // A path with a newline or control character, or an account the renderer refuses: nothing is written.
      throw new ServiceError(err instanceof Error ? err.message : String(err));
    }
  }

  function renderFor(
    t: Target,
    rt: { nodePath: string; bundlePath: string; path: string; notes: string[] },
  ): { text: string; notes: string[] } {
    const ocwHome = t.ocwHome !== join(t.home, ".ocw") ? { ocwHome: t.ocwHome } : {};
    if (t.kind === "launchd") {
      const text = renderLaunchdPlist({
        nodePath: rt.nodePath,
        bundlePath: rt.bundlePath,
        workingDirectory: t.home,
        path: rt.path,
        logFile: logFile(t),
        ...ocwHome,
      });
      return { text, notes: rt.notes };
    }
    const text = renderSystemdUnit({
      scope: t.kind === "systemd-user" ? "user" : "system",
      nodePath: rt.nodePath,
      bundlePath: rt.bundlePath,
      workingDirectory: t.home,
      path: rt.path,
      ...ocwHome,
      ...(t.kind === "systemd-system" ? { account: t.account } : {}),
    });
    return { text, notes: rt.notes };
  }

  async function systemdActive(t: Target): Promise<boolean | null> {
    const r = await run([...ctl(t), "is-active", SYSTEMD_UNIT_NAME]);
    if (r.code === null && !r.stdout) return null;
    return r.stdout.trim() === "active";
  }

  async function linger(account: string): Promise<boolean | null> {
    const r = await run(["loginctl", "show-user", account, "--property=Linger"]);
    const m = /^Linger=(yes|no)$/m.exec(r.stdout);
    return m ? m[1] === "yes" : null;
  }

  async function launchdPrint(): Promise<{ loaded: boolean; running: boolean }> {
    const r = await run(["launchctl", "print", launchdService()]);
    if (r.code !== 0) return { loaded: false, running: false };
    const { state, pid } = parseLaunchctlPrint(r.stdout);
    return { loaded: true, running: state === "running" && pid !== null };
  }

  /** Move a log above 5 MB aside; launchd reopens the path when the agent starts again. */
  async function rotateLog(t: Target): Promise<void> {
    const file = at(logFile(t));
    try {
      if ((await stat(file)).size > LOG_ROTATE_BYTES) await rename(file, `${file}.1`);
    } catch {
      // no log yet
    }
  }

  async function bootstrap(t: Target): Promise<void> {
    let r = await run(["launchctl", "bootstrap", launchdDomain(), t.unitPath]);
    if (r.code !== 0) {
      // launchd may still be tearing the previous instance down (`Bootstrap failed: 5`): one retry.
      await deps.sleep(1_000);
      r = await run(["launchctl", "bootstrap", launchdDomain(), t.unitPath]);
    }
    if (r.code !== 0) throw new ServiceError(`launchctl bootstrap failed: ${firstLine(r)}`);
  }

  async function startLaunchd(t: Target): Promise<boolean> {
    await run(["launchctl", "bootout", launchdService()]); // not loaded is fine
    await rotateLog(t);
    await bootstrap(t);
    let state = await launchdPrint();
    if (!state.running) {
      await deps.sleep(1_000);
      state = await launchdPrint();
    }
    return state.running;
  }

  async function mustRun(argv: string[]): Promise<void> {
    const r = await run(argv);
    if (r.code !== 0) throw new ServiceError(`${argv.join(" ")} failed: ${firstLine(r)}`);
  }

  async function startSystemd(t: Target): Promise<boolean | null> {
    await mustRun([...ctl(t), "daemon-reload"]);
    await mustRun([...ctl(t), "enable", "--now", SYSTEMD_UNIT_NAME]);
    return systemdActive(t);
  }

  async function lingerNote(t: Target, lines: string[]): Promise<void> {
    if ((await linger(t.account)) !== false) return;
    lines.push(
      `Lingering is off: the runtime stops when ${t.account} logs out and does not start at boot. Turn it on with:`,
      `  sudo loginctl enable-linger ${t.account}`,
    );
  }

  async function isRunning(t: Target): Promise<boolean> {
    return t.kind === "launchd" ? (await launchdPrint()).running : (await systemdActive(t)) === true;
  }

  /**
   * Install, or re-install idempotently (D-14, PD-11): the same definition on a running service changes nothing; a
   * changed one is written and applied by a restart only when the runtime reports no session, else the restart command
   * is printed. Refuses before writing anything while another runtime owns this `~/.ocw`.
   */
  async function installTarget(t: Target): Promise<InstallResult> {
    if (t.kind === "systemd-system") return printSystemUnit(t);
    const { text, notes } = await render(t);
    const lines = [...notes];
    const existing = await readText(t.unitPath);
    const running = existing !== null && (await isRunning(t));
    const conflict = await runtimeOwnerConflict(t.ocwHome, {
      controlRequest: deps.controlRequest,
      readText,
      kill: deps.kill,
      serviceActive: running,
    });
    if (conflict.kind !== "none") throw new ServiceError(conflict.message);

    let outcome: InstallOutcome;
    let active: boolean | null;
    if (running && existing === text) {
      outcome = "unchanged";
      active = true;
    } else {
      if (t.kind === "launchd") await ensureLogDir(t);
      await writeUnit(t.unitPath, text);
      if (running) {
        if (t.kind !== "launchd") await mustRun([...ctl(t), "daemon-reload"]);
        if (await runtimeIdle(t.ocwHome, deps)) {
          if (t.kind === "launchd") active = await startLaunchd(t);
          else {
            await mustRun([...ctl(t), "restart", SYSTEMD_UNIT_NAME]);
            active = await systemdActive(t);
          }
          outcome = "updated";
        } else {
          lines.push(
            "The new definition applies at the next start: restart with `ocw-runtime service restart` when no session runs.",
          );
          active = true;
          outcome = "updated-restart-pending";
        }
      } else {
        active = t.kind === "launchd" ? await startLaunchd(t) : await startSystemd(t);
        outcome = existing === null ? "installed" : "updated";
      }
    }
    if (t.kind === "systemd-user") await lingerNote(t, lines);
    return finishInstall(t, outcome, active, lines);
  }

  /**
   * A system unit (HI-01): rendered from this account's install and printed with the root block (`install` from stdin,
   * then `systemctl`), so root never runs a file the account can change. The unit's `User=` keeps the runtime itself on
   * the account. Nothing is written or started here; the same unit, already running, prints only its state.
   */
  async function printSystemUnit(t: Target): Promise<InstallResult> {
    const { text, notes } = await render(t);
    const lines = [...notes];
    const existing = await readText(t.unitPath);
    const running = existing !== null && (await isRunning(t));
    const conflict = await runtimeOwnerConflict(t.ocwHome, {
      controlRequest: deps.controlRequest,
      readText,
      kill: deps.kill,
      serviceActive: running,
    });
    if (conflict.kind !== "none") throw new ServiceError(conflict.message);
    if (running && existing === text) return finishInstall(t, "unchanged", true, lines);
    const update = existing !== null;
    lines.push(
      `A system unit is written by root, and root runs nothing ${t.account} can change: only install and systemctl.`,
      `Check that the unit below runs as ${t.account} (User=${t.account}), then run these lines as root` +
        (update ? ", when no session runs:" : ":"),
      "",
      ...systemUnitRootBlock(text, { update }),
      "",
    );
    return finishInstall(t, "root-step", running ? true : null, lines);
  }

  async function ensureLogDir(t: Target): Promise<void> {
    const dir = at(join(t.ocwHome, "logs"));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
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
        error: `${unitName(t)} is installed (${unitPath}) but not running: see \`ocw-runtime service logs\``,
        lines,
      };
    }
    lines.push(
      t.kind === "systemd-system"
        ? `The service runs as ${t.account}: sign Claude Code and Codex in as ${t.account}, then check with ` +
            "`ocw-runtime doctor`."
        : `The service runs as ${t.account}: sign Claude Code and Codex in as ${t.account}.`,
    );
    return { ok: true, manager: t.kind, unitPath, outcome, active, lines };
  }

  // --- status --------------------------------------------------------------------------------------------------

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

  async function pathFacts(paths: { nodePath: string; bundlePath: string } | null) {
    return {
      nodePathExists: paths ? await exists(paths.nodePath) : null,
      bundlePathExists: paths ? await exists(paths.bundlePath) : null,
    };
  }

  async function systemdStatus(t: Target): Promise<ServiceStatus> {
    const text = await readText(t.unitPath);
    if (text === null) return emptyStatus(t.kind, t.account, null);
    const enabledOut = (await run([...ctl(t), "is-enabled", SYSTEMD_UNIT_NAME])).stdout.trim();
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
      ...(await pathFacts(parseSystemdExecStart(text))),
      reason: null,
    };
  }

  async function launchdStatus(t: Target): Promise<ServiceStatus> {
    const text = await readText(t.unitPath);
    if (text === null) return emptyStatus("launchd", t.account, null);
    const { loaded, running } = await launchdPrint();
    return {
      manager: "launchd",
      installed: true,
      enabled: loaded,
      active: running,
      linger: null,
      account: t.account,
      unitPath: display(t.unitPath),
      ...(await pathFacts(parseLaunchdProgramArguments(text))),
      reason: null,
    };
  }

  /** Last `n` lines of a file, reading at most the final megabyte. */
  async function tailFile(p: string, n: number): Promise<string[] | null> {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(at(p), "r");
      const { size } = await handle.stat();
      const length = Math.min(size, LOG_TAIL_READ_BYTES);
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, size - length);
      const text = buf.toString("utf8").replace(/\n$/, "");
      return text ? text.split("\n").slice(-n) : [];
    } catch {
      return null;
    } finally {
      await handle?.close();
    }
  }

  return {
    detect,

    async install(opts = {}) {
      try {
        return await installTarget(await resolveInstallTarget(opts));
      } catch (err) {
        if (err instanceof ServiceError) return { ok: false, error: err.message, lines: [] };
        throw err;
      }
    },

    async uninstall(opts = {}) {
      const t = await resolveExistingTarget(opts);
      if (!(await exists(t.unitPath))) return { ok: true, lines: [`${unitName(t)} is not installed`] };
      if (t.kind === "systemd-system") {
        return {
          ok: false,
          error: "a system unit is removed by root: run the lines above as root",
          lines: [
            `sudo systemctl disable --now ${SYSTEMD_UNIT_NAME}`,
            `sudo rm ${SYSTEM_UNIT_PATH}`,
            "sudo systemctl daemon-reload",
          ],
        };
      }
      const lines = [`Removed ${display(t.unitPath)}`];
      if (t.kind === "launchd") {
        await run(["launchctl", "bootout", launchdService()]);
        await rm(at(t.unitPath), { force: true });
        return { ok: true, lines };
      }
      const disable = await run([...ctl(t), "disable", "--now", SYSTEMD_UNIT_NAME]);
      await rm(at(t.unitPath), { force: true });
      await run([...ctl(t), "daemon-reload"]);
      if (disable.code !== 0) lines.push(`systemctl disable reported: ${firstLine(disable)}`);
      return { ok: true, lines };
    },

    async status(opts = {}) {
      if (deps.platform !== "linux" && deps.platform !== "darwin") {
        const d = await detect();
        return emptyStatus(d.kind, deps.account, d.reason);
      }
      const t = await resolveExistingTarget(opts);
      if (t.kind === "launchd") return launchdStatus(t);
      const d = await detect({ system: t.kind === "systemd-system" });
      if (d.kind === "none") return emptyStatus("none", deps.account, d.reason);
      const s = await systemdStatus(t);
      if (!d.available) {
        return s.installed
          ? { ...s, enabled: null, active: null, linger: null, reason: d.reason }
          : { ...s, reason: d.reason };
      }
      return s;
    },

    async logs({ lines, follow, ...opts }) {
      const t = await resolveExistingTarget(opts);
      if (t.kind === "launchd") {
        if (follow) {
          const r = await run(["tail", "-n", String(lines), "-F", logFile(t)], { inherit: true });
          return r.code === 0 || r.code === null ? 0 : 1;
        }
        const tail = await tailFile(logFile(t), lines);
        if (tail === null) {
          deps.out(`no log yet at ${display(logFile(t))}`);
          return 0;
        }
        for (const line of tail) deps.out(line);
        return 0;
      }
      const argv = [
        ...journal(t),
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
          error: `${unitName(t)} is not installed: run \`ocw-runtime service install\``,
          lines: [],
        };
      }
      if (t.kind === "systemd-system") {
        return {
          ok: false,
          error: `a system unit is restarted by root: \`sudo systemctl restart ${SYSTEMD_UNIT_NAME}\``,
          lines: [],
        };
      }
      try {
        if (t.kind === "launchd") {
          await run(["launchctl", "bootout", launchdService()]);
          await rotateLog(t);
          await bootstrap(t);
        } else {
          const r = await run([...ctl(t), "restart", SYSTEMD_UNIT_NAME]);
          if (r.code !== 0) return { ok: false, error: `restart failed: ${firstLine(r)}`, lines: [] };
        }
      } catch (err) {
        if (err instanceof ServiceError) return { ok: false, error: err.message, lines: [] };
        throw err;
      }
      return { ok: true, lines: [`Restarted ${unitName(t)}`] };
    },
  };
}

const USAGE = [
  "usage: ocw-runtime service <command>",
  "  install [--system [--user-name <account>]] install and start the runtime service; --system prints the",
  "                                             system unit and the commands root runs (run it as the account)",
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
  if (deps.uid === 0) return fail(ROOT_REFUSAL);
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
        r.outcome === "root-step"
          ? "run the lines above as root"
          : r.outcome === "unchanged"
            ? "already installed and running"
            : r.active
              ? "running"
              : "installed";
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
