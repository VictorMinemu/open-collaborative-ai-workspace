// 07.15-05 (D-05, PD-07), CR-01 (07.15 review): the PDF text extractor. It runs as its own Node process, never in the
// API process: `pdf.ts` spawns `node` on this file with a bounded heap, the permission model (read access to this file
// and the unpdf package only; no child processes, no workers, no addons, no writes), no code generation from strings,
// an empty environment (no secret, no `_FILE` path, no NODE_OPTIONS) and a fresh temporary working directory. The
// parent watches this process's resident memory and kills it past `EXTRACT_LIMITS.pdfRssMb` (a worker thread could not
// be bounded: its ArrayBuffers, such as PDF.js's inflated streams, belonged to the API process). Plain JavaScript on
// purpose: the API's `--import tsx` preload is never inherited (RESEARCH Pitfall 4).
//
// argv: <unpdf entry URL> <maxPages> <maxChars> <maxBytes>
// stdin: the PDF bytes, at most maxBytes.
// stdout carries exactly one JSON answer and nothing else (no IPC channel; the parent reads at most 1 MiB):
//   { ok: true, totalPages, pages, text, truncated, hasText }   pages read = min(numPages, maxPages), cut early past
//     maxChars; hasText: a page of those had a non-space character, even past the cut (IN-03: a short cut of leading
//     blank lines is not a PDF without a text layer)
//   { ok: false, error: "encrypted" | "invalid" | "failed" }
// The error is chosen by `err.name` only. PDF.js messages can quote document strings, so no message, warning or
// document string ever leaves this process except the extracted text itself (P3): the console is silenced (so nothing
// else reaches stdout; stray output would only break the parse) and the parent drops stderr. Eval is off (CVE-2024-4367
// class) and nothing is rendered.
for (const method of ["log", "info", "warn", "error", "debug", "trace", "dir"])
  console[method] = () => undefined;

const [unpdfUrl, maxPagesArg, maxCharsArg, maxBytesArg] = process.argv.slice(2);
const maxPages = Number(maxPagesArg);
const maxChars = Number(maxCharsArg);
const maxBytes = Number(maxBytesArg);

// The parent went away (its end of stdout closed): nothing is left to answer.
process.stdout.on("error", () => process.exit(0));

function answer(message) {
  process.stdout.write(JSON.stringify(message), () => process.exit(0));
}

function code(err) {
  const name = err && typeof err === "object" ? err.name : undefined;
  if (name === "PasswordException") return "encrypted";
  if (name === "InvalidPDFException") return "invalid";
  return "failed";
}

/** The PDF from stdin into one fresh buffer, refused past maxBytes (the parent already checked the size). */
async function input() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error("input over the cap"), { name: "InputTooLarge" });
    chunks.push(chunk);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data;
}

function pageText(content) {
  let out = "";
  for (const item of content.items) {
    if (typeof item.str !== "string") continue; // marked-content markers carry no text
    out += item.str;
    if (item.hasEOL) out += "\n";
  }
  return out;
}

let doc;
try {
  const data = await input();
  const { getDocumentProxy } = await import(unpdfUrl);
  doc = await getDocumentProxy(data, { isEvalSupported: false, verbosity: 0 });
  const totalPages = doc.numPages;
  const last = Math.min(totalPages, maxPages);
  let text = "";
  let pages = 0;
  let cut = false;
  let hasText = false;
  for (let i = 1; i <= last; i++) {
    const page = await doc.getPage(i);
    const chunk = pageText(await page.getTextContent());
    page.cleanup();
    if (!hasText && chunk.trim() !== "") hasText = true;
    // Past the cut the pages are only looked at for whether any text exists.
    if (cut) {
      if (hasText) break;
      continue;
    }
    text += pages === 0 ? chunk : `\n\n${chunk}`;
    pages = i;
    if (text.length > maxChars) {
      // One code unit past the cap, so the parent's surrogate-safe cut (cutChars) sees the overflow.
      text = text.slice(0, maxChars + 1);
      cut = true;
      if (hasText) break;
    }
  }
  answer({ ok: true, totalPages, pages, text, truncated: cut || pages < totalPages, hasText });
} catch (err) {
  answer({ ok: false, error: code(err) });
} finally {
  try {
    await doc?.destroy();
  } catch {
    // the answer is already on its way; the parent kills this process anyway
  }
}
