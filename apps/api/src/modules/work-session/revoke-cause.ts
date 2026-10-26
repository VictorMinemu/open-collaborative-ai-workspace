import { type AuthzDenial, modulePatternOf, type RevokeCause } from "@ocw/contracts";

/**
 * Why a live `ws:` subscription was refused when re-decided (Phase 07.9, D-04, D-13, P-09), as the fixed code the
 * client shows in plain words; never a name. From the resolver's denial of `work_session.read`:
 * - outside the session's audience, or a creator who left its team project → `visibility`;
 * - a revoked device → `device`;
 * - a deny rule that is a module catalog row (Work Zone turned off, ADR-0024) → `module` (`rulePermission` is the
 *   denying rule's `permission`, read by the caller from the rule the denial names);
 * - anything else (a role without Work Zone, another deny rule, a deactivated member) → `role`.
 */
export function revokeCauseOf(
  denial: Pick<AuthzDenial, "layer" | "reason"> | undefined,
  rulePermission: string | null = null,
): RevokeCause {
  if (!denial) return "role";
  if (denial.reason === "not_in_audience" || denial.reason === "left_project") return "visibility";
  if (denial.reason === "device_revoked") return "device";
  if (
    denial.reason === "denied_by_rule" &&
    rulePermission !== null &&
    modulePatternOf(rulePermission) !== null
  ) {
    return "module";
  }
  return "role";
}
