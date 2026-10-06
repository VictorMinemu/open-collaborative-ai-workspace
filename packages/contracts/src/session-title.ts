import { z } from "zod";
import type { RuntimeId } from "./session-events";

/**
 * Automatic Work Zone session titles (D-18 … D-20, ADR-0014). The device asks the session runtime's small model
 * for a short title of the first prompt, normalizes and sanitizes it (`normalizeSessionTitle`), and the API
 * validates it again (`SessionTitle`) before storing it. Both share one word counter (`titleWords`).
 */

/** Where a session title came from: typed by a user (never replaced), the prompt's first line, or generated. */
export const TitleSource = z.enum(["user", "heuristic", "auto"]);
export type TitleSource = z.infer<typeof TitleSource>;

/** 32 characters fit one Work Zone sidebar row (~219 px at 14 px) at 1440 and in the 390 drawer (D-20). */
export const SESSION_TITLE_MAX_CHARS = 32;
export const SESSION_TITLE_MIN_WORDS = 2;
export const SESSION_TITLE_MAX_WORDS = 5;
/** The device's own deadline for a title call (P-19). */
export const TITLE_TIMEOUT_MS = 20_000;
/** Only the start of the first prompt goes to the title call. */
export const TITLE_PROMPT_MAX_CHARS = 4_000;

/** The small model each runtime titles with (D-18). Used only when the device catalog lists it. */
export const TITLE_MODEL: Readonly<Record<RuntimeId, string>> = {
  "claude-code": "haiku",
  codex: "gpt-6-luna",
};

/** Stable prefixes of a failed `session.title` ack (`"<code>: <detail>"`). */
export const TitleFailureCode = z.enum([
  "title_unsupported",
  "title_runtime_mismatch",
  "title_model_not_in_catalog",
  "title_timeout",
  "title_failed",
  "title_used_tool",
  "title_model_mismatch",
  "title_invalid_shape",
  "title_sanitized",
]);
export type TitleFailureCode = z.infer<typeof TitleFailureCode>;

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Word-like segments (so scripts written without spaces count their words too). */
export function titleWords(text: string): string[] {
  return [...segmenter.segment(text)].filter((s) => s.isWordLike).map((s) => s.segment);
}

/** End offset (UTF-16) of each word-like segment, in order. */
function wordEnds(text: string): number[] {
  return [...segmenter.segment(text)].filter((s) => s.isWordLike).map((s) => s.index + s.segment.length);
}

const QUOTES = `"'\`“”‘’«»„‚「」『』`;
const TRAILING_PUNCT_RE = /[\s.,;:!?…。，；：！？、·\-–—]+$/u;
const LEADING_JUNK_RE = /^[\s#>*_\-–—•·]+/u;
const LABEL_RE = /^(?:title|t[ií]tulo)\s*[:：]\s*/iu;
const WRAP_QUOTES_LEAD_RE = new RegExp(`^[${QUOTES}\\s]+`, "u");
const WRAP_QUOTES_TRAIL_RE = new RegExp(`[${QUOTES}\\s]+$`, "u");
const CONTROL_RE = /[\p{Cc}\p{Cf}]/gu;
/** A home directory (`/Users/…`, `/home/…`, `/root/…`, `~/`) or a Windows drive (`C:\`). */
const HOST_PATH_RE = /(?:[\\/](?:Users|home|root)[\\/]|~[\\/]|(?:^|[^\p{L}\p{N}])[A-Za-z]:[\\/])/u;

/** First letter upper, the rest lower (`Rate`, `In`, `A`). */
const isCapitalized = (w: string) => /^\p{Lu}[\p{Ll}\p{M}'’-]*$/u.test(w);
/** Contains a cased letter, all lower (`login`). */
const isLower = (w: string) => /\p{Ll}/u.test(w) && !/\p{Lu}/u.test(w);

/**
 * Title Case → sentence case: when every later word starts upper (short lower words such as "in" are tolerated),
 * plain capitalized words are lowered. All-caps and mixed-case words (API, GitHub) keep their case.
 */
function toSentenceCase(text: string): string {
  const words = text.split(" ");
  const later = words.slice(1).filter((w) => /\p{L}/u.test(w));
  if (later.length === 0) return text;
  const titleCase = later.some(isCapitalized) && later.every((w) => !isLower(w) || [...w].length <= 3);
  if (!titleCase) return text;
  return [words[0]!, ...words.slice(1).map((w) => (isCapitalized(w) ? w.toLowerCase() : w))].join(" ");
}

function stripMarks(line: string): string {
  let s = line;
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s
      .replace(/<[^>]*>/g, " ")
      .replace(/[<>*`]/g, "")
      .replace(/__/g, "")
      .replace(LEADING_JUNK_RE, "")
      .replace(LABEL_RE, "")
      .replace(WRAP_QUOTES_LEAD_RE, "")
      .replace(WRAP_QUOTES_TRAIL_RE, "")
      .replace(TRAILING_PUNCT_RE, "");
    if (s === before) break;
  }
  return s;
}

/**
 * The device-side shape rule (P-16): first non-empty line, no label / markdown / quotes / control characters /
 * trailing punctuation, collapsed whitespace, sentence case, first letter upper, at most 5 words and 32 characters
 * cut on a word boundary. Returns null when fewer than 2 words remain.
 */
export function normalizeSessionTitle(raw: string): string | null {
  const line = raw
    .replace(/\r\n?/g, "\n")
    .split(/[\n\u2028\u2029]/)
    .map((l) => l.replace(/\t/g, " ").replace(CONTROL_RE, "").trim())
    .find((l) => stripMarks(l).length > 0);
  if (!line) return null;
  let s = stripMarks(line).replace(/\s+/gu, " ").trim();
  s = toSentenceCase(s);
  s = s.charAt(0).toLocaleUpperCase() + s.slice(1);
  const ends = wordEnds(s);
  if (ends.length > SESSION_TITLE_MAX_WORDS) s = s.slice(0, ends[SESSION_TITLE_MAX_WORDS - 1]);
  if (s.length > SESSION_TITLE_MAX_CHARS) {
    const fit = wordEnds(s).filter((e) => e <= SESSION_TITLE_MAX_CHARS);
    if (fit.length === 0) return null;
    s = s.slice(0, fit[fit.length - 1]);
  }
  s = stripMarks(s).replace(/\s+/gu, " ").trim();
  if (titleWords(s).length < SESSION_TITLE_MIN_WORDS) return null;
  // Content checks (host paths, secrets) are the caller's: the device sanitizes, the API validates (SessionTitle).
  return s;
}

/** Why a title is refused (empty = valid). The API applies this to every device-supplied title. */
export function titleProblems(text: string): string[] {
  const problems: string[] = [];
  if (text.length === 0) return ["empty"];
  if (text.length > SESSION_TITLE_MAX_CHARS) problems.push("too_long");
  const words = titleWords(text).length;
  if (words < SESSION_TITLE_MIN_WORDS) problems.push("too_few_words");
  if (words > SESSION_TITLE_MAX_WORDS) problems.push("too_many_words");
  if (/[\r\n\u2028\u2029]/u.test(text)) problems.push("line_break");
  if (/[\p{Cc}\p{Cf}]/u.test(text)) problems.push("control_character");
  if (/[`*<>]/.test(text)) problems.push("markup");
  if (text !== text.trim() || /\s{2,}/u.test(text)) problems.push("whitespace");
  if (new RegExp(`^[${QUOTES}]|[${QUOTES}]$`, "u").test(text)) problems.push("wrapping_quotes");
  if (/[.,;:!?…。，；：！？、·\-–—]$/u.test(text)) problems.push("trailing_punctuation");
  if (HOST_PATH_RE.test(text)) problems.push("host_path");
  return problems;
}

/** A device-supplied session title the API accepts (D-20). */
export const SessionTitle = z.string().superRefine((text, ctx) => {
  for (const problem of titleProblems(text)) ctx.addIssue({ code: "custom", message: problem });
});
