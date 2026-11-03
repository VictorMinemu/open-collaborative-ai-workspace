import {
  A2A_HOP_BUDGET,
  A2A_HOP_TIMEOUT_MS,
  A2A_MAX_DEPTH,
  A2A_PARENT_GRACE_MS,
  AgentChannelConsultRequest,
  AgentChannelConsultResponse,
  AgentChannelEventTypes,
  ApiError,
  BUILTIN_TOOLS,
  type ConsultMode,
  cellTopic,
  type ModelRef,
  type TurnToolFlags,
} from "@ocw/contracts";
import {
  type AfterCommit,
  agentChainHops,
  agentChains,
  agents,
  agentTurns,
  conversationMembers,
  conversations,
  messages,
  orgMembers,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { App, Core } from "../../core";
import type { AgentMention } from "../../lib/chat-agent-bridge";
import { notFound } from "../../lib/errors";
import { inChannel } from "../bot-capabilities";
import { announceConsults, convTopic, lockNextSeq } from "../chat";
import type { MemoryService } from "../memory";
import { AuthzDeniedError, memberDirectory, type PermissionService } from "../organization";
import { decideAgentMessage } from "./agent-message";
import { type CellPrincipal, cellOf } from "./auth";
import { cancelChain, chainLive } from "./chains";
import { type AgentTurnRow, auditUnknownTurn, cellAuditBase, claimToolCall, liveTurn } from "./claim";
import { buildMentionEvents, type StoredMention } from "./mentions";

/**
 * `POST /agent-channel/v1/consultations` (`ocw_consult_agent`, Phase 07.7; A2A-01 … A2A-03; D-01 … D-04, D-07, D-08,
 * D-13, D-15; ADR-0027): a bot asks another bot of the organization a question for the human of its turn. The question
 * is the asking bot's visible message `@<target> <question>` in the turn's thread; the target gets a turn on it for the
 * same human (the chain's human pays every hop), and its answer comes back as a new turn (07.7-06).
 *
 * The 07.6 self-validated tool route (`automation-proposals.ts`): tx0 (no user) finds the turn's human in the turn ledger
 * (another organization's event is invisible: 404 `unknown_turn`); tx1 runs AS that human: the live turn (they still read
 * its conversation) → a retry of the key answers its stored hop, nothing claimed or emitted again → the pre-checks, first
 * failure wins, only to name a precise code → the claim (always side-effecting: a tainted turn is refused; a pre-check
 * refusal is recorded by it) → the question posted with `postAgentMessageIn` (chat re-checks the bot and that the human
 * still reads), whose `onInserted` opens the chain and the hop under the DB guards (budget as a conditional UPDATE,
 * target once, not root, one pending per source, depth) → the target's turn built like a proactive delivery. A guard a
 * concurrent request won after the pre-checks rolls the whole transaction back; the refusal is then recorded by a second
 * short claim. Ids never come from the model beyond the target, the question, the mode and the key (strict body); audits
 * and logs carry ids and codes only, never the question.
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];
const TOOL = BUILTIN_TOOLS.consultAgent;
/** Trusted answer, always side-effecting (D-08, D-09): never from a tainted turn, whatever the turn's flags say. */
const FLAGS: TurnToolFlags = { untrustedOutput: false, sideEffecting: true };
const UNKNOWN_TURN = "No delivered turn of this bot has that id";
const Refusal = z.union([AgentChannelConsultResponse, ApiError]);

type Status = 200 | 403 | 404 | 409;
/** The route's answer table (07.7-01): 403 for the claim and the decisions, 409 for the cap and the guards. */
const STATUS: Record<string, Status> = {
  not_in_turn: 403,
  tainted: 403,
  not_channel: 403,
  not_allowed: 403,
  target_personal: 403,
  target_unavailable: 403,
  target_not_member: 403,
  cap_reached: 409,
  chain_closed: 409,
  depth_exceeded: 409,
  target_is_self: 409,
  target_in_chain: 409,
  budget_exhausted: 409,
  consult_pending: 409,
  idempotency_conflict: 409,
  target_not_found: 404,
};

/** One line, no control characters, bounded: the only server values a sentence carries. */
const clean = (value: string, max: number) =>
  [...value]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? " " : ch;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);

interface SentenceVars {
  /** The target's handle (no `@`), or null when the target is unknown. */
  handle: string | null;
  person: string;
}

const at = (v: SentenceVars) => (v.handle ? `@${v.handle}` : "That bot");

/** The model-facing sentences (one line each); the plugin relays them as the tool's answer. */
export const CONSULT_SENTENCES = {
  consult: (v: SentenceVars) =>
    `Question sent to ${at(v)}. Their answer will arrive as a new message in this thread. Tell ${v.person} in one line that you are checking with ${at(v)}.`,
  handoff: (v: SentenceVars) =>
    `Handed over to ${at(v)}. They continue in this thread; you will not get an answer back. Tell ${v.person} in one line.`,
  limit_reached: (v: SentenceVars) => `${at(v)} has reached its daily limit and cannot answer today.`,
  not_allowed: (v: SentenceVars) => `You are not allowed to consult ${at(v)} here.`,
  target_not_member: (v: SentenceVars) => `${at(v)} is not in this channel. Ask a person to add it.`,
  consult_pending: () =>
    "You already have a question waiting for an answer. Wait for it before asking again.",
  budget_exhausted: () => "This request has used all its questions to other bots.",
  tainted: (v: SentenceVars) =>
    `I can't consult another bot after reading web or tool content in this turn. Tell ${v.person} to ask again in a new message.`,
  not_in_turn: () => "Consulting other bots is not available on this turn.",
  cap_reached: () => "This turn already used all its tool calls. Ask again in a new message.",
  target_not_found: () => "That bot does not exist in this organization. Check the handle with the person.",
  other: (v: SentenceVars) => `${at(v)} cannot be consulted here.`,
} as const;

export function consultSentence(code: string, v: SentenceVars): string {
  const vars = {
    handle: v.handle ? clean(v.handle, 64) : null,
    person: clean(v.person, 120) || "the person",
  };
  const fn =
    (CONSULT_SENTENCES as Record<string, (v: SentenceVars) => string>)[code] ?? CONSULT_SENTENCES.other;
  return fn(vars).slice(0, 500);
}

type Answer =
  | { status: 200 | 403 | 404 | 409; body: AgentChannelConsultResponse }
  | { status: 404; code: "unknown_turn" };

export interface ConsultDeps {
  core: Core;
  perms: PermissionService;
  after?: AfterCommit;
  modelLabel?: ((ref: ModelRef) => string) | undefined;
  memory?: MemoryService | undefined;
}

type HopRow = typeof agentChainHops.$inferSelect;
type ChainRow = typeof agentChains.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

/** A guard a concurrent request won between the pre-checks and the write: the code the route records and answers. */
class ConsultRace extends Error {
  constructor(readonly code: string) {
    super(`consult refused: ${code}`);
  }
}

/** The PostgreSQL error under drizzle's wrapper (code and constraint name), if any. */
function pgError(err: unknown): { code?: string; constraint?: string } | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === "object"; i++) {
    const c = e as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof c.code === "string") {
      return { code: c.code, constraint: typeof c.constraint === "string" ? c.constraint : undefined };
    }
    e = c.cause;
  }
  return undefined;
}

/**
 * The refusal a lost race maps to, by constraint name (07.7-02): a guard a concurrent request won. Anything else, a
 * malformed depth or parent (`agent_chain_hops_source_depth_check`, `agent_chain_hops_parent_fk`) included, is a bug and
 * is rethrown (500), never turned into a refusal.
 */
function raceCode(err: unknown): string | null {
  if (err instanceof ConsultRace) return err.code;
  // The question post itself refused: the bot may no longer post here, or the human no longer reads (chat's checks).
  if (err instanceof AuthzDeniedError) return "not_allowed";
  const pg = pgError(err);
  if (!pg?.constraint) return null;
  switch (pg.constraint) {
    case "agent_chain_hops_target_once":
    case "agent_chain_hops_not_root":
      return "target_in_chain";
    case "agent_chain_hops_not_self":
      return "target_is_self";
    case "agent_chain_hops_one_pending":
      return "consult_pending";
    case "agent_chain_hops_idempotency":
      return "idempotency_conflict";
    case "agent_chains_budget_check":
      return "budget_exhausted";
    case "agent_chain_hops_depth_check":
    case "agent_chain_hops_parent_depth_check":
      return "depth_exceeded";
    default:
      return null;
  }
}

async function personName(tx: Tx, userId: string): Promise<string> {
  const [m] = await tx
    .select({ name: orgMembers.displayName })
    .from(orgMembers)
    .where(eq(orgMembers.userId, userId))
    .limit(1);
  return m?.name ?? "the person who asked";
}

async function findTarget(tx: Tx, id: string): Promise<AgentRow | null> {
  const [row] = await tx
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), isNull(agents.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** The thread a turn's replies go to: its message's thread root (single-level threads), or the message itself. */
async function threadRootOf(tx: Tx, messageId: string): Promise<string> {
  const [m] = await tx
    .select({ id: messages.id, threadId: messages.threadId })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!m) throw new Error("turn message missing");
  return m.threadId ?? m.id;
}

/** The chain this turn consults in: its own (a hop turn), or the one it opened as root. */
async function chainOf(tx: Tx, turn: AgentTurnRow): Promise<ChainRow | null> {
  const [row] = await tx
    .select()
    .from(agentChains)
    .where(turn.chainId ? eq(agentChains.id, turn.chainId) : eq(agentChains.rootEventId, turn.eventId))
    .limit(1);
  return row ?? null;
}

/**
 * The turn's chain after the lazy automatic cancel (P-15): an active chain whose thread root is deleted or whose human
 * no longer reads the channel is cancelled `auto` at this touch (in the request's transaction, before its claim: the
 * thread's stream, then the chain, the consult route's lock order), so the request is refused `chain_closed`.
 */
async function touchChain(tx: Tx, core: Core, turn: AgentTurnRow): Promise<ChainRow | null> {
  const chain = await chainOf(tx, turn);
  if (chain?.status !== "active" || (await chainLive(tx, core, chain))) return chain;
  await cancelChain(tx, { core }, chain.id, { byUserId: null, reason: "auto" });
  return chainOf(tx, turn);
}

/** The target is a member of the turn's conversation or of its parent channel (D-04: v1 never adds it). */
async function isMember(tx: Tx, conversationId: string, agentId: string): Promise<boolean> {
  const [conv] = await tx
    .select({ id: conversations.id, parent: conversations.parentConversationId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conv) return false;
  const [m] = await tx
    .select({ id: conversationMembers.memberId })
    .from(conversationMembers)
    .where(
      and(
        inArray(conversationMembers.conversationId, [conv.id, ...(conv.parent ? [conv.parent] : [])]),
        eq(conversationMembers.memberKind, "agent"),
        eq(conversationMembers.memberId, agentId),
      ),
    )
    .limit(1);
  return !!m;
}

/**
 * The precise code of a consult that cannot succeed, first failure wins (D-02, D-03, D-04, D-08). Reads only: the DB
 * constraints still decide every guard at write time.
 */
async function precheck(
  tx: Tx,
  perms: PermissionService,
  p: { turn: AgentTurnRow; chain: ChainRow | null; target: AgentRow | null },
): Promise<string | null> {
  const { turn, chain, target } = p;
  // The claim's own codes first, as every self-validated route (a turn that read outside content says so).
  if (turn.tainted) return "tainted";
  if (!turn.tools.includes(TOOL)) return "not_in_turn";
  if (!(await inChannel(tx, turn.conversationId))) return "not_channel";
  if (chain && chain.status !== "active") return "chain_closed";
  if (turn.chainDepth + 1 > A2A_MAX_DEPTH) return "depth_exceeded";
  if (!target) return "target_not_found";
  if (target.status === "disabled") return "target_unavailable";
  if (target.scope === "personal") return "target_personal";
  if (target.id === turn.agentId) return "target_is_self";
  if (chain) {
    if (target.id === chain.rootAgentId) return "target_in_chain";
    const [asked] = await tx
      .select({ id: agentChainHops.id })
      .from(agentChainHops)
      .where(and(eq(agentChainHops.chainId, chain.id), eq(agentChainHops.targetAgentId, target.id)))
      .limit(1);
    if (asked) return "target_in_chain";
  }
  if (!(await isMember(tx, turn.conversationId, target.id))) return "target_not_member";
  const decision = await decideAgentMessage(tx, perms, {
    sourceAgentId: turn.agentId,
    humanUserId: turn.userId,
    targetAgentId: target.id,
  });
  if (!decision.allowed) return "not_allowed";
  if (chain) {
    if (chain.hopsUsed >= chain.hopBudget) return "budget_exhausted";
    const [pending] = await tx
      .select({ id: agentChainHops.id })
      .from(agentChainHops)
      .where(
        and(
          eq(agentChainHops.chainId, chain.id),
          eq(agentChainHops.sourceAgentId, turn.agentId),
          eq(agentChainHops.status, "pending"),
        ),
      )
      .limit(1);
    if (pending) return "consult_pending";
  }
  return null;
}

/**
 * Opens the hop for a question message just inserted (`onInserted`, the post's transaction): the chain (one per root
 * turn; a concurrent first consult of the same turn re-reads it), the budget as a conditional UPDATE, the hop under the
 * DB guards, and the parent's deadline pushed past the child's (P-10).
 */
async function openHop(
  tx: Tx,
  p: {
    turn: AgentTurnRow;
    chain: ChainRow | null;
    target: AgentRow;
    threadRootId: string;
    questionMessageId: string;
    mode: ConsultMode;
    idempotencyKey: string;
  },
): Promise<{ chain: ChainRow; hop: HopRow }> {
  const { turn, target } = p;
  const { organizationId } = tenantOf(tx);
  let chain = p.chain;
  if (!chain) {
    await tx
      .insert(agentChains)
      .values({
        organizationId,
        conversationId: turn.conversationId,
        threadRootId: p.threadRootId,
        rootEventId: turn.eventId,
        rootAgentId: turn.agentId,
        humanUserId: turn.userId,
        hopBudget: A2A_HOP_BUDGET,
      })
      .onConflictDoNothing({ target: agentChains.rootEventId });
    const [found] = await tx
      .select()
      .from(agentChains)
      .where(eq(agentChains.rootEventId, turn.eventId))
      .limit(1);
    if (!found) throw new Error("agent chain missing after its upsert");
    chain = found;
  }
  const [spent] = await tx
    .update(agentChains)
    .set({ hopsUsed: sql`${agentChains.hopsUsed} + 1`, updatedAt: sql`now()` })
    .where(
      and(
        eq(agentChains.id, chain.id),
        eq(agentChains.status, "active"),
        sql`${agentChains.hopsUsed} < ${agentChains.hopBudget}`,
      ),
    )
    .returning();
  if (!spent) {
    const [now] = await tx
      .select({ status: agentChains.status })
      .from(agentChains)
      .where(eq(agentChains.id, chain.id));
    throw new ConsultRace(now?.status === "active" ? "budget_exhausted" : "chain_closed");
  }
  const depth = turn.chainDepth + 1;
  const parentHopId = depth === 1 ? null : turn.answeringHopId;
  const [hop] = await tx
    .insert(agentChainHops)
    .values({
      organizationId,
      chainId: spent.id,
      rootAgentId: spent.rootAgentId,
      parentHopId,
      sourceAgentId: turn.agentId,
      targetAgentId: target.id,
      depth,
      mode: p.mode,
      status: "pending",
      sourceEventId: turn.eventId,
      questionMessageId: p.questionMessageId,
      idempotencyKey: p.idempotencyKey,
      deadlineAt: sql`now() + make_interval(secs => ${A2A_HOP_TIMEOUT_MS / 1000})`,
    })
    .returning();
  if (!hop) throw new Error("agent chain hop insert returned no row");
  if (parentHopId) {
    // P-10: the parent waits at least until the child's deadline plus the grace, so it never times out first.
    await tx
      .update(agentChainHops)
      .set({
        deadlineAt: sql`greatest(${agentChainHops.deadlineAt}, ${hop.deadlineAt}::timestamptz + make_interval(secs => ${A2A_PARENT_GRACE_MS / 1000}))`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(agentChainHops.id, parentHopId), eq(agentChainHops.status, "pending")));
  }
  return { chain: spent, hop };
}

/**
 * Delivers a consult question to its target (D-07, the `deliverAutomationRun` pattern), inside the route's transaction:
 * an `AgentMention` whose structural author is the chain's human (so `turnPolicy` decides the target's tools, limits and
 * metering for that human, and the turn ledger row is theirs) on the question message, `trigger: "consult"` (unattended,
 * D-13) with the chain context, built by `buildMentionEvents`; then the event names the asking bot as `message.author`
 * and carries the server-built `origin`, and is appended to `cell:<org>`. Null when the target gets no turn (its daily
 * limit: `buildMentionEvents` already scheduled the existing limit notice).
 */
export async function deliverConsultQuestion(
  tx: Tx,
  deps: ConsultDeps,
  p: {
    turn: AgentTurnRow;
    chain: ChainRow;
    hop: HopRow;
    target: AgentRow;
    threadRootId: string;
    question: string;
  },
): Promise<StoredMention | null> {
  const { core } = deps;
  const { organizationId } = tenantOf(tx);
  const directory = await memberDirectory(tx);
  const human = {
    kind: "user" as const,
    id: p.chain.humanUserId,
    displayName: directory.get(p.chain.humanUserId)?.displayName ?? "Former member",
  };
  const [source] = await tx
    .select({ id: agents.id, name: agents.name, username: agents.username })
    .from(agents)
    .where(eq(agents.id, p.hop.sourceAgentId))
    .limit(1);
  if (!source) throw new Error("consulting agent missing");
  const used = await tx
    .select({ id: agentChainHops.targetAgentId })
    .from(agentChainHops)
    .where(eq(agentChainHops.chainId, p.chain.id));
  const mention: AgentMention = {
    organizationId,
    conversationId: p.turn.conversationId,
    threadRootId: p.threadRootId,
    messageId: p.hop.questionMessageId,
    agentIds: [p.target.id],
    author: human,
    body: p.question,
    createdAt: new Date().toISOString(),
    delivery: "thread",
    trigger: "consult",
    chain: {
      chainId: p.chain.id,
      depth: p.hop.depth as 1 | 2,
      answeringHopId: p.hop.id,
      returningHopId: null,
      rootAgentId: p.chain.rootAgentId,
      usedTargetIds: used.map((u) => u.id),
    },
    taintedAtStart: false,
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
  const payload: StoredMention = {
    ...ev,
    message: { ...ev.message, author: { kind: "agent", id: source.id, displayName: source.name } },
    origin: {
      agent: { id: source.id, handle: source.username, displayName: source.name },
      chainId: p.chain.id,
      hopId: p.hop.id,
      depth: p.hop.depth,
      mode: p.hop.mode as ConsultMode,
      onBehalfOf: human,
    },
  };
  await core.realtime.appendEvent(tx, cellTopic(organizationId), AgentChannelEventTypes.mention, payload, {
    actorUserId: human.id,
  });
  return payload;
}

/** The stored hop's answer for a retry of its key (Pitfall 9): nothing is claimed, posted or emitted again. */
async function storedAnswer(
  tx: Tx,
  hop: HopRow,
  person: string,
): Promise<{ status: 200; body: AgentChannelConsultResponse }> {
  const target = await findTarget(tx, hop.targetAgentId);
  const vars = { handle: target?.username ?? null, person };
  if (hop.status === "refused" && hop.refusalReason === "limit_reached") {
    return {
      status: 200,
      body: {
        ok: false,
        code: "limit_reached",
        hopId: hop.id,
        questionMessageId: hop.questionMessageId,
        sentence: consultSentence("limit_reached", vars),
      },
    };
  }
  return {
    status: 200,
    body: {
      ok: true,
      chainId: hop.chainId,
      hopId: hop.id,
      questionMessageId: hop.questionMessageId,
      sentence: consultSentence(hop.mode === "handoff" ? "handoff" : "consult", vars),
    },
  };
}

async function hopByKey(tx: Tx, agentId: string, key: string): Promise<HopRow | null> {
  const [hop] = await tx
    .select()
    .from(agentChainHops)
    .where(and(eq(agentChainHops.sourceAgentId, agentId), eq(agentChainHops.idempotencyKey, key)))
    .limit(1);
  return hop ?? null;
}

/** A refusal the model reads: every code but `unknown_turn` carries its sentence, a 404 `target_not_found` included. */
function refusal(code: string, vars: SentenceVars): Answer {
  return { status: STATUS[code] ?? 409, body: { ok: false, code, sentence: consultSentence(code, vars) } };
}

async function consult(
  deps: ConsultDeps,
  cell: CellPrincipal,
  body: AgentChannelConsultRequest,
): Promise<Answer> {
  const { core, perms } = deps;
  // Ids, the mode and the question's length only: never the question.
  const metadata = {
    eventId: body.eventId,
    targetAgentId: body.target,
    mode: body.mode,
  };
  const human = await core.db.withTenant(
    { organizationId: cell.organizationId, userId: null },
    async (tx) => {
      const [turn] = await tx
        .select({ agentId: agentTurns.agentId, userId: agentTurns.userId })
        .from(agentTurns)
        .where(eq(agentTurns.eventId, body.eventId));
      if (turn && turn.agentId === body.agentId) return turn.userId;
      await auditUnknownTurn(tx, core, { cell, tool: TOOL, reason: "unknown_turn", metadata });
      return null;
    },
  );
  if (!human) return { status: 404, code: "unknown_turn" };
  const ctx = { organizationId: cell.organizationId, userId: human };

  try {
    return await core.db.withTenant(ctx, async (tx): Promise<Answer> => {
      const turn = await liveTurn(tx, core, body);
      if (!turn || turn.userId !== human) {
        // The human no longer reads the turn's conversation: its chain (if any) is orphaned and stops here (P-15).
        const [stale] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, body.eventId));
        if (stale && stale.agentId === body.agentId) await touchChain(tx, core, stale);
        await auditUnknownTurn(tx, core, { cell, tool: TOOL, reason: "unknown_turn", metadata });
        return { status: 404, code: "unknown_turn" };
      }
      // CR-A-02: the thread's stream before anything locks the turn row (the claim below, the question's post): every
      // writer's order is stream → turn → hop → chain, so a first post of this turn (stream, then `recordChainReply` on
      // the turn) and this consult never deadlock.
      await lockNextSeq(tx, convTopic(turn.conversationId));
      const person = await personName(tx, human);
      // A retry of the key (an OpenClaw or bridge retry) answers the stored hop: one hop, one message, one delivery.
      const prior = await hopByKey(tx, turn.agentId, body.idempotencyKey);
      if (prior && prior.sourceEventId === turn.eventId) return storedAnswer(tx, prior, person);

      const target = await findTarget(tx, body.target);
      const vars = { handle: target?.username ?? null, person };
      const chain = await touchChain(tx, core, turn);
      const code = prior ? "idempotency_conflict" : await precheck(tx, perms, { turn, chain, target });
      const claim = await claimToolCall(tx, core, {
        cell,
        turn,
        tool: TOOL,
        flags: FLAGS,
        web: false,
        sourceKind: "builtin",
        sourceId: null,
        target: null,
        reason: code,
        metadata: { ...metadata, ...(chain ? { chainId: chain.id } : {}) },
      });
      if (!claim.allowed || !target) return refusal(claim.reason ?? code ?? "cap_reached", vars);

      const threadRootId = await threadRootOf(tx, turn.messageId);
      const questionBody = `@${target.username} ${body.question}`;
      let opened: { chain: ChainRow; hop: HopRow } | null = null;
      const posted = await core.chatAgent.postAgentMessageIn(tx, {
        agentId: turn.agentId,
        conversationId: turn.conversationId,
        threadRootId,
        body: questionBody,
        // Its own namespace, like cards: a consult and a plain reply never collide on one key.
        idempotencyKey: `consult:${body.idempotencyKey}`,
        inReplyToMessageId: turn.messageId,
        onBehalfOfUserId: human,
        onInserted: async (itx, questionMessageId) => {
          opened = await openHop(itx, {
            turn,
            chain,
            target,
            threadRootId,
            questionMessageId,
            mode: body.mode,
            idempotencyKey: body.idempotencyKey,
          });
        },
      });
      if (!posted.created || !opened) {
        // A concurrent request with the same key posted first (its question and hop are committed): its answer.
        const hop = await hopByKey(tx, turn.agentId, body.idempotencyKey);
        if (!hop || hop.sourceEventId !== turn.eventId) throw new Error("consult question without its hop");
        return storedAnswer(tx, hop, person);
      }
      const { chain: openedChain, hop } = opened as { chain: ChainRow; hop: HopRow };
      const auditBase = {
        ...cellAuditBase(cell),
        resourceType: "agent_chain_hop",
        resourceId: hop.id,
        actorKind: "agent" as const,
        actorId: turn.agentId,
        agentId: turn.agentId,
        userId: human,
      };
      const hopMetadata = {
        chainId: openedChain.id,
        hopId: hop.id,
        questionMessageId: hop.questionMessageId,
        targetAgentId: target.id,
        depth: hop.depth,
        mode: hop.mode,
        eventId: turn.eventId,
      };
      const ev = await deliverConsultQuestion(tx, deps, {
        turn,
        chain: openedChain,
        hop,
        target,
        threadRootId,
        question: questionBody,
      });
      if (!ev) {
        // D-03: the target is at its daily limit. The question stays visible, refused; the limit notice follows.
        await tx
          .update(agentChainHops)
          .set({
            status: "refused",
            refusalReason: "limit_reached",
            closedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(and(eq(agentChainHops.id, hop.id), eq(agentChainHops.status, "pending")));
        await announceConsults(tx, core, [hop.questionMessageId]);
        await core.audit.record(tx, {
          ...auditBase,
          action: "agent.consult.refused",
          result: "denied",
          metadata: { ...hopMetadata, reason: "limit_reached" },
        });
        return {
          status: 200,
          body: {
            ok: false,
            code: "limit_reached",
            hopId: hop.id,
            questionMessageId: hop.questionMessageId,
            sentence: consultSentence("limit_reached", vars),
          },
        };
      }
      await tx
        .update(agentChainHops)
        .set({ targetEventId: ev.eventId, updatedAt: sql`now()` })
        .where(eq(agentChainHops.id, hop.id));
      await core.audit.record(tx, {
        ...auditBase,
        action: "agent.consult.requested",
        result: "success",
        metadata: { ...hopMetadata, targetEventId: ev.eventId },
      });
      return {
        status: 200,
        body: {
          ok: true,
          chainId: openedChain.id,
          hopId: hop.id,
          questionMessageId: hop.questionMessageId,
          sentence: consultSentence(hop.mode === "handoff" ? "handoff" : "consult", vars),
        },
      };
    });
  } catch (err) {
    const code = raceCode(err);
    if (!code) throw err;
    // The race's refusal, recorded by the claim in its own short transaction (the first one rolled back whole).
    return core.db.withTenant(ctx, async (tx): Promise<Answer> => {
      const turn = await liveTurn(tx, core, body);
      if (!turn || turn.userId !== human) {
        await auditUnknownTurn(tx, core, { cell, tool: TOOL, reason: "unknown_turn", metadata });
        return { status: 404, code: "unknown_turn" };
      }
      const target = await findTarget(tx, body.target);
      await claimToolCall(tx, core, {
        cell,
        turn,
        tool: TOOL,
        flags: FLAGS,
        web: false,
        sourceKind: "builtin",
        sourceId: null,
        target: null,
        reason: code,
        metadata: { ...metadata, race: true },
      });
      return refusal(code, { handle: target?.username ?? null, person: await personName(tx, human) });
    });
  }
}

export function registerConsultRoutes(scope: App, deps: ConsultDeps): void {
  scope.post(
    "/consultations",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        body: AgentChannelConsultRequest,
        // A refusal is the model's answer; a validation or authorization error keeps the uniform error body.
        response: { 200: AgentChannelConsultResponse, 403: Refusal, 404: Refusal, 409: Refusal },
      },
    },
    async (req, reply) => {
      const answer = await consult(deps, cellOf(req), req.body);
      // No live turn: the uniform error body (the plugin reads it as "turn no longer active").
      if ("code" in answer) throw notFound(UNKNOWN_TURN, "unknown_turn");
      return reply.code(answer.status).send(answer.body);
    },
  );
}
