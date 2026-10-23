"use client";

import type { LinkableRepos, WorkProjectDetail } from "@ocw/contracts";
import { FolderGit2, Laptop } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { useLinkableRepos, useLinkRepo } from "@/lib/work-project-queries";
import { OnlineDot } from "../meta";
import { ListError, ListSkeleton } from "./settings-list";

export const LINK_COPY = {
  title: (project: string) => `Link a repository to ${project}`,
  description: "Pick a repository from a device you can use. Its path never leaves the device.",
  inProject: (project: string) => `In ${project}`,
  inHidden: "In another project",
  here: "Already linked",
  none: "No repositories available. Add one from the desktop app on your device.",
  error: "Couldn't load repositories.",
  done: "Done",
  linked: (repo: string, project: string) => `${repo} linked to ${project}`,
} as const;

type Device = LinkableRepos["devices"][number];
type Repo = Device["repos"][number];

/** Why a repository cannot be linked here, or null when it can (D-14: a hidden project is never named). */
export function linkBlock(repo: Repo, projectId: string): string | null {
  if (repo.linkedTo?.id === projectId) return LINK_COPY.here;
  if (repo.linkedTo) return LINK_COPY.inProject(repo.linkedTo.name);
  if (repo.linkedToHidden) return LINK_COPY.inHidden;
  return null;
}

/**
 * Link a repository to a project (UI-SPEC § 4.4): the API's repositories on devices the viewer can use, grouped by
 * device, by name only; their paths never reach the browser (principle 7). One click links with a toast and the dialog
 * stays open; a repository in another project shows where it is and is disabled.
 */
export function LinkRepoDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Pick<WorkProjectDetail, "id" | "name">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const devices = useLinkableRepos(project.id, open);
  const link = useLinkRepo(project.id);
  const [pendingId, setPendingId] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="link-repo-dialog">
        <DialogHeader>
          <DialogTitle className="break-words">{LINK_COPY.title(project.name)}</DialogTitle>
          <DialogDescription>{LINK_COPY.description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid min-h-40 content-start gap-4">
          <LinkableList
            projectId={project.id}
            devices={devices.data}
            loading={devices.isPending}
            error={devices.isError && !devices.data}
            onRetry={() => devices.refetch()}
            retrying={devices.isFetching}
            pendingId={pendingId}
            onLink={(repo) => {
              setPendingId(repo.projectId);
              link.mutate(repo.projectId, {
                onSuccess: (p) => toast.success(LINK_COPY.linked(repo.name, p.name)),
                onError: (err) => toast.error(errorMessage(err)),
                onSettled: () => setPendingId(null),
              });
            }}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" className="max-md:h-11" onClick={() => onOpenChange(false)}>
            {LINK_COPY.done}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's list over its inputs (loading, error, empty, devices), for the unit tests. */
export function LinkableList({
  projectId,
  devices,
  loading,
  error,
  onRetry,
  retrying,
  pendingId,
  onLink,
}: {
  projectId: string;
  devices: readonly Device[] | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  retrying?: boolean;
  pendingId: string | null;
  onLink: (repo: Repo) => void;
}) {
  if (error) return <ListError message={LINK_COPY.error} onRetry={onRetry} retrying={retrying} />;
  if (loading || !devices) return <ListSkeleton />;
  const shown = devices.filter((d) => d.repos.length > 0);
  if (shown.length === 0) {
    return <p className="px-2 py-10 text-center text-muted-foreground text-sm">{LINK_COPY.none}</p>;
  }
  return (
    <>
      {shown.map((d) => (
        <section key={d.deviceId} className="grid gap-0.5" aria-label={d.deviceName}>
          <p className="flex min-w-0 items-center gap-1.5 px-2 pb-1 text-muted-foreground text-xs">
            <Laptop aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate font-semibold" title={d.deviceName}>
              {d.deviceName}
            </span>
            <span aria-hidden className="inline-flex">
              <OnlineDot online={d.deviceOnline} className="size-1.5" />
            </span>
            <span className="shrink-0">{d.deviceOnline ? "Online" : "Offline"}</span>
          </p>
          <ul className="grid gap-0.5">
            {d.repos.map((r) => {
              const blocked = linkBlock(r, projectId);
              return (
                <li key={r.projectId}>
                  <button
                    type="button"
                    disabled={blocked !== null || pendingId !== null}
                    data-testid={`link-repo-option-${r.projectId}`}
                    aria-label={blocked ? `${r.name}, ${blocked}` : `Link ${r.name}`}
                    className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2 py-2 text-left outline-none transition-colors enabled:hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed max-md:min-h-14"
                    onClick={() => onLink(r)}
                  >
                    <span
                      aria-hidden
                      className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
                    >
                      <FolderGit2 className="size-4" />
                    </span>
                    <span className="grid min-w-0 flex-1">
                      <span
                        className={`truncate font-semibold text-sm ${blocked ? "text-muted-foreground" : ""}`}
                        title={r.name}
                      >
                        {r.name}
                      </span>
                      {blocked ? (
                        <span className="truncate text-muted-foreground text-xs" title={blocked}>
                          {blocked}
                        </span>
                      ) : null}
                    </span>
                    {pendingId === r.projectId ? (
                      <Spinner className="shrink-0 text-muted-foreground" />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}
