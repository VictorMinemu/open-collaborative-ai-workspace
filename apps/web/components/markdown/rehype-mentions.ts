import { MENTION_TOKEN_RE } from "@ocw/contracts";

/** The slice of a hast tree this plugin reads and writes (no dependency on @types/hast). */
export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Mentions are never chipped inside code, preformatted text or an existing link. */
const SKIP = new Set(["code", "pre", "a"]);

function splitMentions(text: string): HastNode[] {
  const out: HastNode[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(MENTION_TOKEN_RE.source, "g"))) {
    const handle = (m[2] ?? "").replace(/[._-]+$/, "");
    if (!handle) continue;
    const start = (m.index ?? 0) + (m[1]?.length ?? 0);
    const end = start + 1 + handle.length;
    if (start > last) out.push({ type: "text", value: text.slice(last, start) });
    out.push({
      type: "element",
      tagName: "span",
      properties: { dataMention: handle.toLowerCase() },
      children: [{ type: "text", value: `@${handle}` }],
    });
    last = end;
  }
  if (last === 0) return [{ type: "text", value: text }];
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}

function walk(node: HastNode): void {
  if (!node.children) return;
  if (node.type === "element" && node.tagName && SKIP.has(node.tagName)) return;
  const next: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value?.includes("@")) next.push(...splitMentions(child.value));
    else {
      walk(child);
      next.push(child);
    }
  }
  node.children = next;
}

/** rehype plugin: `@handle` in text → `<span data-mention="handle">`; skips code, pre and a. */
export function rehypeMentions() {
  return (tree: HastNode) => walk(tree);
}
