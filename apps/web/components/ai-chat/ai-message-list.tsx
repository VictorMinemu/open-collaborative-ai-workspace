"use client";

import type { Message } from "@ocw/contracts";
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
}: {
  chatId: string;
  messages: Message[];
  textOf: (m: Message) => string;
}) {
  const streamed = messages.reduce((n, m) => n + (m.status === "streaming" ? textOf(m).length : 0), 0);
  const last = messages.at(-1);
  const { ref, onScroll } = useStickToBottom(
    `${messages.length}:${last?.id ?? ""}:${last?.status ?? ""}:${streamed}`,
    chatId,
  );

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      data-testid="ai-message-list"
      className="scrollbar-thin min-h-0 flex-1 overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,black_16px)]"
    >
      <div className="mx-auto grid w-full max-w-3xl grid-cols-[minmax(0,1fr)] gap-7 px-4 pt-6 pb-8 sm:px-6 sm:pt-8">
        {messages.map((m) => (
          <AiMessage key={m.id} message={m} text={textOf(m)} />
        ))}
      </div>
    </div>
  );
}
