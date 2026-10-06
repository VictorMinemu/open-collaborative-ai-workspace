"use client";

import type { AiGeneration, Message } from "@ocw/contracts";
import { Check, Copy } from "lucide-react";
import { Markdown } from "@/components/markdown/markdown";
import { Tooltip } from "@/components/ui/tooltip";
import { useCopy } from "@/hooks/use-copy";
import { cn } from "@/lib/utils";
import { GenerationError, markStreamed } from "./generation-error";

/**
 * One turn of an AI chat (P-09): the member's turns are right-aligned bubbles; answers are full width through the
 * one shared Markdown renderer (no raw HTML, images as links, `safeUrl`), with a caret while they stream and a
 * quiet footer once done: `<model> · ChatGPT plan · <in> in · <out> out`. A failed answer keeps any partial text
 * and ends with a calm card instead of a spinner.
 */
export function AiMessage({ message, text }: { message: Message; text: string }) {
  if (message.authorKind !== "agent") {
    return (
      <div
        data-testid="ai-message"
        data-role="user"
        data-status={message.status}
        data-message-id={message.id}
        className="flex justify-end pl-10 sm:pl-24"
      >
        <div className="max-w-full whitespace-pre-wrap break-words rounded-[20px] bg-muted px-4 py-2.5 text-[15px] leading-6">
          {text}
        </div>
      </div>
    );
  }

  const streaming = message.status === "streaming";
  // A failure that follows a stream seen on this page arrived live (05-07: the usage-limit dialog opens once).
  if (streaming) markStreamed(message.id);
  return (
    <div
      data-testid="ai-message"
      data-role="assistant"
      data-status={message.status}
      data-message-id={message.id}
      className="group/answer grid min-w-0 gap-1.5"
    >
      <div data-testid="ai-message-text" className={text ? "min-w-0" : "hidden"}>
        {text ? (
          <Markdown text={text} variant="document" streaming={streaming} className="text-[15px] leading-7" />
        ) : null}
      </div>
      {message.status === "failed" ? (
        <GenerationError
          messageId={message.id}
          chatKey={message.conversationId}
          code={message.generation?.errorCode ?? null}
          param={message.generation?.errorParam ?? null}
        />
      ) : null}
      {streaming ? (
        <span
          data-testid="ai-streaming-caret"
          role="status"
          aria-label="Writing the answer"
          className="block size-3 animate-pulse rounded-full bg-foreground/80"
        />
      ) : (
        <AnswerFooter text={text} generation={message.generation} />
      )}
    </div>
  );
}

const count = (n: number) => n.toLocaleString("en-US");

const BACKEND_LABEL: Record<AiGeneration["backend"], string> = {
  chatgpt_plan: "ChatGPT plan",
  org_key: "METERED",
  mock: "not metered",
};

/** `GPT-6 Astra · ChatGPT plan · 1,204 in · 87 out` (estimated counts carry a "~"). */
export function footerLabel(g: AiGeneration): string {
  const parts = [g.modelLabel, BACKEND_LABEL[g.backend]];
  if (g.usage) {
    const approx = g.usage.estimated ? "~" : "";
    parts.push(`${approx}${count(g.usage.inputTokens)} in`, `${approx}${count(g.usage.outputTokens)} out`);
  }
  return parts.join(" · ");
}

function AnswerFooter({ text, generation }: { text: string; generation: AiGeneration | undefined }) {
  const { copy, copied } = useCopy();
  return (
    <div
      className={cn(
        "flex min-h-7 min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground",
        // The copy button's padding sits outside the text column, so the label lines up with the answer.
        text && "-ml-1.5",
      )}
    >
      {text ? (
        <Tooltip content={copied ? "Copied" : "Copy answer"}>
          <button
            type="button"
            data-testid="ai-copy-answer"
            aria-label="Copy answer"
            onClick={() => void copy(text)}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30"
          >
            {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
          </button>
        </Tooltip>
      ) : null}
      {generation ? (
        <span
          data-testid="ai-message-footer"
          title={generation.usage?.estimated ? "Token counts are estimated" : undefined}
          className="min-w-0 truncate tabular-nums"
        >
          {footerLabel(generation)}
        </span>
      ) : null}
    </div>
  );
}
