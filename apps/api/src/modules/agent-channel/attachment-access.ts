import { conversations, messages, type Tx } from "@ocw/db";
import { and, eq, isNull, or, type SQL, sql } from "drizzle-orm";
import { type AttachmentRow, attachmentRowsByIds } from "../artifact";
import type { AgentTurnRow } from "./claim";

/**
 * Phase 07.15 (D-16, D-10; PD-05): the one row rule for every bot access to a conversation file. A bot reads or
 * imports exactly the files its turn reads, and nothing else: `ocw_sandbox_import` (07.8-25) and `ocw_attachment_read`
 * (07.15-08) both decide the row with `attachmentForTurn`, so the two can never disagree. The history window a turn
 * is delivered (`buildMentionEvents` in mentions.ts) and this rule share one thread filter, `messageScopeFilter`.
 *
 * Everything here runs in the turn's transaction AS its human (RLS), after `liveTurn` checked that the human still
 * reads the turn's conversation (403 `no_trigger` otherwise). A file the turn does not read answers exactly like a
 * missing one (null → `not_found`), so a bot cannot probe for other people's files.
 *
 * Same rule and semantics as the D-16 hotfix's `importableAttachment` (PR #55, `fix/sandbox-import-attachment-scope`).
 */

/** DMs, group DMs and AI chats are one flat history: a turn there reads the whole conversation (D-04, D-06, P-10). */
const FLAT_KINDS: ReadonlySet<string> = new Set(["dm", "group", "ai_chat"]);
/** Conversation kinds a bot turn reads messages in; a Work Zone session's files are never a chat attachment. */
const TURN_KINDS: ReadonlySet<string> = new Set(["channel", "thread", ...FLAT_KINDS]);

/**
 * The messages a turn of `conv` reads: a DM, group DM or AI chat whole (flat, Pitfall 7); in a channel only the
 * thread of `root` (the root itself and its replies); a thread conversation's own messages besides. Moved verbatim
 * from `buildMentionEvents` (07.15-03), which builds the delivered history with it.
 */
export function messageScopeFilter(conv: { id: string; kind: string }, root: string): SQL {
  if (FLAT_KINDS.has(conv.kind)) return eq(messages.conversationId, conv.id);
  return (
    or(
      eq(messages.id, root),
      eq(messages.threadId, root),
      ...(conv.kind === "thread" ? [eq(messages.conversationId, conv.id)] : []),
    ) ?? sql`false`
  );
}

/**
 * The turn's conversation and its thread root: the root of the turn's own message (`agent_turns.message_id` →
 * `messages.thread_id ?? messages.id`), the same root the delivery's history used. Null when the conversation or that
 * message is not visible in this transaction (or the message belongs to another conversation). No stored column.
 */
export async function turnThreadRoot(
  tx: Tx,
  turn: Pick<AgentTurnRow, "conversationId" | "messageId">,
): Promise<{ conv: { id: string; kind: string }; root: string } | null> {
  const [conv] = await tx
    .select({ id: conversations.id, kind: conversations.kind })
    .from(conversations)
    .where(eq(conversations.id, turn.conversationId))
    .limit(1);
  if (!conv) return null;
  const [trigger] = await tx
    .select({ id: messages.id, threadId: messages.threadId })
    .from(messages)
    .where(and(eq(messages.id, turn.messageId), eq(messages.conversationId, turn.conversationId)))
    .limit(1);
  if (!trigger) return null;
  return { conv, root: trigger.threadId ?? trigger.id };
}

/**
 * The attachment this turn may touch, or null for every failure (the caller answers `not_found`):
 * - present under RLS, of the turn's own conversation, `ready` (never a `pending` upload nobody can read yet);
 * - sent with a message (never an upload still waiting in someone's composer) and never a Work Zone prompt's image;
 * - that message present and live (a tombstone decides, whatever the file's own status says), in the turn's
 *   conversation;
 * - in a channel, that message inside the turn's thread (`messageScopeFilter` with `turnThreadRoot`); a DM, group
 *   DM, AI chat or thread conversation is read whole, so an earlier message's file there is the turn's too.
 */
export async function attachmentForTurn(
  tx: Tx,
  turn: Pick<AgentTurnRow, "conversationId" | "messageId">,
  attachmentId: string,
): Promise<AttachmentRow | null> {
  const [row] = await attachmentRowsByIds(tx, [attachmentId]);
  if (!row || row.conversationId !== turn.conversationId || row.status !== "ready") return null;
  if (row.messageId === null || row.workPromptId !== null) return null;
  const [conv] = await tx
    .select({ id: conversations.id, kind: conversations.kind })
    .from(conversations)
    .where(eq(conversations.id, turn.conversationId))
    .limit(1);
  if (!conv || !TURN_KINDS.has(conv.kind)) return null;
  // A channel turn reads only its thread; every other kind is read whole (its scope is the conversation).
  let scope: SQL = eq(messages.conversationId, conv.id);
  if (conv.kind === "channel") {
    const thread = await turnThreadRoot(tx, turn);
    if (!thread) return null;
    scope = messageScopeFilter(thread.conv, thread.root);
  }
  const [carrier] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.id, row.messageId),
        eq(messages.conversationId, turn.conversationId),
        isNull(messages.deletedAt),
        scope,
      ),
    )
    .limit(1);
  return carrier ? row : null;
}
