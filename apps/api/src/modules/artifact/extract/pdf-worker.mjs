// 07.15-05 (D-05, PD-07): the PDF text worker. Plain JavaScript on purpose: the parent starts it with `execArgv: []`,
// so it never inherits the API's `--import tsx --import ./src/telemetry.ts` (RESEARCH Pitfall 4).
//
// workerData: { data: Uint8Array (a fresh copy, transferred), maxPages: number, maxChars: number }. Nothing else: no
// secret, no environment (the parent passes `env: {}`).
//
// It posts exactly one message:
//   { ok: true, totalPages, pages, text, truncated }   pages read = min(numPages, maxPages), cut early at maxChars
//   { ok: false, error: "encrypted" | "invalid" | "failed" }
// The error is chosen by `err.name` only. PDF.js messages can quote document strings, so no message, warning or
// document string ever leaves this thread except the extracted text itself (P3). Eval is off (CVE-2024-4367 class)
// and nothing is rendered.
import { parentPort, workerData } from "node:worker_threads";
import { getDocumentProxy } from "unpdf";

const { data, maxPages, maxChars } = workerData;

function code(err) {
  const name = err && typeof err === "object" ? err.name : undefined;
  if (name === "PasswordException") return "encrypted";
  if (name === "InvalidPDFException") return "invalid";
  return "failed";
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
  doc = await getDocumentProxy(new Uint8Array(data), { isEvalSupported: false, verbosity: 0 });
  const totalPages = doc.numPages;
  const last = Math.min(totalPages, maxPages);
  let text = "";
  let pages = 0;
  let cut = false;
  for (let i = 1; i <= last; i++) {
    const page = await doc.getPage(i);
    const chunk = pageText(await page.getTextContent());
    page.cleanup();
    text += pages === 0 ? chunk : `\n\n${chunk}`;
    pages = i;
    if (text.length > maxChars) {
      // One code unit past the cap, so the parent's surrogate-safe cut (cutChars) sees the overflow.
      text = text.slice(0, maxChars + 1);
      cut = true;
      break;
    }
  }
  parentPort.postMessage({ ok: true, totalPages, pages, text, truncated: cut || pages < totalPages });
} catch (err) {
  parentPort.postMessage({ ok: false, error: code(err) });
} finally {
  try {
    await doc?.destroy();
  } catch {
    // the answer is already posted; the parent terminates this thread anyway
  }
}
