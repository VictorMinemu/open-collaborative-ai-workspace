import { getResolvedPDFJS } from "unpdf";
import { describe, expect, it } from "vitest";
import { makePdf } from "../../../testing-pdf";
import { pdfText } from "./pdf";

/**
 * 07.15-05 (BRA-02, D-05, D-12, PD-07): a PDF's text for a bot, parsed only inside a bounded Worker (unpdf 1.9.1,
 * PDF.js without eval), never on the API's event loop. Every failure is a fixed code.
 */

const CAPS = { pages: 100, chars: 64_000, ms: 10_000, heapMb: 256 };

/** `a.b.c` ≥ `x.y.z`, numerically. */
function atLeast(version: string, min: string): boolean {
  const a = version.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

describe("pdfText", () => {
  it("returns both pages' text in page order through the worker", async () => {
    const bytes = makePdf(["Invoice 42 total 1300 EUR", "Second page: paid"]);
    const out = await pdfText(bytes, CAPS);
    expect(out).toMatchObject({ ok: true, pages: 2, totalPages: 2, truncated: false });
    if (!out.ok) throw new Error("expected text");
    const first = out.text.indexOf("Invoice 42 total 1300 EUR");
    const second = out.text.indexOf("Second page: paid");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
  });

  it("bundles a PDF.js at least 4.2.67 (CVE-2024-4367 fixed)", async () => {
    const pdfjs = await getResolvedPDFJS();
    expect(atLeast(pdfjs.version, "4.2.67")).toBe(true);
  });

  it("leaves the caller's bytes usable: the worker got a fresh copy", async () => {
    const bytes = makePdf(["Kept"]);
    const before = bytes.byteLength;
    await pdfText(bytes, CAPS);
    expect(bytes.byteLength).toBe(before);
    expect(bytes.buffer.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe("%PDF-1.4");
  });
});
