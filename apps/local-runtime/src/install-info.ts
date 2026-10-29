// The install record of a served runtime bundle (07.12, D-01, PD-04): `<OCW_HOME>/runtime/install.json`, written only by
// the API's `install.sh` (07.12-06) next to `runtime/versions/<sha>/` and the `runtime/current` link. Read by
// `ocw-runtime enroll`/`setup` (the default server, 03 and 08), `service install` (the unit's node and bundle paths, 04)
// and `doctor` (the installed version against the server's, 05). Local only: nothing here is sent to the server.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNTIME_BUNDLE_FILE } from "@ocw/contracts";
import { z } from "zod";

export const RuntimeInstallInfo = z.object({
  /** The workspace API the bundle was downloaded from (`OCW_SERVER_URL` or the script's embedded URL). */
  serverUrl: z.url(),
  /** The bundle's version (`RuntimeDistManifest.version`). */
  version: z.string().min(1).max(64),
  /** The installed file's sha256, verified by `install.sh` before it was linked as `current`. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** When `install.sh` finished (ISO 8601). */
  installedAt: z.string().min(1),
  /**
   * The absolute path of the node binary the shim and the service run the bundle with. An absolute local path that
   * never leaves this device (AGENTS principle 7): doctor shows it home-relative at most.
   */
  nodePath: z.string().min(1),
});
export type RuntimeInstallInfo = z.infer<typeof RuntimeInstallInfo>;

/** `<home>/runtime`: everything `install.sh` writes (versions, the `current` link, install.json). */
export function runtimeDir(home: string): string {
  return join(home, "runtime");
}

/** `<home>/runtime/install.json`. */
export function installInfoPath(home: string): string {
  return join(runtimeDir(home), "install.json");
}

/** `<home>/runtime/current/ocw-runtime.mjs`: the bundle the shim and the service run. */
export function installedBundlePath(home: string): string {
  return join(runtimeDir(home), "current", RUNTIME_BUNDLE_FILE);
}

/** The install record, or null when there is none or it is not valid (a development checkout has none). */
export async function readInstallInfo(home: string): Promise<RuntimeInstallInfo | null> {
  let text: string;
  try {
    text = await readFile(installInfoPath(home), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = RuntimeInstallInfo.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
