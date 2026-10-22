import { ActivityStep, type BotTurnActivity, type Message } from "@ocw/contracts";
import { agentTurns, botTurnActivity, browserContexts, orgMembers, type Tx } from "@ocw/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

/**
 * A bot reply's turn activity (07.8-10; R2, UI-SPEC Surface 5). The agent-channel module composes and masks the steps
 * and attaches them to the turn's first reply (`bot_turn_activity.reply_message_id`); chat only adds them to message
 * DTOs, viewer-agnostic, so every reader of the reply (REST snapshots and the reply's `message.created`) sees the same
 * activity. Tombstones and human messages carry none. One query for the whole list.
 */

const StoredSteps = z.array(ActivityStep).catch([]);

export async function activityFor(tx: Tx, messageIds: string[]): Promise<Map<string, BotTurnActivity>> {
  const out = new Map<string, BotTurnActivity>();
  if (messageIds.length === 0) return out;
  const rows = await tx
    .select({ row: botTurnActivity, userId: agentTurns.userId, name: orgMembers.displayName })
    .from(botTurnActivity)
    .leftJoin(agentTurns, eq(agentTurns.eventId, botTurnActivity.eventId))
    .leftJoin(orgMembers, eq(orgMembers.userId, agentTurns.userId))
    .where(inArray(botTurnActivity.replyMessageId, messageIds));
  const parsed = rows.map(({ row, userId, name }) => ({
    row,
    userId,
    name,
    steps: StoredSteps.parse(row.steps),
  }));
  const open = await openContexts(
    tx,
    parsed.flatMap((p) => p.steps.map((step) => step.contextId)),
  );
  for (const { row, userId, name, steps } of parsed) {
    if (!row.replyMessageId) continue;
    out.set(row.replyMessageId, {
      eventId: row.eventId,
      // Stored steps were built against the contract; anything else is dropped rather than shown.
      // 07.8-22: a step with a page says whether it is still open (the reader's `Watch`); computed here, never stored.
      steps: steps.map((step) =>
        step.contextId ? { ...step, contextOpen: open.has(step.contextId) } : step,
      ),
      more: row.more,
      running: row.running,
      current: null,
      // WINDOWS #265 (07.8-21): the person the bot acted for ("Asked you" / "Asked Sam").
      requester: userId ? { id: userId, displayName: (name ?? "Former member").slice(0, 200) } : null,
    });
  }
  return out;
}

/** Which of these browser contexts are still open (the caller's tenant; one query). */
async function openContexts(tx: Tx, ids: Array<string | null>): Promise<Set<string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Set();
  const rows = await tx
    .select({ id: browserContexts.id })
    .from(browserContexts)
    .where(and(inArray(browserContexts.id, wanted), isNull(browserContexts.closedAt)));
  return new Set(rows.map((r) => r.id));
}

/** Adds `activity` to the agent replies among `list` that have a turn activity attached. */
export async function withActivity(tx: Tx, list: Message[]): Promise<Message[]> {
  const ids = list.filter((m) => m.authorKind === "agent" && !m.deletedAt).map((m) => m.id);
  const found = await activityFor(tx, ids);
  if (found.size === 0) return list;
  return list.map((m) => {
    const activity = m.deletedAt ? undefined : found.get(m.id);
    return activity ? { ...m, activity } : m;
  });
}
