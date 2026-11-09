// Daemon configuration (~/.ocw/runtime.json), device token and the local project registry
// (~/.ocw/projects.json). Absolute project paths live ONLY in the registry on this device.

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  DeviceHostKind,
  type DeviceProjectAnnouncement,
  RuntimeUpdatesLevel,
  type RuntimeUpdatesLevelSource,
} from "@ocw/contracts";
import { z } from "zod";
import { isGitRepo, repoInfo } from "./git.js";
import { installedBundlePath, installInfoPath } from "./install-info.js";

export function ocwHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.OCW_HOME ? resolve(env.OCW_HOME) : join(homedir(), ".ocw");
}

export const RuntimeConfigSchema = z.object({
  serverUrl: z.string().url().default("http://localhost:4000"),
  /** File holding the device token. Defaults to `<OCW_HOME>/device-token`. */
  deviceTokenPath: z.string().optional(),
  deviceName: z.string().optional(),
  /**
   * Phase 07.12 (D-06, PD-09): the paired device's id, written at pairing (typed code or device code) from the API's
   * answer; read by `setup` and `doctor` to say which device this is. Local only; absent before 07.12.
   */
  deviceId: z.uuid().optional(),
  /**
   * Phase 07.12 (D-06, PD-09): the workspace's web origin from the pairing answer, so `setup` and `doctor` can print
   * `<webUrl>/settings/devices` (sharing stays in the web). Local only; absent before 07.12 or from an older API.
   */
  webUrl: z.url().optional(),
  /**
   * Phase 07.12 (D-06, PD-09, RESEARCH Pitfall 3): whom this device was paired with, so a server admin sees who owns it
   * ("Paired with <organization> as <owner>"). Written at pairing, read by `setup` and `doctor`. Local only.
   */
  pairedWith: z
    .object({ organization: z.string().max(200), owner: z.string().max(200), at: z.string() })
    .optional(),
  /**
   * Runtimes run on the user's own CLI logins (Claude Pro/Max, ChatGPT). API keys in the
   * environment are stripped unless `useApiKey` is explicitly true (metered billing).
   */
  claude: z
    .object({ path: z.string().optional(), useApiKey: z.boolean().default(false) })
    .default({ useApiKey: false }),
  codex: z
    .object({ path: z.string().optional(), useApiKey: z.boolean().default(false) })
    .default({ useApiKey: false }),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /**
   * ADR-0012 / P-12: the device owner's LOCAL Full access opt-in (default off). Set only on this device: the desktop
   * Runtime menu, `ocw-runtime full-access on|off`, or `OCW_ALLOW_FULL_ACCESS` for a headless daemon. Never by the
   * server or the web.
   */
  fullAccess: z.object({ optIn: z.boolean().default(false) }).default({ optIn: false }),
  /**
   * Phase 07.11 (D-02): this device's own runtime CLI updates level (default `automatic`). Set only on this device:
   * the desktop app's menu, `ocw-runtime updates automatic|notify|off`, or `OCW_RUNTIME_UPDATES` for a headless daemon.
   * It can only lower the organization's level (the effective level is the lower of the two), never raise it.
   */
  runtimeUpdates: z
    .object({ level: RuntimeUpdatesLevel.default("automatic") })
    .default({ level: "automatic" }),
  /**
   * Phase 07.16 (D-19): the device owner's LOCAL isolated-server mark (default off): bots that read outside content may
   * run Full access sessions here. Honoured by the server only for headless service daemons (`resolveHostKind`); set
   * only on this device (`ocw-runtime isolated-server on|off`, or `OCW_ISOLATED_SERVER`), never by the server or the web.
   */
  isolatedServer: z.object({ on: z.boolean().default(false) }).default({ on: false }),
});
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

/** Where the effective Full access opt-in comes from: the environment wins over runtime.json. */
export type FullAccessSource = "env" | "config";

/**
 * The effective opt-in. `OCW_ALLOW_FULL_ACCESS` = "1"/"true" → on, "0"/"false" → off (headless servers, or to force
 * it off whatever the file says); any other value is ignored and runtime.json decides.
 */
export function resolveFullAccess(
  config: Pick<RuntimeConfig, "fullAccess">,
  env: NodeJS.ProcessEnv = process.env,
): { optIn: boolean; source: FullAccessSource } {
  const raw = env.OCW_ALLOW_FULL_ACCESS?.trim().toLowerCase();
  if (raw === "1" || raw === "true") return { optIn: true, source: "env" };
  if (raw === "0" || raw === "false") return { optIn: false, source: "env" };
  return { optIn: config.fullAccess?.optIn === true, source: "config" };
}

/**
 * Phase 07.11 (D-02): the device's runtime updates level. `OCW_RUNTIME_UPDATES` = `automatic` | `notify` | `off` wins
 * (headless servers); any other value is ignored and runtime.json decides (default `automatic`).
 */
export function resolveRuntimeUpdates(
  config: Partial<Pick<RuntimeConfig, "runtimeUpdates">>,
  env: NodeJS.ProcessEnv = process.env,
): { level: RuntimeUpdatesLevel; source: RuntimeUpdatesLevelSource } {
  const fromEnv = RuntimeUpdatesLevel.safeParse(env.OCW_RUNTIME_UPDATES?.trim().toLowerCase());
  if (fromEnv.success) return { level: fromEnv.data, source: "env" };
  return { level: config.runtimeUpdates?.level ?? "automatic", source: "config" };
}

/** Where the effective isolated-server mark comes from: the environment wins over runtime.json. */
export type IsolatedServerSource = "env" | "config";

/**
 * Phase 07.16 (D-19): the effective isolated-server mark. `OCW_ISOLATED_SERVER` = "1"/"true" → on, "0"/"false" → off;
 * any other value is ignored and runtime.json decides (default off). Like `resolveFullAccess`.
 */
export function resolveIsolatedServer(
  config: Partial<Pick<RuntimeConfig, "isolatedServer">>,
  env: NodeJS.ProcessEnv = process.env,
): { on: boolean; source: IsolatedServerSource } {
  const raw = env.OCW_ISOLATED_SERVER?.trim().toLowerCase();
  if (raw === "1" || raw === "true") return { on: true, source: "env" };
  if (raw === "0" || raw === "false") return { on: false, source: "env" };
  return { on: config.isolatedServer?.on === true, source: "config" };
}

/**
 * Phase 07.16 (PD-18): how this daemon runs. `OCW_RUNTIME_HOST` = `desktop` | `service` decides (the desktop app's
 * launcher sets `desktop`; the systemd and launchd units set `service`); otherwise `service` when `install.sh`'s record
 * (`<home>/runtime/install.json`) exists and `entry` (the running script) is the installed bundle; otherwise unknown
 * (null). Both paths are compared on this device only: only the answer is reported to the server.
 */
export async function resolveHostKind(p: {
  env: NodeJS.ProcessEnv;
  home: string;
  entry: string | undefined;
}): Promise<DeviceHostKind | null> {
  const fromEnv = DeviceHostKind.safeParse(p.env.OCW_RUNTIME_HOST?.trim().toLowerCase());
  if (fromEnv.success) return fromEnv.data;
  if (!p.entry) return null;
  try {
    await stat(installInfoPath(p.home));
  } catch {
    return null;
  }
  const real = (path: string) => realpath(path).catch(() => resolve(path));
  const [entry, bundle] = await Promise.all([real(p.entry), real(installedBundlePath(p.home))]);
  return entry === bundle ? "service" : null;
}

export function fullAccessOptIn(
  config: Pick<RuntimeConfig, "fullAccess">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveFullAccess(config, env).optIn;
}

/**
 * Writes `fullAccess.optIn` into `<home>/runtime.json` (atomic, 0600), keeping every other key. A malformed file is
 * never overwritten (the error is surfaced). Only local callers use this (CLI, tests); the desktop app has its own
 * writer for the same file. A running daemon picks the change up on `reloadConfig`.
 */
export async function setFullAccessOptIn(home: string, on: boolean): Promise<void> {
  await patchRuntimeJsonSection(home, "fullAccess", { optIn: on });
}

/**
 * Phase 07.11 (D-02): writes `runtimeUpdates.level` into `<home>/runtime.json` (atomic, 0600), keeping every other key,
 * exactly like `setFullAccessOptIn`. Local callers only (CLI, tests; the desktop app has its own writer). A running
 * daemon applies it on the value-less `reloadConfig`; `OCW_RUNTIME_UPDATES` still wins.
 */
export async function setRuntimeUpdatesLevel(home: string, level: RuntimeUpdatesLevel): Promise<void> {
  await patchRuntimeJsonSection(home, "runtimeUpdates", { level: RuntimeUpdatesLevel.parse(level) });
}

/**
 * Phase 07.16 (D-19): writes `isolatedServer.on` into `<home>/runtime.json` (atomic, 0600), keeping every other key,
 * exactly like `setFullAccessOptIn`. Local callers only (the CLI, tests). A running daemon applies it on the value-less
 * `reloadConfig`; `OCW_ISOLATED_SERVER` still wins.
 */
export async function setIsolatedServer(home: string, on: boolean): Promise<void> {
  await patchRuntimeJsonSection(home, "isolatedServer", { on });
}

/** Merges `patch` into one object section of runtime.json; a malformed file is never overwritten. */
async function patchRuntimeJsonSection(
  home: string,
  section: "fullAccess" | "runtimeUpdates" | "isolatedServer",
  patch: Record<string, unknown>,
): Promise<void> {
  await ensureOcwHome(home);
  const file = join(home, "runtime.json");
  const raw = (await readJson(file)) ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("cannot update runtime.json: it is not a JSON object");
  }
  const current = raw as Record<string, unknown>;
  const previous = current[section];
  const kept = typeof previous === "object" && previous !== null && !Array.isArray(previous) ? previous : {};
  await writeJsonAtomic(file, { ...current, [section]: { ...kept, ...patch } });
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read ${basename(path)}: ${(err as Error).message}`);
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export async function ensureOcwHome(home: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700).catch(() => undefined);
}

export async function loadConfig(home: string, env: NodeJS.ProcessEnv = process.env): Promise<RuntimeConfig> {
  const raw = (await readJson(join(home, "runtime.json"))) ?? {};
  const merged = { ...(raw as Record<string, unknown>) };
  if (env.OCW_SERVER_URL) merged.serverUrl = env.OCW_SERVER_URL;
  if (env.OCW_LOG_LEVEL) merged.logLevel = env.OCW_LOG_LEVEL;
  return RuntimeConfigSchema.parse(merged);
}

/**
 * Device token from `OCW_DEVICE_TOKEN` (removed from process.env after reading so no child
 * process inherits it) or from the token file. Never logged.
 */
export async function loadDeviceToken(
  home: string,
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const fromEnv = env.OCW_DEVICE_TOKEN?.trim();
  if (fromEnv) {
    delete env.OCW_DEVICE_TOKEN;
    return fromEnv;
  }
  const file = env.OCW_DEVICE_TOKEN_FILE ?? config.deviceTokenPath ?? join(home, "device-token");
  try {
    const token = (
      await readFile(file.startsWith("~/") ? join(homedir(), file.slice(2)) : file, "utf8")
    ).trim();
    return token || null;
  } catch {
    return null;
  }
}

export function deviceName(config: RuntimeConfig): string {
  return config.deviceName ?? hostname().replace(/\.local$/, "");
}

export function toWebSocketUrl(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : u.protocol === "http:" ? "ws:" : u.protocol;
  u.pathname = `${u.pathname.replace(/\/$/, "")}/runtime/ws`;
  u.search = "";
  u.hash = "";
  return u.toString();
}

// -----------------------------------------------------------------------------------------------
// Project registry
// -----------------------------------------------------------------------------------------------

export const LocalProjectSchema = z.object({
  localId: z.string(),
  path: z.string(), // absolute, device-local only
  name: z.string(),
  gitRemote: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  /** False when the folder is in no git repository (registered as it is). Absent on entries written before it. */
  git: z.boolean().optional(),
  addedAt: z.string(),
});
export type LocalProject = z.infer<typeof LocalProjectSchema>;

const RegistryFileSchema = z.object({ projects: z.array(LocalProjectSchema).default([]) });

export class ProjectRegistry {
  private projects: LocalProject[] = [];
  private readonly file: string;

  constructor(home: string) {
    this.file = join(home, "projects.json");
  }

  async load(): Promise<void> {
    const raw = await readJson(this.file);
    this.projects = raw === undefined ? [] : RegistryFileSchema.parse(raw).projects;
  }

  list(): LocalProject[] {
    return [...this.projects];
  }

  get(localId: string): LocalProject | undefined {
    return this.projects.find((p) => p.localId === localId);
  }

  /** What the server is allowed to see: no paths. */
  toSynced(): DeviceProjectAnnouncement[] {
    return this.projects.map(({ localId, name, gitRemote, defaultBranch, git }) => ({
      localId,
      name,
      gitRemote,
      defaultBranch,
      ...(git === undefined ? {} : { git }),
    }));
  }

  async add(path: string, name?: string): Promise<LocalProject> {
    const abs = await realpath(resolve(path)).catch(() => {
      throw new Error("path does not exist");
    });
    if (!(await stat(abs)).isDirectory()) throw new Error("path is not a directory");
    const existing = this.projects.find((p) => p.path === abs);
    if (existing) return existing;
    const info = (await isGitRepo(abs)) ? await repoInfo(abs) : null;
    const project: LocalProject = {
      localId: `lp_${randomUUID()}`,
      path: abs,
      name: name?.trim() || basename(abs),
      gitRemote: info?.remote ?? null,
      defaultBranch: info?.defaultBranch ?? null,
      // A folder without git is a valid project (the Work Zone works without it); nothing is created in it.
      git: info !== null,
      addedAt: new Date().toISOString(),
    };
    this.projects.push(project);
    await this.save();
    return project;
  }

  /**
   * Phase 07.12 (D-07): the project `ref` names, as `remove-project` takes it. In order: an exact `localId`; a directory
   * (`ref` contains `/` or starts with `.` or `~`; `~/` expands against the user's home) matched by its real path, or by
   * the plain resolved path when the directory no longer exists; else a name that exactly one project has. An ambiguous
   * name or no match throws, listing the candidates (or every registered project) by name and id.
   */
  async resolveRef(ref: string, opts: { cwd?: string; userHome?: string } = {}): Promise<LocalProject> {
    const byId = this.get(ref);
    if (byId) return byId;
    const label = (p: LocalProject) => `${p.name} (${p.localId})`;
    const noMatch = () =>
      new Error(
        this.projects.length === 0
          ? `no registered project matches "${ref}"; none are registered`
          : `no registered project matches "${ref}"; registered: ${this.projects.map(label).join(", ")}`,
      );
    if (ref.includes("/") || ref.startsWith(".") || ref.startsWith("~")) {
      const expanded =
        ref === "~" || ref.startsWith("~/") ? join(opts.userHome ?? homedir(), ref.slice(1)) : ref;
      const abs = resolve(opts.cwd ?? process.cwd(), expanded);
      const real = await realpath(abs).catch(() => abs);
      const match = this.projects.find((p) => p.path === real) ?? this.projects.find((p) => p.path === abs);
      if (match) return match;
      throw noMatch();
    }
    const named = this.projects.filter((p) => p.name === ref);
    if (named.length === 1 && named[0]) return named[0];
    if (named.length > 1)
      throw new Error(`ambiguous: ${named.map(label).join(", ")}; use the id or the directory`);
    throw noMatch();
  }

  async remove(localId: string): Promise<boolean> {
    const before = this.projects.length;
    this.projects = this.projects.filter((p) => p.localId !== localId);
    if (this.projects.length === before) return false;
    await this.save();
    return true;
  }

  private async save(): Promise<void> {
    await writeJsonAtomic(this.file, { projects: this.projects });
  }
}
