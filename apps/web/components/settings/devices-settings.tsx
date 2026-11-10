"use client";

import { type Device, type RuntimeId, runtimeInstallCommand } from "@ocw/contracts";
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
  Server,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
  Users,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
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
import { useCan } from "@/lib/permissions";
import { useMe } from "@/lib/queries";
import { cn, relativeTime } from "@/lib/utils";
import {
  useCreateEnrollment,
  useDevices,
  useRevokeDevice,
  useWorkZoneOrgSync,
  wzKeys,
} from "@/lib/workzone-queries";
import { CopyLine } from "./copy-line";
import { DeviceBotConsents, showsBotConsents } from "./device-bot-consents";
import { DeviceSharing } from "./device-sharing";
import { PairApproveDialog, PairCodeField, PLATFORM_LABEL } from "./pair-approve-dialog";
import { compatFlag, DeviceRuntimeUpdates } from "./runtime-updates";

const PLATFORM = PLATFORM_LABEL;

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
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [addTab, setAddTab] = useState<AddTab>("desktop");
  // 07.12 (D-03): the code a server printed (`?pair=`) or typed in the Server tab, shown in the approve dialog.
  const [pairCode, setPairCode] = useState<string | null>(null);
  const desktop = useDesktop();
  const qc = useQueryClient();
  // Pairing belongs to the Work Zone module (07.3, D-01): it leaves once `device.pair` is decided off, never while
  // loading or after a failed fetch (P-08). The device list, rename, sharing and revoke stay for device hygiene.
  const canPair = useGrain("device.pair") !== "off";
  useWorkZoneOrgSync();

  useEffect(() => {
    const add = params.get("add");
    if (add === "1" || add === "server") {
      // `?add=server` is the link a server prints next to its code (07.12, D-01).
      setAddTab(add === "server" ? "server" : "desktop");
      setAdding(true);
    }
    const pair = params.get("pair");
    if (pair) setPairCode(pair);
  }, [params]);

  const openAdd = () => {
    setAddTab("desktop");
    setAdding(true);
  };

  const closePairing = () => {
    setPairCode(null);
    // A reload must not reopen it: the link's code leaves the address bar once the dialog closes (T-07.12-07-03).
    if (params.get("pair")) router.replace("/settings/devices");
  };

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
                    toast.success(
                      `Added ${res.project.name}`,
                      res.notice ? { description: res.notice } : undefined,
                    );
                    void qc.invalidateQueries({ queryKey: wzKeys.devices });
                  } else if (!res.canceled) toast.error(res.error);
                }}
              >
                <FolderPlus /> Add project from this computer
              </Button>
            ) : null}
            {canPair ? (
              <Button onClick={openAdd} data-testid="add-device">
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
            onClick={openAdd}
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

      <PairApproveDialog
        code={pairCode}
        open={pairCode !== null}
        allowed={canPair}
        onOpenChange={(o) => {
          if (!o) closePairing();
        }}
      />

      <AddDeviceDialog
        open={adding && canPair}
        onOpenChange={setAdding}
        known={(devices.data ?? []).map((d) => d.id)}
        initialTab={addTab}
        onPairCode={(code) => {
          setAdding(false);
          setPairCode(code);
        }}
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
  // 07.16 (D-22): an admin also decides which bots run on a headless server; the API decides again (`viewerCan.grant`).
  const canManageWorkZone = useCan("work_zone.manage");
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
                    "inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-md border px-2 py-1 text-xs",
                    !(r.installed && r.loggedIn) && "opacity-60",
                  )}
                >
                  <RuntimeLogo runtime={r.id} className="size-4 rounded-[4px]" />
                  {RUNTIMES[r.id].label}
                  {r.version ? <span className="text-muted-foreground">{r.version}</span> : null}
                  <CompatFlag device={d} runtime={r.id} />
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
      {showsBotConsents(d, owned, canManageWorkZone) ? <DeviceBotConsents device={d} /> : null}
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

/** 07.11 (D-04): "· older than supported" / "· can't run sessions" after a runtime's version, for every viewer. */
export function CompatFlag({ device, runtime }: { device: Device; runtime: RuntimeId }) {
  const flag = compatFlag(device.runtimeCompatibility?.[runtime]);
  return flag ? (
    <span data-testid="runtime-compat-flag" className={cn("whitespace-nowrap", flag.className)}>
      {flag.text}
    </span>
  ) : null;
}

/** Whose subscription a runtime on the device uses (D-06). */
const LOGIN: Record<RuntimeId, string> = { "claude-code": "Claude login", codex: "ChatGPT login" };

/**
 * Whose runtime subscription the device uses (D-06) and its Full access opt-in, which is set on the device itself
 * and only shown here (ADR-0012 §5). 07.16 (D-19, PD-18): on a headless server, also its Isolated server mark, set
 * only on the server (`ocw-runtime isolated-server on`) and shown here read-only.
 */
export function DeviceFacts({ device: d, owned }: { device: Device; owned: boolean }) {
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
      {d.hostKind === "service" ? <IsolatedServerFact on={d.isolatedServer === true} /> : null}
      {d.runtimeMaintenance ? <DeviceRuntimeUpdates device={d} /> : null}
    </div>
  );
}

/**
 * The Isolated server fact (D-08, D-19, PD-18), in the Full access row's style: a fact the server reports about itself,
 * never a control (P5). Only headless servers report it and the API honours it only there.
 */
function IsolatedServerFact({ on }: { on: boolean }) {
  return (
    <div className="flex items-start gap-2.5" data-testid="device-isolated-server" data-enabled={on}>
      <span
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5",
          // The same pairs as the Full access row (WINDOWS #197).
          on
            ? "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300"
            : "bg-muted text-muted-foreground",
        )}
      >
        {on ? <ShieldAlert /> : <ShieldCheck />}
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-sm">
          Isolated server
          <span className="inline-flex items-center gap-1 font-normal text-muted-foreground text-xs">
            <Lock className="size-3" aria-hidden /> Set on the device
          </span>
        </p>
        <p className="text-sm">
          {on ? (
            "On — bots that read outside content may run Full access sessions here"
          ) : (
            <>
              Off — mark it on the server:{" "}
              <code className="whitespace-nowrap rounded bg-muted px-1 py-0.5 font-mono text-[12px]">
                ocw-runtime isolated-server on
              </code>
            </>
          )}
        </p>
        <p className="text-muted-foreground text-xs">
          Only for a server with nothing else on it: after a bot reads mail, web pages or files, it may still
          start sessions here that act without asking.
        </p>
      </div>
    </div>
  );
}

type AddTab = "desktop" | "cli" | "server";

const ADD_TABS = [
  ["desktop", "Desktop app", <Laptop key="d" />],
  ["cli", "Command line", <Terminal key="c" />],
  ["server", "Server", <Server key="s" />],
] as const;

function AddDeviceDialog({
  open,
  onOpenChange,
  known,
  initialTab = "desktop",
  onPairCode,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  known: string[];
  initialTab?: AddTab;
  /** The Server tab's Continue: the code the server shows, opened in the approve dialog. */
  onPairCode: (code: string) => void;
}) {
  const create = useCreateEnrollment();
  const devices = useDevices();
  const { apiUrl } = useRuntimeConfig();
  const { copy, copied } = useCopy();
  // The tab the person picked in this opening; until then the one the page asked for (`?add=server`). Reset while
  // rendering the opening (not in an effect), so its first render already knows it is on the Server tab and no
  // one-time code is created for it; a closing dialog keeps its tab during the fade.
  const [picked, setPicked] = useState<AddTab | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setPicked(null);
  }
  const tab = picked ?? initialTab;
  const [now, setNow] = useState(Date.now());
  const baseline = useRef<Set<string>>(new Set());
  // One one-time code per opening, created only once the Desktop app or Command line tab is shown (07.12, D-01): the
  // Server tab pairs by the code the server prints instead.
  const coded = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a fresh start each time the dialog opens
  useEffect(() => {
    if (!open) return;
    baseline.current = new Set(known);
    coded.current = false;
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new code the first time a code tab is shown
  useEffect(() => {
    if (!open || tab === "server" || coded.current) return;
    coded.current = true;
    create.mutate();
  }, [open, tab]);

  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);

  const tabRefs = useRef<Partial<Record<AddTab, HTMLButtonElement | null>>>({});
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const ids = ADD_TABS.map(([id]) => id);
    const next = ids[(ids.indexOf(tab) + step + ids.length) % ids.length] ?? tab;
    setPicked(next);
    tabRefs.current[next]?.focus();
  };

  const server = tab === "server";
  const code = create.data?.code;
  const remaining = create.data ? Math.max(0, new Date(create.data.expiresAt).getTime() - now) : 0;
  const expired = !!create.data && remaining === 0;
  const paired = open ? (devices.data ?? []).find((d) => !baseline.current.has(d.id)) : undefined;
  const cli = `ocw-runtime enroll --server ${apiUrl} --code ${code ?? "XXXX-XXXX"}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="add-device-dialog" data-tab={tab}>
        <DialogHeader>
          <DialogTitle>{paired ? "Device connected" : "Add a device"}</DialogTitle>
          <DialogDescription>
            {paired
              ? "It is ready for Work Zone sessions."
              : server
                ? "Pair a server, or any computer without a screen, from its terminal. You approve it here."
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
              {server ? null : (
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
              )}

              <div className="grid min-w-0 grid-cols-1 gap-3">
                <div
                  className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1"
                  role="tablist"
                  aria-label="How to pair"
                  onKeyDown={onTabKey}
                >
                  {ADD_TABS.map(([id, label, icon]) => (
                    <button
                      key={id}
                      ref={(el) => {
                        tabRefs.current[id] = el;
                      }}
                      type="button"
                      role="tab"
                      aria-selected={tab === id}
                      // One tab stop for the list; the arrow keys move between tabs (WAI-ARIA tabs pattern).
                      tabIndex={tab === id ? 0 : -1}
                      onClick={() => setPicked(id)}
                      data-testid={`add-device-tab-${id}`}
                      className={cn(
                        "flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-md px-1 font-medium text-[13px] transition-colors sm:h-8 max-sm:[&_svg]:hidden [&_svg]:size-3.5 [&_svg]:shrink-0",
                        tab === id
                          ? "bg-background shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {icon}
                      <span className="truncate">{label}</span>
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
                ) : tab === "cli" ? (
                  <div className="grid min-w-0 grid-cols-1 gap-2">
                    <Steps steps={["On the computer with your code, run:"]} />
                    <CopyLine text={cli} buttonClassName="max-lg:size-11" />
                    <Steps steps={["Register a repository and start the runtime:"]} start={2} />
                    <CopyLine
                      text="ocw-runtime add-project ~/code/my-repo && ocw-runtime run"
                      buttonClassName="max-lg:size-11"
                    />
                  </div>
                ) : (
                  <ServerSteps apiUrl={apiUrl} onContinue={onPairCode} />
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
            <Button onClick={() => onOpenChange(false)} className="max-lg:h-11">
              Done
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} className="max-lg:h-11">
                Close
              </Button>
              {expired && !server ? (
                <Button onClick={() => create.mutate()} className="max-lg:h-11">
                  New code
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Add a device › Server (07.12, D-01, D-02): install the runtime for this workspace, run `ocw-runtime setup`, then type
 * the code the server prints (or open the link it prints) to approve it. No one-time code is shown here.
 */
export function ServerSteps({ apiUrl, onContinue }: { apiUrl: string; onContinue: (code: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="grid min-w-0 grid-cols-1 gap-2">
      <Steps steps={["On the server, as the account that will run it, install the runtime:"]} />
      <CopyLine
        text={runtimeInstallCommand(apiUrl)}
        testId="server-install-command"
        buttonClassName="max-lg:size-11"
        wrap
      />
      <Steps steps={["Pair it and install the service:"]} start={2} />
      <CopyLine
        text="ocw-runtime setup"
        testId="server-setup-command"
        buttonClassName="max-lg:size-11"
        wrap
      />
      <Steps steps={["Enter the code the server shows:"]} start={3} />
      <PairCodeField value={value} onChange={setValue} onSubmit={onContinue} label="Code the server shows" />
      <p className="text-muted-foreground text-xs">
        Needs Node 24 on the server. Linux or macOS. Opening the link the server prints works too.
      </p>
    </div>
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
