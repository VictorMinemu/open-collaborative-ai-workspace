import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Label({ className, ...props }: ComponentProps<"label">) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: callers pass htmlFor
    <label
      data-slot="label"
      className={cn(
        "flex select-none items-center gap-2 font-medium text-[13px] leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
