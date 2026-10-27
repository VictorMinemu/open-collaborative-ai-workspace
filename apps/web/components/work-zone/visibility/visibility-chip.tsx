"use client";

import type { SessionVisibilityKind, WorkSession } from "@ocw/contracts";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetCloseButton, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { useSheetSurface } from "@/components/work-zone/control-surface";
import { chipName, type LongLabelInput, longLabel, sessionPlace, shortLabel } from "@/lib/session-visibility";
import { cn } from "@/lib/utils";
import { CHOICE_ICON } from "./audience-rows";
import { VisibilityPanel } from "./visibility-panel";

type ChipSession = Pick<
  WorkSession,
  | "id"
  | "visibility"
  | "teamProject"
  | "teamProjectHidden"
  | "projectName"
  | "deviceName"
  | "createdBy"
  | "createdByName"
>;

/** The panel's checked radio (editable) or its title (read-only) gets the focus when it opens (§Focus). */
function focusTarget(): HTMLElement | true {
  const panel = document.querySelector<HTMLElement>('[data-testid="visibility-panel"]');
  return (
    panel?.querySelector<HTMLElement>('input[type="radio"]:checked') ??
    panel?.querySelector<HTMLElement>("[data-visibility-title]") ??
    true
  );
}

/** The sheet focuses its title, never the search field (no keyboard popping up on a phone, §Focus). */
function sheetFocus(): HTMLElement | true {
  return document.querySelector<HTMLElement>("[data-visibility-title]") ?? true;
}

/**
 * Who can see this session, in the session header (Phase 07.9, UI-SPEC §1.1, D-07, N1–N5): one chip right before the
 * presence stack, with the short label from the session DTO (it never waits for a request), the AI-chat audience chip's
 * look, no colour. Below 640 it is icon-only on the project's default and icon + label otherwise. It opens the panel:
 * a popover on ≥ 640, a bottom sheet below. Below 768 its hit area is 44 × 44 (the `::before` reaches 7 px past the
 * padding box, 6 px past the border: the header's gap). Never disabled and never hidden: everyone who sees the session may ask who
 * else does; `canChange` (the API's `work_session.visibility`) only names what the panel lets them do.
 */
export function VisibilityChip({
  session,
  viewerId,
  canChange,
}: {
  session: ChipSession;
  viewerId: string | null | undefined;
  canChange: boolean;
}) {
  const sheet = useSheetSurface();
  const [open, setOpen] = useState(false);
  const v = session.visibility ?? {
    kind: "project",
    activeCount: 0,
    differsFromDefault: false,
    firstTeamName: null,
  };
  const kind: SessionVisibilityKind =
    (v.kind === "teams" || v.kind === "people") && v.activeCount === 0 ? "owner" : v.kind;
  const ctx: LongLabelInput & { firstTeamName: string | null } = {
    kind: v.kind,
    activeCount: v.activeCount,
    firstTeamName: v.firstTeamName,
    ownerName: session.createdByName,
    viewerIsOwner: viewerId === session.createdBy,
    // 07.10-07 (ME-01): a project the viewer can't open is "a project you can't open", never the device's users.
    ...sessionPlace(session),
  };
  const label = shortLabel(ctx);
  const name = chipName(longLabel(ctx), canChange);
  const quiet = !v.differsFromDefault;
  const Icon = CHOICE_ICON[kind];

  const trigger = (
    <button
      type="button"
      data-testid="visibility-chip"
      data-kind={kind}
      aria-haspopup="dialog"
      aria-label={name}
      title={name}
      className={cn(
        "relative flex h-8 min-w-0 shrink items-center gap-1.5 rounded-lg border px-2 text-[12.5px] text-muted-foreground outline-none transition-colors before:absolute before:-inset-[7px] before:z-10 hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 data-popup-open:bg-accent data-popup-open:text-foreground md:before:hidden",
        sheet && quiet && "w-8 justify-center px-0",
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span
        data-testid="visibility-chip-label"
        className={cn(
          "truncate font-medium",
          sheet ? (quiet ? "sr-only" : "max-w-[6.5rem]") : "max-w-[10rem]",
        )}
      >
        {label}
      </span>
    </button>
  );

  if (sheet) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger render={trigger} />
        <SheetContent
          side="bottom"
          data-testid="visibility-sheet"
          initialFocus={sheetFocus}
          showClose={false}
          className="h-auto max-h-[85dvh] gap-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        >
          {/* The primitive's close, first in the tab order; 44 px on a phone (§1.6). */}
          <SheetCloseButton />
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/25" aria-hidden />
          <VisibilityPanel mode="edit" sessionId={session.id} surface="sheet" />
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent
        align="end"
        data-testid="visibility-popover"
        initialFocus={focusTarget}
        className="w-[22rem] max-w-[calc(100vw-1rem)] p-0"
      >
        <VisibilityPanel mode="edit" sessionId={session.id} surface="popover" />
      </PopoverContent>
    </Popover>
  );
}
