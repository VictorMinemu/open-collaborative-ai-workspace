import type { AuthzDenial } from "@ocw/contracts";
import { HttpError } from "../../../lib/errors";

const GENERIC_REASONS = new Set(["missing_permission", "denied_by_rule"]);

/**
 * A resolver denial. 403 with `details = denial` when the resource is visible; 404 (`not_found`, no details,
 * so nothing about the resource leaks) when the caller must not learn it exists. `denial` is always kept on
 * the error so the error handler can audit it (Pitfall 4).
 */
export class AuthzDeniedError extends HttpError {
  readonly denial: AuthzDenial;
  readonly hidden: boolean;

  constructor(denial: AuthzDenial, opts: { hideAs404?: boolean; message?: string } = {}) {
    const hidden = opts.hideAs404 === true;
    super(
      hidden ? 404 : 403,
      hidden ? "not_found" : GENERIC_REASONS.has(denial.reason) ? "forbidden" : denial.reason,
      opts.message ?? (hidden ? "Not found" : "You do not have permission to do this"),
      hidden ? undefined : denial,
    );
    this.denial = denial;
    this.hidden = hidden;
  }
}
