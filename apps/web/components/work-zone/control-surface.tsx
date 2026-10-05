"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Popover } from "@base-ui/react/popover";
import {
  type ComponentProps,
  forwardRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

/** Below Tailwind `sm` (640 px) every composer menu is a bottom sheet (D-16). */
export function useSheetSurface(): boolean {
  return useMediaQuery("(max-width: 639px)", false);
}

/** Arrow keys / Home / End move between the surface's items, disabled ones included (they explain themselves). */
export function moveSurfaceFocus(e: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const root = e.currentTarget;
  const items = [...root.querySelectorAll<HTMLElement>("[data-surface-item]")];
  if (items.length === 0) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? items.length - 1
        : e.key === "ArrowDown"
          ? at < 0
            ? 0
            : Math.min(items.length - 1, at + 1)
          : at <= 0
            ? 0
            : at - 1;
  items[next]?.focus();
}

/**
 * The one container for the composer's model, reasoning and permission menus: a popover above its chip on a
 * desktop, a bottom sheet with the same content on a phone (D-16). Controlled by the caller so a pick can close it.
 */
export function ControlSurface({
  trigger,
  title,
  children,
  testId,
  open,
  onOpenChange,
  align = "start",
  className,
  sheetClassName,
  initialFocus,
}: {
  trigger: ReactElement;
  title: string;
  children: ReactNode;
  testId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  align?: "start" | "center";
  /** Popover popup (desktop). */
  className?: string;
  /** Sheet body (phone). */
  sheetClassName?: string;
  initialFocus?: RefObject<HTMLElement | null>;
}) {
  const sheet = useSheetSurface();

  if (sheet) {
    return (
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Trigger render={trigger} />
        <SheetContent
          side="bottom"
          data-testid={testId}
          data-surface="sheet"
          initialFocus={initialFocus ?? false}
          onKeyDown={moveSurfaceFocus}
          className="h-auto max-h-[85dvh] gap-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        >
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/25" aria-hidden />
          <SheetTitle className="px-5 pt-3 pb-2 text-[15px]">{title}</SheetTitle>
          <div className={cn("min-h-0 flex-1 overflow-y-auto px-2", sheetClassName)}>{children}</div>
        </SheetContent>
      </Dialog.Root>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger render={trigger} />
      <Popover.Portal>
        <Popover.Positioner
          side="top"
          align={align}
          sideOffset={8}
          collisionPadding={12}
          className="z-50 outline-none"
        >
          <Popover.Popup
            data-testid={testId}
            data-surface="popover"
            aria-label={title}
            initialFocus={initialFocus ?? true}
            onKeyDown={moveSurfaceFocus}
            className={cn(
              "max-h-[min(70vh,34rem)] origin-(--transform-origin) overflow-y-auto rounded-2xl border bg-popover p-1.5 text-popover-foreground shadow-xl shadow-black/8 outline-none dark:shadow-black/50",
              "transition-[transform,scale,opacity] duration-150 ease-out data-ending-style:scale-[0.97] data-starting-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:opacity-0",
              className,
            )}
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A composer chip (ref-1): quiet text button, highlighted while its surface is open. */
export const ControlChip = forwardRef<HTMLButtonElement, ComponentProps<"button"> & { tone?: "warning" }>(
  function ControlChip({ className, tone, ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          "inline-flex h-8 min-w-0 shrink items-center gap-1.5 rounded-lg px-2 text-[13px] text-muted-foreground outline-none transition-colors",
          "hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30 data-popup-open:bg-accent data-popup-open:text-foreground",
          "disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
          tone === "warning" &&
            "bg-warning/12 text-amber-800 hover:bg-warning/20 hover:text-amber-900 data-popup-open:bg-warning/20 data-popup-open:text-amber-900 dark:text-amber-300 dark:hover:text-amber-200 dark:data-popup-open:text-amber-200",
          className,
        )}
        {...props}
      />
    );
  },
);

/** Section header inside a surface (ref-2: "Reasoning", "Context Window", "Fast Mode"). */
export function SurfaceSection({
  title,
  children,
  note,
}: {
  title: string;
  children: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div role="group" aria-label={title} className="py-1 [&+&]:mt-1 [&+&]:border-t [&+&]:pt-2">
      <p className="px-2.5 pt-1 pb-1 text-[12px] text-muted-foreground">{title}</p>
      {children}
      {note ? (
        <p className="px-2.5 pt-1 pb-1 text-[11.5px] text-muted-foreground leading-snug">{note}</p>
      ) : null}
    </div>
  );
}

/** The "Default" tag of ref-2. */
export function DefaultTag() {
  return (
    <span className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] border px-1 font-medium text-[10.5px] text-muted-foreground leading-none">
      Default
    </span>
  );
}
