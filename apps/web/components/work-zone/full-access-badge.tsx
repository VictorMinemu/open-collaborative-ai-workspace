"use client";

import { LockOpen } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Persistent "Full access" badge in the session header (D-04, ADR-0012): every controller sees that commands and
 * edits run without prompts while the session is in Full access. Warning tone, open lock.
 */
export function FullAccessBadge({ className }: { className?: string }) {
  return (
    <Tooltip content="Commands and edits run without prompts in this session">
      <span
        data-testid="full-access-badge"
        className={cn(
          "inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-warning/15 px-2 font-medium text-[12px] text-amber-800 dark:text-amber-300",
          className,
        )}
      >
        <LockOpen aria-hidden className="size-3.5" />
        Full access
      </span>
    </Tooltip>
  );
}
