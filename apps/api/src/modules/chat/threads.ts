import {
  CursorQuery,
  EventTypes,
  Id,
  Ok,
  ThreadList,
  type ThreadReadEvent,
  ThreadReadRequest,
  type ThreadSummary,
} from "@ocw/contracts";
import { messages, type Tx, threadReads } from "@ocw/db";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { markDecided } from "../../authz";
import { type App, authOf, tenant } from "../../core";
import { badRequest, notFound } from "../../lib/errors";
import { type Directory, loadDirectory } from "./directory";
import type { ChatRouteCtx } from "./index";
import { conversationRefs } from "./saves";
import { hydrateViewer, iso, replyParticipantsFor, toMessage } from "./service";

/**
 * The Threads view (CHAT-02): threads a member started, replied to or was mentioned in (root or reply), newest
 * reply first. Candidates come only from the resolver's readable set (P-03, T-04-08-03): a thread of a conversation
 * the member can no longer read is not listed. Unread replies are others' live replies after the member's
 * `thread_reads` mark (capped at 100). No realtime subscription of its own (Pitfall 13): `thread.read` travels on
 * the member's `user:` stream, `thread.updated` on the `conv:` streams the sidebar already watches.
 */

const NOT_FOUND = "Thread not found";
const UNREAD_CAP = 100;
const LAST_REPLIES = 3;

/** Opaque keyset cursor over (last reply at with microseconds, root id), newest first (T-04-08-05). */
const Cursor = z.object({
  t: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  id: z.uuid(),
});
const encodeCursor = (c: z.infer<typeof Cursor>) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decodeCursor(raw: string): z.infer<typeof Cursor> {
  try {
    return Cursor.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch {
    throw badRequest("Invalid cursor", "invalid_cursor");
  }
}

const RootParams = z.object({ rootId: Id });

export async function listThreadsFor(
  tx: Tx,
  input: { userId: string; readableIds: string[]; cursor?: string; limit: number; dir: Directory },
): Promise<ThreadList> {
  const { userId: me, readableIds, limit, dir } = input;
  const after = input.cursor ? decodeCursor(input.cursor) : null;
  if (readableIds.length === 0) return { threads: [], nextCursor: null };
  const mentionsMe = JSON.stringify([{ kind: "user", id: me }]);
  const rows = await tx
    .select({
      m: messages,
      lastReplyKey: sql<string>`to_char(${messages.lastReplyAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(messages)
    .where(
      and(
        isNull(messages.threadId),
        gt(messages.replyCount, 0),
        isNotNull(messages.lastReplyAt),
        inArray(messages.conversationId, readableIds),
        // Narrowing to the member's own threads; the readable set above decided visibility.
        sql`(
          (${messages.authorKind} = 'user' and ${messages.authorId} = ${me})
          or ${messages.mentions} @> ${mentionsMe}::jsonb
          or exists (
            select 1 from app.messages r
            where r.thread_id = ${messages.id}
              and r.deleted_at is null
              and ((r.author_kind = 'user' and r.author_id = ${me}) or r.mentions @> ${mentionsMe}::jsonb)
          )
        )`,
        after
          ? sql`(${messages.lastReplyAt}, ${messages.id}) < (${after.t}::timestamptz, ${after.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(messages.lastReplyAt), desc(messages.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const rootIds = page.map((r) => r.m.id);

  // The newest live replies of every listed thread in one query.
  const ranked = tx
    .select({
      id: messages.id,
      rn: sql<number>`row_number() over (partition by ${messages.threadId} order by ${messages.seq} desc)`.as(
        "rn",
      ),
    })
    .from(messages)
    .where(and(rootIds.length ? inArray(messages.threadId, rootIds) : sql`false`, isNull(messages.deletedAt)))
    .as("ranked");
  const replyRows =
    rootIds.length === 0
      ? []
      : (
          await tx
            .select({ m: messages })
            .from(messages)
            .innerJoin(ranked, eq(ranked.id, messages.id))
            .where(lte(ranked.rn, LAST_REPLIES))
            .orderBy(messages.seq)
        ).map((r) => r.m);

  // Others' live replies after the member's mark, per listed thread (capped like every unread count, P-07).
  const unreadRows =
    rootIds.length === 0
      ? []
      : await tx
          .select({
            rootId: messages.threadId,
            n: sql<number>`least(count(*), ${UNREAD_CAP})`.mapWith(Number),
          })
          .from(messages)
          .leftJoin(
            threadReads,
            and(eq(threadReads.rootMessageId, messages.threadId), eq(threadReads.userId, me)),
          )
          .where(
            and(
              inArray(messages.threadId, rootIds),
              isNull(messages.deletedAt),
              sql`not (${messages.authorKind} = 'user' and ${messages.authorId} = ${me})`,
              sql`${messages.seq} > coalesce(${threadReads.lastReadSeq}, 0)`,
            ),
          )
          .groupBy(messages.threadId);
  const unread = new Map(unreadRows.map((r) => [r.rootId, r.n]));

  const participants = await replyParticipantsFor(tx, rootIds, dir);
  const refs = await conversationRefs(tx, [...new Set(page.map((r) => r.m.conversationId))], me, dir);
  const roots = await hydrateViewer(
    tx,
    page.map((r) => toMessage(r.m, dir, participants.get(r.m.id) ?? [])),
    me,
  );
  const replies = await hydrateViewer(
    tx,
    replyRows.map((r) => toMessage(r, dir)),
    me,
  );
  const threads: ThreadSummary[] = page.flatMap((r, i) => {
    const conversation = refs.get(r.m.conversationId);
    const root = roots[i];
    if (!conversation || !root) return [];
    return [
      {
        root,
        conversation,
        replyCount: r.m.replyCount,
        lastReplyAt: r.m.lastReplyAt ? iso(r.m.lastReplyAt) : null,
        unreadReplies: Math.min(UNREAD_CAP, unread.get(r.m.id) ?? 0),
        participants: participants.get(r.m.id) ?? [],
        lastReplies: replies.filter((m) => m.threadId === r.m.id),
      },
    ];
  });
  return {
    threads,
    nextCursor: rows.length > limit && last ? encodeCursor({ t: last.lastReplyKey, id: last.m.id }) : null,
  };
}

export function registerThreadRoutes(app: App, ctx: ChatRouteCtx): void {
  const { core, deps, access } = ctx;
  const tags = ["chat"];

  app.get(
    "/threads",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, querystring: CursorQuery, response: { 200: ThreadList } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const me = authOf(req).userId;
        // P-03: the resolver decides every readable conversation; the query only narrows to the member's threads.
        const readableIds = await access.readableIds(tx, me);
        markDecided(req);
        return listThreadsFor(tx, {
          userId: me,
          readableIds,
          ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
          limit: req.query.limit,
          dir: await loadDirectory(tx),
        });
      }),
  );

  app.post(
    "/threads/:rootId/read",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, params: RootParams, body: ThreadReadRequest, response: { 200: Ok } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const me = authOf(req).userId;
        const [root] = await tx.select().from(messages).where(eq(messages.id, req.params.rootId)).limit(1);
        // Only a thread root has a read mark; hidden = missing = 404 (another org's root does not exist here).
        if (!root || root.threadId !== null) throw notFound(NOT_FOUND);
        await access.readable(req, tx, root.conversationId, { notFoundMessage: NOT_FOUND });
        const [mark] = await tx
          .insert(threadReads)
          .values({
            organizationId: root.organizationId,
            userId: me,
            rootMessageId: root.id,
            lastReadSeq: req.body.seq,
          })
          .onConflictDoUpdate({
            target: [threadReads.userId, threadReads.rootMessageId],
            set: {
              lastReadSeq: sql`greatest(${threadReads.lastReadSeq}, excluded.last_read_seq)`,
              updatedAt: sql`now()`,
            },
          })
          .returning({ lastReadSeq: threadReads.lastReadSeq });
        const ev: ThreadReadEvent = {
          rootId: root.id,
          lastReadSeq: Number(mark?.lastReadSeq ?? req.body.seq),
        };
        await deps.realtime.appendEvent(tx, `user:${me}`, EventTypes.threadRead, ev);
        return { ok: true as const };
      }),
  );
}
