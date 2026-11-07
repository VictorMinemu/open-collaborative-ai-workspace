import { Worker } from "node:worker_threads";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { EXTRACT_LIMITS } from "./limits";
import { cutChars } from "./text";

/** A PDF read's outcome (07.15 Cross-plan contracts): its text, or one fixed code the bot can relay. */
export type PdfOutcome =
  | { ok: true; text: string; pages: number; totalPages: number; truncated: boolean }
  | { ok: false; code: "encrypted" | "extraction_failed" | "timeout" | "busy" | "no_text_layer" };

export interface PdfCaps {
  /** Pages read, from the first (`EXTRACT_LIMITS.pdfPages`). */
  pages: number;
  /** UTF-16 code units returned at most. */
  chars: number;
  /** Wall clock before the worker is terminated. */
  ms: number;
  /** The worker's old-generation heap (`resourceLimits.maxOldGenerationSizeMb`). */
  heapMb: number;
}

export interface PdfOptions {
  /** The worker script; tests point it at hostile fixtures. Defaults to `pdf-worker.mjs` next to this file. */
  workerUrl?: URL;
  log?: Pick<FastifyBaseLogger, "warn">;
}

/** The worker's one message, parsed: anything else (a forged or broken message) is `extraction_failed`. */
const WorkerAnswer = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      totalPages: z.number().int().nonnegative(),
      pages: z.number().int().nonnegative(),
      text: z.string(),
      truncated: z.boolean(),
    })
    .strict(),
  z.object({ ok: z.literal(false), error: z.enum(["encrypted", "invalid", "failed"]) }).strict(),
]);

const DEFAULT_WORKER = new URL("./pdf-worker.mjs", import.meta.url);
const YOUNG_GENERATION_MB = 32;

/** PDF workers running in this process; at `EXTRACT_LIMITS.pdfConcurrency` a new read answers `busy` (no queue). */
let inFlight = 0;

/** Workers this process is running now (tests check every path gives its slot back). */
export function pdfWorkersInFlight(): number {
  return inFlight;
}

type Settled = { kind: "message"; value: unknown } | { kind: "failed" } | { kind: "timeout" };

/**
 * A PDF's text (07.15 D-05, D-12, PD-07), parsed by unpdf (PDF.js, eval off, nothing rendered) only inside a
 * `worker_threads` Worker that is bounded in time (`caps.ms`, then `terminate()`), heap (`caps.heapMb` old, 32 MB
 * young), pages (`caps.pages`) and output (`caps.chars`, cut again here), with no inherited flags (an empty `execArgv`),
 * no environment (an empty `env`) and its stdout and stderr drained and dropped (PDF.js can echo document strings). At
 * most `EXTRACT_LIMITS.pdfConcurrency` run per process. Nothing from PDF.js reaches a log or the answer except the
 * text: failures are fixed codes and only an error's name is logged.
 */
export async function pdfText(bytes: Uint8Array, caps: PdfCaps, opts: PdfOptions = {}): Promise<PdfOutcome> {
  if (inFlight >= EXTRACT_LIMITS.pdfConcurrency) return { ok: false, code: "busy" };
  inFlight++;
  let worker: Worker | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    // A fresh copy with its own ArrayBuffer (never a Buffer-pool view), transferred so the caller's bytes stay usable.
    const data = new Uint8Array(bytes);
    const w = new Worker(opts.workerUrl ?? DEFAULT_WORKER, {
      workerData: { data, maxPages: caps.pages, maxChars: caps.chars },
      transferList: [data.buffer],
      resourceLimits: { maxOldGenerationSizeMb: caps.heapMb, maxYoungGenerationSizeMb: YOUNG_GENERATION_MB },
      execArgv: [],
      env: {},
      stdout: true,
      stderr: true,
    });
    worker = w;
    w.stdout.resume();
    w.stderr.resume();
    const settled = await new Promise<Settled>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), caps.ms);
      w.once("message", (value: unknown) => resolve({ kind: "message", value }));
      w.once("error", (err: Error) => {
        opts.log?.warn({ err: { name: err?.name } }, "pdf text worker failed");
        resolve({ kind: "failed" });
      });
      w.once("exit", () => resolve({ kind: "failed" }));
    });
    return outcome(settled, caps);
  } catch (err) {
    opts.log?.warn({ err: { name: (err as Error)?.name } }, "pdf text worker failed");
    return { ok: false, code: "extraction_failed" };
  } finally {
    clearTimeout(timer);
    if (worker) await worker.terminate().catch(() => undefined);
    inFlight--;
  }
}

function outcome(settled: Settled, caps: PdfCaps): PdfOutcome {
  if (settled.kind === "timeout") return { ok: false, code: "timeout" };
  if (settled.kind === "failed") return { ok: false, code: "extraction_failed" };
  const parsed = WorkerAnswer.safeParse(settled.value);
  if (!parsed.success) return { ok: false, code: "extraction_failed" };
  const answer = parsed.data;
  if (!answer.ok)
    return { ok: false, code: answer.error === "encrypted" ? "encrypted" : "extraction_failed" };
  if (answer.text.trim() === "") return { ok: false, code: "no_text_layer" };
  const cut = cutChars(answer.text, caps.chars);
  return {
    ok: true,
    text: cut.text,
    pages: answer.pages,
    totalPages: answer.totalPages,
    truncated: answer.truncated || cut.truncated || answer.pages < answer.totalPages,
  };
}
