import type { WorkSessionStatus, WorkZonePermissionMode } from "./agent-channel-protocol.js";

/**
 * 07.16: the Work Zone words the model reads, shared by the session tools (work-session-tools.ts) and the turn blocks
 * (mention-mapper.ts). Type imports only, so either module can load it without an import cycle.
 */

/** The permission modes as people read them in the Work Zone (apps/web work-zone/meta.tsx labels). */
export const WORK_ZONE_MODE_LABELS: Readonly<Record<WorkZonePermissionMode, string>> = {
  default: "Supervised",
  acceptEdits: "Accept edits",
  plan: "Plan",
  auto: "Auto",
  fullAccess: "Full access",
};

export const WORK_ZONE_RUNTIME_LABELS: Readonly<Record<"claude-code" | "codex", string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

export const WORK_SESSION_STATUS_LABELS: Readonly<Record<WorkSessionStatus, string>> = {
  provisioning: "starting",
  idle: "idle",
  running: "running",
  waiting_approval: "waiting for approval",
  host_offline: "device offline",
  completed: "completed",
  failed: "failed",
  archived: "stopped",
};
