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
} as const;

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
        {showClose ? (
          <Dialog.Close
            aria-label="Close"
            className="absolute top-3 right-3 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
          >
            <X className="size-4" />
          </Dialog.Close>
        ) : null}
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
