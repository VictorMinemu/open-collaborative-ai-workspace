"use client";

import type { WorkSession } from "@ocw/contracts";
import { FolderGit2, GitBranch, GitPullRequestArrow, Laptop } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { BrowserStatusChip } from "./browser/browser-status-chip";
import { OnlineDot, RUNTIMES } from "./meta";

/**
 * The strip under the composer (ref-4, D-17): where the session works (its own worktree or the project's local
 * checkout, on which device), the working tree's diff stat and the branch. Device and runtime details that used to
 * sit in the header live here. 07.13 (D-19): the session's browser state sits next to the device; on a phone the
 * strip is 44 px tall so the chip is a full touch target, and the device shows its icon and name only.
 */
export function SessionFooter({ session }: { session: WorkSession }) {
  const d = session.diffStat;
  return (
    <div
      data-testid="session-footer"
      className="mx-3 flex h-8 min-w-0 items-center gap-3 rounded-b-xl border border-t-0 bg-muted/30 px-3.5 text-[12px] text-muted-foreground max-sm:h-11 max-sm:gap-2 sm:mx-5"
    >
      <Tooltip
        content={`${session.worktree ? "Own git worktree" : "Project checkout"} on ${session.deviceName} · ${RUNTIMES[session.runtime].subscription}`}
      >
        <span className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden">
          {session.worktree ? (
            <FolderGit2 aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <Laptop aria-hidden className="size-3.5 shrink-0" />
          )}
          <span className="shrink-0 max-sm:sr-only">{session.worktree ? "Worktree" : "Local"}</span>
          <span aria-hidden className="text-muted-foreground/50 max-sm:hidden">
            ·
          </span>
          <OnlineDot online={session.deviceOnline} className="size-1.5" />
          <span className="truncate">{session.deviceName}</span>
        </span>
      </Tooltip>
      <BrowserStatusChip state={session.browser} />
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
          className="flex min-w-0 max-w-[45%] shrink-0 items-center gap-1 font-mono max-sm:max-w-[35%]"
          title={session.branch}
        >
          <GitBranch aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{session.branch}</span>
        </span>
      ) : null}
    </div>
  );
}
