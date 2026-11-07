import { describe, expect, it } from "vitest";
import { shouldRefreshPlan } from "./generation-error";

/**
 * A credential failure re-reads the member's plan state (05-07: not eligible, needs reconnect), whether or not the
 * page saw the answer stream first: a 403 not-eligible fails before streaming, so under load it is already failed in
 * the page's first snapshot and was never "live". Once per message; other codes never re-read it.
 */
describe("shouldRefreshPlan", () => {
  it("re-reads the plan state once for a not-eligible failure never seen streaming", () => {
    expect(shouldRefreshPlan("m-not-eligible", "user_not_eligible")).toBe(true);
    expect(shouldRefreshPlan("m-not-eligible", "user_not_eligible")).toBe(false);
  });

  it("re-reads it once for an invalid sign-in", () => {
    expect(shouldRefreshPlan("m-invalid", "invalid_credential")).toBe(true);
    expect(shouldRefreshPlan("m-invalid", "invalid_credential")).toBe(false);
  });

  it("never for a failure that does not move the credential", () => {
    for (const code of ["usage_limit_exceeded", "provider_error", "rate_limited", "timeout"] as const) {
      expect(shouldRefreshPlan(`m-${code}`, code), code).toBe(false);
    }
    expect(shouldRefreshPlan("m-null", null)).toBe(false);
  });
});
