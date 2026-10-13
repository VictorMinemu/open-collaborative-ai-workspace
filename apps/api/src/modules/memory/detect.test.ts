import type { SensitiveFinding, SensitiveSpan } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import {
  appendedContent,
  type ChangeScanner,
  changeExcerpt,
  MAX_VIEW_SPANS,
  NO_SCANNER,
  scanChange,
} from "./detect";

/**
 * 07.2-09 (MEM-05, D-06): the detector scans only what a change adds; layer 2 (a fake scanner here) is mapped back onto
 * the resulting file and loses to layer 1 on overlap; its "unavailable" marker passes through; the view's bounds hold.
 */

const KEY = ["sk", "ant", "api03", "Zq7Lm2Np9Rt4Vx8Bc1Df6Gh3Jk5"].join("-");

/** A scanner answering `spans` (offsets into the text it is given) and recording what it saw. */
function fakeScanner(answer: (text: string) => { findings?: SensitiveFinding[]; spans?: SensitiveSpan[] }) {
  const seen: string[] = [];
  const scanner: ChangeScanner = {
    async scan(text) {
      seen.push(text);
      const a = answer(text);
      return { findings: a.findings ?? [], spans: a.spans ?? [] };
    },
  };
  return { scanner, seen };
}

const UNAVAILABLE: SensitiveFinding = {
  kind: "extended_scan_unavailable",
  severity: "info",
  source: "presidio",
  count: 0,
  samples: [],
  lines: [],
};

const kinds = (fs: readonly SensitiveFinding[]) => fs.map((f) => `${f.source}:${f.kind}`);

describe("scanChange", () => {
  it("create scans everything; line numbers and spans refer to the proposed content", async () => {
    const proposed = "# Acme\n\nContact ana@acme.com\n";
    const s = await scanChange({ base: null, proposed, op: "create" }, NO_SCANNER);
    expect(s.result).toBe(proposed);
    expect(s.findings).toEqual([
      {
        kind: "email",
        severity: "warn",
        source: "builtin",
        count: 1,
        samples: ["a•••@acme.com"],
        lines: [3],
      },
    ]);
    expect(s.spans.map((x) => proposed.slice(x.start, x.end))).toEqual(["ana@acme.com"]);
    expect([s.linesAdded, s.linesRemoved]).toEqual([3, 0]);
  });

  it("a replace that only adds a line does not report PII already in the base", async () => {
    const base = "# Acme\nContact ana@acme.com\n";
    const proposed = "# Acme\nContact ana@acme.com\nPhone +34 612 345 678\n";
    const { scanner, seen } = fakeScanner(() => ({}));
    const s = await scanChange({ base, proposed, op: "replace" }, scanner);
    expect(kinds(s.findings)).toEqual(["builtin:phone"]);
    expect(s.findings[0]?.lines).toEqual([3]);
    expect(s.spans.map((x) => proposed.slice(x.start, x.end))).toEqual(["+34 612 345 678"]);
    expect(seen).toEqual(["Phone +34 612 345 678\n"]);
    expect([s.linesAdded, s.linesRemoved]).toEqual([1, 0]);
  });

  it("append scans only the appended text; offsets and lines are in the resulting file", async () => {
    const base = "Contact ana@acme.com";
    const { scanner, seen } = fakeScanner(() => ({}));
    const s = await scanChange({ base, proposed: "Billing: bill@acme.com", op: "append" }, scanner);
    expect(s.result).toBe("Contact ana@acme.com\nBilling: bill@acme.com\n");
    expect(seen).toEqual(["Billing: bill@acme.com\n"]);
    expect(kinds(s.findings)).toEqual(["builtin:email"]);
    expect(s.findings[0]).toMatchObject({ count: 1, lines: [2], samples: ["b•••@acme.com"] });
    expect(s.spans.map((x) => s.result.slice(x.start, x.end))).toEqual(["bill@acme.com"]);
    expect([s.linesAdded, s.linesRemoved]).toEqual([1, 0]);
  });

  it("a secret anywhere in the added text is a block finding", async () => {
    const s = await scanChange(
      { base: "# Notes\n", proposed: `# Notes\nall good\nkey ${KEY}\n`, op: "replace" },
      NO_SCANNER,
    );
    expect(s.findings).toEqual([expect.objectContaining({ kind: "secret", severity: "block", lines: [3] })]);
    expect(JSON.stringify(s.findings)).not.toContain(KEY);
  });

  it("the scanner's unavailable marker passes through as an info finding", async () => {
    const { scanner } = fakeScanner(() => ({ findings: [UNAVAILABLE] }));
    const s = await scanChange({ base: null, proposed: "plain text\n", op: "create" }, scanner);
    expect(s.findings).toEqual([UNAVAILABLE]);
  });

  it("an email found by both layers is one builtin finding; a PERSON only Presidio sees is added", async () => {
    const proposed = "Ana García wrote from ana@acme.com\n";
    const { scanner } = fakeScanner((text) => ({
      spans: [
        { kind: "email", start: text.indexOf("ana@"), end: text.indexOf("ana@") + 12 },
        { kind: "person", start: 0, end: 10 },
      ],
    }));
    const s = await scanChange({ base: null, proposed, op: "create" }, scanner);
    expect(kinds(s.findings)).toEqual(["builtin:email", "presidio:person"]);
    expect(s.findings[1]).toMatchObject({ count: 1, lines: [1], samples: ["A••• G•••"], severity: "warn" });
    expect(s.spans.map((x) => `${x.kind}:${proposed.slice(x.start, x.end)}`)).toEqual([
      "person:Ana García",
      "email:ana@acme.com",
    ]);
  });

  it("layer-2 spans of a replace are mapped from the added text back onto the proposed file", async () => {
    const base = "line one\nline two\n";
    const proposed = "line one\nAna García joined\nline two\nLuis Mora left\n";
    const { scanner, seen } = fakeScanner((text) => ({
      spans: ["Ana García", "Luis Mora"].map((n) => ({
        kind: "person" as const,
        start: text.indexOf(n),
        end: text.indexOf(n) + n.length,
      })),
    }));
    const s = await scanChange({ base, proposed, op: "replace" }, scanner);
    expect(seen).toEqual(["Ana García joined\nLuis Mora left\n"]);
    expect(s.spans.map((x) => proposed.slice(x.start, x.end))).toEqual(["Ana García", "Luis Mora"]);
    expect(s.findings).toEqual([expect.objectContaining({ kind: "person", count: 2, lines: [2, 4] })]);
  });

  it("caps the view at 200 spans (by offset) while findings keep the full count (WINDOWS 126)", async () => {
    const proposed = Array.from({ length: 250 }, (_, i) => `user${i}@acme.com`).join("\n");
    const s = await scanChange({ base: null, proposed, op: "create" }, NO_SCANNER);
    expect(s.spans).toHaveLength(MAX_VIEW_SPANS);
    expect(s.spans[0]?.start).toBe(0);
    expect(s.allSpans).toHaveLength(250);
    expect(s.findings).toEqual([expect.objectContaining({ kind: "email", count: 250 })]);
    expect(s.findings[0]?.lines).toHaveLength(20);
  });
});

describe("appendedContent and changeExcerpt", () => {
  it("appends on a line of its own and always ends with a line break", () => {
    expect(appendedContent(null, "a")).toEqual({ result: "a\n", bodyStart: 0 });
    expect(appendedContent("x", "a\n")).toEqual({ result: "x\na\n", bodyStart: 2 });
    expect(appendedContent("x\n", "a")).toEqual({ result: "x\na\n", bodyStart: 2 });
  });

  it("shows only the added lines, prefixed and masked, cut at a line within 600 characters", async () => {
    const base = "Contact ana@acme.com\n";
    const s = await scanChange(
      { base, proposed: "IBAN ES91 2100 0418 4502 0005 1332\nok", op: "append" },
      NO_SCANNER,
    );
    expect(changeExcerpt(s)).toBe("+ IBAN ES91 •••• 1332\n+ ok");
    const long = await scanChange(
      { base: null, proposed: Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"), op: "create" },
      NO_SCANNER,
    );
    const ex = changeExcerpt(long);
    expect(ex.length).toBeLessThanOrEqual(600);
    expect(ex.endsWith("\n")).toBe(false);
    expect(ex.split("\n").every((l) => /^\+ line \d+$/.test(l))).toBe(true);
    const one = await scanChange({ base: null, proposed: "x".repeat(700), op: "create" }, NO_SCANNER);
    expect(changeExcerpt(one)).toHaveLength(600);
    expect(changeExcerpt(one).endsWith("…")).toBe(true);
  });
});
