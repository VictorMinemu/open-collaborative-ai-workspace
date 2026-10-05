import { BUILTIN_TOOLS, MAX_TOOL_CALLS_PER_TURN, type MemoryItem } from "@ocw/contracts";
import { agentMemories, agentTurns, type Tx, tenantOf } from "@ocw/db";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { Core } from "../../core";
import type { PermissionService } from "../organization";
import { currentTurnTools } from "./turn-policy";

/**
 * A bot's memory of one human (D-10, BOT-04, SC5). Stored per (bot, human) in `agent_memories`, written only
 * through the cell's own tool `ocw_memory_save` in that human's DM with the bot, read only into that human's
 * DM turns, listed and cleared only by that human. Never readable by admins or other members.
 *
 * Trust: the owner of a note is ALWAYS the human of the stored delivery (`agent_turns.user_id`), never
 * anything the model sends. Untrusted content (web or tool output) taints the turn; a tainted turn can no
 * longer write memory (D-08 taint rule). Audits carry lengths and counts, never the text (T-03.1-07-05).
 */

/** Notes kept per (bot, human); the oldest are pruned beyond it (T-03.1-07-06). */
export const MEMORY_CAP = 200;
/** Newest notes injected into one turn (`TurnContext.memory` max). */
export const TURN_MEMORY_LIMIT = 50;

export type MemoryRefusal =
  | "unknown_turn"
  | "dm_only"
  | "not_in_turn"
  | "memory_off"
  | "tainted"
  | "cap_reached";

export type SaveMemoryResult = { memoryId: string; created: boolean } | { refused: MemoryRefusal };

const toItem = (r: { id: string; text: string; createdAt: string | Date }): MemoryItem => ({
  id: r.id,
  text: r.text,
  createdAt: new Date(r.createdAt).toISOString(),
});

const owned = (agentId: string, userId: string) =>
  and(eq(agentMemories.agentId, agentId), eq(agentMemories.userId, userId));

/** Every note this bot keeps about this human, newest first. */
export async function listMemories(tx: Tx, agentId: string, userId: string): Promise<MemoryItem[]> {
  const rows = await tx
    .select({ id: agentMemories.id, text: agentMemories.text, createdAt: agentMemories.createdAt })
    .from(agentMemories)
    .where(owned(agentId, userId))
    .orderBy(desc(agentMemories.createdAt), desc(agentMemories.id));
  return rows.map(toItem);
}

/** Deletes one note (`memoryId`) or all of them; returns how many were deleted. Scoped to the owner. */
export async function clearMemories(
  tx: Tx,
  agentId: string,
  userId: string,
  memoryId?: string,
): Promise<number> {
  const rows = await tx
    .delete(agentMemories)
    .where(memoryId ? and(owned(agentId, userId), eq(agentMemories.id, memoryId)) : owned(agentId, userId))
    .returning({ id: agentMemories.id });
  return rows.length;
}

/** The newest `TURN_MEMORY_LIMIT` notes, oldest first (the order the model reads them in). */
export async function loadTurnMemory(tx: Tx, agentId: string, userId: string): Promise<MemoryItem[]> {
  const rows = await tx
    .select({ id: agentMemories.id, text: agentMemories.text, createdAt: agentMemories.createdAt })
    .from(agentMemories)
    .where(owned(agentId, userId))
    .orderBy(desc(agentMemories.createdAt), desc(agentMemories.id))
    .limit(TURN_MEMORY_LIMIT);
  return rows.reverse().map(toItem);
}

/**
 * Saves a note for the human of the delivered turn `eventId`. Checks, in order: the turn exists and belongs
 * to this bot (`unknown_turn`), it is a DM (`dm_only`), the turn offered the tool (`not_in_turn`), memory is
 * still effective now (`memory_off`), then ONE conditional UPDATE of the turn counts the call unless the turn
 * is tainted (`tainted`) or at its tool cap (`cap_reached`). Saves of one owner are serialised (advisory
 * lock), so dedupe and pruning are exact. Every outcome is audited without the text.
 */
export async function saveMemory(
  tx: Tx,
  core: Core,
  perms: PermissionService,
  p: { eventId: string; agentId: string; text: string },
): Promise<SaveMemoryResult> {
  const text = p.text.trim();
  const chars = text.length;
  const [turn] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, p.eventId));

  const refuse = async (reason: MemoryRefusal): Promise<SaveMemoryResult> => {
    const known = turn && turn.agentId === p.agentId;
    await core.audit.record(tx, {
      action: "agent.memory_saved",
      resourceType: "agent",
      resourceId: known ? turn.agentId : null,
      result: "denied",
      actorKind: known ? "agent" : "system",
      actorId: known ? turn.agentId : null,
      agentId: known ? turn.agentId : null,
      userId: known ? turn.userId : null,
      clientKind: "agent",
      metadata: { reason, chars },
    });
    return { refused: reason };
  };

  // Unknown (or another organization's: RLS hides it) or another bot's delivery.
  if (!turn || turn.agentId !== p.agentId) return refuse("unknown_turn");
  if (turn.conversationKind !== "dm") return refuse("dm_only");
  if (!turn.tools.includes(BUILTIN_TOOLS.memorySave)) return refuse("not_in_turn");
  const now = await currentTurnTools(
    tx,
    perms,
    { agentId: turn.agentId, humanUserId: turn.userId, conversationKind: turn.conversationKind },
    core.env,
  );
  if (!now.tools.includes(BUILTIN_TOOLS.memorySave)) return refuse("memory_off");

  // Count the call and check the taint in one statement: a web call authorised concurrently on the same
  // turn either lands first (the save is refused) or after (the save already happened before any untrusted
  // content was read).
  const counted = await tx
    .update(agentTurns)
    .set({ toolCalls: sql`${agentTurns.toolCalls} + 1` })
    .where(
      and(
        eq(agentTurns.eventId, turn.eventId),
        eq(agentTurns.tainted, false),
        lt(agentTurns.toolCalls, MAX_TOOL_CALLS_PER_TURN),
      ),
    )
    .returning({ eventId: agentTurns.eventId });
  if (counted.length === 0) {
    const [after] = await tx
      .select({ tainted: agentTurns.tainted })
      .from(agentTurns)
      .where(eq(agentTurns.eventId, turn.eventId));
    return refuse(after?.tainted ? "tainted" : "cap_reached");
  }

  // The owner is the human the turn was delivered to. Serialise this owner's saves.
  const owner = turn.userId;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`memory:${turn.agentId}:${owner}`}, 0))`,
  );
  const [existing] = await tx
    .select({ id: agentMemories.id })
    .from(agentMemories)
    .where(and(owned(turn.agentId, owner), eq(agentMemories.text, text)))
    .limit(1);
  let memoryId: string;
  let created = false;
  if (existing) {
    memoryId = existing.id;
  } else {
    const [row] = await tx
      .insert(agentMemories)
      .values({
        organizationId: tenantOf(tx).organizationId,
        agentId: turn.agentId,
        userId: owner,
        text,
        sourceEventId: turn.eventId,
      })
      .returning({ id: agentMemories.id });
    if (!row) throw new Error("agent_memories insert failed");
    memoryId = row.id;
    created = true;
    // Keep the newest MEMORY_CAP notes of this (bot, human); the oldest go first.
    const keep = tx
      .select({ id: agentMemories.id })
      .from(agentMemories)
      .where(owned(turn.agentId, owner))
      .orderBy(desc(agentMemories.createdAt), desc(agentMemories.id))
      .limit(MEMORY_CAP);
    await tx
      .delete(agentMemories)
      .where(and(owned(turn.agentId, owner), sql`${agentMemories.id} not in (${keep})`));
  }

  await core.audit.record(tx, {
    action: "agent.memory_saved",
    resourceType: "agent",
    resourceId: turn.agentId,
    actorKind: "agent",
    actorId: turn.agentId,
    agentId: turn.agentId,
    userId: owner,
    clientKind: "agent",
    metadata: { chars, created, conversationId: turn.conversationId },
  });
  return { memoryId, created };
}
