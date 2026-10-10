import { messages, type Tx } from "@ocw/db";
import { and, eq } from "drizzle-orm";
import type { Core } from "../../core";
import { HttpError } from "../../lib/errors";

/** One `@channel` / `@here` per channel per minute (P-11). */
export const MENTION_ALL_WINDOW_MS = 60_000;

/**
 * The 1-per-minute gate of `@channel` / `@here` in one channel (P-11, T-04-09-02), claimed before the insert:
 * `SET NX PX` in Redis, so every API instance shares it. A refused claim is 429 `mention_all_rate_limited`. Shared by
 * the message route and board cards (07.1-03), so a card cannot bypass it.
 */
export async function claimMentionAll(core: Core, conversationId: string): Promise<void> {
  const claimed = await core.bus.pub.set(`ocw:mention_all:${conversationId}`, "1", {
    condition: "NX",
    expiration: { type: "PX", value: MENTION_ALL_WINDOW_MS },
  });
  if (claimed !== "OK") {
    throw new HttpError(
      429,
      "mention_all_rate_limited",
      "You can send at most one @channel or @here per minute in this channel",
    );
  }
}

/** A client retry of a message already posted (same author and clientMessageId) answers it, not the limit. */
export async function isOwnRetry(tx: Tx, userId: string, clientMessageId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.authorKind, "user"),
        eq(messages.authorId, userId),
        eq(messages.clientMessageId, clientMessageId),
      ),
    )
    .limit(1);
  return row !== undefined;
}
