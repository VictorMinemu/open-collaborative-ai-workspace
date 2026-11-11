// Phase 07.17.1 (runtime self-update, ADR-0040, D-07; hub PD-12, PD-25): what the daemon does at boot, before its
// first connect, after a self-update restarted it. The run marker (`self-update.json`, written by `switchToVersion`)
// carried the run across the exit; `reconcileSelfUpdate` compares the running build with the marker's target and
// builds the run's `started` and `finished` frames (sent first in the handshake, 10), and rewrites an `install.json`
// left stale by a crash between the link and the record. `pruneRuntimeVersions` and `clearStaging` keep `versions/`
// from piling up.
//
// What this module never does: read the network; delete the running directory, the one `current` points to, a `keep`
// entry or any name that is not 12 lowercase hex; put a path in a frame (versions, 12-hex builds, enums and fixed
// sentences only). It leaves the marker in place: the caller removes it once the frames were sent.

import { realpathSync } from "node:fs";
import { readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { type RuntimeSelfLastRun, type RuntimeUpdateRunFrame, runtimeBuildOf } from "@ocw/contracts";
import { installInfoPath, RuntimeInstallInfo, runtimeDir } from "../install-info.js";
import { readSelfUpdateMarker, type SelfUpdateMarker } from "./self-update.js";

/** The finished frame's output when the daemon came back on the build it left (PD-12). */
export const CAME_BACK_ON_PREVIOUS = "the runtime came back on the previous version";

/** A `versions/` entry the self-update owns: the first 12 hex of a bundle's sha256. */
const BUILD_DIR_RE = /^[0-9a-f]{12}$/;
const STAGING_PREFIX = ".staging-";

/** The run a restart interrupted, as the new daemon reports it. */
export interface SelfUpdateBoot {
  marker: SelfUpdateMarker;
  outcome: "succeeded" | "failed";
  frames: [RuntimeUpdateRunFrame, RuntimeUpdateRunFrame];
  lastRun: RuntimeSelfLastRun;
}

/**
 * Reads the marker and reports its run: running sha256 equal to `marker.to.sha256` → `started` + `finished succeeded`;
 * anything else (the previous build, an unknown one, a checkout) → `finished failed` with `CAME_BACK_ON_PREVIOUS`. Both
 * frames carry the marker's `runId`, `commandId`, trigger, versions and builds, `method: "ocw_bundle"` and `at` from
 * `now`. Null without a readable marker (an unreadable one stays on disk for the doctor). An `install.json` that names
 * another build than the running one is rewritten from it (temp file + rename, 0600; `serverUrl` and `nodePath` kept).
 */
export async function reconcileSelfUpdate(p: {
  ocwHome: string;
  running: { version: string; sha256: string } | null;
  now?: () => Date;
}): Promise<SelfUpdateBoot | null> {
  const marker = await readSelfUpdateMarker(p.ocwHome);
  if (!marker) return null;
  const at = (p.now ?? (() => new Date()))().toISOString();
  const outcome = p.running?.sha256 === marker.to.sha256 ? "succeeded" : "failed";

  const fromBuild = runtimeBuildOf(marker.from.sha256);
  const toBuild = runtimeBuildOf(marker.to.sha256);
  const base = {
    type: "runtime.update.run" as const,
    runId: marker.runId,
    runtime: "ocw-runtime" as const,
    trigger: marker.trigger,
    ...(marker.commandId ? { commandId: marker.commandId } : {}),
    fromVersion: marker.from.version,
    toVersion: marker.to.version,
    candidate: marker.to.version,
    method: "ocw_bundle" as const,
    fromBuild,
    toBuild,
    at,
  };
  const frames: [RuntimeUpdateRunFrame, RuntimeUpdateRunFrame] = [
    { ...base, phase: "started" },
    {
      ...base,
      phase: "finished",
      outcome,
      ...(outcome === "failed" ? { output: CAME_BACK_ON_PREVIOUS } : {}),
    },
  ];

  if (p.running) await rewriteStaleInstallInfo(p.ocwHome, p.running, at);

  return {
    marker,
    outcome,
    frames,
    lastRun: {
      runId: marker.runId,
      outcome,
      at,
      fromVersion: marker.from.version,
      toVersion: marker.to.version,
      fromBuild,
      toBuild,
    },
  };
}

/** Rewrites `install.json` from the running build when it names another one; a missing or invalid record stays. */
async function rewriteStaleInstallInfo(
  ocwHome: string,
  running: { version: string; sha256: string },
  installedAt: string,
): Promise<void> {
  const file = installInfoPath(ocwHome);
  let old: RuntimeInstallInfo;
  try {
    const parsed = RuntimeInstallInfo.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success) return;
    old = parsed.data;
  } catch {
    return;
  }
  if (old.sha256 === running.sha256 && old.version === running.version) return;
  const next = RuntimeInstallInfo.safeParse({
    ...old,
    version: running.version,
    sha256: running.sha256,
    installedAt,
  });
  if (!next.success) return;
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    await rm(tmp, { force: true });
    await writeFile(tmp, `${JSON.stringify(next.data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(tmp, file);
  } catch {
    // Not fatal: the doctor still reads the old record, and the next boot tries again.
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function entriesOf(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** The `versions/` entry name a path lives in (first segment), or null outside `versions/`. */
function versionEntryOf(versions: string, path: string | null): string | null {
  if (!path) return null;
  const rel = relative(versions, path);
  if (rel === "" || rel.startsWith("..") || rel.startsWith("/")) return null;
  return rel.split("/")[0] ?? null;
}

function tryRealpathSync(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Removes every `versions/<12 hex>` directory except `keep`, the one `current` points to and the one the running
 * bundle (`argv1`, default `process.argv[1]`) lives in. Other names are never touched. Returns the removed names.
 */
export async function pruneRuntimeVersions(p: {
  ocwHome: string;
  keep: readonly string[];
  argv1?: string | undefined;
}): Promise<string[]> {
  const runtime = runtimeDir(p.ocwHome);
  const versionsDir = join(runtime, "versions");
  const versions = tryRealpathSync(versionsDir);
  if (!versions) return [];
  const protectedNames = new Set(p.keep);
  const current = await realpath(join(runtime, "current")).catch(() => null);
  const currentEntry = versionEntryOf(versions, current);
  if (currentEntry) protectedNames.add(currentEntry);
  const argv1 = p.argv1 ?? process.argv[1];
  const runningDir = argv1 ? await realpath(dirname(argv1)).catch(() => null) : null;
  const runningEntry = versionEntryOf(versions, runningDir);
  if (runningEntry) protectedNames.add(runningEntry);

  const removed: string[] = [];
  for (const name of await entriesOf(versions)) {
    if (!BUILD_DIR_RE.test(name) || protectedNames.has(name)) continue;
    try {
      await rm(join(versions, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Left for the next boot.
    }
  }
  return removed;
}

/** Removes every `versions/.staging-*` left by an interrupted prepare. Returns how many it removed. */
export async function clearStaging(ocwHome: string): Promise<number> {
  const versions = join(runtimeDir(ocwHome), "versions");
  let removed = 0;
  for (const name of await entriesOf(versions)) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    try {
      await rm(join(versions, name), { recursive: true, force: true });
      removed += 1;
    } catch {
      // Left for the next boot.
    }
  }
  return removed;
}
