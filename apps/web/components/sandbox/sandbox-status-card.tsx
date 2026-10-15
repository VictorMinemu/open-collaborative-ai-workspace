"use client";

import type { SandboxStatusView } from "@ocw/contracts";
import {
  CircleAlert,
  Container,
  Cpu,
  HardDrive,
  Info,
  type LucideIcon,
  OctagonX,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  Square,
  Timer,
} from "lucide-react";
import type { ReactNode } from "react";
import { formatBytes } from "@/components/chat/attachments/files";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn, relativeTime } from "@/lib/utils";
import { QuotaMeter } from "./quota-meter";

/**
 * The Sandbox tab's status card (07.8-15, UI-SPEC §3.1 "Status card", § Color › Live view and sandbox states, § Copy ›
 * Bot page): the state pill, the isolation line, when it was last used, its packages, the Disk, CPU today and Limits
 * cells, and Stop / Restart while it runs. The isolation is said as the API reports it: "Isolated with gVisor" only when
 * the sandbox runs on gVisor; anything else (hardened runc, or a runtime not reported yet) reads "Hardened container ·
 * weaker isolation", never more than is known.
 */

export type SandboxPresentation =
  | "running"
  | "starting"
  | "stopping"
  | "stopped"
  | "disk_full"
  | "killed"
  | "unavailable"
  | "absent";

/** The state the card shows: the API's state, with a stop reason that names a stronger cause. */
export function presentState(s: Pick<SandboxStatusView, "state" | "stopReason">): SandboxPresentation {
  switch (s.state) {
    case "stopped":
      if (s.stopReason === "kill_switch") return "killed";
      if (s.stopReason === "disk_full") return "disk_full";
      if (s.stopReason === "service_down") return "unavailable";
      return "stopped";
    default:
      return s.state;
  }
}

const PILL: Record<SandboxPresentation, { label: string; tone: string; dot?: string; spinner?: boolean }> = {
  running: {
    label: "Running",
    tone: "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300",
    dot: "bg-emerald-500 dark:bg-emerald-400",
  },
  starting: {
    label: "Starting…",
    tone: "bg-primary/10 text-primary dark:bg-primary/20 dark:text-blue-200",
    spinner: true,
  },
  stopping: {
    label: "Stopping…",
    tone: "bg-primary/10 text-primary dark:bg-primary/20 dark:text-blue-200",
    spinner: true,
  },
  stopped: { label: "Stopped", tone: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/70" },
  disk_full: {
    label: "Disk full",
    tone: "bg-red-100 text-red-800 dark:bg-red-400/15 dark:text-red-300",
    dot: "bg-red-500",
  },
  killed: {
    label: "Stopped by an admin",
    tone: "bg-red-100 text-red-800 dark:bg-red-400/15 dark:text-red-300",
    dot: "bg-red-500",
  },
  unavailable: {
    label: "Unavailable",
    tone: "bg-red-100 text-red-800 dark:bg-red-400/15 dark:text-red-300",
    dot: "bg-red-500",
  },
  absent: { label: "Not started yet", tone: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/70" },
};

/** The state pill (Agent Card `StatusPill` semantics: `role="status"`, "Status: {label}"). */
export function SandboxStatePill({ state }: { state: SandboxPresentation }) {
  const p = PILL[state];
  return (
    <span
      role="status"
      aria-label={`Status: ${p.label}`}
      data-testid="sandbox-state-pill"
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 font-medium text-xs",
        p.tone,
      )}
    >
      {p.spinner ? (
        <Spinner className="size-3 motion-reduce:animate-none" />
      ) : (
        <span aria-hidden className={cn("inline-flex size-1.5 rounded-full", p.dot)} />
      )}
      {p.label}
    </span>
  );
}

/** "1 package" / "{n} packages"; nothing at 0. */
function packagesLabel(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "1 package" : `${n} packages`;
}

const minutes = (ms: number) => Math.round(ms / 60_000);

function Notice({
  tone,
  icon: Icon,
  testId,
  children,
}: {
  tone: "blocking" | "info";
  icon: LucideIcon;
  testId: string;
  children: ReactNode;
}) {
  return (
    <p
      data-testid={testId}
      className={cn(
        "flex items-start gap-2 rounded-lg px-3 py-2 text-sm leading-5",
        tone === "blocking"
          ? "border border-red-200 bg-red-50 text-red-800 dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-300"
          : "bg-muted/60 text-muted-foreground",
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function Cell({
  icon: Icon,
  label,
  testId,
  children,
}: {
  icon: LucideIcon;
  label: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div data-testid={testId} className="grid content-start gap-1.5 rounded-lg border bg-background p-3">
      <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        {label}
      </span>
      {children}
    </div>
  );
}

export function SandboxStatusCard({
  status,
  bot,
  actions,
  onStop,
  onRestart,
}: {
  status: SandboxStatusView;
  bot: string;
  /** Stop / Restart sit in the title row from 768 px, under the meta line below it (two halves, 44 px). */
  actions: "inline" | "row";
  onStop: () => void;
  onRestart: () => void;
}) {
  const state = presentState(status);
  const gvisor = status.runtime === "gvisor";
  const used = formatBytes(status.diskBytes);
  const quota = formatBytes(status.diskQuotaBytes);
  const packages = packagesLabel(status.packages);
  const meta: string[] = [];
  if (status.lastActiveAt) meta.push(`Last active ${relativeTime(status.lastActiveAt)}`);
  if (packages) meta.push(packages);
  if (state === "stopped") meta.push(`Starts when ${bot} needs it.`);
  const canAct = state === "running" && status.viewerCan.control;

  const buttons = canAct ? (
    <div className={cn("flex gap-2", actions === "row" ? "w-full" : "ml-auto shrink-0")}>
      <Button
        variant="outline"
        size="sm"
        onClick={onRestart}
        data-testid="sandbox-restart"
        className={cn(actions === "row" && "h-11 flex-1")}
      >
        <RotateCw /> Restart
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={onStop}
        data-testid="sandbox-stop"
        className={cn(actions === "row" && "h-11 flex-1")}
      >
        <Square /> Stop
      </Button>
    </div>
  ) : null;

  return (
    <section
      data-testid="sandbox-status"
      data-status={state}
      aria-labelledby="sandbox-status-title"
      className="grid gap-4 rounded-xl border bg-card p-4 shadow-xs sm:p-5"
    >
      <div className="grid gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Container className="size-[18px] text-muted-foreground" />
          </span>
          <h2 id="sandbox-status-title" className="font-semibold text-[15px] leading-5">
            Sandbox
          </h2>
          <span className={cn(actions === "row" && "ml-auto")}>
            <SandboxStatePill state={state} />
          </span>
          {actions === "inline" ? buttons : null}
        </div>
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground text-xs leading-4 md:pl-12">
          {state !== "unavailable" ? (
            <span
              data-testid="sandbox-isolation"
              className="inline-flex items-center gap-1 max-md:basis-full"
            >
              {gvisor ? (
                <>
                  <ShieldCheck aria-hidden className="size-3.5 shrink-0" />
                  Isolated with gVisor
                </>
              ) : (
                <>
                  <ShieldAlert aria-hidden className="size-3.5 shrink-0 text-amber-700 dark:text-amber-300" />
                  Hardened container · weaker isolation
                </>
              )}
            </span>
          ) : null}
          {/* A dot between items; the one after the isolation hides on phones, where the isolation has its own line. */}
          {meta.map((m, i) => (
            <span key={m} className="inline-flex items-center gap-1.5">
              {i > 0 || state !== "unavailable" ? (
                <span aria-hidden className={cn(i === 0 && "max-md:hidden")}>
                  ·
                </span>
              ) : null}
              {m}
            </span>
          ))}
        </p>
        {actions === "row" && buttons ? <div className="pt-1">{buttons}</div> : null}
      </div>

      {state === "disk_full" ? (
        <Notice tone="blocking" icon={CircleAlert} testId="sandbox-notice">
          The sandbox is full ({used} of {quota}). {bot} can't write files or run commands until you delete
          some.
        </Notice>
      ) : state === "killed" ? (
        <Notice tone="blocking" icon={OctagonX} testId="sandbox-notice">
          An admin stopped all sandboxes. Files are kept.
        </Notice>
      ) : state === "unavailable" ? (
        <Notice tone="blocking" icon={CircleAlert} testId="sandbox-notice">
          The sandbox service isn't reachable. Ask an admin to check Settings › Sandbox &amp; Browser.
        </Notice>
      ) : state === "absent" ? (
        <Notice tone="info" icon={Info} testId="sandbox-notice">
          No sandbox yet. It's created the first time {bot} needs it.
        </Notice>
      ) : null}

      <div className="grid gap-3 md:grid-cols-3">
        <Cell icon={HardDrive} label="Disk" testId="sandbox-disk">
          <span className="font-semibold text-sm tabular-nums">
            {used} of {quota}
          </span>
          <QuotaMeter used={status.diskBytes} max={status.diskQuotaBytes} label="Disk used" />
        </Cell>
        <Cell icon={Cpu} label="CPU today" testId="sandbox-cpu">
          <span className="font-semibold text-sm tabular-nums">{minutes(status.cpuMsToday)} min</span>
          <span className="text-muted-foreground text-xs tabular-nums">
            Organization: {Math.round(status.org.cpuMinutesToday)} of {status.org.cpuMinutesPerDay} min today
          </span>
          <QuotaMeter
            used={status.org.cpuMinutesToday}
            max={status.org.cpuMinutesPerDay}
            label="CPU minutes today"
          />
        </Cell>
        <Cell icon={Timer} label="Limits" testId="sandbox-limits">
          <span className="text-sm tabular-nums">
            {status.limits.cpus} CPU · {formatBytes(status.limits.memoryBytes)} memory · {status.limits.pids}{" "}
            processes
          </span>
          <span className="text-muted-foreground text-xs">
            Stops after {status.limits.idleStopMinutes} min without use
          </span>
        </Cell>
      </div>

      {status.teamBot ? (
        <p
          data-testid="sandbox-team-notice"
          className="flex items-start gap-1.5 text-muted-foreground text-xs"
        >
          <Info aria-hidden className="mt-px size-3.5 shrink-0" />
          Everyone who can use {bot} works with these files. Files you upload are visible to its other
          conversations.
        </p>
      ) : null}
    </section>
  );
}

/** Status card skeleton: the title and three cells (UI-SPEC States › Sandbox tab › Loading). */
export function SandboxStatusSkeleton() {
  return (
    <div
      data-testid="sandbox-status-loading"
      aria-busy
      className="grid gap-4 rounded-xl border bg-card p-4 shadow-xs sm:p-5"
    >
      <div className="flex items-center gap-3">
        <Skeleton className="size-9 rounded-lg motion-reduce:animate-none" />
        <Skeleton className="h-4 w-24 motion-reduce:animate-none" />
        <Skeleton className="h-6 w-20 rounded-full motion-reduce:animate-none" />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {["disk", "cpu", "limits"].map((k) => (
          <Skeleton key={k} className="h-20 rounded-lg motion-reduce:animate-none" />
        ))}
      </div>
    </div>
  );
}
