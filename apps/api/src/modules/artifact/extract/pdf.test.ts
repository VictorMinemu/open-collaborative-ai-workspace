import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { getResolvedPDFJS } from "unpdf";
import { describe, expect, it } from "vitest";
import { GARBAGE_PDF, makeEncryptedPdf, makeFlateBombPdf, makePdf } from "../../../testing-pdf";
import { EXTRACT_LIMITS } from "./limits";
import { pdfText, pdfWorkersInFlight } from "./pdf";

/**
 * 07.15-05 (BRA-02, D-05, D-12, PD-07), CR-01: a PDF's text for a bot, parsed only inside a bounded child process
 * (unpdf 1.9.1, PDF.js without eval), never in the API process. Every failure is a fixed code.
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

describe("pdfText bounds and failures", () => {
  it("reads only the first 100 pages and reports the total", async () => {
    const bytes = makePdf(Array.from({ length: 105 }, (_, i) => `page${i + 1}`));
    const out = await pdfText(bytes, CAPS);
    expect(out).toMatchObject({ ok: true, pages: 100, totalPages: 105, truncated: true });
    if (!out.ok) throw new Error("expected text");
    expect(out.text).toContain("page100");
    expect(out.text).not.toContain("page101");
  });

  it("returns at most chars code units and marks the text truncated", async () => {
    const pages = ["a", "b", "c"].map((c) => c.repeat(30_000));
    const out = await pdfText(makePdf(pages), { ...CAPS, chars: 64_000 });
    expect(out).toMatchObject({ ok: true, truncated: true });
    if (!out.ok) throw new Error("expected text");
    expect(out.text.length).toBe(64_000);
  });

  it("IN-03: a PDF with text is never no_text_layer because the turn had only a few characters left", async () => {
    // Page 1 has no text, so the extracted text starts with the blank line between pages.
    const out = await pdfText(makePdf(["", "Second page has the text"]), { ...CAPS, chars: 1 });
    expect(out).toMatchObject({ ok: true, truncated: true });
    if (!out.ok) throw new Error("expected text");
    expect(out.text).toHaveLength(1);
  });

  it("answers no_text_layer for a PDF whose pages have no text", async () => {
    expect(await pdfText(makePdf(["", ""]), CAPS)).toEqual({ ok: false, code: "no_text_layer" });
  });

  it("answers encrypted for a password-protected PDF", async () => {
    expect(await pdfText(makeEncryptedPdf(), CAPS)).toEqual({ ok: false, code: "encrypted" });
  });

  it("answers extraction_failed for random bytes behind a PDF header", async () => {
    expect(await pdfText(GARBAGE_PDF, CAPS)).toEqual({ ok: false, code: "extraction_failed" });
  });
});

/**
 * Hostile extractors (E12): a process stuck in a synchronous loop, one that exhausts its heap, and one that sends a
 * forged message. `pdfText` resolves only after its process has exited, so the in-flight count returning to 0 proves
 * the process is gone and the slot was given back.
 */
describe("pdfText under hostile workers", () => {
  const HANG = new URL("./fixtures/hang-worker.mjs", import.meta.url);
  const OOM = new URL("./fixtures/oom-worker.mjs", import.meta.url);
  const enc = (s: string) => new TextEncoder().encode(s);

  it("terminates a worker that never answers at the deadline: timeout", async () => {
    const started = Date.now();
    const out = await pdfText(enc("spin"), { ...CAPS, ms: 300 }, { workerUrl: HANG });
    expect(out).toEqual({ ok: false, code: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(pdfWorkersInFlight()).toBe(0);
  });

  it("answers extraction_failed when the worker exhausts its heap", async () => {
    const started = Date.now();
    const out = await pdfText(enc("grow"), { ...CAPS, heapMb: 16 }, { workerUrl: OOM });
    expect(out).toEqual({ ok: false, code: "extraction_failed" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(pdfWorkersInFlight()).toBe(0);
  });

  it("answers busy at once while two reads are in flight, and starts workers again once they end", async () => {
    expect(EXTRACT_LIMITS.pdfConcurrency).toBe(2);
    const first = pdfText(enc("spin"), { ...CAPS, ms: 1_000 }, { workerUrl: HANG });
    const second = pdfText(enc("spin"), { ...CAPS, ms: 1_000 }, { workerUrl: HANG });
    expect(pdfWorkersInFlight()).toBe(2);
    const started = Date.now();
    expect(await pdfText(makePdf(["Third"]), CAPS)).toEqual({ ok: false, code: "busy" });
    expect(Date.now() - started).toBeLessThan(50);
    expect(await first).toEqual({ ok: false, code: "timeout" });
    expect(await second).toEqual({ ok: false, code: "timeout" });
    expect(pdfWorkersInFlight()).toBe(0);
    expect(await pdfText(makePdf(["Fourth"]), CAPS)).toMatchObject({ ok: true, pages: 1 });
  });

  it("answers extraction_failed for a malformed worker message", async () => {
    const out = await pdfText(enc("malformed"), CAPS, { workerUrl: HANG });
    expect(out).toEqual({ ok: false, code: "extraction_failed" });
    expect(pdfWorkersInFlight()).toBe(0);
  });

  it("answers extraction_failed when the worker script cannot start, and gives the slot back", async () => {
    const missing = new URL("./fixtures/no-such-worker.mjs", import.meta.url);
    expect(await pdfText(enc("x"), CAPS, { workerUrl: missing })).toEqual({
      ok: false,
      code: "extraction_failed",
    });
    expect(pdfWorkersInFlight()).toBe(0);
  });
});

/** Whether `pid` is still a live process (signal 0 only checks; ESRCH means it is gone and reaped). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Runs `fn` while sampling this process's resident memory every 10 ms; returns its result and the peak growth. */
async function withRss<T>(fn: () => Promise<T>): Promise<{ value: T; growthMb: number }> {
  const start = process.memoryUsage.rss();
  let peak = start;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage.rss());
  }, 10);
  try {
    const value = await fn();
    peak = Math.max(peak, process.memoryUsage.rss());
    return { value, growthMb: (peak - start) / 1024 / 1024 };
  } finally {
    clearInterval(timer);
  }
}

/**
 * CR-01 (07.15 review): a worker thread's `resourceLimits` bound only the JavaScript heap, so a 1 MB PDF whose
 * content stream inflates to 1 GiB raised the API process to about 2 GB. Extraction now runs in a child process that
 * the parent kills once its resident memory passes `EXTRACT_LIMITS.pdfRssMb` (and, on Linux, under an address-space
 * limit), so none of that memory is ever the API's.
 */
describe("pdfText out of the API process (CR-01)", () => {
  const RSS = new URL("./fixtures/rss-worker.mjs", import.meta.url);
  const PROBE = new URL("./fixtures/probe-worker.mjs", import.meta.url);

  it("a decompression bomb (1 MB inflating to 1 GiB) is too_large, the child is killed, this process stays small", async () => {
    const bomb = await makeFlateBombPdf(1024 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    const pids: number[] = [];
    const started = Date.now();
    const { value, growthMb } = await withRss(() =>
      pdfText(bomb, CAPS, { onSpawn: (pid) => pids.push(pid) }),
    );
    expect(value).toEqual({ ok: false, code: "too_large" });
    expect(Date.now() - started).toBeLessThan(CAPS.ms);
    expect(growthMb).toBeLessThan(128);
    expect(pids).toHaveLength(1);
    expect(alive(pids[0] as number)).toBe(false);
    expect(pdfWorkersInFlight()).toBe(0);
  }, 30_000);

  it("an extractor that allocates memory outside its heap in a loop that never yields is killed: too_large", async () => {
    const pids: number[] = [];
    const { value, growthMb } = await withRss(() =>
      pdfText(new TextEncoder().encode("grow"), CAPS, { workerUrl: RSS, onSpawn: (pid) => pids.push(pid) }),
    );
    expect(value).toEqual({ ok: false, code: "too_large" });
    expect(growthMb).toBeLessThan(128);
    expect(alive(pids[0] as number)).toBe(false);
    expect(pdfWorkersInFlight()).toBe(0);
  }, 30_000);

  it("an extractor that answers far more than an answer can be is cut off: extraction_failed, this process stays small", async () => {
    const FLOOD = new URL("./fixtures/flood-worker.mjs", import.meta.url);
    const pids: number[] = [];
    const { value, growthMb } = await withRss(() =>
      pdfText(new TextEncoder().encode("flood"), CAPS, {
        workerUrl: FLOOD,
        onSpawn: (pid) => pids.push(pid),
      }),
    );
    expect(value).toEqual({ ok: false, code: "extraction_failed" });
    expect(growthMb).toBeLessThan(48);
    expect(alive(pids[0] as number)).toBe(false);
    expect(pdfWorkersInFlight()).toBe(0);
  }, 30_000);

  it("the extractor has no environment, no inherited flags, a temporary cwd and the permission model on", async () => {
    const before = process.env.OCW_PROBE_SECRET;
    process.env.OCW_PROBE_SECRET = "must-not-reach-the-extractor";
    try {
      const out = await pdfText(new TextEncoder().encode("12345"), CAPS, { workerUrl: PROBE });
      if (!out.ok) throw new Error(`expected the probe's answer, got ${out.code}`);
      const facts = JSON.parse(out.text);
      expect(facts.input).toBe(5);
      // macOS sets `__CF_USER_TEXT_ENCODING` in every process it starts; nothing of the API's environment arrives.
      expect(facts.env.filter((key: string) => key !== "__CF_USER_TEXT_ENCODING")).toEqual([]);
      expect(facts.execArgv).toEqual(
        expect.arrayContaining(["--permission", "--disallow-code-generation-from-strings"]),
      );
      expect(facts.execArgv.join(" ")).not.toMatch(/tsx|telemetry|--import|--require|--inspect/u);
      expect(facts.cwd).not.toBe(process.cwd());
      expect(facts.cwd.startsWith(realpathSync(tmpdir()))).toBe(true);
      expect(facts).toMatchObject({
        permission: true,
        readEtc: false,
        readCwd: false,
        write: false,
        child: false,
        worker: false,
        addon: false,
        codeGeneration: false,
        ipc: false,
      });
      expect(out.text).not.toContain("must-not-reach-the-extractor");
    } finally {
      if (before === undefined) delete process.env.OCW_PROBE_SECRET;
      else process.env.OCW_PROBE_SECRET = before;
    }
  });

  it("a real PDF still reads with every bound in place (unpdf loads under the permission model)", async () => {
    expect(await pdfText(makePdf(["Permitted"]), CAPS)).toMatchObject({ ok: true, pages: 1 });
  });
});
