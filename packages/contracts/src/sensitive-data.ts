// Sensitive data, detector layer 1 (MEM-05, D-06, D-08): pure, browser-safe TypeScript, no Node APIs.
// The secret rules live here once; the Local Runtime's `redact()` delegates to `redactSecrets` and its output is
// byte-identical to the list it used to own (apps/local-runtime/src/redact-parity.test.ts proves it).

/**
 * One secret pattern. `source` and `flags` build a fresh `RegExp` on every call (shared `/g` objects keep `lastIndex`
 * between calls, RESEARCH Pitfall 9). A function `replace` keeps the matched key (`DB_PASSWORD=[REDACTED]`).
 */
export interface SecretRule {
  id: string;
  source: string;
  flags: string;
  replace: string | ((m: string, ...g: string[]) => string);
}

// The literals below are copied verbatim from the former `REDACTIONS` list in apps/local-runtime/src/sanitize.ts, in the
// same order; only `.source` and `.flags` are kept, so no regex object is shared between calls.
const rule = (id: string, re: RegExp, replace: SecretRule["replace"]): SecretRule =>
  Object.freeze({ id, source: re.source, flags: re.flags, replace });

/** Applied in this order: an earlier rule's placeholder is never re-matched by a later one. */
export const SECRET_RULES: readonly SecretRule[] = Object.freeze([
  // PEM blocks (also a block truncated before its END line).
  rule(
    "pem-block",
    /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g,
    "[REDACTED:pem-block]",
  ),
  rule("anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{8,}/g, "[REDACTED:anthropic-key]"),
  rule("api-key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED:api-key]"),
  rule("github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "[REDACTED:github-token]"),
  rule("github-pat", /\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED:github-token]"),
  rule("gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}/g, "[REDACTED:gitlab-token]"),
  rule("slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[REDACTED:slack-token]"),
  rule("google-key", /\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED:google-key]"),
  rule("aws-access-key", /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, "[REDACTED:aws-access-key]"),
  rule(
    "aws-secret",
    /(aws_secret_access_key|aws_session_token)(\s*[=:]\s*["']?)[A-Za-z0-9/+=]{16,}/gi,
    (_m, key, sep) => `${key}${sep}[REDACTED]`,
  ),
  rule("auth-header", /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, (_m, scheme) => `${scheme} [REDACTED]`),
  // JWTs
  rule("jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED:jwt]"),
  // Credentials embedded in URLs: https://user:secret@host
  rule(
    "url-credentials",
    /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi,
    (_m, scheme, user) => `${scheme}${user}:[REDACTED]@`,
  ),
  // Env-style assignments of secret-looking variables: FOO_API_KEY=..., export DB_PASSWORD="..."
  // (`=` only, so code such as `API_KEY: z.string()` stays readable in diffs).
  rule(
    "env-assignment",
    /\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY)[A-Z0-9_]*)(\s*=\s*["']?)(?!\[REDACTED)[^\s"']{6,}/g,
    (_m, key, sep) => `${key}${sep}[REDACTED]`,
  ),
]);

/** Redact API keys, tokens and private key material. Idempotent. The algorithm `redact()` always used. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { source, flags, replace } of SECRET_RULES) {
    const re = new RegExp(source, flags);
    out = typeof replace === "string" ? out.replace(re, replace) : out.replace(re, replace);
  }
  return out;
}
