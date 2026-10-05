"use client";

import { EFFORT_LABELS, type PermissionMode, type Project, type RuntimeId } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Check, FolderGit2, FolderPlus, GitBranch, Laptop, Rocket } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/api";
import { useDesktop } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import {
  useCreateWorkSession,
  useDevices,
  useProjects,
  useRuntimeControls,
  wzKeys,
} from "@/lib/workzone-queries";
import { controlReasonText, isShown, OnlineDot, PERMISSION_MODES, RUNTIMES, RuntimeLogo } from "./meta";

/** Before the device's controls load (or for a device with no catalog): the modes every runtime always had. */
const LEGACY_MODES: PermissionMode[] = ["default", "acceptEdits", "plan"];

export function NewSessionDialog({
  open,
  onOpenChange,
  initialProjectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialProjectId?: string | undefined;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const projects = useProjects();
  const devices = useDevices();
  const create = useCreateWorkSession();
  const desktop = useDesktop();

  const available = useMemo(() => (projects.data ?? []).filter((p) => p.available), [projects.data]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeId>("claude-code");
  const [model, setModel] = useState("default");
  const [effort, setEffort] = useState("default");
  const [mode, setMode] = useState<PermissionMode>("default");
  const [worktree, setWorktree] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    const preferred =
      available.find((p) => p.id === initialProjectId) ??
      available.find((p) => p.deviceOnline) ??
      available[0] ??
      null;
    setProjectId(preferred?.id ?? null);
  }, [open, initialProjectId, available]);

  const project = available.find((p) => p.id === projectId) ?? null;
  const device = devices.data?.find((d) => d.id === project?.deviceId) ?? null;
  const runtimeInfo = (id: RuntimeId) => device?.runtimes.find((r) => r.id === id);

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
    const ready = (id: RuntimeId) => {
      const r = device?.runtimes.find((x) => x.id === id);
      return !!r?.installed && r.loggedIn;
    };
    if (device && !ready(runtime)) {
      const alt = (["claude-code", "codex"] as const).find(ready);
      if (alt) {
        setRuntime(alt);
        setModel("default");
        setEffort("default");
      }
    }
  }, [device, runtime]);

  const byDevice = useMemo(() => {
    const m = new Map<string, { name: string; online: boolean; projects: Project[] }>();
    for (const p of available) {
      const g = m.get(p.deviceId) ?? { name: p.deviceName, online: p.deviceOnline, projects: [] };
      g.projects.push(p);
      m.set(p.deviceId, g);
    }
    return [...m.values()];
  }, [available]);

  async function addFromDesktop() {
    if (!desktop) return;
    const res = await desktop.addProject();
    if (res.ok) {
      toast.success(`Added ${res.project.name}`);
      await qc.invalidateQueries({ queryKey: wzKeys.projects });
    } else if (!res.canceled) toast.error(res.error);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!project) return setError("Choose a project");
    setError(null);
    try {
      const s = await create.mutateAsync({
        projectId: project.id,
        runtime,
        permissionMode: mode,
        worktree,
        ...(model !== "default" ? { model } : {}),
        ...(effort !== "default" ? { effort } : {}),
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      });
      onOpenChange(false);
      setPrompt("");
      router.push(`/work-zone/${s.id}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const rt = runtimeInfo(runtime);
  const runtimeReady = !!rt?.installed && rt.loggedIn;
  const canSubmit = !!project && project.deviceOnline && runtimeReady && !create.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="new-session-dialog">
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>New session</DialogTitle>
            <DialogDescription>
              Runs on a teammate's computer, controlled by everyone here. Prompts queue up and run one at a
              time.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-5">
            {/* Project */}
            <section className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label>Project</Label>
                {desktop ? (
                  <Button type="button" size="sm" variant="ghost" onClick={addFromDesktop}>
                    <FolderPlus /> Add project from this computer
                  </Button>
                ) : null}
              </div>
              {available.length === 0 ? (
                <div className="rounded-lg border border-dashed p-4 text-center text-muted-foreground text-sm">
                  No projects yet. Add a repository from the desktop app, or run{" "}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">
                    ocw-runtime add-project .
                  </code>{" "}
                  on a paired device.{" "}
                  <Link href="/settings/devices" className="text-primary underline-offset-4 hover:underline">
                    Manage devices
                  </Link>
                </div>
              ) : (
                <div className="grid gap-3" role="radiogroup" aria-label="Project">
                  {byDevice.map((g) => (
                    <div key={g.name} className="grid gap-1.5">
                      <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
                        <Laptop className="size-3.5" /> {g.name}
                        <OnlineDot online={g.online} className="ml-0.5 size-1.5" />
                        <span>{g.online ? "Online" : "Offline"}</span>
                      </p>
                      {g.projects.map((p) => {
                        const selected = p.id === projectId;
                        return (
                          <button
                            key={p.id}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            data-testid="project-option"
                            disabled={!p.deviceOnline}
                            onClick={() => setProjectId(p.id)}
                            className={cn(
                              "flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] disabled:cursor-not-allowed disabled:opacity-55",
                              selected
                                ? "border-primary/60 bg-primary/5 ring-[3px] ring-primary/15"
                                : "hover:border-foreground/20 hover:bg-accent/40",
                            )}
                          >
                            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                              <FolderGit2 className="size-4" />
                            </span>
                            <span className="grid min-w-0 flex-1">
                              <span className="truncate font-medium text-sm">{p.name}</span>
                              <span className="flex items-center gap-1 truncate text-muted-foreground text-xs">
                                <GitBranch className="size-3" /> {p.defaultBranch ?? "no branch"}
                                {p.gitRemote ? <span className="truncate"> · {p.gitRemote}</span> : null}
                              </span>
                            </span>
                            {selected ? <Check className="size-4 text-primary" /> : null}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Runtime */}
            <section className="grid gap-2">
              <Label>Agent</Label>
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Agent">
                {(["claude-code", "codex"] as const).map((id) => {
                  const info = runtimeInfo(id);
                  const ready = !!info?.installed && info.loggedIn;
                  const selected = runtime === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-testid={`runtime-${id}`}
                      disabled={!!device && !ready}
                      onClick={() => {
                        setRuntime(id);
                        setModel("default");
                        setEffort("default");
                      }}
                      className={cn(
                        "flex items-start gap-3 rounded-lg border p-3 text-left transition-[border-color,background-color,box-shadow] disabled:cursor-not-allowed disabled:opacity-55",
                        selected
                          ? "border-primary/60 bg-primary/5 ring-[3px] ring-primary/15"
                          : "hover:border-foreground/20 hover:bg-accent/40",
                      )}
                    >
                      <RuntimeLogo runtime={id} className="mt-0.5 size-7 rounded-lg" />
                      <span className="grid min-w-0 gap-0.5">
                        <span className="flex items-center gap-1.5 font-medium text-sm">
                          {RUNTIMES[id].label}
                          {info?.version ? (
                            <span className="font-normal text-muted-foreground text-xs">{info.version}</span>
                          ) : null}
                        </span>
                        <span className="text-muted-foreground text-xs leading-snug">
                          {!device
                            ? RUNTIMES[id].subscription
                            : !info?.installed
                              ? "Not installed on this device"
                              : !info.loggedIn
                                ? "Not signed in on this device"
                                : RUNTIMES[id].subscription}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="grid gap-2">
              <Label>Model</Label>
              <div className="grid gap-2 sm:grid-cols-2">
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
                  <SelectTrigger aria-label="Model" data-testid="new-session-model" />
                  <SelectContent>
                    <SelectItem value="default">Default</SelectItem>
                    {catalogModels.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {efforts.length > 0 ? (
                  <Select
                    items={[
                      { value: "default", label: "Default" },
                      ...efforts.map((e) => ({ value: e.value, label: EFFORT_LABELS[e.value] ?? e.value })),
                    ]}
                    value={effort}
                    onValueChange={(v) => setEffort(v ?? "default")}
                  >
                    <SelectTrigger aria-label="Reasoning effort" data-testid="new-session-effort" />
                    <SelectContent>
                      <SelectItem value="default">Default</SelectItem>
                      {efforts.map((e) => (
                        <SelectItem key={e.value} value={e.value}>
                          {EFFORT_LABELS[e.value] ?? e.value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
              </div>
              <p className="text-muted-foreground text-xs">
                {device && controls.isSuccess && !rc?.catalog
                  ? `${device.name} has not reported its ${RUNTIMES[runtime].label} models yet; the runtime picks its default.`
                  : `Models ${RUNTIMES[runtime].label} reported on ${device?.name ?? "the device"}. Change them anytime from the composer.`}
              </p>
            </section>

            <section className="grid gap-2">
              <Label>Permissions</Label>
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Permission mode">
                {modeOptions.map(({ meta, available, reason }) => {
                  const Icon = meta.icon;
                  const selected = mode === meta.value;
                  return (
                    <button
                      key={meta.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-testid={`mode-${meta.value}`}
                      disabled={!available}
                      onClick={() => setMode(meta.value)}
                      className={cn(
                        "flex items-start gap-2.5 rounded-lg border p-2.5 text-left transition-[border-color,background-color,box-shadow] disabled:cursor-not-allowed",
                        selected
                          ? "border-primary/60 bg-primary/5 ring-[3px] ring-primary/15"
                          : "hover:border-foreground/20 hover:bg-accent/40 disabled:hover:border-border disabled:hover:bg-transparent",
                      )}
                    >
                      <Icon
                        className={cn(
                          "mt-0.5 size-4 shrink-0",
                          !available
                            ? "text-muted-foreground/60"
                            : meta.tone === "warning"
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-foreground/80",
                        )}
                      />
                      <span className="grid min-w-0 gap-0.5">
                        <span
                          className={cn("font-medium text-[13px]", !available && "text-muted-foreground")}
                        >
                          {meta.label}
                        </span>
                        <span className="text-muted-foreground text-xs leading-snug">{meta.hint}</span>
                        {reason ? (
                          <span className="text-amber-700 text-xs leading-snug dark:text-amber-300/90">
                            {reason}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
              <span className="grid gap-0.5">
                <span className="font-medium text-sm">Isolated worktree</span>
                <span className="text-muted-foreground text-xs">
                  Work on a separate git branch so the device's checkout stays untouched.
                </span>
              </span>
              <Switch checked={worktree} onCheckedChange={setWorktree} aria-label="Isolated worktree" />
            </div>

            <section className="grid gap-2">
              <Label htmlFor="first-prompt">
                First prompt <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id="first-prompt"
                data-testid="first-prompt"
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="e.g. Add a dark-mode toggle to the settings page"
              />
            </section>

            {error ? (
              <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-destructive text-sm">
                {error}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit} data-testid="start-session">
              {create.isPending ? <Spinner /> : <Rocket />}
              Start session
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
