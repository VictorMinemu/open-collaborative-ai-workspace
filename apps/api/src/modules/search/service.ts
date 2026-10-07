import {
  type AiChatSummary,
  type ConversationRef,
  type MessageAuthor,
  ModelRef,
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
import { ownerAuthor, sharedSql } from "../ai-chat";
import { aiAccessSql } from "../chat";
import { authorOf, type Directory } from "../chat/directory";

/**
 * Search over stock PostgreSQL (D-04, ADR-0016). Every function receives the caller's readable conversation ids
 * from the resolver (`access.readableIds`, P-03); SQL narrows to them and never decides visibility on its own.
 * RLS still scopes every statement to the tenant.
 */

const EMPTY_DIR: Directory = { users: new Map(), agents: new Map(), byHandle: new Map() };

/** Bound as ONE parameter (a uuid[] literal of resolver-produced ids), never spliced into the SQL text. */
const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(",")}}`}::uuid[]`;

/**
 * `ts_headline` options; the markers come from the contract (private-use code points, never typed in source).
 * Short messages are shown whole (fragment mode would drop words around the match); long ones as one fragment.
 */
const MARKERS = `StartSel=${SNIPPET_MARK_START},StopSel=${SNIPPET_MARK_END}`;
const HEADLINE_WHOLE = `HighlightAll=true,${MARKERS}`;
const HEADLINE_FRAGMENT = `MaxFragments=1,MaxWords=18,MinWords=6,${MARKERS}`;
const WHOLE_BODY_MAX = 200;
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

const markCount = (s: string | null) => (s ? s.split(SNIPPET_MARK_START).length - 1 : 0);

/**
 * The headline with the most marked matches: a stemmed match ("deployed" for "deploy") is only marked under its
 * own configuration. Ties keep the first (simple, then Spanish, then English).
 */
function pickSnippet(candidates: Array<string | null>): string {
  let best = candidates.find((c) => !!c) ?? "";
  for (const c of candidates) if (c && markCount(c) > markCount(best)) best = c;
  if (best.length <= SNIPPET_MAX) return best;
  let cut = best.slice(0, SNIPPET_MAX - 1);
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

/** Display label of a model (the model gateway's `labelOf`): the author of an AI chat answer (05-10). */
export type ModelLabelOf = (ref: ModelRef) => string;

/** The label an AI chat answer is shown under when its generation is unknown. */
const ASSISTANT_LABEL = "Assistant";

/**
 * Authors of AI chat answers (P-13: `agent` rows without an author id): the model of each answer's latest
 * generation, else "Assistant" — never "System".
 */
async function aiAnswerAuthors(
  tx: Tx,
  messageIds: readonly string[],
  labelOf: ModelLabelOf | undefined,
): Promise<Map<string, MessageAuthor>> {
  const out = new Map<string, MessageAuthor>();
  if (messageIds.length === 0) return out;
  const rows = (
    await tx.execute(sql`
      select distinct on (assistant_message_id) assistant_message_id, backend, provider, model_id
      from app.ai_generations where assistant_message_id = any(${uuidArray(messageIds)})
      order by assistant_message_id, attempt desc, started_at desc`)
  ).rows as Array<{ assistant_message_id: string; backend: string; provider: string; model_id: string }>;
  const byMessage = new Map(rows.map((r) => [r.assistant_message_id, r]));
  for (const id of messageIds) {
    const g = byMessage.get(id);
    const ref = g
      ? ModelRef.safeParse({ backend: g.backend, provider: g.provider, modelId: g.model_id })
      : null;
    const displayName = ref?.success && labelOf ? labelOf(ref.data) : ASSISTANT_LABEL;
    out.set(id, { kind: "agent", id: null, displayName, avatarUrl: null });
  }
  return out;
}

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
  /** Labels the model that wrote an AI chat answer (05-10). */
  labelOf?: ModelLabelOf;
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
           ts_headline('app.ocw_simple', h.body, q.q, o.opts) as s_simple,
           ts_headline('app.ocw_es', h.body, q.q, o.opts) as s_es,
           ts_headline('app.ocw_en', h.body, q.q, o.opts) as s_en
    from hits h, q,
         lateral (select case when char_length(h.body) <= ${WHOLE_BODY_MAX}
                              then ${HEADLINE_WHOLE}::text else ${HEADLINE_FRAGMENT}::text end as opts) o
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
  const answers = await aiAnswerAuthors(
    tx,
    page
      .filter(
        (r) =>
          r.author_kind === "agent" &&
          r.author_id === null &&
          refs.get(r.conversation_id)?.kind === "ai_chat",
      )
      .map((r) => r.id),
    input.labelOf,
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
      author: answers.get(r.id) ?? authorOf(input.dir, r.author_kind, r.author_id),
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

// ---------------------------------------------------------------- people and channels (pg_trgm)

/** `q` lowercased with LIKE wildcards escaped (the pattern is still a bound parameter, unaccented in SQL). */
const likeEscaped = (q: string) =>
  q
    .trim()
    .toLowerCase()
    .replace(/[\\%_]/g, (c) => `\\${c}`);

/** Fuzzy thresholds: whole-string trigram similarity, and best-matching word span (`word_similarity`). */
const SIMILARITY = 0.3;
const WORD_SIMILARITY = 0.5;

/** A people-search candidate before the resolver's per-row decision (agents carry their bot facts). */
export interface PersonCandidate extends SearchPerson {
  scope?: "team" | "personal";
  ownerUserId?: string | null;
  status?: string;
}

/**
 * Active members and live bots matching `q`: word prefix on the unaccented name (or the e-mail local part /
 * bot username), else trigram similarity. Bots are candidates only when they are team bots or the caller's own
 * personal bots (D-01); `visible` (the resolver: member.read, bot.read) decides each row before the limit.
 */
export async function searchPeople(
  tx: Tx,
  input: {
    viewerId: string;
    q: string;
    limit: number;
    dir: Directory;
    visible?: (candidates: PersonCandidate[]) => Promise<PersonCandidate[]>;
  },
): Promise<SearchPerson[]> {
  const like = likeEscaped(input.q);
  if (!like) return [];
  const res = await tx.execute(sql`
    with p as (select app.unaccent(lower(${input.q.trim()})) as q, app.unaccent(${like}) as l),
    cand as (
      select 'user' as kind, m.user_id as id, m.display_name as name, m.avatar_url,
             m.status_emoji, m.status_text, m.email, null::text as description,
             null::text as scope, null::uuid as owner_user_id, null::text as status,
             app.unaccent(lower(m.display_name)) as norm,
             lower(split_part(coalesce(m.email, ''), '@', 1)) as alt
      from app.org_members m
      where m.deactivated_at is null
      union all
      select 'agent', a.id, a.name, a.avatar_url, null, null, null, a.description, a.scope, a.owner_user_id, a.status,
             app.unaccent(lower(a.name)), lower(a.username)
      from app.agents a
      where a.deleted_at is null and (a.scope = 'team' or a.owner_user_id = ${input.viewerId}::uuid)
    ),
    scored as (
      select cand.*,
             (cand.norm like p.l || '%' escape '\\' or cand.norm like '% ' || p.l || '%' escape '\\'
               or cand.alt like p.l || '%' escape '\\') as prefix,
             greatest(app.similarity(cand.norm, p.q), app.word_similarity(p.q, cand.norm),
                      app.similarity(cand.alt, p.q)) as score
      from cand, p
    )
    select * from scored
    where prefix or score >= ${SIMILARITY}
    order by prefix desc, score desc, name, id
    limit ${input.limit * 3}`);
  const rows = res.rows as Array<{
    kind: "user" | "agent";
    id: string;
    name: string;
    avatar_url: string | null;
    status_emoji: string | null;
    status_text: string | null;
    email: string | null;
    description: string | null;
    scope: "team" | "personal" | null;
    owner_user_id: string | null;
    status: string | null;
  }>;
  const candidates: PersonCandidate[] = rows.map((r) => {
    const entry = r.kind === "agent" ? input.dir.agents.get(r.id) : input.dir.users.get(r.id);
    const status = [r.status_emoji, r.status_text].filter(Boolean).join(" ");
    return {
      kind: r.kind,
      id: r.id,
      displayName: r.name,
      handle: entry?.handle ?? r.name.toLowerCase(),
      avatarUrl: r.avatar_url,
      subtitle:
        r.kind === "agent"
          ? (r.description ?? (r.scope === "personal" ? "Your personal bot" : null))
          : status || r.email,
      ...(r.kind === "agent"
        ? { scope: r.scope ?? "team", ownerUserId: r.owner_user_id, status: r.status ?? undefined }
        : {}),
    };
  });
  const visible = input.visible ? await input.visible(candidates) : candidates;
  return visible.slice(0, input.limit).map(({ kind, id, displayName, handle, avatarUrl, subtitle }) => ({
    kind,
    id,
    displayName,
    handle,
    avatarUrl,
    subtitle,
  }));
}

/**
 * Readable channels (archived included, flagged) whose unaccented name or topic contains `q`, or whose name is
 * trigram-similar to it ("enginering" → #engineering). Live channels first, then name prefix, then similarity.
 */
export async function searchChannels(
  tx: Tx,
  input: { readableIds: string[]; viewerId: string; q: string; limit: number },
): Promise<SearchChannel[]> {
  const like = likeEscaped(input.q);
  if (!like || input.readableIds.length === 0) return [];
  const res = await tx.execute(sql`
    with p as (select app.unaccent(lower(${input.q.trim()})) as q, app.unaccent(${like}) as l),
    scored as (
      select c.id, c.name, c.topic, c.visibility, c.archived_at,
             app.unaccent(lower(coalesce(c.name, ''))) as norm,
             app.unaccent(lower(coalesce(c.topic, ''))) as topic_norm
      from app.conversations c
      where c.kind = 'channel' and c.id = any(${uuidArray(input.readableIds)})
    )
    select s.id, s.name, s.topic, s.visibility, s.archived_at,
           exists (select 1 from app.conversation_members cm
                   where cm.conversation_id = s.id and cm.member_kind = 'user' and cm.member_id = ${input.viewerId}::uuid) as is_member,
           (select count(*) from app.conversation_members cm where cm.conversation_id = s.id)::int as member_count,
           (s.norm like p.l || '%' escape '\\') as prefix,
           greatest(app.similarity(s.norm, p.q), app.word_similarity(p.q, s.norm)) as score
    from scored s, p
    where s.norm like '%' || p.l || '%' escape '\\'
       or s.topic_norm like '%' || p.l || '%' escape '\\'
       or app.similarity(s.norm, p.q) >= ${SIMILARITY}
       or app.word_similarity(p.q, s.norm) >= ${WORD_SIMILARITY}
    order by (s.archived_at is not null), prefix desc, score desc, s.name, s.id
    limit ${input.limit}`);
  return (
    res.rows as Array<{
      id: string;
      name: string | null;
      topic: string | null;
      visibility: "public" | "private";
      archived_at: unknown;
      is_member: boolean;
      member_count: number | string;
    }>
  ).map((r) => ({
    id: r.id,
    name: r.name ?? "",
    topic: r.topic,
    visibility: r.visibility,
    isMember: r.is_member,
    archived: r.archived_at !== null,
    memberCount: Number(r.member_count),
  }));
}

// ---------------------------------------------------------------- AI chats (05-10)

/**
 * The AI chats the caller can read whose title matches `q` (05-10, AICHAT-04; 06-04, P-03): exactly the ids of the
 * readable set (the resolver: the owner and active grantees, person, unit or organization; admins included in the
 * hidden rule), never a wider SQL decision. Each summary carries the viewer's access, the owner and `shared`, as in
 * the AI chat list. Same matching as channels (contains, else trigram); live chats first, then title prefix,
 * similarity and recent activity.
 */
export async function searchAiChats(
  tx: Tx,
  input: {
    readableIds: string[];
    viewerId: string;
    q: string;
    limit: number;
    labelOf?: ModelLabelOf;
    /** Owner names (the overview's directory); a missing owner reads "Former member". */
    dir?: Directory;
  },
): Promise<AiChatSummary[]> {
  const like = likeEscaped(input.q);
  if (!like || input.readableIds.length === 0) return [];
  const res = await tx.execute(sql`
    with p as (select app.unaccent(lower(${input.q.trim()})) as q, app.unaccent(${like}) as l),
    scored as (
      select c.id, c.name, c.archived_at, a.title_source, a.last_model, a.created_at, a.last_activity_at,
             a.owner_user_id, ${aiAccessSql(sql`${input.viewerId}::uuid`, sql`c.id`)} as access,
             ${sharedSql(sql`c.id`)} as shared,
             app.unaccent(lower(coalesce(c.name, ''))) as norm
      from app.conversations c join app.ai_chats a on a.conversation_id = c.id
      where c.kind = 'ai_chat' and c.id = any(${uuidArray(input.readableIds)})
    )
    select s.id, s.name, s.archived_at, s.title_source, s.last_model, s.created_at, s.last_activity_at,
           s.owner_user_id, s.access, s.shared,
           exists (select 1 from app.ai_generations g where g.conversation_id = s.id and g.status = 'running') as generating,
           (s.norm like p.l || '%' escape '\\') as prefix,
           greatest(app.similarity(s.norm, p.q), app.word_similarity(p.q, s.norm)) as score
    from scored s, p
    where s.norm like '%' || p.l || '%' escape '\\'
       or app.similarity(s.norm, p.q) >= ${SIMILARITY}
       or app.word_similarity(p.q, s.norm) >= ${WORD_SIMILARITY}
    order by (s.archived_at is not null), prefix desc, score desc, s.last_activity_at desc, s.id
    limit ${input.limit}`);
  return (
    res.rows as Array<{
      id: string;
      name: string | null;
      archived_at: unknown;
      title_source: AiChatSummary["titleSource"];
      last_model: unknown;
      created_at: unknown;
      last_activity_at: unknown;
      generating: boolean;
      owner_user_id: string;
      access: AiChatSummary["access"] | null;
      shared: boolean;
    }>
  ).map((r) => {
    const parsed = ModelRef.safeParse(r.last_model);
    const lastModel = parsed.success ? parsed.data : null;
    return {
      // Rows are readable, so the access is set; "view" is only the type's floor.
      access: r.access ?? "view",
      owner: ownerAuthor(input.dir ?? EMPTY_DIR, r.owner_user_id),
      shared: r.shared === true,
      id: r.id,
      title: r.name ?? "New chat",
      titleSource: r.title_source,
      lastModel,
      lastModelLabel: lastModel && input.labelOf ? input.labelOf(lastModel) : null,
      archived: r.archived_at !== null,
      generating: r.generating,
      createdAt: iso(r.created_at),
      lastActivityAt: iso(r.last_activity_at),
    };
  });
}
