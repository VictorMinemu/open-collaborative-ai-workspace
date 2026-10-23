"use client";

import type { WorkProjectDetail, WorkProjectTeam } from "@ocw/contracts";
import { Trash2, UserPlus } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { SectionHeader } from "@/components/organization/unit-detail";
import { KindIcon } from "@/components/organization/unit-meta";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { useRemoveTeam } from "@/lib/work-project-queries";
import { AssignTeamsDialog } from "./assign-teams-dialog";
import { teamRowCaption } from "./project-labels";
import { ListEmpty } from "./settings-list";

export const TEAMS_COPY = {
  title: "Teams",
  description: (project: string) => `Everyone in these teams can open ${project} and its sessions.`,
  assign: "Assign teams",
  emptyEditor: "No teams assigned. Assign one so its people join without being added one by one.",
  emptyOther: "No teams assigned.",
  removeLabel: (team: string, project: string) => `Remove ${team} from ${project}`,
  removeTitle: (team: string, project: string) => `Remove ${team} from ${project}?`,
  removeBody: (team: string, project: string) =>
    `People who are in ${project} only through ${team} lose access now, including sessions shared with ${team}.`,
  removeConfirm: "Remove team",
  removed: (team: string, project: string) => `${team} removed from ${project}`,
} as const;

type TeamsProject = Pick<WorkProjectDetail, "id" | "name" | "teams" | "viewerCan">;

/**
 * The project's assigned teams and departments (D-01, D-10, UI-SPEC § 4.3). Assigning and removing are
 * `viewerCan.assignTeams` (the API's `work_project.manage` on the parent); everyone else sees the same rows without
 * actions. Shared by the project page and Settings › Organization, so both places change together.
 */
export function ProjectTeamsSection({ project }: { project: TeamsProject }) {
  const [assigning, setAssigning] = useState(false);
  const [removing, setRemoving] = useState<WorkProjectTeam | null>(null);
  const remove = useRemoveTeam(project.id);
  return (
    <>
      <ProjectTeamsBody project={project} onAssign={() => setAssigning(true)} onRemove={setRemoving} />
      {project.viewerCan.assignTeams ? (
        <>
          <AssignTeamsDialog project={project} open={assigning} onOpenChange={setAssigning} />
          <RemoveTeamDialog
            project={project}
            team={removing}
            pending={remove.isPending}
            onCancel={() => setRemoving(null)}
            onConfirm={() => {
              const team = removing;
              if (!team) return;
              remove.mutate(team.id, {
                onSuccess: (p) => {
                  setRemoving(null);
                  toast.success(TEAMS_COPY.removed(team.name, p.name));
                },
                onError: (err) => toast.error(errorMessage(err)),
              });
            }}
          />
        </>
      ) : null}
    </>
  );
}

/** The section over its inputs (editable and read-only), for the unit tests. */
export function ProjectTeamsBody({
  project,
  onAssign,
  onRemove,
}: {
  project: TeamsProject;
  onAssign: () => void;
  onRemove: (team: WorkProjectTeam) => void;
}) {
  const edit = project.viewerCan.assignTeams;
  return (
    <section className="grid gap-3" data-testid="project-teams" aria-label={TEAMS_COPY.title}>
      <SectionHeader
        title={TEAMS_COPY.title}
        count={project.teams.length}
        description={TEAMS_COPY.description(project.name)}
        action={
          edit ? (
            <Button
              size="sm"
              variant="outline"
              data-testid="assign-teams"
              className="max-md:h-11"
              onClick={onAssign}
            >
              <UserPlus /> {TEAMS_COPY.assign}
            </Button>
          ) : null
        }
      />
      {project.teams.length === 0 ? (
        <ListEmpty>{edit ? TEAMS_COPY.emptyEditor : TEAMS_COPY.emptyOther}</ListEmpty>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
          {project.teams.map((t) => (
            <li
              key={t.id}
              data-testid={`project-team-row-${t.id}`}
              className="flex min-h-14 items-center gap-3 px-4 py-2"
            >
              <KindIcon kind={t.kind} size="md" />
              <span className="grid min-w-0 flex-1">
                <span className="truncate font-semibold text-sm" title={t.name}>
                  {t.name}
                </span>
                <span className="truncate text-muted-foreground text-xs">{teamRowCaption(t)}</span>
              </span>
              {edit ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  data-testid="remove-team"
                  aria-label={TEAMS_COPY.removeLabel(t.name, project.name)}
                  className="shrink-0 text-muted-foreground hover:text-destructive max-md:size-11"
                  onClick={() => onRemove(t)}
                >
                  <Trash2 />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** "Remove {team} from {project}?" (U-8): says who loses access; Cancel holds the focus (destructive). */
export function RemoveTeamDialog({
  project,
  team,
  pending,
  onCancel,
  onConfirm,
}: {
  project: Pick<WorkProjectDetail, "name">;
  team: WorkProjectTeam | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={team !== null} onOpenChange={(o) => !o && !pending && onCancel()}>
      <DialogContent data-testid="remove-team-dialog" className="sm:max-w-md" initialFocus={cancelRef}>
        {team ? (
          <>
            <DialogHeader>
              <DialogTitle className="break-words">
                {TEAMS_COPY.removeTitle(team.name, project.name)}
              </DialogTitle>
              <DialogDescription>{TEAMS_COPY.removeBody(team.name, project.name)}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                ref={cancelRef}
                variant="outline"
                disabled={pending}
                className="max-md:h-11"
                onClick={onCancel}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={pending}
                data-testid="confirm-remove-team"
                className="max-md:h-11"
                onClick={onConfirm}
              >
                {pending ? <Spinner /> : <Trash2 />} {TEAMS_COPY.removeConfirm}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
