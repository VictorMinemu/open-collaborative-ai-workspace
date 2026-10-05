// Platform permission mode → Codex sandbox / approval policy / reviewer (Phase 03.2, D-12). PURE.
//
// One table, used for `thread/start` and for every `turn/start` (stable per-turn overrides that "become the
// defaults for later turns"), plus its inverse for the effective-state readback (`thread/settings/updated`).
// The reviewer is always explicit: the owner's own Codex config may default it to `auto_review` (seen in the
// plan-read fixture), which would silently turn Supervised into an automatic review.
//
// `fullAccess` (danger-full-access + never) is NOT in this table: Plan 06 owns ADR-0012's authorized path.

import type { PermissionMode } from "@ocw/contracts";
import type { ApprovalsReviewer } from "./generated/v2/ApprovalsReviewer.js";
import type { AskForApproval } from "./generated/v2/AskForApproval.js";
import type { SandboxMode } from "./generated/v2/SandboxMode.js";
import type { SandboxPolicy } from "./generated/v2/SandboxPolicy.js";

/** Platform modes this table maps (everything except fullAccess). */
export type CodexPolicyMode = Exclude<PermissionMode, "fullAccess">;
export const CODEX_POLICY_MODES: readonly CodexPolicyMode[] = ["plan", "default", "acceptEdits", "auto"];

export interface CodexModePolicy {
  /** `thread/start` / `thread/resume` field. */
  sandbox: SandboxMode;
  /** `turn/start` field (same meaning as `sandbox`). */
  sandboxPolicy: SandboxPolicy;
  approvalPolicy: AskForApproval;
  approvalsReviewer: ApprovalsReviewer;
}

const READ_ONLY: SandboxPolicy = { type: "readOnly", networkAccess: false };

function workspaceWrite(cwd: string): SandboxPolicy {
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

export function codexModePolicy(mode: CodexPolicyMode, cwd: string): CodexModePolicy {
  switch (mode) {
    case "plan":
      return {
        sandbox: "read-only",
        sandboxPolicy: READ_ONLY,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
      };
    case "default": // Supervised: asks before commands and file changes (D-12)
      return {
        sandbox: "read-only",
        sandboxPolicy: READ_ONLY,
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
      };
    case "acceptEdits":
      return {
        sandbox: "workspace-write",
        sandboxPolicy: workspaceWrite(cwd),
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
      };
    case "auto": // Codex's own risk-based reviewer answers the approval requests
      return {
        sandbox: "workspace-write",
        sandboxPolicy: workspaceWrite(cwd),
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
      };
    default:
      throw new Error(`no Codex policy for permission mode ${String(mode)}`);
  }
}

/** True when Codex runs without a sandbox or without approvals (full access). */
export function isUnrestrictedCodexPolicy(p: {
  approvalPolicy?: AskForApproval | null;
  sandboxPolicy?: SandboxPolicy | null;
}): boolean {
  return p.approvalPolicy === "never" || p.sandboxPolicy?.type === "dangerFullAccess";
}

/**
 * The platform mode an effective Codex configuration corresponds to: `fullAccess` for any unrestricted report
 * (so the server can fail closed), null when no platform mode produces the combination.
 */
export function codexModeFromSettings(
  approvalPolicy: AskForApproval | null | undefined,
  sandboxPolicy: SandboxPolicy | null | undefined,
  approvalsReviewer: ApprovalsReviewer | null | undefined,
): PermissionMode | null {
  if (
    isUnrestrictedCodexPolicy({
      approvalPolicy: approvalPolicy ?? null,
      sandboxPolicy: sandboxPolicy ?? null,
    })
  )
    return "fullAccess";
  for (const mode of CODEX_POLICY_MODES) {
    const p = codexModePolicy(mode, "");
    if (
      p.approvalPolicy === approvalPolicy &&
      p.sandboxPolicy.type === sandboxPolicy?.type &&
      p.approvalsReviewer === approvalsReviewer
    )
      return mode;
  }
  return null;
}
