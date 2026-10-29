// Which service manager can keep the runtime running on this machine (07.12-04, D-04, PD-11, RESEARCH §4 and
// Pitfall 8): a systemd user manager (reachable only from a real login session), the systemd system manager (root, for
// a named account), launchd on macOS, or none (containers, WSL without systemd, Windows).

import type { ServiceExecFn } from "./exec.js";
import type { ServiceManagerKind } from "./types.js";

export const SUPERVISOR_FALLBACK =
  "run `ocw-runtime run` under your own supervisor (Docker restart policy, tmux, supervisord)";

export interface DetectDeps {
  platform: NodeJS.Platform;
  /** The account running this command (named in the "log in as" line). */
  account: string;
  /** Whether a machine path exists (resolved under the injected root in tests). */
  exists: (path: string) => Promise<boolean>;
  which: (name: string) => string | null;
  exec: ServiceExecFn;
}

export interface DetectedManager {
  kind: ServiceManagerKind;
  /** The manager can take a unit now. */
  available: boolean;
  /** One printable line when not available; null otherwise. */
  reason: string | null;
}

export async function detectServiceManager(
  deps: DetectDeps,
  opts: { system?: boolean } = {},
): Promise<DetectedManager> {
  if (deps.platform === "win32") {
    return {
      kind: "none",
      available: false,
      reason: `services are not supported on Windows: ${SUPERVISOR_FALLBACK}`,
    };
  }
  if (deps.platform === "darwin") {
    if (opts.system) {
      return {
        kind: "launchd",
        available: false,
        reason: "system services are Linux only; use the LaunchAgent (`ocw-runtime service install`)",
      };
    }
    return { kind: "launchd", available: true, reason: null };
  }
  if (deps.platform !== "linux") {
    return {
      kind: "none",
      available: false,
      reason: `no supported service manager here: ${SUPERVISOR_FALLBACK}`,
    };
  }
  // sd_booted(): systemd is PID 1 only when /run/systemd/system exists.
  const booted = await deps.exists("/run/systemd/system");
  if (!booted || !deps.which("systemctl")) {
    return { kind: "none", available: false, reason: `systemd is not running here: ${SUPERVISOR_FALLBACK}` };
  }
  if (opts.system) return { kind: "systemd-system", available: true, reason: null };
  const probe = await deps.exec("systemctl", ["--user", "show-environment"]).catch(() => null);
  if (probe?.code === 0) return { kind: "systemd-user", available: true, reason: null };
  return {
    kind: "systemd-user",
    available: false,
    reason:
      `the systemd user manager of ${deps.account} is not reachable from this shell (sudo -u and su have none): ` +
      `log in as ${deps.account} over SSH (or machinectl shell ${deps.account}@) and re-run`,
  };
}
