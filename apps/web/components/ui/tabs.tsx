"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { type ComponentProps, createContext, useContext } from "react";
import { cn } from "@/lib/utils";

/**
 * Tabs over `@base-ui/react/tabs` (base-nova style; 07.1-UI-SPEC "Board toolbar" and "Board channel at 390"). Two
 * variants:
 * - `segmented`: a neutral pill toggle (Board | Messages). List `h-8`, triggers `h-6`; 44 px tall below 768 px.
 * - `underline`: a scrollable row of tabs (column tabs at 390), each `min-h-11`, with a 2 px primary indicator that
 *   slides between tabs, and does not under reduced motion.
 * Keyboard (arrows, Home/End) and roles (`tablist` / `tab` / `tabpanel`) come from Base UI.
 */

export type TabsVariant = "segmented" | "underline";

const VariantContext = createContext<TabsVariant>("segmented");

export function Tabs({
  variant = "segmented",
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.Root> & { variant?: TabsVariant }) {
  return (
    <VariantContext.Provider value={variant}>
      <TabsPrimitive.Root
        data-slot="tabs"
        data-variant={variant}
        className={cn("flex min-w-0 flex-col", className)}
        {...props}
      />
    </VariantContext.Provider>
  );
}

const LIST: Record<TabsVariant, string> = {
  segmented: "relative inline-flex h-8 w-fit items-center gap-0.5 rounded-lg bg-muted p-1 max-md:h-11",
  underline:
    "relative flex min-w-0 items-stretch overflow-x-auto overscroll-x-contain border-b [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
};

const TRIGGER: Record<TabsVariant, string> = {
  segmented:
    "relative inline-flex h-6 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 font-medium text-muted-foreground text-sm outline-none transition-[color,background-color,box-shadow] hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 data-active:bg-background data-active:text-foreground data-active:shadow-xs data-disabled:pointer-events-none data-disabled:opacity-50 max-md:h-9 max-md:after:absolute max-md:after:inset-x-0 max-md:after:-inset-y-1",
  underline:
    "relative inline-flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap px-3 font-medium text-muted-foreground text-sm outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset data-active:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
};

export function TabsList({ className, children, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  const variant = useContext(VariantContext);
  return (
    <TabsPrimitive.List data-slot="tabs-list" className={cn(LIST[variant], className)} {...props}>
      {children}
      {variant === "underline" ? (
        <TabsPrimitive.Indicator
          data-slot="tabs-indicator"
          renderBeforeHydration
          className="absolute bottom-0 left-(--active-tab-left) h-0.5 w-(--active-tab-width) bg-primary transition-[left,width] duration-200 ease-out motion-reduce:transition-none"
        />
      ) : null}
    </TabsPrimitive.List>
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Tab>) {
  const variant = useContext(VariantContext);
  return (
    <TabsPrimitive.Tab data-slot="tabs-trigger" className={cn(TRIGGER[variant], className)} {...props} />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Panel>) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("min-h-0 flex-1 outline-none", className)}
      {...props}
    />
  );
}
