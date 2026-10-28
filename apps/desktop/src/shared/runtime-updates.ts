// What the desktop menu shows about the runtime CLIs' updates (07.11, D-09: the desktop only shows the daemon's status
// and toggles the device's own level; every decision lives in the Local Runtime). Pure, no Electron imports.

import type { DaemonStatusPayload, DesktopRuntimeUpdatesLevel } from "./ipc";

const RUNTIME_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex" };

const LEVEL_LABELS: Record<DesktopRuntimeUpdatesLevel, string> = {
  automatic: "Automatic",
  notify: "Notify only",
  off: "Off",
};

const LEVELS: DesktopRuntimeUpdatesLevel[] = ["automatic", "notify", "off"];

type RuntimeUpdateStatus = NonNullable<
  NonNullable<DaemonStatusPayload["runtimeUpdates"]>["runtimes"]
>[number];

/** Why the device cannot install a newer version itself, in the owner's words (only shown when one is available). */
function blockedSuffix(reason: string | null | undefined): string | null {
  if (reason === "manual") return "update it with the tool that installed it";
  if (reason === "needs_admin") return "needs admin on this machine";
  return null;
}

function statusSuffix(r: RuntimeUpdateStatus): string | null {
  if (r.state === "running" || r.state === "queued") return "updating…";
  if (r.state === "pending" || r.state === "draining") return "waiting for an idle moment";
  if (r.lastRun?.outcome === "failed") return "update failed";
  if (r.advisory === "behind" && r.latestVersion) {
    const blocked = blockedSuffix(r.reason);
    return blocked ? `${r.latestVersion} available · ${blocked}` : `${r.latestVersion} available`;
  }
  if (r.advisory === "current") return "up to date";
  return null;
}

/**
 * One status line per maintained runtime: "Claude Code 2.1.307 · up to date", "· 2.1.312 available", "· updating…",
 * "· waiting for an idle moment", "· update failed". Nothing for a daemon that does not report runtime updates
 * (an older daemon, or one where maintenance does not run).
 */
export function runtimeUpdateLines(report: DaemonStatusPayload | null): string[] {
  const runtimes = report?.runtimeUpdates?.runtimes ?? [];
  return runtimes.map((r) => {
    const name = RUNTIME_NAMES[r.runtime] ?? r.runtime;
    if (!r.installedVersion) return `${name} · not installed`;
    const suffix = statusSuffix(r);
    return suffix ? `${name} ${r.installedVersion} · ${suffix}` : `${name} ${r.installedVersion}`;
  });
}

export interface RuntimeUpdatesMenuItem {
  level: DesktopRuntimeUpdatesLevel;
  label: string;
  checked: boolean;
  enabled: boolean;
}

export interface RuntimeUpdatesMenuModel {
  label: string;
  /** A disabled line above the choices when the effective level is lower than the device's (or null). */
  note: string | null;
  items: RuntimeUpdatesMenuItem[];
}

/**
 * The "Runtime updates" submenu: Automatic / Notify only / Off as radio items with the device's level checked. Set by
 * `OCW_RUNTIME_UPDATES` → every item disabled. While the daemon is unreachable the level comes from runtime.json
 * (`fileLevel`); a running daemon that does not report runtime updates gets no submenu.
 */
export function runtimeUpdatesMenuModel(
  report: DaemonStatusPayload | null,
  fileLevel?: DesktopRuntimeUpdatesLevel,
): RuntimeUpdatesMenuModel | null {
  const updates = report?.runtimeUpdates;
  let level: DesktopRuntimeUpdatesLevel;
  let fromEnv = false;
  let note: string | null = null;
  if (updates?.localLevel) {
    level = updates.localLevel;
    fromEnv = updates.localLevelSource === "env";
    const effective = updates.effectiveLevel;
    if (effective && LEVELS.indexOf(effective) > LEVELS.indexOf(level)) {
      note =
        updates.orgLevelReceived === false
          ? `${LEVEL_LABELS[effective]} until your organization's policy arrives`
          : `Limited to ${LEVEL_LABELS[effective]} by your organization`;
    }
  } else if (report === null && fileLevel) {
    level = fileLevel;
  } else {
    return null;
  }
  return {
    label: fromEnv ? "Runtime updates (set by OCW_RUNTIME_UPDATES)" : "Runtime updates",
    note,
    items: LEVELS.map((l) => ({ level: l, label: LEVEL_LABELS[l], checked: l === level, enabled: !fromEnv })),
  };
}
