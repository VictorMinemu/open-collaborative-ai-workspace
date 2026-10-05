import type { AgentScope, BotCapabilities, BotPolicy, BotUsage } from "@ocw/contracts";
import { agentLimitNotices, agentUsageDaily, type Tx, tenantOf } from "@ocw/db";
import { and, eq, inArray, sql } from "drizzle-orm";

/**
 * Daily usage limits (D-11, BOT-07). A bot's turns are counted per UTC day at delivery time, inside the
 * message transaction, with ONE conditional upsert: there is no read-then-write anywhere, so concurrent
 * messages can never push a bot past its limit (T-03.1-05-01).
 */

/** The UTC date a turn counts in, `YYYY-MM-DD`. */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The next 00:00Z strictly after `now`, ISO: when today's counter stops applying. */
export function nextResetAt(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

/**
 * The limit that applies today: the bot's own `dailyLimit`, capped for personal bots by the organization's
 * `personalDailyLimitMax` (an admin lowering the cap bites at once, without rewriting every bot).
 */
export function effectiveDailyLimit(
  scope: AgentScope,
  caps: Pick<BotCapabilities, "dailyLimit">,
  policy: Pick<BotPolicy, "personalDailyLimitMax">,
): number {
  return scope === "personal" ? Math.min(caps.dailyLimit, policy.personalDailyLimitMax) : caps.dailyLimit;
}

/**
 * Counts one turn for `agentId` today, unless today's count already reached `limit`. Postgres row-locks the
 * conflicting row for the `do update`, and re-evaluates the `where` against the latest committed value, so
 * concurrent callers serialise on the row and exactly `limit` of them succeed.
 */
export async function consumeTurn(
  tx: Tx,
  agentId: string,
  limit: number,
  now = new Date(),
): Promise<{ ok: true; turns: number } | { ok: false }> {
  const { organizationId } = tenantOf(tx);
  // One statement: insert … on conflict do update … where turns < limit returning turns.
  const rows = await tx
    .insert(agentUsageDaily)
    .values({ organizationId, agentId, day: utcDay(now), turns: 1 })
    .onConflictDoUpdate({
      target: [agentUsageDaily.organizationId, agentUsageDaily.agentId, agentUsageDaily.day],
      set: { turns: sql`${agentUsageDaily.turns} + 1` },
      setWhere: sql`${agentUsageDaily.turns} < ${limit}`,
    })
    .returning({ turns: agentUsageDaily.turns });
  const [row] = rows;
  // A fresh insert of 1 with a limit below 1 cannot happen (limits are ≥ 1 by contract).
  return row ? { ok: true, turns: row.turns } : { ok: false };
}

/** Turns counted today (UTC) per bot. */
export async function turnsToday(tx: Tx, agentIds?: readonly string[], now = new Date()) {
  if (agentIds && agentIds.length === 0) return new Map<string, number>();
  const rows = await tx
    .select({ agentId: agentUsageDaily.agentId, turns: agentUsageDaily.turns })
    .from(agentUsageDaily)
    .where(
      and(
        eq(agentUsageDaily.day, utcDay(now)),
        ...(agentIds ? [inArray(agentUsageDaily.agentId, [...agentIds])] : []),
      ),
    );
  return new Map(rows.map((r) => [r.agentId, r.turns]));
}

/** Today's usage of one bot against its limit, with the reset time (what owners and admins see). */
export async function usageOf(tx: Tx, agentId: string, limit: number, now = new Date()): Promise<BotUsage> {
  const today = (await turnsToday(tx, [agentId], now)).get(agentId) ?? 0;
  return { today, limit, resetsAt: nextResetAt(now) };
}

/**
 * Claims today's limit notice for (bot, conversation): true for the first caller of the day only, so a busy
 * channel sees the notice once (T-03.1-05-03). Insert-or-nothing, race-free like the counter.
 */
export async function claimChannelNotice(
  tx: Tx,
  agentId: string,
  conversationId: string,
  now = new Date(),
): Promise<boolean> {
  const { organizationId } = tenantOf(tx);
  const rows = await tx
    .insert(agentLimitNotices)
    .values({ organizationId, agentId, conversationId, day: utcDay(now) })
    .onConflictDoNothing({
      target: [agentLimitNotices.agentId, agentLimitNotices.conversationId, agentLimitNotices.day],
    })
    .returning({ agentId: agentLimitNotices.agentId });
  return rows.length > 0;
}

/**
 * The notice a bot posts instead of replying once it reached its limit. It states only the bot's own limit
 * and the reset time, never anyone's usage (T-03.1-05-05).
 */
export function limitNotice(p: { botName: string; limit: number }): string {
  const replies = p.limit === 1 ? "reply" : "replies";
  return `I've reached my daily limit of ${p.limit} ${replies}, so I can't answer right now. I'll be back after 00:00 UTC.`;
}
