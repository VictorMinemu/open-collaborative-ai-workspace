import {
  AgentCard,
  type AgentCardAction,
  AgentCardDecisionRequest,
  type AgentCardInput,
  AgentCardParams,
  type AgentCardPatch,
  EventTypes,
  type Message,
} from "@ocw/contracts";
import { conversations, messageCardFollows, messageCards, messages, type Tx, tenantOf } from "@ocw/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { markDecided } from "../../authz";
import { type App, authOf, type Core, tenant } from "../../core";
import type { CardAction, ChatAgentBridge, LinkedCardInfo } from "../../lib/chat-agent-bridge";
import { badRequest, conflict, forbidden, gone, notFound } from "../../lib/errors";
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
/**
 * The bridge whose `linkedCards()` knows which platform-owned cards mirror an approval (07.2-06). Set with `decider`;
 * unset or without a provider = no card is linked (no `approval`, never `decide`: fail closed).
 */
let bridge: Pick<ChatAgentBridge, "linkedCards"> | null = null;

/** The approval links of the platform-owned cards among `rows` (one query through the provider). */
async function linksOf(tx: Tx, rows: CardRow[]): Promise<Map<string, LinkedCardInfo>> {
  const owned = rows.filter((r) => r.platformOwned).map((r) => r.messageId);
  const linked = bridge?.linkedCards();
  if (owned.length === 0 || !linked) return new Map();
  return linked.linkOf(tx, owned);
}

/**
 * The card's approval link as the provider composed it: the 07.2 fields, plus the 07.5 extras (kind, expiry, use time
 * and the kind's own fields) only for kinds that have them. No viewer field, so realtime events may carry it.
 */
const approvalLink = (link: LinkedCardInfo | undefined): Pick<AgentCard, "approval"> =>
  link ? { approval: { ...link } } : {};

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
          // Absent without a note, so older snapshots keep their exact shape.
          ...(row.decisionNote ? { note: row.decisionNote } : {}),
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
    ...(row.platformOwned ? { platformOwned: true } : {}),
  };
}

/** The card of a message as every reader sees it (no viewer fields), or null when the message has none. */
export async function cardOf(tx: Tx, messageId: string): Promise<AgentCard | null> {
  const [row] = await tx.select().from(messageCards).where(eq(messageCards.messageId, messageId)).limit(1);
  if (!row) return null;
  const links = await linksOf(tx, [row]);
  return {
    ...cardFromRow(row, row.decidedBy ? await loadDirectory(tx) : null),
    ...approvalLink(links.get(row.messageId)),
  };
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
 * the resolver grants `agent_card.approve` in that conversation, never to a `view` grantee of an AI chat). One query
 * for the cards, one for the follows.
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
  // Linked cards (07.2-06): the approval's kind decides who may decide, live; `agent_card.approve` and the card's
  // approver list are not consulted. A platform-owned card without a link offers no decision.
  const links = await linksOf(tx, rows);
  const linked = bridge?.linkedCards();
  const linkedDeciders =
    viewerId && linked && links.size > 0
      ? await linked.canDecide(tx, [...links.keys()], viewerId)
      : new Set<string>();
  const cards = new Map<string, AgentCard>();
  for (const row of rows) {
    const viewerCan: Array<"follow" | "decide"> = viewerId ? ["follow"] : [];
    const link = links.get(row.messageId);
    if (row.platformOwned) {
      if (link && link.status === "pending" && !row.decision && linkedDeciders.has(row.messageId)) {
        viewerCan.push("decide");
      }
    } else if (viewerId && decisionBlock(row, viewerId) === null && (await mayApprove(row.conversationId))) {
      viewerCan.push("decide");
    }
    cards.set(row.messageId, {
      ...cardFromRow(row, dir),
      ...approvalLink(link),
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
  a: { message: MessageRow; agentId: string; input: AgentCardInput; platformOwned?: boolean },
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
      platformOwned: a.platformOwned === true,
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
  // Platform-owned cards (07.2-06, D-08) are composed by the server: no agent may rewrite their findings or readers.
  if (before.platformOwned) {
    throw forbidden("This card is composed by the platform; agents cannot update it", "card_platform_owned");
  }
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

/**
 * Re-announces a card message to its conversation (`message.updated`, same version): the approval module calls it once
 * it has linked a freshly posted mirror card to its request, so live readers get the card with its approval link
 * (07.2-13, WINDOWS 160; the `message.created` frame was built before the link existed). A deleted message is left out.
 */
export async function announceCardMessage(
  tx: Tx,
  deps: Pick<Core, "realtime">,
  messageId: string,
): Promise<void> {
  const [message] = await tx.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!message || message.deletedAt) return;
  const dto = await cardMessageOf(tx, message, await loadDirectory(tx));
  await deps.realtime.appendEvent(tx, convTopic(message.conversationId), EventTypes.messageUpdated, {
    message: dto,
  });
}

/**
 * Mirrors an approval's decision on its platform-owned card (07.2-06), in the decision transaction: status, decision,
 * decider and note, a version bump, `message.updated` to every reader, then the agent hears it as
 * `agent.card_action.v1` (with the quoted note). Once: a card that already shows a decision is left as it is. Called
 * by the approval module only; chat never decides an approval itself. The 07.5 turn fields (`turnUserId`,
 * `decidedBy`, `grant`, `tainted`) pass through to the card action unchanged (P-06).
 */
export async function mirrorCardDecision(
  tx: Tx,
  deps: Pick<Core, "realtime" | "chatAgent">,
  a: {
    messageId: string;
    outcome: "approved" | "denied";
    deciderUserId: string;
    /** `running`: an approved grant not used yet (WINDOWS 135); `mirrorCardUsed` turns it `succeeded` on use. */
    status: "running" | "succeeded" | "failed" | "cancelled";
    note?: string | null | undefined;
  } & Pick<CardAction, "turnUserId" | "decidedBy" | "grant" | "tainted" | "resultCode">,
): Promise<void> {
  const [after] = await tx
    .update(messageCards)
    .set({
      status: a.status,
      decision: a.outcome,
      decidedBy: a.deciderUserId,
      decidedAt: sql`now()`,
      decisionNote: a.note ?? null,
      version: sql`${messageCards.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(messageCards.messageId, a.messageId),
        eq(messageCards.platformOwned, true),
        isNull(messageCards.decision),
      ),
    )
    .returning();
  if (!after) return;
  const [message] = await tx.select().from(messages).where(eq(messages.id, a.messageId)).limit(1);
  if (message && !message.deletedAt) {
    const dto = await cardMessageOf(tx, message, await loadDirectory(tx));
    await deps.realtime.appendEvent(tx, convTopic(message.conversationId), EventTypes.messageUpdated, {
      message: dto,
    });
  }
  await deps.chatAgent.emitCardAction(
    tx,
    {
      messageId: a.messageId,
      outcome: a.outcome,
      actorUserId: a.deciderUserId,
      note: a.note ?? undefined,
      ...(a.turnUserId ? { turnUserId: a.turnUserId } : {}),
      ...(a.decidedBy ? { decidedBy: a.decidedBy } : {}),
      ...(a.grant ? { grant: a.grant } : {}),
      ...(a.tainted ? { tainted: true } : {}),
      ...(a.resultCode ? { resultCode: a.resultCode } : {}),
    },
    tenantOf(tx).afterCommit,
  );
}

/**
 * Marks the platform-owned card of an approved grant as used (WINDOWS 135): `running` → `succeeded`, a version bump
 * and `message.updated` to every reader (the link then shows `applied` and `usedAt`). No card action turn: using the
 * grant is the bot's own call, not a decision. Once: any other card state is left as it is. Called by the approval
 * module only, inside the transaction that consumed the grant (approval row locked first, then the card).
 */
export async function mirrorCardUsed(
  tx: Tx,
  deps: Pick<Core, "realtime">,
  a: { messageId: string },
): Promise<void> {
  const [after] = await tx
    .update(messageCards)
    .set({ status: "succeeded", version: sql`${messageCards.version} + 1`, updatedAt: sql`now()` })
    .where(
      and(
        eq(messageCards.messageId, a.messageId),
        eq(messageCards.platformOwned, true),
        eq(messageCards.status, "running"),
        eq(messageCards.decision, "approved"),
      ),
    )
    .returning({ messageId: messageCards.messageId });
  if (after) await announceCardMessage(tx, deps, a.messageId);
}

/**
 * Closes the platform-owned card of an approval that nobody decided (the approval's "gone" path, WINDOWS 144): its
 * status only (`failed`), a version bump and `message.updated` to every reader; no decision, no decider, and no card
 * action turn (nobody acted on it). Once: a card that is no longer pending, or shows a decision, is left as it is.
 * Called by the approval module only.
 */
export async function mirrorCardClosed(
  tx: Tx,
  deps: Pick<Core, "realtime">,
  a: { messageId: string; status: "failed" | "cancelled" },
): Promise<void> {
  const [after] = await tx
    .update(messageCards)
    .set({ status: a.status, version: sql`${messageCards.version} + 1`, updatedAt: sql`now()` })
    .where(
      and(
        eq(messageCards.messageId, a.messageId),
        eq(messageCards.platformOwned, true),
        eq(messageCards.status, "pending"),
        isNull(messageCards.decision),
      ),
    )
    .returning({ messageId: messageCards.messageId });
  if (after) await announceCardMessage(tx, deps, a.messageId);
}

const CARD_NOT_FOUND = "Card not found";

/**
 * Human card routes under `/api/v1` (P-11): follow / unfollow and the single decision. Every route reads the card's
 * conversation through the readable set first (hidden = missing = 404, also for a tombstoned message); nobody but the
 * posting agent ever edits a card. Also wires the resolver behind `withCards`.
 */
export function registerCardActionRoutes(app: App, ctx: ChatRouteCtx): void {
  const { core, deps, access, perms } = ctx;
  decider = perms;
  bridge = core.chatAgent;
  const tags = ["chat"];
  // `onRequest`, as every AI chat route: an anonymous caller gets 401 before the body is validated (06-16 sweep).
  const user = { config: { authz: "user" as const }, onRequest: core.identity.requireUser };

  /** The card, its message and the caller's facts on its conversation; 404 when missing or not readable. */
  async function readableCard(req: FastifyRequest, tx: Tx, messageId: string, lock = false) {
    const query = tx.select().from(messageCards).where(eq(messageCards.messageId, messageId)).limit(1);
    const [card] = lock ? await query.for("update") : await query;
    if (!card) throw notFound(CARD_NOT_FOUND);
    const { conv, facts } = await access.readable(req, tx, card.conversationId, {
      kinds: CARD_KINDS,
      notFoundMessage: CARD_NOT_FOUND,
    });
    const [message] = await tx.select().from(messages).where(eq(messages.id, card.messageId)).limit(1);
    if (!message || message.deletedAt) throw notFound(CARD_NOT_FOUND);
    return { card, conv, facts, message };
  }

  /**
   * One card as the caller sees it (06-15): realtime events carry cards without viewer fields (P-04), so a page that
   * got a card live reads `following` and `viewerCan` here. Same readable check as the other routes (hidden = 404).
   */
  app.get(
    "/cards/:messageId",
    { ...user, schema: { tags, params: AgentCardParams, response: { 200: AgentCard } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const { message } = await readableCard(req, tx, req.params.messageId);
        const dto = await cardMessageOf(tx, message, await loadDirectory(tx));
        const [shown] = await withCards(tx, [dto], authOf(req).userId);
        if (!shown?.card) throw notFound(CARD_NOT_FOUND);
        return shown.card;
      }),
  );

  app.post(
    "/cards/:messageId/follow",
    { ...user, schema: { tags, params: AgentCardParams } },
    async (req, reply) => {
      await core.db.withTenant(tenant(req), async (tx) => {
        const { card } = await readableCard(req, tx, req.params.messageId);
        await tx
          .insert(messageCardFollows)
          .values({
            organizationId: card.organizationId,
            messageId: card.messageId,
            userId: authOf(req).userId,
          })
          .onConflictDoNothing();
      });
      return reply.status(204).send();
    },
  );

  app.delete(
    "/cards/:messageId/follow",
    { ...user, schema: { tags, params: AgentCardParams } },
    async (req, reply) => {
      await core.db.withTenant(tenant(req), async (tx) => {
        const { card } = await readableCard(req, tx, req.params.messageId);
        await tx
          .delete(messageCardFollows)
          .where(
            and(
              eq(messageCardFollows.messageId, card.messageId),
              eq(messageCardFollows.userId, authOf(req).userId),
            ),
          );
      });
      return reply.status(204).send();
    },
  );

  /**
   * A platform-owned card's decision (07.2-06): the caller reads the conversation (404), names the hash it was shown
   * (400 `action_hash_required`) and the approval primitive decides with the kind's live rule (403 `not_approver`, 409
   * on a changed action, an expired or an already decided request), applies, audits and mirrors the card. A
   * platform-owned card that mirrors no approval has nothing to decide (409).
   */
  async function decideLinked(
    req: FastifyRequest<{ Params: { messageId: string }; Body: AgentCardDecisionRequest }>,
    tx: Tx,
  ) {
    const userId = authOf(req).userId;
    const { conv, message } = await readableCard(req, tx, req.params.messageId);
    if (conv.archivedAt) throw gone("This conversation is archived", "channel_archived");
    const linked = bridge?.linkedCards();
    const link = linked ? (await linked.linkOf(tx, [message.id])).get(message.id) : undefined;
    if (!linked || !link) throw conflict("This card has nothing to decide", "card_not_decidable");
    const { actionHash, outcome, note } = req.body;
    if (!actionHash) {
      throw badRequest("Deciding this card needs the action hash you were shown", "action_hash_required");
    }
    // 07.5-11 (WINDOWS #211, P-07): a card that does not show the exact action (a `summary` in a shared conversation, or
    // `review_only` when a value was cut for the card) is approved only on the review, where the decider sees all of
    // it. Deny stays possible here. Kinds without a display (07.2 memory) are unchanged.
    if (outcome === "approved" && link.display !== undefined && link.display !== "exact") {
      throw conflict("Review the full action before approving it", "review_required");
    }
    await linked.decide(tx, { messageId: message.id, deciderUserId: userId, outcome, actionHash, note });
    markDecided(req);
    const dto = await cardMessageOf(tx, message, await loadDirectory(tx));
    const [shown] = await withCards(tx, [dto], userId);
    if (!shown?.card) throw new Error("decided card missing");
    return shown.card;
  }

  /**
   * One decision per card, decided by the server (the client only says approved or denied): the caller reads the
   * conversation (404), holds `agent_card.approve` there (403, deny rules win; in an AI chat only the owner or a `chat`
   * grantee holds it, a `view` grantee is 403 `ai_chat_view_only`), the card has an approve action (409
   * `card_not_decidable`), names the caller when it names approvers (403 `not_card_approver`) and is not decided yet
   * (409 `card_already_decided`, also for a concurrent loser of the conditional update). Every reader gets
   * `message.updated`, the decision is audited (ids and outcome) and the agent receives `agent.card_action.v1`.
   */
  app.post(
    "/cards/:messageId/decision",
    {
      ...user,
      schema: { tags, params: AgentCardParams, body: AgentCardDecisionRequest, response: { 200: AgentCard } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx, after) => {
        const userId = authOf(req).userId;
        const { outcome } = req.body;
        const [kind] = await tx
          .select({ platformOwned: messageCards.platformOwned })
          .from(messageCards)
          .where(eq(messageCards.messageId, req.params.messageId))
          .limit(1);
        if (kind?.platformOwned) return decideLinked(req, tx);
        const { card, conv, facts, message } = await readableCard(req, tx, req.params.messageId, true);
        if (conv.archivedAt) throw gone("This conversation is archived", "channel_archived");
        await perms.assertCan(req, tx, "agent_card.approve", channelResource(facts));
        const block = decisionBlock(card, userId);
        if (block === "card_not_decidable") throw conflict("This card has nothing to decide", block);
        if (block === "not_card_approver")
          throw forbidden("Only the approvers named on this card can decide", block);
        if (block === "card_already_decided") throw conflict("This card was already decided", block);
        const note = req.body.note ?? null;
        const [decided] = await tx
          .update(messageCards)
          .set({
            decision: outcome,
            decidedBy: userId,
            decidedAt: sql`now()`,
            updatedAt: sql`now()`,
            ...(note ? { decisionNote: note } : {}),
          })
          .where(and(eq(messageCards.messageId, card.messageId), isNull(messageCards.decision)))
          .returning();
        if (!decided) throw conflict("This card was already decided", "card_already_decided");

        const dto = await cardMessageOf(tx, message, await loadDirectory(tx));
        await deps.realtime.appendEvent(tx, convTopic(message.conversationId), EventTypes.messageUpdated, {
          message: dto,
        });
        await core.audit.record(tx, {
          action: "agent_card.decided",
          resourceType: "message",
          resourceId: card.messageId,
          agentId: card.agentId,
          metadata: {
            messageId: card.messageId,
            conversationId: card.conversationId,
            agentId: card.agentId,
            outcome,
            // The note itself may quote the conversation: only its length is audited.
            ...(note ? { noteChars: note.length } : {}),
          },
        });
        // The agent hears about it through agent-channel (the bridge), in this transaction.
        await core.chatAgent.emitCardAction(
          tx,
          { messageId: card.messageId, outcome, actorUserId: userId, ...(note ? { note } : {}) },
          after,
        );
        const [shown] = await withCards(tx, [dto], userId);
        if (!shown?.card) throw new Error("decided card missing");
        return shown.card;
      }),
  );
}
