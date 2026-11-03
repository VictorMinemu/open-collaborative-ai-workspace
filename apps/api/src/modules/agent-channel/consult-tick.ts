import { agentChainHops, agentChains } from "@ocw/db";
import { and, eq, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { announceConsults, convTopic, lockNextSeq } from "../chat";
import { cancelChain, chainLive, completeChain, deliverConsultReply } from "./chains";
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
 */

/** Hops per tick; the rest wait for the next minute (oldest deadline first). */
const TICK_BATCH = 500;

export type ConsultTickDeps = Omit<ConsultDeps, "core">;

export interface SweepResult {
  timedOut: number;
  cancelled: number;
}

type Outcome = "timed_out" | "cancelled" | null;

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

/**
 * One minute of consult timeouts (D-11). Safe to run on several replicas at once and twice in the same minute: the
 * stream lock, the row lock and the conditional update leave one outcome per hop. A failure on one hop is logged with
 * ids and the error name and never stops the others.
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
      core.log.warn(
        { hopId: row.id, organizationId: row.organization_id, err: { name: (err as Error)?.name } },
        "consult tick failed",
      );
    }
  }
  return out;
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
    if (out.timedOut + out.cancelled > 0) core.log.info(out, "consult tick");
  });
}
