import type { AgentCardStatus, BrowserEndReason, BrowserSignInStatus } from "@ocw/contracts";
import { browserSigninRequests, messageCards, type Tx } from "@ocw/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { announceCardMessage } from "../chat";

/**
 * The sign-in card's row follows its request (07.8-21, UI-SPEC Surface 2): the status pill and `message.updated` to
 * every reader. Kept apart from `signin.ts` so `contexts.ts` can stop the sign-ins of a page that ended without an
 * import cycle.
 */

type Request = typeof browserSigninRequests.$inferSelect;

/** The card's status pill per sign-in state (UI-SPEC Surface 2, Card states). */
export function cardStatusOf(status: BrowserSignInStatus): AgentCardStatus {
  switch (status) {
    case "waiting":
      return "pending";
    case "signing_in":
      return "running";
    case "signed_in":
      return "succeeded";
    default:
      return "cancelled";
  }
}

/** The card follows the request: its status pill, a version bump and `message.updated` to every reader. */
export async function syncCard(
  tx: Tx,
  core: Pick<Core, "realtime">,
  r: Request,
  status: BrowserSignInStatus,
) {
  if (!r.cardMessageId) return;
  await tx
    .update(messageCards)
    .set({
      status: cardStatusOf(status),
      version: sql`${messageCards.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(messageCards.messageId, r.cardMessageId), eq(messageCards.platformOwned, true)));
  await announceCardMessage(tx, core, r.cardMessageId);
}

/**
 * The page ended before anyone signed in (kill switch, module off, crash, idle, the bot's close): its waiting sign-in
 * reads "Stopped" with the reason. Nothing is sealed and no turn is delivered (nobody decided).
 */
export async function stopSignIns(
  tx: Tx,
  core: Pick<Core, "realtime" | "audit">,
  p: { contextId: string; reason: BrowserEndReason },
): Promise<void> {
  const rows = await tx
    .update(browserSigninRequests)
    .set({ status: "stopped", stopReason: p.reason, decidedAt: new Date().toISOString() })
    .where(
      and(
        eq(browserSigninRequests.contextId, p.contextId),
        inArray(browserSigninRequests.status, ["waiting", "signing_in"]),
      ),
    )
    .returning();
  for (const r of rows) {
    await syncCard(tx, core, r, "stopped");
    await core.audit.record(tx, {
      action: "browser.signin_decided",
      actorKind: "system",
      agentId: r.agentId,
      userId: r.requesterUserId,
      resourceType: "browser_context",
      resourceId: r.contextId,
      metadata: {
        requestId: r.id,
        contextId: r.contextId,
        host: r.host,
        outcome: "stopped",
        reason: p.reason,
      },
    });
  }
}
