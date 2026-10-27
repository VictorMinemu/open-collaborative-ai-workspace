"use client";

import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The collapsible section header shared by the chat and Work Zone sidebars (Phase 07.10, UI-SPEC § 2, R8, PD-10): a
 * toggle with a chevron that turns when expanded, the uppercase title, a count pill of what a collapsed section hides,
 * and an optional trailing action ("+"). The markup is the chat header's, unchanged: the optional props add nothing to
 * it when absent, so the chat sidebar renders byte for byte as before.
 */
export function SidebarSectionHeader({
  id,
  title,
  expanded,
  hidden,
  onToggle,
  controls,
  touch = false,
  announceHidden = false,
  action,
  testId,
}: {
  /** The toggle's id (the section's `aria-labelledby`). */
  id: string;
  title: ReactNode;
  expanded: boolean;
  /** What the collapsed section hides; the pill shows only when collapsed and > 0. */
  hidden: number;
  onToggle: () => void;
  /** The id of the list the toggle shows and hides (`aria-controls`), when there is one. */
  controls?: string;
  /** 44 px rows below 768 (the Work Zone drawer). */
  touch?: boolean;
  /** Adds ", {n} hidden" to the toggle's name when collapsed (screen readers). */
  announceHidden?: boolean;
  action?: ReactNode;
  /** The toggle's test id when it is not `section-toggle` (the Work Zone's Settled keeps `settled-toggle`). */
  testId?: string | undefined;
}) {
  const showCount = !expanded && hidden > 0;
  return (
    <div className={cn("group/section flex h-7 items-center gap-1 pr-1", touch && "max-md:h-11")}>
      <button
        type="button"
        id={id}
        data-testid={testId ?? "section-toggle"}
        aria-expanded={expanded}
        aria-controls={controls}
        onClick={onToggle}
        className={cn(
          "flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40",
          touch && "max-md:h-11",
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
            expanded && "rotate-90",
          )}
        />
        <span className="truncate font-semibold text-[11.5px] text-muted-foreground uppercase tracking-wider">
          {title}
        </span>
        {showCount ? (
          <span
            data-testid="section-count"
            className="ml-1 rounded-full bg-muted px-1.5 text-[10.5px] text-muted-foreground tabular-nums"
          >
            {hidden}
          </span>
        ) : null}
        {showCount && announceHidden ? <span className="sr-only">, {hidden} hidden</span> : null}
      </button>
      {action}
    </div>
  );
}
