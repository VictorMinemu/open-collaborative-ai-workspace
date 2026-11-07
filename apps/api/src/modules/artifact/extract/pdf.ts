import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { EXTRACT_LIMITS } from "./limits";
import { cutChars } from "./text";

/** A PDF read's outcome (07.15 Cross-plan contracts): its text, or one fixed code the bot can relay. */
export type PdfOutcome =
  | { ok: true; text: string; pages: number; totalPages: number; truncated: boolean }
  | {
      ok: false;
      code: "encrypted" | "extraction_failed" | "timeout" | "busy" | "no_text_layer" | "too_large";
    };

export interface PdfCaps {
  /** Pages read, from the first (`EXTRACT_LIMITS.pdfPages`). */
  pages: number;
  /** UTF-16 code units returned at most. */
  chars: number;
  /** Wall clock before the extractor process is killed. */
  ms: number;
  /** The extractor's JavaScript heap (`--max-old-space-size`). */
  heapMb: number;
  /** The extractor's resident memory before it is killed (`EXTRACT_LIMITS.pdfRssMb` when absent). */
  rssMb?: number;
}

export interface PdfOptions {
  /** The extractor script; tests point it at hostile fixtures. Defaults to `pdf-worker.mjs` next to this file. */
  workerUrl?: URL;
  log?: Pick<FastifyBaseLogger, "warn">;
  /** Called with the extractor's process id once it is spawned (tests check the process is gone afterwards). */
  onSpawn?: (pid: number) => void;
}

/** The extractor's one message, parsed: anything else (a forged or broken message) is `extraction_failed`. */
const ExtractorAnswer = z.discriminatedUnion("ok", [
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

const DEFAULT_EXTRACTOR = new URL("./pdf-worker.mjs", import.meta.url);
/** The young generation's semi-space (the old worker's 32 MB young generation, in V8's own unit). */
const SEMI_SPACE_MB = 16;
const MIB = 1024 * 1024;
/** How often the extractor's resident memory is read: `/proc` is cheap; `ps` (macOS, development) is not. */
const RSS_POLL_MS = process.platform === "linux" ? 20 : 50;

/** Extractor processes running for this process; at `EXTRACT_LIMITS.pdfConcurrency` a new read answers `busy`. */
let inFlight = 0;

/** Extractor processes this process is running now (tests check every path gives its slot back). */
export function pdfWorkersInFlight(): number {
  return inFlight;
}

/** `prlimit` (util-linux; present in the API's Debian image) by absolute path, never a PATH lookup; Linux only. */
const PRLIMIT =
  process.platform === "linux" ? ["/usr/bin/prlimit", "/bin/prlimit"].find((p) => existsSync(p)) : undefined;

let unpdfLocation: { url: string; dir: string } | undefined;
/**
 * Where unpdf is, resolved here (the extractor may read only its own file and this package directory, so it cannot
 * walk `node_modules` itself): the real path of the package, its ESM entry as a file URL.
 */
function unpdf(): { url: string; dir: string } {
  if (!unpdfLocation) {
    const dist = dirname(realpathSync(createRequire(import.meta.url).resolve("unpdf")));
    unpdfLocation = { url: pathToFileURL(join(dist, "index.mjs")).href, dir: dirname(dist) };
  }
  return unpdfLocation;
}

let scratch: string | undefined;
/** An empty directory of this process's own, the extractor's working directory (it may not even read it). */
function workDir(): string {
  // Made again if something cleaned the temporary directory meanwhile (spawn fails on a missing cwd).
  if (!scratch || !existsSync(scratch)) scratch = mkdtempSync(join(realpathSync(tmpdir()), "ocw-pdf-"));
  return scratch;
}

const execFileAsync = promisify(execFile);

/** A process's resident memory in bytes: `/proc/<pid>/status` on Linux, `ps` on macOS; null when unknown or gone. */
async function residentBytes(pid: number): Promise<number | null> {
  try {
    if (process.platform === "linux") {
      const kb = /^VmRSS:\s+(\d+)\s+kB/mu.exec(await readFile(`/proc/${pid}/status`, "utf8"))?.[1];
      return kb ? Number(kb) * 1024 : null;
    }
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("/bin/ps", ["-o", "rss=", "-p", String(pid)], { env: {} });
      const kb = Number.parseInt(stdout.trim(), 10);
      return Number.isFinite(kb) ? kb * 1024 : null;
    }
  } catch {
    // the process is gone, or `ps` failed: the deadline still holds
  }
  return null;
}

type Settled =
  | { kind: "message"; value: unknown }
  | { kind: "failed" }
  | { kind: "timeout" }
  | { kind: "memory" };

/** The command line of one extractor: node with every bound, under `prlimit --as` where it exists. */
function commandLine(script: string, bytes: number, caps: PdfCaps): { command: string; args: string[] } {
  const lib = unpdf();
  const node = [
    `--max-old-space-size=${caps.heapMb}`,
    `--max-semi-space-size=${SEMI_SPACE_MB}`,
    // The permission model: read only the script and unpdf; no writes, child processes, workers, addons or WASI.
    "--permission",
    `--allow-fs-read=${script}`,
    `--allow-fs-read=${lib.dir}`,
    "--disallow-code-generation-from-strings",
    script,
    lib.url,
    String(caps.pages),
    String(caps.chars),
    String(bytes),
  ];
  if (!PRLIMIT) return { command: process.execPath, args: node };
  return {
    command: PRLIMIT,
    args: [`--as=${EXTRACT_LIMITS.pdfAddressSpaceMb * MIB}`, "--", process.execPath, ...node],
  };
}

/**
 * A PDF's text (07.15 D-05, D-12, PD-07; CR-01), parsed by unpdf (PDF.js, eval off, nothing rendered) only inside a
 * child process, never in the API process: a worker thread's limits cover only its JavaScript heap, so a small PDF
 * whose stream inflates to gigabytes would grow the API itself. The process is bounded in time (`caps.ms`, then
 * SIGKILL), resident memory (`caps.rssMb`, polled; then SIGKILL and `too_large`), heap (`caps.heapMb`), address space
 * (Linux, `prlimit`), pages (`caps.pages`) and output (`caps.chars`, cut again here). It gets no environment (no
 * secret, no `_FILE` path, no NODE_OPTIONS), none of the API's flags, a fresh temporary working directory, the
 * permission model (read access to its script and unpdf only), no code generation from strings, the bytes on stdin,
 * stdout and stderr discarded (PDF.js can echo document strings) and one IPC answer, Zod-parsed. At most
 * `EXTRACT_LIMITS.pdfConcurrency` run per API process (`busy` otherwise, no queue). The promise settles only once the
 * process has exited. Nothing from PDF.js reaches a log or the answer except the text: failures are fixed codes and
 * only an error's name is logged.
 */
export async function pdfText(bytes: Uint8Array, caps: PdfCaps, opts: PdfOptions = {}): Promise<PdfOutcome> {
  if (inFlight >= EXTRACT_LIMITS.pdfConcurrency) return { ok: false, code: "busy" };
  inFlight++;
  let child: ChildProcess | undefined;
  let gone: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  let poll: NodeJS.Timeout | undefined;
  try {
    const script = fileURLToPath(opts.workerUrl ?? DEFAULT_EXTRACTOR);
    const { command, args } = commandLine(script, bytes.byteLength, caps);
    const c = spawn(command, args, {
      cwd: workDir(),
      env: {},
      stdio: ["pipe", "ignore", "ignore", "ipc"],
      serialization: "json",
      windowsHide: true,
    });
    child = c;
    // 'close' comes after the exit and after the IPC channel is drained, so an answer sent just before exiting is
    // never lost; a spawn that failed has no pid and never closes.
    gone = new Promise<void>((resolve) => {
      c.once("close", () => resolve());
      c.once("error", () => {
        if (c.pid === undefined) resolve();
      });
    });
    if (c.pid !== undefined) opts.onSpawn?.(c.pid);
    const settled = await new Promise<Settled>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), caps.ms);
      c.once("message", (value: unknown) => resolve({ kind: "message", value }));
      c.once("error", (err: Error) => {
        opts.log?.warn({ err: { name: err?.name } }, "pdf text extractor failed");
        resolve({ kind: "failed" });
      });
      c.once("close", () => resolve({ kind: "failed" }));
      const pid = c.pid;
      if (pid !== undefined) {
        const cap = (caps.rssMb ?? EXTRACT_LIMITS.pdfRssMb) * MIB;
        let reading = false;
        poll = setInterval(() => {
          if (reading) return;
          reading = true;
          void residentBytes(pid).then((rss) => {
            reading = false;
            if (rss !== null && rss > cap) {
              c.kill("SIGKILL");
              resolve({ kind: "memory" });
            }
          });
        }, RSS_POLL_MS);
      }
      // The bytes go to the extractor and nowhere else; an extractor that dies early closes the pipe (EPIPE).
      c.stdin?.on("error", () => undefined);
      c.stdin?.end(bytes);
    });
    return outcome(settled, caps);
  } catch (err) {
    opts.log?.warn({ err: { name: (err as Error)?.name } }, "pdf text extractor failed");
    return { ok: false, code: "extraction_failed" };
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await gone;
    inFlight--;
  }
}

function outcome(settled: Settled, caps: PdfCaps): PdfOutcome {
  if (settled.kind === "timeout") return { ok: false, code: "timeout" };
  if (settled.kind === "memory") return { ok: false, code: "too_large" };
  if (settled.kind === "failed") return { ok: false, code: "extraction_failed" };
  const parsed = ExtractorAnswer.safeParse(settled.value);
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
