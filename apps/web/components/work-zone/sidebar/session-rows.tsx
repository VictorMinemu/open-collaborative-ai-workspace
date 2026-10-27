"use client";

import type { WorkSession } from "@ocw/contracts";
import { GitPullRequestArrow } from "lucide-react";
import Link from "next/link";
import { sectionItemClass } from "@/components/shell/section-sidebar";
import { cn } from "@/lib/utils";
import { STATUS } from "../meta";
import { VisibilityMarker, VisibilitySrSuffix } from "../visibility/visibility-marker";
import { projectInitials, rowProject, shortAgo } from "./model";

/**
 * The session rows kept from before 07.10, still exported from `session-sidebar.tsx`: `SettledRow` (the Settled section
 * and settled search results) and `ProjectBadge` (Settled rows and the needs-you look). The three-line active row was
 * retired in 07.10-04: active sessions are one-line sub-rows, needs-you rows or search rows now.
 */

export function ProjectBadge({
  name,
  muted,
  className,
}: {
  name: string;
  muted?: boolean;
  className?: string;
}) {
  return (
    <span
      data-testid="row-project-badge"
      aria-hidden
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] font-bold text-[8px] leading-none tracking-tight",
        // Settled rows: a quieter tile, but its letters keep AA contrast (WINDOWS #316, #327).
        muted ? "bg-muted text-muted-foreground" : "bg-primary/12 text-primary",
        className,
      )}
    >
      {projectInitials(name)}
    </span>
  );
}

/** "+N" with the diff icon (ref-4); the tooltip carries files and deletions. */
function RowDiffStat({ s, className }: { s: WorkSession; className?: string }) {
  const d = s.diffStat;
  if (!d || d.files === 0) return null;
  return (
    <span
      data-testid="row-diffstat"
      title={`${d.files} changed file${d.files === 1 ? "" : "s"}, +${d.additions} −${d.deletions}`}
      className={cn("inline-flex shrink-0 items-center gap-0.5 tabular-nums", className)}
    >
      <GitPullRequestArrow aria-hidden className="size-3" />+{d.additions}
    </span>
  );
}

export function SettledRow({
  s,
  now,
  active,
  viewerId,
}: {
  s: WorkSession;
  now: number;
  active: boolean;
  viewerId: string | null;
}) {
  const failed = s.status === "failed";
  const project = rowProject(s);
  return (
    <Link
      href={`/work-zone/${s.id}`}
      data-testid="session-row"
      data-status={s.status}
      aria-current={active ? "page" : undefined}
      title={`${project.name} · ${STATUS[s.status]?.label ?? s.status}`}
      className={cn(sectionItemClass(active), "gap-2 text-muted-foreground max-md:h-11")}
    >
      <ProjectBadge name={project.name} muted />
      <span
        data-testid="row-title"
        title={s.title}
        className="min-w-0 flex-1 truncate text-[13.5px] text-foreground/80"
      >
        {s.title}
      </span>
      <VisibilitySrSuffix session={s} viewerId={viewerId} />
      <VisibilityMarker session={s} viewerId={viewerId} />
      <RowDiffStat s={s} className="text-[12px]" />
      <span className={cn("w-8 shrink-0 text-right text-[12px] tabular-nums", failed && "text-destructive")}>
        {shortAgo(s.updatedAt, now)}
      </span>
    </Link>
  );
}
