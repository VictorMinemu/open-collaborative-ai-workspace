// Outbound sanitisation: every string that leaves the device passes through `contain()` (absolute
// host paths -> repo-relative or `~/...`) and `redact()` (credentials). AGENTS.md principles 7 and 8.

import { homedir } from 'node:os';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Characters that may continue a path segment; a root only matches at a segment boundary. */
const SEGMENT_CHAR = '[A-Za-z0-9._@+~-]';

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
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
  const sorted = [...new Set(roots.filter((r) => r && r.startsWith('/')).map(stripTrailingSlash))].sort(
    (a, b) => b.length - a.length,
  );
  for (const root of sorted) {
    if (root === '/') continue;
    const re = new RegExp(`${escapeRegExp(root)}(?!${SEGMENT_CHAR})(/)?`, 'g');
    out = out.replace(re, (_m, slash: string | undefined) => (slash ? '' : '.'));
  }
  const h = stripTrailingSlash(home);
  if (h && h !== '/') out = out.replace(new RegExp(`${escapeRegExp(h)}(?!${SEGMENT_CHAR})`, 'g'), '~');
  out = out.replace(/\/(?:Users|home)\/[A-Za-z0-9._-]+(?![A-Za-z0-9._-])/g, '~');
  return out;
}

interface RedactionRule {
  re: RegExp;
  replace: string | ((substring: string, ...args: string[]) => string);
}

const REDACTIONS: RedactionRule[] = [
  // PEM blocks (also a block truncated before its END line).
  {
    re: /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g,
    replace: '[REDACTED:pem-block]',
  },
  { re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, replace: '[REDACTED:anthropic-key]' },
  { re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, replace: '[REDACTED:api-key]' },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, replace: '[REDACTED:github-token]' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: '[REDACTED:github-token]' },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}/g, replace: '[REDACTED:gitlab-token]' },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: '[REDACTED:slack-token]' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: '[REDACTED:google-key]' },
  { re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, replace: '[REDACTED:aws-access-key]' },
  {
    re: /(aws_secret_access_key|aws_session_token)(\s*[=:]\s*["']?)[A-Za-z0-9/+=]{16,}/gi,
    replace: (_m, key: string, sep: string) => `${key}${sep}[REDACTED]`,
  },
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, replace: (_m, scheme: string) => `${scheme} [REDACTED]` },
  // JWTs
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: '[REDACTED:jwt]' },
  // Credentials embedded in URLs: https://user:secret@host
  {
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi,
    replace: (_m, scheme: string, user: string) => `${scheme}${user}:[REDACTED]@`,
  },
  // Env-style assignments of secret-looking variables: FOO_API_KEY=..., export DB_PASSWORD="..."
  // (`=` only, so code such as `API_KEY: z.string()` stays readable in diffs).
  {
    re: /\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY)[A-Z0-9_]*)(\s*=\s*["']?)(?!\[REDACTED)[^\s"']{6,}/g,
    replace: (_m, key: string, sep: string) => `${key}${sep}[REDACTED]`,
  },
];

/** Redact API keys, tokens and private key material. Idempotent. */
export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { re, replace } of REDACTIONS) {
    re.lastIndex = 0;
    out = typeof replace === 'string' ? out.replace(re, replace) : out.replace(re, replace as never);
  }
  return out;
}

/** contain() then redact() one string. */
export function sanitizeString(text: string, roots: readonly string[], home?: string): string {
  return redact(contain(text, roots, home));
}

/** Deep-map every string (values only, not keys) of a JSON-like value. */
export function sanitizeValue<T>(value: T, roots: readonly string[], home?: string): T {
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return sanitizeString(v, roots, home);
    if (depth > 32 || v === null || typeof v !== 'object') return v;
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
export function sanitizeEvent<E extends { type: string }>(event: E, roots: readonly string[], home?: string): E {
  return sanitizeValue(event, roots, home);
}

/** Truncate to a UTF-8 byte budget, appending a marker with the number of dropped bytes. */
export function truncateBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  const kept = buf.subarray(0, maxBytes).toString('utf8').replace(/�$/, '');
  return { text: `${kept}\n…[truncated ${buf.byteLength - maxBytes} bytes]`, truncated: true };
}
