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

function isSafeSegment(seg: string): boolean {
  if (seg === "" || seg === "." || seg === "..") return false;
  if (seg.length > BOT_FILE_LIMITS.segmentMaxChars) return false;
  return !seg.endsWith(" ") && !seg.endsWith(".");
}

/**
 * A file inside a session's working tree, named relative to it: 1 … 1 024 characters, `/`-separated; never absolute
 * (`/`), a home shortcut (`~`), a drive (`C:`), a backslash, a control or bidi character; every segment non-empty, not
 * `.` or `..`, at most 255 characters and not ending in a space or a dot (Windows would silently drop them). The device
 * re-checks it against the real tree (realpath containment, no symlink escape).
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
      p.split("/").every(isSafeSegment),
    { message: "must be a file path inside the session's working tree" },
  );
export type WorkSessionFilePath = z.infer<typeof WorkSessionFilePath>;

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
