// Service vocabulary shared by the 07.12 plans (D-04, D-12, D-14, PD-10, PD-11). Types only: the service module
// (07.12-04) produces `ServiceStatus`, the service.env reader (07.12-03) produces `ServiceEnvSummary`, and `doctor`
// (07.12-05) and `setup` (07.12-08) consume both. Local only: none of this is sent to the server.

/**
 * Which service manager runs (or would run) the runtime on this machine: a systemd user unit, a systemd system unit
 * running as a named non-root account, a macOS LaunchAgent, or none (containers, WSL without systemd, Windows: run
 * `ocw-runtime run` under your own supervisor).
 */
export type ServiceManagerKind = "systemd-user" | "systemd-system" | "launchd" | "none";

/** The runtime service's state as `ocw-runtime service status` and `doctor` report it. */
export type ServiceStatus = {
  /** The manager this status comes from. */
  manager: ServiceManagerKind;
  /** The unit or plist file exists. */
  installed: boolean;
  /** Starts at boot / login (`systemctl is-enabled`, the plist loaded); null when unknown or not applicable. */
  enabled: boolean | null;
  /** Running now (`systemctl is-active`, `launchctl print`); null when unknown. */
  active: boolean | null;
  /** systemd user units: lingering is on (survives logout and starts at boot); null when not applicable or unknown. */
  linger: boolean | null;
  /** The OS account the service runs as (its sign-ins to Claude Code and Codex are the ones that count). */
  account: string;
  /**
   * The unit file in display form: `~/…` under the home, or `/etc/systemd/system/ocw-runtime.service` for a system
   * unit; null when not installed. Never an absolute home path.
   */
  unitPath: string | null;
  /** The node binary the unit names still exists (an nvm upgrade can delete it); null when not installed. */
  nodePathExists: boolean | null;
  /** The bundle the unit names still exists; null when not installed. */
  bundlePathExists: boolean | null;
  /** Why the manager is `none` or the state is unknown (one line, safe to print); null otherwise. */
  reason: string | null;
};

/**
 * What `~/.ocw/service.env` contributed (D-12, PD-10): absent; loaded; refused because it is group- or world-readable
 * (`refused_mode`) or not owned by the running user (`refused_owner`). Names only, never values.
 */
export type ServiceEnvSummary = {
  status: "absent" | "loaded" | "refused_mode" | "refused_owner";
  /** The variable names set in the file, sorted (never their values). */
  keys: string[];
  /** Lines that were neither a `NAME=value` pair, a comment nor blank, skipped. */
  invalidLines: number;
};
