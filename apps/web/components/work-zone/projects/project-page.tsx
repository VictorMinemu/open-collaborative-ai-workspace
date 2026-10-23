"use client";

import { ArrowLeft, FolderKanban, Lock } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/common/empty-state";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { PageHeader } from "@/components/shell/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { isApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useWorkProject, useWorkProjectsLive } from "@/lib/work-project-queries";
import type { ProjectTab } from "@/lib/work-zone-routes";
import { useProjects } from "@/lib/workzone-queries";
import { useWorkZone } from "../work-zone-context";
import { trailText } from "./project-labels";
import { NewSessionAction, newSessionTarget, ProjectSessions } from "./project-sessions";

export const NO_ACCESS_COPY = {
  title: "You're not in this project",
  body: "Ask a project lead to add you.",
  back: "Back to projects",
} as const;

/**
 * `/work-zone/projects/<unitId>` (UI-SPEC § 4.2, D-01, D-14): the header (name, trail, New session) and the Sessions
 * tab. Whoever may open or manage the project gets it from the API; everyone else, and unknown ids, get the same 404,
 * shown as one no-access state (no existence leak, T-07.9-11-01). Losing access while here refetches to that state
 * live. `tab` is already read from `?tab=` (an unknown tab falls back to Sessions); the Settings tab is 07.9-13's.
 */
export function ProjectPage({ unitId, tab }: { unitId: string; tab: ProjectTab }) {
  const project = useWorkProject(unitId);
  useWorkProjectsLive();
  const repos = useProjects();
  const { openNewSession } = useWorkZone();

  // A malformed id (400) reads like an unknown one: the same state, nothing to tell them apart.
  if ([400, 403, 404].some((status) => isApiError(project.error, status))) return <ProjectNoAccess />;
  if (!project.data) {
    if (project.isError) {
      return (
        <>
          <PageHeader title="Projects" icon={<FolderKanban />} />
          <ServerUnreachable
            title="Couldn't load this project."
            onRetry={() => project.refetch()}
            retrying={project.isFetching}
          />
        </>
      );
    }
    return <ProjectPageSkeleton />;
  }

  const p = project.data;
  return (
    <div data-testid="project-page" data-tab={tab} className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={<span title={p.name}>{p.name}</span>}
        icon={<FolderKanban />}
        description={p.trail.length > 0 ? trailText(p.trail) : undefined}
        actions={
          <NewSessionAction
            projectName={p.name}
            target={newSessionTarget(p, repos.data)}
            onStart={openNewSession}
          />
        }
      />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-4xl gap-3 px-4 py-6 sm:px-6">
          <ProjectSessions project={p} />
        </div>
      </div>
    </div>
  );
}

/** The one state for "not yours" and "does not exist" (UI-SPEC § States, Project page, No access). */
export function ProjectNoAccess() {
  return (
    <div data-testid="project-no-access" className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Projects" icon={<FolderKanban />} />
      <EmptyState icon={Lock} title={NO_ACCESS_COPY.title} description={NO_ACCESS_COPY.body}>
        <Link
          href="/work-zone/projects"
          className={cn(buttonVariants({ variant: "outline" }), "max-md:h-11")}
        >
          <ArrowLeft /> {NO_ACCESS_COPY.back}
        </Link>
      </EmptyState>
    </div>
  );
}

function ProjectPageSkeleton() {
  return (
    <div data-testid="project-page-loading" className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b px-4 py-2.5 sm:px-6">
        <Skeleton className="size-5 rounded-md" />
        <div className="grid gap-1.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-28" />
        </div>
      </header>
      <div className="mx-auto grid w-full max-w-4xl gap-2 px-4 py-6 sm:px-6">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}
