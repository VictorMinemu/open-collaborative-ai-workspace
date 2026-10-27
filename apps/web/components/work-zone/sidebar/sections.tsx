"use client";

import type { WorkProjectIndex, WorkSession } from "@ocw/contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { SidebarSectionHeader } from "@/components/shell/sidebar-section-header";
import { Tooltip } from "@/components/ui/tooltip";
import { useWorkZone } from "../work-zone-context";
import type { PersonalModel, SidebarModel, UnitSectionModel } from "./model";
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

export interface SectionsProps extends RowContext {
  model: SidebarModel;
  /** The projects request; 07.10-05 adds its loading and error states and the onboarding line here (PD-11). */
  projects: Pick<UseQueryResult<WorkProjectIndex>, "status" | "error" | "refetch" | "data">;
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
  ctx: RowContext;
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
}: {
  section: UnitSectionModel;
  ctx: RowContext;
  /** Shown only where the viewer may create a project in this department (07.10-05, `useCreatableUnits`). */
  onNewProject?: (() => void) | undefined;
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
          <ProjectRow project={p} />
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
export function PersonalSection({ personal, ctx }: { personal: PersonalModel; ctx: RowContext }) {
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
          <RepoRow repo={r} />
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

/** Every department section of the viewer, in the model's order. */
export function DepartmentSections({
  model,
  projects: _projects,
  sessions: _sessions,
  ...ctx
}: SectionsProps) {
  const creatable = useCreatableUnits();
  const { openNewProject } = useWorkZone();
  if (model.sections.length === 0) return null;
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
        />
      ))}
    </div>
  );
}
