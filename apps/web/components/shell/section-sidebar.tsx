"use client";

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useShell } from "./shell-context";

/**
 * A page's secondary sidebar (channel list, session list, settings sections…).
 * Desktop: a column next to the rail. Mobile: portalled into the navigation drawer under the main nav.
 *
 *   <SectionSidebar title="Channels" actions={<Button size="icon-xs">…</Button>}>…</SectionSidebar>
 *   <div className="flex min-w-0 flex-1 flex-col">…page content…</div>
 */
export function SectionSidebar({
  title,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const { isDesktop, mobileSectionSlot } = useShell();

  const body = (
    <>
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-4">
        <h2 className="truncate font-semibold text-[13px] text-muted-foreground uppercase tracking-wider">
          {title}
        </h2>
        {actions ? <div className="flex items-center gap-1">{actions}</div> : null}
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">{children}</div>
    </>
  );

  if (!isDesktop) {
    return mobileSectionSlot ? createPortal(body, mobileSectionSlot) : null;
  }

  return (
    <aside
      data-testid="section-sidebar"
      className={cn("flex w-64 shrink-0 flex-col border-r bg-sidebar/50 dark:bg-sidebar/40", className)}
    >
      {body}
    </aside>
  );
}

/** A row in a SectionSidebar (link or button). */
export function sectionItemClass(active: boolean): string {
  return cn(
    "flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13.5px] outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40",
    active
      ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
      : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
  );
}
