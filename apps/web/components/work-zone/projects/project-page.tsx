"use client";

import { ArrowLeft, FolderKanban, Lock } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { EmptyState } from "@/components/common/empty-state";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { PageHeader } from "@/components/shell/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { isApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useWorkProject, useWorkProjectsLive } from "@/lib/work-project-queries";
import { type ProjectTab, projectTabOf } from "@/lib/work-zone-routes";
import { useProjects } from "@/lib/workzone-queries";
import { useWorkZone } from "../work-zone-context";
import { trailText } from "./project-labels";
import { NewSessionAction, newSessionTarget, ProjectSessions } from "./project-sessions";
import { ProjectSettings } from "./project-settings";

export const NO_ACCESS_COPY = {
  title: "You're not in this project",
  body: "Ask a project lead to add you.",
  back: "Back to projects",
} as const;

/**
 * `/work-zone/projects/<unitId>` (UI-SPEC § 4.2, § 4.3, D-01, D-14): the header (name, trail, New session) and the
 * `Sessions · Settings` tabs. Whoever may open or manage the project gets it from the API; everyone else, and unknown
 * ids, get the same 404, shown as one no-access state (no existence leak, T-07.9-11-01). Losing access while here
 * refetches to that state live. The tab follows `?tab=` (`settings` deep-links; an unknown tab falls back to Sessions)
 * and switching tabs replaces the URL.
 */
export function ProjectPage({ unitId, tab: initialTab }: { unitId: string; tab: ProjectTab }) {
  const project = useWorkProject(unitId);
  useWorkProjectsLive();
  const repos = useProjects();
  const { openNewSession } = useWorkZone();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const tab = search ? projectTabOf(search.get("tab")) : initialTab;

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
        // The tab row right below draws the separator (one line, not two).
        className="border-b-0"
        description={p.trail.length > 0 ? trailText(p.trail) : undefined}
        actions={
          <NewSessionAction
            projectName={p.name}
            target={newSessionTarget(p, repos.data)}
            onStart={openNewSession}
          />
        }
      />
      <Tabs
        variant="underline"
        value={tab}
        onValueChange={(next) =>
          router.replace(next === "settings" ? `${pathname}?tab=settings` : pathname, { scroll: false })
        }
        className="min-h-0 flex-1"
      >
        <div className="shrink-0 border-b">
          <TabsList
            aria-label={`${p.name} sections`}
            className="mx-auto w-full max-w-4xl border-b-0 px-1 sm:px-3"
          >
            <TabsTrigger value="sessions" data-testid="project-tab-sessions" className="md:min-h-12">
              Sessions
            </TabsTrigger>
            <TabsTrigger value="settings" data-testid="project-tab-settings" className="md:min-h-12">
              Settings
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="sessions" className="scrollbar-thin overflow-y-auto">
          <div className="mx-auto grid w-full max-w-4xl gap-3 px-4 py-6 sm:px-6">
            <ProjectSessions project={p} onOpenSettings={() => router.replace(`${pathname}?tab=settings`)} />
          </div>
        </TabsContent>
        <TabsContent value="settings" className="scrollbar-thin overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
            <ProjectSettings project={p} />
          </div>
        </TabsContent>
      </Tabs>
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
