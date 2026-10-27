"use client";

import type { WorkSession } from "@ocw/contracts";
import { ChevronDown, Compass, Laptop, Plus, Search, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SectionSidebar, sectionItemClass } from "@/components/shell/section-sidebar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useWorkProjects, useWorkProjectsLive } from "@/lib/work-project-queries";
import { isSessionPath } from "@/lib/work-zone-routes";
import { useWorkSessions } from "@/lib/workzone-queries";
import { useWorkZone } from "../work-zone-context";
import { buildWorkZoneSidebar, isActiveSession, orderActiveSessions } from "./model";
import { DepartmentSections } from "./sections";
import { ActiveRow, SettledRow } from "./session-rows";

/** Settled rows shown before "Show N more" (ref-4). */
const SETTLED_PAGE = 10;

const PROJECT_PAGE = /^\/work-zone\/projects\/([^/]+)$/u;

/** Re-render on a clock: every second while `isFast(now)` (a turn under a minute old), otherwise every 30 s. */
export function useNow(isFast: (now: number) => boolean): number {
  const [now, setNow] = useState(() => Date.now());
  const fast = isFast(now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), fast ? 1000 : 30_000);
    return () => clearInterval(t);
  }, [fast]);
  return now;
}

/**
 * The Work Zone sidebar (Phase 07.10, UI-SPEC § Information Architecture): the header with New session, the search
 * field, one section per department holding the team projects the viewer belongs to (each with its active sessions),
 * the Settled list, and Browse projects · Devices at the foot. The same component is the desktop column and the
 * mobile drawer (`SectionSidebar`). It reads the two list requests only (`/work-sessions`, `/work-projects`) and
 * groups what they returned (PD-07): it never decides who can see what.
 */
export function WorkZoneSidebar() {
  const sessions = useWorkSessions();
  const projects = useWorkProjects();
  useWorkProjectsLive();
  const pathname = usePathname();
  const { openNewSession } = useWorkZone();
  const viewerId = useMe().data?.user.id ?? null;
  const list = sessions.data ?? [];
  const [query, setQuery] = useState("");
  const [settledOpen, setSettledOpen] = useState(true);
  const [settledAll, setSettledAll] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const now = useNow((t) =>
    list.some(
      (s) =>
        s.status === "running" && s.runningSince !== null && t - new Date(s.runningSince).getTime() < 60_000,
    ),
  );

  const openSessionId = isSessionPath(pathname) ? (pathname.split("/")[2] ?? null) : null;
  const openProjectId = PROJECT_PAGE.exec(pathname)?.[1] ?? null;

  const model = useMemo(
    () =>
      buildWorkZoneSidebar({
        sessions: list,
        index: projects.data,
        viewerId,
        now,
        openSessionId,
        openProjectId,
        collapsed,
        expanded: new Set(),
      }),
    [list, projects.data, viewerId, now, openSessionId, openProjectId, collapsed],
  );

  const q = query.trim().toLowerCase();
  const { active, settled } = useMemo(() => {
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
  }, [list, q, now]);

  const settledShown = settledAll ? settled : settled.slice(0, SETTLED_PAGE);
  const browsing = pathname === "/work-zone/projects";

  return (
    <SectionSidebar
      title="Work Zone"
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
      <nav aria-label="Work Zone" data-testid="session-list" className="flex min-h-full flex-col gap-3">
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

        {q ? (
          // Today's search (07.10-04 replaces it with grouped results): flat active rows, then Settled below.
          active.length > 0 ? (
            <div className="grid grid-cols-1 gap-0.5">
              {active.map((s) => (
                <ActiveRow
                  key={s.id}
                  s={s}
                  now={now}
                  active={s.id === openSessionId}
                  viewerId={viewerId}
                  onNew={() => openNewSession(s.projectId)}
                />
              ))}
            </div>
          ) : null
        ) : (
          <DepartmentSections
            model={model}
            projects={projects}
            sessions={list}
            now={now}
            viewerId={viewerId}
            openSessionId={openSessionId}
            onToggle={toggle}
          />
        )}

        {settled.length > 0 ? (
          <div className="grid grid-cols-1 gap-0.5 pt-2" data-testid="settled-group">
            <button
              type="button"
              data-testid="settled-toggle"
              onClick={() => setSettledOpen((v) => !v)}
              aria-expanded={settledOpen}
              className="flex items-center gap-2 px-2.5 pb-1 text-left text-[12.5px] text-muted-foreground hover:text-foreground max-md:min-h-11 max-md:pb-0"
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
                    active={s.id === openSessionId}
                    viewerId={viewerId}
                  />
                ))}
                {settled.length > SETTLED_PAGE ? (
                  <button
                    type="button"
                    data-testid="settled-more"
                    onClick={() => setSettledAll((v) => !v)}
                    className="flex h-8 items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground max-md:h-11"
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
        {q && list.length > 0 && active.length === 0 && settled.length === 0 ? (
          <p className="px-2.5 text-[13px] text-muted-foreground">No sessions match “{query.trim()}”.</p>
        ) : null}

        <div className="mt-auto grid gap-0.5">
          <Link
            href="/work-zone/projects"
            data-testid="sidebar-projects"
            aria-current={browsing ? "page" : undefined}
            className={cn(sectionItemClass(browsing), "text-muted-foreground max-md:h-11")}
          >
            <Compass className="size-4" /> Browse projects
          </Link>
          <Link
            href="/settings/devices"
            className={cn(
              sectionItemClass(pathname === "/settings/devices"),
              "text-muted-foreground max-md:h-11",
            )}
          >
            <Laptop className="size-4" /> Devices
          </Link>
        </div>
      </nav>
    </SectionSidebar>
  );
}
