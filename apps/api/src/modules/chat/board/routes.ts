import {
  BoardCard,
  BoardColumnCards,
  BoardColumnPageQuery,
  BoardSnapshot,
  CreateBoardCardRequest,
  Id,
  mentionAllOf,
  UpdateBoardCardRequest,
} from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import { z } from "zod";
import { type App, authOf, tenant } from "../../../core";
import { type Directory, loadDirectory } from "../directory";
import type { ChatRouteCtx } from "../index";
import { dtoOf } from "../message-actions";
import type { ConversationRow, PostResult } from "../service";
import { readableBoard, writableBoard } from "./access";
import { registerColumnRoutes } from "./columns";
import { createBoardCard, readBoardSnapshot, readColumnPage, updateBoardCard } from "./service";

/**
 * The side effects of a fresh human post (observers, DM / group / mention / reply-mode dispatch), extracted from the
 * message route so a card created by a person notifies and wakes bots exactly like a message (07.1-03).
 */
export type AfterHumanPost = (
  tx: Tx,
  conv: ConversationRow,
  dir: Directory,
  result: PostResult,
  author: { id: string; clientTimeZone?: string },
  mentionAll: ReturnType<typeof mentionAllOf>,
) => Promise<void>;

export type BoardRouteCtx = ChatRouteCtx & { afterHumanPost: AfterHumanPost };

const BoardParams = z.object({ conversationId: Id });
const BoardColumnParams = z.object({ conversationId: Id, columnId: Id });
const BoardCardParams = z.object({ conversationId: Id, messageId: Id });

/** Everything of a card request that ends up in its message body, for the `@channel` / `@here` decision. */
const broadcastText = (r: { title?: string; description?: string; fields?: Record<string, unknown> }) =>
  [
    r.title ?? "",
    r.description ?? "",
    ...Object.values(r.fields ?? {}).map((v) => (typeof v === "string" ? v : "")),
  ]
    .filter(Boolean)
    .join("\n");

/**
 * Board routes under `/api/v1` (BOARD-01 … BOARD-06): the snapshot, a column page, card creation, card updates
 * (move, waiting state; text by the card's author) and column management (`columns.ts`). Every route resolves its board through `access.ts` (reads `readableBoard`, writes
 * `writableBoard`), so hidden and missing boards are the same 404 and another organization's ids do not exist (RLS).
 */
export function registerBoardRoutes(app: App, ctx: BoardRouteCtx): void {
  const { core, deps } = ctx;
  const tags = ["chat"];
  const user = { config: { authz: "user" as const }, preHandler: core.identity.requireUser };

  // Column management (07.1-06): `channel.update` on the board's channel.
  registerColumnRoutes(app, ctx);

  app.get(
    "/boards/:conversationId",
    { ...user, schema: { tags, params: BoardParams, response: { 200: BoardSnapshot } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const { conv } = await readableBoard(req, tx, ctx, req.params.conversationId);
        return readBoardSnapshot(tx, deps, conv.id);
      }),
  );

  app.get(
    "/boards/:conversationId/columns/:columnId/cards",
    {
      ...user,
      schema: {
        tags,
        params: BoardColumnParams,
        querystring: BoardColumnPageQuery,
        response: { 200: BoardColumnCards },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const { board } = await readableBoard(req, tx, ctx, req.params.conversationId);
        return readColumnPage(tx, board, req.params.columnId, req.query.after);
      }),
  );

  app.post(
    "/boards/:conversationId/cards",
    {
      ...user,
      schema: { tags, params: BoardParams, body: CreateBoardCardRequest, response: { 200: BoardCard } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const { conv } = await writableBoard(req, tx, ctx, req.params.conversationId, {
          body: broadcastText(req.body),
          clientMessageId: req.body.clientMessageId,
          columnId: req.body.columnId,
        });
        const { card, created, result } = await createBoardCard(tx, deps, {
          conv,
          author: { kind: "user", id: auth.userId },
          input: req.body,
          clientKind: auth.clientKind,
          sessionId: auth.sessionId,
        });
        if (created) {
          const dir = await loadDirectory(tx);
          await ctx.afterHumanPost(tx, conv, dir, result, { id: auth.userId }, mentionAllOf(result.row.body));
        }
        return card;
      }),
  );

  app.patch(
    "/boards/:conversationId/cards/:messageId",
    {
      ...user,
      schema: { tags, params: BoardCardParams, body: UpdateBoardCardRequest, response: { 200: BoardCard } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const { conv } = await writableBoard(req, tx, ctx, req.params.conversationId);
        return updateBoardCard(tx, deps, {
          conv,
          messageId: req.params.messageId,
          actor: { kind: "user", id: auth.userId },
          input: req.body,
          sessionId: auth.sessionId,
          // Text edits notify like the generic message edit: only people newly mentioned, never a bot (Pitfall 8).
          onTextEdited: async (etx, edit) =>
            core.chatEvents.messageEdited(etx, {
              conv: { id: conv.id, kind: "channel", organizationId: conv.organizationId },
              message: await dtoOf(etx, edit.row, edit.dir),
              editorId: auth.userId,
              previousMentions: edit.previousMentions,
            }),
        });
      }),
  );
}
