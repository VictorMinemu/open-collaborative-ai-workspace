import { extractMentionHandles, type Mention } from "@ocw/contracts";
import type { Directory } from "./directory";

/**
 * Server-authoritative mention resolution: `@handle` tokens in the body resolved against the org directory
 * (agents by username, humans by `userHandle`). Client-sent mention arrays are ignored, so a client cannot
 * trigger an agent the text does not address. Unknown handles are dropped.
 */
export function resolveMentions(body: string, dir: Directory): Mention[] {
  const out: Mention[] = [];
  const seen = new Set<string>();
  for (const handle of extractMentionHandles(body)) {
    const e = dir.byHandle.get(handle);
    if (!e) continue;
    const key = `${e.kind}:${e.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: e.kind, id: e.id });
  }
  return out;
}
