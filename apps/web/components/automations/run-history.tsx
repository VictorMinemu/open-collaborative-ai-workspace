"use client";

import type { Automation, AutomationRun } from "@ocw/contracts";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  browserTimeZone,
  formatRunInstant,
  RESULT_TONE,
  runLine,
  runOpenHref,
  runResult,
  TRIGGER_WORD,
  targetName,
  useAutomationRuns,
} from "@/lib/automation-queries";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";

/**
 * Run history (07.6-15, AUTO-01, UI-SPEC Surface 2 › Runs tab): newest first, 30 a page, each run with its trigger, its
 * result, the reason or how long the bot took, and an Open link to the message it was delivered under. Inbound runs
 * say they started from outside content. `?run=<id>` scrolls to that run, focuses it and rings it until the first
 * interaction.
 */
export function RunHistory({
  automation: a,
  highlight,
}: {
  automation: Automation;
  highlight: string | null;
}) {
  const runs = useAutomationRuns(a.id);
  const me = useMe({ enabled: false }).data?.user.id ?? null;
  const [ring, setRing] = useState(highlight);
  const focused = useRef(false);
  const list = runs.data?.pages.flatMap((p) => p.runs) ?? [];
  const zone = a.trigger.schedule?.timeZone ?? browserTimeZone();
  const found = !!highlight && list.some((r) => r.id === highlight);

  useEffect(() => {
    if (!found || focused.current || !highlight) return;
    focused.current = true;
    const el = document.getElementById(`run-${highlight}`);
    el?.scrollIntoView({ block: "center" });
    el?.focus({ preventScroll: true });
  }, [found, highlight]);

  useEffect(() => {
    if (!ring) return;
    const clear = () => setRing(null);
    // The first interaction ends the highlight (07.4 pattern); focusing the row programmatically is not one.
    window.addEventListener("pointerdown", clear, { once: true });
    window.addEventListener("keydown", clear, { once: true });
    return () => {
      window.removeEventListener("pointerdown", clear);
      window.removeEventListener("keydown", clear);
    };
  }, [ring]);

  if (runs.isPending) {
    return (
      <div
        className="grid gap-2"
        aria-busy="true"
        role="status"
        aria-label="Loading runs"
        data-testid="run-history-loading"
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-lg motion-reduce:animate-none" />
        ))}
      </div>
    );
  }
  if (runs.isError) {
    return (
      <div role="alert" className="grid justify-items-start gap-2 text-sm" data-testid="run-history-error">
        <p>Couldn't load runs.</p>
        <Button variant="outline" size="sm" className="max-md:h-11" onClick={() => runs.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (list.length === 0) {
    const first =
      a.trigger.kind !== "schedule"
        ? "No runs yet. They start when something arrives."
        : a.nextRunAt && a.status === "active"
          ? `No runs yet. The first one is ${formatRunInstant(a.nextRunAt, zone)}.`
          : "No runs yet.";
    return (
      <p
        className="rounded-lg border border-dashed px-4 py-12 text-center text-muted-foreground text-sm"
        data-testid="run-history-empty"
      >
        {first}
      </p>
    );
  }

  return (
    <div className="grid gap-3">
      <ul
        aria-label="Run history"
        data-testid="run-history"
        className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs"
      >
        {list.map((run) => (
          <RunRow key={run.id} run={run} automation={a} zone={zone} me={me} highlighted={ring === run.id} />
        ))}
      </ul>
      {runs.hasNextPage ? (
        <Button
          variant="ghost"
          className="w-full max-md:h-11"
          disabled={runs.isFetchingNextPage}
          onClick={() => void runs.fetchNextPage()}
        >
          {runs.isFetchingNextPage ? <Spinner /> : null}
          Show older runs
        </Button>
      ) : null}
    </div>
  );
}

function RunRow({
  run,
  automation: a,
  zone,
  me,
  highlighted,
}: {
  run: AutomationRun;
  automation: Automation;
  zone: string;
  me: string | null;
  highlighted: boolean;
}) {
  const at = run.scheduledFor ?? run.createdAt;
  const result = runResult(run.status, a.actionKind === "digest");
  const line = runLine(run, a, me);
  const href = runOpenHref(run, a);
  const outside = run.trigger === "webhook" || run.trigger === "mail" || run.tainted;
  const browserAt = new Date(at).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <li
      id={`run-${run.id}`}
      tabIndex={-1}
      data-testid="run-row"
      data-run-id={run.id}
      data-status={run.status}
      data-highlighted={highlighted || undefined}
      className={cn(
        "grid min-h-14 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-4 py-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset",
        "[grid-template-areas:'time_open'_'trigger_open'_'result_open'_'line_line']",
        "sm:grid-cols-[10.5rem_minmax(0,1fr)_auto_2rem] sm:items-center sm:gap-x-4",
        "sm:[grid-template-areas:'time_trigger_result_open'_'._line_line_open']",
        highlighted && "ring-2 ring-primary/60 ring-inset",
      )}
    >
      <time dateTime={at} title={`${browserAt} your time`} className="text-sm [grid-area:time]">
        {formatRunInstant(at, zone)}
      </time>
      <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm [grid-area:trigger]">
        <span data-testid="run-trigger">{TRIGGER_WORD[run.trigger]}</span>
        {outside ? (
          <Badge variant="outline" data-testid="run-outside">
            Outside content
          </Badge>
        ) : null}
      </p>
      <p className="flex items-center gap-1.5 text-xs [grid-area:result]" data-testid="run-result">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", RESULT_TONE[result.tone].dot)} />
        <span className={cn("font-semibold", RESULT_TONE[result.tone].text)}>{result.label}</span>
      </p>
      {line ? (
        <p className="text-muted-foreground text-xs [grid-area:line]" data-testid="run-line">
          {line}
        </p>
      ) : null}
      {href ? (
        <Link
          href={href}
          aria-label={`Open run in ${targetName(a, me)}`}
          data-testid="run-open"
          className={cn(
            buttonVariants({ variant: "ghost", size: "icon-sm" }),
            "self-center text-muted-foreground [grid-area:open] max-md:size-11",
          )}
        >
          <ArrowRight />
        </Link>
      ) : null}
    </li>
  );
}
