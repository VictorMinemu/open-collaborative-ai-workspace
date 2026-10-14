"use client";

import type { Device, RuntimeId } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CheckCircle2,
  Copy,
  FolderPlus,
  Laptop,
  Lock,
  Monitor,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
  Users,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { useGrain } from "@/components/shell/module-gate";
import { Badge } from "@/components/ui/badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { OnlineDot, RUNTIMES, RuntimeLogo } from "@/components/work-zone/meta";
import { useCopy } from "@/hooks/use-copy";
import { errorMessage } from "@/lib/api";
import { useRuntimeConfig } from "@/lib/config";
import { useDesktop } from "@/lib/desktop";
import { useMe } from "@/lib/queries";
import { cn, relativeTime } from "@/lib/utils";
import {
  useCreateEnrollment,
  useDevices,
  useRevokeDevice,
  useWorkZoneOrgSync,
  wzKeys,
} from "@/lib/workzone-queries";
import { DeviceSharing } from "./device-sharing";

const PLATFORM: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

/** The Devices page subtitle: it offers pairing only while `device.pair` is not decided off (07.3, P-08). */
export function DevicesSubtitle() {
  return useGrain("device.pair") === "off"
    ? "The computers you paired and who can use them"
    : "Pair computers that run your coding agents";
}

export function DevicesSettings() {
  const devices = useDevices();
  const me = useMe({ enabled: false });
  const params = useSearchParams();
  const [adding, setAdding] = useState(false);
  const desktop = useDesktop();
  const qc = useQueryClient();
  // Pairing belongs to the Work Zone module (07.3, D-01): it leaves once `device.pair` is decided off, never while
  // loading or after a failed fetch (P-08). The device list, rename, sharing and revoke stay for device hygiene.
  const canPair = useGrain("device.pair") !== "off";
  useWorkZoneOrgSync();

  useEffect(() => {
    if (params.get("add") === "1") setAdding(true);
  }, [params]);

  const mine = (devices.data ?? []).filter((d) => d.ownerUserId === me.data?.user.id);
  const others = (devices.data ?? []).filter((d) => d.ownerUserId !== me.data?.user.id);

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-8 px-4 py-6 sm:px-6 sm:py-8">
      <section className="grid gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-semibold text-[15px] tracking-tight">Your devices</h2>
            <p className="mt-0.5 text-muted-foreground text-sm">
              Computers that run Claude Code or Codex for the Work Zone, on your own subscription.
            </p>
          </div>
          <div className="flex gap-2">
            {desktop && canPair ? (
              <Button
                variant="outline"
                onClick={async () => {
                  const res = await desktop.addProject();
                  if (res.ok) {
                    toast.success(`Added ${res.project.name}`);
                    void qc.invalidateQueries({ queryKey: wzKeys.devices });
                  } else if (!res.canceled) toast.error(res.error);
                }}
              >
                <FolderPlus /> Add project from this computer
              </Button>
            ) : null}
            {canPair ? (
              <Button onClick={() => setAdding(true)} data-testid="add-device">
                <Plus /> Add device
              </Button>
            ) : null}
          </div>
        </div>
        {devices.isError ? (
          <ServerUnreachable onRetry={() => devices.refetch()} retrying={devices.isFetching} />
        ) : devices.isLoading ? (
          <div className="grid gap-2">
            <Skeleton className="h-24" />
          </div>
        ) : mine.length === 0 && !canPair ? (
          <p
            data-testid="devices-none"
            className="rounded-xl border border-dashed px-6 py-8 text-center text-muted-foreground text-sm"
          >
            You have no paired devices.
          </p>
        ) : mine.length === 0 ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            data-testid="add-first-device"
            className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center transition-colors hover:bg-accent/30"
          >
            <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Laptop className="size-5" />
            </span>
            <span className="font-medium text-sm">Connect your first device</span>
            <span className="max-w-sm text-muted-foreground text-sm">
              Install the desktop app (or the <code className="font-mono text-[12px]">ocw-runtime</code> CLI)
              and pair it with a one-time code.
            </span>
          </button>
        ) : (
          <ul className="grid gap-2" data-testid="device-list">
            {mine.map((d) => (
              <DeviceCard key={d.id} device={d} owned />
            ))}
          </ul>
        )}
      </section>

      {others.length > 0 ? (
        <section className="grid gap-3">
          <div>
            <h2 className="font-semibold text-[15px] tracking-tight">Team devices</h2>
            <p className="mt-0.5 text-muted-foreground text-sm">
              Shared devices are available when you start a session.
            </p>
          </div>
          <ul className="grid gap-2">
            {others.map((d) => (
              <DeviceCard key={d.id} device={d} owned={false} />
            ))}
          </ul>
        </section>
      ) : null}

      <AddDeviceDialog
        open={adding && canPair}
        onOpenChange={setAdding}
        known={(devices.data ?? []).map((d) => d.id)}
      />
    </div>
  );
}

function DeviceCard({ device: d, owned }: { device: Device; owned: boolean }) {
  const revoke = useRevokeDevice();
  const [confirm, setConfirm] = useState(false);
  // Decided by the API resolver: revoke = owner or admin; update (rename, share) = owner only.
  const canRevoke = d.viewerCan?.includes("device.revoke") ?? false;
  const canUpdate = d.viewerCan?.includes("device.update") ?? false;
  const online = d.status === "online";

  return (
    <li className="rounded-xl border bg-card" data-testid="device-card" data-status={d.status}>
      <div className="flex items-start gap-3 p-4">
        <span className="relative flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          {d.platform === "darwin" ? <Laptop className="size-5" /> : <Monitor className="size-5" />}
          <OnlineDot online={online} className="absolute -right-0.5 -bottom-0.5 ring-2 ring-card" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate font-medium text-sm">{d.name}</p>
            <Badge variant={online ? "success" : "outline"}>{online ? "Online" : "Offline"}</Badge>
            {d.shared ? (
              <Badge variant="brand">
                <Users /> Shared
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {PLATFORM[d.platform] ?? d.platform}
            {owned ? "" : ` · ${d.ownerName ?? "teammate"}`} · {d.projectCount} project
            {d.projectCount === 1 ? "" : "s"}
            {" · "}
            {online
              ? "connected"
              : d.lastSeenAt
                ? `last seen ${relativeTime(d.lastSeenAt)}`
                : "never connected"}
          </p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {d.runtimes.length === 0 ? (
              <span className="text-muted-foreground text-xs">
                Runtimes are detected when the device connects.
              </span>
            ) : (
              d.runtimes.map((r) => (
                <span
                  key={r.id}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
                    !(r.installed && r.loggedIn) && "opacity-60",
                  )}
                >
                  <RuntimeLogo runtime={r.id} className="size-4 rounded-[4px]" />
                  {RUNTIMES[r.id].label}
                  {r.version ? <span className="text-muted-foreground">{r.version}</span> : null}
                  {!r.installed ? (
                    <span className="text-muted-foreground">· not installed</span>
                  ) : r.loggedIn ? (
                    <Check className="size-3 text-success" aria-label="Signed in" />
                  ) : (
                    <span className="text-warning">· sign in needed</span>
                  )}
                </span>
              ))
            )}
          </div>
        </div>
        {canRevoke ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Revoke ${d.name}`}
            className="text-muted-foreground hover:text-destructive"
            onClick={() => setConfirm(true)}
            data-testid="revoke-device"
          >
            <Trash2 />
          </Button>
        ) : null}
      </div>
      <DeviceFacts device={d} owned={owned} />
      {canUpdate ? <DeviceSharing device={d} /> : null}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Revoke {d.name}?</DialogTitle>
            <DialogDescription>
              It disconnects immediately and its running sessions stop. Pair it again with a new code to reuse
              it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={revoke.isPending}
              data-testid="confirm-revoke"
              onClick={() =>
                revoke.mutate(d.id, {
                  onSuccess: () => {
                    setConfirm(false);
                    toast.success(`${d.name} revoked`);
                  },
                  onError: (err) => toast.error(errorMessage(err)),
                })
              }
            >
              {revoke.isPending ? <Spinner /> : <Trash2 />} Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

/** Whose subscription a runtime on the device uses (D-06). */
const LOGIN: Record<RuntimeId, string> = { "claude-code": "Claude login", codex: "ChatGPT login" };

/**
 * Whose runtime subscription the device uses (D-06) and its Full access opt-in, which is set on the device itself
 * and only shown here (ADR-0012 §5).
 */
function DeviceFacts({ device: d, owned }: { device: Device; owned: boolean }) {
  const whose = owned ? "your" : `${d.ownerName ?? "the owner"}'s`;
  const signedIn = d.runtimes.filter((r) => r.installed && r.loggedIn);
  return (
    <div className="grid gap-3 border-t px-4 py-3">
      {signedIn.length > 0 ? (
        <ul className="grid gap-1.5" data-testid="device-subscription" aria-label="Subscriptions used">
          {signedIn.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-sm">
              <RuntimeLogo runtime={r.id} className="size-4 shrink-0 rounded-[4px]" />
              <span className="min-w-0">
                {RUNTIMES[r.id].label} runs on {whose} {LOGIN[r.id]}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div
        className="flex items-start gap-2.5"
        data-testid="device-full-access"
        data-enabled={d.fullAccessOptIn}
      >
        <span
          data-testid="device-full-access-icon"
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5",
            // The Badge warning pill colours: the icon keeps 3:1 in both themes (WINDOWS #197).
            d.fullAccessOptIn
              ? "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300"
              : "bg-muted text-muted-foreground",
          )}
        >
          {d.fullAccessOptIn ? <ShieldAlert /> : <ShieldCheck />}
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-sm">
            Full access
            <span className="inline-flex items-center gap-1 font-normal text-muted-foreground text-xs">
              <Lock className="size-3" aria-hidden /> Set on the device
            </span>
          </p>
          <p className="text-sm">
            {d.fullAccessOptIn ? (
              "On — enabled on this device by its owner"
            ) : (
              <>
                Off — enable it on the device (desktop app › Runtime › Allow Full access, or{" "}
                <code className="whitespace-nowrap rounded bg-muted px-1 py-0.5 font-mono text-[12px]">
                  ocw-runtime full-access on
                </code>
                )
              </>
            )}
          </p>
          <p className="text-muted-foreground text-xs">
            Recommended only on a dedicated machine: the agent can run any command and edit any file this
            computer's user can reach, without asking.
          </p>
        </div>
      </div>
    </div>
  );
}

function AddDeviceDialog({
  open,
  onOpenChange,
  known,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  known: string[];
}) {
  const create = useCreateEnrollment();
  const devices = useDevices();
  const { apiUrl } = useRuntimeConfig();
  const { copy, copied } = useCopy();
  const [tab, setTab] = useState<"desktop" | "cli">("desktop");
  const [now, setNow] = useState(Date.now());
  const baseline = useRef<Set<string>>(new Set());

  // biome-ignore lint/correctness/useExhaustiveDependencies: new code each time the dialog opens
  useEffect(() => {
    if (!open) return;
    baseline.current = new Set(known);
    create.mutate();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);

  const code = create.data?.code;
  const remaining = create.data ? Math.max(0, new Date(create.data.expiresAt).getTime() - now) : 0;
  const expired = !!create.data && remaining === 0;
  const paired = open ? (devices.data ?? []).find((d) => !baseline.current.has(d.id)) : undefined;
  const cli = `ocw-runtime enroll --server ${apiUrl} --code ${code ?? "XXXX-XXXX"}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="add-device-dialog">
        <DialogHeader>
          <DialogTitle>{paired ? "Device connected" : "Add a device"}</DialogTitle>
          <DialogDescription>
            {paired
              ? "It is ready for Work Zone sessions."
              : "Pair a computer with this one-time code. It expires in 10 minutes."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-5">
          {paired ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center" data-testid="device-paired">
              <CheckCircle2 className="size-10 text-success" />
              <p className="font-medium">{paired.name}</p>
              <p className="max-w-sm text-muted-foreground text-sm">
                Add a repository from the desktop app (or{" "}
                <code className="font-mono text-[12px]">ocw-runtime add-project</code>
                ), then start a session from the Work Zone.
              </p>
            </div>
          ) : (
            <>
              <div className="grid justify-items-center gap-2 rounded-xl border bg-muted/40 px-4 py-5">
                {create.isPending || !code ? (
                  <Skeleton className="h-11 w-56" />
                ) : (
                  <button
                    type="button"
                    onClick={() => void copy(code)}
                    data-testid="pairing-code"
                    className={cn(
                      "group flex items-center gap-3 rounded-lg px-3 py-1 font-mono font-semibold text-3xl tracking-[0.18em] transition-colors hover:bg-background",
                      expired && "text-muted-foreground line-through",
                    )}
                    aria-label="Copy pairing code"
                  >
                    {code}
                    {copied === code ? (
                      <Check className="size-4 text-success" />
                    ) : (
                      <Copy className="size-4 text-muted-foreground group-hover:text-foreground" />
                    )}
                  </button>
                )}
                <p className="text-muted-foreground text-xs" aria-live="polite">
                  {create.isError ? (
                    <span className="text-destructive">{errorMessage(create.error)}</span>
                  ) : expired ? (
                    "Code expired"
                  ) : create.data ? (
                    <>
                      Expires in {Math.floor(remaining / 60_000)}:
                      {String(Math.floor((remaining % 60_000) / 1000)).padStart(2, "0")} · waiting for the
                      device <Spinner className="ml-1 inline size-3" />
                    </>
                  ) : (
                    "Generating…"
                  )}
                </p>
              </div>

              <div className="grid gap-3">
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="tablist">
                  {(
                    [
                      ["desktop", "Desktop app", <Laptop key="d" />],
                      ["cli", "Command line", <Terminal key="c" />],
                    ] as const
                  ).map(([id, label, icon]) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={tab === id}
                      onClick={() => setTab(id)}
                      className={cn(
                        "flex h-8 items-center justify-center gap-1.5 rounded-md font-medium text-[13px] transition-colors [&_svg]:size-3.5",
                        tab === id
                          ? "bg-background shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {icon}
                      {label}
                    </button>
                  ))}
                </div>
                {tab === "desktop" ? (
                  <Steps
                    steps={[
                      "Open the OCW desktop app on the computer that has your code.",
                      "Paste this code when it asks to pair.",
                      <>
                        Choose <strong>Add project</strong> and pick a repository folder.
                      </>,
                    ]}
                  />
                ) : (
                  <div className="grid gap-2">
                    <Steps steps={["On the computer with your code, run:"]} />
                    <CopyLine text={cli} />
                    <Steps steps={["Register a repository and start the runtime:"]} start={2} />
                    <CopyLine text="ocw-runtime add-project ~/code/my-repo && ocw-runtime run" />
                  </div>
                )}
                <p className="text-muted-foreground text-xs">
                  Sessions use the Claude Code / Codex login already on that computer. No API keys are
                  uploaded and file paths never leave the device.
                </p>
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          {paired ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              {expired ? <Button onClick={() => create.mutate()}>New code</Button> : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Steps({ steps, start = 1 }: { steps: ReactNode[]; start?: number }) {
  return (
    <ol className="grid gap-2">
      {steps.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static list
        <li key={i} className="flex gap-2.5 text-sm">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/12 font-medium text-[11px] text-primary">
            {i + start}
          </span>
          <span className="pt-px">{s}</span>
        </li>
      ))}
    </ol>
  );
}

function CopyLine({ text }: { text: string }) {
  const { copy, copied } = useCopy();
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/50 py-1.5 pr-1.5 pl-3">
      <code className="scrollbar-thin min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px]">
        {text}
      </code>
      <Button size="icon-xs" variant="ghost" aria-label="Copy command" onClick={() => void copy(text)}>
        {copied === text ? <Check className="text-success" /> : <Copy />}
      </Button>
    </div>
  );
}
