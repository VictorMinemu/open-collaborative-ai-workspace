import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function AuthCard({
  title,
  description,
  eyebrow,
  children,
  footer,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("animate-in fade-in-0 slide-in-from-bottom-2 duration-300", className)}>
      <div className="rounded-2xl border bg-card/85 p-6 shadow-black/[0.04] shadow-xl backdrop-blur-sm sm:p-8 dark:shadow-black/30">
        <div className="mb-6">
          {eyebrow ? <div className="mb-3">{eyebrow}</div> : null}
          <h1 className="font-semibold text-xl tracking-tight">{title}</h1>
          {description ? <p className="mt-1.5 text-muted-foreground text-sm">{description}</p> : null}
        </div>
        {children}
      </div>
      {footer ? <div className="mt-5 text-center text-muted-foreground text-sm">{footer}</div> : null}
    </div>
  );
}

export function AuthCardSkeleton() {
  return (
    <div className="rounded-2xl border bg-card/85 p-8 shadow-xl" aria-busy>
      <div className="h-6 w-2/3 animate-pulse rounded bg-muted" />
      <div className="mt-3 h-4 w-full animate-pulse rounded bg-muted" />
      <div className="mt-8 space-y-4">
        <div className="h-9 animate-pulse rounded-md bg-muted" />
        <div className="h-9 animate-pulse rounded-md bg-muted" />
        <div className="h-9 animate-pulse rounded-md bg-muted/70" />
      </div>
    </div>
  );
}
