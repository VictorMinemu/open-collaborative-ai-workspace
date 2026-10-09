import { describe, expect, it } from "vitest";
import { moduleTargetResource } from ".";

describe("public interface", () => {
  it("exports moduleTargetResource for other modules (07.3-01 open item 4)", () => {
    expect(moduleTargetResource({ id: "u1", path: ["u0", "u1"] }, "admin")).toMatchObject({
      type: "unit",
      unitPath: ["u0", "u1"],
      targetRole: "admin",
    });
    expect(moduleTargetResource(null)).not.toHaveProperty("targetRole");
  });
});
