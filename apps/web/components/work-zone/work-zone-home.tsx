"use client";

import { ArrowRight, FolderGit2, Laptop, Plus, ShieldCheck, SquareTerminal, Users } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, relativeTime } from "@/lib/utils";
import { useDevices, useProjects, useWorkSessions } from "@/lib/workzone-queries";
import { OnlineDot, RuntimeLogo, StatusChip } from "./meta";
import { useWorkZone } from "./work-zone-context";

export function WorkZoneHome() {
  const devices = useDevices();
  const projects = useProjects();
  const sessions = useWorkSessions();
  const { openNewSession } = useWorkZone();

  const loading = devices.isLoading || projects.isLoading || sessions.isLoading;
  const hasDevice = (devices.data?.length ?? 0) > 0;
  const hasProject = (projects.data ?? []).some((p) => p.available);
  const list = sessions.data ?? [];

  return (
    <>
      <PageHeader
        title="Work Zone"
        icon={<SquareTerminal />}
        description="Coding agents on your team's computers, steered together"
        actions={
          hasProject ? (
            <Button size="sm" onClick={() => openNewSession()} data-testid="new-session">
              <Plus /> New session
            </Button>
          ) : null
        }
      />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="mx-auto grid w-full max-w-4xl gap-3 p-6">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        ) : !hasDevice ? (
          <EmptyState
            icon={Laptop}
            title="Connect your computer"
            description="Pair a device to run Claude Code or Codex on your repositories, with your own subscription. Your team follows, prompts and approves from here."
          >
            <Link href="/settings/devices?add=1" className={buttonVariants()} data-testid="connect-device">
              <Laptop /> Add a device
            </Link>
          </EmptyState>
        ) : !hasProject ? (
          <EmptyState
            icon={FolderGit2}
            title="Add a project"
            description={
              <>
                Open the desktop app and choose <strong>Add project</strong>, or run{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">
                  ocw-runtime add-project .
                </code>{" "}
                inside a repository. Only its name is shared, never its path.
              </>
            }
          >
            <Link href="/settings/devices" className={buttonVariants({ variant: "outline" })}>
              <Laptop /> Manage devices
            </Link>
          </EmptyState>
        ) : list.length === 0 ? (
          <EmptyState
            icon={SquareTerminal}
            title="Start your first session"
            description="Pick a project, an agent and how much it may do on its own. Everyone in the workspace can queue prompts and approve changes."
          >
            <Button onClick={() => openNewSession()} data-testid="new-session-empty">
              <Plus /> New session
            </Button>
          </EmptyState>
        ) : (
          <div className="mx-auto grid w-full max-w-4xl gap-6 px-4 py-6 sm:px-6">
            <div className="grid gap-2 sm:grid-cols-3 sm:gap-3">
              {[
                {
                  icon: Laptop,
                  title: "Runs locally",
                  text: "On the device that has the code. Paths never leave it.",
                },
                {
                  icon: Users,
                  title: "Steered together",
                  text: "A shared queue: prompts run one at a time, in order.",
                },
                {
                  icon: ShieldCheck,
                  title: "You approve",
                  text: "Edits and commands wait for an explicit yes.",
                },
              ].map((f) => (
                <div key={f.title} className="flex gap-3 rounded-xl border bg-card p-3 sm:block sm:p-4">
                  <f.icon className="mt-0.5 size-4 shrink-0 text-primary sm:mt-0 sm:mb-2" />
                  <div>
                    <p className="font-medium text-sm">{f.title}</p>
                    <p className="mt-0.5 text-muted-foreground text-xs">{f.text}</p>
                  </div>
                </div>
              ))}
            </div>
            <section className="grid gap-2">
              <h2 className="font-semibold text-[15px] tracking-tight">Recent sessions</h2>
              <div className="grid gap-2">
                {list.slice(0, 12).map((s) => (
                  <Link
                    key={s.id}
                    href={`/work-zone/${s.id}`}
                    className="group flex items-center gap-3 rounded-xl border bg-card px-4 py-3 transition-colors hover:border-foreground/15 hover:bg-accent/30"
                  >
                    <RuntimeLogo runtime={s.runtime} className="size-8 rounded-lg" />
                    <span className="grid min-w-0 flex-1">
                      <span className="truncate font-medium text-sm">{s.title}</span>
                      <span className="flex items-center gap-1.5 truncate text-muted-foreground text-xs">
                        {s.projectName}
                        <span aria-hidden>·</span>
                        <OnlineDot online={s.deviceOnline} className="size-1.5" /> {s.deviceName}
                        <span aria-hidden>·</span>
                        {relativeTime(s.updatedAt)}
                      </span>
                    </span>
                    <StatusChip status={s.status} className="hidden sm:inline-flex" />
                    <ArrowRight
                      className={cn(
                        "size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5",
                      )}
                    />
                  </Link>
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
    </>
  );
}
