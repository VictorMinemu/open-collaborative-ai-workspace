import { describe, expect, it } from "vitest";
import { SignInRatePerMinute } from "./env";

describe("OCW_SIGNIN_RATE_LIMIT_PER_MINUTE", () => {
  it("defaults to 30 sign-ins per minute (production brake)", () => {
    expect(SignInRatePerMinute.parse(undefined)).toBe(30);
  });

  it("accepts a raised value for test harnesses and rejects nonsense", () => {
    expect(SignInRatePerMinute.parse("600")).toBe(600);
    expect(SignInRatePerMinute.safeParse("0").success).toBe(false);
    expect(SignInRatePerMinute.safeParse("abc").success).toBe(false);
  });
});
