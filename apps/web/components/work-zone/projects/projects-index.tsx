"use client";

import type { PersonalRepo, WorkProjectIndex, WorkProjectSummary } from "@ocw/contracts";
import { ChevronRight, FolderGit2, FolderKanban, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { KindIcon } from "@/components/organization/unit-meta";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkProjects, useWorkProjectsLive } from "@/lib/work-project-queries";
import { projectHref } from "@/lib/work-zone-routes";
import { OnlineDot } from "../meta";
import { useWorkZone } from "../work-zone-context";
import { NewProjectDialog } from "./new-project-dialog";
import { teamCaption, teamCounts, trailText } from "./project-labels";

export const INDEX_COPY = {
  title: "Projects",
  description: "Team projects you're in and your personal repositories",
  team: "Team projects",
  personal: "Personal projects",
  personalHint: "Repositories on a device, not linked to a team project.",
  emptyTitle: "No team projects yet",
  emptyBody:
    "A team project lets everyone in it see and steer sessions together. Admins and team leads create them.",
  personalEmpty: "No personal repositories. Add one from the desktop app.",
} as const;

/** `/work-zone/projects` (UI-SPEC § 4.1): the team projects the API lets the viewer open, then their own repositories. */
export function ProjectsIndex() {
  const index = useWorkProjects();
  useWorkProjectsLive();
  const { openNewSession } = useWorkZone();
  const [creating, setCreating] = useState(false);
  const canCreate = index.data?.viewerCan.create === true;

  return (
    <div data-testid="projects-index" className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={INDEX_COPY.title}
        icon={<FolderKanban />}
        description={INDEX_COPY.description}
        actions={canCreate ? <NewProjectButton onClick={() => setCreating(true)} /> : null}
      />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {index.isError && !index.data ? (
          <ServerUnreachable
            title="Couldn't load projects."
            onRetry={() => index.refetch()}
            retrying={index.isFetching}
          />
        ) : (
          <ProjectsIndexBody
            data={index.data}
            onNewProject={canCreate ? () => setCreating(true) : undefined}
            onNewSession={openNewSession}
          />
        )}
      </div>
      {canCreate ? <NewProjectDialog open={creating} onOpenChange={setCreating} /> : null}
    </div>
  );
}

/** `New project` (outline sm); an icon button of 44 with the same name on phones (UI-SPEC § 4.1). */
export function NewProjectButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label="New project"
      data-testid="new-project"
      onClick={onClick}
      className="max-sm:size-11 max-sm:px-0"
    >
      <Plus />
      <span className="max-sm:sr-only">New project</span>
    </Button>
  );
}

/** The index body, pure over the API's answer (`undefined` while loading), so every state renders in a unit test. */
export function ProjectsIndexBody({
  data,
  onNewProject,
  onNewSession,
}: {
  data: WorkProjectIndex | undefined;
  onNewProject?: (() => void) | undefined;
  onNewSession: (projectId: string) => void;
}) {
  return (
    <div data-testid="projects-index-body" className="mx-auto grid w-full max-w-4xl gap-8 px-4 py-6 sm:px-6">
      <section className="grid gap-2" aria-labelledby="team-projects-heading">
        <h2 id="team-projects-heading" className="font-semibold text-sm">
          {INDEX_COPY.team}
        </h2>
        {!data ? (
          <RowSkeletons height="h-16" />
        ) : data.teamProjects.length === 0 ? (
          <EmptyState
            icon={FolderKanban}
            title={INDEX_COPY.emptyTitle}
            description={INDEX_COPY.emptyBody}
            className="rounded-xl border border-dashed py-10"
          >
            {onNewProject ? (
              <Button variant="outline" size="sm" className="max-md:h-11" onClick={onNewProject}>
                <Plus /> New project
              </Button>
            ) : null}
          </EmptyState>
        ) : (
          <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
            {data.teamProjects.map((p) => (
              <li key={p.id}>
                <TeamProjectRow project={p} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-2" aria-labelledby="personal-projects-heading">
        <div>
          <h2 id="personal-projects-heading" className="font-semibold text-sm">
            {INDEX_COPY.personal}
          </h2>
          <p className="text-muted-foreground text-xs">{INDEX_COPY.personalHint}</p>
        </div>
        {!data ? (
          <RowSkeletons height="h-14" />
        ) : data.personalRepos.length === 0 ? (
          <p className="rounded-xl border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
            {INDEX_COPY.personalEmpty}
          </p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
            {data.personalRepos.map((r) => (
              <li key={r.projectId}>
                <PersonalRepoRow repo={r} onNewSession={() => onNewSession(r.projectId)} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RowSkeletons({ height }: { height: string }) {
  return (
    <div className="grid gap-2">
      <Skeleton className={`${height} w-full rounded-xl`} />
      <Skeleton className={`${height} w-full rounded-xl`} />
    </div>
  );
}

/** A team project: a link to its page, the name truncating with the full name in `title` (long-text rule). */
export function TeamProjectRow({ project }: { project: WorkProjectSummary }) {
  const caption = teamCaption(project);
  return (
    <Link
      href={projectHref(project.id)}
      data-testid={`project-row-${project.id}`}
      title={project.name}
      className="group flex h-16 items-center gap-3 px-4 outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset"
    >
      <KindIcon kind="project" size="md" />
      <span className="grid min-w-0 flex-1">
        <span className="truncate font-semibold text-sm">{project.name}</span>
        {/* The trail truncates first, so the counts stay readable at 390 (long-text rule). */}
        <span className="flex min-w-0 text-muted-foreground text-xs" title={caption}>
          {project.trail.length > 0 ? (
            <>
              <span className="truncate">{trailText(project.trail)}</span>
              <span className="shrink-0 whitespace-pre">{" · "}</span>
            </>
          ) : null}
          <span className="shrink-0">{teamCounts(project)}</span>
        </span>
      </span>
      <ChevronRight
        aria-hidden
        className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
      />
    </Link>
  );
}

/** A personal repository with `New session` on it (the shared new-session dialog, repository preselected). */
export function PersonalRepoRow({ repo, onNewSession }: { repo: PersonalRepo; onNewSession: () => void }) {
  return (
    <div
      data-testid={`personal-row-${repo.projectId}`}
      className="flex min-h-14 items-center gap-3 px-4 py-2"
    >
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
      >
        <FolderGit2 className="size-4" />
      </span>
      <span className="grid min-w-0 flex-1">
        <span className="truncate font-semibold text-sm" title={repo.name}>
          {repo.name}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
          <span className="truncate" title={repo.deviceName}>
            {repo.deviceName}
          </span>
          <span aria-hidden className="inline-flex">
            <OnlineDot online={repo.deviceOnline} className="size-1.5" />
          </span>
          <span className="shrink-0">{repo.deviceOnline ? "Online" : "Offline"}</span>
        </span>
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 max-md:h-11"
        aria-label={`New session in ${repo.name}`}
        onClick={onNewSession}
      >
        <Plus /> New session
      </Button>
    </div>
  );
}
