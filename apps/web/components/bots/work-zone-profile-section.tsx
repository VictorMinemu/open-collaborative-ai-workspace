"use client";

import {
  type Agent,
  BOT_WORK_ZONE_LIMITS,
  type BotWorkZoneProfile,
  type BotWorkZoneProfileInput,
  type BotWorkZoneProfileView,
  type Device,
  type Project,
  type RuntimeId,
} from "@ocw/contracts";
import { FolderGit2, FolderKanban, Laptop, Server, Trash2 } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useId, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { OnlineDot, RUNTIMES, RuntimeLogo } from "@/components/work-zone/meta";
import { ProjectsLoading, RowCheck, radioRowClass } from "@/components/work-zone/new-session-sections";
import { errorMessage } from "@/lib/api";
import {
  useBotWorkZoneProfile,
  useRemoveBotWorkZoneProfile,
  useSaveBotWorkZoneProfile,
} from "@/lib/bot-work-zone-queries";
import { groupRepos } from "@/lib/new-session-groups";
import { cn } from "@/lib/utils";
import { useDevices, useProjects } from "@/lib/workzone-queries";

/**
 * A bot's Work Zone profile in its sheet (07.16-12; D-01, D-02, D-08, PD-04, PD-20): where the bot may run sessions
 * (device, runtime, projects), with which models and options, up to which permission mode, within which limits, and
 * (admins only) whether it may act right after reading outside content. The API decides; the page renders: the status
 * row is the API's own verdict (`status`), never computed here, and is the confirmation of a save (no success toast).
 * Every save sends the full desired state in one PUT; the API's answer replaces the form. The options offered are the
 * caller's own live controls for the chosen device and runtime (the saver becomes the bot's sponsor, D-02); the API
 * checks every value again at save and at use.
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
  return <Editor key={key} agent={agent} view={q.data} devices={devices.data ?? []} />;
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
    <fieldset className="grid min-w-0 gap-3">
      <legend className="mb-3 font-medium text-sm">{legend}</legend>
      {children}
    </fieldset>
  );
}

function Editor({
  agent,
  view,
  devices,
}: {
  agent: Agent;
  view: BotWorkZoneProfileView;
  devices: readonly Device[];
}) {
  const id = useId();
  const projectsQ = useProjects();
  const save = useSaveBotWorkZoneProfile(agent.id);
  const remove = useRemoveBotWorkZoneProfile(agent.id);
  const usable = usableDevices(devices);
  const [draft, setDraft] = useState<ProfileDraft | null>(() =>
    view.profile ? draftFromProfile(view.profile) : newDraft(devices),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const readOnly = !view.viewerCan.edit;
  const busy = readOnly || save.isPending;
  const allProjects = projectsQ.data ?? [];

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

  const change = (patch: Partial<ProfileDraft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setErrors({});
    setFormError(null);
  };

  function submit() {
    if (!draft) return;
    if (draft.projectIds.length === 0) {
      setErrors({ projectIds: WORK_ZONE_COPY.pickProject });
      return;
    }
    save.mutate(toProfileInput(draft), {
      onError: (err) => setFormError(errorMessage(err)),
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

  return (
    <div className="grid gap-6" data-testid="work-zone-profile">
      <StatusRow view={view} />

      <Group legend="Where">
        <FormField id={`${id}-device`} label="Device" error={errors.deviceId}>
          <Select
            items={deviceItems}
            value={draft.deviceId}
            onValueChange={(v) => {
              const next = usable.find((d) => d.id === v);
              if (next) setDraft((d) => (d ? withDevice(d, next, allProjects) : d));
            }}
            disabled={busy}
          >
            <SelectTrigger id={`${id}-device`} data-testid="work-zone-device" className="w-full" />
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
                  onClick={() => change({ runtime: r })}
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
        </div>
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

      {formError ? (
        <p role="alert" className="text-[13px] text-destructive" data-testid="work-zone-form-error">
          {formError}
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        {view.profile && !readOnly ? (
          <Button
            variant={confirmRemove ? "destructive" : "ghost"}
            onClick={onRemove}
            disabled={remove.isPending}
            data-testid="work-zone-remove"
            className="w-full sm:w-auto"
          >
            {remove.isPending ? <Spinner /> : <Trash2 aria-hidden />}
            {confirmRemove ? WORK_ZONE_COPY.confirmRemove : WORK_ZONE_COPY.remove}
          </Button>
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
