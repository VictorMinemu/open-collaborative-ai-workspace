import { MODULE_CATALOG } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { revokeCauseOf } from "./revoke-cause";

/** Phase 07.9-07 (D-13, hub P-09 mapping): the code a revoked `ws:` frame carries, from the resolver's denial. */
describe("revokeCauseOf", () => {
  it("outside the audience or left the project → visibility", () => {
    expect(revokeCauseOf({ layer: "resource", reason: "not_in_audience" })).toBe("visibility");
    expect(revokeCauseOf({ layer: "resource", reason: "left_project" })).toBe("visibility");
  });

  it("a revoked device → device", () => {
    expect(revokeCauseOf({ layer: "device", reason: "device_revoked" })).toBe("device");
  });

  it("a Work Zone module row → module, for every catalog pattern and at every scope", () => {
    for (const pattern of MODULE_CATALOG.work_zone.patterns) {
      for (const layer of ["org", "unit", "user"] as const) {
        expect(revokeCauseOf({ layer, reason: "denied_by_rule" }, pattern), `${layer} ${pattern}`).toBe(
          "module",
        );
      }
    }
  });

  it("any other deny rule, a missing role grain, a deactivated member or no denial → role", () => {
    expect(revokeCauseOf({ layer: "unit", reason: "denied_by_rule" }, "work_session.read")).toBe("role");
    expect(revokeCauseOf({ layer: "unit", reason: "denied_by_rule" })).toBe("role");
    expect(revokeCauseOf({ layer: "role", reason: "missing_permission" })).toBe("role");
    expect(revokeCauseOf({ layer: "user", reason: "deactivated" })).toBe("role");
    expect(revokeCauseOf(undefined)).toBe("role");
  });

  it("the module mapping needs the rule's pattern: a rule denial alone is not a module", () => {
    expect(revokeCauseOf({ layer: "org", reason: "denied_by_rule" }, null)).toBe("role");
    expect(revokeCauseOf({ layer: "resource", reason: "not_in_audience" }, "work_session.*")).toBe(
      "visibility",
    );
  });
});
