"use client";

import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SettledModel } from "./model";
import { SectionShell } from "./needs-you-section";
import type { RowContext } from "./sections";
import { SettledRow } from "./session-rows";

/**
 * Settled (Phase 07.10-04, D-04, UI-SPEC § 8): the history of the viewer's sidebar scope as a section at the end,
 * collapsed by default and remembered with the others. Its header is the shared section header with the existing
 * `settled-group` / `settled-toggle` ids; its rows are the existing `SettledRow`, 10 then "Show {n} more" /
 * "Show fewer" (`settled-more`). No count pill: history is not news (§ 2).
 */
export function SettledSection({
  model,
  now,
  viewerId,
  openSessionId,
  onToggle,
  onExpand,
}: { model: SettledModel | null } & RowContext) {
  if (!model) return null;
  return (
    <SectionShell
      sectionKey="settled"
      title="Settled"
      collapsed={model.collapsed}
      hidden={0}
      onToggle={onToggle}
      testId="settled-group"
      toggleTestId="settled-toggle"
    >
      {model.rows.map((s) => (
        <li key={s.id}>
          <SettledRow s={s} now={now} active={s.id === openSessionId} viewerId={viewerId} />
        </li>
      ))}
      {model.more > 0 || model.expanded ? (
        <li>
          <button
            type="button"
            data-testid="settled-more"
            aria-expanded={model.expanded}
            aria-controls="wz-list-settled"
            onClick={() => onExpand("settled")}
            className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-muted-foreground outline-none hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 max-md:h-11"
          >
            <Plus
              aria-hidden
              className={cn("size-3.5 transition-transform", model.expanded && "rotate-45")}
            />
            {model.expanded ? "Show fewer" : `Show ${model.more} more`}
          </button>
        </li>
      ) : null}
    </SectionShell>
  );
}
