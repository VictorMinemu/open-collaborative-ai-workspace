import { describe, expect, it } from "vitest";
import { redactSecrets, SECRET_RULES } from "./sensitive-data";

// Fake credentials are assembled at runtime so secret scanners do not flag this file.
const fake = (...parts: string[]) => parts.join("");
const ANTHROPIC = fake("sk-", "ant-api03-", "abcdefghijklmnopqrstuvwxyz0123");

describe("SECRET_RULES", () => {
  it("has unique ids, global flags and compiles every source", () => {
    expect(new Set(SECRET_RULES.map((r) => r.id)).size).toBe(SECRET_RULES.length);
    for (const r of SECRET_RULES) {
      expect(r.flags).toContain("g");
      expect(() => new RegExp(r.source, r.flags)).not.toThrow();
    }
  });

  it("is frozen, so no caller can loosen a rule at runtime", () => {
    expect(Object.isFrozen(SECRET_RULES)).toBe(true);
    for (const r of SECRET_RULES) expect(Object.isFrozen(r)).toBe(true);
  });
});

describe("redactSecrets()", () => {
  it("redacts and keeps the surrounding text", () => {
    expect(redactSecrets(`key ${ANTHROPIC} end`)).toBe("key [REDACTED:anthropic-key] end");
    expect(redactSecrets(fake("export DB_PASSWORD=", '"hunter2hunter2"'))).toBe(
      'export DB_PASSWORD="[REDACTED]"',
    );
  });

  it("returns empty and secret-free text unchanged", () => {
    expect(redactSecrets("")).toBe("");
    expect(redactSecrets("const API_KEY: z.string();")).toBe("const API_KEY: z.string();");
  });

  it("is idempotent and gives the same output twice in a row", () => {
    const input = `${ANTHROPIC} Bearer abcdefghijkl ${fake("AK", "IAIOSFODNN7EXAMPLE")}`;
    const once = redactSecrets(input);
    expect(redactSecrets(once)).toBe(once);
    expect(redactSecrets(input)).toBe(once);
  });
});
