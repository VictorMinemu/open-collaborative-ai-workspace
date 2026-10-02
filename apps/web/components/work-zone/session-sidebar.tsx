"use client";

import type { WorkSession } from "@ocw/contracts";
import { FolderGit2, Hand, Laptop, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SectionSidebar, sectionItemClass } from "@/components/shell/section-sidebar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { cn, relativeTime } from "@/lib/utils";
import { useWorkSessions } from "@/lib/workzone-queries";
import { OnlineDot, RuntimeLogo, StatusDot } from "./meta";
import { useWorkZone } from "./work-zone-context";

function needsAttention(s: WorkSession) {
  return s.status === "waiting_approval" || s.pendingApprovals > 0;
}

export function SessionSidebar() {
  const sessions = useWorkSessions();
  const pathname = usePathname();
  const { openNewSession } = useWorkZone();
  const list = sessions.data ?? [];
  const attention = list.filter(needsAttention);

  const groups = new Map<string, { name: string; online: boolean; sessions: WorkSession[] }>();
  for (const s of list) {
    const g = groups.get(s.projectId) ?? { name: s.projectName, online: s.deviceOnline, sessions: [] };
    g.sessions.push(s);
    groups.set(s.projectId, g);
  }

  return (
    <SectionSidebar
      title="Sessions"
      actions={
        <Tooltip content="New session">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="New session"
            data-testid="sidebar-new-session"
            onClick={() => openNewSession()}
          >
            <Plus />
          </Button>
        </Tooltip>
      }
    >
      <nav data-testid="session-list" className="grid gap-4">
        {sessions.isLoading ? (
          <div className="grid gap-2 px-1 pt-1">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : null}

        {attention.length > 0 ? (
          <div className="grid gap-0.5">
            <p className="flex items-center gap-1.5 px-2.5 pb-1 font-medium text-[11px] text-warning uppercase tracking-wider">
              <Hand className="size-3" /> Needs attention
            </p>
            {attention.map((s) => (
              <SessionRow key={`a-${s.id}`} s={s} active={pathname === `/work-zone/${s.id}`} attention />
            ))}
          </div>
        ) : null}

        {[...groups.entries()].map(([projectId, g]) => (
          <div key={projectId} className="grid gap-0.5">
            <div className="group flex items-center gap-1.5 px-2.5 pb-1">
              <FolderGit2 className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium text-[12px] text-muted-foreground">
                {g.name}
              </span>
              <OnlineDot online={g.online} className="size-1.5" />
              <button
                type="button"
                aria-label={`New session in ${g.name}`}
                onClick={() => openNewSession(projectId)}
                className="ml-0.5 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Plus className="size-3.5" />
              </button>
            </div>
            {g.sessions.map((s) => (
              <SessionRow key={s.id} s={s} active={pathname === `/work-zone/${s.id}`} />
            ))}
          </div>
        ))}

        {!sessions.isLoading && list.length === 0 ? (
          <p className="px-2.5 text-[13px] text-muted-foreground">No sessions yet.</p>
        ) : null}

        <Link
          href="/settings/devices"
          className={cn(sectionItemClass(pathname === "/settings/devices"), "mt-1 text-muted-foreground")}
        >
          <Laptop className="size-4" /> Devices
        </Link>
      </nav>
    </SectionSidebar>
  );
}

function SessionRow({ s, active, attention }: { s: WorkSession; active: boolean; attention?: boolean }) {
  return (
    <Link
      href={`/work-zone/${s.id}`}
      data-testid="session-row"
      className={cn(sectionItemClass(active), "h-auto min-h-8 items-start py-1.5")}
    >
      <StatusDot status={s.status} className="mt-1.5" />
      <span className="grid min-w-0 flex-1">
        <span className="truncate">{s.title}</span>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <RuntimeLogo runtime={s.runtime} className="size-3 rounded-[3px]" />
          {attention ? (
            <span className="truncate text-warning">
              {s.pendingApprovals > 0
                ? `${s.pendingApprovals} approval${s.pendingApprovals > 1 ? "s" : ""}`
                : "Waiting"}
            </span>
          ) : (
            <span className="truncate">
              {s.queuedCount > 0 ? `${s.queuedCount} queued · ` : ""}
              {relativeTime(s.updatedAt)}
            </span>
          )}
        </span>
      </span>
    </Link>
  );
}
