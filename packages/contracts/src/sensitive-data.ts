// Sensitive data, detector layer 1 (MEM-05, D-06, D-08): pure, browser-safe TypeScript, no Node APIs.
// The secret rules live here once; the Local Runtime's `redact()` delegates to `redactSecrets` and its output is
// byte-identical to the list it used to own (apps/local-runtime/src/redact-parity.test.ts proves it).

import { maskSample, type SensitiveFinding, type SensitiveSpan } from "./memory";

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

// The literals below come from the former `REDACTIONS` list in apps/local-runtime/src/sanitize.ts, in the same order;
// only `.source` and `.flags` are kept, so no regex object is shared between calls. Three of them (jwt, url-credentials,
// env-assignment) gained a lookaround so a long run is not rescanned from every start position (quadratic: ~17 s on
// 256 KiB of `a.`); their matches, groups and offsets are unchanged, proven against the original literals in
// sensitive-data.test.ts, and redact-parity.test.ts pins the Local Runtime's output.
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
  // JWTs. Only the first `eyJ` of a run may start a match: a later start in the same run has a shorter first segment and
  // needs the same `.` after the run, so it can only fail where the first one failed.
  rule(
    "jwt",
    /\b(?<!\beyJ[A-Za-z0-9_-]*?)eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    "[REDACTED:jwt]",
  ),
  // Credentials embedded in URLs: https://user:secret@host. The scheme always runs to the end of its `[a-z0-9+.-]` run,
  // so only the run's first word-start letter may start a match (the lookbehind skips the later ones).
  rule(
    "url-credentials",
    /\b(?=[a-z])(?<!(?:^|\W)[a-z][a-z0-9+.-]*?)([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi,
    (_m, scheme, user) => `${scheme}${user}:[REDACTED]@`,
  ),
  // Env-style assignments of secret-looking variables: FOO_API_KEY=..., export DB_PASSWORD="..."
  // (`=` only, so code such as `API_KEY: z.string()` stays readable in diffs). The name is the whole `[A-Z0-9_]` run
  // containing a keyword: the lookahead finds the keyword, then the run is taken once.
  rule(
    "env-assignment",
    /\b(?=[A-Z0-9_]*?(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY))([A-Z0-9_]+)(\s*=\s*["']?)(?!\[REDACTED)[^\s"']{6,}/g,
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

// ---------------------------------------------------------------- checksums (implemented in place, no dependency)

const NIF_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";

/** Luhn check over 13-19 digits; spaces and dashes are ignored. */
export const luhnOk = (s: string): boolean => {
  const digits = s.replace(/[ -]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
};

/** IBAN structure (2 letters, 2 check digits, 11-30 alphanumerics; spaces ignored) and ISO 13616 mod-97 == 1. */
export const ibanOk = (s: string): boolean => {
  const compact = s.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  let rem = 0;
  for (const ch of compact.slice(4) + compact.slice(0, 4)) {
    const v = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of v) rem = (rem * 10 + (c.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
};

/** Spanish NIF: 8 digits and the control letter `TRWAGMYFPDXBNJZSQVHLCKE[n % 23]`. */
export const nifOk = (s: string): boolean =>
  /^\d{8}[A-Z]$/.test(s) && NIF_LETTERS[Number(s.slice(0, 8)) % 23] === s[8];

/** Spanish NIE: X, Y or Z (read as 0, 1, 2), 7 digits and the NIF control letter. */
export const nieOk = (s: string): boolean =>
  /^[XYZ]\d{7}[A-Z]$/.test(s) && nifOk(`${"XYZ".indexOf(s.charAt(0))}${s.slice(1)}`);

// ---------------------------------------------------------------- detector layer 1

type DetectedKind = "secret" | "iban" | "payment_card" | "es_nif" | "es_nie" | "email" | "phone";

/** One detection rule: `accept` returns how many characters of the match are a finding (0 rejects it). */
interface DetectRule {
  kind: DetectedKind;
  source: string;
  flags: string;
  accept: (m: RegExpExecArray) => number;
}

const compactUpper = (s: string) => s.replace(/[\s-]/g, "").toUpperCase();

/** The longest prefix of an IBAN-shaped run that passes mod-97, cut at a space (a following word may be swallowed). */
function ibanLength(run: string): number {
  if (ibanOk(run)) return run.length;
  for (let i = run.lastIndexOf(" "); i > 0; i = run.lastIndexOf(" ", i - 1)) {
    const head = run.slice(0, i).trimEnd();
    if (ibanOk(head)) return head.length;
  }
  return 0;
}

const pii = (
  kind: DetectedKind,
  re: RegExp,
  accept: DetectRule["accept"] = (m) => m[0].length,
): DetectRule => ({
  kind,
  source: re.source,
  flags: re.flags,
  accept,
});

/**
 * Detection order is priority: a span claimed by an earlier rule is never reported again by a later one (a digit run
 * inside a JWT is not a card; an IBAN's digits are not a card or a phone). Every PII quantifier is bounded and every PII
 * rule starts at a boundary, so, with the secret rules above, a long adversarial run costs linear time.
 */
const DETECT_RULES: readonly DetectRule[] = [
  // Secrets: every rule of SECRET_RULES, in order. A match counts only if redacting it changes it, so an already
  // redacted value (`https://bob:[REDACTED]@host`) is not a secret.
  ...SECRET_RULES.map(
    (r): DetectRule => ({
      kind: "secret",
      source: r.source,
      flags: r.flags,
      accept: (m) => {
        const out = typeof r.replace === "string" ? r.replace : r.replace(m[0], ...(m.slice(1) as string[]));
        return out === m[0] ? 0 : m[0].length;
      },
    }),
  ),
  pii("iban", /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}/g, (m) => ibanLength(m[0])),
  pii("payment_card", /\b\d(?:[ -]?\d){12,18}\b/g, (m) => (luhnOk(m[0]) ? m[0].length : 0)),
  pii("es_nif", /\b\d{8}-?[A-Z]\b/gi, (m) => (nifOk(compactUpper(m[0])) ? m[0].length : 0)),
  pii("es_nie", /\b[XYZ]-?\d{7}-?[A-Z]\b/gi, (m) => (nieOk(compactUpper(m[0])) ? m[0].length : 0)),
  pii(
    "email",
    /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24}(?![\w-])/g,
  ),
  // Spanish mobile and landline (9 digits starting 6-9, optional +34), then any E.164 number (+ and 8-15 digits).
  pii("phone", /(?<![\w+])(?:\+34[ -]?)?[6789](?:[ -]?\d){8}(?!\w)/g),
  pii("phone", /(?<![\w+])\+[1-9](?:[ -]?\d){7,14}(?!\d)/g),
];

/** Report order and severity: secrets block every write; PII warns the approver. */
const KIND_ORDER: readonly DetectedKind[] = [
  "secret",
  "iban",
  "payment_card",
  "es_nif",
  "es_nie",
  "email",
  "phone",
];

const MAX_SAMPLES = 3;
const MAX_LINES = 20;
/** `SensitiveFinding.samples` items are at most 80 characters (a masked email keeps its domain). */
const MAX_SAMPLE_LENGTH = 80;

interface Hit {
  kind: DetectedKind;
  start: number;
  end: number;
}

/** Sorted, non-overlapping hits: is `[start, end)` free? Binary search on `end` (sorted too, as hits never overlap). */
function isFree(claimed: readonly Hit[], start: number, end: number): boolean {
  let lo = 0;
  let hi = claimed.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((claimed[mid] as Hit).end <= start) lo = mid + 1;
    else hi = mid;
  }
  return lo === claimed.length || (claimed[lo] as Hit).start >= end;
}

function mergeSorted(a: readonly Hit[], b: readonly Hit[]): Hit[] {
  const out: Hit[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    if (y === undefined || (x !== undefined && x.start <= y.start)) {
      out.push(x as Hit);
      i++;
    } else {
      out.push(y);
      j++;
    }
  }
  return out;
}

/** 1-based line of each offset, by binary search over the line start offsets. */
function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

export interface SensitiveScan {
  findings: SensitiveFinding[];
  spans: SensitiveSpan[];
}

/**
 * Detector layer 1 (MEM-05, D-06): secrets (`block`) and IBAN, payment cards, NIF, NIE, email and phone numbers
 * (`warn`, checksums where they exist). Findings carry counts, 1-based line numbers and masked samples only, never a
 * raw value; `spans` are UTF-16 offsets into `text` for highlighting. `opts.lines` (1-based) restricts the report to
 * hits touching those lines (the changed lines of a proposal); the whole text is still scanned, so offsets stay valid
 * and a secret spanning several lines still claims its span. Deterministic: fresh RegExp objects on every call.
 */
export function detectSensitive(text: string, opts?: { lines?: readonly number[] }): SensitiveScan {
  if (!text) return { findings: [], spans: [] };
  const lineOf = lineIndex(text);
  const wanted = opts?.lines ? new Set(opts.lines) : null;
  const touchesWanted = (h: Hit): boolean => {
    if (!wanted) return true;
    const first = lineOf(h.start);
    const last = lineOf(h.end - 1);
    if (last - first < wanted.size) {
      for (let l = first; l <= last; l++) if (wanted.has(l)) return true;
      return false;
    }
    for (const l of wanted) if (l >= first && l <= last) return true;
    return false;
  };

  let claimed: Hit[] = [];
  for (const rule of DETECT_RULES) {
    const found: Hit[] = [];
    for (const m of text.matchAll(new RegExp(rule.source, rule.flags))) {
      const length = rule.accept(m);
      if (length <= 0) continue;
      const start = m.index;
      const end = start + length;
      if (isFree(claimed, start, end)) found.push({ kind: rule.kind, start, end });
    }
    if (found.length > 0) claimed = mergeSorted(claimed, found);
  }

  const reported = claimed.filter(touchesWanted);
  const findings: SensitiveFinding[] = [];
  for (const kind of KIND_ORDER) {
    const hits = reported.filter((h) => h.kind === kind);
    if (hits.length === 0) continue;
    const samples: string[] = [];
    for (const h of hits) {
      if (samples.length >= MAX_SAMPLES) break;
      const masked = maskSample(kind, text.slice(h.start, h.end));
      const sample =
        masked.length > MAX_SAMPLE_LENGTH ? `${masked.slice(0, MAX_SAMPLE_LENGTH - 1)}…` : masked;
      if (!samples.includes(sample)) samples.push(sample);
    }
    const lines = [...new Set(hits.map((h) => lineOf(h.start)))].sort((a, b) => a - b).slice(0, MAX_LINES);
    findings.push({
      kind,
      severity: kind === "secret" ? "block" : "warn",
      source: "builtin",
      count: hits.length,
      samples,
      lines,
    });
  }
  return { findings, spans: reported.map(({ kind, start, end }) => ({ kind, start, end })) };
}

/** True when any finding blocks the write (a secret: principle 8 forbids plaintext secrets in the database). */
export function hasBlockingFinding(findings: readonly SensitiveFinding[]): boolean {
  return findings.some((f) => f.severity === "block");
}
