/**
 * URL allowlist of the shared Markdown renderer (D-05, T-04-02-01): http, https, mailto and same-origin
 * references only. The check runs on the URL a browser would actually parse: browsers remove tab, CR and LF
 * anywhere in a URL, C0 controls and spaces at its ends, and read "\" as "/" for http(s), so `java\tscript:`,
 * `\u0001javascript:` or `/\evil.example` must be judged after that normalization, never on the raw string.
 */

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** Parse base when there is no window (SSR, tests): only its origin matters for the same-origin check. */
const SERVER_BASE = "https://ocw.invalid/";

function baseUrl(): string {
  return typeof window !== "undefined" && window.location?.origin
    ? `${window.location.origin}/`
    : SERVER_BASE;
}

/**
 * Returns the URL to put in `href` (controls removed), or `undefined` to drop the attribute. Compose after the
 * engine's own default transform; this is the authority.
 */
export function safeUrl(url: string | null | undefined): string | undefined {
  if (typeof url !== "string") return undefined;
  // Every C0 control and DEL anywhere (a superset of what browsers drop), then spaces at the ends.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
  const value = url.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (value === "") return undefined;
  // Protocol-relative in any spelling ("//", "\\", "/\", "\/") leaves the origin.
  if (/^[/\\]{2}/.test(value)) return undefined;
  const base = baseUrl();
  let parsed: URL;
  try {
    parsed = new URL(value, base);
  } catch {
    return undefined;
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return undefined;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(value);
  // A reference without a scheme must resolve to this origin (anything else is a host in disguise).
  if (!hasScheme && parsed.origin !== new URL(base).origin) return undefined;
  return value;
}
