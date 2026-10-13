import {
  type MemorySearchHit,
  type MemorySearchResult,
  SNIPPET_MARK_END,
  SNIPPET_MARK_START,
} from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import { sql } from "drizzle-orm";
import type { Core } from "../../core";
import { withPersonalOwner } from "./access";
import type { MemoryService } from "./index";

/**
 * Memory full-text search (MEM-02, MEM-07, D-03, D-08): the chat search's three unaccented configurations over
 * `memory_files.search_tsv` (path words weight A + content), restricted to the files the viewer may read.
 *
 * Visibility is decided only by the memory service: `readableFileIds` lists the existing scopes the viewer may read (or
 * the one `scopeId`) and their live files' ids and paths, never content, then the resolver per path in one pass (folder
 * rules apply). Nothing is written: search never creates a scope (WINDOWS 139, 141). SQL narrows to those ids, bound as
 * ONE uuid[] parameter, and never decides visibility on its own. RLS still scopes every statement to the tenant and to
 * the viewer's own private memory. Query text and content are never logged.
 *
 * Bounded work (WINDOWS 142): ranking uses the stored index over the whole file, but only the 50 hits are read, and the
 * snippet is cut from the first `HEADLINE_INPUT_CHARS` characters of each (`ts_headline` parses its whole input, three
 * times). A file whose only match lies past that window is still found and ranked; its snippet is then its opening
 * words, unmarked.
 */

/** At most this many hits, best first. */
export const MEMORY_SEARCH_LIMIT = 50;

/** Bound as ONE parameter (a uuid[] literal of resolver-produced ids), never spliced into the SQL text. */
const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(",")}}`}::uuid[]`;

/** Same `ts_headline` options as the chat search: short files whole, long ones as one fragment. */
const MARKERS = `StartSel=${SNIPPET_MARK_START},StopSel=${SNIPPET_MARK_END}`;
const HEADLINE_WHOLE = `HighlightAll=true,${MARKERS}`;
const HEADLINE_FRAGMENT = `MaxFragments=1,MaxWords=18,MinWords=6,${MARKERS}`;
const WHOLE_BODY_MAX = 200;
const SNIPPET_MAX = 400;
/** At most this many characters of a hit go through `ts_headline` (x3 configurations, x50 hits). */
export const HEADLINE_INPUT_CHARS = 16 * 1024;

/** OR of the three unaccented configurations: exact tokens and path words (simple), Spanish and English stems. */
const tsQuery = (q: string) =>
  sql`(websearch_to_tsquery('app.ocw_simple', ${q}) || websearch_to_tsquery('app.ocw_es', ${q}) || websearch_to_tsquery('app.ocw_en', ${q}))`;

const markCount = (s: string | null) => (s ? s.split(SNIPPET_MARK_START).length - 1 : 0);

/** The headline with the most marks (a stem is only marked under its own configuration), at most 400 characters. */
function pickSnippet(candidates: Array<string | null>): string {
  let best = candidates.find((c) => !!c) ?? "";
  for (const c of candidates) if (c && markCount(c) > markCount(best)) best = c;
  if (best.length <= SNIPPET_MAX) return best;
  let cut = best.slice(0, SNIPPET_MAX - 1);
  // Never split a surrogate pair; an unbalanced marker is dropped by splitSnippet.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * Memory files matching `q` that `viewerUserId` may read, best first (`ts_rank`, then the most recently updated), at
 * most 50, each with a plain-text snippet carrying the contract markers.
 */
export async function searchMemory(
  tx: Tx,
  deps: { core: Core; memory: MemoryService },
  viewerUserId: string,
  q: string,
  scopeId?: string,
): Promise<MemorySearchResult> {
  // The viewer's own lens: their private memory and nobody else's (a no-op for a request already read as them).
  return withPersonalOwner(tx, viewerUserId, async () => {
    // An unreadable or unknown `scopeId` throws memory_not_found (404) here, before any search runs.
    const ids = await deps.memory.readableFileIds(tx, viewerUserId, scopeId);
    if (ids.length === 0) return { hits: [] };
    // The ranked ids first (the index only, no content); then the 50 hits' bodies, cut to the headline window.
    const res = await tx.execute(sql`
      with q as (select ${tsQuery(q)} as q),
      ranked as (
        select f.id, f.updated_at, ts_rank(f.search_tsv, q.q) as rank
        from app.memory_files f, q
        where f.id = any(${uuidArray(ids)})
          and f.deleted_at is null
          and f.search_tsv @@ q.q
        order by rank desc, f.updated_at desc, f.id
        limit ${MEMORY_SEARCH_LIMIT}
      ),
      hits as (
        select r.id, r.rank, r.updated_at, f.scope_id, f.path,
               replace(replace(left(f.content, ${HEADLINE_INPUT_CHARS}), ${SNIPPET_MARK_START}, ''),
                       ${SNIPPET_MARK_END}, '') as body
        from ranked r join app.memory_files f on f.id = r.id
      )
      select h.id, h.scope_id, h.path,
             ts_headline('app.ocw_simple', h.body, q.q, o.opts) as s_simple,
             ts_headline('app.ocw_es', h.body, q.q, o.opts) as s_es,
             ts_headline('app.ocw_en', h.body, q.q, o.opts) as s_en
      from hits h, q,
           lateral (select case when char_length(h.body) <= ${WHOLE_BODY_MAX}
                                then ${HEADLINE_WHOLE}::text else ${HEADLINE_FRAGMENT}::text end as opts) o
      order by h.rank desc, h.updated_at desc, h.id`);
    const rows = res.rows as Array<{
      id: string;
      scope_id: string;
      path: string;
      s_simple: string | null;
      s_es: string | null;
      s_en: string | null;
    }>;
    const hits: MemorySearchHit[] = rows.map((r) => ({
      fileId: r.id,
      scopeId: r.scope_id,
      path: r.path,
      snippet: pickSnippet([r.s_simple, r.s_es, r.s_en]),
    }));
    return { hits };
  });
}
