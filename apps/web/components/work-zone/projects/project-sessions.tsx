"use client";

import type { Project, WorkProjectDetail, WorkSession } from "@ocw/contracts";
import { FolderGit2, Plus, SquareTerminal } from "lucide-react";
import { useId, useState } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { useMe } from "@/lib/queries";
import { useProjects, useWorkSessions } from "@/lib/workzone-queries";
import { useWorkZone } from "../work-zone-context";
import { RecentSessionRow } from "../work-zone-home";

/** Rows shown before `Show more`, and how many more each press shows (UI-SPEC § 4.2). */
export const SESSIONS_PAGE = 25;

export const SESSIONS_COPY = {
  footnote: "Sessions people keep to themselves don't appear here.",
  noReposTitle: "No repositories yet",
  noReposEditor: "Link a repository so the team can start sessions here.",
  noReposOther: "Ask a project lead to link one.",
  noSessionsTitle: "No sessions you can see",
  noSessionsBody: "Start one. Sessions people keep to themselves don't appear here.",
  offline: (project: string) => `No repository of ${project} is online right now.`,
} as const;

/**
 * The project's sessions the viewer can see: the authorized `GET /work-sessions` list, grouped by `teamProject.id`.
 * Grouping is presentation, never an access decision (R6, T-07.9-11-02): a session outside the viewer's audience is
 * not in the list the API sent, so it cannot appear here. Newest first.
 */
export function projectSessions(sessions: readonly WorkSession[], unitId: string): WorkSession[] {
  return sessions
    .filter((s) => s.teamProject?.id === unitId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * What `New session` does on a project (UI-SPEC § 4.2): absent when the project has no repositories, or none the viewer
 * can start on (`GET /projects` lists only repositories the viewer may use in a project they can open, D-13); disabled
 * when none of those is online; otherwise it opens the dialog on the first online one.
 */
export type NewSessionTarget =
  | { kind: "absent" }
  | { kind: "offline" }
  | { kind: "ready"; projectId: string };

export function newSessionTarget(
  project: Pick<WorkProjectDetail, "id" | "repos">,
  repos: readonly Project[] | undefined,
): NewSessionTarget {
  if (project.repos.length === 0) return { kind: "absent" };
  const startable = (repos ?? []).filter((r) => r.teamProject?.id === project.id && r.available);
  if (startable.length === 0) return { kind: "absent" };
  const online = startable.find((r) => r.deviceOnline);
  return online ? { kind: "ready", projectId: online.id } : { kind: "offline" };
}

/** `New session` (primary, `Plus`); disabled with its reason in a tooltip and in its description when none is online. */
export function NewSessionAction({
  projectName,
  target,
  onStart,
}: {
  projectName: string;
  target: NewSessionTarget;
  onStart: (projectId: string) => void;
}) {
  const reasonId = useId();
  if (target.kind === "absent") return null;
  if (target.kind === "offline") {
    const reason = SESSIONS_COPY.offline(projectName);
    return (
      <>
        <Tooltip content={reason}>
          <Button
            size="sm"
            disabled
            focusableWhenDisabled
            aria-describedby={reasonId}
            data-testid="project-new-session"
            className="max-md:h-11 data-disabled:pointer-events-auto data-disabled:cursor-not-allowed"
          >
            <Plus /> New session
          </Button>
        </Tooltip>
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      </>
    );
  }
  return (
    <Button
      size="sm"
      data-testid="project-new-session"
      className="max-md:h-11"
      onClick={() => onStart(target.projectId)}
    >
      <Plus /> New session
    </Button>
  );
}

/** The Sessions tab, wired to the live session list and the shared new-session dialog. */
export function ProjectSessions({ project }: { project: WorkProjectDetail }) {
  const sessions = useWorkSessions();
  const repos = useProjects();
  const viewerId = useMe().data?.user.id ?? null;
  const { openNewSession } = useWorkZone();
  return (
    <ProjectSessionsBody
      project={project}
      sessions={sessions.data}
      viewerId={viewerId}
      target={newSessionTarget(project, repos.data)}
      onStart={openNewSession}
    />
  );
}

/** The Sessions tab over its inputs (`sessions` undefined while loading), so every state renders in a unit test. */
export function ProjectSessionsBody({
  project,
  sessions,
  viewerId,
  target,
  onStart,
}: {
  project: WorkProjectDetail;
  sessions: readonly WorkSession[] | undefined;
  viewerId: string | null;
  target: NewSessionTarget;
  onStart: (projectId: string) => void;
}) {
  const [shown, setShown] = useState(SESSIONS_PAGE);
  if (!sessions) {
    return (
      <div className="grid gap-2" data-testid="project-sessions-loading">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  const rows = projectSessions(sessions, project.id);
  if (rows.length === 0 && project.repos.length === 0) {
    return (
      <EmptyState
        icon={FolderGit2}
        title={SESSIONS_COPY.noReposTitle}
        description={project.viewerCan.manage ? SESSIONS_COPY.noReposEditor : SESSIONS_COPY.noReposOther}
        className="rounded-xl border border-dashed py-10"
      />
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={SquareTerminal}
        title={SESSIONS_COPY.noSessionsTitle}
        description={SESSIONS_COPY.noSessionsBody}
        className="rounded-xl border border-dashed py-10"
      >
        <NewSessionAction projectName={project.name} target={target} onStart={onStart} />
      </EmptyState>
    );
  }
  return (
    <div className="grid gap-3">
      <ul className="grid gap-2" aria-label={`Sessions in ${project.name}`}>
        {rows.slice(0, shown).map((s) => (
          <li key={s.id} data-testid="project-session-row">
            <RecentSessionRow s={s} viewerId={viewerId} />
          </li>
        ))}
      </ul>
      {rows.length > shown ? (
        <Button
          variant="outline"
          size="sm"
          data-testid="project-sessions-more"
          className="justify-self-center max-md:h-11 max-sm:w-full"
          onClick={() => setShown((n) => n + SESSIONS_PAGE)}
        >
          Show more
        </Button>
      ) : null}
      <p className="text-muted-foreground text-xs" data-testid="project-sessions-footnote">
        {SESSIONS_COPY.footnote}
      </p>
    </div>
  );
}
