import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 font-medium text-[11px] leading-none [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        brand: "border-transparent bg-brand-soft text-brand-soft-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-muted-foreground",
        // The semantic tokens on their own 12-15 % tint measure 2.7:1 (success), 2:1 (warning) and 4.3:1 / 2.8:1
        // (destructive, light / dark) at 11 px: under AA. These are the Agent Card pill colours (UI-SPEC § Color,
        // AA-verified: >= 6.4:1 light, >= 8:1 dark), so every badge of these variants reads in both themes.
        success:
          "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300",
        warning: "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
        destructive: "border-transparent bg-red-100 text-red-800 dark:bg-red-400/15 dark:text-red-300",
      },
    },
    defaultVariants: { variant: "secondary" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}
