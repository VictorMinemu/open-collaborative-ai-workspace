"use client";

import type { WorkSession } from "@ocw/contracts";
import { Compass, Laptop, Plus, Search, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SectionSidebar, sectionItemClass } from "@/components/shell/section-sidebar";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useWorkProjects, useWorkProjectsLive } from "@/lib/work-project-queries";
import { isSessionPath } from "@/lib/work-zone-routes";
import { useWorkSessions } from "@/lib/workzone-queries";
import { useWorkZone } from "../work-zone-context";
import { buildWorkZoneSidebar, searchSidebar } from "./model";
import { NeedsYouSection } from "./needs-you-section";
import { SidebarSearchResults } from "./search-results";
import { DepartmentSections, PersonalSection, ProjectsLoading } from "./sections";
import { SettledSection } from "./settled-section";
import { NoSessionsLine, RetryButton } from "./states";
import { useSeenSessions } from "./use-seen-sessions";
import { useSidebarCollapse } from "./use-sidebar-collapse";
import { useSidebarKeys } from "./use-sidebar-keys";

const PROJECT_PAGE = /^\/work-zone\/projects\/([^/]+)$/u;

/** A stable empty list while the sessions request has no data (keeps the model's memo). */
const NO_SESSIONS: readonly WorkSession[] = [];

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
 * field, Needs you, one section per department holding the team projects the viewer belongs to (each with its active
 * sessions), Personal, Settled, and Browse projects · Devices at the foot. While a query is typed, the grouped search
 * results replace everything between the search field and the foot. The same component is the desktop column and the
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
  const list = sessions.data ?? NO_SESSIONS;
  const seen = useSeenSessions();
  const [query, setQuery] = useState("");
  const { collapsed, toggle } = useSidebarCollapse();
  // Inline expansions ("{n} more projects", "Show {n} more", "Show all {n}", …) last for this page.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const expand = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  // A new query starts with every result group capped again.
  const changeQuery = useCallback((value: string) => {
    setQuery(value);
    setExpanded((prev) =>
      [...prev].some((k) => k.startsWith("search:"))
        ? new Set([...prev].filter((k) => !k.startsWith("search:")))
        : prev,
    );
  }, []);
  const navRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const clearSearch = useCallback(() => changeQuery(""), [changeQuery]);
  // ↑/↓/Home/End between rows, ←/→ on a section toggle, ArrowDown and Escape in the search field (UI-SPEC § Keyboard).
  const onKeyDown = useSidebarKeys(navRef, searchRef, clearSearch);
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
        expanded,
        seen,
      }),
    [list, projects.data, viewerId, now, openSessionId, openProjectId, collapsed, expanded, seen],
  );
  const ctx = { now, viewerId, openSessionId, onToggle: toggle, onExpand: expand };

  const q = query.trim();
  const result = useMemo(
    () =>
      q ? searchSidebar(q, { sessions: list, index: projects.data, now, openProjectId, expanded }) : null,
    [q, list, projects.data, now, openProjectId, expanded],
  );

  // The sessions request: first load, or failed with nothing to show (a refetch that fails keeps the list drawn).
  const loading = sessions.isPending && !sessions.isError;
  const failed = sessions.isError && !sessions.data;
  const nothing =
    sessions.data !== undefined &&
    projects.data !== undefined &&
    list.length === 0 &&
    model.sections.length === 0 &&
    model.personal === null;
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
            className="max-md:size-11"
          >
            <Plus />
          </Button>
        </Tooltip>
      }
    >
      <nav
        ref={navRef}
        aria-label="Work Zone"
        data-testid="session-list"
        onKeyDown={onKeyDown}
        className="flex min-h-full flex-col gap-3"
      >
        <div className="relative px-0.5">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            data-testid="session-search"
            type="search"
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search sessions"
            className="h-8 w-full rounded-md border border-transparent bg-transparent pr-7 pl-8 text-[13.5px] outline-none transition-colors placeholder:text-muted-foreground hover:bg-sidebar-accent/60 focus:border-border focus:bg-background max-md:h-11 max-md:text-base [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => changeQuery("")}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground max-md:right-0 max-md:inline-flex max-md:size-11 max-md:items-center max-md:justify-center max-md:p-0"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>

        {result ? (
          <SidebarSearchResults query={q} result={result} {...ctx} />
        ) : (
          <>
            <NeedsYouSection model={model.needsYou} {...ctx} />
            {failed ? (
              <p
                data-testid="sessions-error"
                className="flex flex-wrap items-center gap-x-1.5 px-2.5 py-1 text-[12px] text-muted-foreground leading-4"
              >
                Couldn't load sessions.
                <RetryButton
                  testId="sessions-retry"
                  disabled={sessions.isFetching}
                  onClick={() => void sessions.refetch()}
                />
              </p>
            ) : null}
            {loading ? (
              // One skeleton for the first load (a header bar and three rows), whichever request is still pending.
              <ProjectsLoading />
            ) : (
              <DepartmentSections model={model} projects={projects} sessions={list} {...ctx} />
            )}
            {!loading && model.personal ? <PersonalSection personal={model.personal} ctx={ctx} /> : null}
            <SettledSection model={model.settled} {...ctx} />
            {nothing ? <NoSessionsLine /> : null}
          </>
        )}

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
