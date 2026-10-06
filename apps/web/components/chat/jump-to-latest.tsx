"use client";

import { ArrowDown } from "lucide-react";

/**
 * Detached history (CHAT-14): a floating pill above the composer that returns to the live tail. Shows how many
 * messages arrived since the reader left it.
 */
export function JumpToLatest({ newCount, onJump }: { newCount: number; onJump: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-4">
      <button
        type="button"
        data-testid="jump-to-latest"
        onClick={onJump}
        className="pointer-events-auto inline-flex h-9 items-center gap-2 rounded-full border bg-background/95 pr-2 pl-3.5 font-medium text-[13px] shadow-lg outline-none backdrop-blur transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40 dark:bg-popover/95"
      >
        <ArrowDown className="size-4 text-primary" aria-hidden />
        <span>Jump to latest</span>
        {newCount > 0 ? (
          <span
            data-testid="jump-to-latest-count"
            className="rounded-full bg-primary px-2 py-0.5 font-semibold text-[11px] text-primary-foreground tabular-nums"
          >
            {newCount > 99 ? "99+" : newCount} new
          </span>
        ) : (
          <span className="w-1.5" aria-hidden />
        )}
      </button>
    </div>
  );
}
