import { SNIPPET_MAX } from "@ocw/contracts";

/**
 * The inbox snippet of a message body (CHAT-08, Pitfall 9: computed at read time, never stored): one line of plain
 * text with the Markdown markup dropped (emphasis, links, code marks, headings, quotes, list markers) and @mentions
 * kept, at most SNIPPET_MAX UTF-16 units, never splitting a code point.
 *
 * It runs on every inbox read, over bodies any member writes, so every rule is linear: the fence, link and strong
 * rules are scans (their regexes rescanned a run from every start position, quadratic on a hostile body), the rest
 * are regexes whose every attempt stops at the next delimiter.
 */
export function snippetOf(body: string): string {
  const plain = unwrapStrong(unwrapLinks(dropFenceLines(body)))
    .replace(/(^|[\s(])[*_](?=\S)([^*_\n]+?)(?<=\S)[*_](?=$|[\s).,!?:;])/gm, "$1$2")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/^[ \t]{0,3}(#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/gm, "");
  const line = plain.replace(/\s+/g, " ").trim();
  if (line.length <= SNIPPET_MAX) return line;
  let out = "";
  for (const ch of line) {
    if (out.length + ch.length > SNIPPET_MAX - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

const WHITESPACE = /\s/;
const isSpace = (ch: string | undefined) => ch !== undefined && WHITESPACE.test(ch);
/** What a multiline `^` matches after and a `.` never matches. */
const isLineTerminator = (ch: string | undefined) =>
  ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029";

/**
 * `find(from)` (the first index at or after `from` where something holds, or -1) remembered: while `from` does not
 * pass the last answer, the answer stands. Asked with a non-decreasing `from`, each stretch of text is scanned once.
 */
function forward(find: (from: number) => number): (from: number) => number {
  let asked = Number.POSITIVE_INFINITY;
  let hit = -1;
  return (from) => {
    if (from < asked || (hit !== -1 && from > hit)) hit = find(from);
    asked = from;
    return hit;
  };
}

const indexOf = (s: string, needle: string) => forward((from) => s.indexOf(needle, from));

/** The first of two forward searches' hits (-1 when neither finds one). */
const first = (a: number, b: number) => (a === -1 ? b : b === -1 ? a : Math.min(a, b));

/**
 * `/^\s*(```|~~~)[^\n]*$/gm` → " ": a line whose first non-blank is a code fence, with the blank lines before it.
 * `\s*` only matches up to the end of the whitespace run, which every line start inside the run shares, so the run is
 * read once instead of once per line start.
 */
export function dropFenceLines(s: string): string {
  const nextNewline = indexOf(s, "\n");
  let out = "";
  let pos = 0;
  let i = 0;
  while (i <= s.length) {
    if (i > 0 && !isLineTerminator(s[i - 1])) {
      i++;
      continue;
    }
    let j = i;
    while (isSpace(s[j])) j++;
    if (s.startsWith("```", j) || s.startsWith("~~~", j)) {
      const end = nextNewline(j);
      const t = end === -1 ? s.length : end;
      out += `${s.slice(pos, i)} `;
      pos = t;
      // A match never ends where it starts (the fence is three characters), so this always advances.
      i = t;
    } else {
      // No line start inside [i, j] can match: they all reach the same `j`.
      i = j + 1;
    }
  }
  return out + s.slice(pos);
}

/**
 * `/!?\[([^\]\n]*)\]\([^)\n]*\)/g` → "$1": a link or image keeps only its label. The label runs to the first `]` or
 * newline and the URL to the first `)` or newline, both read through remembered forward searches, so no stretch is
 * rescanned from each `[`.
 */
export function unwrapLinks(s: string): string {
  const nextOpen = indexOf(s, "[");
  const labelClose = indexOf(s, "]");
  const labelNewline = indexOf(s, "\n");
  const urlClose = indexOf(s, ")");
  const urlNewline = indexOf(s, "\n");
  let out = "";
  let pos = 0;
  let from = 0;
  for (let q = nextOpen(from); q !== -1; q = nextOpen(from)) {
    from = q + 1;
    const r = first(labelClose(q + 1), labelNewline(q + 1));
    if (r === -1 || s[r] !== "]" || s[r + 1] !== "(") continue;
    const t = first(urlClose(r + 2), urlNewline(r + 2));
    if (t === -1 || s[t] !== ")") continue;
    const start = q - 1 >= pos && s[q - 1] === "!" ? q - 1 : q;
    out += s.slice(pos, start) + s.slice(q + 1, r);
    pos = t + 1;
    from = t + 1;
  }
  return out + s.slice(pos);
}

/**
 * `/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g` → "$2": strong and strikethrough keep their text. The closer is the first
 * same delimiter after the opener that follows a non-blank and comes before the line ends; those are found by
 * remembered forward searches instead of rescanning the line from every opener.
 */
export function unwrapStrong(s: string): string {
  const closers = new Map(
    ["**", "__", "~~"].map((d) => {
      const find = (from: number) => {
        let e = s.indexOf(d, from);
        while (e !== -1 && isSpace(s[e - 1])) e = s.indexOf(d, e + 1);
        return e;
      };
      return [d, forward(find)] as const;
    }),
  );
  const lineEnd = forward((from) => {
    for (let i = from; i < s.length; i++) if (isLineTerminator(s[i])) return i;
    return -1;
  });
  let out = "";
  let pos = 0;
  let p = 0;
  while (p + 2 < s.length) {
    const closer = s[p] === s[p + 1] ? closers.get(s.slice(p, p + 2)) : undefined;
    if (closer && !isSpace(s[p + 2])) {
      const e = closer(p + 3);
      const eol = lineEnd(p + 2);
      if (e !== -1 && (eol === -1 || e <= eol)) {
        out += s.slice(pos, p) + s.slice(p + 2, e);
        pos = e + 2;
        p = e + 2;
        continue;
      }
    }
    p++;
  }
  return out + s.slice(pos);
}
