// Phase 07.17.1 (runtime self-update, ADR-0040, D-05, D-12; hub PD-05, PD-11): whether a service manager will restart
// this daemon after it exits for an update, and which build it runs. A daemon nothing would restart (the launcher in a
// terminal, the desktop app, a checkout, Docker or a custom supervisor, refused by D-05) never switches versions under
// itself. Paths are compared on this device only: only the answer (`supervised`, a `RuntimeSelfBlock`, a version and a
// hash) ever leaves it.

import { createHash } from "node:crypto";
import { readFile as fsReadFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { RUNTIME_BUNDLE_FILE, type RuntimeSelfBlock } from "@ocw/contracts";
import { readInstallInfo, runtimeDir } from "../install-info.js";
import { LAUNCHD_LABEL, LAUNCHD_PLIST_FILE, readGeneratedLaunchdPlist } from "../service/launchd.js";
import { readGeneratedSystemdUnit, SYSTEMD_SYSTEM_UNIT_DIR, SYSTEMD_UNIT_NAME } from "../service/systemd.js";

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

/** Where to look for the unit that started this daemon: the OS account's home, and `/` (tests: a scratch root). */
export interface UnitLookup {
  userHome: string;
  root?: string;
}

/**
 * The scope of the systemd unit this process runs in, from `/proc/self/cgroup` (the v2 `0::` line, else v1's
 * `name=systemd` hierarchy): `user` under a `user@<uid>.service` manager, `system` under `/system.slice/`, null when
 * the last path segment is not `ocw-runtime.service` (another unit, a session scope, no systemd).
 */
function ocwUnitScope(cgroup: string): "user" | "system" | null {
  const lines = cgroup.split("\n");
  const line = lines.find((l) => l.startsWith("0::")) ?? lines.find((l) => /^\d+:name=systemd:/.test(l));
  const path = line?.slice(line.indexOf(":", line.indexOf(":") + 1) + 1).trim();
  if (!path) return null;
  const segments = path.split("/");
  if (segments.at(-1) !== SYSTEMD_UNIT_NAME) return null;
  if (segments.some((s) => /^user@\d+\.service$/.test(s))) return "user";
  return segments[1] === "system.slice" ? "system" : null;
}

/** The bundle path goes through `<OCW_HOME>/runtime/current/` (realpaths), so a restart runs the build just switched. */
async function followsCurrent(bundlePath: string, ocwHome: string): Promise<boolean> {
  if (basename(bundlePath) !== RUNTIME_BUNDLE_FILE || basename(dirname(bundlePath)) !== "current")
    return false;
  const [named, ours] = await Promise.all([
    realpath(dirname(dirname(bundlePath))).catch(() => null),
    realpath(runtimeDir(ocwHome)).catch(() => null),
  ]);
  return named !== null && named === ours;
}

/**
 * A daemon started by a unit an older installer wrote (before 07.16-05, v0.2.x: the same unit without
 * `OCW_RUNTIME_HOST=service`). It counts as supervised only when D-05's guarantee still holds from the unit itself:
 * systemd started this process as `ocw-runtime.service` (cgroup; launchd's label is the marker), the unit file for
 * that scope is the one `service install` generated (our header), ExecStart runs this OCW_HOME's bundle through
 * `current` with `run`, the manager restarts it after exit 75, and no drop-in beside it can override that. The first
 * existing candidate decides; anything unread or unmet is false.
 */
async function legacyUnitSupervises(p: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  ocwHome: string;
  unit: UnitLookup;
}): Promise<boolean> {
  const root = p.unit.root ?? "/";
  const at = (path: string) => (root === "/" ? path : join(root, path));
  let candidates: string[];
  if (p.platform === "linux") {
    const cgroup = await fsReadFile(at("/proc/self/cgroup"), "utf8").catch(() => null);
    const scope = cgroup === null ? null : ocwUnitScope(cgroup);
    if (scope === null) return false;
    if (scope === "system") candidates = [join(SYSTEMD_SYSTEM_UNIT_DIR, SYSTEMD_UNIT_NAME)];
    else {
      const xdg = p.env.XDG_CONFIG_HOME;
      const dirs = [...(xdg && isAbsolute(xdg) ? [xdg] : []), join(p.unit.userHome, ".config")];
      candidates = [...new Set(dirs)].map((d) => join(d, "systemd", "user", SYSTEMD_UNIT_NAME));
    }
  } else if (p.platform === "darwin") {
    candidates = [join(p.unit.userHome, "Library", "LaunchAgents", LAUNCHD_PLIST_FILE)];
  } else return false;

  for (const path of candidates) {
    const text = await fsReadFile(at(path), "utf8").catch(() => null);
    if (text === null) continue;
    const facts = p.platform === "linux" ? readGeneratedSystemdUnit(text) : readGeneratedLaunchdPlist(text);
    if (!facts?.restartsOnUpdateExit) return false;
    if (p.platform === "linux") {
      const dropIns = await readdir(at(`${path}.d`)).catch(() => []);
      if (dropIns.some((f) => f.endsWith(".conf"))) return false;
    }
    return followsCurrent(facts.bundlePath, p.ocwHome);
  }
  return false;
}

/**
 * Supervised iff the running bundle is an installed version (`<OCW_HOME>/runtime/versions/<12 hex>/`, realpaths) with
 * a parseable `install.json`, the platform's manager marker (`INVOCATION_ID` on Linux, `XPC_SERVICE_NAME =
 * org.ocw.runtime` on macOS), and either `OCW_RUNTIME_HOST=service` or, with no `OCW_RUNTIME_HOST` at all and a
 * `unit` lookup, a unit an older installer wrote that still restarts the switched build (`legacyUnitSupervises`). Not
 * installed wins over the env checks (`not_installed`); otherwise anything unmet, or another platform, is
 * `not_supervised`.
 */
export async function isSupervised(p: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  argv1: string | undefined;
  ocwHome: string;
  /** Where the unit lives; without it a unit is never read (only `OCW_RUNTIME_HOST=service` counts). */
  unit?: UnitLookup;
}): Promise<{ supervised: boolean; reason: RuntimeSelfBlock | null }> {
  const [entry, info] = await Promise.all([installedEntry(p.argv1, p.ocwHome), readInstallInfo(p.ocwHome)]);
  if (!entry || !info) return { supervised: false, reason: "not_installed" };
  const notSupervised = { supervised: false, reason: "not_supervised" } as const;
  if (!managerMarker(p.env, p.platform)) return notSupervised;
  const host = p.env.OCW_RUNTIME_HOST?.trim().toLowerCase() ?? "";
  if (host === "service") return { supervised: true, reason: null };
  if (host === "" && p.unit && (await legacyUnitSupervises({ ...p, unit: p.unit })))
    return { supervised: true, reason: null };
  return notSupervised;
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
