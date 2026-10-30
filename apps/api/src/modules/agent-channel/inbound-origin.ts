import { automationEvents, automationRuns, type Tx } from "@ocw/db";
import { and, eq, inArray, or } from "drizzle-orm";

/**
 * Phase 07.6 (D-02, D-07, P-11, Pitfall 3): whether outside content is the root of a thread, or among the other messages
 * a turn reads. Inbound content is what the platform posted for a webhook or mail item (`automation_events.message_id`),
 * the board card it filed one as (`automation_events.board_card_message_id`), and the anchor of a run that started
 * tainted (`automation_runs.tainted`: the bot's answer there was written from outside text). A turn that reads any of
 * them starts tainted, so a person asking the bot in such a thread never gets a side-effecting turn whose history holds
 * injected text. Ids only; RLS keeps both tables to the transaction's organization. A leaf module, so the mention
 * delivery and the run delivery share it without an import cycle (`automation-runs.ts` re-exports it).
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
    .where(or(inArray(automationEvents.messageId, ids), inArray(automationEvents.boardCardMessageId, ids)))
    .limit(1);
  if (event) return true;
  const [run] = await tx
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .where(and(eq(automationRuns.tainted, true), inArray(automationRuns.anchorMessageId, ids)))
    .limit(1);
  return run !== undefined;
}
