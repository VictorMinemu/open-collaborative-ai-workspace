"use client";

import type { WorkProjectIndex, WorkSession } from "@ocw/contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import { SidebarSectionHeader } from "@/components/shell/sidebar-section-header";
import type { SidebarModel, UnitSectionModel } from "./model";
import { MoreRow, ProjectRow, SessionSubRow } from "./rows";

/**
 * The department sections of the Work Zone sidebar (Phase 07.10, UI-SPEC § 4, Accessibility Contract): nested lists
 * inside the nav landmark, never `role="tree"`. Each section is `<section aria-labelledby>` with the shared header and
 * one list of projects; each project holds its sub-rows in a nested, labelled list.
 */

export interface SectionsProps {
  model: SidebarModel;
  /** The projects request; 07.10-05 adds its loading and error states here (PD-11). */
  projects: Pick<UseQueryResult<WorkProjectIndex>, "status" | "error" | "refetch" | "data">;
  sessions: readonly WorkSession[];
  now: number;
  viewerId: string | null;
  openSessionId: string | null;
  onToggle: (key: string) => void;
}

export function UnitSection({
  section,
  now,
  viewerId,
  openSessionId,
  onToggle,
}: {
  section: UnitSectionModel;
  now: number;
  viewerId: string | null;
  openSessionId: string | null;
  onToggle: (key: string) => void;
}) {
  const { key, title, collapsed, hidden, projects } = section;
  const headingId = `wz-section-${key}`;
  const listId = `wz-list-${key}`;
  return (
    <section
      aria-labelledby={headingId}
      data-testid="sidebar-section"
      data-section={key}
      data-collapsed={collapsed ? "true" : undefined}
      className="grid grid-cols-1 gap-px"
    >
      <SidebarSectionHeader
        id={headingId}
        title={title}
        expanded={!collapsed}
        hidden={hidden}
        onToggle={() => onToggle(key)}
        controls={listId}
        touch
        announceHidden
      />
      {/* biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics under `list-style: none` (UI-SPEC). */}
      <ul id={listId} role="list" className="grid grid-cols-1 gap-px">
        {projects.map((p) => (
          <li key={p.id} className="grid grid-cols-1 gap-px">
            <ProjectRow project={p} />
            {p.sessions.length > 0 || p.more > 0 ? (
              // biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics under `list-style: none`.
              <ul role="list" aria-label={`Active sessions in ${p.name}`} className="grid grid-cols-1 gap-px">
                {p.sessions.map((s) => (
                  <li key={s.id}>
                    <SessionSubRow s={s} now={now} active={s.id === openSessionId} viewerId={viewerId} />
                  </li>
                ))}
                {p.more > 0 ? (
                  <li>
                    <MoreRow projectId={p.id} projectName={p.name} n={p.more} />
                  </li>
                ) : null}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Every department section of the viewer, in the model's order. */
export function DepartmentSections({ model, now, viewerId, openSessionId, onToggle }: SectionsProps) {
  if (model.sections.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-3">
      {model.sections.map((section) => (
        <UnitSection
          key={section.key}
          section={section}
          now={now}
          viewerId={viewerId}
          openSessionId={openSessionId}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}
