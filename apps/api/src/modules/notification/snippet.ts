import { SNIPPET_MAX } from "@ocw/contracts";

/**
 * The inbox snippet of a message body (CHAT-08, Pitfall 9: computed at read time, never stored): one line of plain
 * text with the Markdown markup dropped (emphasis, links, code marks, headings, quotes, list markers) and @mentions
 * kept, at most SNIPPET_MAX UTF-16 units, never splitting a code point.
 */
export function snippetOf(body: string): string {
  const plain = body
    .replace(/^\s*(```|~~~)[^\n]*$/gm, " ")
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2")
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
