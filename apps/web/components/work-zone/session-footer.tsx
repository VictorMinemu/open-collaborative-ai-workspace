"use client";

import type { WorkSession } from "@ocw/contracts";
import { FolderGit2, GitBranch, GitPullRequestArrow, Laptop } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { OnlineDot, RUNTIMES } from "./meta";

/**
 * The strip under the composer (ref-4, D-17): where the session works (its own worktree or the project's local
 * checkout, on which device), the working tree's diff stat and the branch. Device and runtime details that used to
 * sit in the header live here.
 */
export function SessionFooter({ session }: { session: WorkSession }) {
  const d = session.diffStat;
  return (
    <div
      data-testid="session-footer"
      className="mx-3 flex h-8 min-w-0 items-center gap-3 rounded-b-xl border border-t-0 bg-muted/30 px-3.5 text-[12px] text-muted-foreground sm:mx-5"
    >
      <Tooltip
        content={`${session.worktree ? "Own git worktree" : "Project checkout"} on ${session.deviceName} · ${RUNTIMES[session.runtime].subscription}`}
      >
        <span className="flex min-w-0 shrink items-center gap-1.5">
          {session.worktree ? (
            <FolderGit2 aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <Laptop aria-hidden className="size-3.5 shrink-0" />
          )}
          <span className="shrink-0">{session.worktree ? "Worktree" : "Local"}</span>
          <span aria-hidden className="text-muted-foreground/50">
            ·
          </span>
          <OnlineDot online={session.deviceOnline} className="size-1.5" />
          <span className="truncate">{session.deviceName}</span>
        </span>
      </Tooltip>
      <span className="flex-1" />
      {d && d.files > 0 ? (
        <span
          data-testid="footer-diffstat"
          title={`${d.files} changed file${d.files === 1 ? "" : "s"}`}
          className="inline-flex shrink-0 items-center gap-1 font-mono tabular-nums"
        >
          <GitPullRequestArrow aria-hidden className="size-3.5 text-violet-600 dark:text-violet-400" />
          <span className="text-emerald-600 dark:text-emerald-400">+{d.additions}</span>{" "}
          <span className="text-red-600 dark:text-red-400">−{d.deletions}</span>
        </span>
      ) : null}
      {session.branch ? (
        <span
          className="flex min-w-0 max-w-[45%] shrink-0 items-center gap-1 font-mono"
          title={session.branch}
        >
          <GitBranch aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{session.branch}</span>
        </span>
      ) : null}
    </div>
  );
}
