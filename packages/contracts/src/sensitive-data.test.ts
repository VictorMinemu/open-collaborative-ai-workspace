import { describe, expect, it } from "vitest";
import { SensitiveFinding, SensitiveSpan } from "./memory";
import {
  detectSensitive,
  hasBlockingFinding,
  ibanOk,
  luhnOk,
  nieOk,
  nifOk,
  redactSecrets,
  SECRET_RULES,
} from "./sensitive-data";

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

describe("checksums", () => {
  it("ibanOk: mod-97 on known-valid samples, spaces ignored", () => {
    expect(ibanOk("ES91 2100 0418 4502 0005 1332")).toBe(true);
    expect(ibanOk("GB82WEST12345698765432")).toBe(true);
    expect(ibanOk("ES91 2100 0418 4502 0005 1333")).toBe(false);
    expect(ibanOk("GB82WEST12345698765433")).toBe(false);
    expect(ibanOk("ES91")).toBe(false);
  });

  it("luhnOk: 13-19 digits passing Luhn", () => {
    expect(luhnOk("4111111111111111")).toBe(true);
    expect(luhnOk("4111 1111 1111 1111")).toBe(true);
    expect(luhnOk("4111111111111112")).toBe(false);
    expect(luhnOk("411111111111")).toBe(false);
    expect(luhnOk("41111111111111111111")).toBe(false);
  });

  it("nifOk and nieOk: the control letter", () => {
    expect(nifOk("12345678Z")).toBe(true);
    expect(nifOk("12345678A")).toBe(false);
    expect(nieOk("X1234567L")).toBe(true);
    expect(nieOk("X1234567T")).toBe(false);
    expect(nieOk("Y1234567X")).toBe(true);
    expect(nieOk("A1234567L")).toBe(false);
  });
});

// The PII values below are public test samples (Visa test number, documentation IBANs, the textbook NIF/NIE).
const NOTE = [
  `Deploy key: ${ANTHROPIC}`,
  "IBAN ES91 2100 0418 4502 0005 1332",
  "Card 4111 1111 1111 1111 for the trial",
  "NIF 12345678Z and NIE X1234567L",
  "Write to ana@acme.com",
  "Call +34 612 345 678 or 912345678",
].join("\n");

const RAW_VALUES = [
  ANTHROPIC,
  "ES91 2100 0418 4502 0005 1332",
  "ES9121000418450200051332",
  "4111 1111 1111 1111",
  "4111111111111111",
  "12345678Z",
  "X1234567L",
  "ana@acme.com",
  "+34 612 345 678",
  "612 345 678",
  "912345678",
];

const byKind = (findings: readonly SensitiveFinding[]) =>
  Object.fromEntries(findings.map((f) => [f.kind, f]));

describe("detectSensitive()", () => {
  it("blocks the secret and warns once per PII kind with counts, lines and masked samples", () => {
    const { findings } = detectSensitive(NOTE);
    expect(findings.map((f) => f.kind)).toEqual([
      "secret",
      "iban",
      "payment_card",
      "es_nif",
      "es_nie",
      "email",
      "phone",
    ]);
    const k = byKind(findings);
    expect(k.secret).toEqual({
      kind: "secret",
      severity: "block",
      source: "builtin",
      count: 1,
      samples: ["sk-a••••"],
      lines: [1],
    });
    expect(k.iban).toMatchObject({
      severity: "warn",
      source: "builtin",
      count: 1,
      samples: ["ES91 •••• 1332"],
      lines: [2],
    });
    expect(k.payment_card).toMatchObject({ severity: "warn", count: 1, samples: ["•••• 1111"], lines: [3] });
    expect(k.es_nif).toMatchObject({ severity: "warn", count: 1, samples: ["•••••678Z"], lines: [4] });
    expect(k.es_nie).toMatchObject({ severity: "warn", count: 1, samples: ["•••••567L"], lines: [4] });
    expect(k.email).toMatchObject({ severity: "warn", count: 1, samples: ["a•••@acme.com"], lines: [5] });
    expect(k.phone).toMatchObject({
      severity: "warn",
      count: 2,
      samples: ["+34 ••• ••• 678", "••• ••• 678"],
      lines: [6],
    });
    for (const f of findings) expect(SensitiveFinding.safeParse(f).success).toBe(true);
  });

  it("never serialises a raw value", () => {
    const serialised = JSON.stringify(detectSensitive(NOTE).findings);
    for (const raw of RAW_VALUES) expect(serialised).not.toContain(raw);
  });

  it("returns spans over exactly the detected text", () => {
    const { spans } = detectSensitive(NOTE);
    const text = (kind: string) =>
      spans.filter((s) => s.kind === kind).map((s) => NOTE.slice(s.start, s.end));
    expect(text("iban")).toEqual(["ES91 2100 0418 4502 0005 1332"]);
    expect(text("payment_card")).toEqual(["4111 1111 1111 1111"]);
    expect(text("phone")).toEqual(["+34 612 345 678", "912345678"]);
    expect(text("secret")).toEqual([ANTHROPIC]);
    expect(spans.map((s) => s.start)).toEqual([...spans.map((s) => s.start)].sort((a, b) => a - b));
    for (const s of spans) expect(SensitiveSpan.safeParse(s).success).toBe(true);
  });

  it("does not flag checksum-invalid look-alikes", () => {
    const text = "Order 1234567812345678\nIBAN ES00 2100 0418 4502 0005 1332\nNIF 12345678A, NIE X1234567T";
    expect(detectSensitive(text).findings).toEqual([]);
  });

  it("finds an IBAN followed by an upper case word (the run is cut back to the valid prefix)", () => {
    const text = "Pay to ES91 2100 0418 4502 0005 1332 BIC CAIXESBBXXX today";
    const { findings, spans } = detectSensitive(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "iban", samples: ["ES91 •••• 1332"] });
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["ES91 2100 0418 4502 0005 1332"]);
  });

  it("restricts the report to opts.lines (1-based)", () => {
    const text = "first line\nmail ana@acme.com\nthird line";
    expect(detectSensitive(text, { lines: [3] })).toEqual({ findings: [], spans: [] });
    expect(detectSensitive(text, { lines: [2] }).findings.map((f) => f.kind)).toEqual(["email"]);
    expect(detectSensitive(text, { lines: [] }).findings).toEqual([]);
  });

  it("reports a multi-line secret when any of its lines is scanned", () => {
    const text = fake(
      "intro\n-----BEGIN RSA ",
      "PRIVATE KEY-----\nMIIE\nabcd\n-----END RSA ",
      "PRIVATE KEY-----\nend",
    );
    const { findings } = detectSensitive(text, { lines: [4] });
    expect(findings).toEqual([expect.objectContaining({ kind: "secret", count: 1, lines: [2] })]);
  });

  it("does not report PII inside a secret's span (a token's digit runs are not a card or a phone)", () => {
    const card = "4111111111111111";
    expect(detectSensitive(`x ${card} y`).findings.map((f) => f.kind)).toEqual(["payment_card"]);
    const bearer = detectSensitive(fake("Authorization: Bear", `er abc.${card}.def`)).findings;
    expect(bearer.map((f) => f.kind)).toEqual(["secret"]);

    expect(detectSensitive("sig-612345678-tail").findings.map((f) => f.kind)).toEqual(["phone"]);
    const jwt = detectSensitive(
      fake("eyJ", "hbGciOiJIUzI1NiJ9.eyJ", "zdWIiOiIxMjM0In0.sig-612345678-tail"),
    ).findings;
    expect(jwt.map((f) => f.kind)).toEqual(["secret"]);
  });

  it("does not count an already redacted value as a secret", () => {
    expect(detectSensitive("git clone https://bob:[REDACTED]@github.com/x/y").findings).toEqual([]);
    expect(detectSensitive("ANTHROPIC_API_KEY=[REDACTED] and [REDACTED:jwt]").findings).toEqual([]);
  });

  it("finds every secret redactSecrets would redact", () => {
    const text = [
      fake("export DB_PASSWORD=", '"hunter2hunter2"'),
      fake("aws_secret_access_key = ", "wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY"),
      fake("https://bob:", "hunter2hunter2", "@github.com"),
      fake("AK", "IAIOSFODNN7EXAMPLE"),
    ].join("\n");
    const secret = detectSensitive(text).findings[0];
    expect(secret).toMatchObject({ kind: "secret", severity: "block", count: 4, lines: [1, 2, 3, 4] });
    expect(secret?.samples).toHaveLength(3);
  });

  it("is deterministic: the same input twice gives deep-equal results", () => {
    expect(detectSensitive(NOTE)).toEqual(detectSensitive(NOTE));
    expect(detectSensitive(NOTE, { lines: [2, 6] })).toEqual(detectSensitive(NOTE, { lines: [2, 6] }));
  });

  it("caps samples at 3 and lines at 20 per finding, keeping the full count", () => {
    const text = Array.from({ length: 30 }, (_, i) => `user${i}@team${i}.example.com`).join("\n");
    const [email] = detectSensitive(text).findings;
    expect(email?.count).toBe(30);
    expect(email?.samples).toHaveLength(3);
    expect(email?.lines).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(SensitiveFinding.safeParse(email).success).toBe(true);
  });

  it("keeps a sample within the 80-character limit for a very long email domain", () => {
    const domain = `${Array.from({ length: 8 }, () => "d".repeat(40)).join(".")}.com`;
    const [email] = detectSensitive(`ana@${domain}`).findings;
    expect(email?.samples[0]?.length).toBeLessThanOrEqual(80);
    expect(SensitiveFinding.safeParse(email).success).toBe(true);
  });

  it("returns nothing for empty or clean text", () => {
    expect(detectSensitive("")).toEqual({ findings: [], spans: [] });
    expect(detectSensitive("Plain notes about the roadmap, 2026-10-12, v1.2.3.").findings).toEqual([]);
  });

  it("scans a 256 KiB adversarial input in under 200 ms", () => {
    const chunk = 64 * 1024;
    const text = [
      "1".repeat(chunk),
      "1 ".repeat(chunk / 2),
      "a@".repeat(chunk / 2),
      "+3 ".repeat(chunk / 6),
      fake("-----BEGIN RSA ", "PRIVATE KEY-----\n"),
      "-----BEGIN ",
      "A".repeat(chunk),
    ].join("");
    expect(text.length).toBeGreaterThanOrEqual(256 * 1024);
    detectSensitive(text.slice(0, 1024));
    const t0 = performance.now();
    detectSensitive(text);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

// Backtracking-heavy shapes: before 07.2-04 the URL-credential rule took ~17 s on 256 KiB of `a.`, the JWT rule ~5 s on
// `eyJaaaaaaaa-` and the env-assignment rule ~5 s on `SECRET` (a run with many start positions, each rescanned).
const ADVERSARIAL_SHAPES = [
  "a.",
  "a-",
  "sk-",
  "1.",
  "eyJaaaaaaaa-",
  "SECRET",
  "A_TOKEN ",
  "a://x:",
  "1 ",
  "a@",
  "+3 ",
  "AB12 ",
];

describe("linear time on adversarial runs", () => {
  const sized = (shape: string, size: number) => shape.repeat(Math.ceil(size / shape.length)).slice(0, size);
  /**
   * Best of seven interleaved passes per size, after a warm-up. Interleaving makes a busy shared CI runner slow both
   * sizes alike, so the ratio stays stable; a super-linear rule is slow on every pass.
   */
  const bestPair = (fn: (text: string) => unknown, small: string, large: string): [number, number] => {
    fn(small);
    fn(large);
    let a = Number.POSITIVE_INFINITY;
    let b = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 5; i++) {
      let t0 = performance.now();
      fn(small);
      a = Math.min(a, performance.now() - t0);
      t0 = performance.now();
      fn(large);
      b = Math.min(b, performance.now() - t0);
    }
    return [a, b];
  };
  for (const shape of ADVERSARIAL_SHAPES) {
    it(`detectSensitive and redactSecrets scale linearly on ${JSON.stringify(shape)} repeated`, () => {
      for (const fn of [detectSensitive, redactSecrets]) {
        // 1 MiB → 4 MiB keeps both timings at several milliseconds, where scheduler noise cannot swing the ratio.
        const [small, large] = bestPair(fn, sized(shape, 1024 * 1024), sized(shape, 4 * 1024 * 1024));
        // 4x the input: about 4x the time when linear, 16x when quadratic (the ReDoS took 17 s at 256 KiB). The 2 ms
        // floor stops a tiny baseline from inflating the ratio; the absolute cap still catches a catastrophic rule.
        expect(large / Math.max(small, 2)).toBeLessThan(12);
        expect(large).toBeLessThan(4000);
      }
      // Two functions × (warm-up + 5 interleaved rounds) of 1 + 4 MiB: about 9 s on a laptop and more on a shared CI
      // runner (pipeline 75 hit the 15 s default). The budget is the assertions above, not this timeout.
    }, 60_000);
  }
});

// The literals the three rewritten rules had before 07.2-04 (identical to the Local Runtime's former REDACTIONS): the
// oracle. The rewrites only stop rescanning a run from every start position; matches, groups and offsets are the same.
const ORIGINAL_RULES: Record<string, RegExp> = {
  jwt: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  "url-credentials": /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi,
  "env-assignment":
    /\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY)[A-Z0-9_]*)(\s*=\s*["']?)(?!\[REDACTED)[^\s"']{6,}/g,
};

/** Tokens that exercise every branch of each rule (boundaries, separators, keywords, placeholders). */
const FUZZ_TOKENS: Record<string, readonly string[]> = {
  jwt: [..."eyJ.-_ x1é\n", "eyJ", "eyJ", "ab", "abcd", "abcdefgh", "abcdefgh", ".", "eyJabcdefgh."],
  "url-credentials": [
    ..."abZx19_.-+:/@ \n\t\"'[]é",
    "http",
    "https",
    "://",
    "://",
    "u:p@",
    "git+ssh",
    "[REDACTED]",
  ],
  "env-assignment": [
    ..."aZ19_.- \n\t=\"'[]é",
    "SECRET",
    "TOKEN",
    "API_KEY",
    "PASSWD",
    "[REDACTED",
    "abcdefgh",
  ],
};

function fuzzCorpus(tokens: readonly string[], count: number, seed: number): string[] {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  return Array.from({ length: count }, () => {
    let s = "";
    const n = 1 + Math.floor(next() * 32);
    for (let i = 0; i < n; i++) s += tokens[Math.floor(next() * tokens.length)];
    return s;
  });
}

const matches = (source: string, flags: string, text: string) =>
  [...text.matchAll(new RegExp(source, flags))].map((m) => [m.index, ...m]);

describe("SECRET_RULES rewritten for linear time match the original rules exactly", () => {
  for (const [id, original] of Object.entries(ORIGINAL_RULES)) {
    it(`${id}: same matches, groups and offsets on a seeded random corpus`, () => {
      const corpus = fuzzCorpus(FUZZ_TOKENS[id] ?? [], 40_000, 2026);
      const rule = SECRET_RULES.find((r) => r.id === id);
      expect(rule).toBeDefined();
      let hits = 0;
      for (const text of corpus) {
        const expected = matches(original.source, original.flags, text);
        if (expected.length > 0) hits++;
        expect(matches(rule?.source ?? "", rule?.flags ?? "", text)).toEqual(expected);
      }
      expect(hits).toBeGreaterThan(100);
    });
  }
});

describe("hasBlockingFinding()", () => {
  it("is true only with a block finding", () => {
    expect(hasBlockingFinding(detectSensitive(NOTE).findings)).toBe(true);
    expect(hasBlockingFinding(detectSensitive("mail ana@acme.com").findings)).toBe(false);
    expect(hasBlockingFinding([])).toBe(false);
  });
});
