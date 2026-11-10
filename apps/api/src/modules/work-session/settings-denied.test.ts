import { describe, expect, it } from "vitest";
import { settingsDenied } from "./start";

/** 07.16 (D-04, PD-07): a refusal caused by a bot's Work Zone profile names that profile, on the agent layer. */
describe("settingsDenied", () => {
  it("bot_profile → 403 on the agent layer with the profile message", () => {
    const err = settingsDenied("permissionMode", "bot_profile");
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("bot_profile");
    expect(err.denial).toEqual({
      permission: "work_session.configure",
      layer: "agent",
      reason: "bot_profile",
    });
    expect(err.message).toBe("Permission mode: Above this bot's Work Zone profile");
  });

  it("member reasons keep their layer and message", () => {
    const err = settingsDenied("model", "org_policy");
    expect(err.statusCode).toBe(403);
    expect(err.denial).toEqual({ permission: "work_session.configure", layer: "org", reason: "org_policy" });
    expect(err.message).toBe("Model: Your organization's Work Zone policy does not allow this");
  });
});
