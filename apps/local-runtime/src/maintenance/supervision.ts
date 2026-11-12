// Phase 07.17.1 (runtime self-update, ADR-0040, D-05, D-12; hub PD-05, PD-11): whether a service manager will restart
// this daemon after it exits for an update, and which build it runs. A daemon nothing would restart (the launcher in a
// terminal, the desktop app, a checkout, Docker or a custom supervisor, refused by D-05) never switches versions under
// itself. Paths are compared on this device only: only the answer (`supervised`, a `RuntimeSelfBlock`, a version and a
// hash) ever leaves it.

import { createHash } from "node:crypto";
import { readFile as fsReadFile, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { RUNTIME_BUNDLE_FILE, type RuntimeSelfBlock } from "@ocw/contracts";
import { readInstallInfo, runtimeDir } from "../install-info.js";
import { LAUNCHD_LABEL } from "../service/launchd.js";

const BUILD_DIR_RE = /^[0-9a-f]{12}$/;

/** The real path of `argv1` when it is `<OCW_HOME>/runtime/versions/<12 hex>/ocw-runtime.mjs`, else null. */
async function installedEntry(argv1: string | undefined, ocwHome: string): Promise<string | null> {
  if (!argv1) return null;
  const [entry, versions] = await Promise.all([
    realpath(argv1).catch(() => null),
    realpath(join(runtimeDir(ocwHome), "versions")).catch(() => null),
  ]);
  if (!entry || !versions) return null;
  const parts = relative(versions, entry).split(sep);
  if (parts.length !== 2 || !BUILD_DIR_RE.test(parts[0] ?? "") || parts[1] !== RUNTIME_BUNDLE_FILE)
    return null;
  return entry;
}

/** Whether the platform's service manager started this process: systemd's `INVOCATION_ID`, launchd's job label. */
function managerMarker(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform === "linux") return (env.INVOCATION_ID ?? "").trim() !== "";
  // launchd sets XPC_SERVICE_NAME to the job's label for a LaunchAgent; a terminal has "0" (research A1, A-01).
  if (platform === "darwin") return env.XPC_SERVICE_NAME === LAUNCHD_LABEL;
  return false;
}

/**
 * Supervised iff the running bundle is an installed version (`<OCW_HOME>/runtime/versions/<12 hex>/`, realpaths) with
 * a parseable `install.json`, `OCW_RUNTIME_HOST=service`, and the platform's manager marker (`INVOCATION_ID` on Linux,
 * `XPC_SERVICE_NAME = org.ocw.runtime` on macOS). Not installed wins over the env checks (`not_installed`); otherwise
 * anything unmet, or another platform, is `not_supervised`.
 */
export async function isSupervised(p: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  argv1: string | undefined;
  ocwHome: string;
}): Promise<{ supervised: boolean; reason: RuntimeSelfBlock | null }> {
  const [entry, info] = await Promise.all([installedEntry(p.argv1, p.ocwHome), readInstallInfo(p.ocwHome)]);
  if (!entry || !info) return { supervised: false, reason: "not_installed" };
  if (p.env.OCW_RUNTIME_HOST?.trim().toLowerCase() !== "service" || !managerMarker(p.env, p.platform))
    return { supervised: false, reason: "not_supervised" };
  return { supervised: true, reason: null };
}

/**
 * The running build: `version` and the sha256 of the real file behind `argv1`, read once (PD-05: never what `current`
 * points to now). Null outside `<OCW_HOME>/runtime/versions/` (a checkout, the desktop app) or when it cannot be read.
 */
export async function runningBuild(p: {
  argv1: string | undefined;
  ocwHome: string;
  version: string;
  readFile?: (path: string) => Promise<Buffer>;
}): Promise<{ version: string; sha256: string } | null> {
  const entry = await installedEntry(p.argv1, p.ocwHome);
  if (!entry) return null;
  try {
    const bytes = await (p.readFile ?? fsReadFile)(entry);
    return { version: p.version, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch {
    return null;
  }
}
