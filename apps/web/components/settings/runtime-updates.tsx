"use client";

import {
  type Device,
  type InstallMethod,
  RUNTIME_UPDATES_RANK,
  type RuntimeId,
  type RuntimeMaintenanceStatus,
  type RuntimeUpdateRun,
  type RuntimeUpdateRunState,
  type RuntimeUpdatesLevel,
} from "@ocw/contracts";
import { ChevronRight, History, Lock, RefreshCw, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { RUNTIMES, RuntimeLogo } from "@/components/work-zone/meta";
import { useMediaQuery } from "@/hooks/use-media-query";
import { errorMessage } from "@/lib/api";
import { useRequestRuntimeUpdate, useRuntimeUpdateHistory } from "@/lib/device-queries";
import { cn, relativeTime } from "@/lib/utils";
import { CopyLine } from "./copy-line";
import { historyDate } from "./policy-history-sheet";

/**
 * Settings › Devices › Runtime updates (Phase 07.11, D-05, D-06, PD-15): what the device reports about its coding
 * CLIs, for the device owner and admins only. The block renders only when the API sent `runtimeMaintenance` (it does
 * so only for `device.maintain` holders), and "Update now" only when `viewerCan` has `device.maintain`: the web
 * displays and requests, the API decides and audits (D-09).
 */

export const METHOD_LABEL: Record<InstallMethod, string> = {
  native: "Native installer",
  codex_standalone: "Standalone installer",
  npm: "npm",
  pnpm: "pnpm",
  bun: "bun",
  yarn: "Yarn",
  volta: "Volta",
  homebrew_cask: "Homebrew",
  homebrew_formula: "Homebrew",
  system_package: "System package",
  mise: "mise",
  asdf: "asdf",
  project_local: "Project dependency",
  sdk_bundled: "Bundled with OCW",
  windows: "Windows",
  unknown: "Unknown",
  not_installed: "Not installed",
};

export const LEVEL_LABEL: Record<RuntimeUpdatesLevel, string> = {
  automatic: "Automatic",
  notify: "Notify only",
  off: "Off",
};

const LEVEL_SENTENCE: Record<RuntimeUpdatesLevel, string> = {
  automatic: "Updates install when the agent is idle; turns are never cut.",
  notify: "New versions are reported; install them with Update now.",
  off: "Updates are off.",
};

export type PillTone = "success" | "brand" | "outline" | "warning" | "destructive";

export interface RuntimeUpdatePill {
  label: string;
  tone: PillTone;
  /** An update is in progress on the device (the pill carries a spinner). */
  busy: boolean;
  /** Extra detail on hover ("since 2 hours ago"). */
  title?: string;
}

const UPDATING: ReadonlySet<RuntimeMaintenanceStatus["state"]> = new Set(["running", "draining", "queued"]);

/** The status pill of one runtime row (PD-15): an update in progress first, then what the version needs. */
export function runtimeUpdateStatus(
  s: RuntimeMaintenanceStatus,
  now: number = Date.now(),
): RuntimeUpdatePill {
  const pill = (label: string, tone: PillTone, title?: string): RuntimeUpdatePill => ({
    label,
    tone,
    busy: false,
    ...(title ? { title } : {}),
  });
  if (UPDATING.has(s.state)) return { label: "Updating…", tone: "outline", busy: true };
  if (s.state === "pending") {
    return pill(
      "Waiting for an idle moment",
      "outline",
      s.pendingSince ? `since ${relativeTime(s.pendingSince, now)}` : undefined,
    );
  }
  if (s.method === "not_installed" || s.reason === "not_installed") return pill("Not installed", "outline");
  if (s.installedCompatibility === "broken") return pill("Can't run sessions", "destructive");
  if (s.lastRun?.outcome === "failed" && s.advisory !== "current")
    return pill("Update failed", "destructive");
  if (s.installedCompatibility === "unsupported") return pill("Unsupported version", "warning");
  if (s.advisory === "behind" && s.latestVersion) return pill(`${s.latestVersion} available`, "brand");
  if (s.advisory === "current") return pill("Up to date", "success");
  return pill("Not checked", "outline");
}

/** The row's last line: the last run, else the last check (null when neither happened). */
export function lastRunText(s: RuntimeMaintenanceStatus, now: number = Date.now()): string | null {
  const run = s.lastRun;
  if (run) {
    const when = relativeTime(run.at, now);
    switch (run.outcome) {
      case "succeeded":
        return run.fromVersion && run.toVersion && run.fromVersion !== run.toVersion
          ? `Updated ${run.fromVersion} → ${run.toVersion} · ${when}`
          : `Updated ${when}`;
      case "unchanged":
        return `Update ran ${when} · version unchanged`;
      case "failed":
        return `Update failed ${when}`;
      case "skipped_broken":
        return `Skipped ${run.toVersion ?? "a version"} (known not to work) · ${when}`;
    }
  }
  return s.checkedAt ? `Checked ${relativeTime(s.checkedAt, now)}` : null;
}

/** Why "Update now" is disabled, or null when it can be pressed (the API decides again). */
export function updateNowBlock(device: Device, s: RuntimeMaintenanceStatus): string | null {
  if (device.status !== "online") return "The device is offline";
  if (device.runtimeMaintenance?.effectiveLevel === "off") return "Runtime updates are off";
  if (s.state === "pending") return "An update is waiting for an idle moment";
  if (s.state !== "idle") return "An update is in progress";
  return null;
}

const RUN_STATE: Record<RuntimeUpdateRunState, { label: string; tone: PillTone | "secondary" }> = {
  requested: { label: "Requested", tone: "outline" },
  started: { label: "Running", tone: "outline" },
  succeeded: { label: "Succeeded", tone: "success" },
  unchanged: { label: "Unchanged", tone: "secondary" },
  failed: { label: "Failed", tone: "destructive" },
  skipped_broken: { label: "Skipped: broken version", tone: "warning" },
  refused: { label: "Refused", tone: "warning" },
  expired: { label: "Expired", tone: "outline" },
};

/** Who started a run: "Automatic", "By Owen", "On the device". */
export function runTrigger(run: RuntimeUpdateRun): string {
  if (run.trigger === "automatic") return "Automatic";
  if (run.trigger === "local") return "On the device";
  return run.requestedBy ? `By ${run.requestedBy.name ?? "a member"}` : "Update now";
}

function runVersions(run: RuntimeUpdateRun): string | null {
  const to = run.toVersion ?? run.candidate;
  if (run.fromVersion && to && run.fromVersion !== to) return `${run.fromVersion} → ${to}`;
  return run.fromVersion ?? to ?? null;
}

const TERMINAL: ReadonlySet<RuntimeUpdateRunState> = new Set([
  "succeeded",
  "unchanged",
  "failed",
  "skipped_broken",
  "refused",
  "expired",
]);

export function DeviceRuntimeUpdates({ device }: { device: Device }) {
  const [history, setHistory] = useState<RuntimeId | null>(null);
  const m = device.runtimeMaintenance;
  if (!m) return null;
  const canMaintain = device.viewerCan?.includes("device.maintain") ?? false;
  const warn = m.runtimes.some(
    (r) =>
      r.installedCompatibility === "unsupported" ||
      r.installedCompatibility === "broken" ||
      r.lastRun?.outcome === "failed",
  );
  const lowered = RUNTIME_UPDATES_RANK[m.localLevel] < RUNTIME_UPDATES_RANK[m.orgLevel];
  return (
    <div className="flex items-start gap-2.5" data-testid="runtime-updates" data-level={m.effectiveLevel}>
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5",
          // The Full access fact's warning tile (WINDOWS #197: 3:1 in both themes).
          warn
            ? "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300"
            : "bg-muted text-muted-foreground",
        )}
      >
        {warn ? <TriangleAlert /> : <RefreshCw />}
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-sm">
          Runtime updates
          <span
            data-testid="runtime-update-level"
            className="inline-flex flex-wrap items-center gap-1 font-normal text-muted-foreground text-xs"
          >
            Organization: {LEVEL_LABEL[m.orgLevel]} · This device: {LEVEL_LABEL[m.localLevel]}
            {lowered ? (
              <span className="inline-flex items-center gap-1">
                · <Lock className="size-3" aria-hidden /> Set on the device
              </span>
            ) : null}
          </span>
        </p>
        <p className="text-sm">{LEVEL_SENTENCE[m.effectiveLevel]}</p>
        <ul className="mt-2 divide-y rounded-lg border" aria-label="Coding agents on this device">
          {m.runtimes.map((s) => (
            <RuntimeUpdateRow
              key={s.runtime}
              device={device}
              status={s}
              canMaintain={canMaintain}
              onHistory={() => setHistory(s.runtime)}
            />
          ))}
        </ul>
      </div>
      {canMaintain ? (
        <RuntimeUpdateHistorySheet
          device={device}
          runtime={history ?? undefined}
          open={history !== null}
          onOpenChange={(o) => {
            if (!o) setHistory(null);
          }}
        />
      ) : null}
    </div>
  );
}

export function RuntimeUpdateRow({
  device,
  status: s,
  canMaintain,
  onHistory,
  now,
}: {
  device: Device;
  status: RuntimeMaintenanceStatus;
  canMaintain: boolean;
  onHistory: () => void;
  now?: number;
}) {
  const label = RUNTIMES[s.runtime].label;
  const request = useRequestRuntimeUpdate(device.id);
  // The run "Update now" created: followed until it ends, so a refusal on the device (already up to date, …) or a
  // failure is said where it was asked for.
  const [tracked, setTracked] = useState<string | null>(null);
  const runs = useRuntimeUpdateHistory(device.id, s.runtime, tracked !== null, {
    refetchInterval: tracked ? 2000 : false,
  });
  const trackedRun = tracked ? runs.data?.find((r) => r.id === tracked) : undefined;
  useEffect(() => {
    if (!trackedRun || !TERMINAL.has(trackedRun.state)) return;
    setTracked(null);
    if (trackedRun.state === "succeeded" && trackedRun.toVersion) {
      toast.success(`${label} updated to ${trackedRun.toVersion}`);
    } else if (trackedRun.state === "failed") {
      toast.error(`${label} update failed`, trackedRun.error ? { description: trackedRun.error } : undefined);
    } else if (trackedRun.state === "refused" || trackedRun.state === "expired") {
      toast.error(trackedRun.error ?? `The device didn't run the ${label} update`);
    }
  }, [trackedRun, label]);

  const pill = runtimeUpdateStatus(s, now);
  const last = lastRunText(s, now);
  const block = updateNowBlock(device, s);
  const busy = request.isPending || tracked !== null || pill.busy;
  return (
    <li
      data-testid="runtime-update-row"
      data-runtime={s.runtime}
      data-state={s.state}
      className="flex flex-col gap-2.5 px-3 py-2.5 md:flex-row md:items-start md:gap-3"
    >
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <RuntimeLogo runtime={s.runtime} className="size-4 shrink-0 rounded-[4px]" />
          <span className="font-medium text-sm">{label}</span>
          {s.installedVersion ? (
            <span className="font-mono text-muted-foreground text-xs" data-testid="runtime-update-version">
              {s.installedVersion}
            </span>
          ) : null}
          <Badge variant={pill.tone} title={pill.title} data-testid="runtime-update-status">
            {pill.busy ? <Spinner className="size-3" /> : null}
            {pill.label}
          </Badge>
        </div>
        <MethodLine status={s} />
        {last ? <p className="text-muted-foreground text-xs">{last}</p> : null}
      </div>
      {canMaintain ? (
        <div className="flex gap-2 *:flex-1 md:shrink-0 md:*:flex-none">
          {s.canUpdate ? (
            <Button
              size="sm"
              variant="outline"
              className="min-h-11 md:min-h-8"
              data-testid="runtime-update-now"
              disabled={busy || block !== null}
              title={block ?? undefined}
              onClick={() =>
                request.mutate(s.runtime, {
                  onSuccess: ({ run }) => setTracked(run.id),
                  onError: (err) => toast.error(errorMessage(err)),
                })
              }
            >
              {busy ? <Spinner className="size-3.5" /> : <RefreshCw />}
              {busy ? "Updating…" : "Update now"}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11 md:min-h-8"
            data-testid="runtime-update-history"
            aria-label={`${label} update history`}
            onClick={onHistory}
          >
            <History /> History
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function MethodLine({ status: s }: { status: RuntimeMaintenanceStatus }) {
  const method = METHOD_LABEL[s.method];
  if (s.reason === "not_installed" || s.method === "not_installed") {
    return <p className="text-muted-foreground text-xs">Not installed on this device.</p>;
  }
  if (s.reason === "updates_disabled") {
    return (
      <p className="text-muted-foreground text-xs">Updates are disabled on this machine (DISABLE_UPDATES).</p>
    );
  }
  if (s.reason === "needs_admin" || s.reason === "manual") {
    return (
      <div className="grid gap-1.5">
        <p className="text-muted-foreground text-xs">
          {s.reason === "needs_admin"
            ? "Needs admin on this machine:"
            : `Installed with ${method}. Update it with the tool that installed it.`}
        </p>
        {s.updateCommand ? <CopyLine text={s.updateCommand} buttonClassName="max-md:size-11" /> : null}
      </div>
    );
  }
  return (
    <p className="text-muted-foreground text-xs">
      {method}
      {s.location ? ` · ${s.location}` : ""}
    </p>
  );
}

/**
 * A runtime's update history (D-06, PD-04): newest first, who or what started each run, versions, outcome, the
 * device's reason for a refusal and the (path-free) output as plain text (T-07.11-10-03: never Markdown or HTML).
 */
export function RuntimeUpdateHistorySheet({
  device,
  runtime,
  open,
  onOpenChange,
}: {
  device: Device;
  runtime: RuntimeId | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const wide = useMediaQuery("(min-width: 640px)", true);
  const history = useRuntimeUpdateHistory(device.id, runtime, open);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={wide ? "right" : "bottom"}
        showClose={false}
        className={cn(wide ? "w-[28rem]" : "h-[80dvh]")}
        data-testid="runtime-update-history-sheet"
      >
        <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
          <div className="min-w-0">
            <SheetTitle className="break-words">{device.name} · Runtime updates</SheetTitle>
            <SheetDescription className="text-xs">
              {runtime ? RUNTIMES[runtime].label : "All coding agents"} · newest first
            </SheetDescription>
          </div>
          <SheetClose
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close"
                className="-mt-1 -mr-2 text-muted-foreground max-md:size-11"
              />
            }
          >
            <X />
          </SheetClose>
        </div>
        <div
          role="region"
          aria-label="Update runs"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (axe)
          tabIndex={0}
          className="scrollbar-thin min-h-0 flex-1 overflow-y-auto pb-[max(env(safe-area-inset-bottom),12px)] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset"
        >
          <RunList history={history} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function RunList({
  history,
}: {
  history: {
    data?: RuntimeUpdateRun[] | undefined;
    isPending: boolean;
    isError: boolean;
    isFetching: boolean;
    refetch: () => unknown;
  };
}) {
  if (history.isPending) {
    return (
      <ul className="divide-y" aria-busy>
        {[0, 1, 2].map((i) => (
          <li key={i} className="grid gap-2 px-5 py-3">
            <Skeleton className="h-3.5 w-56 max-w-full motion-reduce:animate-none" />
            <Skeleton className="h-3 w-32 motion-reduce:animate-none" />
          </li>
        ))}
      </ul>
    );
  }
  if (history.isError) {
    return <ServerUnreachable onRetry={() => void history.refetch()} retrying={history.isFetching} />;
  }
  const runs = history.data ?? [];
  if (runs.length === 0) {
    return <p className="px-5 py-10 text-center text-muted-foreground text-sm">No updates yet.</p>;
  }
  return (
    <ul className="divide-y" data-testid="runtime-update-runs">
      {runs.map((run) => (
        <RunItem key={run.id} run={run} />
      ))}
    </ul>
  );
}

function RunItem({ run }: { run: RuntimeUpdateRun }) {
  const outcome = RUN_STATE[run.state];
  const versions = runVersions(run);
  const at = run.finishedAt ?? run.startedAt ?? run.requestedAt;
  return (
    <li className="grid gap-1 px-5 py-3" data-testid="runtime-update-run" data-state={run.state}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <RuntimeLogo runtime={run.runtime} className="size-4 shrink-0 rounded-[4px]" />
        <span className="font-medium text-sm">{RUNTIMES[run.runtime].label}</span>
        {versions ? <span className="font-mono text-muted-foreground text-xs">{versions}</span> : null}
        <Badge variant={outcome.tone}>{outcome.label}</Badge>
      </div>
      <p className="text-muted-foreground text-xs">
        {runTrigger(run)}
        {at ? (
          <>
            {" · "}
            <time dateTime={at}>{historyDate(at)}</time>
          </>
        ) : null}
      </p>
      {run.error ? <p className="break-words text-[13px] text-destructive">{run.error}</p> : null}
      {run.output ? (
        <details className="group text-xs">
          <summary className="flex min-h-11 w-fit cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground md:min-h-7 [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden className="size-3.5 transition-transform group-open:rotate-90" />
            Output
          </summary>
          <pre
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (axe)
            tabIndex={0}
            className="scrollbar-thin mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/50 p-2 font-mono text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
          >
            {run.output}
          </pre>
        </details>
      ) : null}
    </li>
  );
}
