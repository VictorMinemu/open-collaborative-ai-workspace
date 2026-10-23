"use client";

import type { Project, SessionVisibilityKind } from "@ocw/contracts";
import { X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetClose, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { useSheetSurface } from "@/components/work-zone/control-surface";
import { type DraftAudience, draftLongLabel, type PlaceContext } from "@/lib/session-visibility";
import { cn } from "@/lib/utils";
import { CHOICE_ICON } from "./audience-rows";
import { type DraftPlace, VisibilityPanel } from "./visibility-panel";

/** What the line shows for the chosen repository and draft; null = no line (nothing to describe). */
export function lineModel(
  project: Project | null,
  value: DraftAudience | null,
): { kind: SessionVisibilityKind; label: string; place: DraftPlace; context: PlaceContext } | null {
  if (!project || !value || project.teamProjectHidden) return null;
  const tp = project.teamProject;
  const place: DraftPlace = tp
    ? { kind: "team", unitId: tp.id, name: tp.name, defaultVisibility: tp.defaultVisibility }
    : { kind: "personal", deviceName: project.deviceName };
  const context: PlaceContext = tp
    ? { projectName: tp.name, deviceName: project.deviceName, personal: false }
    : { projectName: project.deviceName, deviceName: project.deviceName, personal: true };
  return { kind: value.kind, label: draftLongLabel(value, context), place, context };
}

/** The draft panel's checked radio gets the focus when the popover opens (UI-SPEC §Focus). */
function popoverFocus(): HTMLElement | true {
  const panel = document.querySelector<HTMLElement>(
    '[data-testid="visibility-popover"] [data-testid="visibility-panel"]',
  );
  return panel?.querySelector<HTMLElement>('input[type="radio"]:checked') ?? true;
}

/** The sheet focuses its title, never the search field (no keyboard popping up on a phone, §Focus). */
function sheetFocus(): HTMLElement | true {
  return (
    document.querySelector<HTMLElement>('[data-testid="visibility-sheet"] [data-visibility-title]') ?? true
  );
}

/**
 * Who a session not started yet will be visible to, in the new-session dialog right under the Project section
 * (Phase 07.9-14, UI-SPEC Surface 3, D-03, D-07, N1): one line, "Visible to: {long label} · Change", no card and no
 * border. Change opens the same panel as the session header's chip, in draft mode: a popover anchored to Change on
 * ≥ 640, a nested bottom sheet below. The choice stays in the dialog until Start session sends it; the panel never
 * saves and never shows Undo. Hidden without a repository (nothing to describe).
 */
export function NewSessionVisibilityLine({
  project,
  value,
  onChange,
}: {
  project: Project | null;
  value: DraftAudience | null;
  onChange: (value: DraftAudience) => void;
}) {
  const sheet = useSheetSurface();
  const [open, setOpen] = useState(false);
  const m = lineModel(project, value);
  if (!m || !project || !value) return null;
  const Icon = CHOICE_ICON[m.kind];

  const trigger = (
    <Button
      type="button"
      variant="link"
      size="sm"
      data-testid="new-session-visibility-change"
      aria-label="Change who can see this session"
      className="h-8 shrink-0 px-1.5 max-md:h-11 max-md:px-3"
    >
      Change
    </Button>
  );
  const panel = (surface: "popover" | "sheet") => (
    <VisibilityPanel
      mode="draft"
      projectId={project.id}
      place={m.place}
      value={value}
      onChange={onChange}
      surface={surface}
    />
  );

  return (
    <div
      data-testid="new-session-visibility"
      data-kind={m.kind}
      className="flex min-h-9 min-w-0 items-center gap-1.5 text-sm"
    >
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      {/* The spaces between items read the line as words ("Visible to: Project · Change"); flex drops them visually. */}
      <span className="shrink-0 text-muted-foreground">Visible to:</span>{" "}
      <span
        data-testid="new-session-visibility-label"
        title={m.label}
        className="min-w-0 truncate font-semibold"
      >
        {m.label}
      </span>{" "}
      <span aria-hidden className="shrink-0 text-muted-foreground">
        ·
      </span>{" "}
      {sheet ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger render={trigger} />
          <SheetContent
            side="bottom"
            data-testid="visibility-sheet"
            initialFocus={sheetFocus}
            showClose={false}
            className="h-auto max-h-[85dvh] gap-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          >
            {/* A 44 px close (§1.6); the primitive's own is 32. */}
            <SheetClose
              aria-label="Close"
              className={cn(
                "absolute top-1.5 right-1.5 inline-flex size-11 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors",
                "hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40",
              )}
            >
              <X className="size-4" />
            </SheetClose>
            <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/25" aria-hidden />
            {panel("sheet")}
          </SheetContent>
        </Sheet>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger render={trigger} />
          <PopoverContent
            align="end"
            data-testid="visibility-popover"
            initialFocus={popoverFocus}
            className="w-[22rem] max-w-[calc(100vw-1rem)] p-0"
          >
            {panel("popover")}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
