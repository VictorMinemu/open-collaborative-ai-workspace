import { SANDBOX_LIMITS } from "@ocw/contracts";

/**
 * Bounds of the bot read layer (07.15 D-05, PD-07). These are the defaults and they change only here: no environment
 * variable or admin setting tunes them (A-02). Characters are counted in UTF-16 code units everywhere.
 *
 * - `textReadBytes`: a text file is read with one range read of at most this many bytes (64 000 characters fit in
 *   256 KiB of UTF-8), never the whole object.
 * - `pdfPages`, `pdfMs`, `pdfHeapMb`, `pdfConcurrency`: the PDF text extractor's page limit, wall clock, JavaScript
 *   heap and the number of extractor processes one API process runs at once (07.15-05).
 * - `pdfRssMb` (CR-01): the extractor process is killed once its resident memory passes this, polled every few tens
 *   of milliseconds by the API (a PDF.js inflated stream is ArrayBuffer memory, outside any heap limit).
 * - `pdfAddressSpaceMb` (CR-01): on Linux, where `prlimit` exists, the kernel's hard address-space limit of that
 *   process, a backstop if the watchdog is late. Generous on purpose: V8 alone reserves 1 to 1.7 GB of address space
 *   before it allocates anything, so a tight value would stop every extractor from starting.
 */
export const EXTRACT_LIMITS = {
  textReadBytes: 262_144,
  pdfPages: 100,
  pdfMs: 10_000,
  pdfHeapMb: 256,
  pdfRssMb: 512,
  pdfAddressSpaceMb: 4096,
  pdfConcurrency: 2,
  imageOriginalMaxBytes: SANDBOX_LIMITS.previewImageMaxBytes,
} as const;
