import {
  type ConversationRef,
  type SearchChannel,
  type SearchMessageHit,
  type SearchMessagesResult,
  type SearchPerson,
  SNIPPET_MARK_END,
  SNIPPET_MARK_START,
} from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { badRequest } from "../../lib/errors";
import { authorOf, type Directory } from "../chat/directory";

/**
 * Search over stock PostgreSQL (D-04, ADR-0016). Every function receives the caller's readable conversation ids
 * from the resolver (`access.readableIds`, P-03); SQL narrows to them and never decides visibility on its own.
 * RLS still scopes every statement to the tenant.
 */

/** Bound as ONE parameter (a uuid[] literal of resolver-produced ids), never spliced into the SQL text. */
const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(",")}}`}::uuid[]`;

/** `ts_headline` options; the markers come from the contract (private-use code points, never typed in source). */
const HEADLINE_OPTIONS = `MaxFragments=1,MaxWords=18,MinWords=6,StartSel=${SNIPPET_MARK_START},StopSel=${SNIPPET_MARK_END}`;
const SNIPPET_MAX = 400;

/** OR of the three unaccented configurations: exact tokens and code (simple), Spanish and English stems. */
const tsQuery = (q: string) =>
  sql`(websearch_to_tsquery('app.ocw_simple', ${q}) || websearch_to_tsquery('app.ocw_es', ${q}) || websearch_to_tsquery('app.ocw_en', ${q}))`;

// ---------------------------------------------------------------- cursor

const CursorPayload = z.object({ t: z.string().min(1).max(64), i: z.uuid() });
type CursorPayload = z.infer<typeof CursorPayload>;

const encodeCursor = (c: CursorPayload) => Buffer.from(JSON.stringify(c), "utf8").toString("base64url");

function decodeCursor(raw: string): CursorPayload {
  try {
    const parsed = CursorPayload.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (Number.isNaN(Date.parse(parsed.t))) throw new Error("bad time");
    return parsed;
  } catch {
    throw badRequest("Invalid cursor", "invalid_cursor");
  }
}

// ---------------------------------------------------------------- helpers

/** Start of the UTC day of `date` (YYYY-MM-DD), plus `days`. */
function utcDay(date: string, days = 0): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/** Picks the first headline that marked a match (stemmed matches only mark under their own configuration). */
function pickSnippet(candidates: Array<string | null>): string {
  const marked = candidates.find((c) => c?.includes(SNIPPET_MARK_START));
  const s = marked ?? candidates.find((c) => !!c) ?? "";
  if (s.length <= SNIPPET_MAX) return s;
  let cut = s.slice(0, SNIPPET_MAX - 1);
  // Never split a surrogate pair; an unbalanced marker is dropped by splitSnippet.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

const iso = (v: unknown) => new Date(v as string).toISOString();

/**
 * `ConversationRef`s for the given conversations as `viewerId` sees them: "#name" for channels, the other
 * members' names for DMs and group DMs (a group's own name wins). Archived ones are flagged.
 */
export async function conversationRefs(
  tx: Tx,
  conversationIds: readonly string[],
  viewerId: string,
  dir: Directory,
): Promise<Map<string, ConversationRef>> {
  const out = new Map<string, ConversationRef>();
  const unique = [...new Set(conversationIds)];
  if (unique.length === 0) return out;
  const convs = (
    await tx.execute(sql`
      select id, kind, name, visibility, archived_at from app.conversations where id = any(${uuidArray(unique)})`)
  ).rows as Array<{
    id: string;
    kind: ConversationRef["kind"];
    name: string | null;
    visibility: ConversationRef["visibility"];
    archived_at: unknown;
  }>;
  const direct = convs.filter((c) => c.kind !== "channel").map((c) => c.id);
  const members = new Map<string, Array<{ kind: "user" | "agent"; id: string }>>();
  if (direct.length > 0) {
    const rows = (
      await tx.execute(sql`
        select conversation_id, member_kind, member_id from app.conversation_members
        where conversation_id = any(${uuidArray(direct)}) order by created_at, member_id`)
    ).rows as Array<{ conversation_id: string; member_kind: "user" | "agent"; member_id: string }>;
    for (const r of rows) {
      const list = members.get(r.conversation_id) ?? [];
      list.push({ kind: r.member_kind, id: r.member_id });
      members.set(r.conversation_id, list);
    }
  }
  for (const c of convs) {
    let label: string;
    if (c.kind === "channel") label = `#${c.name ?? ""}`;
    else if (c.name) label = c.name;
    else {
      const all = members.get(c.id) ?? [];
      const others = all.filter((m) => !(m.kind === "user" && m.id === viewerId));
      const names = (others.length > 0 ? others : all).map((m) => authorOf(dir, m.kind, m.id).displayName);
      label =
        names.length <= 1
          ? (names[0] ?? "Direct message")
          : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    }
    out.set(c.id, {
      id: c.id,
      kind: c.kind,
      name: c.name,
      label,
      visibility: c.visibility,
      archived: c.archived_at !== null,
    });
  }
  return out;
}

// ---------------------------------------------------------------- messages

export interface SearchMessagesInput {
  /** Resolver-filtered conversation ids (P-03). */
  readableIds: string[];
  /** Labels DMs from this user's point of view. */
  viewerId: string;
  q: string;
  in?: string;
  from?: string;
  /** YYYY-MM-DD, inclusive (UTC day bounds). */
  after?: string;
  /** YYYY-MM-DD, inclusive (UTC day bounds). */
  before?: string;
  cursor?: string;
  limit: number;
  dir: Directory;
}

/**
 * Messages matching `q` in the readable conversations, newest first, keyset-paged on (created_at, id). Deleted
 * messages never match. An `in` outside the readable set answers an empty page (no existence oracle).
 */
export async function searchMessages(tx: Tx, input: SearchMessagesInput): Promise<SearchMessagesResult> {
  const empty: SearchMessagesResult = { hits: [], nextCursor: null };
  const readable = input.in ? input.readableIds.filter((id) => id === input.in) : input.readableIds;
  if (readable.length === 0) return empty;
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  const q = tsQuery(input.q);

  const res = await tx.execute(sql`
    with q as (select ${q} as q),
    hits as (
      select m.id, m.conversation_id, m.thread_id, m.seq, m.author_kind, m.author_id, m.created_at,
             m.created_at::text as cursor_at,
             replace(replace(m.body, ${SNIPPET_MARK_START}, ''), ${SNIPPET_MARK_END}, '') as body
      from app.messages m, q
      where m.search_tsv @@ q.q
        and m.conversation_id = any(${uuidArray(readable)})
        and m.deleted_at is null
        ${input.from ? sql`and m.author_id = ${input.from}::uuid` : sql``}
        ${input.after ? sql`and m.created_at >= ${utcDay(input.after)}::timestamptz` : sql``}
        ${input.before ? sql`and m.created_at < ${utcDay(input.before, 1)}::timestamptz` : sql``}
        ${cursor ? sql`and (m.created_at, m.id) < (${cursor.t}::timestamptz, ${cursor.i}::uuid)` : sql``}
      order by m.created_at desc, m.id desc
      limit ${input.limit + 1}
    )
    select h.id, h.conversation_id, h.thread_id, h.seq, h.author_kind, h.author_id, h.created_at, h.cursor_at,
           ts_headline('app.ocw_simple', h.body, q.q, ${HEADLINE_OPTIONS}) as s_simple,
           ts_headline('app.ocw_es', h.body, q.q, ${HEADLINE_OPTIONS}) as s_es,
           ts_headline('app.ocw_en', h.body, q.q, ${HEADLINE_OPTIONS}) as s_en
    from hits h, q
    order by h.created_at desc, h.id desc`);

  const rows = res.rows as Array<{
    id: string;
    conversation_id: string;
    thread_id: string | null;
    seq: number | string;
    author_kind: "user" | "agent" | "system";
    author_id: string | null;
    created_at: unknown;
    cursor_at: string;
    s_simple: string | null;
    s_es: string | null;
    s_en: string | null;
  }>;
  const page = rows.slice(0, input.limit);
  const refs = await conversationRefs(
    tx,
    page.map((r) => r.conversation_id),
    input.viewerId,
    input.dir,
  );
  const hits: SearchMessageHit[] = [];
  for (const r of page) {
    const conversation = refs.get(r.conversation_id);
    if (!conversation) continue;
    hits.push({
      messageId: r.id,
      conversation,
      threadRootId: r.thread_id,
      seq: Number(r.seq),
      author: authorOf(input.dir, r.author_kind, r.author_id),
      createdAt: iso(r.created_at),
      snippet: pickSnippet([r.s_simple, r.s_es, r.s_en]),
    });
  }
  const last = page[page.length - 1];
  return {
    hits,
    nextCursor: rows.length > input.limit && last ? encodeCursor({ t: last.cursor_at, i: last.id }) : null,
  };
}

// ---------------------------------------------------------------- people and channels (Task 2)

/** A people-search candidate before the resolver's per-row decision (agents carry their bot facts). */
export interface PersonCandidate extends SearchPerson {
  scope?: "team" | "personal";
  ownerUserId?: string | null;
  status?: string;
}

export async function searchPeople(
  _tx: Tx,
  _input: {
    viewerId: string;
    q: string;
    limit: number;
    dir: Directory;
    /** The resolver's per-row decision (member.read / bot.read), applied before the limit. */
    visible?: (candidates: PersonCandidate[]) => Promise<PersonCandidate[]>;
  },
): Promise<SearchPerson[]> {
  return [];
}

export async function searchChannels(
  _tx: Tx,
  _input: { readableIds: string[]; viewerId: string; q: string; limit: number },
): Promise<SearchChannel[]> {
  return [];
}
