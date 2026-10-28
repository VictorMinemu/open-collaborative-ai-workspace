// Phase 07.11 (runtime CLI auto-updates, D-01, D-05, D-08, PD-09): how each runtime CLI was installed on this device
// and the one command that updates it, from one fixed on-device table. The server never names a command, a prefix
// or a version (D-05); a non-writable install is reported `needs_admin` and never run (D-08).
//
// No host path leaves the device (AGENTS principle 7): `binPath`, `realPath`, `installRoot`, `codexHome`, `prefix`
// and `managerPath` are absolute and device-only; `display` comes from path-free templates and `location` is
// `~`-relative or null. `publicInstallFields` is the only view that may leave the device.

import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join, relative, sep } from "node:path";
import {
  DisplayCommand,
  HomeRelativeLocation,
  type InstallMethod,
  type RuntimeId,
  RuntimeVersion,
  type UpdateBlockReason,
  type UpdateChannel,
} from "@ocw/contracts";
import { findExecutable } from "../exec-path.js";
import { channelFor } from "./registry.js";

/** The npm package of each runtime CLI: constants, never from the server. */
export const RUNTIME_PACKAGES: Readonly<Record<RuntimeId, string>> = {
  "claude-code": "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};

/** The executable each runtime is found by. */
export const RUNTIME_BINARIES: Readonly<Record<RuntimeId, string>> = {
  "claude-code": "claude",
  codex: "codex",
};

/** Homebrew casks and formulae per runtime (`claude-code` follows stable, `claude-code@latest` latest). */
const BREW_NAMES: Readonly<Record<RuntimeId, readonly string[]>> = {
  "claude-code": ["claude-code@latest", "claude-code"],
  codex: ["codex"],
};

export type SystemPackageManager = "apt" | "dnf" | "apk";

/** The system package's commands for Claude Code (RESEARCH § Install methods); Codex has no system package. */
const SYSTEM_TEMPLATES: Readonly<Record<SystemPackageManager, { user: string; admin: string }>> = {
  apt: {
    user: "apt update && apt upgrade claude-code",
    admin: "sudo apt update && sudo apt upgrade claude-code",
  },
  dnf: { user: "dnf upgrade claude-code", admin: "sudo dnf upgrade claude-code" },
  apk: {
    user: "apk update && apk upgrade claude-code",
    admin: "sudo apk update && sudo apk upgrade claude-code",
  },
};

/** Root-owned trees a system package lives in (Homebrew and `/usr/local` are excluded where matched). */
const DEFAULT_SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/opt", "/snap"];
const NOT_SYSTEM = ["/usr/local/", "/opt/homebrew/"];

export interface InstallResolution {
  runtime: RuntimeId;
  method: InstallMethod;
  /** The binary as found (configured path or PATH lookup); device-only. */
  binPath: string | null;
  /** Its realpath; device-only. */
  realPath: string | null;
  /** What the method writes (and the lock key): `~/.local/share/claude`, the npm prefix, …; device-only. */
  installRoot: string | null;
  /** The binary's directory as `~/…` when under the daemon user's home, else null. */
  location: HomeRelativeLocation | null;
  canUpdate: boolean;
  reason: UpdateBlockReason | null;
  /** The command people can read; path-free by construction (`claude update`, `sudo npm install -g …`). */
  display: DisplayCommand | null;
  /** One short path-free sentence for the cases the device does not run ("Update it with the tool that installed it"). */
  note: string | null;
  channel: UpdateChannel;
  /** Codex standalone: the detected `CODEX_HOME`; device-only. */
  codexHome?: string;
  /** The package manager inside the install's own prefix (`<prefix>/bin/npm`, `<brew>/bin/brew`); device-only. */
  managerPath?: string;
  /** npm: the global prefix; Homebrew: the brew prefix; device-only. */
  prefix?: string;
  /** Homebrew: the cask or formula name (`claude-code`, `claude-code@latest`, `codex`). */
  brewName?: string;
}

/** The fields that may leave the device (07 maps them into `RuntimeMaintenanceStatus`). */
export function publicInstallFields(r: InstallResolution): {
  method: InstallMethod;
  location: HomeRelativeLocation | null;
  canUpdate: boolean;
  reason: UpdateBlockReason | null;
  display: DisplayCommand | null;
  note: string | null;
  channel: UpdateChannel;
} {
  return {
    method: r.method,
    location: r.location,
    canUpdate: r.canUpdate,
    reason: r.reason,
    display: r.display,
    note: r.note,
    channel: r.channel,
  };
}

export interface ResolveOptions {
  /** The daemon user's home (`os.homedir()` in production; a temp home in tests). */
  home: string;
  env: NodeJS.ProcessEnv;
  /** `config.<runtime>.path`, when the owner pinned one. */
  configuredPath?: string;
  /** PATH lookup, called fresh on every resolution (Pitfall 11). Default `findExecutable(name, env)`. */
  which?: (name: string) => string | null;
  platform?: NodeJS.Platform;
  /** Root-owned trees a system package installs into (tests pass a temp directory). */
  systemDirs?: readonly string[];
  /** The OS package manager; default detected from `/usr/bin/apt-get`, `/usr/bin/dnf`, `/sbin/apk`. */
  systemPackageManager?: SystemPackageManager | null;
}

export const NOTE_MANUAL = "Update it with the tool that installed it";
export const NOTE_SDK_BUNDLED = "Updates with the OCW runtime";
export const NOTE_NEEDS_ADMIN = "Needs an administrator: this install is not writable by the device's user";
export const NOTE_DISABLED = "Updates are turned off for Claude Code on this device (DISABLE_UPDATES)";
export const NOTE_NOT_INSTALLED = "Not installed";

function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function writable(p: string): boolean {
  try {
    accessSync(p, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function executable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truthy(value: unknown): boolean {
  if (typeof value !== "string") return value === true || value === 1;
  const v = value.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

/** `DISABLE_UPDATES` in the daemon's env or in `~/.claude/settings.json` `env` (Claude Code blocks every update). */
function claudeUpdatesDisabled(env: NodeJS.ProcessEnv, home: string): boolean {
  if (truthy(env.DISABLE_UPDATES)) return true;
  try {
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as unknown;
    const settingsEnv = (settings as { env?: Record<string, unknown> } | null)?.env;
    return truthy(settingsEnv?.DISABLE_UPDATES);
  } catch {
    return false;
  }
}

function detectSystemPackageManager(): SystemPackageManager | null {
  if (executable("/usr/bin/apt-get")) return "apt";
  if (executable("/usr/bin/dnf")) return "dnf";
  if (executable("/sbin/apk") || executable("/usr/sbin/apk")) return "apk";
  return null;
}

/** `dir` as `~` or `~/…` when it is inside `home` (or its realpath), else null. */
function homeRelative(dir: string, homes: readonly string[]): HomeRelativeLocation | null {
  for (const h of homes) {
    const rel = relative(h, dir);
    if (rel.startsWith("..") || rel.startsWith(sep) || /^[A-Za-z]:/.test(rel)) continue;
    const location = rel === "" ? "~" : `~/${rel.split(sep).join("/")}`;
    const parsed = HomeRelativeLocation.safeParse(location);
    return parsed.success ? parsed.data : null;
  }
  return null;
}

function display(text: string | null): DisplayCommand | null {
  if (text === null) return null;
  const parsed = DisplayCommand.safeParse(text);
  return parsed.success ? parsed.data : null;
}

/** What one row of the table found: the method and what an update writes. */
interface Match {
  method: InstallMethod;
  installRoot: string | null;
  /** Directories the update writes; when any is not writable the install is `needs_admin`. Empty = not checked. */
  writes: string[];
  /** The path-free command a person (or the device) runs, or null. */
  template: string | null;
  /** The path-free command when the install needs an administrator (default `sudo <template>`). */
  adminTemplate?: string | null;
  /** True for the methods the device runs itself when writable (PD-09). */
  updatable: boolean;
  codexHome?: string;
  managerPath?: string;
  prefix?: string;
  brewName?: string;
}

interface MatchContext {
  env: NodeJS.ProcessEnv;
  systemDirs: readonly string[];
  systemPackageManager: () => SystemPackageManager | null;
}

function manual(method: InstallMethod, template: string | null = null): Match {
  return { method, installRoot: null, writes: [], template, updatable: false };
}

/**
 * The fixed table (PD-09), first match wins: native and standalone first, then the package managers whose trees
 * also contain `lib/node_modules` (Volta, mise, asdf) or are their own (pnpm, bun, yarn), then the npm global prefix,
 * Homebrew, system packages, a project's `node_modules`, unknown.
 */
function matchInstall(runtime: RuntimeId, binPath: string, realPath: string, ctx: MatchContext): Match {
  const pkg = RUNTIME_PACKAGES[runtime];
  const pkgRe = escapeRegExp(pkg);
  const paths = `${binPath}\n${realPath}`;

  if (runtime === "claude-code") {
    const native = /^(.*)\/\.local\/share\/claude\/versions\/[^/]+$/.exec(realPath);
    if (native) {
      const root = join(native[1] ?? "", ".local", "share", "claude");
      return {
        method: "native",
        installRoot: root,
        writes: [root, dirname(binPath)],
        template: "claude update",
        updatable: true,
      };
    }
  }

  if (runtime === "codex") {
    const standalone = /^(.*)\/packages\/standalone\/releases\/[^/]+\//.exec(realPath);
    if (standalone) {
      const codexHome = standalone[1] ?? "";
      const root = join(codexHome, "packages", "standalone");
      return {
        method: "codex_standalone",
        installRoot: root,
        writes: [root, dirname(binPath)],
        template: "codex update",
        updatable: true,
        codexHome,
      };
    }
  }

  // Package managers the device recognises but leaves to their owner (RESEARCH A3: their update commands are not
  // proven on fake trees, so they are shown, never run).
  if (/\/volta-shim$/.test(realPath) || /\/\.volta\/tools\/image\/packages\//.test(realPath)) {
    return manual("volta", `volta install ${pkg}@latest`);
  }
  const pnpmHome = ctx.env.PNPM_HOME?.replace(/\/+$/, "");
  if (/\/pnpm\/global\/\d+\//.test(realPath) || (pnpmHome && dirname(binPath) === pnpmHome)) {
    return manual("pnpm", `pnpm add -g ${pkg}@latest`);
  }
  if (/\/\.bun\/install\/global\/node_modules\//.test(realPath))
    return manual("bun", `bun add -g ${pkg}@latest`);
  if (/\/yarn\/global\/node_modules\//i.test(realPath) || /\/Yarn\/Data\/global\//.test(realPath)) {
    return manual("yarn", `yarn global add ${pkg}@latest`);
  }
  if (/\/mise\/(?:installs|shims)\//.test(paths) || /\/mise$/.test(realPath)) return manual("mise");
  if (/\/\.asdf\//.test(paths)) return manual("asdf");

  // npm global prefix: `<prefix>/lib/node_modules/<pkg>/…`, updated by the npm inside that prefix (Pitfall 4).
  const npm = new RegExp(`^(.*)/lib/node_modules/${pkgRe}/`).exec(realPath);
  if (npm) {
    const prefix = npm[1] || "/";
    const managerPath = join(prefix, "bin", "npm");
    if (executable(managerPath)) {
      return {
        method: "npm",
        installRoot: prefix,
        writes: [join(prefix, "lib", "node_modules"), join(prefix, "bin")],
        template: `npm install -g ${pkg}@latest`,
        updatable: true,
        managerPath,
        prefix,
      };
    }
  }

  // Homebrew: the realpath is inside `<brew>/Caskroom/<name>/` or `<brew>/Cellar/<name>/` and `<brew>/bin/brew`
  // exists. Homebrew refuses to run as root, so its admin form is the same command for the user who owns it.
  for (const name of BREW_NAMES[runtime]) {
    for (const [tree, method] of [
      ["Caskroom", "homebrew_cask"],
      ["Cellar", "homebrew_formula"],
    ] as const) {
      const hit = new RegExp(`^(.*)/${tree}/${escapeRegExp(name)}/`).exec(realPath);
      if (!hit) continue;
      const brew = hit[1] || "/";
      const managerPath = join(brew, "bin", "brew");
      if (!executable(managerPath)) continue;
      const template = method === "homebrew_cask" ? `brew upgrade --cask ${name}` : `brew upgrade ${name}`;
      return {
        method,
        installRoot: brew,
        writes: [brew, join(brew, tree)],
        template,
        adminTemplate: template,
        updatable: true,
        managerPath,
        prefix: brew,
        brewName: name,
      };
    }
  }

  // A system package (apt/dnf/apk): shown, never run (D-08).
  const inSystem =
    !NOT_SYSTEM.some((p) => realPath.startsWith(p)) &&
    ctx.systemDirs.some((d) => realPath.startsWith(`${d.replace(/\/+$/, "")}/`));
  if (inSystem) {
    const manager = runtime === "claude-code" ? ctx.systemPackageManager() : null;
    const templates = manager ? SYSTEM_TEMPLATES[manager] : null;
    return {
      method: "system_package",
      installRoot: null,
      writes: [dirname(realPath)],
      template: templates?.user ?? null,
      adminTemplate: templates?.admin ?? null,
      updatable: false,
    };
  }

  if (/\/node_modules\//.test(paths)) return manual("project_local");
  return manual("unknown");
}

/**
 * How `runtime` is installed on this device (D-01, PD-09): the binary (configured path or a fresh PATH lookup) →
 * realpath → the first matching row of the fixed table → writability (`needs_admin`, D-08) → `DISABLE_UPDATES` →
 * the path-free display command.
 */
export function resolveInstall(runtime: RuntimeId, opts: ResolveOptions): InstallResolution {
  const { home, env } = opts;
  const homes = [...new Set([home, tryRealpath(home)].filter((h): h is string => !!h))];
  const base = (
    fields: Partial<InstallResolution> & Pick<InstallResolution, "method">,
  ): InstallResolution => {
    const r: InstallResolution = {
      runtime,
      binPath: null,
      realPath: null,
      installRoot: null,
      location: null,
      canUpdate: false,
      reason: null,
      display: null,
      note: null,
      channel: "latest",
      ...fields,
    };
    r.channel = channelFor(r, home);
    return r;
  };

  const which = opts.which ?? ((name: string) => findExecutable(name, env));
  const binPath = opts.configuredPath ?? which(RUNTIME_BINARIES[runtime]);
  const realPath = binPath ? tryRealpath(binPath) : null;
  if (!binPath || !realPath) {
    return runtime === "claude-code"
      ? base({ method: "sdk_bundled", reason: "manual", note: NOTE_SDK_BUNDLED })
      : base({ method: "not_installed", reason: "not_installed", note: NOTE_NOT_INSTALLED });
  }

  const found = { binPath, realPath, location: homeRelative(dirname(binPath), homes) };
  if ((opts.platform ?? process.platform) === "win32") {
    return base({ method: "windows", ...found, reason: "manual", note: NOTE_MANUAL });
  }

  let detected: SystemPackageManager | null | undefined = opts.systemPackageManager;
  const m = matchInstall(runtime, binPath, realPath, {
    env,
    systemDirs: (opts.systemDirs ?? DEFAULT_SYSTEM_DIRS).map((d) => tryRealpath(d) ?? d),
    systemPackageManager: () => {
      if (detected === undefined) detected = detectSystemPackageManager();
      return detected;
    },
  });
  const extras = {
    installRoot: m.installRoot,
    ...(m.codexHome ? { codexHome: m.codexHome } : {}),
    ...(m.managerPath ? { managerPath: m.managerPath } : {}),
    ...(m.prefix ? { prefix: m.prefix } : {}),
    ...(m.brewName ? { brewName: m.brewName } : {}),
  };
  const disabled = runtime === "claude-code" && claudeUpdatesDisabled(env, home);

  if (m.writes.length > 0 && !m.writes.every(writable)) {
    const adminTemplate =
      m.adminTemplate === undefined ? (m.template ? `sudo ${m.template}` : null) : m.adminTemplate;
    return base({
      method: m.method,
      ...found,
      ...extras,
      reason: disabled ? "updates_disabled" : "needs_admin",
      display: display(adminTemplate),
      note: disabled ? NOTE_DISABLED : NOTE_NEEDS_ADMIN,
    });
  }
  if (!m.updatable) {
    return base({
      method: m.method,
      ...found,
      ...extras,
      reason: "manual",
      display: display(m.template),
      note: NOTE_MANUAL,
    });
  }
  if (disabled) {
    return base({
      method: m.method,
      ...found,
      ...extras,
      reason: "updates_disabled",
      display: display(m.template),
      note: NOTE_DISABLED,
    });
  }
  return base({ method: m.method, ...found, ...extras, canUpdate: true, display: display(m.template) });
}

export interface UpdateCommand {
  file: string;
  args: string[];
  /** Variables the command needs on top of the runner's filtered environment (PATH, CODEX_HOME). */
  env: Record<string, string>;
}

/** `<dir>` first on PATH (npm and brew are `#!/usr/bin/env` scripts; a desktop-launched daemon lacks nvm, Pitfall 4). */
function pathWith(dir: string, baseEnv: NodeJS.ProcessEnv): string {
  return baseEnv.PATH ? `${dir}${delimiter}${baseEnv.PATH}` : dir;
}

/**
 * The one command that updates `resolution` to `candidate` (D-05), or null when the device will not run one: not
 * updatable (manual, needs admin, disabled) or a candidate that is not a plain `RuntimeVersion`. npm installs the
 * exact checked candidate, so the compatibility check binds (Pitfall 7).
 */
export function updateCommandFor(
  resolution: InstallResolution,
  candidate: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): UpdateCommand | null {
  if (!resolution.canUpdate || !resolution.binPath) return null;
  if (!RuntimeVersion.safeParse(candidate).success) return null;
  switch (resolution.method) {
    case "native":
      return { file: resolution.binPath, args: ["update"], env: {} };
    case "codex_standalone":
      if (!resolution.codexHome) return null;
      return { file: resolution.binPath, args: ["update"], env: { CODEX_HOME: resolution.codexHome } };
    case "npm": {
      if (!resolution.prefix || !resolution.managerPath) return null;
      return {
        file: resolution.managerPath,
        args: [
          "install",
          "-g",
          "--prefix",
          resolution.prefix,
          `${RUNTIME_PACKAGES[resolution.runtime]}@${candidate}`,
        ],
        env: { PATH: pathWith(join(resolution.prefix, "bin"), baseEnv) },
      };
    }
    case "homebrew_cask":
    case "homebrew_formula": {
      if (!resolution.prefix || !resolution.managerPath || !resolution.brewName) return null;
      const args =
        resolution.method === "homebrew_cask"
          ? ["upgrade", "--cask", resolution.brewName]
          : ["upgrade", resolution.brewName];
      return {
        file: resolution.managerPath,
        args,
        env: { PATH: pathWith(join(resolution.prefix, "bin"), baseEnv) },
      };
    }
    default:
      return null;
  }
}
