"use client";

import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronsUpDown } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const Select = SelectPrimitive.Root;

export function SelectTrigger({
  className,
  placeholder,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger> & { placeholder?: string }) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "flex h-9 w-full items-center justify-between gap-2 whitespace-nowrap rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-[color,box-shadow,border-color] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 data-disabled:cursor-not-allowed data-disabled:opacity-50 dark:bg-input/25",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.Value
        className="truncate data-placeholder:text-muted-foreground"
        placeholder={placeholder}
      />
      <SelectPrimitive.Icon className="text-muted-foreground">
        <ChevronsUpDown className="size-3.5" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Popup>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner className="z-50 outline-none" sideOffset={4} alignItemWithTrigger={false}>
        <SelectPrimitive.Popup
          className={cn(
            "min-w-(--anchor-width) origin-(--transform-origin) overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg shadow-black/5 outline-none dark:shadow-black/40",
            "transition-[transform,scale,opacity] duration-150 data-ending-style:scale-95 data-starting-style:scale-95 data-ending-style:opacity-0 data-starting-style:opacity-0",
            className,
          )}
          {...props}
        >
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-sm outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2 flex size-4 items-center justify-center">
        <Check className="size-4" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}
