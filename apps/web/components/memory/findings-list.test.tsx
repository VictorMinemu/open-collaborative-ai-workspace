import type { SensitiveFinding } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FindingsList } from "./findings-list";

/**
 * The findings of a memory proposal review (07.2-13, MEM-05, UI-SPEC "Accessibility Contract › Findings"): one row per
 * warn or block finding with its kind, severity chip, count, masked samples and lines; the extended-scan state as a
 * polite status; never a raw value (T-07.2-13-04). Static markup in node.
 */

const finding = (over: Partial<SensitiveFinding>): SensitiveFinding => ({
  kind: "email",
  severity: "warn",
  source: "builtin",
  count: 1,
  samples: ["a•••@acme.com"],
  lines: [3],
  ...over,
});

const html = (findings: SensitiveFinding[]) => renderToStaticMarkup(<FindingsList findings={findings} />);
const decode = (s: string) =>
  s
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

describe("FindingsList", () => {
  it("lists every warn finding with its kind, Check chip, count, masked samples and lines", () => {
    const out = html([
      finding({}),
      finding({ kind: "iban", count: 2, samples: ["ES91 •••• 1332", "ES12 •••• 0001"], lines: [4, 7] }),
    ]);
    expect(out).toContain('<ul aria-label="Sensitive data"');
    expect(out.match(/data-testid="finding"/g)).toHaveLength(2);
    expect(out).toContain('data-kind="email"');
    expect(out).toContain(">Email<");
    expect(out).toContain(">IBAN<");
    expect(out.match(/>Check</g)).toHaveLength(2);
    expect(out).toContain("1 found");
    expect(out).toContain("2 found");
    expect(out).toContain("a•••@acme.com");
    expect(out).toContain("ES91 •••• 1332");
    expect(out).toContain("Line 3");
    expect(out).toContain("Lines 4, 7");
  });

  it("names block findings Blocked and info findings Info", () => {
    const out = html([
      finding({ kind: "secret", severity: "block", samples: ["sk-a••••"] }),
      finding({ kind: "person", severity: "info", source: "presidio" }),
    ]);
    expect(out).toContain(">Secret<");
    expect(out).toContain(">Blocked<");
    expect(out).toContain(">Person name<");
    expect(out).toContain(">Info<");
  });

  it("shows the extended scan as unavailable in a polite status, without listing it as a finding", () => {
    const out = decode(
      html([
        finding({}),
        finding({
          kind: "extended_scan_unavailable",
          severity: "info",
          source: "presidio",
          count: 0,
          samples: [],
          lines: [],
        }),
      ]),
    );
    expect(out).toMatch(/role="status"[^>]*>.*Extended scan unavailable — review the text yourself/s);
    expect(out.match(/data-testid="finding"/g)).toHaveLength(1);
  });

  it("shows the incomplete variant when the extended scan was partial", () => {
    const out = decode(
      html([
        finding({
          kind: "extended_scan_partial",
          severity: "info",
          source: "presidio",
          count: 0,
          samples: [],
          lines: [],
        }),
      ]),
    );
    expect(out).toContain("Extended scan incomplete — review the text yourself");
    expect(out).toContain('role="status"');
    expect(out).toContain("No sensitive data found");
  });

  it("says so when nothing was found", () => {
    const out = html([]);
    expect(out).toContain("No sensitive data found");
    expect(out).not.toContain('data-testid="finding"');
    expect(out).not.toContain('role="status"');
  });

  it("never renders a raw value: only the masked samples it was given", () => {
    const out = html([finding({ kind: "iban", samples: ["ES91 •••• 1332"] })]);
    expect(out).not.toMatch(/ES91\s?2100/);
    expect(out).not.toContain("ana@acme.com");
  });
});
