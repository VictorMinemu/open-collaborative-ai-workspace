"use client";

import type { AiModelOption } from "@ocw/contracts";
import { ArrowUp, Sparkles } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { PlanUsageLine } from "./plan-usage-line";

/**
 * The AI chat composer (P-09): an auto-growing textarea (Enter sends, Shift+Enter is a new line), the model chip
 * and the send button, in the Work Zone composer card. The chip shows the model the next answer uses, read-only
 * until the picker lands (05-04). Plan models carry "Using ChatGPT plan · Manage usage" under the card (P-11).
 */
export function AiComposer({
  model,
  modelsLoading,
  busy,
  onSend,
  autoFocus,
  className,
}: {
  /** The model the next answer runs on, or null when none is available. */
  model: AiModelOption | null;
  modelsLoading: boolean;
  /** An answer is being written: one generation per chat (Stop arrives in 05-06). */
  busy: boolean;
  /** Resolves once the API accepted the send; rejects to keep the text. */
  onSend: (text: string, model: AiModelOption) => Promise<void>;
  autoFocus?: boolean;
  className?: string;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const noModel = !model && !modelsLoading;
  const canSend = text.trim().length > 0 && !!model && !busy && !sending;

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const body = text.trim();
    if (!body || !model || busy || sending) return;
    setSending(true);
    setText("");
    try {
      await onSend(body, model);
    } catch {
      setText(body); // the caller reported the error; nothing typed is lost
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <form
      onSubmit={submit}
      data-testid="ai-composer-form"
      className={cn(
        "mx-auto grid w-full max-w-3xl gap-1.5 px-3 pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-3",
        className,
      )}
    >
      <div className="relative rounded-[22px] border bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.12)] transition-[border-color,box-shadow] focus-within:border-ring/50 dark:shadow-none">
        <textarea
          ref={ref}
          data-testid="ai-composer"
          rows={1}
          value={text}
          // biome-ignore lint/a11y/noAutofocus: a new chat opens ready to type, like ChatGPT and Claude.ai
          autoFocus={autoFocus}
          disabled={noModel}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={noModel ? "No model is available to you yet" : "Ask anything"}
          aria-label="Message"
          className="block max-h-[240px] min-h-[56px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-6 outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed"
        />
        <div className="flex items-center gap-1.5 px-2 pb-2">
          {model ? (
            <span
              data-testid="ai-model-chip"
              title={`${model.label} · ${model.providerLabel}`}
              className="inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[13px] text-foreground/85"
            >
              <Sparkles aria-hidden className="size-3.5 shrink-0 text-primary" />
              <span className="truncate">{model.label}</span>
            </span>
          ) : modelsLoading ? (
            <span className="h-4 w-24 animate-pulse rounded bg-muted" />
          ) : null}
          <Button
            type="submit"
            size="icon"
            disabled={!canSend}
            aria-label="Send"
            data-testid="ai-send"
            className="ml-auto rounded-full"
          >
            {sending ? <Spinner /> : <ArrowUp className="size-[18px]" />}
          </Button>
        </div>
      </div>
      {model?.group === "chatgpt_plan" ? <PlanUsageLine /> : null}
    </form>
  );
}
