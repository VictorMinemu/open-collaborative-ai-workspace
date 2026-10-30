// `~/.ocw/service.env` (07.12, D-12, PD-10): the daemon's own environment file for service secrets such as
// `CLAUDE_CODE_OAUTH_TOKEN` on a headless server. `ocw-runtime run` reads it itself before anything else, so it works
// the same under systemd, launchd or by hand; the systemd unit and the launchd plist never reference it (D-04: no
// secret in a unit file). `ocw-runtime doctor` (07.12-05) shows the key names it set, never the values.
//
// Format: `NAME=value` lines (`NAME` matches ^[A-Z_][A-Z0-9_]*$), `#` comments and blank lines ignored, one pair of
// matching quotes stripped, no expansion; anything else is skipped and counted. `OCW_HOME` is never taken from it (the
// file lives inside OCW_HOME). A key already in the environment wins. The file is refused (nothing loaded, one error
// with the fix) unless it is owned by the running user and neither group- nor world-accessible (0600).

import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { Logger } from "./logger.js";
import type { ServiceEnvSummary } from "./service/types.js";

export const SERVICE_ENV_FILE = "service.env";

const NAME = /^[A-Z_][A-Z0-9_]*$/;
/** Never taken from the file: it decides where the file is. */
const RESERVED = new Set(["OCW_HOME"]);

export interface ServiceEnvDeps {
  /** The file's mode and owner (tests simulate another owner); defaults to `fstat` of the opened file. */
  stat?: (path: string) => Promise<{ mode: number; uid: number }>;
  /** The running user's uid; null where there is none (Windows: no owner or mode check). */
  uid?: number | null;
  /** The home that `~` stands for in messages (os.homedir() by default). */
  userHome?: string;
}

export interface ServiceEnvRead {
  summary: ServiceEnvSummary;
  /** The parsed values; empty unless `summary.status` is `loaded`. Never logged. */
  values: Record<string, string>;
}

/** `<home>/service.env` as people read it: `~/…` under the user's home, else as is. Local messages only. */
export function serviceEnvDisplayPath(home: string, userHome: string = homedir()): string {
  const file = join(home, SERVICE_ENV_FILE);
  return userHome && file.startsWith(`${userHome}${sep}`) ? `~${file.slice(userHome.length)}` : file;
}

const empty = (status: ServiceEnvSummary["status"]): ServiceEnvRead => ({
  summary: { status, keys: [], invalidLines: 0 },
  values: {},
});

/** Reads, checks and parses `<home>/service.env` (see the file comment). Never throws for a missing file. */
export async function readServiceEnv(home: string, deps: ServiceEnvDeps = {}): Promise<ServiceEnvRead> {
  const path = join(home, SERVICE_ENV_FILE);
  const handle = await open(path, "r").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (!handle) return empty("absent");
  let text: string;
  try {
    // Checked and read through one descriptor, so the file cannot be swapped between the check and the read.
    const st = deps.stat ? await deps.stat(path) : await handle.stat();
    const uid = deps.uid !== undefined ? deps.uid : (process.getuid?.() ?? null);
    if (uid !== null) {
      if (st.uid !== uid) return empty("refused_owner");
      if ((st.mode & 0o077) !== 0) return empty("refused_mode");
    }
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }

  const values: Record<string, string> = {};
  let invalidLines = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const name = eq > 0 ? line.slice(0, eq) : "";
    if (!NAME.test(name) || RESERVED.has(name)) {
      invalidLines += 1;
      continue;
    }
    values[name] = unquote(line.slice(eq + 1));
  }
  return { summary: { status: "loaded", keys: Object.keys(values).sort(), invalidLines }, values };
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1);
  }
  return value;
}

/**
 * Applies `<home>/service.env` to `env` (process.env at `run`): sets only the keys `env` lacks, logs one line with the
 * key names (never a value), or, when refused, one error with the `chmod 600` fix and sets nothing. Returns the summary.
 */
export async function applyServiceEnv(
  home: string,
  env: NodeJS.ProcessEnv,
  log: Logger,
  deps: ServiceEnvDeps = {},
): Promise<ServiceEnvSummary> {
  const display = serviceEnvDisplayPath(home, deps.userHome);
  const { summary, values } = await readServiceEnv(home, deps);
  if (summary.status === "absent") {
    log.debug("no service.env", { file: display });
    return summary;
  }
  if (summary.status === "refused_mode") {
    log.error(
      `${display} is readable or writable by other users; it was not loaded. Fix: chmod 600 ${display}, then restart the runtime`,
    );
    return summary;
  }
  if (summary.status === "refused_owner") {
    log.error(
      `${display} is not owned by the user running the runtime; it was not loaded. Fix: chown it to this user and chmod 600 ${display}, then restart the runtime`,
    );
    return summary;
  }
  const kept: string[] = [];
  for (const key of summary.keys) {
    if (env[key] !== undefined) kept.push(key);
    else env[key] = values[key];
  }
  log.info("service.env loaded", {
    file: display,
    keys: summary.keys,
    ...(kept.length > 0 ? { keptFromEnvironment: kept } : {}),
    ...(summary.invalidLines > 0 ? { invalidLines: summary.invalidLines } : {}),
  });
  return summary;
}
