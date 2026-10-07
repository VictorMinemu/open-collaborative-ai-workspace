import {
  type AgentCard,
  type AgentCardAction,
  type AgentCardInput,
  type AgentCardPatch,
  EventTypes,
  type Message,
} from "@ocw/contracts";
import { conversations, messageCardFollows, messageCards, messages, type Tx } from "@ocw/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { App } from "../../core";
import { conflict, forbidden, gone, notFound } from "../../lib/errors";
import { channelResource, type PermissionService } from "../organization";
import { authorOf, type Directory, loadDirectory } from "./directory";
import type { ChatRouteCtx } from "./index";
import { resolveMentions } from "./mentions";
import {
  type ChatDeps,
  channelFacts,
  convTopic,
  iso,
  type MessageRow,
  replyParticipantsFor,
  toMessage,
  withAttachments,
} from "./service";

/**
 * Agent Cards in chat (AGENT-04, D-07, P-11). A card lives in `app.message_cards`, keyed by its message; the message body
 * is the card's plain-text summary, so search and notifications keep working and no card JSON is ever indexed. Chat
 * owns the rows: the agent's post inserts the card in the message transaction (`insertCard`), the posting agent's
 * updates go through `patchCard` (optimistic version, `message.updated` in place), and every REST snapshot adds the
 * card with the viewer's fields through `withCards`. Realtime payloads carry `cardOf` (no viewer fields, P-04).
 */

export type CardRow = typeof messageCards.$inferSelect;

/** Kinds a card may live in: wherever an agent may post (P-10). */
const CARD_KINDS = ["channel", "dm", "group", "ai_chat"] as const;

/**
 * The resolver used for the viewer's `decide` capability in snapshots. Set when the chat module registers its routes
 * (every app does, before serving); unset = nobody is offered `decide` (fail closed).
 */
let decider: Pick<PermissionService, "decide"> | null = null;

function cardFromRow(row: CardRow, dir: Directory | null): AgentCard {
  const decision: AgentCard["decision"] =
    row.decision && row.decidedAt
      ? {
          outcome: row.decision,
          by: {
            kind: "user",
            id: row.decidedBy,
            displayName:
              row.decidedBy && dir ? authorOf(dir, "user", row.decidedBy).displayName : "Former member",
          },
          at: iso(row.decidedAt),
        }
      : null;
  return {
    kind: row.kind,
    title: row.title,
    fields: row.fields,
    status: row.status,
    actions: row.actions as AgentCardAction[],
    version: row.version,
    decision,
    updatedAt: iso(row.updatedAt),
  };
}

/** The card of a message as every reader sees it (no viewer fields), or null when the message has none. */
export async function cardOf(tx: Tx, messageId: string): Promise<AgentCard | null> {
  const [row] = await tx.select().from(messageCards).where(eq(messageCards.messageId, messageId)).limit(1);
  if (!row) return null;
  return cardFromRow(row, row.decidedBy ? await loadDirectory(tx) : null);
}

/**
 * Why `userId` may not decide this card, or null when the card itself allows it (the caller still needs `channel.read`
 * and `agent_card.approve`). Checked in this order: an approve action, the named approvers, a decision already taken.
 */
export function decisionBlock(
  row: Pick<CardRow, "actions" | "decision">,
  userId: string,
): "card_not_decidable" | "not_card_approver" | "card_already_decided" | null {
  const approve = (row.actions as AgentCardAction[]).find(
    (a): a is Extract<AgentCardAction, { kind: "approve" }> => a.kind === "approve",
  );
  if (!approve) return "card_not_decidable";
  if (approve.approverIds && !approve.approverIds.includes(userId)) return "not_card_approver";
  if (row.decision) return "card_already_decided";
  return null;
}

/**
 * Adds `card` to every live message that has one (P-05: tombstones carry none) with the viewer's fields: `following`
 * and `viewerCan` (`follow` for any reader, which the list's caller already is; `decide` when the card allows it and
 * the resolver grants `agent_card.approve` in that conversation). One query for the cards, one for the follows.
 */
export async function withCards(tx: Tx, list: Message[], viewerId: string | null): Promise<Message[]> {
  const live = list.filter((m) => !m.deletedAt).map((m) => m.id);
  if (live.length === 0) return list;
  const rows = await tx.select().from(messageCards).where(inArray(messageCards.messageId, live));
  if (rows.length === 0) return list;
  const ids = rows.map((r) => r.messageId);
  const following = viewerId
    ? new Set(
        (
          await tx
            .select({ id: messageCardFollows.messageId })
            .from(messageCardFollows)
            .where(and(eq(messageCardFollows.userId, viewerId), inArray(messageCardFollows.messageId, ids)))
        ).map((r) => r.id),
      )
    : new Set<string>();
  const dir = rows.some((r) => r.decidedBy) ? await loadDirectory(tx) : null;
  const approves = new Map<string, boolean>();
  const mayApprove = async (conversationId: string): Promise<boolean> => {
    if (!viewerId || !decider) return false;
    const known = approves.get(conversationId);
    if (known !== undefined) return known;
    const [conv] = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    const allowed = conv
      ? (
          await decider.decide(
            tx,
            { kind: "user", userId: viewerId },
            "agent_card.approve",
            channelResource(await channelFacts(tx, conv, { kind: "user", id: viewerId })),
          )
        ).allowed
      : false;
    approves.set(conversationId, allowed);
    return allowed;
  };
  const cards = new Map<string, AgentCard>();
  for (const row of rows) {
    const viewerCan: Array<"follow" | "decide"> = viewerId ? ["follow"] : [];
    if (viewerId && decisionBlock(row, viewerId) === null && (await mayApprove(row.conversationId))) {
      viewerCan.push("decide");
    }
    cards.set(row.messageId, {
      ...cardFromRow(row, dir),
      following: following.has(row.messageId),
      viewerCan,
    });
  }
  return list.map((m) => {
    const card = m.deletedAt ? undefined : cards.get(m.id);
    return card ? { ...m, card } : m;
  });
}

/** Inserts the card of an agent's new message (version 1), in the message transaction. */
export async function insertCard(
  tx: Tx,
  a: { message: MessageRow; agentId: string; input: AgentCardInput },
): Promise<AgentCard> {
  const [row] = await tx
    .insert(messageCards)
    .values({
      messageId: a.message.id,
      organizationId: a.message.organizationId,
      conversationId: a.message.conversationId,
      agentId: a.agentId,
      kind: a.input.kind,
      title: a.input.title,
      fields: a.input.fields,
      status: a.input.status,
      actions: a.input.actions,
    })
    .returning();
  if (!row) throw new Error("card insert returned no row");
  return cardFromRow(row, null);
}

/**
 * The DTO of a card message as realtime events carry it: thread roots with their reply participants, the message's
 * attachments and the card without viewer fields.
 */
export async function cardMessageOf(tx: Tx, row: MessageRow, dir: Directory): Promise<Message> {
  const participants = row.threadId
    ? undefined
    : row.replyCount === 0
      ? []
      : ((await replyParticipantsFor(tx, [row.id], dir)).get(row.id) ?? []);
  const [dto] = await withAttachments(tx, [toMessage(row, dir, participants)]);
  if (!dto) throw new Error("message DTO missing");
  const card = await cardOf(tx, row.id);
  return card ? { ...dto, card } : dto;
}

/**
 * The posting agent's update of its card (P-11): the card row is locked; only `agentId` (its author, still enabled)
 * may change it, naming the version it saw (`card_version_conflict` otherwise). A new summary replaces the message body
 * (and its mentions) and marks it edited. Every reader gets `message.updated` with the card in place.
 */
export async function patchCard(
  tx: Tx,
  deps: ChatDeps,
  a: { messageId: string; agentId: string; patch: AgentCardPatch },
): Promise<{ before: CardRow; after: CardRow; message: Message }> {
  const [before] = await tx
    .select()
    .from(messageCards)
    .where(eq(messageCards.messageId, a.messageId))
    .limit(1)
    .for("update");
  if (!before) throw notFound("Card not found", "card_not_found");
  if (before.agentId !== a.agentId) {
    throw forbidden("Only the agent that posted this card can update it", "not_card_author");
  }
  const dir = await loadDirectory(tx);
  const agent = dir.agents.get(a.agentId);
  if (!agent || agent.deleted || agent.status === "disabled") {
    throw forbidden("This bot is disabled", "agent_disabled");
  }
  const [message] = await tx.select().from(messages).where(eq(messages.id, a.messageId)).limit(1);
  if (!message || message.deletedAt) throw conflict("This message was deleted", "message_deleted");
  const [conv] = await tx
    .select({ archivedAt: conversations.archivedAt })
    .from(conversations)
    .where(and(eq(conversations.id, message.conversationId), inArray(conversations.kind, [...CARD_KINDS])))
    .limit(1);
  if (!conv) throw notFound("Card not found", "card_not_found");
  if (conv.archivedAt) throw gone("This conversation is archived", "channel_archived");

  const { patch } = a;
  const [after] = await tx
    .update(messageCards)
    .set({
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.fields !== undefined ? { fields: patch.fields } : {}),
      version: sql`${messageCards.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(messageCards.messageId, a.messageId), eq(messageCards.version, patch.expectedVersion)))
    .returning();
  if (!after) {
    throw conflict(
      `The card is at version ${before.version}, not ${patch.expectedVersion}`,
      "card_version_conflict",
    );
  }
  let row = message;
  if (patch.summary !== undefined && patch.summary !== message.body) {
    const [updated] = await tx
      .update(messages)
      .set({ body: patch.summary, mentions: resolveMentions(patch.summary, dir), editedAt: sql`now()` })
      .where(eq(messages.id, message.id))
      .returning();
    if (!updated) throw new Error("message update returned no row");
    row = updated;
  }
  const dto = await cardMessageOf(tx, row, dir);
  await deps.realtime.appendEvent(tx, convTopic(row.conversationId), EventTypes.messageUpdated, {
    message: dto,
  });
  return { before, after, message: dto };
}

/** Human card routes under `/api/v1` (follow, decision); also wires the resolver behind `withCards`. */
export function registerCardActionRoutes(_app: App, ctx: ChatRouteCtx): void {
  decider = ctx.perms;
}
