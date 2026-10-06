"use client";

import { type AiModelOption, type ModelRef, modelRefKey } from "@ocw/contracts";
import { ArrowUp, Square } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAiChatModel } from "@/lib/ai-chat-model-store";
import { cn } from "@/lib/utils";
import { ModelPicker } from "./model-picker";
import { PlanUsageLine } from "./plan-usage-line";

/**
 * The model a chat falls back to: the first of `preferred` that is still available (the chat's last model, the
 * member's default), else the list's default, else any available model.
 */
export function pickModel(
  models: AiModelOption[] | undefined,
  preferred: (ModelRef | null | undefined)[],
): AiModelOption | null {
  const list = models ?? [];
  for (const ref of preferred) {
    if (!ref) continue;
    const found = list.find((m) => m.available && modelRefKey(m.ref) === modelRefKey(ref));
    if (found) return found;
  }
  return list.find((m) => m.available && m.isDefault) ?? list.find((m) => m.available) ?? null;
}

/**
 * The AI chat composer (P-09): an auto-growing textarea (Enter sends, Shift+Enter is a new line), the model picker
 * chip and the send button, in the Work Zone composer card. While an answer is being written the send button is
 * Stop (05-06, D-05: one generation per chat): the textarea keeps taking text, Enter does not send, Esc stops. The model is chosen per chat (`chatKey`) and per
 * message: the selection survives sends and only ever applies to the next answer. Plan models carry "Using ChatGPT
 * plan · Manage usage" under the card (P-11); organization models carry METERED on the chip.
 */
export function AiComposer({
  chatKey,
  models,
  preferred,
  modelsLoading,
  busy,
  onSend,
  onStop,
  autoFocus,
  className,
}: {
  /** The chat id, or "new" on `/chat/ai/new`. */
  chatKey: string;
  models: AiModelOption[] | undefined;
  /** Fallbacks before the member picks: the chat's last model, then the member's default. */
  preferred: (ModelRef | null | undefined)[];
  modelsLoading: boolean;
  /** An answer is being written: one generation per chat, so Stop replaces Send. */
  busy: boolean;
  /** Stops the answer being written (absent while the chat has none to stop). */
  onStop?: () => Promise<void>;
  /** Resolves once the API accepted the send; rejects to keep the text. */
  onSend: (text: string, model: AiModelOption) => Promise<void>;
  autoFocus?: boolean;
  className?: string;
}) {
  const fallback = pickModel(models, preferred);
  const [selected, setSelected] = useAiChatModel(chatKey, fallback?.ref ?? null);
  // A pick the admin has since removed (or that became unavailable) falls back instead of failing the send.
  const model = pickModel(models, [selected, fallback?.ref]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  // A new answer clears the "stopping" state of the previous one.
  useEffect(() => {
    if (!busy) setStopping(false);
  }, [busy]);

  const noModel = !model && !modelsLoading;
  const showStop = busy && !!onStop;
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

  async function stop() {
    if (!onStop || stopping) return;
    setStopping(true);
    try {
      await onStop();
    } catch {
      setStopping(false); // the caller reported the error; Stop stays available
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && showStop) {
      e.preventDefault();
      void stop();
      return;
    }
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
            <ModelPicker chatKey={chatKey} value={model.ref} onChange={setSelected} />
          ) : modelsLoading ? (
            <span className="h-4 w-24 animate-pulse rounded bg-muted" />
          ) : null}
          {showStop ? (
            <Button
              type="button"
              size="icon"
              onClick={() => void stop()}
              disabled={stopping}
              aria-label="Stop writing"
              title="Stop writing (Esc)"
              data-testid="ai-stop"
              className="ml-auto rounded-full"
            >
              {stopping ? <Spinner /> : <Square aria-hidden className="size-3.5 fill-current" />}
            </Button>
          ) : (
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
          )}
        </div>
      </div>
      {model?.group === "chatgpt_plan" ? <PlanUsageLine /> : null}
    </form>
  );
}
