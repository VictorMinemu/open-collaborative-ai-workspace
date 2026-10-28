"use client";

import type { WorkSession } from "@ocw/contracts";
import { CloudOff, FolderGit2, FolderKanban, Hand, Plus } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { sectionItemClass } from "@/components/shell/section-sidebar";
import { Tooltip } from "@/components/ui/tooltip";
import { sessionLabels } from "@/lib/session-visibility";
import { cn } from "@/lib/utils";
import { projectHref } from "@/lib/work-zone-routes";
import { RUNTIMES } from "../meta";
import { VisibilityMarker, VisibilitySrSuffix } from "../visibility/visibility-marker";
import { needsApproval, type ProjectRowModel, type RepoRowModel, rowStatusText } from "./model";

/**
 * The rows of the Work Zone sidebar tree (Phase 07.10, UI-SPEC § 5-§ 7): project rows that open the project page,
 * one-line session sub-rows and "+N more" rows. Every row is 44 px below 768. Names are React text only, truncated with
 * the full text in `title`. 07.10-05 adds optional "+" props; 07.10-04 reuses the rows in search results.
 */

/**
 * The team pill (the chat sub-label classes): secondary to the name, so it shrinks first and never takes more than
 * 35 % of the row (07.10-07, UI review fix 1); its full text stays in `title` and in the link's name.
 */
const PILL =
  "min-w-0 max-w-[35%] shrink truncate rounded-[4px] bg-muted/80 px-1 py-px font-medium text-[10.5px] text-muted-foreground leading-tight";

/** With a pointer, the "+" shows on the row's hover or keyboard focus; what sits in its slot steps aside. */
const STEP_ASIDE =
  "pointer-fine:group-hover/project:invisible pointer-fine:group-has-[:focus-visible]/project:invisible";

/** "● n": live sessions the viewer can see. The visual part is hidden from assistive tech (the link says it). */
export function LiveCount({ n, testId, className }: { n: number; testId: string; className?: string }) {
  if (n <= 0) return null;
  return (
    <span
      data-testid={testId}
      aria-hidden
      className={cn(
        "ml-auto inline-flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground tabular-nums",
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-primary" />
      {n}
    </span>
  );
}

/** The classes every row "+" shares (the chat section "+" look): 24 px, quiet until hovered. */
const PLUS =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-opacity hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/40";

/**
 * A team project's row (D-03, UI-SPEC § 5). With `onNewSession` and at least one repository, a "+" ("New session in
 * {project}") sits beside the link (never inside it) in the live count's slot: with a pointer it shows on the row's
 * hover or keyboard focus and the count steps aside (visibility only, no width change); on touch it is not rendered
 * (U-8: the project page's New session is one tap away). It opens the dialog, never navigates.
 */
export function ProjectRow({
  project,
  muted = false,
  onNewSession,
}: {
  project: ProjectRowModel;
  muted?: boolean;
  onNewSession?: (() => void) | undefined;
}) {
  const { id, name, pill, live, active } = project;
  const plus = onNewSession !== undefined && project.repoCount > 0;
  // The "+" slot (07.10-07, UI review fix 1): the count when there is one, else the pill; with neither, the name's
  // text stops short of the "+" while it shows (its box never moves). No fixed gutter takes width from the name.
  const plusOverPill = plus && live <= 0 && pill !== null;
  const plusOverName = plus && live <= 0 && pill === null;
  const link = (
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
      <span
        title={name}
        className={cn(
          "min-w-[55%] flex-1 truncate",
          plusOverName &&
            "pointer-fine:group-hover/project:pr-7 pointer-fine:group-has-[:focus-visible]/project:pr-7",
        )}
      >
        {name}
        {pill ? <span className="sr-only">, {pill}</span> : null}
        {live > 0 ? <span className="sr-only">, {live} running</span> : null}
      </span>
      {pill ? (
        <span
          data-testid="project-pill"
          aria-hidden
          title={pill}
          className={cn(PILL, plusOverPill && cn("pointer-fine:min-w-6", STEP_ASIDE))}
        >
          {pill}
        </span>
      ) : null}
      <LiveCount
        n={live}
        testId="project-live-count"
        className={plus ? cn("justify-end pointer-fine:min-w-6", STEP_ASIDE) : undefined}
      />
    </Link>
  );
  if (!plus) return link;
  const label = `New session in ${name}`;
  return (
    <div className="group/project relative">
      {link}
      <Tooltip content={label}>
        <button
          type="button"
          aria-label={label}
          data-testid="project-new-session"
          onClick={onNewSession}
          className={cn(
            PLUS,
            "absolute top-1/2 right-2.5 -translate-y-1/2 opacity-0 group-hover/project:opacity-100 group-has-[:focus-visible]/project:opacity-100 pointer-coarse:hidden",
          )}
        >
          <Plus aria-hidden className="size-3.5" />
        </button>
      </Tooltip>
    </div>
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

/** An inline "more" (Personal, a repository's sessions, a section's projects): a button, never a navigation. */
export function ExpandRow({
  expanded,
  label,
  controls,
  onToggle,
  testId,
}: {
  expanded: boolean;
  /** The collapsed label ("+2 more", "3 more repositories"); expanded reads "Show fewer". */
  label: string;
  controls?: string;
  onToggle: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
      className={MORE_CLASS}
    >
      {expanded ? "Show fewer" : label}
    </button>
  );
}

/** The one hint a repository row gives about a project the viewer may not see named (07.9 D-14 wording). */
export const HIDDEN_PROJECT_HINT = "Linked to a project you can't open";

/**
 * A personal repository (UI-SPEC § 7): plain text, not a link (a repository has no page), with its live count. A
 * repository linked to a project the viewer may not see named carries only `HIDDEN_PROJECT_HINT` in its `title`.
 */
export function RepoRow({
  repo,
  muted = false,
  onNewSession,
}: {
  repo: RepoRowModel;
  muted?: boolean;
  /**
   * The repository's "+" ("New session in {repo}", UI-SPEC § 7): hover-revealed with a pointer, visible on touch with
   * a 44 px target. Never on a repository whose project the viewer can't open: nobody can start there (D-14).
   */
  onNewSession?: (() => void) | undefined;
}) {
  const plus = onNewSession !== undefined && !repo.hiddenProject;
  const label = `New session in ${repo.name}`;
  return (
    <div
      data-testid={`repo-row-${repo.projectId}`}
      title={repo.hiddenProject ? HIDDEN_PROJECT_HINT : undefined}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13.5px] text-sidebar-foreground max-md:h-11",
        muted && "text-muted-foreground",
        plus && "group/repo",
      )}
    >
      <FolderGit2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span title={repo.hiddenProject ? undefined : repo.name} className="min-w-0 flex-1 truncate">
        {repo.name}
        {/* 07.10-07 (LO-04): the hint reaches screen readers and touch, not only a pointer's tooltip. */}
        {repo.hiddenProject ? <span className="sr-only">, {HIDDEN_PROJECT_HINT}</span> : null}
        {repo.live > 0 ? <span className="sr-only">, {repo.live} running</span> : null}
      </span>
      <LiveCount n={repo.live} testId="repo-live-count" />
      {plus ? (
        <Tooltip content={label}>
          <button
            type="button"
            aria-label={label}
            data-testid="repo-new-session"
            onClick={onNewSession}
            className={cn(
              PLUS,
              "-mr-1.5 opacity-0 group-hover/repo:opacity-100 max-md:size-11 [@media(hover:none)]:opacity-100",
            )}
          >
            <Plus aria-hidden className="size-3.5" />
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
}
