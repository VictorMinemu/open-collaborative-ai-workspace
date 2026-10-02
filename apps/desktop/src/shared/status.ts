// Folds supervisor state + the daemon's own status into the one status the tray and the web
// app show. Pure.

import type { DaemonStatusPayload, DesktopStatus } from "./ipc";

export type DaemonProcessState = "running" | "starting" | "stopped" | "restarting" | "external";

export interface StatusInputs {
  paused: boolean;
  /** The desktop holds a device token (or an external daemon reports itself paired). */
  paired: boolean;
  daemon: DaemonProcessState;
  /** Last successful control-socket `status` answer, or null if the socket is unreachable. */
  report: DaemonStatusPayload | null;
}

const LABELS: Record<DesktopStatus["state"], string> = {
  online: "Runtime online",
  connecting: "Connecting to server…",
  offline: "Runtime offline",
  needs_pairing: "Needs pairing",
  paused: "Runtime paused",
};

export function deriveStatus(input: StatusInputs): DesktopStatus {
  const { report } = input;
  const paired = input.paired || report?.paired === true;
  let state: DesktopStatus["state"];
  if (input.paused) state = "paused";
  else if (!paired) state = "needs_pairing";
  else if (report?.connected) state = "online";
  else if (report || input.daemon === "starting" || input.daemon === "running") state = "connecting";
  else state = "offline";
  return {
    state,
    label: LABELS[state],
    paired,
    daemon: input.daemon,
    deviceName: report?.deviceName ?? null,
    projects: report?.projects ?? 0,
    activeSessions: report?.sessions?.length ?? 0,
    runtimes: report?.runtimes ?? [],
  };
}

export function sameStatus(a: DesktopStatus | null, b: DesktopStatus): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}
