import { ApiRequestError } from "@/lib/api";

/**
 * Pure helpers for chat attachments (CHAT-12): sizes, names, client-side checks before presigning, readable upload
 * errors, icon families and image boxes. No DOM, no React (unit-tested in node).
 */

const UNITS = ["B", "KB", "MB", "GB"] as const;

/** 1536 → "1.5 KB", 25 MiB → "25 MB" (binary units, at most one decimal, trailing ".0" dropped). */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${UNITS[unit]}`;
}

/** Shortens a file name in the middle so its start and extension stay readable. */
export function middleEllipsis(name: string, max = 32): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : "";
  const tail = ext ? Math.min(ext.length + 2, Math.floor(max / 3)) : Math.floor((max - 1) / 3);
  const head = max - 1 - tail;
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

export interface Limits {
  maxBytes: number;
  maxPerMessage: number;
}

export const tooLargeText = (maxBytes: number) => `Larger than the ${formatBytes(maxBytes)} limit`;

/**
 * Checks files before anything is uploaded: files beyond the per-message count (counting `already` queued ones) are
 * dropped; empty or oversized files are kept with an error so the member sees why they cannot be sent.
 */
export function screenFiles<F extends { name: string; size: number }>(
  files: readonly F[],
  limits: Limits,
  already: number,
): { accepted: Array<{ file: F; error: string | null }>; dropped: number } {
  const room = Math.max(0, limits.maxPerMessage - already);
  const kept = files.slice(0, room);
  return {
    accepted: kept.map((file) => ({
      file,
      error:
        file.size === 0
          ? "This file is empty"
          : file.size > limits.maxBytes
            ? tooLargeText(limits.maxBytes)
            : null,
    })),
    dropped: files.length - kept.length,
  };
}

/** A readable reason for a failed presign, PUT or complete. */
export function uploadErrorText(err: unknown, maxBytes?: number): string {
  if (err instanceof ApiRequestError) {
    if (err.isNetwork) return "Upload failed. Check your connection and try again.";
    if (err.status === 429) return "Too many uploads at once. Wait a minute and try again.";
    switch (err.code) {
      case "too_large":
        return maxBytes ? tooLargeText(maxBytes) : "This file is too large";
      case "type_mismatch":
        return "This file's contents don't match its type";
      case "size_mismatch":
      case "upload_missing":
        return "The upload was incomplete. Try again.";
      case "image_too_large":
        return "This image is too large to process";
      case "storage_unavailable":
        return "File storage is unreachable right now. Try again.";
      case "attachments_disabled":
        return "File sharing is turned off on this server";
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : "Upload failed";
}

/** The browser leaves `type` empty for unknown extensions; the API needs a MIME type. */
export function contentTypeOf(file: { type: string }): string {
  return file.type.trim().toLowerCase() || "application/octet-stream";
}

export type FileKind =
  | "image"
  | "pdf"
  | "archive"
  | "sheet"
  | "doc"
  | "slides"
  | "code"
  | "text"
  | "audio"
  | "video"
  | "other";

const EXT: Record<string, FileKind> = {
  pdf: "pdf",
  zip: "archive",
  gz: "archive",
  tgz: "archive",
  rar: "archive",
  "7z": "archive",
  tar: "archive",
  csv: "sheet",
  tsv: "sheet",
  xls: "sheet",
  xlsx: "sheet",
  ods: "sheet",
  numbers: "sheet",
  doc: "doc",
  docx: "doc",
  odt: "doc",
  rtf: "doc",
  pages: "doc",
  ppt: "slides",
  pptx: "slides",
  odp: "slides",
  key: "slides",
  txt: "text",
  md: "text",
  log: "text",
  json: "code",
  js: "code",
  ts: "code",
  tsx: "code",
  jsx: "code",
  py: "code",
  rb: "code",
  go: "code",
  rs: "code",
  java: "code",
  sh: "code",
  sql: "code",
  yaml: "code",
  yml: "code",
  html: "code",
  css: "code",
  xml: "code",
  svg: "code",
};

/** Icon family of a file from its (sniffed) type, then its extension. */
export function fileKind(contentType: string, name: string): FileKind {
  const type = contentType.toLowerCase();
  if (type.startsWith("image/") && type !== "image/svg+xml") return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf") return "pdf";
  if (/zip|compressed|x-tar|gzip|x-7z|x-rar/.test(type)) return "archive";
  if (/spreadsheet|excel|text\/csv/.test(type)) return "sheet";
  if (/presentation|powerpoint/.test(type)) return "slides";
  if (/wordprocessing|msword|opendocument\.text/.test(type)) return "doc";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return EXT[ext] ?? (type.startsWith("text/") ? "text" : "other");
}

/** The display size of an image inside `maxW × maxH`, aspect kept, never enlarged (reserved before it loads). */
export function imageBox(
  width: number | null,
  height: number | null,
  maxW: number,
  maxH: number,
): { width: number; height: number } {
  if (!width || !height) return { width: 360, height: 240 };
  const scale = Math.min(maxW / width, maxH / height, 1);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
