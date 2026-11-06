"use client";

import {
  type Device,
  EFFORT_LABELS,
  type PermissionMode,
  type Project,
  type RuntimeCompatibility,
  type RuntimeId,
  type RuntimeInfo,
} from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, FolderPlus, LockOpen, Rocket, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useGrain } from "@/components/shell/module-gate";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/panel-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage, isApiError } from "@/lib/api";
import { useDesktop } from "@/lib/desktop";
import { defaultAudience, groupRepos, isStartable } from "@/lib/new-session-groups";
import { readNewSessionPrefs, saveNewSessionPrefs } from "@/lib/new-session-prefs";
import { useMe } from "@/lib/queries";
import { type DraftAudience, draftInput } from "@/lib/session-visibility";
import { cn } from "@/lib/utils";
import {
  useCreateWorkSession,
  useDevices,
  useProjects,
  useRuntimeControls,
  wzKeys,
} from "@/lib/workzone-queries";
import { controlReasonText, isShown, PERMISSION_MODES, RUNTIMES, RuntimeLogo } from "./meta";
import {
  AddServerLink,
  onRadioGroupKeyDown,
  ProjectList,
  ProjectsEmpty,
  ProjectsLoading,
  RowCheck,
  radioRowClass,
  TOUCH,
} from "./new-session-sections";
import { NewSessionVisibilityLine } from "./visibility/new-session-visibility-line";
import type { NewSessionPreselect } from "./work-zone-context";

export { AddServerLink, stepRadio } from "./new-session-sections";

/** Before the device's controls load (or for a device with no catalog): the modes every runtime always had. */
const LEGACY_MODES: PermissionMode[] = ["default", "acceptEdits", "plan"];

const RUNTIME_IDS = ["claude-code", "codex"] as const;

/** "Leo Park" · "Leo Park and Pia Gómez" · "Leo Park, Pia Gómez and 2 more". */
function namesOf(names: readonly string[]): string {
  const [a, b] = names;
  if (names.length === 1 || !b) return a ?? "";
  return names.length === 2 ? `${a} and ${b}` : `${a}, ${b} and ${names.length - 2} more`;
}

/**
 * A runtime card on the chosen device (D-04, PD-13): installed and signed in, and not a version that can't run sessions
 * (`broken`); an `unsupported` version stays usable with a warning. `whoUpdates` ends the note: "ask Owen to update".
 */
export function runtimeCardState(
  info: RuntimeInfo | undefined,
  compat: RuntimeCompatibility | undefined,
  whoUpdates: string,
): { ready: boolean; note: string | null; tone: "muted" | "warning" | "destructive" } {
  if (!info?.installed) return { ready: false, note: "Not installed on this device", tone: "muted" };
  if (!info.loggedIn) return { ready: false, note: "Not signed in on this device", tone: "muted" };
  const version = info.version ?? "This version";
  if (compat === "broken") {
    return { ready: false, note: `${version} can't run sessions · ${whoUpdates}`, tone: "destructive" };
  }
  if (compat === "unsupported") {
    return { ready: true, note: `${version} is older than supported · ${whoUpdates}`, tone: "warning" };
  }
  return { ready: true, note: null, tone: "muted" };
}

/** Who can update a device's CLIs, as the end of the card's note. */
export function whoUpdates(
  device: Pick<Device, "ownerUserId" | "ownerName">,
  meId: string | undefined,
): string {
  return device.ownerUserId === meId
    ? "update it in Settings › Devices"
    : `ask ${device.ownerName ?? "its owner"} to update`;
}

/**
 * The create request's audience was refused (07.9-06: 422 `audience_outside_project` / `team_not_assigned`, entry ids
 * only): the dialog words it with the names it showed in the draft (UI-SPEC Copy "Refusal (inline)", D-04, D-13), e.g.
 * "Leo Park isn't in Customer portal anymore. Choose who can see it again." Null when it is another error, or when no
 * refused id is one the draft named (the API's own message is shown then).
 */
export function audienceRefusal(
  err: unknown,
  draft: DraftAudience | null,
  project: Pick<Project, "deviceName" | "teamProject"> | null,
): string | null {
  if (!isApiError(err, 422) || !draft || !project) return null;
  const details = err.details as { ids?: unknown } | null | undefined;
  const ids = Array.isArray(details?.ids)
    ? details.ids.filter((x): x is string => typeof x === "string")
    : [];
  const again = "Choose who can see it again.";
  const tp = project.teamProject;
  if (err.code === "audience_outside_project" && draft.kind === "people") {
    const names = draft.people.filter((p) => ids.includes(p.userId)).map((p) => p.name);
    if (names.length === 0) return null;
    const one = names.length === 1;
    return tp
      ? `${namesOf(names)} ${one ? "isn't" : "aren't"} in ${tp.name} anymore. ${again}`
      : `${namesOf(names)} can't use ${project.deviceName} anymore. ${again}`;
  }
  if (err.code === "team_not_assigned" && draft.kind === "teams" && tp) {
    const names = draft.teams.filter((t) => ids.includes(t.id)).map((t) => t.name);
    if (names.length === 0) return null;
    return `${namesOf(names)} ${names.length === 1 ? "isn't" : "aren't"} assigned to ${tp.name} anymore. ${again}`;
  }
  return null;
}

/**
 * The repository the dialog opens on (07.9 rule, 07.10-05 R5). A repository nobody can start on from here (D-14: its
 * project is hidden from the caller) is never preselected. A repository id is kept when it is one the caller may
 * choose; a team project picks its first online repository, else its first. Without a usable target, the repository the
 * viewer started their last session on (`lastUsed`), when it is still listed and its device online; then the first
 * online repository, else the first. Never forced: the API decides.
 */
export function preselectedRepo(
  available: readonly Project[],
  target: NewSessionPreselect | undefined,
  lastUsed?: string | null,
): string | null {
  const startable = available.filter((p) => !p.teamProjectHidden);
  const firstOf = (list: readonly Project[]) => list.find((p) => p.deviceOnline) ?? list[0];
  let chosen: Project | undefined;
  if (typeof target === "string") chosen = startable.find((p) => p.id === target);
  else if (target) chosen = firstOf(startable.filter((p) => p.teamProject?.id === target.teamProjectId));
  if (!chosen && lastUsed) chosen = startable.find((p) => p.id === lastUsed && p.deviceOnline);
  return (chosen ?? firstOf(startable))?.id ?? null;
}

/**
 * Why Start session can't be pressed yet, in the order of the form, shown next to the button; null = ready. Never a
 * silently disabled button.
 */
export function startBlocker(s: {
  loading: boolean;
  hasProjects: boolean;
  project: Pick<Project, "deviceName" | "deviceOnline" | "teamProjectHidden"> | null;
  runtimeLabel: string;
  runtimeReady: boolean;
}): string | null {
  if (!s.project) {
    if (s.loading) return "Loading your projects…";
    return s.hasProjects ? "Choose a project" : "Add a project to start a session";
  }
  if (s.project.teamProjectHidden) return "Choose a project";
  if (!s.project.deviceOnline) return `${s.project.deviceName} is offline`;
  if (!s.runtimeReady) return `${s.runtimeLabel} isn't ready on ${s.project.deviceName}`;
  return null;
}

/** The collapsed Model and permissions row, in words: "Default model · Supervised · Current checkout". */
export function settingsSummary(s: {
  modelLabel: string | null;
  effortLabel: string | null;
  modeLabel: string;
  worktree: boolean;
}): string {
  return [
    s.modelLabel ?? "Default model",
    s.effortLabel,
    s.modeLabel,
    s.worktree ? "Isolated worktree" : "Current checkout",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** One step of the form: a heading, an optional action on its right and an optional hint under it. */
function Step({
  title,
  hint,
  action,
  children,
}: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-2.5">
      <div className="grid gap-0.5">
        <div className="flex min-h-8 items-center justify-between gap-3">
          <h3 id={id} className="font-semibold text-sm tracking-tight">
            {title}
          </h3>
          {action}
        </div>
        {hint ? <p className="text-[13px] text-muted-foreground leading-snug">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Start a Work Zone session (owner feedback 2026-11-06: "chaos, not as nice as the rest"). One decision per step, in
 * the order a person thinks about it: where (the repository, which names its computer), which agent and how (Model and
 * permissions folded into one summary row until opened), who sees it, then the first prompt. The last repository and
 * agent are preselected; the footer says why Start is unavailable and holds the error, so both are always in view. A
 * sheet that fills a phone, a fixed-height dialog on desktop (nothing jumps while lists load).
 */
export function NewSessionDialog({
  open,
  onOpenChange,
  initialProjectId,
  initialTarget,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialProjectId?: string | undefined;
  /** A repository or a team project to preselect (the Work Zone sidebar's "+", 07.10-05); wins over the id. */
  initialTarget?: NewSessionPreselect | undefined;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const projects = useProjects();
  const devices = useDevices();
  const create = useCreateWorkSession();
  const desktop = useDesktop();
  // Pairing (and so the way to a server) leaves with the Work Zone module's `device.pair` (07.3, D-01).
  const canPair = useGrain("device.pair") !== "off";

  const available = useMemo(() => (projects.data ?? []).filter((p) => p.available), [projects.data]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeId>("claude-code");
  const [model, setModel] = useState("default");
  const [effort, setEffort] = useState("default");
  const [mode, setMode] = useState<PermissionMode>("default");
  const [worktree, setWorktree] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  /** Who the session will be visible to (Surface 3): the project's default until Change picks another (draft). */
  const [audience, setAudience] = useState<DraftAudience | null>(null);

  // Opening the dialog starts on the viewer's last agent (the device's readiness below may still switch it).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the dialog opens, never on a later change
  useEffect(() => {
    if (!open) return;
    const last = readNewSessionPrefs().runtime;
    if (last && last !== runtime) {
      setRuntime(last);
      setModel("default");
      setEffort("default");
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setProjectId(
      preselectedRepo(available, initialTarget ?? initialProjectId, readNewSessionPrefs().projectId),
    );
  }, [open, initialTarget, initialProjectId, available]);

  const project = available.find((p) => p.id === projectId) ?? null;
  // Choosing another repository (or reopening the dialog) resets the line to that repository's default (D-03): the
  // team project's (Project or Only me) or Project on a personal one. A list refresh of the same repository keeps it.
  const teamProjectId = project?.teamProject?.id ?? null;
  const placeKey = open && project ? `${project.id}|${teamProjectId ?? ""}` : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the place changes, not on each list refresh
  useEffect(() => {
    setAudience(defaultAudience(project));
  }, [placeKey]);
  const device = devices.data?.find((d) => d.id === project?.deviceId) ?? null;
  const runtimeInfo = (id: RuntimeId) => device?.runtimes.find((r) => r.id === id);
  const me = useMe({ enabled: false });
  const ownDevice = !!device && device.ownerUserId === me.data?.user.id;
  const updater = device ? whoUpdates(device, me.data?.user.id) : "";
  const cardState = (id: RuntimeId) =>
    runtimeCardState(runtimeInfo(id), device?.runtimeCompatibility?.[id], updater);

  // Everything below the runtime comes from the device's reported catalog as the API filtered it for the caller
  // (D-08, WZC-03): models, efforts and modes, with the reason for each refused mode.
  const controls = useRuntimeControls(device?.id, runtime);
  const rc = controls.data && controls.data.runtime === runtime ? controls.data : undefined;
  const catalogModels = useMemo(
    () =>
      (rc?.models ?? [])
        .filter((m) => m.available && isShown(m))
        .sort((a, b) => Number(a.legacy) - Number(b.legacy)),
    [rc],
  );
  const chosenModel = catalogModels.find((m) => m.id === model) ?? catalogModels.find((m) => m.isDefault);
  const efforts = (model === "default" ? [] : (chosenModel?.efforts ?? [])).filter(
    (e) => e.available && isShown(e),
  );
  const modeOptions = useMemo(() => {
    const ctx = { runtime, modes: rc?.permissionModes ?? [] };
    return PERMISSION_MODES.flatMap((meta) => {
      if (!rc) return LEGACY_MODES.includes(meta.value) ? [{ meta, available: true, reason: null }] : [];
      const option = rc.permissionModes.find((m) => m.value === meta.value);
      if (!option || !isShown(option)) return [];
      if (option.available && meta.value === "auto" && chosenModel && !chosenModel.supportsAutoMode)
        return [{ meta, available: false, reason: `${chosenModel.displayName} does not support Auto` }];
      return [
        {
          meta,
          available: option.available,
          reason: option.available ? null : controlReasonText(option, ctx),
        },
      ];
    });
  }, [rc, runtime, chosenModel]);

  // A choice the new device / runtime / model does not offer falls back to its default.
  useEffect(() => {
    if (!rc) return;
    if (model !== "default" && !catalogModels.some((m) => m.id === model)) setModel("default");
  }, [rc, model, catalogModels]);
  useEffect(() => {
    if (effort !== "default" && !efforts.some((e) => e.value === effort)) setEffort("default");
  }, [effort, efforts]);
  useEffect(() => {
    if (modeOptions.length === 0 || modeOptions.some((o) => o.meta.value === mode && o.available)) return;
    const fallback =
      modeOptions.find((o) => o.meta.value === "default" && o.available) ??
      modeOptions.find((o) => o.available);
    if (fallback) setMode(fallback.meta.value);
  }, [modeOptions, mode]);

  useEffect(() => {
    // Prefer a runtime that is ready on the chosen device.
    const ready = (id: RuntimeId) =>
      runtimeCardState(
        device?.runtimes.find((x) => x.id === id),
        device?.runtimeCompatibility?.[id],
        "",
      ).ready;
    if (device && !ready(runtime)) {
      const alt = RUNTIME_IDS.find(ready);
      if (alt) {
        setRuntime(alt);
        setModel("default");
        setEffort("default");
      }
    }
  }, [device, runtime]);

  // Team projects first, then Personal by device (D-01, R5); `GET /projects` is already the caller's list.
  const groups = useMemo(() => groupRepos(available), [available]);

  async function addFromDesktop() {
    if (!desktop) return;
    const res = await desktop.addProject();
    if (res.ok) {
      toast.success(`Added ${res.project.name}`);
      await qc.invalidateQueries({ queryKey: wzKeys.projects });
    } else if (!res.canceled) toast.error(res.error);
  }

  const runtimeReady = cardState(runtime).ready;
  const blocker = startBlocker({
    loading: projects.isPending,
    hasProjects: available.length > 0,
    project,
    runtimeLabel: RUNTIMES[runtime].label,
    runtimeReady,
  });
  const canSubmit = !!project && isStartable(project) && runtimeReady && !create.isPending;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!project) return setError("Choose a project");
    if (!canSubmit) return;
    setError(null);
    const visibility = audience ? draftInput(audience) : null;
    try {
      const s = await create.mutateAsync({
        projectId: project.id,
        runtime,
        permissionMode: mode,
        worktree,
        ...(visibility ? { visibility } : {}),
        ...(model !== "default" ? { model } : {}),
        ...(effort !== "default" ? { effort } : {}),
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      });
      saveNewSessionPrefs({ projectId: project.id, runtime });
      onOpenChange(false);
      setPrompt("");
      router.push(`/work-zone/${s.id}`);
    } catch (err) {
      setError(audienceRefusal(err, audience, project) ?? errorMessage(err));
    }
  }

  /** ⌘/Ctrl + Enter anywhere starts; in the prompt, Enter starts and Shift + Enter breaks the line (the composer's rule). */
  function onFormKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    const inPrompt = (e.target as HTMLElement).id === "first-prompt";
    if (!(e.metaKey || e.ctrlKey) && !(inPrompt && !e.shiftKey)) return;
    e.preventDefault();
    if (canSubmit) formRef.current?.requestSubmit();
  }

  const closeDialog = () => onOpenChange(false);
  const empty = projects.isSuccess && available.length === 0;
  const emptyKind = devices.isSuccess && devices.data.length === 0 ? "no-devices" : "no-projects";
  const modeMeta = PERMISSION_MODES.find((m) => m.value === mode);
  const summary = settingsSummary({
    modelLabel: model === "default" ? null : (chosenModel?.displayName ?? null),
    effortLabel: effort === "default" ? null : (EFFORT_LABELS[effort] ?? effort),
    modeLabel: modeMeta?.label ?? mode,
    worktree,
  });
  const noRuntimeReady = !!device && RUNTIME_IDS.every((id) => !cardState(id).ready);
  const runtimeStop =
    cardState(runtime).ready || !device ? runtime : RUNTIME_IDS.find((id) => cardState(id).ready);
  const modeStop =
    modeOptions.find((o) => o.meta.value === mode && o.available)?.meta.value ??
    modeOptions.find((o) => o.available)?.meta.value;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="new-session-dialog"
        className={cn(
          "sm:max-w-[40rem] max-sm:max-h-[calc(100dvh-0.75rem)]",
          !empty &&
            "max-sm:h-[calc(100dvh-0.75rem)] sm:h-[min(48rem,calc(100dvh-4rem))] lg:h-[min(42rem,calc(100dvh-4rem))] lg:max-w-[60rem]",
        )}
      >
        <form
          ref={formRef}
          onSubmit={onSubmit}
          onKeyDown={onFormKeyDown}
          className="flex min-h-0 flex-1 flex-col"
        >
          <DialogHeader className={cn("pb-1", !empty && "lg:border-b lg:pb-4")}>
            <DialogTitle className="text-lg">New session</DialogTitle>
            <DialogDescription>
              Runs on a computer in your team. People who can see the session follow it and queue prompts;
              they run one at a time.
            </DialogDescription>
          </DialogHeader>
          {/* Phones and tablets: one scrolling column. Desktop: where on the left, how and who on the right, both in view. */}
          <div
            className={cn(
              "scrollbar-thin min-h-0 flex-1 overflow-y-auto",
              !empty && "lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)] lg:overflow-hidden",
            )}
          >
            {/* 1. Where: the repository, which names the computer it runs on */}
            <div
              className={cn(
                "grid content-start px-5 pt-4 pb-4 lg:pb-6",
                !empty && "scrollbar-thin lg:overflow-y-auto lg:border-r lg:bg-muted/25 lg:pt-5",
              )}
            >
              <Step
                title="Project"
                hint={empty ? undefined : "A repository on one of your team's computers."}
                action={
                  desktop && !empty ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={addFromDesktop}
                      className={cn("-mr-2", TOUCH)}
                    >
                      <FolderPlus aria-hidden /> Add project from this computer
                    </Button>
                  ) : null
                }
              >
                {projects.isPending ? (
                  <ProjectsLoading />
                ) : projects.isError ? (
                  <div
                    role="status"
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed px-4 py-3 text-[13px] text-muted-foreground"
                  >
                    Couldn't load your projects.
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => projects.refetch()}
                      className={TOUCH}
                    >
                      Try again
                    </Button>
                  </div>
                ) : empty ? (
                  <ProjectsEmpty
                    kind={emptyKind}
                    canPair={canPair}
                    desktop={!!desktop}
                    onAddFromDesktop={addFromDesktop}
                    onNavigate={closeDialog}
                  />
                ) : (
                  <ProjectList groups={groups} selectedId={projectId} onSelect={setProjectId} />
                )}
                {canPair && available.length > 0 ? (
                  <AddServerLink className="justify-self-start" onClick={closeDialog} />
                ) : null}
              </Step>
            </div>

            {empty ? null : (
              <div className="scrollbar-thin grid content-start gap-7 px-5 pt-2 pb-6 lg:overflow-y-auto lg:pt-5">
                {/* 2. Which agent, and how it works */}
                <Step title="Agent">
                  <div
                    className="grid grid-cols-2 gap-2"
                    role="radiogroup"
                    aria-label="Agent"
                    onKeyDown={onRadioGroupKeyDown}
                  >
                    {RUNTIME_IDS.map((id) => {
                      const info = runtimeInfo(id);
                      const state = cardState(id);
                      const ready = state.ready;
                      const selected = runtime === id;
                      const note = device ? state.note : null;
                      return (
                        <button
                          key={id}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          tabIndex={runtimeStop === id ? 0 : -1}
                          data-testid={`runtime-${id}`}
                          disabled={!!device && !ready}
                          onClick={() => {
                            setRuntime(id);
                            setModel("default");
                            setEffort("default");
                          }}
                          className={cn(
                            "flex min-h-14 items-start gap-2.5 rounded-lg border bg-card p-3 text-left sm:gap-3 outline-none transition-[border-color,background-color,box-shadow]",
                            "focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60",
                            selected && (ready || !device)
                              ? "border-primary/50 bg-brand-soft/60 ring-1 ring-primary/30 dark:bg-brand-soft/40"
                              : "hover:border-foreground/20 hover:bg-accent/40 disabled:hover:border-border disabled:hover:bg-card",
                          )}
                        >
                          <RuntimeLogo runtime={id} className="size-6 rounded-md sm:size-7 sm:rounded-lg" />
                          <span className="grid min-w-0 flex-1 gap-0.5">
                            <span className="truncate font-medium text-sm leading-tight">
                              {RUNTIMES[id].label}
                            </span>
                            <span
                              data-testid={
                                device && state.tone !== "muted" ? "runtime-compat-note" : undefined
                              }
                              className={cn(
                                "text-xs leading-snug",
                                !note || state.tone === "muted"
                                  ? "text-muted-foreground"
                                  : state.tone === "warning"
                                    ? "text-amber-700 dark:text-amber-300"
                                    : "text-red-700 dark:text-red-300",
                              )}
                            >
                              {note ??
                                (device
                                  ? info?.version
                                    ? `Ready · ${info.version}`
                                    : "Ready"
                                  : RUNTIMES[id].vendor)}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {noRuntimeReady && device ? (
                    <p
                      data-testid="new-session-no-runtime"
                      className="rounded-md bg-warning/12 px-3 py-2 text-[13px] text-amber-800 leading-snug dark:text-amber-200"
                    >
                      Neither agent is ready on {device.name}.{" "}
                      {ownDevice ? (
                        <Link
                          href="/settings/devices"
                          onClick={closeDialog}
                          className="font-medium underline underline-offset-4 max-md:inline-flex max-md:min-h-11 max-md:items-center"
                        >
                          Set one up in Settings › Devices
                        </Link>
                      ) : (
                        `Ask ${device.ownerName ?? "its owner"} to install and sign in to Claude Code or Codex.`
                      )}
                    </p>
                  ) : (
                    <p className="text-[13px] text-muted-foreground">{RUNTIMES[runtime].subscription}</p>
                  )}

                  {/* Model, effort, permissions and worktree: one summary row until opened */}
                  <div className="rounded-lg border bg-card" data-open={settingsOpen || undefined}>
                    <button
                      type="button"
                      aria-expanded={settingsOpen}
                      aria-controls="new-session-settings"
                      data-testid="new-session-settings-toggle"
                      onClick={() => setSettingsOpen((o) => !o)}
                      className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/40"
                    >
                      <SlidersHorizontal aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                      <span className="grid min-w-0 flex-1">
                        <span className="font-medium text-sm">Model and permissions</span>
                        <span
                          data-testid="new-session-settings-summary"
                          className="truncate text-muted-foreground text-xs"
                        >
                          {summary}
                        </span>
                      </span>
                      {mode === "fullAccess" ? (
                        <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-warning/15 px-2 font-medium text-[12px] text-amber-800 dark:text-amber-300">
                          <LockOpen aria-hidden className="size-3.5" />
                          Full access
                        </span>
                      ) : null}
                      <ChevronDown
                        aria-hidden
                        className={cn(
                          "size-4 shrink-0 text-muted-foreground transition-transform",
                          settingsOpen && "rotate-180",
                        )}
                      />
                    </button>
                    {settingsOpen ? (
                      <div id="new-session-settings" className="grid gap-5 border-t px-3 pt-4 pb-3">
                        <div className="grid gap-2">
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="grid gap-1.5">
                              <Label>Model</Label>
                              <Select
                                items={[
                                  { value: "default", label: "Default" },
                                  ...catalogModels.map((m) => ({ value: m.id, label: m.displayName })),
                                ]}
                                value={model}
                                onValueChange={(v) => {
                                  setModel(v ?? "default");
                                  setEffort("default");
                                }}
                              >
                                <SelectTrigger
                                  aria-label="Model"
                                  data-testid="new-session-model"
                                  className="max-md:h-11"
                                />
                                <SelectContent>
                                  <SelectItem value="default">Default</SelectItem>
                                  {catalogModels.map((m) => (
                                    <SelectItem key={m.id} value={m.id}>
                                      {m.displayName}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            {efforts.length > 0 ? (
                              <div className="grid gap-1.5">
                                <Label>Reasoning effort</Label>
                                <Select
                                  items={[
                                    { value: "default", label: "Default" },
                                    ...efforts.map((e) => ({
                                      value: e.value,
                                      label: EFFORT_LABELS[e.value] ?? e.value,
                                    })),
                                  ]}
                                  value={effort}
                                  onValueChange={(v) => setEffort(v ?? "default")}
                                >
                                  <SelectTrigger
                                    aria-label="Reasoning effort"
                                    data-testid="new-session-effort"
                                    className="max-md:h-11"
                                  />
                                  <SelectContent>
                                    <SelectItem value="default">Default</SelectItem>
                                    {efforts.map((e) => (
                                      <SelectItem key={e.value} value={e.value}>
                                        {EFFORT_LABELS[e.value] ?? e.value}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            ) : null}
                          </div>
                          <p className="text-muted-foreground text-xs">
                            {device && controls.isSuccess && !rc?.catalog
                              ? `${device.name} has not reported its ${RUNTIMES[runtime].label} models yet; the runtime picks its default.`
                              : `Models ${RUNTIMES[runtime].label} reported on ${device?.name ?? "the device"}. Change them anytime from the composer.`}
                          </p>
                        </div>

                        <div className="grid gap-1.5">
                          <Label>Permissions</Label>
                          <div
                            className="divide-y overflow-hidden rounded-lg border"
                            role="radiogroup"
                            aria-label="Permission mode"
                            onKeyDown={onRadioGroupKeyDown}
                          >
                            {modeOptions.map(({ meta, available: ok, reason }) => {
                              const Icon = meta.icon;
                              const selected = mode === meta.value;
                              return (
                                <button
                                  key={meta.value}
                                  type="button"
                                  role="radio"
                                  aria-checked={selected}
                                  tabIndex={modeStop === meta.value ? 0 : -1}
                                  data-testid={`mode-${meta.value}`}
                                  disabled={!ok}
                                  onClick={() => setMode(meta.value)}
                                  className={cn(radioRowClass, "items-start")}
                                >
                                  <Icon
                                    aria-hidden
                                    className={cn(
                                      "mt-0.5 size-4 shrink-0",
                                      !ok
                                        ? "text-muted-foreground/60"
                                        : meta.tone === "warning"
                                          ? "text-amber-600 dark:text-amber-400"
                                          : selected
                                            ? "text-primary"
                                            : "text-foreground/80",
                                    )}
                                  />
                                  <span className="grid min-w-0 flex-1 gap-0.5">
                                    <span
                                      className={cn(
                                        "font-medium text-[13px] leading-tight",
                                        !ok && "text-muted-foreground",
                                      )}
                                    >
                                      {meta.label}
                                    </span>
                                    <span className="text-muted-foreground text-xs leading-snug">
                                      {meta.hint}
                                    </span>
                                    {reason ? (
                                      <span className="text-amber-700 text-xs leading-snug dark:text-amber-300/90">
                                        {reason}
                                      </span>
                                    ) : null}
                                  </span>
                                  <RowCheck checked={selected} />
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {/* biome-ignore lint/a11y/noLabelWithoutControl: the Switch renders the control inside the label */}
                        <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
                          <span className="grid gap-0.5">
                            <span className="font-medium text-[13px]">Isolated worktree</span>
                            <span
                              id="new-session-worktree-hint"
                              className="text-muted-foreground text-xs leading-snug"
                            >
                              Work on a separate git branch so the device's checkout stays untouched.
                            </span>
                          </span>
                          <Switch
                            checked={worktree}
                            onCheckedChange={setWorktree}
                            aria-label="Isolated worktree"
                            aria-describedby="new-session-worktree-hint"
                          />
                        </label>
                      </div>
                    ) : null}
                  </div>
                </Step>

                {/* 3. Who sees it (the draft audience, applied at start) */}
                {project && audience ? (
                  <section aria-label="Visibility" className="-my-2">
                    <NewSessionVisibilityLine project={project} value={audience} onChange={setAudience} />
                  </section>
                ) : null}

                {/* 4. What to do first */}
                <section className="grid gap-2">
                  <Label htmlFor="first-prompt" className="text-sm">
                    First prompt <span className="font-normal text-muted-foreground">(optional)</span>
                  </Label>
                  <Textarea
                    id="first-prompt"
                    data-testid="first-prompt"
                    rows={3}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="e.g. Add a dark-mode toggle to the settings page"
                    aria-describedby="first-prompt-hint"
                    className="max-h-48 resize-none"
                  />
                  <p id="first-prompt-hint" className="text-muted-foreground text-xs max-md:sr-only">
                    Enter starts the session · Shift + Enter for a new line
                  </p>
                </section>
              </div>
            )}
          </div>
          <DialogFooter className="flex-col gap-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 text-[13px] sm:flex-1">
              {error ? (
                <p role="alert" className="font-medium text-destructive leading-snug">
                  {error}
                </p>
              ) : (
                <p
                  id="new-session-status"
                  data-testid="new-session-status"
                  className={cn("truncate text-muted-foreground", !blocker && "max-sm:hidden")}
                >
                  {blocker ?? (project ? `On ${project.deviceName} with ${RUNTIMES[runtime].label}` : null)}
                </p>
              )}
            </div>
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 sm:flex">
              <Button type="button" variant="outline" onClick={closeDialog} className={TOUCH}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!canSubmit}
                aria-describedby={blocker && !error ? "new-session-status" : undefined}
                data-testid="start-session"
                className={TOUCH}
              >
                {create.isPending ? <Spinner /> : <Rocket aria-hidden />}
                Start session
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
