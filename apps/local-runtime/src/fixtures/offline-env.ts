// Offline recorder environment (07.13-04, PD-29). The 07.13 fixture recorders never read the caller's runtime homes,
// logins or keys: every child they spawn gets HOME, CODEX_HOME, CLAUDE_CONFIG_DIR, the XDG dirs and TMPDIR inside a
// fresh temp dir, the only model endpoint is the repo's fake model server (infra/fake-model) on loopback, and the only
// credentials are fake values that server accepts. Nothing from the caller's environment passes except a short
// allowlist of process basics (PATH, locale, terminal, user name).

import { mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** The only credentials a recorder child sees (the fake model accepts any bearer). */
export const OFFLINE_FAKE_ANTHROPIC_KEY = "ocw-fake-key";
export const OFFLINE_FAKE_MODEL_KEY = "fake";

/** Caller variables a recorder child may inherit; everything else (keys, tokens, runtime homes) is dropped. */
const INHERITED = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "USER",
  "LOGNAME",
  "SHELL",
  // Windows process basics.
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
] as const;

/** Credentials that must never reach a recorder child, whatever the allowlist says. */
const FORBIDDEN = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/** The variables that hold a directory inside the recorder's temp dir. */
export const OFFLINE_DIR_KEYS = [
  "HOME",
  "USERPROFILE",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "TMPDIR",
] as const;

export type OfflineEnv = Record<string, string>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** True when `url` is an http(s) URL on a loopback host. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

function inside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The caller's home directories as the caller's env names them (never `os.homedir()`). */
function callerHomes(env: NodeJS.ProcessEnv): string[] {
  return [env.HOME, env.USERPROFILE].filter((h): h is string => typeof h === "string" && h.length > 0);
}

export interface OfflineRecorderEnvOptions {
  /** The caller's environment (only the allowlist passes). */
  env: NodeJS.ProcessEnv;
  /** A fresh temp dir; must not be inside the caller's home. */
  tmp: string;
  /** The fake model server's origin, e.g. `http://127.0.0.1:41234` (loopback only). */
  fakeUrl: string;
}

/**
 * The environment of a recorder child: temp HOME, CODEX_HOME, CLAUDE_CONFIG_DIR, XDG dirs and TMPDIR under `tmp`,
 * the caller's keys dropped, fake credentials only, every provider URL on `fakeUrl`. Throws when `fakeUrl` is not
 * loopback or `tmp` is inside the caller's home. Pure: `makeOfflineDirs` creates the directories.
 */
export function offlineRecorderEnv({ env, tmp, fakeUrl }: OfflineRecorderEnvOptions): OfflineEnv {
  if (!isLoopbackUrl(fakeUrl)) {
    throw new Error("offline recorder: the fake model URL must be http(s) on a loopback host");
  }
  if (!isAbsolute(tmp)) throw new Error("offline recorder: the temp dir must be an absolute path");
  for (const home of callerHomes(env)) {
    if (inside(tmp, home)) throw new Error("offline recorder: the temp dir is inside the caller's home");
  }
  const origin = new URL(fakeUrl).origin;
  const out: OfflineEnv = {};
  for (const key of INHERITED) {
    const value = env[key];
    if (typeof value === "string") out[key] = value;
  }
  const home = join(tmp, "home");
  Object.assign(out, {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(tmp, "codex-home"),
    CLAUDE_CONFIG_DIR: join(tmp, "claude-config"),
    XDG_CONFIG_HOME: join(tmp, "xdg", "config"),
    XDG_DATA_HOME: join(tmp, "xdg", "data"),
    XDG_CACHE_HOME: join(tmp, "xdg", "cache"),
    XDG_STATE_HOME: join(tmp, "xdg", "state"),
    TMPDIR: join(tmp, "tmp"),
    ANTHROPIC_API_KEY: OFFLINE_FAKE_ANTHROPIC_KEY,
    ANTHROPIC_BASE_URL: origin,
    OPENAI_BASE_URL: `${origin}/v1`,
    OCW_FAKE_MODEL_URL: origin,
    OCW_FAKE_MODEL_KEY: OFFLINE_FAKE_MODEL_KEY,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    NO_COLOR: "1",
  });
  assertOffline(out, env);
  return out;
}

/**
 * Throws unless `env` is an offline recorder env: every dir key set, absolute and outside the caller's home, no real
 * credential, fake keys only, every provider URL on loopback.
 */
export function assertOffline(env: Record<string, string | undefined>, caller: NodeJS.ProcessEnv = {}): void {
  const homes = callerHomes(caller);
  for (const key of OFFLINE_DIR_KEYS) {
    const dir = env[key];
    if (!dir || !isAbsolute(dir)) throw new Error(`offline recorder: ${key} is not an absolute temp path`);
    if (homes.some((h) => inside(dir, h)))
      throw new Error(`offline recorder: ${key} is inside the caller's home`);
  }
  for (const key of FORBIDDEN) {
    if (env[key] !== undefined) throw new Error(`offline recorder: ${key} must not reach a recorder child`);
  }
  if (env.ANTHROPIC_API_KEY !== OFFLINE_FAKE_ANTHROPIC_KEY) {
    throw new Error("offline recorder: ANTHROPIC_API_KEY must be the fake key");
  }
  for (const key of ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "OCW_FAKE_MODEL_URL"]) {
    const url = env[key];
    if (!url || !isLoopbackUrl(url)) throw new Error(`offline recorder: ${key} is not a loopback URL`);
  }
}

/** Creates every directory of an offline env (0700). */
export function makeOfflineDirs(env: OfflineEnv): void {
  for (const key of OFFLINE_DIR_KEYS) mkdirSync(env[key] as string, { recursive: true, mode: 0o700 });
}

/** The env as `--print-env` shows it: PATH is inherited and not printed. */
export function printableOfflineEnv(env: OfflineEnv): OfflineEnv {
  const { PATH: _path, ...rest } = env;
  return rest;
}
