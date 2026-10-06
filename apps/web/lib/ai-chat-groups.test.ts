import type { AiChatSummary } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { groupAiChats } from "./ai-chat-groups";

const chat = (id: string, lastActivityAt: string): AiChatSummary => ({
  id,
  title: id,
  titleSource: "heuristic",
  lastModel: null,
  lastModelLabel: null,
  archived: false,
  generating: false,
  createdAt: lastActivityAt,
  lastActivityAt,
});

/** Local-time instants (the list groups by the member's own day). */
const local = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h, 0, 0).toISOString();

describe("groupAiChats (Today / Previous 7 days / Older, local time)", () => {
  const now = new Date(2026, 9, 6, 9, 30).getTime();

  it("splits on the member's local midnight and seven days before it, keeping the list order", () => {
    const groups = groupAiChats(
      [
        chat("a", local(2026, 10, 6, 8)),
        chat("b", local(2026, 10, 6, 0)),
        chat("c", local(2026, 10, 5, 23)),
        chat("d", local(2026, 9, 29, 1)),
        chat("e", local(2026, 9, 28, 23)),
        chat("f", local(2025, 1, 1)),
      ],
      now,
    );
    expect(groups.map((g) => [g.key, g.label, g.chats.map((c) => c.id)])).toEqual([
      ["today", "Today", ["a", "b"]],
      ["week", "Previous 7 days", ["c", "d"]],
      ["older", "Older", ["e", "f"]],
    ]);
  });

  it("omits empty groups; a future time (clock skew) counts as today", () => {
    const groups = groupAiChats([chat("x", local(2026, 10, 7, 10)), chat("y", local(2026, 1, 1))], now);
    expect(groups.map((g) => g.key)).toEqual(["today", "older"]);
    expect(groupAiChats([], now)).toEqual([]);
  });
});
