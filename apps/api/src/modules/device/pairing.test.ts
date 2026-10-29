import { normalizeUserCode, USER_CODE_ALPHABET } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/crypto";
import { generateUserCode, pairingEnrollmentHash } from "./pairing";
import { normalizePairingCode } from "./routes";

const FORMATTED = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

describe("generateUserCode (D-03: 8 Crockford symbols, shown XXXX-XXXX)", () => {
  it("returns 8 symbols of the alphabet, formatted, and normalizes back to itself", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateUserCode();
      expect(code).toMatch(FORMATTED);
      const canonical = normalizeUserCode(code);
      expect(canonical).toBe(code.replace("-", ""));
      expect(normalizeUserCode(code.toLowerCase().replace("-", " "))).toBe(canonical);
      for (const symbol of canonical!) expect(USER_CODE_ALPHABET).toContain(symbol);
    }
  });

  it("draws every symbol of the alphabet (no bias toward a subset)", () => {
    const seen = new Map<string, number>();
    for (let i = 0; i < 2_000; i++) {
      for (const symbol of generateUserCode().replace("-", "")) seen.set(symbol, (seen.get(symbol) ?? 0) + 1);
    }
    expect([...seen.keys()].sort()).toEqual([...USER_CODE_ALPHABET].sort());
    // 16,000 draws over 32 symbols: 500 expected each; a uniform draw stays far inside these bounds.
    for (const n of seen.values()) {
      expect(n).toBeGreaterThan(350);
      expect(n).toBeLessThan(650);
    }
  });
});

describe("pairingEnrollmentHash (PD-06: domain-separated from the typed-code hash)", () => {
  it("is deterministic, hex and differs from the typed-code hash of the same text", () => {
    const deviceCode = "ABCDEFGHJKMNPQRSTUVWXYZ23456789abcdefgh";
    expect(pairingEnrollmentHash(deviceCode)).toBe(pairingEnrollmentHash(deviceCode));
    expect(pairingEnrollmentHash(deviceCode)).toMatch(/^[0-9a-f]{64}$/);
    expect(pairingEnrollmentHash(deviceCode)).toBe(sha256Hex(`pair:${deviceCode}`));
    expect(pairingEnrollmentHash(deviceCode)).not.toBe(sha256Hex(normalizePairingCode(deviceCode)));
    expect(pairingEnrollmentHash(deviceCode)).not.toBe(sha256Hex(deviceCode));
  });
});
