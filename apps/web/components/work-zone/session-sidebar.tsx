"use client";

import type { WorkSession } from "@ocw/contracts";
import {
  ChevronDown,
  CloudOff,
  FolderGit2,
  GitPullRequestArrow,
  Hand,
  Laptop,
  Loader,
  Plus,
  Search,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { SectionSidebar, sectionItemClass } from "@/components/shell/section-sidebar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useWorkSessions } from "@/lib/workzone-queries";
import { RuntimeMark, STATUS } from "./meta";
import { VisibilityMarker, VisibilitySrSuffix } from "./visibility/visibility-marker";
import { useWorkZone } from "./work-zone-context";

/** Idle sessions touched within this window stay in the active list (D-17); older ones settle. */
const ACTIVE_IDLE_MS = 24 * 60 * 60 * 1000;
/** Settled rows shown before "Show N more" (ref-4). */
const SETTLED_PAGE = 10;

const LIVE: ReadonlyArray<WorkSession["status"]> = [
  "provisioning",
  "running",
  "waiting_approval",
  "host_offline",
];

export function isActiveSession(s: WorkSession, now: number): boolean {
  if (LIVE.includes(s.status) || s.pendingApprovals > 0 || s.queuedCount > 0) return true;
  return s.status === "idle" && now - new Date(s.updatedAt).getTime() < ACTIVE_IDLE_MS;
}

/** Two-letter project badge (ref-4 "OW", "HE"): first letters of the first two words, or of the only word. */
export function projectInitials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+|(?<=\p{Ll})(?=\p{Lu})/u).filter((w) => /^\p{L}/u.test(w));
  if (words.length === 0) return name.slice(0, 2).toUpperCase() || "?";
  const [a = "", b = ""] = words;
  return (b ? a.charAt(0) + b.charAt(0) : a.slice(0, 2)).toUpperCase();
}

/** "now", "5m", "3h", "2d", "6w" (ref-4 sidebar times). */
export function shortAgo(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`;
  return `${Math.floor(s / (7 * 86_400))}w`;
}

/** Elapsed time of the running turn: "12s", "5m", "1h 5m". */
export function elapsedLabel(sinceIso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(sinceIso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The group a row sorts under and the name its label and badge show (UI-SPEC R10): the team project when the repository
 * is linked to one (two repositories of one project sort together), the repository otherwise.
 */
export function rowProject(s: Pick<WorkSession, "projectId" | "projectName" | "teamProject">): {
  key: string;
  name: string;
} {
  return s.teamProject
    ? { key: s.teamProject.id, name: s.teamProject.name }
    : { key: s.projectId, name: s.projectName };
}

/** Active rows: by project group (the group with the latest activity first), then by recency. */
export function orderActiveSessions(live: readonly WorkSession[]): WorkSession[] {
  const recency = (s: WorkSession) => new Date(s.updatedAt).getTime();
  const groupRank = new Map<string, number>();
  for (const s of live) {
    const key = rowProject(s).key;
    groupRank.set(key, Math.max(groupRank.get(key) ?? 0, recency(s)));
  }
  return [...live].sort((a, b) => {
    const ka = rowProject(a).key;
    const kb = rowProject(b).key;
    return (
      (groupRank.get(kb) ?? 0) - (groupRank.get(ka) ?? 0) || ka.localeCompare(kb) || recency(b) - recency(a)
    );
  });
}

/** Re-render on a clock: every second while `isFast(now)` (a turn under a minute old), otherwise every 30 s. */
function useNow(isFast: (now: number) => boolean): number {
  const [now, setNow] = useState(() => Date.now());
  const fast = isFast(now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), fast ? 1000 : 30_000);
    return () => clearInterval(t);
  }, [fast]);
  return now;
}

export function SessionSidebar() {
  const sessions = useWorkSessions();
  const pathname = usePathname();
  const { openNewSession } = useWorkZone();
  const viewerId = useMe().data?.user.id ?? null;
  const list = sessions.data ?? [];
  const [query, setQuery] = useState("");
  const [settledOpen, setSettledOpen] = useState(true);
  const [settledAll, setSettledAll] = useState(false);
  const now = useNow((t) =>
    list.some(
      (s) =>
        s.status === "running" && s.runningSince !== null && t - new Date(s.runningSince).getTime() < 60_000,
    ),
  );

  const { active, settled } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = q
      ? list.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            s.projectName.toLowerCase().includes(q) ||
            (s.teamProject?.name.toLowerCase().includes(q) ?? false),
        )
      : list;
    const recency = (s: WorkSession) => new Date(s.updatedAt).getTime();
    const live = orderActiveSessions(shown.filter((s) => isActiveSession(s, now)));
    const rest = shown.filter((s) => !isActiveSession(s, now)).sort((a, b) => recency(b) - recency(a));
    return { active: live, settled: rest };
  }, [list, query, now]);

  const settledShown = settledAll ? settled : settled.slice(0, SETTLED_PAGE);

  return (
    <SectionSidebar
      title="Sessions"
      actions={
        <Tooltip content="New session">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="New session"
            data-testid="sidebar-new-session"
            onClick={() => openNewSession()}
          >
            <Plus />
          </Button>
        </Tooltip>
      }
    >
      <nav data-testid="session-list" className="flex min-h-full flex-col gap-3">
        <div className="relative px-0.5">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            data-testid="session-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search sessions"
            className="h-8 w-full rounded-md border border-transparent bg-transparent pr-7 pl-8 text-[13.5px] outline-none transition-colors placeholder:text-muted-foreground hover:bg-sidebar-accent/60 focus:border-border focus:bg-background [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>

        {sessions.isLoading ? (
          <div className="grid gap-2 px-1">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : null}

        {active.length > 0 ? (
          // grid-cols-1 = minmax(0, 1fr): a long title truncates inside its row instead of widening the track.
          <div className="grid grid-cols-1 gap-0.5">
            {active.map((s) => (
              <ActiveRow
                key={s.id}
                s={s}
                now={now}
                active={pathname === `/work-zone/${s.id}`}
                viewerId={viewerId}
                onNew={() => openNewSession(s.projectId)}
              />
            ))}
          </div>
        ) : null}

        {settled.length > 0 ? (
          <div className="grid grid-cols-1 gap-0.5 pt-2" data-testid="settled-group">
            <button
              type="button"
              data-testid="settled-toggle"
              onClick={() => setSettledOpen((v) => !v)}
              aria-expanded={settledOpen}
              className="flex items-center gap-2 px-2.5 pb-1 text-left text-[12.5px] text-muted-foreground hover:text-foreground"
            >
              Settled
              <span aria-hidden className="h-px flex-1 bg-border" />
              <ChevronDown className={cn("size-3.5 transition-transform", settledOpen && "rotate-180")} />
            </button>
            {settledOpen ? (
              <>
                {settledShown.map((s) => (
                  <SettledRow
                    key={s.id}
                    s={s}
                    now={now}
                    active={pathname === `/work-zone/${s.id}`}
                    viewerId={viewerId}
                  />
                ))}
                {settled.length > SETTLED_PAGE ? (
                  <button
                    type="button"
                    data-testid="settled-more"
                    onClick={() => setSettledAll((v) => !v)}
                    className="flex h-8 items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
                  >
                    <Plus className={cn("size-3.5 transition-transform", settledAll && "rotate-45")} />
                    {settledAll ? "Show fewer" : `Show ${settled.length - SETTLED_PAGE} more`}
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        {!sessions.isLoading && list.length === 0 ? (
          <p className="px-2.5 text-[13px] text-muted-foreground">No sessions yet.</p>
        ) : null}
        {list.length > 0 && active.length === 0 && settled.length === 0 ? (
          <p className="px-2.5 text-[13px] text-muted-foreground">No sessions match “{query.trim()}”.</p>
        ) : null}

        <Link
          href="/settings/devices"
          className={cn(sectionItemClass(pathname === "/settings/devices"), "mt-auto text-muted-foreground")}
        >
          <Laptop className="size-4" /> Devices
        </Link>
      </nav>
    </SectionSidebar>
  );
}

function ProjectBadge({ name, muted, className }: { name: string; muted?: boolean; className?: string }) {
  return (
    <span
      data-testid="row-project-badge"
      aria-hidden
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] font-bold text-[8px] leading-none tracking-tight",
        muted ? "bg-muted text-muted-foreground/70" : "bg-primary/12 text-primary",
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
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground/80">
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
      {/* Per-project new session (replaces the old project header "+"): over the badge on hover / focus. */}
      <Tooltip content={`New session in ${s.projectName}`}>
        <button
          type="button"
          aria-label={`New session in ${s.projectName}`}
          onClick={onNew}
          className="absolute top-2 left-2 inline-flex size-[18px] items-center justify-center rounded-[4px] bg-background text-muted-foreground opacity-0 shadow-sm ring-1 ring-border transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
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
      className={cn(sectionItemClass(active), "gap-2 text-muted-foreground")}
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
