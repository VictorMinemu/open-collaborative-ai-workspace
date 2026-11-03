import { agentChainHops, agentChains } from "@ocw/db";
import { and, eq, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { announceConsults, convTopic, lockNextSeq } from "../chat";
import {
  answeringTurn,
  cancelChain,
  chainLive,
  closeAnsweredHop,
  completeChain,
  deliverConsultReply,
} from "./chains";
import type { ConsultDeps } from "./consult";

/**
 * The consult timeout tick (Phase 07.7-09; A2A-03; D-04, D-06, D-11; P-10; ADR-0027, ADR-0028).
 *
 * A hop nobody answers ends by itself: once a minute (07.6's job runtime, `consult.tick`, UTC, evaluated once across
 * replicas) the ids-only `app.expired_agent_chain_hops` lists pending hops past their deadline across organizations, and
 * each is handled in its own organization's tenant transaction as the chain's human, re-read `FOR UPDATE` (the listing is
 * never trusted): an orphaned chain (thread root deleted, human gone) is cancelled `auto` instead (P-15); otherwise
 * `pending → timed_out` once, announced on the question, audited with ids only, and for a `consult` hop
 * returned to the asker as `agent.consult_reply.v1` with the server sentence "@<target> did not answer in time.". A hop
 * whose return delivers nothing (a handoff, the asker's daily limit) leaves the chain to the completion rule, as a done
 * does. The lock order is the consult route's (thread stream → hop → chain), so a tick racing a done, a Stop, a consult
 * or another replica's tick waits instead of deadlocking, and the conditional update leaves exactly one outcome.
 * CR-A-06: a hop whose answer is posted but whose done never came closes `answered` (never `timed_out`), and the
 * idle sweep (`closeIdleChains`) ends active chains with nothing pending and no activity for ten minutes.
 */

/** Hops per tick; the rest wait for the next minute (oldest deadline first). */
const TICK_BATCH = 500;

export type ConsultTickDeps = Omit<ConsultDeps, "core">;

export interface SweepResult {
  timedOut: number;
  cancelled: number;
}

type Outcome = "timed_out" | "cancelled" | "answered" | null;

/** A chain with nothing pending and no activity for this long is ended by the tick (CR-A-06: a lost done). */
export const CHAIN_IDLE_MS = 600_000;

/** One expired hop in its organization: tx0 finds the chain's human, tx1 runs as that human. */
async function expireHop(
  core: Core,
  deps: ConsultTickDeps,
  organizationId: string,
  hopId: string,
  now: Date,
): Promise<Outcome> {
  const found = await core.db.withTenant({ organizationId, userId: null }, async (tx) => {
    const [row] = await tx
      .select({ humanUserId: agentChains.humanUserId, conversationId: agentChains.conversationId })
      .from(agentChainHops)
      .innerJoin(agentChains, eq(agentChains.id, agentChainHops.chainId))
      .where(eq(agentChainHops.id, hopId))
      .limit(1);
    return row ?? null;
  });
  if (!found) return null;
  return core.db.withTenant({ organizationId, userId: found.humanUserId }, async (tx): Promise<Outcome> => {
    // The thread's stream first, then the hop and the chain (the consult route's, done's and Stop's order).
    await lockNextSeq(tx, convTopic(found.conversationId));
    const [hop] = await tx
      .select()
      .from(agentChainHops)
      .where(
        and(
          eq(agentChainHops.id, hopId),
          eq(agentChainHops.status, "pending"),
          sql`${agentChainHops.deadlineAt} < ${now.toISOString()}::timestamptz`,
        ),
      )
      .for("update");
    if (!hop) return null;
    const [chain] = await tx.select().from(agentChains).where(eq(agentChains.id, hop.chainId)).limit(1);
    if (chain?.status !== "active") return null;
    // P-15: an orphaned chain (thread root deleted, human gone) is cancelled `auto` instead; nothing is delivered.
    if (!(await chainLive(tx, core, chain))) {
      const cancelled = await cancelChain(tx, { core }, chain.id, { byUserId: null, reason: "auto" });
      return cancelled ? "cancelled" : null;
    }
    // CR-A-06: the hop's answer is posted but its done never came (best effort): it closes `answered` through the done's
    // own path, never `timed_out`.
    const answeredBy = await answeringTurn(tx, hop.id);
    if (answeredBy) {
      const answered = await closeAnsweredHop(tx, { core, ...deps }, null, answeredBy, hop.id, "replied");
      if (!answered) return null;
      await completeChain(tx, hop.chainId, now);
      return "answered";
    }
    const [closed] = await tx
      .update(agentChainHops)
      .set({ status: "timed_out", closedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(agentChainHops.id, hop.id), eq(agentChainHops.status, "pending")))
      .returning();
    if (!closed) return null;
    // Streams in the order a post takes them: the thread's `message.updated` first, then the cell's delivery.
    await announceConsults(tx, core, [closed.questionMessageId]);
    const ev = await deliverConsultReply(tx, { core, ...deps }, closed, "timed_out");
    await core.audit.record(tx, {
      action: "agent.consult.timed_out",
      resourceType: "agent_chain_hop",
      resourceId: closed.id,
      result: "error",
      actorKind: "system",
      agentId: closed.targetAgentId,
      userId: found.humanUserId,
      // Ids only: never the question.
      metadata: {
        chainId: closed.chainId,
        hopId: closed.id,
        questionMessageId: closed.questionMessageId,
        sourceAgentId: closed.sourceAgentId,
        targetAgentId: closed.targetAgentId,
        depth: closed.depth,
        mode: closed.mode,
        returnEventId: ev?.eventId ?? null,
      },
    });
    // Nothing went back (a handoff, the asker at its limit): the chain completes once nothing is pending; otherwise the
    // asker's return turn closes it with its own done.
    if (!ev) await completeChain(tx, closed.chainId, now);
    return "timed_out";
  });
}

/** CR-A-08: the tick's tries on one hop before it gives up, and the backoff between them (1, 2, 4, 8 minutes). */
export const TICK_MAX_ATTEMPTS = 5;
const backoffMs = (attempt: number) => Math.min(30, 2 ** (attempt - 1)) * 60_000;

/**
 * A hop the tick could not close (CR-A-08), in its own short transaction: the failure is counted and its next try pushed
 * out by the backoff (the listing is oldest deadline first, so newer expired hops are reached first and a poison hop
 * never starves them); the last attempt ends it `pending → failed` with `refusal_reason = 'tick_error'`, announced
 * nowhere (whatever broke would break again), audited with ids only. The idle sweep then ends its chain.
 */
async function recordTickFailure(
  core: Core,
  organizationId: string,
  hopId: string,
  now: Date,
): Promise<void> {
  await core.db.withTenant({ organizationId, userId: null }, async (tx) => {
    const [hop] = await tx
      .update(agentChainHops)
      .set({ tickAttempts: sql`${agentChainHops.tickAttempts} + 1`, updatedAt: sql`now()` })
      .where(and(eq(agentChainHops.id, hopId), eq(agentChainHops.status, "pending")))
      .returning();
    if (!hop) return;
    if (hop.tickAttempts < TICK_MAX_ATTEMPTS) {
      await tx
        .update(agentChainHops)
        .set({ deadlineAt: new Date(now.getTime() + backoffMs(hop.tickAttempts)).toISOString() })
        .where(eq(agentChainHops.id, hopId));
      return;
    }
    await tx
      .update(agentChainHops)
      .set({ status: "failed", refusalReason: "tick_error", closedAt: sql`now()` })
      .where(and(eq(agentChainHops.id, hopId), eq(agentChainHops.status, "pending")));
    const [chain] = await tx
      .select({ humanUserId: agentChains.humanUserId })
      .from(agentChains)
      .where(eq(agentChains.id, hop.chainId));
    await core.audit.record(tx, {
      action: "agent.consult.failed",
      resourceType: "agent_chain_hop",
      resourceId: hop.id,
      result: "error",
      actorKind: "system",
      agentId: hop.targetAgentId,
      userId: chain?.humanUserId ?? null,
      // Ids and the code only.
      metadata: {
        chainId: hop.chainId,
        hopId: hop.id,
        questionMessageId: hop.questionMessageId,
        sourceAgentId: hop.sourceAgentId,
        targetAgentId: hop.targetAgentId,
        reason: "tick_error",
        attempts: hop.tickAttempts,
      },
    });
  });
}

/**
 * One minute of consult timeouts (D-11). Safe to run on several replicas at once and twice in the same minute: the
 * stream lock, the row lock and the conditional update leave one outcome per hop. A failure on one hop is logged with
 * ids and the error name, counted with backoff and bounded (CR-A-08), and never stops the others.
 */
export async function sweepConsults(
  core: Core,
  deps: ConsultTickDeps,
  now: Date = new Date(),
  batch: number = TICK_BATCH,
): Promise<SweepResult> {
  const out: SweepResult = { timedOut: 0, cancelled: 0 };
  const expired = await core.db.pool.query<{ id: string; organization_id: string }>(
    "select id, organization_id from app.expired_agent_chain_hops($1, $2)",
    [batch, now.toISOString()],
  );
  for (const row of expired.rows) {
    try {
      const outcome = await expireHop(core, deps, row.organization_id, row.id, now);
      if (outcome === "timed_out") out.timedOut++;
      else if (outcome === "cancelled") out.cancelled++;
    } catch (err) {
      core.log.error(
        { hopId: row.id, organizationId: row.organization_id, err: { name: (err as Error)?.name } },
        "consult tick failed",
      );
      try {
        await recordTickFailure(core, row.organization_id, row.id, now);
      } catch (again) {
        core.log.error(
          { hopId: row.id, organizationId: row.organization_id, err: { name: (again as Error)?.name } },
          "consult tick could not record the failure",
        );
      }
    }
  }
  return out;
}

/**
 * The idle sweep (CR-A-06): a chain whose last pending thing was lost (the cell never sent a done: a skipped turn, a
 * lost report) still ends. The ids-only `app.idle_agent_chains` lists active chains with nothing pending and nothing
 * touched for `CHAIN_IDLE_MS`; each is completed in its own organization as the chain's human, under the thread's stream
 * and then the chain's row lock (the one lock order), by the done's own completion rule at the tick's clock (its turns
 * are by then older than the hop timeout, so taken as lost). Returns how many chains it completed.
 */
export async function closeIdleChains(
  core: Core,
  now: Date = new Date(),
  batch: number = TICK_BATCH,
): Promise<number> {
  const idle = await core.db.pool.query<{ id: string; organization_id: string }>(
    "select id, organization_id from app.idle_agent_chains($1, $2)",
    [batch, new Date(now.getTime() - CHAIN_IDLE_MS).toISOString()],
  );
  let completed = 0;
  for (const row of idle.rows) {
    try {
      const done = await core.db.withTenant(
        { organizationId: row.organization_id, userId: null },
        async (tx) => {
          const [chain] = await tx
            .select({ humanUserId: agentChains.humanUserId, conversationId: agentChains.conversationId })
            .from(agentChains)
            .where(eq(agentChains.id, row.id))
            .limit(1);
          if (!chain) return false;
          await lockNextSeq(tx, convTopic(chain.conversationId));
          await completeChain(tx, row.id, now);
          const [after] = await tx
            .select({ status: agentChains.status })
            .from(agentChains)
            .where(eq(agentChains.id, row.id));
          return after?.status === "completed";
        },
      );
      if (done) completed++;
    } catch (err) {
      core.log.error(
        { chainId: row.id, organizationId: row.organization_id, err: { name: (err as Error)?.name } },
        "consult tick: idle chain failed",
      );
    }
  }
  return completed;
}

/**
 * Wires the tick once (from the module factory, before `core.jobs` starts): the one-minute UTC cron, evaluated once
 * across replicas, and its worker (an empty payload: ids-only jobs, ADR-0028). Workers run only with
 * `OCW_JOBS_WORKER=on`; tests drive `sweepConsults` and `core.jobs.drain("consult.tick")`.
 */
export function registerConsultTick(core: Core, deps: ConsultTickDeps): void {
  core.jobs.schedule("consult.tick", "* * * * *");
  core.jobs.work("consult.tick", async () => {
    const out = await sweepConsults(core, deps);
    const idle = await closeIdleChains(core);
    if (out.timedOut + out.cancelled + idle > 0)
      core.log.info({ ...out, idleCompleted: idle }, "consult tick");
  });
}
