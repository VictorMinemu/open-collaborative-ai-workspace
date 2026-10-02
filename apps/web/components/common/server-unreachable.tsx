"use client";

import { RefreshCw, ServerOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRuntimeConfig } from "@/lib/config";
import { cn } from "@/lib/utils";

export function ServerUnreachable({
  onRetry,
  retrying,
  className,
}: {
  onRetry: () => void;
  retrying?: boolean;
  className?: string;
}) {
  const { apiUrl } = useRuntimeConfig();
  return (
    <div
      role="alert"
      data-testid="server-unreachable"
      className={cn("flex flex-col items-center px-6 py-10 text-center", className)}
    >
      <div className="mb-4 flex size-12 items-center justify-center rounded-xl border bg-muted/50">
        <ServerOff className="size-5 text-muted-foreground" />
      </div>
      <h2 className="font-semibold text-base">Can't reach the server</h2>
      <p className="mt-1.5 max-w-xs text-balance text-muted-foreground text-sm">
        The workspace API at <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{apiUrl}</code>{" "}
        is not responding. Make sure it is running, then try again.
      </p>
      <Button variant="outline" size="sm" className="mt-5" onClick={onRetry} disabled={retrying}>
        <RefreshCw className={cn(retrying && "animate-spin")} />
        Try again
      </Button>
    </div>
  );
}
