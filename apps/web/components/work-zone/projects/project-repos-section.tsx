"use client";

import type { WorkProjectDetail, WorkProjectRepo } from "@ocw/contracts";
import { FolderGit2, GitBranch, Link2, Unlink } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { SectionHeader } from "@/components/organization/unit-detail";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { useUnlinkImpact, useUnlinkRepo } from "@/lib/work-project-queries";
import { OnlineDot } from "../meta";
import { LinkRepoDialog } from "./link-repo-dialog";
import { ListEmpty, ListError } from "./settings-list";

export const REPOS_COPY = {
  title: "Repositories",
  link: "Link a repository",
  emptyEditor: "No repositories linked. Link one from a device you can use.",
  emptyOther: "No repositories linked.",
  unavailable: "Not on the device anymore",
  unlink: "Unlink",
  unlinkLabel: (repo: string) => `Unlink ${repo}`,
  unlinkTitle: (repo: string, project: string) => `Unlink ${repo} from ${project}?`,
  impactError: "Couldn't count its sessions.",
  unlinked: (repo: string, project: string) => `${repo} unlinked from ${project}`,
} as const;

/** The unlink dialog's consequence, from the server's count (U-7). */
export function unlinkConsequence(sessions: number, deviceName: string): string {
  if (sessions === 0) return "It has no sessions.";
  if (sessions === 1)
    return `1 session on it becomes personal: only people who can use ${deviceName} will see it.`;
  return `${sessions} sessions on it become personal: only people who can use ${deviceName} will see them.`;
}

type ReposProject = Pick<WorkProjectDetail, "id" | "name" | "repos" | "viewerCan">;

/**
 * The repositories linked to the project (D-01, D-10, UI-SPEC § 4.3): names, devices and branches, never a path
 * (principle 7). Linking and unlinking are `viewerCan.manage`; unlinking confirms first with the server's count of the
 * sessions that become personal (U-7). Shared by the project page and Settings › Organization.
 */
export function ProjectReposSection({ project }: { project: ReposProject }) {
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState<WorkProjectRepo | null>(null);
  return (
    <>
      <ProjectReposBody project={project} onLink={() => setLinking(true)} onUnlink={setUnlinking} />
      {project.viewerCan.manage ? (
        <>
          <LinkRepoDialog project={project} open={linking} onOpenChange={setLinking} />
          <UnlinkRepoDialog project={project} repo={unlinking} onClose={() => setUnlinking(null)} />
        </>
      ) : null}
    </>
  );
}

/** The section over its inputs (editable and read-only), for the unit tests. */
export function ProjectReposBody({
  project,
  onLink,
  onUnlink,
}: {
  project: ReposProject;
  onLink: () => void;
  onUnlink: (repo: WorkProjectRepo) => void;
}) {
  const edit = project.viewerCan.manage;
  return (
    <section className="grid gap-3" data-testid="project-repos" aria-label={REPOS_COPY.title}>
      <SectionHeader
        title={REPOS_COPY.title}
        count={project.repos.length}
        action={
          edit ? (
            <Button
              size="sm"
              variant="outline"
              data-testid="link-repo"
              className="max-md:h-11"
              onClick={onLink}
            >
              <Link2 /> {REPOS_COPY.link}
            </Button>
          ) : null
        }
      />
      {project.repos.length === 0 ? (
        <ListEmpty>{edit ? REPOS_COPY.emptyEditor : REPOS_COPY.emptyOther}</ListEmpty>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
          {project.repos.map((r) => (
            <li
              key={r.projectId}
              data-testid={`project-repo-row-${r.projectId}`}
              className="flex min-h-14 items-center gap-3 px-4 py-2"
            >
              <span
                aria-hidden
                className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
              >
                <FolderGit2 className="size-4" />
              </span>
              <span className="grid min-w-0 flex-1">
                <span className="truncate font-semibold text-sm" title={r.name}>
                  {r.name}
                </span>
                <RepoCaption repo={r} />
              </span>
              {edit ? (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="unlink-repo"
                  aria-label={REPOS_COPY.unlinkLabel(r.name)}
                  className="shrink-0 text-muted-foreground hover:text-destructive max-sm:size-11 max-sm:px-0 max-md:h-11"
                  onClick={() => onUnlink(r)}
                >
                  <Unlink />
                  <span className="max-sm:hidden">{REPOS_COPY.unlink}</span>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** "{device} ● Online · ⑂ main": the device truncates first, so the state and the branch stay readable at 390. */
function RepoCaption({ repo: r }: { repo: WorkProjectRepo }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
      <span className="truncate" title={r.deviceName}>
        {r.deviceName}
      </span>
      <span aria-hidden className="inline-flex">
        <OnlineDot online={r.deviceOnline} className="size-1.5" />
      </span>
      <span className="shrink-0">{r.deviceOnline ? "Online" : "Offline"}</span>
      {r.branch ? (
        <>
          <span aria-hidden className="shrink-0">
            ·
          </span>
          <span className="flex min-w-0 shrink items-center gap-1">
            <GitBranch aria-hidden className="size-3 shrink-0" />
            <span className="sr-only">branch</span>
            <span className="truncate font-mono" title={r.branch}>
              {r.branch}
            </span>
          </span>
        </>
      ) : null}
      {r.available ? null : (
        <>
          <span aria-hidden className="shrink-0">
            ·
          </span>
          <span className="shrink-0">{REPOS_COPY.unavailable}</span>
        </>
      )}
    </span>
  );
}

/**
 * "Unlink {repo} from {project}?" (U-7): the body is the server's count of the sessions that become personal, asked
 * when the dialog opens; Unlink waits for it. Cancel holds the focus (destructive).
 */
function UnlinkRepoDialog({
  project,
  repo,
  onClose,
}: {
  project: Pick<WorkProjectDetail, "id" | "name">;
  repo: WorkProjectRepo | null;
  onClose: () => void;
}) {
  const impact = useUnlinkImpact(project.id, repo?.projectId ?? null);
  const unlink = useUnlinkRepo(project.id);
  return (
    <UnlinkRepoDialogView
      project={project}
      repo={repo}
      sessions={impact.data}
      impactError={impact.isError}
      onRetry={() => impact.refetch()}
      pending={unlink.isPending}
      onCancel={onClose}
      onConfirm={() => {
        if (!repo) return;
        unlink.mutate(repo.projectId, {
          onSuccess: (p) => {
            onClose();
            toast.success(REPOS_COPY.unlinked(repo.name, p.name));
          },
          onError: (err) => toast.error(errorMessage(err)),
        });
      }}
    />
  );
}

/** The unlink confirmation over its inputs (count loading, known, failed), for the unit tests. */
export function UnlinkRepoDialogView({
  project,
  repo,
  sessions,
  impactError,
  onRetry,
  pending,
  onCancel,
  onConfirm,
}: {
  project: Pick<WorkProjectDetail, "name">;
  repo: WorkProjectRepo | null;
  sessions: number | undefined;
  impactError: boolean;
  onRetry: () => void;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={repo !== null} onOpenChange={(o) => !o && !pending && onCancel()}>
      <DialogContent data-testid="unlink-repo-dialog" className="sm:max-w-md" initialFocus={cancelRef}>
        {repo ? (
          <>
            <DialogHeader>
              <DialogTitle className="break-words">
                {REPOS_COPY.unlinkTitle(repo.name, project.name)}
              </DialogTitle>
              <DialogDescription render={<div />} data-testid="unlink-impact">
                {sessions !== undefined ? (
                  unlinkConsequence(sessions, repo.deviceName)
                ) : impactError ? null : (
                  <Skeleton className="h-4 w-64 max-w-full" />
                )}
              </DialogDescription>
            </DialogHeader>
            {impactError && sessions === undefined ? (
              <ListError message={REPOS_COPY.impactError} onRetry={onRetry} />
            ) : null}
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
                disabled={pending || sessions === undefined}
                data-testid="confirm-unlink-repo"
                className="max-md:h-11"
                onClick={onConfirm}
              >
                {pending ? <Spinner /> : <Unlink />} {REPOS_COPY.unlink}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
