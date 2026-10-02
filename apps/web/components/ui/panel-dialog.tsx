"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/** Sectioned modal (header / scrollable body / footer bar); bottom sheet on small screens. Plain variant: ./dialog. */
export function DialogContent({
  className,
  showClose = true,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Popup> & { showClose?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed z-50 flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden border bg-background shadow-2xl outline-none",
          "inset-x-0 bottom-0 rounded-t-2xl sm:inset-x-auto sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:w-full sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl",
          "transition-[transform,opacity] duration-200 ease-out data-ending-style:translate-y-4 data-starting-style:translate-y-4 data-ending-style:opacity-0 data-starting-style:opacity-0 sm:data-ending-style:scale-95 sm:data-starting-style:scale-95 sm:data-ending-style:-translate-y-1/2 sm:data-starting-style:-translate-y-1/2",
          className,
        )}
        {...props}
      >
        {children}
        {showClose ? (
          <DialogPrimitive.Close
            aria-label="Close"
            className="absolute top-3 right-3 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("grid gap-1 px-5 pt-5 pr-12", className)} {...props} />;
}

export function DialogBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("scrollbar-thin min-h-0 overflow-y-auto px-5 py-4", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 border-t bg-muted/30 px-5 py-3 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title className={cn("font-semibold text-base tracking-tight", className)} {...props} />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description className={cn("text-muted-foreground text-sm", className)} {...props} />
  );
}
