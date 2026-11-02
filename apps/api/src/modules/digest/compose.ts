import { AUTOMATION_LIMITS, type DigestSection } from "@ocw/contracts";

/**
 * The digest message (07.6-13; AUTO-05, D-05, UI-SPEC § Copy › Digest DM headings). Pure: the same items, date and
 * zone always give the same Markdown, and the list is never written by a model (an optional summary only goes on top).
 *
 * Every link is a same-origin relative path built from ids (`/approvals/<id>`, `/chat/<id>?m=<id>`, `/work-zone/<id>`,
 * `/settings/digest`), so the web's `safeUrl` keeps it and it says nothing to someone who cannot open it. Every text
 * that came from a person, a bot or a model (titles, names, the summary) is flattened to one line, cut and escaped, so
 * it can never open a link, an image, a heading or HTML in the message.
 */

/** One line of a section. */
export interface DigestItem {
  /** Plain text (escaped here). */
  title: string;
  /** A same-origin relative path (`/…`). */
  href: string;
  /** Plain text after the title (who asked, where, the state), or null. */
  detail: string | null;
  /** When it happened (shown in the person's zone). */
  at: Date;
}

export type DigestItems = Partial<Record<DigestSection, readonly DigestItem[]>>;

/** At most this many lines per section (the queries return no more). */
export const DIGEST_SECTION_MAX = 20;
/** The message body limit (chat's 20 000, with room to spare). */
const MAX_MARKDOWN = 19_000;
const TITLE_MAX = 100;
const DETAIL_MAX = 80;
const SUMMARY_MAX = 600;

/** Section headings in the order the digest lists them (UI-SPEC). */
export const SECTION_HEADINGS: Record<DigestSection, string> = {
  decisions: "Waiting for you",
  follows: "Cards you follow",
  mentions: "Unread mentions",
  work_zone: "Work Zone",
};

const SECTION_ORDER: readonly DigestSection[] = ["decisions", "follows", "mentions", "work_zone"];

export const DIGEST_FOOTER = "Change what's included in [Settings › Digest](/settings/digest).";
export const NOTHING_NEW = "Nothing new since your last digest.";

/**
 * One line of untrusted text as inert Markdown: whitespace (newlines included) collapsed, cut to `max` characters, and
 * every character that could start Markdown or HTML escaped with a backslash.
 */
export function escapeMarkdown(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const cut = flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
  return cut.replace(/[\\`*_{}[\]()<>#!|~&]/g, "\\$&");
}

/** A same-origin relative path: `/` then anything but a second slash or a backslash (never `//host`, never a scheme). */
export function isRelativeHref(href: string): boolean {
  return /^\/(?![/\\])[^\s()<>\\]*$/.test(href);
}

const dateIn = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(at);

const timeIn = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);

function line(item: DigestItem, timeZone: string): string {
  if (!isRelativeHref(item.href)) throw new Error("digest links must be same-origin relative paths");
  const title = escapeMarkdown(item.title, TITLE_MAX) || "Untitled";
  const detail = item.detail ? ` · ${escapeMarkdown(item.detail, DETAIL_MAX)}` : "";
  return `- [${title}](${item.href})${detail} · ${timeIn(item.at, timeZone)}`;
}

function render(
  p: { date: Date; timeZone: string; sections: readonly DigestSection[]; summary?: string },
  items: DigestItems,
  perSection: number,
): { markdown: string; empty: boolean } {
  const parts: string[] = [`### Your digest · ${dateIn(p.date, p.timeZone)}`];
  const summary = p.summary ? escapeMarkdown(p.summary, SUMMARY_MAX) : "";
  if (summary) parts.push(summary);
  let empty = true;
  for (const section of SECTION_ORDER) {
    if (!p.sections.includes(section)) continue;
    const list = items[section] ?? [];
    if (list.length === 0) continue;
    empty = false;
    const shown = list.slice(0, perSection);
    const lines = shown.map((item) => line(item, p.timeZone));
    if (list.length > shown.length) lines.push(`- …and ${list.length - shown.length} more`);
    parts.push(`**${SECTION_HEADINGS[section]} (${list.length})**\n${lines.join("\n")}`);
  }
  if (empty) parts.push(NOTHING_NEW);
  parts.push(DIGEST_FOOTER);
  return { markdown: parts.join("\n\n"), empty };
}

/**
 * The digest's Markdown: `### Your digest · Mon, Oct 12`, the optional summary as one plain paragraph, then each chosen
 * section that has items (`**Waiting for you (2)**` and its lines, newest first), and the footer link to the settings.
 * A section without items is left out; with none at all the message says there is nothing new and `empty` is true.
 */
export function composeDigest(p: {
  date: Date;
  timeZone: string;
  sections: readonly DigestSection[];
  items: DigestItems;
  summary?: string;
}): { markdown: string; empty: boolean } {
  let out = render(p, p.items, DIGEST_SECTION_MAX);
  // Long titles everywhere: fewer lines per section, never a message chat would refuse.
  for (const perSection of [10, 5, 2]) {
    if (out.markdown.length <= MAX_MARKDOWN) break;
    out = render(p, p.items, perSection);
  }
  if (out.markdown.length > AUTOMATION_LIMITS.mailTextMaxChars) throw new Error("digest too long");
  return out;
}
