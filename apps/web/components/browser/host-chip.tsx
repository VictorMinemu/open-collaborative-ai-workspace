"use client";

import { LockKeyhole, TriangleAlert } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * A page's host as every 07.8 surface shows it (UI-SPEC §1.1 `HostChip`; T-07.8-20-03): the host only, never a path or
 * a query, always from the server's browser context or approval view, never from bot text. `https` reads with a lock;
 * `http` reads "Not secure" as a word next to the amber glyph (never colour alone). The host truncates at its end and
 * the Tooltip shows it whole; the DOM always holds the full host, so assistive tech reads all of it.
 *
 * `secure: null` = the caller has no scheme for this host (an activity step carries the host only): no glyph, no claim.
 */
export function HostChip({
  host,
  secure,
  className,
  testId = "host-chip",
}: {
  host: string;
  secure: boolean | null;
  className?: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      data-secure={secure === null ? undefined : String(secure)}
      className={cn("inline-flex min-w-0 max-w-full items-center gap-1 font-mono text-xs", className)}
    >
      {secure === true ? (
        <LockKeyhole aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      ) : secure === false ? (
        <>
          <TriangleAlert aria-hidden className="size-3 shrink-0 text-amber-700 dark:text-amber-300" />
          <span className="shrink-0 font-sans font-semibold text-amber-700 text-xs dark:text-amber-300">
            Not secure
          </span>
        </>
      ) : null}
      <Tooltip content={<span className="font-mono">{host}</span>}>
        <span data-testid={`${testId}-host`} className="min-w-0 truncate">
          {host}
        </span>
      </Tooltip>
    </span>
  );
}
