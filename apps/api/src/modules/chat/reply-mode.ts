import { DEFAULT_CAPABILITIES, type Mention, ReplyMode } from "@ocw/contracts";
import { agents, conversationMembers, type Tx } from "@ocw/db";
import { and, eq, inArray } from "drizzle-orm";
import type { Directory } from "./directory";

/**
 * Reply mode `all` (D-12, BOT-04): a team bot set to answer every message follows the human conversation in
 * the channels it is a member of, without being mentioned. This file only selects candidates from stored data;
 * the org policy, the per-minute cap and the daily limit are decided at delivery (agent-channel mentions.ts).
 */

/** Automatic (reply-mode) replies allowed per bot per conversation per minute (T-03.1-08-01). */
export const REPLY_MODE_PER_MINUTE = 6;

/**
 * Team bots that are members of the conversation (or of its parent), live, not disabled and whose stored
 * reply mode is `all`. Empty when the author is not a human (no bot ↔ bot loops) or when the message mentions
 * any bot (the mentioned bot answers; the others stay silent). Sorted by id (stable lock order downstream).
 */
export async function replyModeCandidates(
  tx: Tx,
  dir: Directory,
  p: {
    conversationId: string;
    parentConversationId: string | null;
    authorKind: "user" | "agent";
    mentions: Mention[];
  },
): Promise<string[]> {
  if (p.authorKind !== "user") return [];
  if (p.mentions.some((m) => m.kind === "agent")) return [];
  const scope = [p.conversationId, ...(p.parentConversationId ? [p.parentConversationId] : [])];
  const members = await tx
    .select({ id: conversationMembers.memberId })
    .from(conversationMembers)
    .where(
      and(inArray(conversationMembers.conversationId, scope), eq(conversationMembers.memberKind, "agent")),
    );
  const live = [...new Set(members.map((m) => m.id))].filter((id) => {
    const a = dir.agents.get(id);
    // Personal bots never live in channels (D-01); disabled and deleted bots answer nobody.
    return a && !a.deleted && a.status !== "disabled" && a.scope === "team";
  });
  if (live.length === 0) return [];
  const rows = await tx
    .select({ id: agents.id, capabilities: agents.capabilities })
    .from(agents)
    .where(inArray(agents.id, live));
  return rows
    .filter((r) => storedReplyMode(r.capabilities) === "all")
    .map((r) => r.id)
    .sort();
}

/** The stored reply mode over the team default; anything invalid reads as the default. */
function storedReplyMode(capabilities: unknown): ReplyMode {
  const raw =
    capabilities && typeof capabilities === "object"
      ? (capabilities as Record<string, unknown>).replyMode
      : undefined;
  const parsed = ReplyMode.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_CAPABILITIES.team.replyMode;
}
