import { SANDBOX_LIMITS } from "@ocw/contracts";

/**
 * Bounds of the bot read layer (07.15 D-05, PD-07). These are the defaults and they change only here: no environment
 * variable or admin setting tunes them (A-02). Characters are counted in UTF-16 code units everywhere.
 *
 * - `textReadBytes`: a text file is read with one range read of at most this many bytes (64 000 characters fit in
 *   256 KiB of UTF-8), never the whole object.
 * - `pdfPages`, `pdfMs`, `pdfHeapMb`, `pdfConcurrency`: the PDF text worker's page limit, wall clock, old-generation
 *   heap and the number of workers one API process runs at once (07.15-05).
 * - `imageOriginalMaxBytes`: an image without a stored rendition goes to the model only up to this size (the
 *   screenshot ceiling, `SANDBOX_LIMITS.previewImageMaxBytes`, 5 MiB).
 */
export const EXTRACT_LIMITS = {
  textReadBytes: 262_144,
  pdfPages: 100,
  pdfMs: 10_000,
  pdfHeapMb: 256,
  pdfConcurrency: 2,
  imageOriginalMaxBytes: SANDBOX_LIMITS.previewImageMaxBytes,
} as const;
