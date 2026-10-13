import {
  detectSensitive,
  type MemoryProposalOp,
  maskSample,
  type SensitiveFinding,
  type SensitiveFindingKind,
  type SensitiveSpan,
} from "@ocw/contracts";
import { diffLines } from "diff";

/**
 * What a memory change adds, and what the detector finds in it (MEM-05, D-06, D-08). Only the added text is scanned:
 * PII already in the file is not reported again by a change that keeps it. Pure apart from the scanner it is given
 * (layer 2, Presidio), which only ever sees the added text.
 */

/** Detector layer 2: the Presidio client (`createPresidioScanner`) or a stand-in; spans index the text it was given. */
export interface ChangeScanner {
  scan(text: string): Promise<{ findings: SensitiveFinding[]; spans: SensitiveSpan[] }>;
}

/** A scanner that finds nothing (views recompute layer 1 only; Presidio is called once, when the proposal is made). */
export const NO_SCANNER: ChangeScanner = { scan: async () => ({ findings: [], spans: [] }) };

/** `MemoryProposalView` bounds (UI-SPEC R5, WINDOWS 126): spans beyond are dropped (by offset), findings beyond too. */
export const MAX_VIEW_SPANS = 200;
export const MAX_VIEW_FINDINGS = 50;

const MAX_SAMPLES = 3;
const MAX_LINES = 20;
const MAX_SAMPLE_LENGTH = 80;
/** Bounds Myers' edit distance like `lineChanges` (files.ts): past it the change counts as a full replacement. */
const MAX_EDIT_LENGTH = 2_000;

export interface ChangeScan {
  /** The file as it would be once applied (for `append`: the base plus the appended body). */
  result: string;
  findings: SensitiveFinding[];
  /** UTF-16 offsets into `result`, sorted, at most `MAX_VIEW_SPANS`. */
  spans: SensitiveSpan[];
  /** Every span, uncapped (the card's excerpt masks all of them). */
  allSpans: SensitiveSpan[];
  linesAdded: number;
  linesRemoved: number;
  /** The added text, as one string (what layer 2 scans). */
  addedText: string;
  /** Where each added piece starts in `result` (offsets) and its 1-based line numbers there. */
  added: Array<{ start: number; text: string }>;
  addedLines: number[];
}

const countLines = (s: string) => (s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0));

/** The text `appendToFile` writes: the appended body ends with a line break and starts on a line of its own. */
export function appendedContent(base: string | null, text: string): { result: string; bodyStart: number } {
  const body = text.endsWith("\n") ? text : `${text}\n`;
  const b = base ?? "";
  const head = b === "" || b.endsWith("\n") ? b : `${b}\n`;
  return { result: head + body, bodyStart: head.length };
}

/** 1-based line numbers of the added pieces (sorted by offset) in `text`, in one pass over the text. */
function addedLineNumbers(text: string, pieces: ChangeScan["added"]): number[] {
  const out: number[] = [];
  let line = 1;
  let pos = 0;
  for (const p of pieces) {
    for (let i = text.indexOf("\n", pos); i !== -1 && i < p.start; i = text.indexOf("\n", i + 1)) line += 1;
    pos = p.start;
    const n = countLines(p.text);
    for (let k = 0; k < n; k++) out.push(line + k);
  }
  return out;
}

/** The added pieces of `after` relative to `before` (offsets into `after`), and the lines removed. */
function addedPieces(before: string, after: string): { added: ChangeScan["added"]; removed: number } {
  const changes = diffLines(before, after, { maxEditLength: MAX_EDIT_LENGTH });
  if (!changes) return { added: after ? [{ start: 0, text: after }] : [], removed: countLines(before) };
  const added: ChangeScan["added"] = [];
  let offset = 0;
  let removed = 0;
  for (const c of changes) {
    if (c.removed) {
      removed += c.count;
      continue;
    }
    if (c.added) added.push({ start: offset, text: c.value });
    offset += c.value.length;
  }
  return { added, removed };
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  a.start < b.end && b.start < a.end;

/** 1-based line of an offset in `text`. */
function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if ((starts[mid] as number) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Findings of layer-2 spans, rebuilt on the resulting file so lines and samples refer to it. */
function presidioFindings(result: string, spans: readonly SensitiveSpan[]): SensitiveFinding[] {
  const starts = [0];
  for (let i = result.indexOf("\n"); i !== -1; i = result.indexOf("\n", i + 1)) starts.push(i + 1);
  const byKind = new Map<SensitiveFindingKind, SensitiveFinding>();
  for (const s of spans) {
    let f = byKind.get(s.kind);
    if (!f) {
      f = { kind: s.kind, severity: "warn", source: "presidio", count: 0, samples: [], lines: [] };
      byKind.set(s.kind, f);
    }
    f.count += 1;
    const masked = maskSample(s.kind, result.slice(s.start, s.end));
    const sample = masked.length > MAX_SAMPLE_LENGTH ? `${masked.slice(0, MAX_SAMPLE_LENGTH - 1)}…` : masked;
    if (f.samples.length < MAX_SAMPLES && !f.samples.includes(sample)) f.samples.push(sample);
    const line = lineAt(starts, s.start);
    if (f.lines.length < MAX_LINES && !f.lines.includes(line)) f.lines.push(line);
  }
  for (const f of byKind.values()) f.lines.sort((a, b) => a - b);
  return [...byKind.values()];
}

/**
 * Scans what a proposal adds: `create` = the whole content; `replace` = the lines `diffLines` adds; `append` = the
 * appended body (`proposed` is the text to append). Layer 1 (`detectSensitive`, restricted to the added lines) always;
 * layer 2 (`scanner`) on the added text, its spans mapped back onto the resulting file, a span overlapping a layer-1
 * span dropped (layer 1 wins), its `info` markers (`extended_scan_unavailable`, `extended_scan_partial`) kept. Line
 * numbers and offsets refer to the resulting file.
 */
export async function scanChange(
  a: { base: string | null; proposed: string; op: MemoryProposalOp },
  scanner: ChangeScanner,
): Promise<ChangeScan> {
  let result: string;
  let added: ChangeScan["added"];
  let linesRemoved = 0;
  if (a.op === "append") {
    const { result: r, bodyStart } = appendedContent(a.base, a.proposed);
    result = r;
    added = [{ start: bodyStart, text: r.slice(bodyStart) }];
  } else if (a.op === "create" || a.base === null) {
    result = a.proposed;
    added = result ? [{ start: 0, text: result }] : [];
  } else {
    result = a.proposed;
    const d = addedPieces(a.base, a.proposed);
    added = d.added;
    linesRemoved = d.removed;
  }
  const addedLines = addedLineNumbers(result, added);
  const addedText = added.map((p) => p.text).join("");

  const layer1 = detectSensitive(result, { lines: addedLines });

  const layer2 = await scanner.scan(addedText);
  const mapped: SensitiveSpan[] = [];
  let at = 0;
  const pieces = added.map((p) => {
    const piece = { from: at, to: at + p.text.length, start: p.start };
    at = piece.to;
    return piece;
  });
  for (const s of layer2.spans) {
    const piece = pieces.find((p) => s.start >= p.from && s.start < p.to);
    if (!piece) continue;
    const start = piece.start + (s.start - piece.from);
    const end = piece.start + (Math.min(s.end, piece.to) - piece.from);
    const span = { kind: s.kind, start, end };
    if (end > start && !layer1.spans.some((b) => overlaps(b, span))) mapped.push(span);
  }
  const info = layer2.findings.filter((f) => f.severity === "info");

  const findings = [...layer1.findings, ...presidioFindings(result, mapped), ...info].slice(
    0,
    MAX_VIEW_FINDINGS,
  );
  const allSpans = [...layer1.spans, ...mapped].sort((x, y) => x.start - y.start || x.end - y.end);
  return {
    result,
    findings,
    spans: allSpans.slice(0, MAX_VIEW_SPANS),
    allSpans,
    linesAdded: addedLines.length,
    linesRemoved,
    addedText,
    added,
    addedLines,
  };
}

/**
 * The card's change preview (UI-SPEC R6): the added lines prefixed "+ ", every span inside them masked, at most `max`
 * characters cut at a line (a first line longer than that is cut with "…"). Never a raw finding.
 */
export function changeExcerpt(scan: Pick<ChangeScan, "result" | "added" | "allSpans">, max = 600): string {
  const pieces = scan.added.map((p) => {
    const end = p.start + p.text.length;
    let out = "";
    let cursor = p.start;
    for (const s of scan.allSpans) {
      if (s.end <= p.start || s.start >= end) continue;
      const from = Math.max(s.start, p.start);
      const to = Math.min(s.end, end);
      if (from < cursor) continue;
      out += scan.result.slice(cursor, from) + maskSample(s.kind, scan.result.slice(from, to));
      cursor = to;
    }
    return out + scan.result.slice(cursor, end);
  });
  const lines = pieces
    .join("")
    .split("\n")
    .filter((l, i, all) => !(i === all.length - 1 && l === ""))
    .map((l) => `+ ${l}`);
  let out = "";
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line;
    if (next.length > max) {
      if (!out) out = `${line.slice(0, max - 1)}…`;
      break;
    }
    out = next;
  }
  return out;
}
