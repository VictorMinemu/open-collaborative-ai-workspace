import { messageCardFollows, messageCards, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { Core } from "../../core";
import {
  type ConversationAccess,
  createConversationAccess,
  type PlatformCardUpdate,
  updatePlatformCard,
} from "../chat";
import { notifyUsers } from "../notification";

/**
 * A card's followers hear about its status changes (06-13, `card_updated`), whoever changed it: the agent's own patch
 * (`cards.ts`) and the server's update of a platform-owned card (07.6 review LO-03: a run card's "Done", "No reply" or
 * skip reason). Only status changes notify; the actor is the card's agent.
 */
export async function notifyCardFollowers(
  tx: Tx,
  deps: { core: Core; access: ConversationAccess },
  p: { conversationId: string; messageId: string; agentId: string },
): Promise<void> {
  const followers = await tx
    .select({ userId: messageCardFollows.userId })
    .from(messageCardFollows)
    .where(eq(messageCardFollows.messageId, p.messageId));
  await notifyUsers(tx, deps, {
    kind: "card_updated",
    conversationId: p.conversationId,
    messageId: p.messageId,
    actor: { kind: "agent", id: p.agentId },
    userIds: followers.map((f) => f.userId),
  });
}

/**
 * `updatePlatformCard` (chat) plus the followers' notification when the status changes, in the caller's transaction.
 * The card row is locked first, so the status compared is the one the update replaces.
 */
export async function updatePlatformCardNotified(
  tx: Tx,
  core: Core,
  p: { messageId: string } & PlatformCardUpdate,
): Promise<{ version: number } | null> {
  const [before] = await tx
    .select({
      status: messageCards.status,
      agentId: messageCards.agentId,
      conversationId: messageCards.conversationId,
    })
    .from(messageCards)
    .where(eq(messageCards.messageId, p.messageId))
    .limit(1)
    .for("update");
  const out = await updatePlatformCard(tx, core, p);
  if (out && before && p.status !== undefined && p.status !== before.status) {
    await notifyCardFollowers(
      tx,
      { core, access: createConversationAccess(core) },
      {
        conversationId: before.conversationId,
        messageId: p.messageId,
        agentId: before.agentId,
      },
    );
  }
  return out;
}
