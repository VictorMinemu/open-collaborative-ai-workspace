import type { AiChatList, AiChatSummary } from "@ocw/contracts";
import { type InfiniteData, QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { aiKeys, applyAiChatUpdated } from "./ai-chat-queries";

/**
 * 06-03: `ai_chat.updated` reaches the viewer's `user:` topic for their own chats and for chats shared with them.
 * Shared ones go to "Shared with me" only, never to the member's own list (Phase 5 owners are unchanged).
 */

const chat = (id: string, at: string, extra: Partial<AiChatSummary> = {}): AiChatSummary => ({
  id,
  title: id,
  titleSource: "heuristic",
  lastModel: null,
  lastModelLabel: null,
  archived: false,
  generating: false,
  createdAt: at,
  lastActivityAt: at,
  ...extra,
});

type Data = InfiniteData<AiChatList, string | null>;
const page = (...chats: AiChatSummary[]): Data => ({
  pages: [{ chats, nextCursor: null }],
  pageParams: [null],
});
const ids = (qc: QueryClient, key: readonly unknown[]) =>
  qc
    .getQueryData<Data>(key)
    ?.pages.flatMap((p) => p.chats)
    .map((c) => c.id);

const OWNER = {
  kind: "user" as const,
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Víctor Ruiz",
};

function seeded() {
  const qc = new QueryClient();
  qc.setQueryData(aiKeys.list(false), page(chat("mine-1", "2026-10-07T09:00:00.000Z")));
  qc.setQueryData(aiKeys.list(true), page());
  qc.setQueryData(aiKeys.shared, page());
  return qc;
}

describe("applyAiChatUpdated routes shared chats to “Shared with me”", () => {
  it("a chat shared with the viewer (access chat or view) lands in the shared list only", () => {
    const qc = seeded();
    applyAiChatUpdated(
      qc,
      chat("shared-1", "2026-10-07T10:00:00.000Z", { access: "chat", owner: OWNER, shared: true }),
    );
    applyAiChatUpdated(
      qc,
      chat("shared-2", "2026-10-07T11:00:00.000Z", { access: "view", owner: OWNER, shared: true }),
    );
    expect(ids(qc, aiKeys.shared)).toEqual(["shared-2", "shared-1"]);
    expect(ids(qc, aiKeys.list(false))).toEqual(["mine-1"]);
    expect(ids(qc, aiKeys.list(true))).toEqual([]);
  });

  it("the owner's own chats (access owner, or absent as in Phase 5) stay in the member's list", () => {
    const qc = seeded();
    applyAiChatUpdated(qc, chat("mine-2", "2026-10-07T10:00:00.000Z", { access: "owner", shared: true }));
    applyAiChatUpdated(qc, chat("mine-3", "2026-10-07T11:00:00.000Z"));
    expect(ids(qc, aiKeys.list(false))).toEqual(["mine-3", "mine-2", "mine-1"]);
    expect(ids(qc, aiKeys.shared)).toEqual([]);
  });

  it("an archived shared chat leaves the shared list and never enters the member's archive", () => {
    const qc = seeded();
    const shared = chat("shared-1", "2026-10-07T10:00:00.000Z", {
      access: "chat",
      owner: OWNER,
      shared: true,
    });
    applyAiChatUpdated(qc, shared);
    applyAiChatUpdated(qc, { ...shared, archived: true });
    expect(ids(qc, aiKeys.shared)).toEqual([]);
    expect(ids(qc, aiKeys.list(true))).toEqual([]);
  });
});
