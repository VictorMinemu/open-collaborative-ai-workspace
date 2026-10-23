import { describe, expect, it, vi } from "vitest";
import { accessLostCopy, leftProjectLine } from "./session-view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

/** The session view's words for a lost session and for a creator who left the project (07.9-10, R7, D-12). */
describe("session view words", () => {
  it("says why the session went away, with today's words for every cause but visibility (R7)", () => {
    expect(accessLostCopy("visibility", "Ana Ruiz")).toEqual({
      title: "You can no longer see this session",
      description: "Who can see it changed. Ask Ana Ruiz if you need it back.",
    });
    expect(accessLostCopy("visibility", null).description).toBe(
      "Who can see it changed. Ask the owner if you need it back.",
    );
    for (const cause of ["role", "device", "module", null]) {
      expect(accessLostCopy(cause, "Ana Ruiz")).toEqual({
        title: "You no longer have access to this session",
        description: "Your role or permissions changed. Ask an admin if you need it back.",
      });
    }
  });

  it("replaces the composer for a creator who left the project (D-12)", () => {
    expect(leftProjectLine("Customer portal")).toBe(
      "You left Customer portal. You can still read and archive this session.",
    );
  });

  it("never uses the words ACL, grant, audience, scope or visibility rule (N4)", () => {
    const words = [
      ...Object.values(accessLostCopy("visibility", "Ana")),
      ...Object.values(accessLostCopy("role", "Ana")),
      leftProjectLine("Customer portal"),
    ].join(" ");
    expect(words).not.toMatch(/\b(acl|grant|grants|audience|scope|visibility rule)\b/i);
  });
});
