import {
  type MemorySearchHit,
  type MemorySearchResult,
  SNIPPET_MARK_END,
  SNIPPET_MARK_START,
} from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import { sql } from "drizzle-orm";
import type { Core } from "../../core";
import { type MemoryActor, withPersonalOwner } from "./access";
import type { MemoryService } from "./index";

/**
 * Memory full-text search (MEM-02, MEM-07, D-03, D-08): the chat search's three unaccented configurations over
 * `memory_files.search_tsv` (path words weight A + content), restricted to the files the viewer may read.
 *
 * Visibility is decided only by the memory service: the scopes come from `listScopes` (or the one `scopeId`), and the
 * files from `listReadableFiles` (the resolver on the scope, then per path, so folder rules apply). SQL narrows to
 * those ids, bound as ONE uuid[] parameter, and never decides visibility on its own. RLS still scopes every statement to
 * the tenant and to the viewer's own private memory. Query text and content are never logged.
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

/** The ids of the files the viewer may read, with their scope, decided by the memory service only. */
async function readableFileIds(
  tx: Tx,
  memory: MemoryService,
  viewerUserId: string,
  scopeId: string | undefined,
): Promise<string[]> {
  const actor: MemoryActor = { kind: "user", userId: viewerUserId };
  const scopeIds = scopeId ? [scopeId] : (await memory.listScopes(tx, viewerUserId)).map((s) => s.id);
  const ids: string[] = [];
  // An unreadable or unknown `scopeId` throws memory_not_found (404) here, before any search runs.
  for (const id of scopeIds) for (const f of await memory.listReadableFiles(tx, actor, id)) ids.push(f.id);
  return ids;
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
    const ids = await readableFileIds(tx, deps.memory, viewerUserId, scopeId);
    if (ids.length === 0) return { hits: [] };
    const res = await tx.execute(sql`
      with q as (select ${tsQuery(q)} as q),
      hits as (
        select f.id, f.scope_id, f.path, f.updated_at, ts_rank(f.search_tsv, q.q) as rank,
               replace(replace(f.content, ${SNIPPET_MARK_START}, ''), ${SNIPPET_MARK_END}, '') as body
        from app.memory_files f, q
        where f.id = any(${uuidArray(ids)})
          and f.deleted_at is null
          and f.search_tsv @@ q.q
        order by rank desc, f.updated_at desc, f.id
        limit ${MEMORY_SEARCH_LIMIT}
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
