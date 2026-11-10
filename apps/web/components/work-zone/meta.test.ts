import { describe, expect, it } from "vitest";
import { controlReasonText } from "./meta";

/** P-08 and 07.16 (D-04, PD-07): why an option is unavailable, in one sentence. */
describe("controlReasonText", () => {
  const ctx = { runtime: "claude-code" } as const;

  it("bot_profile names the bot's Work Zone profile", () => {
    expect(controlReasonText({ reason: "bot_profile", detail: null }, ctx)).toBe(
      "Above this bot's Work Zone profile",
    );
  });

  it("member reasons are unchanged", () => {
    expect(controlReasonText({ reason: "org_policy", detail: null }, ctx)).toBe(
      "Not allowed by your organization",
    );
    expect(controlReasonText({ reason: "not_confirmed", detail: null }, ctx)).toBeNull();
    expect(controlReasonText({ reason: null, detail: null }, ctx)).toBeNull();
  });
});
