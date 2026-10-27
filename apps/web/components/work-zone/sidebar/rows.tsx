"use client";

import type { WorkSession } from "@ocw/contracts";
import { CloudOff, FolderKanban, Hand } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { sectionItemClass } from "@/components/shell/section-sidebar";
import { sessionLabels } from "@/lib/session-visibility";
import { cn } from "@/lib/utils";
import { projectHref } from "@/lib/work-zone-routes";
import { RUNTIMES } from "../meta";
import { VisibilityMarker, VisibilitySrSuffix } from "../visibility/visibility-marker";
import { needsApproval, type ProjectRowModel, rowStatusText } from "./model";

/**
 * The rows of the Work Zone sidebar tree (Phase 07.10, UI-SPEC § 5-§ 7): project rows that open the project page,
 * one-line session sub-rows and "+N more" rows. Every row is 44 px below 768. Names are React text only, truncated with
 * the full text in `title`. 07.10-05 adds optional "+" props; 07.10-04 reuses the rows in search results.
 */

/** The team pill (the chat sub-label classes), never more than 40 % of the row. */
const PILL =
  "max-w-[40%] shrink-0 truncate rounded-[4px] bg-muted/80 px-1 py-px font-medium text-[10.5px] text-muted-foreground leading-tight";

/** "● n": live sessions the viewer can see. The visual part is hidden from assistive tech (the link says it). */
export function LiveCount({ n, testId }: { n: number; testId: string }) {
  if (n <= 0) return null;
  return (
    <span
      data-testid={testId}
      aria-hidden
      className="ml-auto inline-flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground tabular-nums"
    >
      <span className="size-1.5 rounded-full bg-primary" />
      {n}
    </span>
  );
}

export function ProjectRow({ project, muted = false }: { project: ProjectRowModel; muted?: boolean }) {
  const { id, name, pill, live, active } = project;
  return (
    <Link
      href={projectHref(id)}
      data-testid={`project-row-${id}`}
      data-active={active ? "true" : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(sectionItemClass(active), "max-md:h-11", muted && !active && "text-muted-foreground")}
    >
      <FolderKanban
        aria-hidden
        className={cn("size-4 shrink-0", active ? "text-sidebar-accent-foreground" : "text-muted-foreground")}
      />
      <span title={name} className="min-w-0 flex-1 truncate">
        {name}
        {pill ? <span className="sr-only">, {pill}</span> : null}
        {live > 0 ? <span className="sr-only">, {live} running</span> : null}
      </span>
      {pill ? (
        <span data-testid="project-pill" aria-hidden title={pill} className={PILL}>
          {pill}
        </span>
      ) : null}
      <LiveCount n={live} testId="project-live-count" />
    </Link>
  );
}

/** The sub-row's glyph (UI-SPEC § 6): no spinner in the tree; the status text carries the meaning. */
function StatusGlyph({ s }: { s: WorkSession }) {
  let glyph: ReactNode;
  if (needsApproval(s)) glyph = <Hand className="size-3 text-amber-700 dark:text-amber-400" />;
  else if (s.status === "running" || s.status === "provisioning")
    glyph = <span className="size-2 rounded-full bg-primary" />;
  else if (s.status === "host_offline") glyph = <CloudOff className="size-3 text-muted-foreground" />;
  else glyph = <span className="size-2 rounded-full ring-1 ring-muted-foreground/60 ring-inset" />;
  return (
    <span aria-hidden className="inline-flex size-3 shrink-0 items-center justify-center">
      {glyph}
    </span>
  );
}

/**
 * The hover detail of a sub-row (desktop): "{title} · {runtime} · {branch or device}", plus " · +a −d" when the
 * session changed files (07.10 X4: the branch and diff stat of the old three-line row live on here).
 */
export function subRowDetail(s: WorkSession): string {
  const where = s.branch ?? (s.worktree ? "Worktree" : s.deviceName);
  const runtime = RUNTIMES[s.runtime]?.label ?? s.runtime;
  const diff =
    s.diffStat && s.diffStat.files > 0 ? ` · +${s.diffStat.additions} −${s.diffStat.deletions}` : "";
  return `${s.title} · ${runtime} · ${where}${diff}`;
}

const TONE: Record<"primary" | "warning" | "muted", string> = {
  primary: "text-primary",
  warning: "font-medium text-amber-700 dark:text-amber-400",
  muted: "text-muted-foreground",
};

export function SessionSubRow({
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
  const status = rowStatusText(s, now);
  const { srSuffix } = sessionLabels(s, viewerId);
  // A settled session shows here only while it is open (UI-SPEC § 6).
  const settled = !["provisioning", "running", "waiting_approval", "host_offline", "idle"].includes(s.status);
  return (
    <Link
      href={`/work-zone/${s.id}`}
      data-testid="session-row"
      data-status={s.status}
      aria-current={active ? "page" : undefined}
      aria-label={`${s.title}, ${status.text}${srSuffix}`}
      title={subRowDetail(s)}
      className={cn(
        sectionItemClass(active),
        "h-7 gap-2 pr-2.5 pl-8 max-md:h-11",
        settled && !active && "text-muted-foreground",
      )}
    >
      <StatusGlyph s={s} />
      <span data-testid="row-title" title={s.title} className="min-w-0 flex-1 truncate">
        {s.title}
      </span>
      <VisibilityMarker session={s} viewerId={viewerId} />
      <VisibilitySrSuffix session={s} viewerId={viewerId} />
      <span
        data-testid="row-status"
        data-tone={status.tone}
        className={cn("shrink-0 text-[12px] tabular-nums", TONE[status.tone])}
      >
        {status.text}
      </span>
    </Link>
  );
}

const MORE_CLASS =
  "flex h-7 w-full items-center rounded-md pr-2.5 pl-8 text-left text-[12px] text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 max-md:h-11";

/** "+N more" under a team project: opens the project page, where every session is listed. */
export function MoreRow({
  projectId,
  projectName,
  n,
}: {
  projectId: string;
  projectName: string;
  n: number;
}) {
  return (
    <Link
      href={projectHref(projectId)}
      data-testid="project-more"
      aria-label={`${n} more active session${n === 1 ? "" : "s"} in ${projectName}`}
      className={MORE_CLASS}
    >
      +{n} more
    </Link>
  );
}
