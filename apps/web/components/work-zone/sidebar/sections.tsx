"use client";

import type { WorkProjectIndex, WorkSession } from "@ocw/contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import { FolderGit2, FolderKanban, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { SidebarSectionHeader } from "@/components/shell/sidebar-section-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { useWorkZone } from "../work-zone-context";
import {
  isActiveSession,
  orderActiveSessions,
  type PersonalModel,
  rowProject,
  type SidebarModel,
  type UnitSectionModel,
} from "./model";
import { OnboardingLine } from "./onboarding-line";
import { ExpandRow, MoreRow, ProjectRow, RepoRow, SessionSubRow } from "./rows";
import { useCreatableUnits } from "./use-creatable-units";

/**
 * The sections of the Work Zone sidebar (Phase 07.10, UI-SPEC § 4, § 7, Accessibility Contract): nested lists inside
 * the nav landmark, never `role="tree"`. Each section is `<section aria-labelledby>` with the shared header (its toggle
 * controls the section's list) and one list of rows; each project or repository holds its sessions in a nested,
 * labelled list.
 */

/** What every section needs to draw its rows. */
export interface RowContext {
  now: number;
  viewerId: string | null;
  openSessionId: string | null;
  onToggle: (key: string) => void;
  /** Flips an inline expansion: `section:<key>`, `personal`, `repo:<projectId>`. */
  onExpand: (key: string) => void;
}

/** What a session sub-row needs: the clock, the viewer and the open session. */
type SubRowContext = Pick<RowContext, "now" | "viewerId" | "openSessionId">;

export interface SectionsProps extends RowContext {
  model: SidebarModel;
  /** The projects request: its loading and error states and the onboarding line live here (07.10-05, PD-11). */
  projects: Pick<UseQueryResult<WorkProjectIndex>, "status" | "error" | "refetch" | "data"> &
    Partial<Pick<UseQueryResult<WorkProjectIndex>, "isFetching">>;
  sessions: readonly WorkSession[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function SessionList({
  label,
  sessions,
  ctx,
  more,
}: {
  label: string;
  sessions: readonly WorkSession[];
  ctx: SubRowContext;
  more?: ReactNode;
}) {
  if (sessions.length === 0 && !more) return null;
  return (
    // biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics under `list-style: none` (UI-SPEC).
    <ul role="list" aria-label={label} className="grid grid-cols-1 gap-px">
      {sessions.map((s) => (
        <li key={s.id}>
          <SessionSubRow s={s} now={ctx.now} active={s.id === ctx.openSessionId} viewerId={ctx.viewerId} />
        </li>
      ))}
      {more ? <li>{more}</li> : null}
    </ul>
  );
}

/** The `<section>` frame every sidebar section shares: header toggle, then the list it controls. */
function SectionFrame({
  sectionKey,
  title,
  collapsed,
  hidden,
  onToggle,
  testId = "sidebar-section",
  action,
  children,
}: {
  sectionKey: string;
  title: string;
  collapsed: boolean;
  hidden: number;
  onToggle: (key: string) => void;
  testId?: string;
  /** The header's trailing action (a department's "+"). */
  action?: ReactNode;
  children: ReactNode;
}) {
  const headingId = `wz-section-${sectionKey}`;
  const listId = `wz-list-${sectionKey}`;
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      data-section={sectionKey}
      data-collapsed={collapsed ? "true" : undefined}
      className="grid grid-cols-1 gap-px"
    >
      <SidebarSectionHeader
        id={headingId}
        title={title}
        expanded={!collapsed}
        hidden={hidden}
        onToggle={() => onToggle(sectionKey)}
        controls={listId}
        touch
        announceHidden
        action={action}
      />
      {/* biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics under `list-style: none` (UI-SPEC). */}
      <ul id={listId} role="list" className="grid grid-cols-1 gap-px">
        {children}
      </ul>
    </section>
  );
}

/**
 * A department's "+" (D-07, UI-SPEC § 2, Geometry): "New project in {unit}". With a pointer it shows on the header's
 * hover or on focus; on touch it is always visible with a 44 × 44 hit area. It opens a dialog, never navigates.
 */
export function SectionCreate({ unit, onCreate }: { unit: string; onCreate: () => void }) {
  const label = `New project in ${unit}`;
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        data-testid="section-create"
        onClick={onCreate}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/40 group-hover/section:opacity-100 max-md:size-11 [@media(hover:none)]:opacity-100"
      >
        <Plus aria-hidden className="size-3.5" />
      </button>
    </Tooltip>
  );
}

export function UnitSection({
  section,
  ctx,
  onNewProject,
  onNewSession,
}: {
  section: UnitSectionModel;
  ctx: RowContext;
  /** Shown only where the viewer may create a project in this department (07.10-05, `useCreatableUnits`). */
  onNewProject?: (() => void) | undefined;
  /** A project row's "+" (07.10-05, R5): start a session in that team project. */
  onNewSession?: ((teamProjectId: string) => void) | undefined;
}) {
  const { key, title, collapsed, hidden, projects, moreProjects, expanded } = section;
  return (
    <SectionFrame
      sectionKey={key}
      title={title}
      collapsed={collapsed}
      hidden={hidden}
      onToggle={ctx.onToggle}
      action={onNewProject ? <SectionCreate unit={title} onCreate={onNewProject} /> : null}
    >
      {projects.map((p) => (
        <li key={p.id} className="grid grid-cols-1 gap-px">
          <ProjectRow project={p} onNewSession={onNewSession ? () => onNewSession(p.id) : undefined} />
          <SessionList
            label={`Active sessions in ${p.name}`}
            sessions={p.sessions}
            ctx={ctx}
            more={p.more > 0 ? <MoreRow projectId={p.id} projectName={p.name} n={p.more} /> : null}
          />
        </li>
      ))}
      {moreProjects > 0 || expanded ? (
        <li>
          <ExpandRow
            testId="section-more"
            expanded={expanded}
            label={plural(moreProjects, "more project", "more projects")}
            controls={`wz-list-${key}`}
            onToggle={() => ctx.onExpand(`section:${key}`)}
          />
        </li>
      ) : null}
    </SectionFrame>
  );
}

/** Personal (D-06, UI-SPEC § 7): the viewer's repositories outside the team projects, with their active sessions. */
export function PersonalSection({
  personal,
  ctx,
  onNewSession,
}: {
  personal: PersonalModel;
  ctx: RowContext;
  /** A repository row's "+" (07.10-05, § 7); defaults to the Work Zone's new-session dialog on that repository. */
  onNewSession?: ((repoId: string) => void) | undefined;
}) {
  const { openNewSession } = useWorkZone();
  const start = onNewSession ?? openNewSession;
  const { collapsed, hidden, repos, moreRepos, expanded } = personal;
  return (
    <SectionFrame
      sectionKey="personal"
      title="Personal"
      collapsed={collapsed}
      hidden={hidden}
      onToggle={ctx.onToggle}
      testId="personal-section"
    >
      {repos.map((r) => (
        <li key={r.projectId} className="grid grid-cols-1 gap-px">
          <RepoRow repo={r} onNewSession={() => start(r.projectId)} />
          <SessionList
            label={`Active sessions in ${r.name}`}
            sessions={r.sessions}
            ctx={ctx}
            more={
              r.more > 0 || r.expanded ? (
                <ExpandRow
                  testId="repo-more"
                  expanded={r.expanded}
                  label={`+${r.more} more`}
                  onToggle={() => ctx.onExpand(`repo:${r.projectId}`)}
                />
              ) : null
            }
          />
        </li>
      ))}
      {moreRepos > 0 || expanded ? (
        <li>
          <ExpandRow
            testId="personal-more"
            expanded={expanded}
            label={plural(moreRepos, "more repository", "more repositories")}
            controls="wz-list-personal"
            onToggle={() => ctx.onExpand("personal")}
          />
        </li>
      ) : null}
    </SectionFrame>
  );
}

/** While the projects request loads (UI-SPEC States): one header bar and three rows, where the sections will be. */
export function ProjectsLoading() {
  return (
    <div data-testid="projects-loading" aria-hidden className="grid grid-cols-1 gap-px">
      <div className="flex h-7 items-center px-1 max-md:h-11">
        <Skeleton className="h-4 w-24" />
      </div>
      {["w-[72%]", "w-[56%]", "w-[64%]"].map((width) => (
        <Skeleton key={width} className={`h-8 ${width} max-md:h-11`} />
      ))}
    </div>
  );
}

/** A fallback group: the sessions of one team project or repository, under its plain name. */
export interface FallbackGroup {
  key: string;
  name: string;
  team: boolean;
  sessions: WorkSession[];
}

/**
 * The fallback of a failed projects request (UI-SPEC States): the active sessions (and the open one) not already under
 * Personal (`scope`), grouped by `rowProject` as before 07.10, so no session the viewer had disappears and none shows
 * twice. A project the viewer may not see named is never named: its sessions group under their repository.
 */
export function fallbackGroups(
  sessions: readonly WorkSession[],
  scope: ReadonlySet<string>,
  ctx: SubRowContext,
): FallbackGroup[] {
  const shown = sessions.filter(
    (s) => !scope.has(s.id) && (isActiveSession(s, ctx.now) || s.id === ctx.openSessionId),
  );
  const groups = new Map<string, FallbackGroup>();
  for (const s of orderActiveSessions(shown)) {
    const { key, name } = rowProject(s);
    const group = groups.get(key) ?? { key, name, team: s.teamProject != null, sessions: [] };
    group.sessions.push(s);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** A failed projects request: the error line with Try again, then the fallback rows. */
export function ProjectsFallback({
  sessions,
  scope,
  ctx,
  retrying,
  onRetry,
}: {
  sessions: readonly WorkSession[];
  scope: ReadonlySet<string>;
  ctx: SubRowContext;
  retrying: boolean;
  onRetry: () => void;
}) {
  const groups = fallbackGroups(sessions, scope, ctx);
  return (
    <div data-testid="projects-error" className="grid grid-cols-1 gap-px">
      <p className="flex flex-wrap items-center gap-x-1.5 px-2.5 py-1 text-[12px] text-muted-foreground leading-4">
        Couldn't load projects.
        <Button
          type="button"
          variant="link"
          size="sm"
          data-testid="projects-retry"
          disabled={retrying}
          onClick={onRetry}
          className="h-auto p-0 text-[12px] max-md:min-h-11"
        >
          Try again
        </Button>
      </p>
      {groups.length > 0 ? (
        // biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics under `list-style: none` (UI-SPEC).
        <ul role="list" className="grid grid-cols-1 gap-px">
          {groups.map((g) => (
            <li key={g.key} className="grid grid-cols-1 gap-px">
              <div
                data-testid="fallback-group"
                className="flex h-8 w-full items-center gap-2 px-2.5 text-[13.5px] text-sidebar-foreground max-md:h-11"
              >
                {g.team ? (
                  <FolderKanban aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FolderGit2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span title={g.name} className="min-w-0 flex-1 truncate">
                  {g.name}
                </span>
              </div>
              <SessionList label={`Active sessions in ${g.name}`} sessions={g.sessions} ctx={ctx} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Every department section of the viewer, in the model's order; in their place, the projects request's loading and
 * error states, or the onboarding line when the viewer belongs to no team project (07.10-05, D-08, UI-SPEC States).
 */
export function DepartmentSections({ model, projects, sessions, ...ctx }: SectionsProps) {
  const creatable = useCreatableUnits();
  const { openNewProject, openNewSession } = useWorkZone();
  // Data already loaded (a later refetch failed) keeps drawing the sections; the states apply only without it.
  if (!projects.data) {
    if (projects.status === "error")
      return (
        <ProjectsFallback
          sessions={sessions}
          scope={model.scope}
          ctx={ctx}
          retrying={projects.isFetching === true}
          onRetry={() => void projects.refetch()}
        />
      );
    return <ProjectsLoading />;
  }
  if (model.sections.length === 0)
    return <OnboardingLine canCreate={projects.data.viewerCan.create} onCreate={() => openNewProject()} />;
  return (
    <div className="grid grid-cols-1 gap-3">
      {model.sections.map((section) => (
        <UnitSection
          key={section.key}
          section={section}
          ctx={ctx}
          onNewProject={
            creatable.canCreateIn(section.key)
              ? () => openNewProject(creatable.defaultParentFor(section.key))
              : undefined
          }
          onNewSession={(teamProjectId) => openNewSession({ teamProjectId })}
        />
      ))}
    </div>
  );
}
