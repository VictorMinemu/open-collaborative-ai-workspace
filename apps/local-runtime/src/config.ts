// Daemon configuration (~/.ocw/runtime.json), device token and the local project registry
// (~/.ocw/projects.json). Absolute project paths live ONLY in the registry on this device.

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import type { DeviceProjectAnnouncement } from "@ocw/contracts";
import { z } from "zod";
import { isGitRepo, repoInfo } from "./git.js";

export function ocwHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.OCW_HOME ? resolve(env.OCW_HOME) : join(homedir(), ".ocw");
}

export const RuntimeConfigSchema = z.object({
  serverUrl: z.string().url().default("http://localhost:4000"),
  /** File holding the device token. Defaults to `<OCW_HOME>/device-token`. */
  deviceTokenPath: z.string().optional(),
  deviceName: z.string().optional(),
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
  await ensureOcwHome(home);
  const file = join(home, "runtime.json");
  const raw = (await readJson(file)) ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("cannot update runtime.json: it is not a JSON object");
  }
  const current = raw as Record<string, unknown>;
  const previous =
    typeof current.fullAccess === "object" && current.fullAccess !== null ? current.fullAccess : {};
  await writeJsonAtomic(file, { ...current, fullAccess: { ...previous, optIn: on } });
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
    return this.projects.map(({ localId, name, gitRemote, defaultBranch }) => ({
      localId,
      name,
      gitRemote,
      defaultBranch,
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
      addedAt: new Date().toISOString(),
    };
    this.projects.push(project);
    await this.save();
    return project;
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
