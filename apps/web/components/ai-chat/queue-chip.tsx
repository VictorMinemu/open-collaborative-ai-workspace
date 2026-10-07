"use client";

import type { AiQueueState } from "@ocw/contracts";
import { Square } from "lucide-react";
import { useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { queueText } from "@/lib/ai-format";
import { cn } from "@/lib/utils";

/**
 * The one-generation queue of a multiplayer AI chat, above the composer (06-11, D-05): "AI is answering Víctor Ruiz ·
 * Alex Kim is next". Requesters first, then the waiting authors in order. Stop sits here (not in the composer, whose
 * Send stays available while an answer runs) and only for the running request's author or someone holding
 * `ai_chat.manage` (`canStop`; the API enforces the same rule). Hidden while nothing runs and nothing waits; the
 * sentence truncates on a phone, its full text in the tooltip.
 */
export function QueueChip({
  queue,
  names,
  canStop,
  onStop,
}: {
  queue: AiQueueState;
  names: (userId: string) => string;
  /** Who reads the chip (kept in the interface for viewer-relative wording later; names stay names, 06-11). */
  viewerId?: string | null;
  canStop: boolean;
  onStop(): Promise<void> | void;
}) {
  const [stopping, setStopping] = useState(false);
  const text = queueText(queue, names);
  if (!text) return null;
  const running = queue.running !== null;

  async function stop() {
    if (stopping) return;
    setStopping(true);
    try {
      await onStop();
    } finally {
      setStopping(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl justify-center px-3 pb-1.5 sm:px-6">
      <div
        role="status"
        data-testid="ai-queue-chip"
        data-running={running || undefined}
        title={text}
        className="flex h-8 min-w-0 max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-[12.5px] text-muted-foreground shadow-[0_1px_2px_rgb(0_0_0/0.04)] dark:shadow-none"
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            running ? "animate-pulse bg-primary motion-reduce:animate-none" : "bg-muted-foreground/50",
          )}
        />
        <span data-testid="ai-queue-text" className={cn("min-w-0 truncate", !canStop && "pr-2")}>
          {text}
        </span>
        {running && canStop ? (
          <button
            type="button"
            onClick={() => void stop()}
            disabled={stopping}
            data-testid="ai-queue-stop"
            aria-label="Stop the answer"
            className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-foreground px-2.5 font-medium text-[12px] text-background outline-none transition-opacity hover:opacity-90 focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-60"
          >
            {stopping ? (
              <Spinner className="size-3" />
            ) : (
              <Square aria-hidden className="size-2.5 fill-current" />
            )}
            Stop
          </button>
        ) : null}
      </div>
    </div>
  );
}
