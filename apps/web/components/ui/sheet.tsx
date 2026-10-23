"use client";

import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const Sheet = Dialog.Root;
export const SheetTrigger = Dialog.Trigger;
export const SheetClose = Dialog.Close;

const sideClass = {
  left: "inset-y-0 left-0 h-dvh w-[19rem] max-w-[85vw] border-r data-ending-style:-translate-x-full data-starting-style:-translate-x-full",
  right:
    "inset-y-0 right-0 h-dvh w-[24rem] max-w-[92vw] border-l data-ending-style:translate-x-full data-starting-style:translate-x-full",
  bottom:
    "inset-x-0 bottom-0 h-[85dvh] w-full rounded-t-2xl border-t data-ending-style:translate-y-full data-starting-style:translate-y-full",
} as const;

/**
 * The sheet's close button: 32 px from 768 up; below 768 a 44 px target whose icon stays exactly where the 32 px one
 * was (the box grows 6 px on each side and moves out by 6 px), so every sheet meets the touch rule (07.9 polish).
 * `SheetContent` renders it unless `showClose={false}`; a sheet that places its own close renders this one.
 */
export function SheetCloseButton({ className, ...props }: ComponentProps<typeof Dialog.Close>) {
  return (
    <Dialog.Close
      aria-label="Close"
      className={cn(
        "absolute top-3 right-3 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 max-md:top-1.5 max-md:right-1.5 max-md:size-11",
        className,
      )}
      {...props}
    >
      <X className="size-4" />
    </Dialog.Close>
  );
}

export function SheetContent({
  className,
  side = "left",
  showClose = true,
  children,
  ...props
}: ComponentProps<typeof Dialog.Popup> & { side?: keyof typeof sideClass; showClose?: boolean }) {
  return (
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-[-webkit-touch-callout:none]:absolute" />
      <Dialog.Popup
        data-slot="sheet-content"
        className={cn(
          "fixed z-50 flex flex-col bg-background shadow-2xl outline-none transition-transform duration-250 ease-[cubic-bezier(0.32,0.72,0,1)]",
          sideClass[side],
          className,
        )}
        {...props}
      >
        {children}
        {showClose ? <SheetCloseButton /> : null}
      </Dialog.Popup>
    </Dialog.Portal>
  );
}

export function SheetTitle({ className, ...props }: ComponentProps<typeof Dialog.Title>) {
  return <Dialog.Title className={cn("font-semibold text-base", className)} {...props} />;
}

export function SheetDescription({ className, ...props }: ComponentProps<typeof Dialog.Description>) {
  return <Dialog.Description className={cn("text-muted-foreground text-sm", className)} {...props} />;
}
