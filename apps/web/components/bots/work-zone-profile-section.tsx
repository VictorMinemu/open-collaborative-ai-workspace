"use client";

import {
  type Agent,
  BOT_WORK_ZONE_LIMITS,
  type BotFastMode,
  type BotWorkZoneProfile,
  type BotWorkZoneProfileInput,
  type BotWorkZoneProfileView,
  DEFERRED_EFFORTS,
  type Device,
  EFFORT_LABELS,
  effortRank,
  minMode,
  OUTSIDE_CONTENT_WARNING,
  PERMISSION_MODE_RANK,
  type PermissionMode,
  type Project,
  type RuntimeControls,
  type RuntimeId,
} from "@ocw/contracts";
import { FolderGit2, FolderKanban, Laptop, LockOpen, Server, ShieldAlert, Trash2, X } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  contextWindowLabel,
  controlReasonText,
  isShown,
  OnlineDot,
  PERMISSION_MODES,
  permissionModeMeta,
  RUNTIMES,
  RuntimeLogo,
} from "@/components/work-zone/meta";
import { ProjectsLoading, RowCheck, radioRowClass } from "@/components/work-zone/new-session-sections";
import { errorMessage, isApiError } from "@/lib/api";
import {
  useBotWorkZoneProfile,
  useRemoveBotWorkZoneProfile,
  useSaveBotWorkZoneProfile,
} from "@/lib/bot-work-zone-queries";
import { groupRepos } from "@/lib/new-session-groups";
import { cn } from "@/lib/utils";
import { useDevices, useProjects, useRuntimeControls } from "@/lib/workzone-queries";

/**
 * A bot's Work Zone profile in its sheet (07.16-12; D-01, D-02, D-08, PD-04, PD-20): where the bot may run sessions
 * (device, runtime, projects), with which models and options, up to which permission mode, within which limits, and
 * (admins only) whether it may act right after reading outside content. The API decides; the page renders: the status
 * row is the API's own verdict (`status`), never computed here, and is the confirmation of a save (no success toast).
 * Every save sends the full desired state in one PUT; the API's answer replaces the form. The options offered are the
 * caller's own live controls for the chosen device and runtime (`GET /work-zone/controls`; the saver becomes the bot's
 * sponsor, D-02); the API checks every value again at save and at use. The section shows the device's reported facts
 * only (online, "Server"): it never offers a host-kind or isolated-server control (P5).
 */

export const WORK_ZONE_COPY = {
  empty: "No Work Zone profile yet",
  emptyHint: "Save one to let this bot start sessions on a device.",
  active: "Active",
  inactive: "Inactive",
  noDevice: "No device to run on yet",
  noDeviceHint: "The bot runs sessions on a computer or server you can use. Pair one first.",
  noProjects: "No projects on this device yet.",
  pickProject: "Pick at least one project.",
  loadError: "Couldn't load the Work Zone profile.",
  runtimeDefault: "Runtime default",
  adminOnly: "Only an admin can change this",
  fullAccessNeeds: "Full access also needs the device's own opt-in and its owner's consent for this bot.",
  save: "Save profile",
  remove: "Remove profile",
  confirmRemove: "Confirm remove",
} as const;

const RUNTIME_IDS: readonly RuntimeId[] = ["claude-code", "codex"];

/** The form's state: exactly the PUT body (the full desired state). */
export type ProfileDraft = BotWorkZoneProfileInput;

const signedIn = (d: Device, runtime: RuntimeId) =>
  d.runtimes.some((r) => r.id === runtime && r.installed && r.loggedIn);

/** The devices a profile may name: every device `GET /devices` answers that was not removed. */
export function usableDevices(devices: readonly Device[]): Device[] {
  return devices.filter((d) => d.revokedAt === null);
}

/** The device's first signed-in runtime, in the order the device reported them. */
function firstRuntime(d: Device): RuntimeId | null {
  return d.runtimes.find((r) => r.installed && r.loggedIn)?.id ?? null;
}

/**
 * A new profile's starting point: the first device with a signed-in runtime, that runtime, no project yet, the
 * runtime's own model and options, Supervised, a worktree, the platform's default limits and outside content off.
 * Null when the caller has no such device.
 */
export function newDraft(devices: readonly Device[]): ProfileDraft | null {
  const device = usableDevices(devices).find((d) => firstRuntime(d) !== null);
  const runtime = device ? firstRuntime(device) : null;
  if (!device || !runtime) return null;
  return {
    deviceId: device.id,
    runtime,
    projectIds: [],
    defaultModel: null,
    allowedModels: [],
    defaultEffort: null,
    allowedEfforts: [],
    defaultContextWindow: null,
    allowedContextWindows: [],
    fastMode: "off",
    defaultMode: "default",
    maxMode: "default",
    worktree: true,
    maxConcurrent: BOT_WORK_ZONE_LIMITS.maxConcurrentDefault,
    promptsPerHour: BOT_WORK_ZONE_LIMITS.promptsPerHourDefault,
    wakesPerSessionDay: BOT_WORK_ZONE_LIMITS.wakesPerSessionDayDefault,
    actOnOutsideContent: false,
  };
}

/** A stored profile as the form's state. */
export function draftFromProfile(p: BotWorkZoneProfile): ProfileDraft {
  return {
    deviceId: p.deviceId,
    runtime: p.runtime,
    projectIds: p.projects.map((x) => x.id),
    defaultModel: p.defaultModel,
    allowedModels: [...p.allowedModels],
    defaultEffort: p.defaultEffort,
    allowedEfforts: [...p.allowedEfforts],
    defaultContextWindow: p.defaultContextWindow,
    allowedContextWindows: [...p.allowedContextWindows],
    fastMode: p.fastMode,
    defaultMode: p.defaultMode,
    maxMode: p.maxMode,
    worktree: p.worktree,
    maxConcurrent: p.maxConcurrent,
    promptsPerHour: p.promptsPerHour,
    wakesPerSessionDay: p.wakesPerSessionDay,
    actOnOutsideContent: p.actOnOutsideContent,
  };
}

/** The PUT body: every field, nothing else (the contract is strict). */
export function toProfileInput(d: ProfileDraft): BotWorkZoneProfileInput {
  return {
    deviceId: d.deviceId,
    runtime: d.runtime,
    defaultModel: d.defaultModel,
    allowedModels: d.allowedModels,
    defaultEffort: d.defaultEffort,
    allowedEfforts: d.allowedEfforts,
    defaultContextWindow: d.defaultContextWindow,
    allowedContextWindows: d.allowedContextWindows,
    fastMode: d.fastMode,
    defaultMode: d.defaultMode,
    maxMode: d.maxMode,
    worktree: d.worktree,
    maxConcurrent: d.maxConcurrent,
    promptsPerHour: d.promptsPerHour,
    wakesPerSessionDay: d.wakesPerSessionDay,
    actOnOutsideContent: d.actOnOutsideContent,
    projectIds: d.projectIds,
  };
}

/** Another device: its own projects only, and its first signed-in runtime when the current one is not signed in. */
export function withDevice(d: ProfileDraft, device: Device, projects: readonly Project[]): ProfileDraft {
  const onDevice = new Set(projects.filter((p) => p.deviceId === device.id).map((p) => p.id));
  const runtime = signedIn(device, d.runtime) ? d.runtime : (firstRuntime(device) ?? d.runtime);
  return { ...d, deviceId: device.id, runtime, projectIds: d.projectIds.filter((id) => onDevice.has(id)) };
}

/** The repositories a profile may list on a device: announced by it and openable by the caller (D-14). */
export function deviceProjects(projects: readonly Project[], deviceId: string): Project[] {
  return projects.filter((p) => p.deviceId === deviceId && p.available && !p.teamProjectHidden);
}

// ---------------------------------------------------------------- the offer (the caller's live controls)

/** One option of a picker: unavailable ones are shown disabled with their reason in words (`controlReasonText`). */
export interface Choice<V extends string | number> {
  value: V;
  label: string;
  available: boolean;
  reason: string | null;
  /** Full access: the warning tone (D-04). */
  warning?: boolean;
}

export interface Offer {
  models: Choice<string>[];
  efforts: Choice<string>[];
  contextWindows: Choice<number>[];
  fast: { available: boolean; reason: string | null };
  modes: Choice<PermissionMode>[];
}

/** Efforts or context windows across the models: available when an available model offers them available. */
function union<V extends string | number>(
  rc: RuntimeControls,
  pick: (m: RuntimeControls["models"][number]) => ReadonlyArray<{
    value: V;
    available: boolean;
    reason: RuntimeControls["models"][number]["reason"];
    detail: string | null;
  }>,
  label: (v: V) => string,
): Choice<V>[] {
  const out = new Map<V, Choice<V>>();
  for (const m of rc.models.filter(isShown)) {
    for (const o of pick(m)) {
      if (!isShown(o)) continue;
      const ok = m.available && o.available;
      const reason = ok
        ? null
        : controlReasonText(m.available ? o : m, { runtime: rc.runtime, modes: rc.permissionModes });
      const seen = out.get(o.value);
      if (!seen) out.set(o.value, { value: o.value, label: label(o.value), available: ok, reason });
      else if (ok && !seen.available) out.set(o.value, { ...seen, available: true, reason: null });
    }
  }
  return [...out.values()];
}

/** What the caller may pick for the bot on this device and runtime, in the order the pickers list it. */
export function offerFrom(rc: RuntimeControls): Offer {
  const ctx = { runtime: rc.runtime, modes: rc.permissionModes };
  const models = rc.models
    .filter(isShown)
    .sort((a, b) => Number(a.legacy) - Number(b.legacy))
    .map((m) => ({
      value: m.id,
      label: m.displayName,
      available: m.available,
      reason: m.available ? null : controlReasonText(m, ctx),
    }));
  const efforts = union(
    rc,
    (m) => m.efforts.filter((e) => !DEFERRED_EFFORTS.includes(e.value)),
    (v) => EFFORT_LABELS[v] ?? v,
  ).sort((a, b) => effortRank(a.value) - effortRank(b.value));
  const contextWindows = union(rc, (m) => m.contextWindows, contextWindowLabel).sort(
    (a, b) => a.value - b.value,
  );
  const fastOk = rc.models.some(
    (m) => isShown(m) && m.available && m.fastMode.supported && m.fastMode.available,
  );
  const fastWhy = rc.models.find((m) => isShown(m) && m.fastMode.supported)?.fastMode;
  const fast = {
    available: fastOk,
    reason: fastOk
      ? null
      : controlReasonText(fastWhy?.reason ? fastWhy : { reason: "runtime", detail: null }, ctx),
  };
  const modes: Choice<PermissionMode>[] = [];
  for (const meta of PERMISSION_MODES) {
    const o = rc.permissionModes.find((m) => m.value === meta.value);
    if (!o || !isShown(o)) continue;
    modes.push({
      value: meta.value,
      label: meta.label,
      available: o.available,
      reason: o.available ? null : controlReasonText(o, ctx),
      warning: meta.tone === "warning",
    });
  }
  return { models, efforts, contextWindows, fast, modes };
}

/** "Bot may also use" adds only available values that are neither the default nor already listed. */
export function addable<V extends string | number>(
  choices: readonly Choice<V>[],
  allowed: readonly V[],
  defaultValue: V | null,
): Choice<V>[] {
  return choices.filter((c) => c.available && c.value !== defaultValue && !allowed.includes(c.value));
}

/**
 * The draft against a new offer (another device or runtime, or controls that changed): every value no longer offered
 * is dropped, and its name returned for the "Removed:" line. Modes fall back to Supervised.
 */
export function reconcile(draft: ProfileDraft, offer: Offer): { draft: ProfileDraft; removed: string[] } {
  const removed: string[] = [];
  const drop = (label: string) => {
    if (!removed.includes(label)) removed.push(label);
  };
  const ok = <V extends string | number>(list: readonly Choice<V>[], v: V) =>
    list.some((c) => c.value === v && c.available);
  // A value the new offer does not list at all is named as the pickers would name it.
  const name = <V extends string | number>(list: readonly Choice<V>[], v: V): string => {
    const listed = list.find((c) => c.value === v)?.label;
    if (listed) return listed;
    if (typeof v === "number") return contextWindowLabel(v);
    const s = String(v);
    return EFFORT_LABELS[s] ?? permissionModeMeta(s)?.label ?? s;
  };
  function one<V extends string | number>(list: readonly Choice<V>[], v: V | null): V | null {
    if (v === null || ok(list, v)) return v;
    drop(name(list, v));
    return null;
  }
  function many<V extends string | number>(list: readonly Choice<V>[], vs: readonly V[]): V[] {
    return vs.filter((v) => {
      if (ok(list, v)) return true;
      drop(name(list, v));
      return false;
    });
  }
  const defaultModel = one(offer.models, draft.defaultModel);
  const allowedModels = many(offer.models, draft.allowedModels);
  const defaultEffort = one(offer.efforts, draft.defaultEffort);
  const allowedEfforts = many(offer.efforts, draft.allowedEfforts);
  const defaultContextWindow = one(offer.contextWindows, draft.defaultContextWindow);
  const allowedContextWindows = many(offer.contextWindows, draft.allowedContextWindows);
  let fastMode: BotFastMode = draft.fastMode;
  if (fastMode !== "off" && !offer.fast.available) {
    fastMode = "off";
    drop("Fast mode");
  }
  const mode = (m: PermissionMode): PermissionMode => {
    if (ok(offer.modes, m)) return m;
    drop(name(offer.modes, m));
    return "default";
  };
  const maxMode = mode(draft.maxMode);
  const defaultMode = minMode(mode(draft.defaultMode), maxMode);
  if (removed.length === 0) return { draft, removed };
  return {
    draft: {
      ...draft,
      defaultModel,
      allowedModels,
      defaultEffort,
      allowedEfforts,
      defaultContextWindow,
      allowedContextWindows,
      fastMode,
      defaultMode,
      maxMode,
    },
    removed,
  };
}

/** A default mode above the highest raises the highest to it. */
export function withDefaultMode(d: ProfileDraft, mode: PermissionMode): ProfileDraft {
  const maxMode = PERMISSION_MODE_RANK[mode] > PERMISSION_MODE_RANK[d.maxMode] ? mode : d.maxMode;
  return { ...d, defaultMode: mode, maxMode };
}

/** A highest mode below the default lowers the default to it. */
export function withMaxMode(d: ProfileDraft, mode: PermissionMode): ProfileDraft {
  return { ...d, maxMode: mode, defaultMode: minMode(d.defaultMode, mode) };
}

export const FAST_MODE_OPTIONS: ReadonlyArray<{ value: BotFastMode; label: string }> = [
  { value: "off", label: "Off" },
  { value: "allowed", label: "Bot may turn it on" },
  { value: "on", label: "On" },
];

type LimitKey = "maxConcurrent" | "promptsPerHour" | "wakesPerSessionDay";

/** The three limits (PD-22), bounded exactly as the contract bounds them. */
export const LIMIT_FIELDS: ReadonlyArray<{ key: LimitKey; label: string; min: number; max: number }> = [
  { key: "maxConcurrent", label: "Sessions at once", min: 1, max: BOT_WORK_ZONE_LIMITS.maxConcurrentMax },
  { key: "promptsPerHour", label: "Prompts per hour", min: 1, max: BOT_WORK_ZONE_LIMITS.promptsPerHourMax },
  {
    key: "wakesPerSessionDay",
    label: "Wake-ups per session per day",
    min: 0,
    max: BOT_WORK_ZONE_LIMITS.wakesPerSessionDayMax,
  },
];

/** The form fields a refusal can name, one to one with the API's `details.field`. */
const FIELDS = new Set<string>([
  "deviceId",
  "runtime",
  "projectIds",
  "defaultModel",
  "allowedModels",
  "defaultEffort",
  "allowedEfforts",
  "defaultContextWindow",
  "allowedContextWindows",
  "fastMode",
  "defaultMode",
  "maxMode",
  "maxConcurrent",
  "promptsPerHour",
  "wakesPerSessionDay",
  "actOnOutsideContent",
]);

/** A refused save as a field and the API's message: 400 `invalid_work_zone_profile`, 403 `outside_content_admin_only`. */
export function fieldError(err: unknown): { field: string; message: string } | null {
  if (isApiError(err, 403) && err.code === "outside_content_admin_only") {
    return { field: "actOnOutsideContent", message: err.message };
  }
  if (isApiError(err, 400) && err.code === "invalid_work_zone_profile") {
    const field = (err.details as { field?: unknown } | null | undefined)?.field;
    if (typeof field === "string") return { field, message: err.message };
  }
  return null;
}

// ---------------------------------------------------------------- the section

export function WorkZoneProfileSection({ agent }: { agent: Agent }) {
  const q = useBotWorkZoneProfile(agent.id);
  const devices = useDevices();

  if (q.isPending || devices.isPending) {
    return (
      <div className="grid gap-2" aria-busy data-testid="work-zone-profile">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-9 rounded-md" />
        ))}
      </div>
    );
  }
  if (q.isError) {
    return (
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-3 text-sm"
        data-testid="work-zone-profile"
      >
        <span className="text-muted-foreground" data-testid="work-zone-error">
          {WORK_ZONE_COPY.loadError}
        </span>
        <Button variant="outline" size="sm" onClick={() => void q.refetch()} className="max-md:h-11">
          Try again
        </Button>
      </div>
    );
  }
  // The API's answer replaces the form: a new save (or a removal) starts the form again from what it holds.
  const key = q.data.profile ? `${q.data.profile.id}:${q.data.profile.updatedAt}` : "none";
  return <WorkZoneProfileEditor key={key} agent={agent} view={q.data} devices={devices.data ?? []} />;
}

function StatusRow({ view }: { view: BotWorkZoneProfileView }) {
  const { profile, status } = view;
  const tone = !profile ? "none" : status.active ? "active" : "inactive";
  return (
    <div className="grid gap-1 rounded-lg border bg-muted/30 p-3" data-testid="work-zone-status">
      <p className="flex items-start gap-2 text-sm">
        <span
          aria-hidden
          data-testid="work-zone-status-dot"
          className={cn(
            "mt-1.5 inline-block size-2 shrink-0 rounded-full",
            tone === "active" && "bg-success shadow-[0_0_0_3px] shadow-success/20",
            tone === "inactive" && "bg-warning",
            tone === "none" && "bg-muted-foreground/40",
          )}
        />
        <span className="min-w-0">
          {tone === "none" ? (
            <span className="font-medium">{WORK_ZONE_COPY.empty}</span>
          ) : tone === "active" ? (
            <span className="font-medium">{WORK_ZONE_COPY.active}</span>
          ) : (
            <>
              <span className="font-medium">{WORK_ZONE_COPY.inactive}</span>
              {status.sentence ? ` · ${status.sentence}` : null}
            </>
          )}
        </span>
      </p>
      <p className="pl-4 text-muted-foreground text-xs">
        {profile ? `Runs as ${profile.sponsor.displayName}` : WORK_ZONE_COPY.emptyHint}
      </p>
    </div>
  );
}

function Group({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="grid min-w-0 gap-4">
      <legend className="mb-3 font-medium text-sm">{legend}</legend>
      {children}
    </fieldset>
  );
}

export function RemoveProfileButton({
  confirming,
  pending,
  onClick,
}: {
  confirming: boolean;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant={confirming ? "destructive" : "ghost"}
      onClick={onClick}
      disabled={pending}
      data-testid="work-zone-remove"
      className="w-full sm:w-auto"
    >
      {pending ? <Spinner /> : <Trash2 aria-hidden />}
      {confirming ? WORK_ZONE_COPY.confirmRemove : WORK_ZONE_COPY.remove}
    </Button>
  );
}

/**
 * The form for one view of the profile. `initial` is the state a refused save or a controls change leaves (field
 * errors, removed names); the section starts it empty.
 */
export function WorkZoneProfileEditor({
  agent,
  view,
  devices,
  initial,
}: {
  agent: Agent;
  view: BotWorkZoneProfileView;
  devices: readonly Device[];
  initial?: { errors?: Record<string, string>; removed?: string[] } | undefined;
}) {
  const id = useId();
  const projectsQ = useProjects();
  const save = useSaveBotWorkZoneProfile(agent.id);
  const remove = useRemoveBotWorkZoneProfile(agent.id);
  const usable = usableDevices(devices);
  const [draft, setDraft] = useState<ProfileDraft | null>(() =>
    view.profile ? draftFromProfile(view.profile) : newDraft(devices),
  );
  const [errors, setErrors] = useState<Record<string, string>>(initial?.errors ?? {});
  const [removed, setRemoved] = useState<string[]>(initial?.removed ?? []);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const readOnly = !view.viewerCan.edit;
  const busy = readOnly || save.isPending;
  const allProjects = projectsQ.data ?? [];

  // The caller's own live controls for the chosen device and runtime, refetched on every change of either.
  const controls = useRuntimeControls(draft?.deviceId, draft?.runtime ?? "claude-code");
  const rc = draft && controls.data?.runtime === draft.runtime ? controls.data : undefined;
  const offer = useMemo(() => (rc ? offerFrom(rc) : null), [rc]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the offer changes, never on each edit
  useEffect(() => {
    if (!offer || !draft) return;
    const r = reconcile(draft, offer);
    if (r.removed.length === 0) return;
    setDraft(r.draft);
    setRemoved((prev) => [...new Set([...prev, ...r.removed])]);
  }, [offer]);

  const device = draft ? (usable.find((d) => d.id === draft.deviceId) ?? null) : null;
  const list = useMemo(
    () => (draft ? deviceProjects(allProjects, draft.deviceId) : []),
    [allProjects, draft],
  );

  if (!draft) {
    return (
      <div className="grid gap-4" data-testid="work-zone-profile">
        <StatusRow view={view} />
        <div className="grid justify-items-start gap-2 rounded-lg border border-dashed p-4">
          <p className="font-medium text-sm">{WORK_ZONE_COPY.noDevice}</p>
          <p className="text-[13px] text-muted-foreground">{WORK_ZONE_COPY.noDeviceHint}</p>
          <Link href="/settings/devices" className={buttonVariants({ size: "sm", variant: "outline" })}>
            <Laptop aria-hidden /> Manage devices
          </Link>
        </div>
      </div>
    );
  }

  const set = (next: ProfileDraft) => {
    setDraft(next);
    setErrors({});
    setFormError(null);
  };
  const change = (patch: Partial<ProfileDraft>) => set({ ...draft, ...patch });

  function pickDevice(deviceId: string) {
    const next = usable.find((d) => d.id === deviceId);
    if (!draft || !next || next.id === draft.deviceId) return;
    const moved = withDevice(draft, next, allProjects);
    const names = new Map(allProjects.map((p) => [p.id, p.name]));
    setRemoved(
      draft.projectIds.filter((p) => !moved.projectIds.includes(p)).map((p) => names.get(p) ?? "A project"),
    );
    set(moved);
  }

  function pickRuntime(runtime: RuntimeId) {
    if (!draft || runtime === draft.runtime) return;
    setRemoved([]);
    change({ runtime });
  }

  function submit() {
    if (!draft) return;
    if (draft.projectIds.length === 0) {
      setErrors({ projectIds: WORK_ZONE_COPY.pickProject });
      return;
    }
    save.mutate(toProfileInput(draft), {
      onError: (err) => {
        const fe = fieldError(err);
        if (fe && FIELDS.has(fe.field)) setErrors({ [fe.field]: fe.message });
        else setFormError(fe?.message ?? errorMessage(err));
      },
    });
  }

  function onRemove() {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    remove.mutate(undefined, { onError: (err) => setFormError(errorMessage(err)) });
  }

  // Keep a stored device the caller can no longer see selectable, named by the profile.
  const deviceItems = usable.map((d) => ({ value: d.id, label: deviceLabel(d) }));
  if (view.profile && !usable.some((d) => d.id === view.profile?.deviceId)) {
    deviceItems.push({ value: view.profile.device.id, label: view.profile.device.name });
  }
  const runtimeLabel = RUNTIMES[draft.runtime].label;
  const modes = offer?.modes ?? fallbackModes(draft);

  return (
    <div className="grid gap-7" data-testid="work-zone-profile">
      <StatusRow view={view} />

      <Group legend="Where">
        <FormField id={`${id}-device`} label="Device" error={errors.deviceId}>
          <Select
            items={deviceItems}
            value={draft.deviceId}
            onValueChange={(v) => typeof v === "string" && pickDevice(v)}
            disabled={busy}
          >
            <SelectTrigger
              id={`${id}-device`}
              data-testid="work-zone-device"
              aria-invalid={!!errors.deviceId}
              aria-describedby={describedBy(`${id}-device`, errors.deviceId)}
              className="w-full"
            />
            <SelectContent>
              {usable.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  <span className="flex min-w-0 items-center gap-2">
                    <OnlineDot online={d.status === "online"} className="size-1.5" />
                    <span className="truncate">{d.name}</span>
                    {d.hostKind === "service" ? <ServerBadge /> : null}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {device ? (
            <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
              <OnlineDot online={device.status === "online"} className="size-1.5" />
              {device.status === "online" ? "Online" : "Offline"}
              {device.hostKind === "service" ? <ServerBadge /> : null}
            </p>
          ) : null}
        </FormField>

        <div className="grid gap-2">
          <p id={`${id}-runtime`} className="font-medium text-sm">
            Runtime
          </p>
          <div
            role="radiogroup"
            aria-labelledby={`${id}-runtime`}
            className="grid grid-cols-2 gap-2"
            data-testid="work-zone-runtime"
          >
            {RUNTIME_IDS.map((r) => {
              const ready = device ? signedIn(device, r) : false;
              const checked = draft.runtime === r;
              return (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  tabIndex={checked ? 0 : -1}
                  disabled={busy || (!ready && !checked)}
                  onClick={() => pickRuntime(r)}
                  data-testid={`work-zone-runtime-${r}`}
                  className={cn(radioRowClass, "rounded-lg border")}
                >
                  <RuntimeLogo runtime={r} />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate font-medium text-sm">{RUNTIMES[r].label}</span>
                    {!ready ? (
                      <span className="truncate text-muted-foreground text-xs">
                        Not signed in on this device
                      </span>
                    ) : null}
                  </span>
                  <RowCheck checked={checked} />
                </button>
              );
            })}
          </div>
          {errors.runtime ? (
            <p role="alert" className="text-[13px] text-destructive">
              {errors.runtime}
            </p>
          ) : null}
        </div>
        {removed.length > 0 ? (
          <p className="text-muted-foreground text-xs" data-testid="work-zone-removed">
            Removed: {removed.join(", ")}
          </p>
        ) : null}
      </Group>

      <Group legend="Projects">
        <ProjectChecks
          projects={list}
          loading={projectsQ.isPending}
          selected={draft.projectIds}
          extra={(view.profile?.projects ?? []).filter(
            (p) => draft.projectIds.includes(p.id) && !list.some((x) => x.id === p.id),
          )}
          disabled={busy}
          error={errors.projectIds}
          onChange={(projectIds) => change({ projectIds })}
        />
      </Group>

      <Group legend="Model and options">
        {offer && offer.models.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            This device reported no models for {runtimeLabel}. The bot uses the runtime's default.
          </p>
        ) : null}
        <DefaultAndAllowed
          id={`${id}-model`}
          testId="model"
          pluralTestId="models"
          label="Default model"
          noun="model"
          anyHint="Any model this device offers"
          choices={offer?.models ?? []}
          defaultValue={draft.defaultModel}
          allowed={draft.allowedModels}
          disabled={busy}
          defaultError={errors.defaultModel}
          allowedError={errors.allowedModels}
          onDefault={(defaultModel) => change({ defaultModel })}
          onAllowed={(allowedModels) => change({ allowedModels })}
        />
        <DefaultAndAllowed
          id={`${id}-effort`}
          testId="effort"
          pluralTestId="efforts"
          label="Reasoning"
          noun="reasoning level"
          anyHint="Any level this device offers"
          choices={offer?.efforts ?? []}
          defaultValue={draft.defaultEffort}
          allowed={draft.allowedEfforts}
          disabled={busy}
          defaultError={errors.defaultEffort}
          allowedError={errors.allowedEfforts}
          onDefault={(defaultEffort) => change({ defaultEffort })}
          onAllowed={(allowedEfforts) => change({ allowedEfforts })}
        />
        <DefaultAndAllowed
          id={`${id}-context`}
          testId="context"
          pluralTestId="contexts"
          label="Context window"
          noun="context window"
          anyHint="Any window this device offers"
          choices={offer?.contextWindows ?? []}
          defaultValue={draft.defaultContextWindow}
          allowed={draft.allowedContextWindows}
          disabled={busy}
          defaultError={errors.defaultContextWindow}
          allowedError={errors.allowedContextWindows}
          onDefault={(defaultContextWindow) => change({ defaultContextWindow })}
          onAllowed={(allowedContextWindows) => change({ allowedContextWindows })}
        />
        <FastModeField
          id={`${id}-fast`}
          value={draft.fastMode}
          fast={offer?.fast ?? { available: true, reason: null }}
          disabled={busy}
          error={errors.fastMode}
          onChange={(fastMode) => change({ fastMode })}
        />
      </Group>

      <Group legend="Permissions">
        <div className="grid gap-4 md:grid-cols-2">
          <ModeField
            id={`${id}-default-mode`}
            testId="work-zone-default-mode"
            label="Default mode"
            value={draft.defaultMode}
            modes={modes}
            disabled={busy}
            error={errors.defaultMode}
            onChange={(m) => set(withDefaultMode(draft, m))}
          />
          <ModeField
            id={`${id}-max-mode`}
            testId="work-zone-max-mode"
            label="Highest mode"
            hint="The bot may ask for any mode up to this one."
            value={draft.maxMode}
            modes={modes}
            disabled={busy}
            error={errors.maxMode}
            onChange={(m) => set(withMaxMode(draft, m))}
          />
        </div>
        {draft.maxMode === "fullAccess" ? (
          <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
            <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-warning/15 px-2 font-medium text-[12px] text-amber-800 dark:text-amber-300">
              <LockOpen aria-hidden className="size-3.5" />
              Full access
            </span>
            <span className="pt-0.5">{WORK_ZONE_COPY.fullAccessNeeds}</span>
          </p>
        ) : null}
        {/* biome-ignore lint/a11y/noLabelWithoutControl: the Switch renders the control inside the label */}
        <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
          <span className="grid gap-0.5">
            <span id={`${id}-worktree`} className="font-medium text-sm">
              Isolated worktree
            </span>
            <span id={`${id}-worktree-hint`} className="text-muted-foreground text-xs leading-snug">
              Each session works on its own git branch, so the device's checkout stays untouched.
            </span>
          </span>
          <Switch
            checked={draft.worktree}
            onCheckedChange={(worktree) => change({ worktree })}
            disabled={busy}
            aria-labelledby={`${id}-worktree`}
            aria-describedby={`${id}-worktree-hint`}
            data-testid="work-zone-worktree"
          />
        </label>
      </Group>

      <Group legend="Limits">
        <div className="grid gap-4 md:grid-cols-3">
          {LIMIT_FIELDS.map((f) => (
            <LimitField
              key={f.key}
              id={`${id}-${f.key}`}
              field={f}
              value={draft[f.key]}
              disabled={busy}
              error={errors[f.key]}
              onCommit={(n) => change({ [f.key]: n })}
            />
          ))}
        </div>
      </Group>

      <Group legend="Outside content">
        <OutsideContent
          id={`${id}-outside`}
          view={view}
          value={draft.actOnOutsideContent}
          disabled={busy}
          error={errors.actOnOutsideContent}
          onChange={(actOnOutsideContent) => change({ actOnOutsideContent })}
        />
      </Group>

      {formError ? (
        <p role="alert" className="text-[13px] text-destructive" data-testid="work-zone-form-error">
          {formError}
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        {view.profile && !readOnly ? (
          <RemoveProfileButton confirming={confirmRemove} pending={remove.isPending} onClick={onRemove} />
        ) : (
          <span />
        )}
        {readOnly ? null : (
          <Button
            onClick={submit}
            disabled={save.isPending}
            data-testid="work-zone-save"
            className="w-full sm:w-auto"
          >
            {save.isPending ? <Spinner /> : null}
            {WORK_ZONE_COPY.save}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Before the controls load: the draft's own modes, so the menus show the current values. */
function fallbackModes(d: ProfileDraft): Choice<PermissionMode>[] {
  const values = new Set<PermissionMode>(["default", d.defaultMode, d.maxMode]);
  return PERMISSION_MODES.filter((m) => values.has(m.value)).map((m) => ({
    value: m.value,
    label: m.label,
    available: true,
    reason: null,
    warning: m.tone === "warning",
  }));
}

function deviceLabel(d: Device): string {
  return d.hostKind === "service" ? `${d.name} · Server` : d.name;
}

function ServerBadge() {
  return (
    <Badge variant="outline" className="gap-1 text-foreground">
      <Server aria-hidden /> Server
    </Badge>
  );
}

/** A disabled option's reason, under its label (a disabled item takes no pointer, so no tooltip would show). */
function ChoiceLabel({ choice }: { choice: Choice<string | number> }) {
  return (
    <span className="grid min-w-0">
      <span className={cn("truncate", choice.warning && "text-amber-800 dark:text-amber-300")}>
        {choice.label}
      </span>
      {choice.reason ? (
        <span className="text-muted-foreground text-xs leading-snug">{choice.reason}</span>
      ) : null}
    </span>
  );
}

const RUNTIME_DEFAULT = "runtime-default";

/** A default select ("Runtime default" or one value) beside the chip list of the other values the bot may use. */
function DefaultAndAllowed<V extends string | number>({
  id,
  testId,
  pluralTestId,
  label,
  noun,
  anyHint,
  choices,
  defaultValue,
  allowed,
  disabled,
  defaultError,
  allowedError,
  onDefault,
  onAllowed,
}: {
  id: string;
  testId: string;
  pluralTestId: string;
  label: string;
  noun: string;
  anyHint: string;
  choices: readonly Choice<V>[];
  defaultValue: V | null;
  allowed: readonly V[];
  disabled: boolean;
  defaultError?: string | undefined;
  allowedError?: string | undefined;
  onDefault: (v: V | null) => void;
  onAllowed: (vs: V[]) => void;
}) {
  const byKey = new Map(choices.map((c) => [String(c.value), c]));
  const labelOf = (v: V) => byKey.get(String(v))?.label ?? String(v);
  // A stored value the offer does not list (yet) stays shown as itself.
  const items = [
    { value: RUNTIME_DEFAULT, label: WORK_ZONE_COPY.runtimeDefault },
    ...choices.map((c) => ({ value: String(c.value), label: c.label })),
    ...(defaultValue !== null && !byKey.has(String(defaultValue))
      ? [{ value: String(defaultValue), label: String(defaultValue) }]
      : []),
  ];
  const others = allowed.filter((v) => v !== defaultValue);
  const add = addable(choices, allowed, defaultValue);
  const hint =
    others.length === 0 ? (defaultValue === null ? anyHint : `Only the default ${noun}`) : undefined;
  const allowedId = `${id}-allowed`;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <FormField id={id} label={label} error={defaultError}>
        <Select
          items={items}
          value={defaultValue === null ? RUNTIME_DEFAULT : String(defaultValue)}
          onValueChange={(v) => {
            if (typeof v !== "string") return;
            onDefault(v === RUNTIME_DEFAULT ? null : (byKey.get(v)?.value ?? null));
          }}
          disabled={disabled}
        >
          <SelectTrigger
            id={id}
            data-testid={`work-zone-default-${testId}`}
            aria-invalid={!!defaultError}
            aria-describedby={describedBy(id, defaultError)}
            className="w-full"
          />
          <SelectContent>
            <SelectItem value={RUNTIME_DEFAULT}>{WORK_ZONE_COPY.runtimeDefault}</SelectItem>
            {choices.map((c) => (
              <SelectItem key={String(c.value)} value={String(c.value)} disabled={!c.available}>
                <ChoiceLabel choice={c} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <div className="grid content-start gap-2" data-testid={`work-zone-allowed-${pluralTestId}-field`}>
        <p id={`${allowedId}-label`} className="font-medium text-sm">
          Bot may also use
        </p>
        {others.length > 0 ? (
          <ul aria-labelledby={`${allowedId}-label`} className="flex flex-wrap gap-1.5">
            {others.map((v) => (
              <li key={String(v)}>
                <Badge variant="outline" className="h-7 gap-0.5 py-0 pr-0.5 pl-2 text-foreground text-xs">
                  {labelOf(v)}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${labelOf(v)}`}
                    disabled={disabled}
                    onClick={() => onAllowed(allowed.filter((x) => x !== v))}
                    className="size-6 text-muted-foreground"
                  >
                    <X aria-hidden />
                  </Button>
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
        <Select
          items={add.map((c) => ({ value: String(c.value), label: c.label }))}
          value={null}
          onValueChange={(v) => {
            const c = typeof v === "string" ? byKey.get(v) : undefined;
            if (c) onAllowed([...allowed, c.value]);
          }}
          disabled={disabled || add.length === 0}
        >
          <SelectTrigger
            placeholder={`Add a ${noun}…`}
            aria-label={`Add a ${noun} the bot may also use`}
            aria-invalid={!!allowedError}
            aria-describedby={allowedError ? `${allowedId}-error` : hint ? `${allowedId}-hint` : undefined}
            data-testid={`work-zone-allowed-${pluralTestId}`}
            className="w-full"
          />
          <SelectContent>
            {add.map((c) => (
              <SelectItem key={String(c.value)} value={String(c.value)}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {allowedError ? (
          <p id={`${allowedId}-error`} role="alert" className="text-[13px] text-destructive">
            {allowedError}
          </p>
        ) : hint ? (
          <p id={`${allowedId}-hint`} className="text-[13px] text-muted-foreground">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function FastModeField({
  id,
  value,
  fast,
  disabled,
  error,
  onChange,
}: {
  id: string;
  value: BotFastMode;
  fast: { available: boolean; reason: string | null };
  disabled: boolean;
  error?: string | undefined;
  onChange: (v: BotFastMode) => void;
}) {
  return (
    <FormField
      id={id}
      label="Fast mode"
      error={error}
      hint={fast.available ? undefined : (fast.reason ?? undefined)}
    >
      <Select
        items={FAST_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        value={value}
        onValueChange={(v) => typeof v === "string" && onChange(v as BotFastMode)}
        disabled={disabled}
      >
        <SelectTrigger
          id={id}
          data-testid="work-zone-fast"
          aria-invalid={!!error}
          aria-describedby={describedBy(id, error, fast.available ? undefined : fast.reason)}
          className="w-full md:w-1/2"
        />
        <SelectContent>
          {FAST_MODE_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value} disabled={o.value !== "off" && !fast.available}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  );
}

function ModeField({
  id,
  testId,
  label,
  hint,
  value,
  modes,
  disabled,
  error,
  onChange,
}: {
  id: string;
  testId: string;
  label: string;
  hint?: string;
  value: PermissionMode;
  modes: readonly Choice<PermissionMode>[];
  disabled: boolean;
  error?: string | undefined;
  onChange: (m: PermissionMode) => void;
}) {
  const items = modes.some((m) => m.value === value)
    ? modes
    : [...modes, ...fallbackModes({ defaultMode: value, maxMode: value } as ProfileDraft)];
  return (
    <FormField id={id} label={label} error={error} hint={hint}>
      <Select
        items={items.map((m) => ({ value: m.value, label: m.label }))}
        value={value}
        onValueChange={(v) => typeof v === "string" && onChange(v as PermissionMode)}
        disabled={disabled}
      >
        <SelectTrigger
          id={id}
          data-testid={testId}
          aria-invalid={!!error}
          aria-describedby={describedBy(id, error, hint)}
          className="w-full"
        />
        <SelectContent>
          {items.map((m) => (
            <SelectItem key={m.value} value={m.value} disabled={!m.available}>
              <span className="flex min-w-0 items-start gap-2">
                {m.warning ? (
                  <LockOpen
                    aria-hidden
                    className="mt-0.5 size-3.5 shrink-0 text-amber-800 dark:text-amber-300"
                  />
                ) : null}
                <ChoiceLabel choice={m} />
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  );
}

/** A bounded whole number: typing keeps the text, a valid value commits at once, leaving the field clamps it. */
function LimitField({
  id,
  field,
  value,
  disabled,
  error,
  onCommit,
}: {
  id: string;
  field: (typeof LIMIT_FIELDS)[number];
  value: number;
  disabled: boolean;
  error?: string | undefined;
  onCommit: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const hint = `${field.min} to ${field.max}`;
  const clamp = (n: number) => Math.min(field.max, Math.max(field.min, n));
  return (
    <FormField id={id} label={field.label} error={error} hint={hint}>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={field.min}
        max={field.max}
        step={1}
        value={text}
        disabled={disabled}
        aria-invalid={!!error}
        aria-describedby={describedBy(id, error, hint)}
        data-testid={`work-zone-limit-${field.key}`}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          const n = Number(raw);
          if (raw !== "" && Number.isInteger(n) && n >= field.min && n <= field.max) onCommit(n);
        }}
        onBlur={() => {
          const n = Number(text);
          const next = text === "" || !Number.isFinite(n) ? value : clamp(Math.round(n));
          setText(String(next));
          if (next !== value) onCommit(next);
        }}
      />
    </FormField>
  );
}

/** "Act on outside content" (D-08): a switch with the warning for admins; everyone else reads its value. */
function OutsideContent({
  id,
  view,
  value,
  disabled,
  error,
  onChange,
}: {
  id: string;
  view: BotWorkZoneProfileView;
  value: boolean;
  disabled: boolean;
  error?: string | undefined;
  onChange: (v: boolean) => void;
}) {
  const canSet = view.viewerCan.setOutsideContent;
  const by = view.profile?.actOnOutsideContent ? view.profile.actOnOutsideContentBy : null;
  return (
    <div className="grid gap-3" data-testid="work-zone-outside">
      {canSet ? (
        // biome-ignore lint/a11y/noLabelWithoutControl: the Switch renders the control inside the label
        <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
          <span className="grid gap-0.5">
            <span id={`${id}-label`} className="font-medium text-sm">
              Act on outside content
            </span>
            {by ? <span className="text-muted-foreground text-xs">Turned on by {by.displayName}</span> : null}
          </span>
          <Switch
            checked={value}
            onCheckedChange={onChange}
            disabled={disabled}
            aria-labelledby={`${id}-label`}
            aria-describedby={`${id}-warning`}
            data-testid="work-zone-outside-switch"
          />
        </label>
      ) : (
        <div className="flex min-h-11 items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
          <span className="grid gap-0.5">
            <span className="font-medium text-sm">Act on outside content</span>
            <span className="text-muted-foreground text-xs">{WORK_ZONE_COPY.adminOnly}</span>
          </span>
          <span className="shrink-0 text-sm" data-testid="work-zone-outside-value">
            {value ? "On" : "Off"}
          </span>
        </div>
      )}
      {canSet ? (
        <div
          id={`${id}-warning`}
          data-testid="work-zone-outside-warning"
          className="flex gap-2.5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[13px] text-amber-900 leading-relaxed dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200"
        >
          <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>{OUTSIDE_CONTENT_WARNING}</p>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The device's repositories as checkbox rows, grouped by team project like the New session dialog. */
function ProjectChecks({
  projects,
  loading,
  selected,
  extra,
  disabled,
  error,
  onChange,
}: {
  projects: readonly Project[];
  loading: boolean;
  selected: readonly string[];
  /** Stored projects the caller does not see on this device any more: listed so they can be taken out. */
  extra: ReadonlyArray<{ id: string; name: string }>;
  disabled: boolean;
  error?: string | undefined;
  onChange: (ids: string[]) => void;
}) {
  const groups = groupRepos(projects);
  const chosen = new Set(selected);
  const toggle = (pid: string) =>
    onChange(chosen.has(pid) ? selected.filter((x) => x !== pid) : [...selected, pid]);
  if (loading) return <ProjectsLoading />;
  const row = (p: { id: string; name: string }, caption?: string) => (
    <button
      key={p.id}
      type="button"
      role="checkbox"
      aria-checked={chosen.has(p.id)}
      data-project-id={p.id}
      disabled={disabled}
      onClick={() => toggle(p.id)}
      className={radioRowClass}
    >
      <FolderGit2
        aria-hidden
        className={cn("size-4 shrink-0", chosen.has(p.id) ? "text-primary" : "text-muted-foreground")}
      />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate font-medium text-sm leading-tight">{p.name}</span>
        {caption ? <span className="truncate text-muted-foreground text-xs">{caption}</span> : null}
      </span>
      <RowCheck checked={chosen.has(p.id)} />
    </button>
  );
  const personal = groups.personal.flatMap((g) => g.repos);
  const empty = projects.length === 0 && extra.length === 0;
  return (
    <div className="grid gap-2" data-testid="work-zone-projects">
      {empty ? (
        <p className="rounded-lg border border-dashed p-3 text-muted-foreground text-sm">
          {WORK_ZONE_COPY.noProjects}
        </p>
      ) : (
        <div
          role="group"
          aria-label="Projects"
          className="divide-y overflow-hidden rounded-lg border bg-card"
        >
          {groups.teams.map((g) => (
            <div key={g.project.id} className="divide-y">
              <div className="flex min-w-0 items-center gap-1.5 bg-muted/70 px-3 py-1.5 text-muted-foreground text-xs">
                <FolderKanban aria-hidden className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">
                  <span className="font-semibold text-foreground">{g.project.name}</span> · Team project
                </span>
              </div>
              {g.repos.map((p) => row(p, p.defaultBranch ?? undefined))}
            </div>
          ))}
          {personal.length > 0 ? (
            <div className="divide-y">
              {groups.teams.length > 0 ? (
                <p className="bg-muted/70 px-3 py-1.5 font-semibold text-foreground text-xs">Personal</p>
              ) : null}
              {personal.map((p) => row(p, p.defaultBranch ?? undefined))}
            </div>
          ) : null}
          {extra.length > 0 ? (
            <div className="divide-y">
              <p className="bg-muted/70 px-3 py-1.5 font-semibold text-foreground text-xs">
                Not on this device any more
              </p>
              {extra.map((p) => row(p))}
            </div>
          ) : null}
        </div>
      )}
      {error ? (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
