"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cn } from "@/lib/utils";

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({
  content,
  side = "top",
  children,
  className,
}: {
  content: ReactNode;
  side?: ComponentProps<typeof TooltipPrimitive.Positioner>["side"];
  /** The trigger element; it receives the tooltip props via `render`. */
  children: ReactElement;
  className?: string;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} sideOffset={8} className="z-50">
          <TooltipPrimitive.Popup
            className={cn(
              "origin-(--transform-origin) rounded-md bg-foreground px-2 py-1 font-medium text-background text-xs shadow-md",
              "transition-[transform,scale,opacity] duration-100 data-ending-style:scale-95 data-starting-style:scale-95 data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0",
              className,
            )}
          >
            {content}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
