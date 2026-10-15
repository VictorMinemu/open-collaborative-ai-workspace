import { cn } from "@/lib/utils";

/** The meter's tone: primary below 80 %, amber from 80 %, destructive at the cap (UI-SPEC §3.1 Cells). */
export function quotaTone(used: number, max: number): "ok" | "warn" | "full" {
  if (max <= 0 || used >= max) return "full";
  return used / max >= 0.8 ? "warn" : "ok";
}

const FILL = {
  ok: "bg-primary",
  warn: "bg-amber-500",
  full: "bg-destructive",
} as const;

/**
 * A 6 px quota bar (07.8-15; UsageMeter's markup, which stays unchanged): `role="progressbar"` with its values and a
 * label ("Disk used", "CPU minutes today"). The fill never drops under 4 % once something is used, so it stays visible.
 */
export function QuotaMeter({
  used,
  max,
  label,
  className,
}: {
  used: number;
  max: number;
  label: string;
  className?: string;
}) {
  const tone = quotaTone(used, max);
  const ratio = max > 0 ? Math.min(1, used / max) : 1;
  return (
    <div
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, Math.round(max))}
      aria-valuenow={Math.round(Math.min(used, max))}
      data-tone={tone}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none",
          FILL[tone],
        )}
        style={{ width: `${Math.max(ratio * 100, used > 0 ? 4 : 0)}%` }}
      />
    </div>
  );
}
