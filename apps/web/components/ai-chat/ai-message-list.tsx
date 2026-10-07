"use client";

import type { Message, SendAiMessageResponse } from "@ocw/contracts";
import { useStickToBottom } from "@/components/chat/use-stick-to-bottom";
import { AiMessage } from "./ai-message";

/**
 * The conversation column (P-09): centered, ~760 px, following the answer while the reader is at the bottom
 * (`useStickToBottom`, re-run on every streamed character). The column fades under the borderless header like the
 * Work Zone stream.
 */
export function AiMessageList({
  chatId,
  messages,
  textOf,
  onRegenerated,
  live = true,
}: {
  chatId: string;
  /** Streaming answers rendered now are live here (false while a fresh page only replays history). */
  live?: boolean;
  messages: Message[];
  textOf: (m: Message) => string;
  /** Applies a regenerate answered by the API (05-06). */
  onRegenerated?: (response: SendAiMessageResponse) => void;
}) {
  const streamed = messages.reduce((n, m) => n + (m.status === "streaming" ? textOf(m).length : 0), 0);
  const last = messages.at(-1);
  const writing = messages.some((m) => m.status === "streaming");
  // Only the chat's last answer can be regenerated, and only while nothing is being written (05-06).
  const regenerableId =
    onRegenerated && last?.authorKind === "agent" && last.status !== "streaming" ? last.id : null;
  const { ref, onScroll } = useStickToBottom(
    `${messages.length}:${last?.id ?? ""}:${last?.status ?? ""}:${streamed}`,
    chatId,
  );

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      data-testid="ai-message-list"
      // Screen readers hear new turns politely; a streaming answer is aria-busy, so it is read once, when done.
      role="log"
      aria-live="polite"
      aria-label="Conversation"
      className="scrollbar-thin min-h-0 flex-1 overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,black_16px)]"
    >
      <div className="mx-auto grid w-full max-w-3xl grid-cols-[minmax(0,1fr)] gap-7 px-4 pt-6 pb-8 sm:px-6 sm:pt-8">
        {messages.map((m) => (
          <AiMessage
            key={m.id}
            message={m}
            text={textOf(m)}
            live={live}
            last={m.id === last?.id}
            regenerate={
              onRegenerated && m.id === regenerableId
                ? { chatId, disabled: writing, onRegenerated }
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}
