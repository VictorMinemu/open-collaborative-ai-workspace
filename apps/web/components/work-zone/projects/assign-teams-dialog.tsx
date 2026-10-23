"use client";

import type { WorkProjectDetail, WorkProjectTeam } from "@ocw/contracts";
import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { KindIcon } from "@/components/organization/unit-meta";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { useDebounced } from "@/lib/search-queries";
import { useAssignableTeams, useAssignTeam } from "@/lib/work-project-queries";
import { teamRowCaption } from "./project-labels";
import { ListError, ListSkeleton } from "./settings-list";

export const ASSIGN_COPY = {
  title: (project: string) => `Assign teams to ${project}`,
  description: "Their people get access to the project and to sessions visible to the project.",
  search: "Search teams and departments",
  noMatch: (q: string) => `No team matches “${q}”`,
  allAssigned: "Every team is already assigned",
  error: "Couldn't load teams.",
  done: "Done",
  assigned: (team: string, project: string) => `${team} assigned to ${project}`,
} as const;

/**
 * Assign teams and departments to a project (UI-SPEC § 4.4, the `AddGrantDialog` look). The list is the API's: the
 * units the viewer may assign and that are not assigned yet (D-14), never projects. One click assigns with a toast and
 * the dialog stays open for more; Done closes it.
 */
export function AssignTeamsDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Pick<WorkProjectDetail, "id" | "name">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 200);
  const teams = useAssignableTeams(project.id, q, open);
  const assign = useAssignTeam(project.id);
  const [pendingId, setPendingId] = useState<string | null>(null);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="assign-teams-dialog">
        <DialogHeader>
          <DialogTitle className="break-words">{ASSIGN_COPY.title(project.name)}</DialogTitle>
          <DialogDescription>{ASSIGN_COPY.description}</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            placeholder={ASSIGN_COPY.search}
            aria-label={ASSIGN_COPY.search}
            data-testid="assign-teams-search"
            className="h-10 pl-9 max-sm:h-11 max-sm:text-base"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <DialogBody className="-mt-1 grid min-h-40 content-start gap-0.5">
          <AssignableList
            teams={teams.data}
            loading={teams.isPending}
            error={teams.isError && !teams.data}
            onRetry={() => teams.refetch()}
            retrying={teams.isFetching}
            query={q}
            pendingId={pendingId}
            onAssign={(team) => {
              setPendingId(team.id);
              assign.mutate(team.id, {
                onSuccess: (p) => toast.success(ASSIGN_COPY.assigned(team.name, p.name)),
                onError: (err) => toast.error(errorMessage(err)),
                onSettled: () => setPendingId(null),
              });
            }}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" className="max-md:h-11" onClick={() => onOpenChange(false)}>
            {ASSIGN_COPY.done}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's list over its inputs (loading, error, empty, rows), for the unit tests. */
export function AssignableList({
  teams,
  loading,
  error,
  onRetry,
  retrying,
  query,
  pendingId,
  onAssign,
}: {
  teams: readonly WorkProjectTeam[] | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  retrying?: boolean;
  query: string;
  pendingId: string | null;
  onAssign: (team: WorkProjectTeam) => void;
}) {
  if (error) return <ListError message={ASSIGN_COPY.error} onRetry={onRetry} retrying={retrying} />;
  if (loading || !teams) return <ListSkeleton />;
  if (teams.length === 0) {
    return (
      <p className="px-2 py-10 text-center text-muted-foreground text-sm">
        {query ? ASSIGN_COPY.noMatch(query) : ASSIGN_COPY.allAssigned}
      </p>
    );
  }
  return (
    <ul className="grid gap-0.5" aria-label="Teams and departments">
      {teams.map((t) => (
        <li key={t.id}>
          <button
            type="button"
            disabled={pendingId !== null}
            data-testid={`assign-team-option-${t.id}`}
            aria-label={`Assign ${t.name}, ${teamRowCaption(t)}`}
            className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2 py-2 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-wait max-md:min-h-14"
            onClick={() => onAssign(t)}
          >
            <KindIcon kind={t.kind} size="lg" className="size-9" />
            <span className="grid min-w-0 flex-1">
              <span className="truncate font-semibold text-sm" title={t.name}>
                {t.name}
              </span>
              <span className="truncate text-muted-foreground text-xs">{teamRowCaption(t)}</span>
            </span>
            {pendingId === t.id ? <Spinner className="shrink-0 text-muted-foreground" /> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
