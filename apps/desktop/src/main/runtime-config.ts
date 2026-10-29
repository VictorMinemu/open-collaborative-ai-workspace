// The Local Runtime daemon's own config file (`<OCW_HOME>/runtime.json`) as far as the desktop app touches it: the
// device owner's Full access opt-in (ADR-0012, P-12) and runtime updates level (07.11, D-02). Only the main process
// writes it, from the Runtime menu (Full access after a native confirmation); the web origin and the preload API can
// never change it. The daemon picks the change up on the `reloadConfig` control request (no restart). No Electron
// imports (unit-tested).

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DesktopRuntimeUpdatesLevel } from "../shared/ipc";

const FILE = "runtime.json";

async function readObject(ocwHome: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(join(ocwHome, FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`cannot read ${FILE}: ${(err as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${FILE} is not valid JSON; fix or remove it first`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${FILE} is not a JSON object; fix or remove it first`);
  }
  return value as Record<string, unknown>;
}

/** The opt-in as runtime.json says it (false when the file or the key is missing). */
export async function readDaemonFullAccess(ocwHome: string): Promise<boolean> {
  const config = await readObject(ocwHome);
  const fullAccess = config.fullAccess as { optIn?: unknown } | undefined;
  return fullAccess?.optIn === true;
}

/** Sets `fullAccess.optIn` atomically (temp file + rename, mode 0600), keeping every other key. */
export async function writeDaemonFullAccess(ocwHome: string, on: boolean): Promise<void> {
  await patchSection(ocwHome, "fullAccess", { optIn: on });
}

/** The device's runtime updates level as runtime.json says it (`automatic` when missing or unknown here). */
export async function readDaemonRuntimeUpdates(ocwHome: string): Promise<DesktopRuntimeUpdatesLevel> {
  const config = await readObject(ocwHome);
  const updates = config.runtimeUpdates as { level?: unknown } | undefined;
  const level = DesktopRuntimeUpdatesLevel.safeParse(updates?.level);
  return level.success ? level.data : "automatic";
}

/** Sets `runtimeUpdates.level` atomically (temp file + rename, mode 0600), keeping every other key. */
export async function writeDaemonRuntimeUpdates(
  ocwHome: string,
  level: DesktopRuntimeUpdatesLevel,
): Promise<void> {
  await patchSection(ocwHome, "runtimeUpdates", { level: DesktopRuntimeUpdatesLevel.parse(level) });
}

/** Merges `patch` into one object section of runtime.json; a malformed file is never overwritten. */
async function patchSection(
  ocwHome: string,
  section: "fullAccess" | "runtimeUpdates",
  patch: Record<string, unknown>,
): Promise<void> {
  await mkdir(ocwHome, { recursive: true, mode: 0o700 });
  const config = await readObject(ocwHome);
  const previous = config[section];
  const kept = typeof previous === "object" && previous !== null && !Array.isArray(previous) ? previous : {};
  const path = join(ocwHome, FILE);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ ...config, [section]: { ...kept, ...patch } }, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}
