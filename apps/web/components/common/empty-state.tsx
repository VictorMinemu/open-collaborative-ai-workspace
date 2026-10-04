import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  /** Actions (buttons). */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-1 flex-col items-center justify-center px-6 py-16 text-center", className)}>
      <div className="relative mb-5">
        <div aria-hidden className="absolute inset-0 -z-10 scale-150 rounded-full bg-primary/10 blur-2xl" />
        <div className="flex size-14 items-center justify-center rounded-2xl border bg-card shadow-sm">
          <Icon className="size-6 text-primary" strokeWidth={1.75} />
        </div>
      </div>
      <h2 className="font-semibold text-lg tracking-tight">{title}</h2>
      <p className="mt-1.5 max-w-sm text-balance text-muted-foreground text-sm">{description}</p>
      {children ? (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}
