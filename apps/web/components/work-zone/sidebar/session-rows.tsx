"use client";

import type { WorkSession } from "@ocw/contracts";
import { CloudOff, FolderGit2, GitPullRequestArrow, Hand, Laptop, Loader, Plus } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { sectionItemClass } from "@/components/shell/section-sidebar";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { RuntimeMark, STATUS } from "../meta";
import { VisibilityMarker, VisibilitySrSuffix } from "../visibility/visibility-marker";
import { elapsedLabel, projectInitials, rowProject, shortAgo } from "./model";

/**
 * The pre-07.10 session rows, unchanged and still exported from `session-sidebar.tsx`: today's search results and the
 * Settled list draw them until 07.10-04 replaces the search and moves Settled into a section (it retires `ActiveRow`).
 * `ProjectBadge` is shared with the needs-you rows of 07.10-04.
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

function RowStatus({ s, now }: { s: WorkSession; now: number }) {
  let tone: "primary" | "warning" | "muted" = "muted";
  let icon: ReactNode = null;
  let text: string;
  if (s.status === "waiting_approval" || s.pendingApprovals > 0) {
    tone = "warning";
    icon = <Hand className="size-3" />;
    text = "Needs approval";
  } else if (s.status === "running") {
    tone = "primary";
    icon = <Loader className="size-3 animate-spin [animation-duration:2s]" />;
    text = s.runningSince ? `Working ${elapsedLabel(s.runningSince, now)}` : "Working";
  } else if (s.status === "provisioning") {
    icon = <Loader className="size-3 animate-spin [animation-duration:2s]" />;
    text = "Starting";
  } else if (s.status === "host_offline") {
    icon = <CloudOff className="size-3" />;
    text = "Offline";
  } else if (s.queuedCount > 0) {
    text = `${s.queuedCount} queued`;
  } else {
    text = shortAgo(s.updatedAt, now);
  }
  return (
    <span
      data-testid="row-status"
      data-tone={tone}
      className={cn(
        "ml-auto inline-flex shrink-0 items-center gap-1 tabular-nums",
        tone === "primary" && "text-primary",
        tone === "warning" && "font-medium text-amber-700 dark:text-amber-400",
      )}
    >
      {icon}
      {text}
    </span>
  );
}

export function ActiveRow({
  s,
  now,
  active,
  viewerId,
  onNew,
}: {
  s: WorkSession;
  now: number;
  active: boolean;
  viewerId: string | null;
  onNew: () => void;
}) {
  const where = s.branch ?? (s.worktree ? "Worktree" : s.deviceName);
  const project = rowProject(s);
  const marker = <VisibilityMarker session={s} viewerId={viewerId} />;
  const title = (
    <span
      data-testid="row-title"
      title={s.title}
      className="truncate text-[14px] text-foreground leading-snug"
    >
      {s.title}
    </span>
  );
  return (
    <div className="group/row relative">
      <Link
        href={`/work-zone/${s.id}`}
        data-testid="session-row"
        data-status={s.status}
        aria-current={active ? "page" : undefined}
        className={cn(
          "grid gap-0.5 rounded-lg px-2.5 py-2 outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40",
          active
            ? "bg-background shadow-[0_1px_2px_rgb(0_0_0/0.06)] ring-1 ring-border/60 dark:bg-sidebar-accent dark:ring-0"
            : "hover:bg-sidebar-accent/60",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <ProjectBadge name={project.name} />
          <span data-testid="row-project" className="min-w-0 truncate">
            {project.name}
          </span>
          <RowStatus s={s} now={now} />
        </span>
        {/* Silence on the default (N2): the title stays as it was unless the session is different. */}
        {s.visibility?.differsFromDefault ? (
          <span className="flex min-w-0 items-center gap-1.5">
            {title}
            {marker}
            <VisibilitySrSuffix session={s} viewerId={viewerId} />
          </span>
        ) : (
          title
        )}
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
          {s.worktree ? (
            <FolderGit2 aria-hidden className="size-3 shrink-0" />
          ) : (
            <Laptop aria-hidden className="size-3 shrink-0" />
          )}
          <span data-testid="row-branch" className="min-w-0 truncate">
            {where}
          </span>
          <RowDiffStat s={s} className="text-violet-600 dark:text-violet-400" />
          <RuntimeMark runtime={s.runtime} className="ml-auto size-3" />
        </span>
      </Link>
      {/* Per-project new session (replaces the old project header "+"): over the badge on hover / focus. A touch
          screen has no hover, so there it would be an invisible target over the row: it is left out, and New session
          and the project's page offer the same start (07.9 polish). */}
      <Tooltip content={`New session in ${s.projectName}`}>
        <button
          type="button"
          aria-label={`New session in ${s.projectName}`}
          onClick={onNew}
          className="absolute top-2 left-2 inline-flex size-[18px] items-center justify-center rounded-[4px] bg-background text-muted-foreground opacity-0 shadow-sm ring-1 ring-border transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 pointer-coarse:hidden"
        >
          <Plus className="size-3" />
        </button>
      </Tooltip>
    </div>
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
