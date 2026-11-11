"use client";

import {
  type Device,
  type InstallMethod,
  OCW_RUNTIME_TARGET,
  RUNTIME_SELF_BLOCK_SENTENCES,
  RUNTIME_SELF_UPDATE_REFUSAL_SENTENCES,
  RUNTIME_UPDATE_TARGET_LABEL,
  RUNTIME_UPDATES_RANK,
  type RuntimeCompatibility,
  type RuntimeMaintenanceStatus,
  type RuntimeSelfStatus,
  type RuntimeSelfUpdateState,
  type RuntimeUpdateRun,
  type RuntimeUpdateRunState,
  type RuntimeUpdatesLevel,
  type RuntimeUpdateTarget,
  runtimeInstallCommand,
} from "@ocw/contracts";
import { ChevronRight, History, Lock, RefreshCw, Server, TriangleAlert, X } from "lucide-react";
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
import { useRuntimeConfig } from "@/lib/config";
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
  ocw_bundle: "Installed from your workspace",
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
export function lastRunText(
  s: Pick<RuntimeMaintenanceStatus, "lastRun" | "checkedAt">,
  now: number = Date.now(),
): string | null {
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

/**
 * The suffix every viewer sees on a device's runtime chip (D-04): what the Control Plane's manifest says about the
 * installed version. Amber / red text in the Badge pill colours (AA in both themes); null when it can run sessions.
 */
export function compatFlag(
  compat: RuntimeCompatibility | undefined,
): { text: string; className: string } | null {
  if (compat === "unsupported")
    return { text: "· older than supported", className: "text-amber-700 dark:text-amber-300" };
  if (compat === "broken")
    return { text: "· can't run sessions", className: "text-red-700 dark:text-red-300" };
  return null;
}

/** Why "Update now" is disabled, or null when it can be pressed (the API decides again). */
export function updateNowBlock(device: Device, s: RuntimeMaintenanceStatus): string | null {
  if (device.status !== "online") return "The device is offline";
  if (device.runtimeMaintenance?.effectiveLevel === "off") return "Runtime updates are off";
  if (s.state === "pending") return "An update is waiting for an idle moment";
  if (s.state !== "idle") return "An update is in progress";
  if (s.advisory === "current") return "Already up to date";
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

/** A run's versions; an OCW runtime run names both builds, since the build (not the version) is its identity (D-10). */
function runVersions(run: RuntimeUpdateRun): string | null {
  if (run.fromBuild || run.toBuild) {
    const from = withBuild(run.fromVersion, run.fromBuild);
    const to = withBuild(run.toVersion ?? run.candidate, run.toBuild);
    if (from && to && from !== to) return `${from} → ${to}`;
    return from ?? to;
  }
  const to = run.toVersion ?? run.candidate;
  if (run.fromVersion && to && run.fromVersion !== to) return `${run.fromVersion} → ${to}`;
  return run.fromVersion ?? to ?? null;
}

/** "0.3.1 · 1a2b3c4d5e6f", or the version alone when there is no build (a checkout, the desktop app). */
function withBuild(version: string | null | undefined, build: string | null | undefined): string | null {
  if (!version) return build ?? null;
  return build ? `${version} · ${build}` : version;
}

/** The history sheet's subtitle for one maintenance target, or every one. */
export function runtimeHistoryTitle(runtime: RuntimeUpdateTarget | undefined): string {
  return `${runtime ? RUNTIME_UPDATE_TARGET_LABEL[runtime] : "All coding agents"} · newest first`;
}

const TERMINAL: ReadonlySet<RuntimeUpdateRunState> = new Set([
  "succeeded",
  "unchanged",
  "failed",
  "skipped_broken",
  "refused",
  "expired",
]);

/**
 * Review WR-03: the clock the Runtime row reads, ticking every 15 s only while the device is offline in the middle of
 * its own update (so "Restarting…" turns into "Did not come back" without a reload).
 */
function useSelfClock(active: boolean, fixed: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || fixed !== undefined) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [active, fixed]);
  // Otherwise every render reads the wall clock, as before.
  return fixed ?? (active ? now : undefined);
}

export function DeviceRuntimeUpdates({ device, now: fixedNow }: { device: Device; now?: number }) {
  const [history, setHistory] = useState<RuntimeUpdateTarget | null>(null);
  const m = device.runtimeMaintenance;
  const selfBusyOffline = device.status !== "online" && !!m?.self && m.self.state !== "idle";
  const now = useSelfClock(selfBusyOffline, fixedNow);
  if (!m) return null;
  const canMaintain = device.viewerCan?.includes("device.maintain") ?? false;
  const selfView = runtimeSelfView(device, now ?? Date.now());
  const warn =
    selfView.kind === "failed" ||
    selfView.kind === "not_back" ||
    m.runtimes.some(
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
        <ul className="mt-2 divide-y rounded-lg border" aria-label="Runtimes on this device">
          {selfView.kind !== "hidden" ? (
            <RuntimeSelfRow
              device={device}
              view={selfView}
              canMaintain={canMaintain}
              onHistory={() => setHistory(OCW_RUNTIME_TARGET)}
              now={now}
            />
          ) : null}
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

// ---- 07.17.1 (D-01, D-04, D-05, D-07, D-10, PD-17): the device's own OCW runtime ----

const SELF_LABEL = RUNTIME_UPDATE_TARGET_LABEL[OCW_RUNTIME_TARGET];

const SELF_BUSY_LABEL: Record<Exclude<RuntimeSelfUpdateState, "idle">, string> = {
  downloading: "Downloading…",
  installing: "Installing…",
  waiting: "Waiting for sessions to finish",
  restarting: "Restarting…",
};

/** What the effective level means for the runtime itself (notify says nothing: Update is the way). */
const SELF_LEVEL_LINE: Partial<Record<RuntimeUpdatesLevel, string>> = {
  automatic: "Updates by itself when no session runs",
  off: "Automatic checks are off. Update still works.",
};

/**
 * Everything the Runtime row can show, decided only from what the device and the API reported (the API re-decides every
 * request). `installed` is "version · build" (the build alone tells two bundles apart, D-10).
 */
export type RuntimeSelfView =
  | { kind: "behind"; installed: string; served: string; servedVersion: string; canPress: true }
  | { kind: "failed"; installed: string; served: string; servedVersion: string; canPress: true }
  | { kind: "current"; installed: string }
  | { kind: "busy"; installed: string; label: string }
  /** Review WR-03: busy when the device went offline, and still gone past `SELF_NOT_BACK_AFTER_MS`. */
  | { kind: "not_back"; installed: string; since: string | null }
  | { kind: "blocked"; installed: string; note: string }
  | { kind: "not_served"; installed: string }
  /** The desktop app ships its runtime (D-01): no button. */
  | { kind: "desktop"; installed: string | null }
  /** A server daemon older than 07.17.1 reports no `self`: one more install command run turns the button on. */
  | { kind: "legacy"; installed: string | null }
  /** A runtime of unknown host kind not installed with the install command (a checkout). */
  | { kind: "unmanaged"; installed: string; note: string }
  /** Nothing reported (a device of unknown kind and an older daemon): the section shows the CLI rows only. */
  | { kind: "hidden" };

/** The build the workspace serves: the API's (PD-15), else the device's last check (an API that does not send it). */
function servedOf(device: Device, s: RuntimeSelfStatus): { version: string; build: string } | null {
  const served = device.runtimeMaintenance?.served;
  if (served !== undefined) return served;
  return s.servedVersion && s.servedBuild ? { version: s.servedVersion, build: s.servedBuild } : null;
}

/**
 * Review WR-03: a device that went offline during its own update and has not been seen for this long did not come back
 * (a normal restart reconnects within seconds).
 */
export const SELF_NOT_BACK_AFTER_MS = 3 * 60_000;

/** The device went offline while busy with its own update, and has stayed away past `SELF_NOT_BACK_AFTER_MS`. */
function notBack(device: Device, now: number): boolean {
  if (device.status === "online") return false;
  return device.lastSeenAt === null || Date.parse(device.lastSeenAt) <= now - SELF_NOT_BACK_AFTER_MS;
}

/**
 * The Runtime row's view (pure): the host kind first (desktop, an older server daemon, a checkout), then an update
 * that did not come back, then busy, then why it can't update, then installed vs served.
 */
export function runtimeSelfView(device: Device, now: number = Date.now()): RuntimeSelfView {
  const s = device.runtimeMaintenance?.self;
  if (device.hostKind === "desktop") {
    return { kind: "desktop", installed: s ? withBuild(s.version, s.build) : device.daemonVersion };
  }
  if (!s)
    return device.hostKind === "service"
      ? { kind: "legacy", installed: device.daemonVersion }
      : { kind: "hidden" };
  const installed = withBuild(s.version, s.build) ?? s.version;
  if (device.hostKind !== "service" && s.reason === "not_installed") {
    return { kind: "unmanaged", installed, note: RUNTIME_SELF_BLOCK_SENTENCES.not_installed };
  }
  if (s.state !== "idle" && notBack(device, now)) {
    return { kind: "not_back", installed, since: device.lastSeenAt };
  }
  if (s.state !== "idle") return { kind: "busy", installed, label: SELF_BUSY_LABEL[s.state] };
  if (s.reason) return { kind: "blocked", installed, note: RUNTIME_SELF_BLOCK_SENTENCES[s.reason] };
  const served = servedOf(device, s);
  if (!served) return { kind: "not_served", installed };
  if (s.build === served.build) return { kind: "current", installed };
  const behind = {
    installed,
    served: `${served.version} · ${served.build}`,
    servedVersion: served.version,
    canPress: true as const,
  };
  return s.lastRun?.outcome === "failed" ? { kind: "failed", ...behind } : { kind: "behind", ...behind };
}

function selfPill(
  view: RuntimeSelfView,
  s: RuntimeSelfStatus | undefined,
  now?: number,
): RuntimeUpdatePill | null {
  switch (view.kind) {
    case "behind":
      return { label: `${view.servedVersion} available`, tone: "brand", busy: false };
    case "failed":
      return { label: "Update failed", tone: "warning", busy: false };
    case "current":
      return { label: "Up to date", tone: "success", busy: false };
    case "not_back":
      return {
        label: "Did not come back",
        tone: "warning",
        busy: false,
        ...(view.since ? { title: `last seen ${relativeTime(view.since, now)}` } : {}),
      };
    case "busy":
      return {
        label: view.label,
        tone: "outline",
        busy: true,
        ...(s?.pendingSince ? { title: `since ${relativeTime(s.pendingSince, now)}` } : {}),
      };
    default:
      return null;
  }
}

/** The row's note for the views whose sentence is fixed (the blocked ones carry their own). */
const SELF_NOTE: Partial<Record<RuntimeSelfView["kind"], string>> = {
  not_served: RUNTIME_SELF_UPDATE_REFUSAL_SENTENCES.runtime_not_served,
  desktop: "Updates with the desktop app",
  legacy: "Re-run the install command once to turn on one-click updates.",
  not_back:
    "The runtime did not come back after updating. On the server, run `ocw-runtime doctor`; it names the way back " +
    "(`ocw-runtime updates off`, then the previous version). Re-run the install command once your workspace serves a " +
    "fixed build.",
};

/** The views that come from the device's own report and have a history worth opening. */
const SELF_HISTORY: ReadonlySet<RuntimeSelfView["kind"]> = new Set([
  "behind",
  "failed",
  "current",
  "busy",
  "not_back",
  "blocked",
  "not_served",
]);

/**
 * The OCW runtime's row, first in the device's list (PD-17): installed vs served, one Update (D-01) that the API decides
 * and audits, the run followed until it ends (D-07), and what to do where one click can't work (D-05).
 */
export function RuntimeSelfRow({
  device,
  view,
  canMaintain,
  onHistory,
  now,
}: {
  device: Device;
  view: RuntimeSelfView;
  canMaintain: boolean;
  onHistory: () => void;
  now?: number;
}) {
  const m = device.runtimeMaintenance;
  const s = m?.self;
  const request = useRequestRuntimeUpdate(device.id);
  // The run Update created, followed until it ends: the device restarts in between, so the answer comes from the API.
  const [tracked, setTracked] = useState<string | null>(null);
  const runs = useRuntimeUpdateHistory(device.id, OCW_RUNTIME_TARGET, tracked !== null, {
    refetchInterval: tracked ? 2000 : false,
  });
  const trackedRun = tracked ? runs.data?.find((r) => r.id === tracked) : undefined;
  useEffect(() => {
    if (!trackedRun || !TERMINAL.has(trackedRun.state)) return;
    setTracked(null);
    if (trackedRun.state === "succeeded" && trackedRun.toVersion) {
      toast.success(`${SELF_LABEL} updated to ${withBuild(trackedRun.toVersion, trackedRun.toBuild)}`);
    } else if (trackedRun.state === "failed") {
      toast.error(
        `${SELF_LABEL} update failed`,
        trackedRun.error ? { description: trackedRun.error } : undefined,
      );
    } else if (trackedRun.state === "refused" || trackedRun.state === "expired") {
      toast.error(trackedRun.error ?? `The device didn't run the ${SELF_LABEL} update`);
    }
  }, [trackedRun]);

  const pill = selfPill(view, s, now);
  const installed = "installed" in view ? view.installed : null;
  const note = "note" in view ? view.note : SELF_NOTE[view.kind];
  const { apiUrl } = useRuntimeConfig();
  const pressable = view.kind === "behind" || view.kind === "failed" || view.kind === "busy";
  const levelLine =
    m && (view.kind === "behind" || view.kind === "failed" || view.kind === "current")
      ? SELF_LEVEL_LINE[m.effectiveLevel]
      : undefined;
  const last = s && SELF_HISTORY.has(view.kind) ? lastRunText(s, now) : null;
  const showUpdate = canMaintain && pressable;
  const showHistory = canMaintain && SELF_HISTORY.has(view.kind);
  const busy = request.isPending || tracked !== null || view.kind === "busy";
  const block = device.status !== "online" ? "The device is offline" : null;
  return (
    <li
      data-testid="runtime-self-row"
      data-runtime={OCW_RUNTIME_TARGET}
      data-view={view.kind}
      data-state={s?.state}
      className="flex flex-col gap-2.5 px-3 py-2.5 md:flex-row md:items-start md:gap-3"
    >
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            aria-hidden
            className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-muted text-muted-foreground [&_svg]:size-3"
          >
            <Server />
          </span>
          <span className="font-medium text-sm">{SELF_LABEL}</span>
          {installed ? (
            <span className="font-mono text-muted-foreground text-xs" data-testid="runtime-self-version">
              {installed}
            </span>
          ) : null}
          {pill ? (
            <Badge variant={pill.tone} title={pill.title} data-testid="runtime-self-status">
              {pill.busy ? <Spinner className="size-3" /> : null}
              {pill.label}
            </Badge>
          ) : null}
        </div>
        {"served" in view ? (
          <p className="text-muted-foreground text-xs" data-testid="runtime-self-served">
            {`Your workspace serves ${view.served}`}
          </p>
        ) : null}
        {note ? (
          <p className="text-muted-foreground text-xs" data-testid="runtime-self-note">
            {note}
          </p>
        ) : null}
        {view.kind === "not_back" && view.since ? (
          <p className="text-muted-foreground text-xs">{`The device was last seen ${relativeTime(view.since, now)}`}</p>
        ) : null}
        {view.kind === "legacy" || view.kind === "not_back" ? (
          <CopyLine
            text={runtimeInstallCommand(apiUrl)}
            testId="runtime-self-install-command"
            buttonClassName="max-md:size-11"
            wrap
          />
        ) : null}
        {levelLine ? <p className="text-muted-foreground text-xs">{levelLine}</p> : null}
        {last ? <p className="text-muted-foreground text-xs">{last}</p> : null}
      </div>
      {showUpdate || showHistory ? (
        <div className="flex gap-2 *:flex-1 md:shrink-0 md:*:flex-none">
          {showUpdate ? (
            <Button
              size="sm"
              variant="outline"
              className="min-h-11 md:min-h-8"
              data-testid="runtime-self-update-now"
              aria-label={busy ? `Updating the ${SELF_LABEL}` : `Update the ${SELF_LABEL}`}
              disabled={busy || block !== null}
              title={block ?? undefined}
              onClick={() =>
                request.mutate(OCW_RUNTIME_TARGET, {
                  onSuccess: ({ run }) => setTracked(run.id),
                  onError: (err) => toast.error(errorMessage(err)),
                })
              }
            >
              {busy ? <Spinner className="size-3.5" /> : <RefreshCw />}
              {busy ? "Updating…" : "Update"}
            </Button>
          ) : null}
          {showHistory ? (
            <Button
              size="sm"
              variant="ghost"
              className="min-h-11 md:min-h-8"
              data-testid="runtime-self-history"
              aria-label={`${SELF_LABEL} update history`}
              onClick={onHistory}
            >
              <History /> History
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
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
  runtime: RuntimeUpdateTarget | undefined;
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
            <SheetDescription className="text-xs">{runtimeHistoryTitle(runtime)}</SheetDescription>
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
        {run.runtime === OCW_RUNTIME_TARGET ? (
          <Server className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <RuntimeLogo runtime={run.runtime} className="size-4 shrink-0 rounded-[4px]" />
        )}
        <span className="font-medium text-sm">{RUNTIME_UPDATE_TARGET_LABEL[run.runtime]}</span>
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
      {run.error ? (
        <p className="break-words text-[13px] text-red-700 dark:text-red-300">{run.error}</p>
      ) : null}
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
