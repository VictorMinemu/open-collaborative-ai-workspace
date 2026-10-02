import { cn } from "@/lib/utils";

export const PRODUCT_NAME = "Open Collaborative AI Workspace";
export const PRODUCT_SHORT = "OCW";

/** Brand mark: two overlapping rings (humans and agents) on the accent gradient. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-linear-to-br from-indigo-500 to-violet-600 text-white shadow-sm shadow-indigo-500/30 ring-1 ring-white/15 ring-inset",
        className,
      )}
    >
      <svg viewBox="0 0 24 24" className="size-[62%]" fill="none" stroke="currentColor" strokeWidth={2.2}>
        <title>OCW</title>
        <circle cx="9" cy="12" r="5.5" />
        <circle cx="15" cy="12" r="5.5" strokeOpacity={0.75} />
      </svg>
    </span>
  );
}

export function Logo({ className, showName = true }: { className?: string; showName?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark />
      {showName ? (
        <span className="font-semibold text-[15px] tracking-tight">
          {PRODUCT_SHORT}
          <span className="ml-1.5 font-normal text-muted-foreground">Workspace</span>
        </span>
      ) : null}
    </span>
  );
}
