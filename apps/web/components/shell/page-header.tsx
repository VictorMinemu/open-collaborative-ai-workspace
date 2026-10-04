import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Top bar of a page's content column. */
export function PageHeader({
  title,
  description,
  icon,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex min-h-14 shrink-0 items-center justify-between gap-3 border-b px-4 py-2.5 sm:px-6",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {icon ? <span className="text-muted-foreground [&_svg]:size-[18px]">{icon}</span> : null}
        <div className="min-w-0">
          <h1 className="truncate font-semibold text-[15px] tracking-tight">{title}</h1>
          {description ? <p className="truncate text-muted-foreground text-xs">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
