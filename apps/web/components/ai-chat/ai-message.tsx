"use client";

import type { AiGeneration, Message } from "@ocw/contracts";
import { Check, Copy, Square, Unplug } from "lucide-react";
import { Markdown } from "@/components/markdown/markdown";
import { Tooltip } from "@/components/ui/tooltip";
import { useCopy } from "@/hooks/use-copy";
import { cn } from "@/lib/utils";
import { GenerationError } from "./generation-error";

/**
 * One turn of an AI chat (P-09): the member's turns are right-aligned bubbles; answers are full width through the
 * one shared Markdown renderer (no raw HTML, images as links, `safeUrl`), with a caret while they stream and a
 * quiet footer once done: `<model> · ChatGPT plan · <in> in · <out> out`. A failed answer keeps any partial text
 * and ends with a calm card instead of a spinner. A stopped or interrupted answer keeps its text and says so in the
 * footer ("Stopped" / "Interrupted"), quietly: it was cut short, not broken (05-06).
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
      {message.status === "failed" ? <GenerationError code={message.generation?.errorCode ?? null} /> : null}
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

const CUT_SHORT: Partial<
  Record<AiGeneration["status"], { label: string; hint: string; icon: typeof Square }>
> = {
  stopped: { label: "Stopped", hint: "You stopped this answer", icon: Square },
  interrupted: {
    label: "Interrupted",
    hint: "The server restarted while writing this answer",
    icon: Unplug,
  },
};

/** "Stopped" / "Interrupted" before the model label of an answer that was cut short (text kept). */
function CutShortLabel({ generation }: { generation: AiGeneration | undefined }) {
  const state = generation ? CUT_SHORT[generation.status] : undefined;
  if (!state) return null;
  const Icon = state.icon;
  return (
    <span
      title={state.hint}
      className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-medium text-[11.5px] text-foreground/70"
    >
      <Icon aria-hidden className={cn(Icon === Square ? "size-2.5 fill-current" : "size-3")} />
      <span data-testid="ai-generation-state">{state.label}</span>
    </span>
  );
}

function AnswerFooter({ text, generation }: { text: string; generation: AiGeneration | undefined }) {
  const { copy, copied } = useCopy();
  return (
    <div
      className={cn(
        "flex min-h-7 min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-muted-foreground",
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
      <CutShortLabel generation={generation} />
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
