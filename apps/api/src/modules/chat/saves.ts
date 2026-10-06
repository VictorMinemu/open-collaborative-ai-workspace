import {
  type ConversationRef,
  CursorQuery,
  EventTypes,
  IdParams,
  Ok,
  SavedList,
  type SaveUpdatedEvent,
} from "@ocw/contracts";
import { conversationMembers, conversations, messageSaves, messages, type Tx } from "@ocw/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { markDecided } from "../../authz";
import { type App, authOf, tenant } from "../../core";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { type Directory, loadDirectory } from "./directory";
import type { ChatRouteCtx } from "./index";
import { hydrateViewer, iso, replyParticipantsFor, toMessage } from "./service";

/**
 * Personal saves (CHAT-13): a private bookmark per (member, message). Only the member's own `user:<id>` stream
 * hears `save.updated` (P-04); pages hydrate `saved` per viewer. The Saved list is decided at read time by the one
 * readable-set authority (P-03): a message from a conversation the member can no longer read is not listed, and
 * comes back if access returns. Not audited: a private bookmark is not a sensitive action.
 */

const NOT_FOUND = "Message not found";

/** The ids among `messageIds` that `viewerId` saved (page hydration). */
export async function savedFor(tx: Tx, messageIds: string[], viewerId: string): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  const rows = await tx
    .select({ id: messageSaves.messageId })
    .from(messageSaves)
    .where(and(eq(messageSaves.userId, viewerId), inArray(messageSaves.messageId, messageIds)));
  return new Set(rows.map((r) => r.id));
}

/** Opaque keyset cursor over (saved at with microseconds, message id), newest first. */
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

/** "#name" for channels; the other participants' names for direct conversations ("Ada, Sam and Claude"). */
export async function conversationRefs(
  tx: Tx,
  ids: string[],
  me: string,
  dir: Directory,
): Promise<Map<string, ConversationRef>> {
  const out = new Map<string, ConversationRef>();
  if (ids.length === 0) return out;
  const convs = await tx.select().from(conversations).where(inArray(conversations.id, ids));
  const direct = convs.filter((c) => c.kind !== "channel").map((c) => c.id);
  const members =
    direct.length === 0
      ? []
      : await tx
          .select({
            conversationId: conversationMembers.conversationId,
            kind: conversationMembers.memberKind,
            id: conversationMembers.memberId,
          })
          .from(conversationMembers)
          .where(inArray(conversationMembers.conversationId, direct))
          .orderBy(conversationMembers.joinedAt);
  for (const c of convs) {
    let label = `#${c.name ?? "channel"}`;
    if (c.kind !== "channel") {
      const names = members
        .filter((m) => m.conversationId === c.id && !(m.kind === "user" && m.id === me))
        .map(
          (m) => (m.kind === "agent" ? dir.agents.get(m.id) : dir.users.get(m.id))?.displayName ?? "Someone",
        );
      label =
        names.length <= 1
          ? (names[0] ?? c.name ?? "Direct message")
          : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    }
    out.set(c.id, {
      id: c.id,
      kind: c.kind,
      name: c.name,
      label,
      visibility: c.visibility,
      archived: c.archivedAt !== null,
    });
  }
  return out;
}

export function registerSaveRoutes(app: App, ctx: ChatRouteCtx): void {
  const { core, deps, access } = ctx;
  const tags = ["chat"];

  /** The message once the caller may read its conversation (hidden = missing = 404). */
  async function readableMessage(req: FastifyRequest, tx: Tx, id: string) {
    const [row] = await tx.select().from(messages).where(eq(messages.id, id)).limit(1);
    if (!row) throw notFound(NOT_FOUND);
    await access.readable(req, tx, row.conversationId, { notFoundMessage: NOT_FOUND });
    return row;
  }

  async function emit(tx: Tx, me: string, messageId: string, saved: boolean) {
    const ev: SaveUpdatedEvent = { messageId, saved };
    await deps.realtime.appendEvent(tx, `user:${me}`, EventTypes.saveUpdated, ev);
  }

  app.put(
    "/messages/:id/save",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, params: IdParams, response: { 200: Ok } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const me = authOf(req).userId;
        const message = await readableMessage(req, tx, req.params.id);
        if (message.deletedAt) throw conflict("This message was deleted", "message_deleted");
        const inserted = await tx
          .insert(messageSaves)
          .values({ organizationId: message.organizationId, userId: me, messageId: message.id })
          .onConflictDoNothing()
          .returning({ id: messageSaves.messageId });
        if (inserted.length > 0) await emit(tx, me, message.id, true);
        return { ok: true as const };
      }),
  );

  app.delete(
    "/messages/:id/save",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, params: IdParams, response: { 200: Ok } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const me = authOf(req).userId;
        const message = await readableMessage(req, tx, req.params.id);
        const removed = await tx
          .delete(messageSaves)
          .where(and(eq(messageSaves.userId, me), eq(messageSaves.messageId, message.id)))
          .returning({ id: messageSaves.messageId });
        if (removed.length > 0) await emit(tx, me, message.id, false);
        return { ok: true as const };
      }),
  );

  app.get(
    "/saved",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, querystring: CursorQuery, response: { 200: SavedList } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const me = authOf(req).userId;
        const after = req.query.cursor ? decodeCursor(req.query.cursor) : null;
        // P-03: the resolver decides every readable conversation; SQL only narrows the member's own saves to them.
        const readable = await access.readableIds(tx, me, { includeArchived: true });
        markDecided(req);
        if (readable.length === 0) return { items: [], nextCursor: null };
        const rows = await tx
          .select({
            m: messages,
            savedAt: messageSaves.createdAt,
            // Full precision for the cursor (a JS Date would drop the microseconds and skip rows).
            savedAtKey: sql<string>`to_char(${messageSaves.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          })
          .from(messageSaves)
          .innerJoin(messages, eq(messages.id, messageSaves.messageId))
          .where(
            and(
              eq(messageSaves.userId, me),
              isNull(messages.deletedAt),
              inArray(messages.conversationId, readable),
              after
                ? sql`(${messageSaves.createdAt}, ${messageSaves.messageId}) < (${after.t}::timestamptz, ${after.id}::uuid)`
                : undefined,
            ),
          )
          .orderBy(desc(messageSaves.createdAt), desc(messageSaves.messageId))
          .limit(req.query.limit + 1);
        const page = rows.slice(0, req.query.limit);
        const last = page.at(-1);
        const dir = await loadDirectory(tx);
        const refs = await conversationRefs(tx, [...new Set(page.map((r) => r.m.conversationId))], me, dir);
        const roots = page.filter((r) => !r.m.threadId && r.m.replyCount > 0).map((r) => r.m.id);
        const participants = await replyParticipantsFor(tx, roots, dir);
        const dtos = await hydrateViewer(
          tx,
          page.map((r) => toMessage(r.m, dir, r.m.threadId ? undefined : (participants.get(r.m.id) ?? []))),
          me,
        );
        const items = page.flatMap((r, i) => {
          const conversation = refs.get(r.m.conversationId);
          const message = dtos[i];
          return conversation && message ? [{ message, conversation, savedAt: iso(r.savedAt) }] : [];
        });
        return {
          items,
          nextCursor:
            rows.length > req.query.limit && last
              ? encodeCursor({ t: last.savedAtKey, id: last.m.id })
              : null,
        };
      }),
  );
}
