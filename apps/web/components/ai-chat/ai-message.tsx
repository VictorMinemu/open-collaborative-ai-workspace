"use client";

import type { AiGeneration, Message, SendAiMessageResponse } from "@ocw/contracts";
import { Check, Copy, Globe, Square, Unplug } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { Markdown } from "@/components/markdown/markdown";
import { safeUrl } from "@/components/markdown/safe-url";
import { Tooltip } from "@/components/ui/tooltip";
import { useCopy } from "@/hooks/use-copy";
import { footerParts, formatUsage, usageTitle } from "@/lib/ai-format";
import { sourceLinks } from "@/lib/ai-tools";
import { cn } from "@/lib/utils";
import { GenerationError, markStreamed } from "./generation-error";
import { RegenerateMenu } from "./regenerate-menu";

/** Regenerate on the chat's last answer only (05-06). */
export interface AnswerRegenerate {
  chatId: string;
  /** Something is being written in the chat (one generation per chat). */
  disabled: boolean;
  onRegenerated: (response: SendAiMessageResponse) => void;
}

/**
 * One turn of an AI chat (P-09): the member's turns are right-aligned bubbles; answers are full width through the
 * one shared Markdown renderer (no raw HTML, images as links, `safeUrl`), with a caret while they stream and a
 * quiet footer once done: tokens, cost on organization keys, model and who pays (`1.2k in · 340 out · ~$0.004 ·
 * Claude Sonnet 5.5 · METERED`, `… · GPT-6 Astra · ChatGPT plan`), exact counts in its tooltip (05-08). A failed
 * answer keeps any partial text and ends with a calm card instead of a spinner. A stopped or interrupted answer keeps its text and says so in the
 * line under it ("Stopped" / "Interrupted"), quietly: it was cut short, not broken (05-06). An answer that used the
 * web lists its sources as domain chips under the text (05-11): no favicons (no third-party request), `safeUrl`
 * links that open in a new tab without a referrer.
 */
export function AiMessage({
  message,
  text,
  regenerate,
}: {
  message: Message;
  text: string;
  regenerate?: AnswerRegenerate | undefined;
}) {
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
      {streaming ? null : <Sources text={text} generation={message.generation} />}
      {streaming ? null : <CutShortLabel generation={message.generation} />}
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
        <AnswerFooter
          text={text}
          generation={message.generation}
          actions={
            regenerate ? (
              <RegenerateMenu
                chatId={regenerate.chatId}
                message={message}
                disabled={regenerate.disabled}
                onRegenerated={regenerate.onRegenerated}
              />
            ) : null
          }
        />
      )}
    </div>
  );
}

/** The domains an answer drew on (web search), each linking to the page it cited. */
function Sources({ text, generation }: { text: string; generation: AiGeneration | undefined }) {
  const domains = generation?.sourceDomains ?? [];
  if (domains.length === 0) return null;
  return (
    <div data-testid="ai-sources" className="flex flex-wrap items-center gap-1.5 pt-0.5">
      <span className="mr-0.5 inline-flex items-center gap-1 text-[12px] text-muted-foreground">
        <Globe aria-hidden className="size-3.5" />
        Sources
      </span>
      {sourceLinks(text, domains).map((s) => {
        const href = safeUrl(s.href);
        return (
          <a
            key={s.domain}
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            data-testid="ai-source-chip"
            title={href}
            className="inline-flex h-6 max-w-[14rem] items-center truncate rounded-full border bg-background px-2.5 text-[12px] text-foreground/80 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30"
          >
            {s.domain}
          </a>
        );
      })}
    </div>
  );
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

/** "Stopped" / "Interrupted" right under an answer that was cut short (its text is kept), above the footer. */
function CutShortLabel({ generation }: { generation: AiGeneration | undefined }) {
  const state = generation ? CUT_SHORT[generation.status] : undefined;
  if (!state) return null;
  const Icon = state.icon;
  return (
    <span
      title={state.hint}
      className="inline-flex w-fit items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-medium text-[11.5px] text-foreground/70"
    >
      <Icon aria-hidden className={cn(Icon === Square ? "size-2.5 fill-current" : "size-3")} />
      <span data-testid="ai-generation-state">{state.label}</span>
    </span>
  );
}

function AnswerFooter({
  text,
  generation,
  actions,
}: {
  text: string;
  generation: AiGeneration | undefined;
  actions: ReactNode;
}) {
  const { copy, copied } = useCopy();
  return (
    <div
      className={cn(
        "flex min-h-7 min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground",
        // The copy button's padding sits outside the text column, so the label lines up with the answer.
        (text || actions) && "-ml-1.5",
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
      {actions}
      {generation ? (
        <span
          data-testid="ai-message-footer"
          data-usage={formatUsage(generation) || undefined}
          title={usageTitle(generation)}
          className="min-w-0 py-1 leading-[18px] tabular-nums"
        >
          {/* Each part stays whole: on a phone the line wraps between parts, never inside one. */}
          {footerParts(generation).map((part, i) => (
            <Fragment key={part}>
              {i > 0 ? " · " : null}
              <span className="whitespace-nowrap">{part}</span>
            </Fragment>
          ))}
        </span>
      ) : null}
    </div>
  );
}
