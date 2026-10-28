// Phase 07.11 (runtime CLI auto-updates, D-01, D-05, D-08, PD-09): how each runtime CLI was installed on this device
// and the one command that updates it, from one fixed on-device table. The server never names a command, a prefix
// or a version (D-05); a non-writable install is reported `needs_admin` and never run (D-08).
//
// No host path leaves the device (AGENTS principle 7): `binPath`, `realPath`, `installRoot` and `codexHome` are
// absolute and device-only; `display` comes from path-free templates and `location` is `~`-relative or null.

import { accessSync, constants, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
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
  /** One short path-free sentence for manual cases ("Update it with the tool that installed it"). */
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
  /** Directories the update writes; all must be writable or the install is `needs_admin`. */
  writes: string[];
  /** The path-free command template, or null when there is none. */
  template: string | null;
  /** True for methods the device runs itself when writable. */
  updatable: boolean;
  codexHome?: string;
  managerPath?: string;
  prefix?: string;
  brewName?: string;
}

/** The fixed table (PD-09), in order: native and standalone first, then global prefixes, Homebrew, manual. */
function matchInstall(runtime: RuntimeId, binPath: string, realPath: string): Match {
  const bin = RUNTIME_BINARIES[runtime];

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

  return {
    method: "unknown",
    installRoot: null,
    writes: [],
    template: null,
    updatable: false,
    brewName: bin,
  };
}

/**
 * How `runtime` is installed on this device (D-01, PD-09): the binary (configured path or a fresh PATH lookup) →
 * realpath → the first matching row of the fixed table → writability → the path-free display command.
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
  const m = matchInstall(runtime, binPath, realPath);
  const extras = {
    ...(m.codexHome ? { codexHome: m.codexHome } : {}),
    ...(m.managerPath ? { managerPath: m.managerPath } : {}),
    ...(m.prefix ? { prefix: m.prefix } : {}),
    ...(m.brewName && m.method.startsWith("homebrew") ? { brewName: m.brewName } : {}),
  };
  if (!m.updatable) {
    return base({
      method: m.method,
      ...found,
      installRoot: m.installRoot,
      reason: "manual",
      display: display(m.template),
      note: NOTE_MANUAL,
      ...extras,
    });
  }

  if (!m.writes.every(writable)) {
    return base({
      method: m.method,
      ...found,
      installRoot: m.installRoot,
      reason: "needs_admin",
      display: display(m.template ? `sudo ${m.template}` : null),
      note: NOTE_NEEDS_ADMIN,
      ...extras,
    });
  }

  return base({
    method: m.method,
    ...found,
    installRoot: m.installRoot,
    canUpdate: true,
    display: display(m.template),
    ...extras,
  });
}

export interface UpdateCommand {
  file: string;
  args: string[];
  /** Variables the command needs on top of the runner's filtered environment (PATH, CODEX_HOME). */
  env: Record<string, string>;
}

/**
 * The one command that updates `resolution` to `candidate` (D-05), or null when the device will not run one: not
 * updatable (manual, needs admin, disabled) or a candidate that is not a plain `RuntimeVersion`.
 */
export function updateCommandFor(resolution: InstallResolution, candidate: string): UpdateCommand | null {
  if (!resolution.canUpdate || !resolution.binPath) return null;
  if (!RuntimeVersion.safeParse(candidate).success) return null;
  switch (resolution.method) {
    case "native":
      return { file: resolution.binPath, args: ["update"], env: {} };
    case "codex_standalone":
      if (!resolution.codexHome) return null;
      return { file: resolution.binPath, args: ["update"], env: { CODEX_HOME: resolution.codexHome } };
    default:
      return null;
  }
}
