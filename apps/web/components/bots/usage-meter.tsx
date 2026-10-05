"use client";

import type { BotUsage } from "@ocw/contracts";
import { cn } from "@/lib/utils";

function resetTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Today's replies against the bot's daily limit (D-11): "N of L replies today", a thin bar (destructive at the
 * limit) and when it resets. `compact` is the one-line table / header variant.
 */
export function UsageMeter({
  usage,
  compact = false,
  className,
  testId = "usage-meter",
}: {
  usage: BotUsage;
  compact?: boolean;
  className?: string;
  testId?: string;
}) {
  const ratio = usage.limit > 0 ? Math.min(1, usage.today / usage.limit) : 1;
  const full = usage.today >= usage.limit;
  const bar = (
    <div
      className={cn("h-1.5 overflow-hidden rounded-full bg-muted", compact ? "w-16" : "w-full")}
      role="progressbar"
      aria-label="Replies used today"
      aria-valuemin={0}
      aria-valuemax={usage.limit}
      aria-valuenow={Math.min(usage.today, usage.limit)}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-300",
          full ? "bg-destructive" : "bg-primary",
        )}
        style={{ width: `${Math.max(ratio * 100, usage.today > 0 ? 4 : 0)}%` }}
      />
    </div>
  );

  if (compact) {
    return (
      <span
        data-testid={testId}
        className={cn("inline-flex items-center gap-2 text-xs tabular-nums", className)}
        title={`${usage.today} of ${usage.limit} replies today · resets at ${resetTime(usage.resetsAt)}`}
      >
        {bar}
        <span className={cn(full ? "text-destructive" : "text-muted-foreground")}>
          {usage.today} / {usage.limit}
        </span>
      </span>
    );
  }

  return (
    <div data-testid={testId} className={cn("grid gap-2", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className={cn("font-medium text-sm tabular-nums", full && "text-destructive")}>
          {usage.today} of {usage.limit} replies today
        </span>
        <span className="text-muted-foreground text-xs">Resets at {resetTime(usage.resetsAt)}</span>
      </div>
      {bar}
      {full ? (
        <p className="text-destructive text-xs">Limit reached: the bot pauses until the reset.</p>
      ) : null}
    </div>
  );
}
