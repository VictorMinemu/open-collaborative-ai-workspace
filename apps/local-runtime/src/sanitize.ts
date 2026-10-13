// Outbound sanitisation: every string that leaves the device passes through `contain()` (absolute
// host paths -> repo-relative or `~/...`) and `redact()` (credentials). AGENTS.md principles 7 and 8.

import { homedir } from "node:os";
import { redactSecrets } from "@ocw/contracts";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Characters that may continue a path segment; a root only matches at a segment boundary. */
const SEGMENT_CHAR = "[A-Za-z0-9._@+~-]";

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * Replace absolute paths with safe forms.
 * - Paths under one of `roots` (project path, worktree path, their realpaths) become repo-relative
 *   (`<root>/src/a.ts` -> `src/a.ts`, `<root>` alone -> `.`).
 * - Any other path under the user's home becomes `~/...`.
 * - Other users' home directories (`/Users/<name>`, `/home/<name>`) are collapsed to `~`.
 */
export function contain(text: string, roots: readonly string[], home: string = homedir()): string {
  if (!text) return text;
  let out = text;
  const sorted = [...new Set(roots.filter((r) => r && r.startsWith("/")).map(stripTrailingSlash))].sort(
    (a, b) => b.length - a.length,
  );
  for (const root of sorted) {
    if (root === "/") continue;
    const re = new RegExp(`${escapeRegExp(root)}(?!${SEGMENT_CHAR})(/)?`, "g");
    out = out.replace(re, (_m, slash: string | undefined) => (slash ? "" : "."));
  }
  const h = stripTrailingSlash(home);
  if (h && h !== "/") out = out.replace(new RegExp(`${escapeRegExp(h)}(?!${SEGMENT_CHAR})`, "g"), "~");
  out = out.replace(/\/(?:Users|home)\/[A-Za-z0-9._-]+(?![A-Za-z0-9._-])/g, "~");
  return out;
}

/** Redact API keys, tokens and private key material. Idempotent. */
export function redact(text: string): string {
  // The rules live once in @ocw/contracts (07.2-04, D-08); redact-parity.test.ts pins the output byte for byte.
  return redactSecrets(text);
}

/** contain() then redact() one string. */
export function sanitizeString(text: string, roots: readonly string[], home?: string): string {
  return redact(contain(text, roots, home));
}

/** Deep-map every string (values only, not keys) of a JSON-like value. */
export function sanitizeValue<T>(value: T, roots: readonly string[], home?: string): T {
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return sanitizeString(v, roots, home);
    if (depth > 32 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, depth + 1);
    return out;
  };
  return walk(value, 0) as T;
}

/**
 * The single choke point for runtime events leaving the device. Applies contain() and redact() to
 * every string field, including nested `runtime.raw` data.
 */
export function sanitizeEvent<E extends { type: string }>(
  event: E,
  roots: readonly string[],
  home?: string,
): E {
  return sanitizeValue(event, roots, home);
}

/** Truncate to a UTF-8 byte budget, appending a marker with the number of dropped bytes. */
export function truncateBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  const kept = buf.subarray(0, maxBytes).toString("utf8").replace(/�$/, "");
  return { text: `${kept}\n…[truncated ${buf.byteLength - maxBytes} bytes]`, truncated: true };
}
