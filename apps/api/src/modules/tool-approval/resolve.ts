import type { ToolApprovalMode, ToolApproverKind } from "@ocw/contracts";

/**
 * Tool approval resolution (Phase 07.5, D-01, P-04): pure data in, one decision out. No I/O; policies.ts loads the
 * rows and the facts inside the caller's tenant transaction.
 */

/** One stored rule with the path (root…unit ids) of its scope; the organization scope has an empty path. */
export interface PolicyRow {
  id: string;
  scopeUnitId: string | null;
  scopePath: readonly string[];
  toolPattern: string;
  mode: ToolApprovalMode;
  approverKind: ToolApproverKind;
  approverUserIds: readonly string[];
}
