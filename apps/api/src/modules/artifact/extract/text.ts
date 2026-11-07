import { INLINE_IMAGE_TYPES } from "@ocw/contracts";
import type { AttachmentRow } from "../model";

/**
 * 07.15-04 (D-05, PD-07): how the bot read layer classifies and decodes a stored file. Nothing here executes,
 * evaluates or renders a file: markup (HTML, SVG, XML) and code are text like any other text.
 */

/** What a bot can be given for one stored file (a subset of `TurnAttachmentKind`, kept local: 04 needs nothing from 01). */
export type AgentReadKind = "image" | "text" | "pdf" | "other";

/**
 * Extensions read as text when the sniffer found no type (text has no magic bytes, so it is stored as
 * `application/octet-stream`, and so are the ACTIVE types HTML, SVG, XML and JS). Needed because browsers declare
 * `.ts` as `video/mp2t` and `.csv` as `application/vnd.ms-excel`, and bot-shared files declare octet-stream (Pitfall 1).
 */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "ndjson",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "log",
  "xml",
  "html",
  "htm",
  "svg",
  "css",
  "scss",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "sql",
  "r",
  "lua",
  "pl",
  "scala",
  "dart",
  "vue",
  "svelte",
  "graphql",
  "proto",
  "tf",
]);

const INLINE = new Set<string>(INLINE_IMAGE_TYPES);
const OCTET = "application/octet-stream";

const baseType = (type: string) => type.split(";", 1)[0]!.trim().toLowerCase();

/** A media type a model reads as plain text: `text/*` or JSON. */
const isTextual = (type: string) => {
  const base = baseType(type);
  return base.startsWith("text/") || base === "application/json";
};

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

/**
 * The kind of a stored file for a bot read, in this order (PD-07): an image by its sniffed type
 * (`INLINE_IMAGE_TYPES`); a PDF only by the sniffed `application/pdf` (the sniffer is authoritative, a declared PDF
 * that did not sniff as one is `other`); text when the sniffed type is `text/*` or JSON, or when nothing was sniffed
 * (null or octet-stream) and the declared type is `text/*` or JSON or the extension is in `TEXT_EXTENSIONS`; anything
 * else `other`. A text kind is still only a claim: the bytes must decode (`decodeText`) when they are read.
 */
export function attachmentKindOf(
  row: Pick<AttachmentRow, "filename" | "declaredType" | "contentType">,
): AgentReadKind {
  const type = baseType(row.contentType ?? row.declaredType);
  if (INLINE.has(type)) return "image";
  const sniffed = row.contentType === null ? null : baseType(row.contentType);
  if (sniffed === "application/pdf") return "pdf";
  if (sniffed !== null && isTextual(sniffed)) return "text";
  if (sniffed === null || sniffed === OCTET) {
    if (isTextual(row.declaredType) || TEXT_EXTENSIONS.has(extensionOf(row.filename))) return "text";
  }
  return "other";
}

/** How much of the start of a file the NUL rule looks at. */
const SAMPLE_BYTES = 8192;

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The text of a file's leading bytes, or null when they are not text. `complete` says whether `bytes` is the whole
 * file (false when a range read cut it).
 */
export function decodeText(
  bytes: Uint8Array,
  _opts: { complete: boolean },
): { text: string; encoding: string } | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return utf8(bytes.subarray(3));
  }
  if (bytes.subarray(0, SAMPLE_BYTES).includes(0)) return null;
  return utf8(bytes);
}

function utf8(bytes: Uint8Array): { text: string; encoding: string } | null {
  try {
    return { text: strictUtf8.decode(bytes), encoding: "utf-8" };
  } catch {
    return null;
  }
}

/**
 * The first `max` UTF-16 code units of `text` (PD-07: characters are code units), never ending on the high half of
 * a surrogate pair (the cut then keeps one unit fewer).
 */
export function cutChars(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let end = Math.max(0, max);
  if (end > 0) {
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return { text: text.slice(0, end), truncated: true };
}
