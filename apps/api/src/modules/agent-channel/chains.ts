import {
  AgentChannelEventTypes,
  AgentChannelTurnDone,
  type AgentConsultReplyEvent,
  type ConsultMode,
  cellTopic,
  Id,
  Ok,
} from "@ocw/contracts";
import {
  agentChainHops,
  agentChains,
  agents,
  agentTurns,
  conversations,
  messages,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, asc, eq, gte, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { App, Core } from "../../core";
import type { AgentMention } from "../../lib/chat-agent-bridge";
import { notFound } from "../../lib/errors";
import { announceConsults, convTopic, createConversationAccess, lockNextSeq } from "../chat";
import { memberDirectory } from "../organization";
import { type CellPrincipal, cellOf } from "./auth";
import { cellAuditBase } from "./claim";
import type { ConsultDeps } from "./consult";
import { buildMentionEvents } from "./mentions";

/**
 * The return half of a consult (Phase 07.7-06; A2A-01, A2A-03; D-01, D-04, D-06, D-07, D-09, D-13, D-15; ADR-0027).
 *
 * A consulted bot answers in the chain's thread like any delivered turn (PR #25's rule decides the post, no new trigger
 * code); its first post is recorded on its ledger row (`recordChainReply`, in the `/messages` and `/cards` hooks). When
 * the cell reports the turn done (`POST /turns/:eventId/done`), the hop the turn answers closes exactly once (a
 * conditional `pending →` update) and, for a `consult` hop of an active chain, the asking bot gets the answer back as a
 * new turn for the chain's human (`deliverConsultReply`, the 07.6 proactive-delivery pattern), re-typed
 * `agent.consult_reply.v1`. A turn that opened a consult of its own does not close its parent (Pitfall 6): its return
 * turn does. Audits carry ids only, never a question or an answer.
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];
const UNKNOWN_TURN = "No delivered turn of this bot has that id";

type HopRow = typeof agentChainHops.$inferSelect;
type TurnRow = typeof agentTurns.$inferSelect;

/** How a hop ended for its asker: the return turn's `consultReply.outcome`. */
export type ConsultOutcome = "answered" | "failed" | "timed_out";

/** Stored payload; `seq` is injected by the gateway when the frame is sent. */
export type StoredConsultReply = Omit<AgentConsultReplyEvent, "seq">;

/** The server sentence a return turn carries when the consulted bot left no answer (one line, the handle only). */
export function noAnswerSentence(handle: string, outcome: "failed" | "timed_out"): string {
  return outcome === "timed_out" ? `@${handle} did not answer in time.` : `@${handle} couldn't answer.`;
}

/**
 * Records the first message a chain turn posted (`agent_turns.reply_message_id`), in the post's transaction: the anchor
 * of the hop's answer when the turn answers one (D-15, P-09; `answerOf` joins the turn's later chunks at delivery). Turns outside any chain record nothing; later posts never overwrite.
 */
export async function recordChainReply(tx: Tx, p: { eventId: string; messageId: string }): Promise<void> {
  await tx
    .update(agentTurns)
    .set({ replyMessageId: p.messageId })
    .where(
      and(
        eq(agentTurns.eventId, p.eventId),
        isNull(agentTurns.replyMessageId),
        or(
          isNotNull(agentTurns.answeringHopId),
          isNotNull(agentTurns.returningHopId),
          isNotNull(agentTurns.chainId),
        ),
      ),
    );
}

type ChainRow = typeof agentChains.$inferSelect;

/**
 * Whether a chain may still act (P-15, T-07.7-09-04): its thread root is not deleted and its human still reads the
 * conversation (a thread is judged by its channel; the resolver decides `channel.read`). False → the caller cancels the
 * chain with reason `auto` (`cancelChain`): a request, a return and a tick touching an orphaned chain all stop it. Reads
 * only, in the caller's transaction (which runs as the chain's human).
 */
export async function chainLive(
  tx: Tx,
  core: Core,
  chain: Pick<ChainRow, "conversationId" | "threadRootId" | "humanUserId">,
): Promise<boolean> {
  const [root] = await tx
    .select({ deletedAt: messages.deletedAt })
    .from(messages)
    .where(eq(messages.id, chain.threadRootId))
    .limit(1);
  if (!root || root.deletedAt) return false;
  const [conv] = await tx
    .select({ id: conversations.id, kind: conversations.kind, parent: conversations.parentConversationId })
    .from(conversations)
    .where(eq(conversations.id, chain.conversationId))
    .limit(1);
  const judged = conv ? (conv.kind === "thread" ? conv.parent : conv.id) : null;
  if (!judged) return false;
  return createConversationAccess(core).isReadable(tx, chain.humanUserId, judged, { kinds: ["channel"] });
}

/** The longest answer a return turn carries (the chat's message bound). */
const ANSWER_MAX = 20_000;

/**
 * The answer of an answered hop (CR-A-03): every post of the turn that answered it, in thread order, joined into one
 * text, starting with the post recorded on that turn (`hop.answer_message_id`, the first, whatever its key: a message or
 * a card). Later posts belong to that turn when they are the same bot's, in the same conversation, after the first, and
 * keyed in the turn's own reply namespace (`evt:<eventId>:<n>`, the bridge's chunk and block keys; its failure notice,
 * `evt:<eventId>:failed`, never is): another turn of the same bot in the same thread never mixes in. Deleted posts are
 * skipped. Null when nothing is left (the answer was deleted).
 */
async function answerOf(tx: Tx, hop: HopRow): Promise<{ id: string; body: string; ids: string[] } | null> {
  if (!hop.answerMessageId) return null;
  const [first] = await tx
    .select({ id: messages.id, seq: messages.seq, conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.id, hop.answerMessageId))
    .limit(1);
  if (!first) return null;
  const [turn] = await tx
    .select({ eventId: agentTurns.eventId })
    .from(agentTurns)
    .where(and(eq(agentTurns.answeringHopId, hop.id), eq(agentTurns.replyMessageId, first.id)))
    .limit(1);
  const prefix = turn ? `evt:${turn.eventId}:` : null;
  const posts = await tx
    .select({
      id: messages.id,
      body: messages.body,
      key: messages.clientMessageId,
      deletedAt: messages.deletedAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, first.conversationId),
        eq(messages.authorKind, "agent"),
        eq(messages.authorId, hop.targetAgentId),
        gte(messages.seq, first.seq),
        prefix
          ? or(eq(messages.id, first.id), like(messages.clientMessageId, `${prefix}%`))
          : eq(messages.id, first.id),
      ),
    )
    .orderBy(asc(messages.seq))
    .limit(100);
  const chunk = (key: string | null) =>
    prefix !== null && /^\d{1,6}$/u.test((key ?? "").slice(prefix.length));
  const kept = posts.filter(
    (m) => !m.deletedAt && m.body.trim() !== "" && (m.id === first.id || chunk(m.key)),
  );
  const [head] = kept;
  if (!head) return null;
  return {
    id: head.id,
    body: kept
      .map((m) => m.body)
      .join("\n\n")
      .slice(0, ANSWER_MAX),
    ids: kept.map((m) => m.id),
  };
}

/**
 * Delivers a closed hop back to the bot that asked (D-01, D-07: the `deliverAutomationRun` / `emitCardAction`
 * pattern), in the closing transaction, which runs as the chain's human. The `AgentMention`'s structural author is that
 * human (tools, limits, metering and the ledger row are theirs; never the consulted bot's owner, ADR-0019), on the
 * answer (or, without one, on the question with a server sentence), `trigger: "consult"` (unattended, D-13), with the
 * asker's place in the chain (its own answering hop, if any, and the hop it receives). The return turn starts with the
 * taint and member data of every turn that answered the hop and of the turn that asked it (D-09, Pitfall 2, CR-A-01:
 * nothing is laundered through a hop, in either direction). The
 * event then names the consulted bot as `message.author` when it carries its answer, the chain's human in `origin`, and
 * is appended as `agent.consult_reply.v1`. Null when nothing is delivered: a handoff, a closed chain, a human who no
 * longer reads the conversation, a gone asker, or its daily limit (the existing notice then follows).
 */
export async function deliverConsultReply(
  tx: Tx,
  deps: ConsultDeps,
  hop: HopRow,
  outcome: ConsultOutcome,
): Promise<StoredConsultReply | null> {
  if (hop.mode !== "consult") return null;
  const { core } = deps;
  const { organizationId } = tenantOf(tx);
  const [chain] = await tx.select().from(agentChains).where(eq(agentChains.id, hop.chainId)).limit(1);
  if (chain?.status !== "active") return null;
  // The confused-deputy rule at delivery (the asker's reply re-checks it), and the lazy automatic cancel (P-15): a chain
  // whose thread root is gone or whose human no longer reads the channel stops here, and nothing is delivered.
  if (!(await chainLive(tx, core, chain))) {
    await cancelChain(tx, deps, chain.id, { byUserId: null, reason: "auto" });
    return null;
  }
  const directory = await memberDirectory(tx);
  const person = directory.get(chain.humanUserId);
  if (!person) return null;
  const [target] = await tx
    .select({ id: agents.id, name: agents.name, username: agents.username })
    .from(agents)
    .where(eq(agents.id, hop.targetAgentId))
    .limit(1);
  if (!target) return null;

  // CR-A-01: every turn that answered this hop (the question turn and its own return turns) AND the turn that asked it,
  // as it stands now. Consulting is asynchronous: the asking turn keeps running after its consult call and may read
  // outside content or member data, and the return turn resumes the same per-thread session, so it starts with all of it.
  const [carried] = await tx
    .select({
      tainted: sql<boolean>`coalesce(bool_or(${agentTurns.tainted}), false)`,
      memberData: sql<boolean>`coalesce(bool_or(${agentTurns.memberData}), false)`,
    })
    .from(agentTurns)
    .where(or(eq(agentTurns.answeringHopId, hop.id), eq(agentTurns.eventId, hop.sourceEventId)));
  const tainted = carried?.tainted === true;
  const memberData = carried?.memberData === true;

  // CR-A-04: only an answered hop carries an answer; a failed turn's post (the bridge's failure notice) never does.
  const posted = outcome === "answered" ? await answerOf(tx, hop) : null;
  const effective: ConsultOutcome = outcome === "answered" && !posted ? "failed" : outcome;
  const used = await tx
    .select({ id: agentChainHops.targetAgentId })
    .from(agentChainHops)
    .where(eq(agentChainHops.chainId, chain.id));
  const human = { kind: "user" as const, id: chain.humanUserId, displayName: person.displayName };
  const mention: AgentMention = {
    organizationId,
    conversationId: chain.conversationId,
    threadRootId: chain.threadRootId,
    messageId: posted ? posted.id : hop.questionMessageId,
    agentIds: [hop.sourceAgentId],
    author: human,
    body: posted
      ? posted.body
      : noAnswerSentence(target.username, effective === "timed_out" ? "timed_out" : "failed"),
    createdAt: new Date().toISOString(),
    delivery: "thread",
    trigger: "consult",
    chain: {
      chainId: chain.id,
      depth: (hop.depth - 1) as 0 | 1,
      answeringHopId: hop.parentHopId,
      returningHopId: hop.id,
      rootAgentId: chain.rootAgentId,
      usedTargetIds: used.map((u) => u.id),
    },
    taintedAtStart: tainted,
  };
  const events = await buildMentionEvents(tx, mention, {
    core,
    perms: deps.perms,
    ...(deps.after ? { after: deps.after } : {}),
    modelLabel: deps.modelLabel,
    memory: deps.memory,
  });
  const [ev] = events;
  if (!ev) return null;
  // D-09 (the 07.5 re-run rule, 07.8-25 D-13): member data read while answering stays with the answer, set before the
  // append so the cell never acts on a return turn without it.
  if (memberData) {
    await tx.update(agentTurns).set({ memberData: true }).where(eq(agentTurns.eventId, ev.eventId));
  }
  const targetRef = { id: target.id, handle: target.username, displayName: target.name };
  const answerIds = new Set(posted?.ids ?? []);
  const payload: StoredConsultReply = {
    ...ev,
    // The answer is the event's message: its chunks are not repeated as history.
    threadHistory: ev.threadHistory.filter((h) => !answerIds.has(h.id)),
    type: AgentChannelEventTypes.consultReply,
    // The answer is the consulted bot's message; a server sentence stays the chain's human's (the card-action pattern).
    message: posted
      ? { ...ev.message, author: { kind: "agent", id: target.id, displayName: target.name } }
      : ev.message,
    origin: {
      agent: targetRef,
      chainId: chain.id,
      hopId: hop.id,
      depth: hop.depth,
      mode: hop.mode as ConsultMode,
      onBehalfOf: human,
    },
    consultReply: {
      chainId: chain.id,
      hopId: hop.id,
      target: targetRef,
      mode: hop.mode as ConsultMode,
      outcome: effective,
      answerMessageId: effective === "answered" && posted ? posted.id : null,
    },
  };
  await core.realtime.appendEvent(
    tx,
    cellTopic(organizationId),
    AgentChannelEventTypes.consultReply,
    payload,
    {
      actorUserId: chain.humanUserId,
    },
  );
  return payload;
}

/**
 * Whether this turn handed its own hop on to a return turn (Pitfall 6): it opened a `consult` that is still pending, or
 * whose answer was already delivered back to it as a return turn (a child that closed before this turn's done arrived).
 * A refused, cancelled or undelivered child leaves the parent to this turn.
 */
async function waitsForChild(tx: Tx, eventId: string): Promise<boolean> {
  const children = await tx
    .select({ id: agentChainHops.id, status: agentChainHops.status })
    .from(agentChainHops)
    .where(and(eq(agentChainHops.sourceEventId, eventId), eq(agentChainHops.mode, "consult")));
  if (children.some((c) => c.status === "pending")) return true;
  if (children.length === 0) return false;
  const [returned] = await tx
    .select({ eventId: agentTurns.eventId })
    .from(agentTurns)
    .where(
      inArray(
        agentTurns.returningHopId,
        children.map((c) => c.id),
      ),
    )
    .limit(1);
  return !!returned;
}

/**
 * Closes the chain once nothing is left to answer (`active → completed`), under the chain's row lock taken after every
 * stream append (the consult route's order: stream, then chain), so a consult opening a hop in the same chain is either
 * seen as pending or refused `chain_closed`. Also the timeout tick's completion rule (07.7-09).
 */
export async function completeChain(tx: Tx, chainId: string): Promise<void> {
  const [chain] = await tx
    .select({ status: agentChains.status })
    .from(agentChains)
    .where(eq(agentChains.id, chainId))
    .for("update");
  if (chain?.status !== "active") return;
  const [pending] = await tx
    .select({ id: agentChainHops.id })
    .from(agentChainHops)
    .where(and(eq(agentChainHops.chainId, chainId), eq(agentChainHops.status, "pending")))
    .limit(1);
  if (pending) return;
  await tx
    .update(agentChains)
    .set({ status: "completed", closedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(agentChains.id, chainId), eq(agentChains.status, "active")));
}

/**
 * Closes the hop `turn` answers with its outcome (`pending → answered | failed`, once), announces it, delivers the
 * answer back for a consult, and audits it. Returns whether a return turn was delivered, or null when the hop was no
 * longer pending (a replay, a double done, a timeout or a Stop came first: nothing happens).
 */
async function closeAnsweredHop(
  tx: Tx,
  deps: ConsultDeps,
  cell: CellPrincipal,
  turn: TurnRow,
  hopId: string,
  outcome: AgentChannelTurnDone["outcome"],
): Promise<{ delivered: boolean } | null> {
  const status = outcome === "replied" && turn.replyMessageId ? "answered" : "failed";
  const [hop] = await tx
    .update(agentChainHops)
    .set({
      status,
      // CR-A-04: a failed turn has no answer (its post, if any, is the bridge's failure notice or a fragment).
      answerMessageId: status === "answered" ? turn.replyMessageId : null,
      closedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(agentChainHops.id, hopId), eq(agentChainHops.status, "pending")))
    .returning();
  if (!hop) return null;
  // Streams in the order a post takes them: the thread's `message.updated` first, then the cell's delivery.
  await announceConsults(tx, deps.core, [
    hop.questionMessageId,
    ...(hop.answerMessageId ? [hop.answerMessageId] : []),
  ]);
  const ev = await deliverConsultReply(tx, deps, hop, status);
  await deps.core.audit.record(tx, {
    ...cellAuditBase(cell),
    action: status === "answered" ? "agent.consult.answered" : "agent.consult.failed",
    resourceType: "agent_chain_hop",
    resourceId: hop.id,
    result: status === "answered" ? "success" : "error",
    actorKind: "agent",
    actorId: turn.agentId,
    agentId: turn.agentId,
    userId: turn.userId,
    // Ids only: never the question or the answer.
    metadata: {
      chainId: hop.chainId,
      hopId: hop.id,
      questionMessageId: hop.questionMessageId,
      answerMessageId: hop.answerMessageId,
      sourceAgentId: hop.sourceAgentId,
      targetAgentId: hop.targetAgentId,
      depth: hop.depth,
      mode: hop.mode,
      eventId: turn.eventId,
      returnEventId: ev?.eventId ?? null,
    },
  });
  return { delivered: ev !== null };
}

/**
 * `POST /turns/:eventId/done` (P-09): the cell's signal that a turn which may belong to a chain ended. tx0 (no user)
 * binds the event to this cell's bot (RLS: another organization's event is invisible) and finds its chain; a turn outside
 * any chain changes nothing. tx1 runs as the turn's human: the hop it answers closes (unless it is waiting for a consult
 * of its own), and the chain completes when nothing is pending and either this is the root bot's turn or no return
 * turn was delivered. Idempotent: every write is conditional.
 */
export async function turnDone(
  deps: ConsultDeps,
  cell: CellPrincipal,
  eventId: string,
  body: AgentChannelTurnDone,
): Promise<void> {
  const { core } = deps;
  const found = await core.db.withTenant(
    { organizationId: cell.organizationId, userId: null },
    async (tx) => {
      const [turn] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, eventId));
      if (!turn || turn.agentId !== body.agentId) return null;
      const base = { userId: turn.userId, conversationId: turn.conversationId };
      if (turn.chainId) return { ...base, chainId: turn.chainId };
      const [rooted] = await tx
        .select({ id: agentChains.id })
        .from(agentChains)
        .where(eq(agentChains.rootEventId, eventId))
        .limit(1);
      return { ...base, chainId: rooted?.id ?? null };
    },
  );
  if (!found) throw notFound(UNKNOWN_TURN, "unknown_turn");
  const { chainId } = found;
  if (!chainId) return;
  await core.db.withTenant({ organizationId: cell.organizationId, userId: found.userId }, async (tx) => {
    // The thread's stream first, then the turn, the hop and the chain: the consult route's lock order (CR-A-02), so a
    // done and a consult in one chain never deadlock. The turn is read under the stream (CR-A-05): a post of this turn
    // still in flight commits its reply under the same lock, so its answer is seen here (the conversation never changes).
    await lockNextSeq(tx, convTopic(found.conversationId));
    const [turn] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, eventId));
    if (!turn) return;
    // P-15: an orphaned chain (thread root deleted, human gone) is cancelled `auto` at this touch; nothing closes or
    // returns.
    const [chain] = await tx.select().from(agentChains).where(eq(agentChains.id, chainId)).limit(1);
    if (chain?.status === "active" && !(await chainLive(tx, core, chain))) {
      await cancelChain(tx, deps, chainId, { byUserId: null, reason: "auto" });
      return;
    }
    let closed: { delivered: boolean } | null = null;
    if (turn.answeringHopId && !(await waitsForChild(tx, turn.eventId))) {
      closed = await closeAnsweredHop(tx, deps, cell, turn, turn.answeringHopId, body.outcome);
    }
    if (!turn.answeringHopId || (closed && !closed.delivered)) await completeChain(tx, chainId);
  });
}

/**
 * Stops a chain (P-14, D-04): `active → cancelled` once (with the reason and, for a person's Stop, who stopped it),
 * every pending hop `cancelled`, the questions re-announced, `agent.chain.cancelled` audited with ids and counts. No
 * in-flight turn is aborted (the cell has no abort; ADR-0027): a late answer still posts, but its done finds no pending
 * hop and delivers nothing, and new consults in the chain are `chain_closed`. Null when the chain was not active (a
 * second Stop, a completed chain): nothing changes and nothing is audited. The caller decides who may stop it.
 */
export async function cancelChain(
  tx: Tx,
  deps: Pick<ConsultDeps, "core">,
  chainId: string,
  p: { byUserId: string | null; reason: "user" | "auto" },
): Promise<{ cancelledHops: number } | null> {
  const { core } = deps;
  const [current] = await tx
    .select({ conversationId: agentChains.conversationId })
    .from(agentChains)
    .where(eq(agentChains.id, chainId))
    .limit(1);
  if (!current) return null;
  // The thread's stream before the chain row (the consult route's order: its post holds the stream when it spends the
  // chain's budget), so a Stop racing a consult waits instead of deadlocking.
  await lockNextSeq(tx, convTopic(current.conversationId));
  const [chain] = await tx
    .update(agentChains)
    .set({
      status: "cancelled",
      cancelReason: p.reason,
      cancelledByUserId: p.byUserId,
      closedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(agentChains.id, chainId), eq(agentChains.status, "active")))
    .returning();
  if (!chain) return null;
  const hops = await tx
    .update(agentChainHops)
    .set({ status: "cancelled", closedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(agentChainHops.chainId, chainId), eq(agentChainHops.status, "pending")))
    .returning({ id: agentChainHops.id, questionMessageId: agentChainHops.questionMessageId });
  await announceConsults(
    tx,
    core,
    hops.map((h) => h.questionMessageId),
  );
  await core.audit.record(tx, {
    action: "agent.chain.cancelled",
    resourceType: "agent_chain",
    resourceId: chain.id,
    result: "success",
    ...(p.byUserId ? { actorKind: "user" as const, actorId: p.byUserId } : { actorKind: "system" as const }),
    userId: p.byUserId ?? chain.humanUserId,
    // Ids and counts only.
    metadata: {
      chainId: chain.id,
      reason: p.reason,
      cancelledHops: hops.length,
      hopIds: hops.map((h) => h.id),
      humanUserId: chain.humanUserId,
      conversationId: chain.conversationId,
    },
  });
  return { cancelledHops: hops.length };
}

const DoneParams = z.object({ eventId: Id });

/** Registers the cell's turn-done signal on the bearer-authenticated Agent Channel scope. */
export function registerChainCellRoutes(scope: App, deps: ConsultDeps): void {
  scope.post(
    "/turns/:eventId/done",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        params: DoneParams,
        body: AgentChannelTurnDone,
        response: { 200: Ok },
      },
    },
    async (req) => {
      await turnDone(deps, cellOf(req), req.params.eventId, req.body);
      return { ok: true as const };
    },
  );
}
