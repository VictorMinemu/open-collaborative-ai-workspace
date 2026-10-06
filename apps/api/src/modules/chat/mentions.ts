import { extractMentionHandles, isReservedHandle, type Mention } from "@ocw/contracts";
import type { Directory } from "./directory";

/**
 * Server-authoritative mention resolution: `@handle` tokens in the body resolved against the org directory
 * (agents by username, humans by `userHandle`). Client-sent mention arrays are ignored, so a client cannot
 * trigger an agent the text does not address. Unknown handles are dropped, and reserved handles (`@channel`,
 * `@here`, `@everyone`) never resolve to a person or a bot (Pitfall 6): they are broadcasts, decided by chat.
 */
export function resolveMentions(body: string, dir: Directory): Mention[] {
  const out: Mention[] = [];
  const seen = new Set<string>();
  for (const handle of extractMentionHandles(body)) {
    if (isReservedHandle(handle)) continue;
    const e = dir.byHandle.get(handle);
    if (!e) continue;
    const key = `${e.kind}:${e.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: e.kind, id: e.id });
  }
  return out;
}
