import { AUTOMATION_LIMITS } from "@ocw/contracts";
import PostalMime from "postal-mime";

/**
 * A polled mail as the platform stores it (07.6-11; AUTO-02, D-07, P-09; research Pattern 5). The source is untrusted
 * MIME: postal-mime decodes it (encoded words, charsets, transfer encodings), and only plain text leaves this file
 * (HTML converted here, never rendered), capped like the `automation_events` columns.
 *
 * - `messageId`: the Message-ID when it is one `<id>` (the idempotency key; null → the caller hashes UIDVALIDITY:UID).
 * - `threadKey`: the first References id, else In-Reply-To, else the own Message-ID (21 threads follow-ups on it).
 * - `skipReason`: the loop filters, so no automation can trigger itself through mail: our own
 *   `X-OCW-Automation-Run` header, mail from the mailbox's own address, RFC 3834 `Auto-Submitted` other than `no`,
 *   `Precedence: bulk | junk | list`.
 */

export type MailSkipReason = "auto_submitted" | "bulk" | "self" | "own_header";

export interface ParsedMail {
  messageId: string | null;
  subject: string;
  /** `Name <address>` (or the address), at most 320 characters; null without a From. */
  from: string | null;
  fromAddress: string | null;
  /** Plain text (HTML converted), at most 32 768 characters. */
  text: string;
  threadKey: string | null;
  skipReason: MailSkipReason | null;
}

const ID_MAX = 998;
const SUBJECT_MAX = 500;
const SENDER_MAX = 320;
/**
 * One `<…>` message id (RFC 5322 msg-id, loosely): no spaces, no brackets and no control characters inside. An id with
 * a control character is no id at all (the caller keys the mail by its UID hash instead): PostgreSQL `text` refuses
 * U+0000, and a key is never worth a poisoned row (07.6 review A CR-01).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what an id may not hold.
const MSG_ID = /<[^<>\s\u0000-\u001f\u007f]{1,996}>/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: as above.
const ONE_ID = /^\s*(<[^<>\s\u0000-\u001f\u007f]{1,996}>)\s*$/;

/**
 * Removes U+0000, which postal-mime decodes from a quoted-printable `=00`, a base64 NUL or a raw 0x00 byte, and which
 * PostgreSQL `text` refuses (`22021`): one such mail would otherwise fail its poll's insert forever. Every string that
 * leaves this file for a column goes through it.
 */
const noNul = (s: string): string => (s.includes("\u0000") ? s.replaceAll("\u0000", "") : s);

const header = (headers: Array<{ key: string; value: string }>, key: string): string[] =>
  headers.filter((h) => h.key === key).map((h) => h.value);

function firstId(value: string | undefined): string | null {
  if (!value) return null;
  const found = value.match(MSG_ID);
  return found?.[0] ?? null;
}

const lower = (v: string) => v.trim().toLowerCase();

function skipReasonOf(
  headers: Array<{ key: string; value: string }>,
  fromAddress: string | null,
  mailboxAddress: string,
): MailSkipReason | null {
  if (header(headers, "x-ocw-automation-run").length > 0) return "own_header";
  if (fromAddress && mailboxAddress && lower(fromAddress) === lower(mailboxAddress)) return "self";
  // RFC 3834: any value other than `no` (the keyword before its parameters) marks an automatic message.
  if (header(headers, "auto-submitted").some((v) => lower(v.split(";")[0] ?? "") !== "no"))
    return "auto_submitted";
  if (header(headers, "precedence").some((v) => ["bulk", "junk", "list"].includes(lower(v)))) return "bulk";
  return null;
}

// ---------------------------------------------------------------- HTML → text

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  euro: "€",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
        return " ";
      return String.fromCodePoint(code);
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const TAG_END = /[\s/>]/;

/** The next `needle` (`<head`, `</head`) at a tag boundary from `from`, so `<head` never catches `<header`. */
function findTag(low: string, needle: string, from: number): number {
  let at = low.indexOf(needle, from);
  while (at >= 0 && !TAG_END.test(low[at + needle.length] ?? ">")) at = low.indexOf(needle, at + 1);
  return at;
}

/** Removes `<tag …>…</tag>` blocks (a missing close drops the rest). One forward scan: linear on any input. */
function dropBlocks(html: string, tag: string): string {
  const low = html.toLowerCase();
  const open = `<${tag}`;
  const close = `</${tag}`;
  let out = "";
  let at = 0;
  for (;;) {
    const start = findTag(low, open, at);
    if (start < 0) return out + html.slice(at);
    out += `${html.slice(at, start)} `;
    const end = findTag(low, close, start + open.length);
    if (end < 0) return out;
    const gt = low.indexOf(">", end);
    if (gt < 0) return out;
    at = gt + 1;
  }
}

const BREAKS = new Set([
  "br",
  "p",
  "div",
  "tr",
  "table",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "blockquote",
]);

/**
 * Readable text of untrusted HTML: comments, `head`, `script` and `style` dropped, block tags as line breaks, every
 * other tag removed, entities decoded. Hand-written scanners (no backtracking regex over the markup), so a hostile
 * body costs linear time.
 */
export function htmlToText(html: string): string {
  let s = html;
  // Comments first (they may hide tags), then the blocks whose content is not text.
  {
    let out = "";
    let at = 0;
    for (;;) {
      const start = s.indexOf("<!--", at);
      if (start < 0) {
        out += s.slice(at);
        break;
      }
      out += s.slice(at, start);
      const end = s.indexOf("-->", start + 4);
      if (end < 0) break;
      at = end + 3;
    }
    s = out;
  }
  for (const tag of ["head", "script", "style", "noscript", "template", "title"]) s = dropBlocks(s, tag);
  let out = "";
  let at = 0;
  for (;;) {
    const lt = s.indexOf("<", at);
    if (lt < 0) {
      out += s.slice(at);
      break;
    }
    out += s.slice(at, lt);
    const gt = s.indexOf(">", lt + 1);
    if (gt < 0) break; // an unclosed tag: the rest is markup
    const name = /^\/?([a-z][a-z0-9]{0,9})/i.exec(s.slice(lt + 1, Math.min(gt, lt + 13)))?.[1]?.toLowerCase();
    if (name && BREAKS.has(name)) out += name === "li" ? "\n* " : "\n";
    else out += name ? "" : " ";
    at = gt + 1;
  }
  return decodeEntities(out)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------- parse

/** Parses one mail source (already capped by the fetch at 256 KiB). Never throws on malformed MIME. */
export async function parseMail(source: Buffer, ctx: { mailboxAddress: string }): Promise<ParsedMail> {
  let email: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    email = await PostalMime.parse(source, { maxNestingDepth: 32, maxPartCount: 200 });
  } catch {
    return {
      messageId: null,
      subject: "",
      from: null,
      fromAddress: null,
      text: "",
      threadKey: null,
      skipReason: null,
    };
  }
  const headers = email.headers ?? [];
  const messageId = ONE_ID.exec(email.messageId ?? "")?.[1]?.slice(0, ID_MAX) ?? null;
  const from = email.from && "address" in email.from && email.from.address ? email.from : null;
  const fromAddress = from?.address ? noNul(from.address).trim().slice(0, SENDER_MAX) || null : null;
  const name = noNul(from?.name ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim();
  const sender = fromAddress ? (name ? `${name} <${fromAddress}>` : fromAddress).slice(0, SENDER_MAX) : null;
  const body = noNul(email.text?.trim() ? email.text : email.html ? htmlToText(email.html) : "");
  return {
    messageId,
    subject: noNul(email.subject ?? "")
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(0, SUBJECT_MAX),
    from: sender,
    fromAddress,
    text: body.replace(/\r\n?/g, "\n").trim().slice(0, AUTOMATION_LIMITS.mailTextMaxChars),
    threadKey: (firstId(email.references) ?? firstId(email.inReplyTo) ?? messageId)?.slice(0, ID_MAX) ?? null,
    skipReason: skipReasonOf(headers, fromAddress, ctx.mailboxAddress),
  };
}
