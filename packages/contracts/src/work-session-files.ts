import { z } from "zod";
import { ATTACHMENT_DEFAULT_MAX_BYTES } from "./attachments";

/**
 * Bot file exchange with its Work Zone sessions (Phase 07.17.1.1, D-02, D-03, D-07, D-08, D-09; BWF-01 … BWF-08): a bot
 * uploads an attachment of its turn's thread into a session it started, or downloads one file of that session back to
 * the conversation as an attachment.
 *
 * - Repo-relative paths only (principle 7): the absolute form exists only on the device.
 * - Bytes never cross the Device Link (D-08): a command carries the path and the bounds, the device streams the bytes
 *   over HTTP to and from `RUNTIME_FILE_ROUTE` with its own device token, building the URL from its own server URL.
 * - One deny list both ways (D-09): the API pre-checks it before any transfer exists; the device decides it again on
 *   real paths, authoritative.
 *
 * Imports only `zod` and leaf contracts: `bot-work-zone`, `work-zone-policy` and `device-link` may import this file,
 * never the reverse.
 */

// ---------------------------------------------------------------- limits (D-06, D-07, PD-05, PD-18)

export const BOT_FILE_LIMITS = {
  /** The organization's limit when it saved none: the chat attachment default (25 MiB). */
  defaultMaxBytes: ATTACHMENT_DEFAULT_MAX_BYTES,
  /** The lowest limit an organization or a bot may save. */
  minMaxBytes: 1024 * 1024,
  /** The highest `OCW_ATTACHMENT_MAX_BYTES` a self-hoster may set, so the highest limit anywhere. */
  ceilingMaxBytes: 1024 ** 3,
  /** Files one turn moves in each direction. */
  filesPerTurnEachWay: 5,
  pathMaxChars: 1024,
  segmentMaxChars: 255,
  /** Object storage multipart part size (one part in memory at a time). */
  partBytes: 8 * 1024 * 1024,
  /** A transfer's deadline: this base plus one second per `transferBytesPerSecond`, at most `transferMaxMs`. */
  transferBaseMs: 30_000,
  transferBytesPerSecond: 1024 * 1024,
  transferMaxMs: 600_000,
  /** Streams one API process serves at once; beyond, the transfer route answers 503 and the device retries. */
  concurrentTransfersPerProcess: 4,
} as const;

/** How long a transfer of `bytes` may take, end to end (PD-18): 30 s + 1 s per MiB, at most 10 minutes. */
export function transferDeadlineMs(bytes: number): number {
  const L = BOT_FILE_LIMITS;
  return Math.min(L.transferMaxMs, L.transferBaseMs + Math.ceil(bytes / L.transferBytesPerSecond) * 1000);
}

// ---------------------------------------------------------------- the path rule (D-02, D-03, principle 7)

/**
 * C0 controls and DEL, and the bidi embeddings, overrides, isolates and marks (a "fdp.exe" spoof). Compared by code
 * point, so no such character ever appears in this source file.
 */
function hasUnsafePathChar(p: string): boolean {
  for (const ch of p) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x1f || c === 0x7f || c === 0x200e || c === 0x200f) return true;
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return true;
  }
  return false;
}

/**
 * The form two file names are compared in (review CR-01): NFKC, then a full case fold. Case-insensitive APFS and NTFS
 * open a name under more spellings than `toLowerCase` folds: U+017F (long s) opens `s`, U+212A (Kelvin sign) opens `k`,
 * NTFS's upcase table maps U+0131 (dotless i) to `I`, and NFKC maps compatibility forms (ligatures, fullwidth letters,
 * superscript digits) to their plain letters. Upper-casing before lower-casing applies the folds `toLowerCase` alone
 * misses (U+017F, U+0131, U+1E9E); the second NFKC re-composes what case mapping decomposed. Folding more than a volume
 * does only ever refuses more, never less. The API and the device both compare in this form (`@ocw/contracts`).
 */
export function canonicalFileName(name: string): string {
  return name.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}

function isSafeSegment(seg: string): boolean {
  if (seg === "" || seg === "." || seg === "..") return false;
  if (seg.length > BOT_FILE_LIMITS.segmentMaxChars) return false;
  return !seg.endsWith(" ") && !seg.endsWith(".");
}

/** Safe as written AND in its folded form: a compatibility character never folds into `/`, `\`, `:` or `..`. */
function isSafeSegmentBothForms(seg: string): boolean {
  if (!isSafeSegment(seg)) return false;
  const folded = canonicalFileName(seg);
  return isSafeSegment(folded) && !/[/\\:]/.test(folded);
}

/**
 * A file inside a session's working tree, named relative to it: 1 … 1 024 characters, `/`-separated; never absolute
 * (`/`), a home shortcut (`~`), a drive (`C:`), a backslash, a control or bidi character; every segment non-empty, not
 * `.` or `..`, at most 255 characters and not ending in a space or a dot (Windows would silently drop them), in both its
 * written and its folded form (`canonicalFileName`). The device re-checks it against the real tree (realpath
 * containment, no symlink escape).
 */
export const WorkSessionFilePath = z
  .string()
  .min(1)
  .max(BOT_FILE_LIMITS.pathMaxChars)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.startsWith("~") &&
      !/^[A-Za-z]:/.test(p) &&
      !p.includes("\\") &&
      !hasUnsafePathChar(p) &&
      p.split("/").every(isSafeSegmentBothForms),
    { message: "must be a file path inside the session's working tree" },
  );
export type WorkSessionFilePath = z.infer<typeof WorkSessionFilePath>;

// ---------------------------------------------------------------- the shared deny list (D-09, PD-09)

/**
 * Copied verbatim from the Claude adapter's `ENV_TEMPLATE_ALLOW` / `SECRET_BASENAME`
 * (`apps/local-runtime/src/claude/tool-policy.ts`); since 07.17.1.1 the daemon imports this copy, so the two never
 * drift. Matched against the folded name (`canonicalFileName`), so case-insensitively and compatibility-folded.
 */
const ENV_TEMPLATE_ALLOW = /^\.env\.(example|sample|template|dist)$/i;
const SECRET_BASENAME = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.production …
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.key$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.keychain(-db)?$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^credentials(\.json)?$/i,
  /^\.credentials\.json$/i,
  /^device-token$/i,
];

/** True for a file name that holds credentials (`.env*` except the templates, private keys, keychains, rc files). */
export function isSecretBasename(name: string): boolean {
  const folded = canonicalFileName(name);
  if (ENV_TEMPLATE_ALLOW.test(folded)) return false;
  return SECRET_BASENAME.some((re) => re.test(folded));
}

/** Why a path may not be moved: the repository, the worktrees, a runtime's configuration, or a secrets file. */
export const WorkSessionFileDenyReason = z.enum(["git", "worktrees", "runtime_config", "secret"]);
export type WorkSessionFileDenyReason = z.infer<typeof WorkSessionFileDenyReason>;

/**
 * The one deny list for both directions (D-09): any `.git` segment → `git`; any `.ocw-worktrees` → `worktrees`; any
 * `.claude` or `.codex`, or a final `.mcp.json` → `runtime_config` (planting runtime configuration would steer the
 * session); a secret base name → `secret` (uploading `.env` is refused on purpose). Segments are compared in their
 * folded form (`canonicalFileName`: APFS and NTFS are case-insensitive by default and fold more than `toLowerCase`,
 * review CR-01). Pure: the API pre-checks it, the device decides it on real paths.
 */
export function workSessionFilePathRefusal(rel: string): WorkSessionFileDenyReason | null {
  const segments = rel.split("/").map(canonicalFileName);
  const last = segments[segments.length - 1] ?? "";
  if (segments.includes(".git")) return "git";
  if (segments.includes(".ocw-worktrees")) return "worktrees";
  if (segments.includes(".claude") || segments.includes(".codex") || last === ".mcp.json")
    return "runtime_config";
  if (isSecretBasename(last)) return "secret";
  return null;
}

// ---------------------------------------------------------------- the limit that applies (D-07)

/** Which level set the per-file limit that applied. */
export const BotFileLimitSource = z.enum(["bot", "organization", "server"]);
export type BotFileLimitSource = z.infer<typeof BotFileLimitSource>;

/** The effective per-file limit and the level that set it. */
export const BotFileLimit = z.object({ bytes: z.number().int().positive(), source: BotFileLimitSource });
export type BotFileLimit = z.infer<typeof BotFileLimit>;

/** How a refusal and the settings name each level. */
export const BOT_FILE_LIMIT_SOURCE_LABELS: Readonly<Record<BotFileLimitSource, string>> = {
  bot: "this bot's limit",
  organization: "the organization's limit",
  server: "the server's limit",
};

/**
 * The per-file limit for one call (PD-11): the lowest of the bot's (null or absent = none), the organization's (absent
 * = 25 MiB) and the server's (`OCW_ATTACHMENT_MAX_BYTES`). On a tie the outer level is named (the server, then the
 * organization), because a person cannot raise it from the bot's profile.
 */
export function effectiveBotFileMaxBytes(p: {
  bot: number | null | undefined;
  organization: number | null | undefined;
  server: number;
}): BotFileLimit {
  let limit: BotFileLimit = { bytes: p.server, source: "server" };
  const organization = p.organization ?? BOT_FILE_LIMITS.defaultMaxBytes;
  if (organization < limit.bytes) limit = { bytes: organization, source: "organization" };
  if (p.bot !== null && p.bot !== undefined && p.bot < limit.bytes) limit = { bytes: p.bot, source: "bot" };
  return limit;
}

const SIZE_UNITS = ["B", "KB", "MB", "GB"] as const;

/** The chat's `formatBytes` rules: 1 536 → "1.5 KB", 25 MiB → "25 MB" (binary units, one decimal, ".0" dropped). */
export function fileSizeLabel(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${SIZE_UNITS[unit]}`;
}

/** The `file_too_large` sentence naming the limit that applied (≤ 300 characters; numbers and fixed labels only). */
export function botFileTooLargeSentence(p: { sizeBytes?: number | null; limit: BotFileLimit }): string {
  const limit = `${fileSizeLabel(p.limit.bytes)} (${BOT_FILE_LIMIT_SOURCE_LABELS[p.limit.source]})`;
  const text =
    p.sizeBytes === null || p.sizeBytes === undefined
      ? `That file is larger than this bot may move: up to ${limit}.`
      : `That file is ${fileSizeLabel(p.sizeBytes)}. This bot moves files up to ${limit}.`;
  return text.slice(0, 300);
}

// ---------------------------------------------------------------- device commands (D-04, D-08, PD-05, PD-15)

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * `session.file.write`: write one file of an active, idle session from `GET <serverUrl>/api/v1/runtime/files/<command
 * id>`. The transfer id IS the command id; the payload names no URL and carries no bytes (P2). A plain object, so a
 * newer API's extra key never breaks an older daemon.
 */
export const SessionFileWritePayload = z.object({
  path: WorkSessionFilePath,
  sizeBytes: z.number().int().nonnegative().max(BOT_FILE_LIMITS.ceilingMaxBytes),
  sha256: Sha256Hex.nullable(),
  overwrite: z.boolean(),
});
export type SessionFileWritePayload = z.infer<typeof SessionFileWritePayload>;

/** `session.file.read`: stream one regular file of an active session, at most `maxBytes`, to `PUT …/<command id>`. */
export const SessionFileReadPayload = z.object({
  path: WorkSessionFilePath,
  maxBytes: z.number().int().positive().max(BOT_FILE_LIMITS.ceilingMaxBytes),
});
export type SessionFileReadPayload = z.infer<typeof SessionFileReadPayload>;

/** The codes a device acks a failed file command with (the ack error is `code` or `code: detail`). */
export const SessionFileFailure = z.enum([
  "invalid_path",
  "path_not_allowed",
  "not_found",
  "not_a_file",
  "exists",
  "too_large",
  "busy",
  "not_running",
  "no_space",
  "mismatch",
  "expired",
  "transfer_failed",
]);
export type SessionFileFailure = z.infer<typeof SessionFileFailure>;

const ACK_DETAIL_MAX = 120;

/** The ack error a device sends: the code, then at most one line of 120 characters of detail. */
export function sessionFileAckError(code: SessionFileFailure, detail?: string): string {
  const line = (detail ?? "").split(/\r?\n/, 1)[0]?.trim().slice(0, ACK_DETAIL_MAX) ?? "";
  return line ? `${code}: ${line}` : code;
}

/** The exact ack of a daemon that does not know a command kind (`local-runtime/src/device-link.ts`). */
const OLD_DAEMON_ACK = "invalid command frame";

/**
 * Reads a file command's ack error: an older daemon's `invalid command frame` → `runtime_too_old` (PD-15); `too_large:
 * <n>` carries the file's size; anything else unknown → `unknown`.
 */
export function parseSessionFileAck(error: string | null | undefined): {
  code: SessionFileFailure | "runtime_too_old" | "unknown";
  sizeBytes?: number;
} {
  if (error === null || error === undefined) return { code: "unknown" };
  const text = error.trim();
  if (text === OLD_DAEMON_ACK) return { code: "runtime_too_old" };
  const sep = text.indexOf(":");
  const head = (sep === -1 ? text : text.slice(0, sep)).trim();
  const code = SessionFileFailure.safeParse(head);
  if (!code.success) return { code: "unknown" };
  if (code.data === "too_large" && sep !== -1) {
    const detail = text.slice(sep + 1).trim();
    if (/^\d{1,16}$/.test(detail)) return { code: "too_large", sizeBytes: Number(detail) };
  }
  return { code: code.data };
}

/** Where a device streams a transfer's bytes, under its own device token: `GET|PUT <route>/<command id>`. */
export const RUNTIME_FILE_ROUTE = "/api/v1/runtime/files";

/** The `PUT` answer: the bytes the API counted and stored. */
export const RuntimeFilePutAnswer = z.object({
  ok: z.literal(true),
  sizeBytes: z.number().int().nonnegative(),
});
export type RuntimeFilePutAnswer = z.infer<typeof RuntimeFilePutAnswer>;
