import { describe, expect, it } from "vitest";
import { readReviewToken, reviewTokenOf } from "./packages.js";

// The review token's MAC is 32 bytes, 43 base64url characters: the last character carries only 4 bits, so its 2 low
// bits are padding that a lenient decoder ignores. A token whose MAC differs only there names the same bytes. The
// 07.9-15 gate found the integration test's forgery (the last two characters replaced by "xx") accepted that way, about
// once in 1,024 runs. Only the canonical spelling of the MAC is accepted.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const core = {
  env: { BETTER_AUTH_SECRET: "unit-test-secret-0123456789abcdef0123456789abcdef" },
} as Parameters<typeof reviewTokenOf>[0];
const ORG = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const pin = {
  source: "npm",
  name: "is-even",
  version: "1.0.0",
  sha256: "a".repeat(64),
  treeSha256: "b".repeat(64),
} as Parameters<typeof reviewTokenOf>[2];

/** The same MAC bytes, spelled with other padding bits in the last character. */
function nonCanonical(token: string): string {
  const last = token.at(-1) as string;
  const i = ALPHABET.indexOf(last);
  return `${token.slice(0, -1)}${ALPHABET[i ^ 1]}`;
}

describe("the sandbox package review token", () => {
  it("verifies the token it minted, in its organization only", () => {
    const token = reviewTokenOf(core, ORG, pin);
    expect(readReviewToken(core, ORG, token)).toMatchObject({ name: "is-even", version: "1.0.0" });
    expect(readReviewToken(core, "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c", token)).toBeNull();
  });

  it("refuses a MAC that is not spelled canonically, even when it decodes to the same bytes", () => {
    const token = reviewTokenOf(core, ORG, pin);
    const variant = nonCanonical(token);
    expect(variant).not.toBe(token);
    const mac = (s: string) => Buffer.from(s.split(".")[2] as string, "base64url");
    expect(mac(variant).equals(mac(token))).toBe(true);
    expect(readReviewToken(core, ORG, variant)).toBeNull();
  });

  it("refuses the integration test's forgery whatever the MAC's last characters were", () => {
    const token = reviewTokenOf(core, ORG, pin);
    for (const tail of ["xx", "wx", "xy", "AA", "__"]) {
      const forged = `${token.slice(0, -2)}${tail}`;
      if (forged === token) continue;
      expect(readReviewToken(core, ORG, forged)).toBeNull();
    }
  });
});
