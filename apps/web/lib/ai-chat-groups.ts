import type { AiChatSummary } from "@ocw/contracts";

/** The /chat/ai list's date groups (05-10), in the member's local time. */
export type AiChatGroupKey = "today" | "week" | "older";

export interface AiChatGroup {
  key: AiChatGroupKey;
  label: string;
  chats: AiChatSummary[];
}

const LABELS: Record<AiChatGroupKey, string> = {
  today: "Today",
  week: "Previous 7 days",
  older: "Older",
};

/**
 * Groups chats (already newest first) by their last activity: since local midnight → Today; the seven days before
 * it → Previous 7 days; anything earlier → Older. Empty groups are left out; the order inside a group is kept.
 */
export function groupAiChats(chats: readonly AiChatSummary[], now: number): AiChatGroup[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const week = new Date(today);
  week.setDate(week.getDate() - 7);
  const out: Record<AiChatGroupKey, AiChatSummary[]> = { today: [], week: [], older: [] };
  for (const c of chats) {
    const at = Date.parse(c.lastActivityAt);
    out[at >= today.getTime() ? "today" : at >= week.getTime() ? "week" : "older"].push(c);
  }
  return (Object.keys(LABELS) as AiChatGroupKey[])
    .filter((k) => out[k].length > 0)
    .map((k) => ({ key: k, label: LABELS[k], chats: out[k] }));
}
