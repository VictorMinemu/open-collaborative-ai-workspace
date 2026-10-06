import type { AttachmentPart } from "./storage";

/**
 * RFC 6266 `Content-Disposition` for presigned GETs (T-04-04-06): an ASCII `filename` fallback (accents folded,
 * anything else `_`, never a quote, backslash or control character) and the exact name as RFC 5987
 * `filename*`. Inline is used only for the API's own webp renditions; every original is an attachment.
 */
export function contentDisposition(filename: string, kind: "attachment" | "inline"): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const clean = filename.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim() || "file";
  const ascii =
    clean
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^\x20-\x7e]|["\\]/g, "_")
      .trim() || "file";
  const encoded = encodeURIComponent(clean).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** The disposition for one stored part: renditions inline (named `<base>.webp`), the original as a download. */
export function dispositionFor(part: AttachmentPart, filename: string): string {
  if (part === "original") return contentDisposition(filename, "attachment");
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return contentDisposition(`${base}.webp`, "inline");
}
