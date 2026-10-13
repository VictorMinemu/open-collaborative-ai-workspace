// redact() parity (07.2-04, D-08): the secret rules moved to @ocw/contracts, and the device's redaction must stay
// byte-identical. The fixture was captured from sanitize.ts before the move and is never regenerated.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { redact } from "./sanitize.js";

const Fixture = z.object({
  description: z.string(),
  capturedAt: z.string(),
  entries: z
    .array(z.object({ name: z.string().min(1), input: z.array(z.string()).min(1), output: z.string() }))
    .min(40),
});

const fixture = Fixture.parse(
  JSON.parse(readFileSync(new URL("./redact-parity.fixture.json", import.meta.url), "utf8")),
);
// Inputs are stored in parts so no credential-shaped literal appears whole in the fixture.
const corpus = fixture.entries.map((e) => ({ name: e.name, input: e.input.join(""), output: e.output }));

describe("redact() parity with the outputs captured before the rules moved", () => {
  it("has unique entry names", () => {
    expect(new Set(corpus.map((e) => e.name)).size).toBe(corpus.length);
  });

  for (const { name, input, output } of corpus) {
    it(`matches the captured output byte for byte: ${name}`, () => {
      expect(redact(input)).toBe(output);
    });
  }

  it("is idempotent on the whole corpus", () => {
    for (const { input } of corpus) expect(redact(redact(input))).toBe(redact(input));
  });

  it("gives the same output when called twice in a row (no shared regex state)", () => {
    for (const { input } of corpus) {
      const first = redact(input);
      expect(redact(input)).toBe(first);
    }
  });
});
