import {
  matchesToolPattern,
  strictestMode,
  type ToolApprovalMode,
  type ToolApproverKind,
} from "@ocw/contracts";

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

/**
 * Who a call involves, as unit paths (root…unit): the agent's unit (null = an organization or personal bot) and every
 * unit the human belongs to (the resolver's `memberUnitPaths`).
 */
export interface ApprovalFacts {
  agentUnitPath: readonly string[] | null;
  humanUnitPaths: readonly (readonly string[])[];
}

export interface ResolvedApproval {
  mode: ToolApprovalMode;
  approverKind: ToolApproverKind;
  approverUserIds: readonly string[];
  /** The rule that carries the effective mode (its approvers decide). */
  policyId: string;
  scopeUnitId: string | null;
  pattern: string;
}

const isServerPattern = (pattern: string) => pattern.endsWith("__*");

/** Upper scope first, then the exact tool name before `<safe>__*`, then id: one carrier for any input order. */
function carrierOrder(a: PolicyRow, b: PolicyRow): number {
  return (
    a.scopePath.length - b.scopePath.length ||
    Number(isServerPattern(a.toolPattern)) - Number(isServerPattern(b.toolPattern)) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * The effective rule for (agent, human, tool), or null when no rule names the tool. Applicable rules: the
 * organization's, those on a unit whose subtree holds the agent's unit, and those on a unit whose subtree holds any of
 * the human's units (restrictions accumulate, principle 6). The mode is the strictest of them (`always` >
 * `when_tainted` > `never`), so a lower scope never relaxes an upper one; the approvers come from the highest-scope
 * rule carrying that mode, so a unit rule never changes who approves an upper rule of the same strictness.
 */
export function resolveToolApproval(
  rows: readonly PolicyRow[],
  facts: ApprovalFacts,
  tool: string,
): ResolvedApproval | null {
  const reaches = (unitId: string) =>
    (facts.agentUnitPath?.includes(unitId) ?? false) || facts.humanUnitPaths.some((p) => p.includes(unitId));
  const applicable = rows.filter(
    (r) => (r.scopeUnitId === null || reaches(r.scopeUnitId)) && matchesToolPattern(r.toolPattern, tool),
  );
  if (applicable.length === 0) return null;
  const mode = strictestMode(applicable.map((r) => r.mode));
  const [carrier] = applicable.filter((r) => r.mode === mode).sort(carrierOrder);
  if (!carrier) return null;
  return {
    mode,
    approverKind: carrier.approverKind,
    approverUserIds: [...carrier.approverUserIds],
    policyId: carrier.id,
    scopeUnitId: carrier.scopeUnitId,
    pattern: carrier.toolPattern,
  };
}
