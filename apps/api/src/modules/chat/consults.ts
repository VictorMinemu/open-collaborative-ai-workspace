import { EventTypes, type Message, type MessageConsult } from "@ocw/contracts";
import { agentChainHops, agentChains, messages, type Tx } from "@ocw/db";
import { eq, inArray, or } from "drizzle-orm";
import type { Core } from "../../core";
import { withActivity } from "./activity";
import { cardMessageOf } from "./card-actions";
import { loadDirectory } from "./directory";
import { convTopic } from "./service";

/**
 * A consult hop's question and answer messages (Phase 07.7, D-15; ADR-0027). The agent-channel module owns the chain
 * ledger (`agent_chains`, `agent_chain_hops`); chat only adds `consult` to message DTOs, viewer-agnostic, the way
 * `withActivity` adds a bot reply's turn activity: every reader of the thread (REST snapshots, `message.created` and
 * every `message.updated` announced here) sees the same hop state. Tombstones carry none. One query for the whole list.
 */

export async function consultsFor(tx: Tx, messageIds: string[]): Promise<Map<string, MessageConsult>> {
  const out = new Map<string, MessageConsult>();
  if (messageIds.length === 0) return out;
  const rows = await tx
    .select({ hop: agentChainHops, human: agentChains.humanUserId })
    .from(agentChainHops)
    .innerJoin(agentChains, eq(agentChains.id, agentChainHops.chainId))
    .where(
      or(
        inArray(agentChainHops.questionMessageId, messageIds),
        inArray(agentChainHops.answerMessageId, messageIds),
      ),
    );
  for (const { hop, human } of rows) {
    const base = {
      chainId: hop.chainId,
      hopId: hop.id,
      sourceAgentId: hop.sourceAgentId,
      targetAgentId: hop.targetAgentId,
      onBehalfOfUserId: human,
      depth: hop.depth,
      mode: hop.mode,
      status: hop.status,
    } as const;
    if (messageIds.includes(hop.questionMessageId)) {
      out.set(hop.questionMessageId, { ...base, role: "question" } as MessageConsult);
    }
    if (hop.answerMessageId && messageIds.includes(hop.answerMessageId)) {
      out.set(hop.answerMessageId, { ...base, role: "answer" } as MessageConsult);
    }
  }
  return out;
}

/** Adds `consult` to the agent messages among `list` that are a hop's question or answer. */
export async function withConsults(tx: Tx, list: Message[]): Promise<Message[]> {
  const ids = list.filter((m) => m.authorKind === "agent" && !m.deletedAt).map((m) => m.id);
  const found = await consultsFor(tx, ids);
  if (found.size === 0) return list;
  return list.map((m) => {
    const consult = m.deletedAt ? undefined : found.get(m.id);
    return consult ? { ...m, consult } : m;
  });
}

/**
 * Announces a hop's status change on its messages (`message.updated` on `conv:<id>`, the `announceCardMessage` shape):
 * the realtime DTO (`cardMessageOf`, no viewer fields) with the turn activity and the consult state. A deleted message is
 * left out. Called by the agent-channel module after it changed a hop (chat never imports agent-channel).
 */
export async function announceConsults(
  tx: Tx,
  deps: Pick<Core, "realtime">,
  messageIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(messageIds)];
  if (ids.length === 0) return;
  const rows = await tx.select().from(messages).where(inArray(messages.id, ids));
  const dir = await loadDirectory(tx);
  for (const id of ids) {
    const row = rows.find((r) => r.id === id);
    if (!row || row.deletedAt) continue;
    const [dto] = await withConsults(tx, await withActivity(tx, [await cardMessageOf(tx, row, dir)]));
    if (!dto) continue;
    await deps.realtime.appendEvent(tx, convTopic(row.conversationId), EventTypes.messageUpdated, {
      message: dto,
    });
  }
}
