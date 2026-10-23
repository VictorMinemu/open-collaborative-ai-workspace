"use client";

import type { OrgUnit, WorkProjectDetail } from "@ocw/contracts";
import { Info } from "lucide-react";
import { MembersSection, SectionHeader } from "@/components/organization/unit-detail";
import type { UnitNode } from "@/components/organization/unit-meta";
import { errorMessage } from "@/lib/api";
import { useUnits, useUnitsLive } from "@/lib/org-queries";
import { ProjectAccessLine } from "./project-access-line";
import { ProjectDefaultSwitch } from "./project-default-switch";
import { ProjectReposSection } from "./project-repos-section";
import { ProjectTeamsSection } from "./project-teams-section";
import { ListError, ListSkeleton } from "./settings-list";

export const SETTINGS_COPY = {
  readOnly: "Only project leads and admins change these settings.",
  newSessions: "New sessions",
  peopleError: "Couldn't load the people in this project.",
} as const;

/** Nobody may change anything here: no default, no teams, no people (the API's `viewerCan`, never a role check). */
export const readOnlySettings = (p: Pick<WorkProjectDetail, "viewerCan">) =>
  !p.viewerCan.manage && !p.viewerCan.assignTeams && !p.viewerCan.members;

/**
 * The project page's Settings tab (UI-SPEC § 4.3, D-03, D-10, D-14), in order: Access, New sessions, People, Teams,
 * Repositories. Every action renders from the API's `viewerCan`; read-only viewers see the same facts without
 * actions and one line saying who changes them. Managers outside the project (D-14) get the complete tab.
 */
export function ProjectSettings({ project }: { project: WorkProjectDetail }) {
  useUnitsLive();
  return (
    <ProjectSettingsLayout
      project={project}
      people={<ProjectPeople unitId={project.id} />}
      teams={<ProjectTeamsSection project={project} />}
      repos={<ProjectReposSection project={project} />}
      defaultSwitch={<ProjectDefaultSwitch project={project} />}
    />
  );
}

/** The tab's layout over its sections, so its order and the read-only line render in a unit test. */
export function ProjectSettingsLayout({
  project,
  defaultSwitch,
  people,
  teams,
  repos,
}: {
  project: WorkProjectDetail;
  defaultSwitch: React.ReactNode;
  people: React.ReactNode;
  teams: React.ReactNode;
  repos: React.ReactNode;
}) {
  return (
    <div data-testid="project-settings" className="grid w-full max-w-3xl gap-10">
      <div className="grid gap-3">
        {readOnlySettings(project) ? (
          <p
            data-testid="project-settings-readonly"
            className="flex items-center gap-2 text-muted-foreground text-xs"
          >
            <Info aria-hidden className="size-3.5 shrink-0" />
            {SETTINGS_COPY.readOnly}
          </p>
        ) : null}
        <ProjectAccessLine project={project} />
      </div>
      <section className="grid gap-3" aria-label={SETTINGS_COPY.newSessions}>
        <SectionHeader title={SETTINGS_COPY.newSessions} />
        {defaultSwitch}
      </section>
      {people}
      {teams}
      {repos}
    </div>
  );
}

/** The project's direct members: the existing `MembersSection` of Settings › Organization, on the project's unit. */
function ProjectPeople({ unitId }: { unitId: string }) {
  const units = useUnits();
  const unit = units.data?.units.find((u) => u.id === unitId);
  if (unit) return <MembersSection unit={unitNode(unit)} />;
  if (units.isError) {
    return (
      <section className="grid gap-3" aria-label="People">
        <SectionHeader title="People" />
        <ListError
          message={errorMessage(units.error) || SETTINGS_COPY.peopleError}
          onRetry={() => units.refetch()}
          retrying={units.isFetching}
        />
      </section>
    );
  }
  if (units.isPending) {
    return (
      <section className="grid gap-3" aria-label="People">
        <SectionHeader title="People" />
        <ListSkeleton />
      </section>
    );
  }
  // The org tree does not list it (deleted meanwhile): the page itself goes to its no-access state on the next read.
  return null;
}

const unitNode = (u: OrgUnit): UnitNode => ({ ...u, children: [], depth: 0 });
