import type { MeResponse } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "./api";
import { signedInMe } from "./queries";

const me = { user: { id: "u1" } } as unknown as MeResponse;

describe("signedInMe (the one rule every auth guard uses, 07.8-29)", () => {
  it("is the member while /me answers", () => {
    expect(signedInMe({ data: me, error: null })).toBe(me);
  });

  it("is null before /me answered", () => {
    expect(signedInMe({ data: undefined, error: null })).toBeNull();
  });

  it("is null when /me answered 401, even with the last /me still cached (an ended session)", () => {
    expect(
      signedInMe({ data: me, error: new ApiRequestError(401, "unauthorized", "Unauthorized") }),
    ).toBeNull();
  });

  it("keeps the member through other failures (offline, 5xx): only a 401 ends the session", () => {
    expect(signedInMe({ data: me, error: new ApiRequestError(503, "unavailable", "Down") })).toBe(me);
    expect(signedInMe({ data: me, error: new Error("network") })).toBe(me);
  });
});
