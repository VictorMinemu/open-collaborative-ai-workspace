import {
  agentTurns,
  automationConversations,
  automationEvents,
  automationRuns,
  automations,
  messages,
  type Tx,
} from "@ocw/db";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";

/**
 * Phase 07.6 (D-02, D-07, P-11, Pitfall 3): whether outside content is the root of a thread, or among the other messages
 * a turn reads. Inbound content is what the platform posted for a webhook or mail item (`automation_events.message_id`,
 * and its full-text reply, `full_message_id`), the board card it filed one as (`automation_events.board_card_message_id`),
 * and the anchor of a run that started
 * tainted (`automation_runs.tainted`: the bot's answer there was written from outside text). A turn that reads any of
 * them starts tainted, so a person asking the bot in such a thread never gets a side-effecting turn whose history holds
 * injected text. Ids only; RLS keeps both tables to the transaction's organization. A leaf module, so the mention
 * delivery and the run delivery share it without an import cycle (`automation-runs.ts` re-exports it).
 *
 * 07.17 PD-10: an opened root (`automation_conversations.root_message_id`) holds bot-written outside content (an item's
 * title and body, from a run that may have read an MCP), so it counts too: the item's own turn, a person's @mention and
 * a Work Zone wake in its thread all start tainted. The run log root is not included (run turns keep a clean start).
 */
export async function inboundRooted(
  tx: Tx,
  threadRootId: string,
  alsoMessageIds: readonly string[] = [],
): Promise<boolean> {
  const ids = [...new Set([threadRootId, ...alsoMessageIds])];
  const [event] = await tx
    .select({ id: automationEvents.id })
    .from(automationEvents)
    .where(
      or(
        inArray(automationEvents.messageId, ids),
        inArray(automationEvents.boardCardMessageId, ids),
        // The full-text reply after the card (07.6 review A LO-05): a window holding only it is inbound too.
        inArray(automationEvents.fullMessageId, ids),
      ),
    )
    .limit(1);
  if (event) return true;
  const [run] = await tx
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .where(and(eq(automationRuns.tainted, true), inArray(automationRuns.anchorMessageId, ids)))
    .limit(1);
  if (run) return true;
  const [opened] = await tx
    .select({ id: automationConversations.id })
    .from(automationConversations)
    .where(inArray(automationConversations.rootMessageId, ids))
    .limit(1);
  return opened !== undefined;
}

/**
 * 07.17 code review CR-01: whether a fan-out automation's run log thread holds outside content. Every run of such an
 * automation anchors in one long-lived "<name> · Runs" thread (D-10), so a run turn that read an MCP (its turn's
 * `agent_turns.tainted`, live: the taint a turn reaches after its start too) leaves a bot reply there that may echo item
 * titles or summaries. Once any run anchored in this thread had a tainted turn (or started tainted), a turn that reads
 * the thread (a person's @mention, reply mode) starts tainted. Fan-out run turns themselves read no history (they are
 * delivered with an empty window, `mentions.ts`), so they keep their clean start (ADR-0039 § 7). Only automations with a
 * run log are concerned: every other run anchor keeps the 07.6 rule of `inboundRooted`. Ids only.
 */
export async function runLogTainted(tx: Tx, threadRootId: string): Promise<boolean> {
  const [run] = await tx
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .innerJoin(messages, eq(messages.id, automationRuns.anchorMessageId))
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .leftJoin(agentTurns, eq(agentTurns.eventId, automationRuns.agentEventId))
    .where(
      and(
        eq(messages.threadId, threadRootId),
        isNotNull(automations.runLogMessageId),
        or(eq(automationRuns.tainted, true), eq(agentTurns.tainted, true)),
      ),
    )
    .limit(1);
  return run !== undefined;
}
