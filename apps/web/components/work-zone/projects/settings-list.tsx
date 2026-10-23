"use client";

import { RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The states every project settings list shares (UI-SPEC § States "Project settings lists"): two skeleton rows while
 * loading, a dashed box when empty, one inline `role="alert"` row with Try again on error.
 */

export function ListEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed px-4 py-5 text-center text-muted-foreground text-sm">
      {children}
    </p>
  );
}

export function ListSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="divide-y overflow-hidden rounded-xl border">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders, never reordered
        <div key={i} className="flex min-h-14 items-center gap-3 px-4 py-2">
          <Skeleton className="size-8 rounded-lg" />
          <div className="grid flex-1 gap-1.5">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ListError({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void;
  retrying?: boolean;
}) {
  return (
    <div
      role="alert"
      className="flex min-h-14 flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed px-4 py-2 text-sm"
    >
      <span className="text-destructive">{message}</span>
      <Button size="sm" variant="outline" className="max-md:h-11" disabled={retrying} onClick={onRetry}>
        <RotateCw /> Try again
      </Button>
    </div>
  );
}
