"use client";
// authz-legacy: 02-10 migrates this file to the resolver

import { AlertTriangle, Check, Copy, KeyRound, RefreshCw, Server, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/panel-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useCopy } from "@/hooks/use-copy";
import { errorMessage } from "@/lib/api";
import {
  useAgents,
  useBotsRealtime,
  useCellStatus,
  useIsAdmin,
  useRotateCellToken,
} from "@/lib/bots-queries";
import { cn, formatDate, relativeTime } from "@/lib/utils";

export function BotsRuntimeSettings() {
  useBotsRealtime();
  const isAdmin = useIsAdmin();
  const cell = useCellStatus(isAdmin);
  const agents = useAgents();
  const rotate = useRotateCellToken();
  const [confirming, setConfirming] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const { copy, copied } = useCopy();

  if (!isAdmin) {
    return (
      <Shell>
        <div className="rounded-xl border border-dashed px-4 py-10 text-center text-muted-foreground text-sm">
          Only workspace admins can manage the bots runtime.
        </div>
      </Shell>
    );
  }

  const s = cell.data;
  const counts = (agents.data?.agents ?? []).reduce<Record<string, number>>((acc, a) => {
    acc[a.status] = (acc[a.status] ?? 0) + 1;
    return acc;
  }, {});

  async function generate() {
    try {
      const res = await rotate.mutateAsync();
      setToken(res.token);
      setConfirming(false);
    } catch (err) {
      toast.error("Could not generate a token", { description: errorMessage(err) });
    }
  }

  return (
    <Shell>
      <div>
        <h2 className="font-semibold text-[15px] tracking-tight">OpenClaw runtime</h2>
        <p className="mt-0.5 max-w-xl text-muted-foreground text-sm">
          Your bots run in a self-hosted OpenClaw cell that connects to this workspace through the Agent
          Channel API. It never touches the database directly.
        </p>
      </div>

      {cell.isPending ? (
        <Skeleton className="h-36 rounded-2xl" />
      ) : cell.isError || !s ? (
        <div className="rounded-xl border bg-card">
          <ServerUnreachable onRetry={() => cell.refetch()} retrying={cell.isFetching} />
        </div>
      ) : (
        <section
          data-testid="cell-status"
          data-connected={s.connected}
          className={cn(
            "overflow-hidden rounded-2xl border bg-card shadow-xs",
            s.connected ? "border-success/30" : "border-warning/30",
          )}
        >
          <div className="flex flex-wrap items-center gap-4 p-5">
            <span
              className={cn(
                "relative flex size-12 items-center justify-center rounded-2xl",
                s.connected ? "bg-success/12 text-success" : "bg-warning/12 text-warning",
              )}
            >
              <Server className="size-5" />
              <span
                className={cn(
                  "absolute -top-0.5 -right-0.5 size-3 rounded-full border-2 border-card",
                  s.connected ? "bg-success" : "bg-warning",
                )}
              >
                {s.connected ? (
                  <span className="absolute inset-0 animate-ping rounded-full bg-success opacity-60" />
                ) : null}
              </span>
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-base">{s.connected ? "Connected" : "Offline"}</p>
              <p className="text-muted-foreground text-sm">
                {s.connected
                  ? `Since ${relativeTime(s.connectedAt ?? new Date().toISOString())}${s.connections > 1 ? ` · ${s.connections} connections` : ""}`
                  : s.lastSeenAt
                    ? `Last seen ${relativeTime(s.lastSeenAt)}`
                    : "The OpenClaw cell has never connected."}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => cell.refetch()} disabled={cell.isFetching}>
              <RefreshCw className={cn(cell.isFetching && "animate-spin")} /> Refresh
            </Button>
          </div>
          <dl className="grid grid-cols-2 border-t bg-muted/20 text-sm sm:grid-cols-4">
            <Stat label="Ready" value={counts.ready ?? 0} tone="text-success" />
            <Stat label="Provisioning" value={counts.provisioning ?? 0} tone="text-warning" />
            <Stat label="Errors" value={counts.error ?? 0} tone="text-destructive" />
            <Stat label="Disabled" value={counts.disabled ?? 0} tone="text-muted-foreground" />
          </dl>
        </section>
      )}

      {s ? (
        <section className="grid gap-3 rounded-2xl border bg-card p-5 shadow-xs">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 font-semibold text-[15px] tracking-tight">
                <KeyRound className="size-4 text-muted-foreground" /> Cell token
              </h3>
              <p className="mt-0.5 max-w-lg text-muted-foreground text-sm">
                The OpenClaw cell authenticates with a bearer token. It can act for every bot in this
                workspace, so treat it like a password.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirming(true)}
              data-testid="rotate-cell-token"
            >
              <RefreshCw /> {s.uiTokenCreatedAt ? "Rotate token" : "Generate token"}
            </Button>
          </div>
          <ul className="grid gap-2 text-sm">
            <li className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
              <span>
                <span className="block font-medium">Environment token</span>
                <span className="block font-mono text-muted-foreground text-xs">OCW_CELL_TOKEN</span>
              </span>
              <Badge variant={s.envTokenConfigured ? "success" : "outline"}>
                {s.envTokenConfigured ? "Configured" : "Not set"}
              </Badge>
            </li>
            <li className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
              <span>
                <span className="block font-medium">Workspace token</span>
                <span className="block text-muted-foreground text-xs">
                  {s.uiTokenCreatedAt
                    ? `Created ${formatDate(s.uiTokenCreatedAt)}`
                    : "Generated here, shown once"}
                </span>
              </span>
              <Badge variant={s.uiTokenCreatedAt ? "success" : "outline"}>
                {s.uiTokenCreatedAt ? "Active" : "None"}
              </Badge>
            </li>
          </ul>
          <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <ShieldCheck className="size-3.5" /> Only a SHA-256 hash of workspace tokens is stored.
          </p>
        </section>
      ) : null}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {s?.uiTokenCreatedAt ? "Rotate the cell token?" : "Generate a cell token?"}
            </DialogTitle>
            <DialogDescription>
              {s?.uiTokenCreatedAt
                ? "The current workspace token stops working immediately. Update the OpenClaw cell with the new one."
                : "You will see the token once. Configure it as OCW_CELL_TOKEN on the OpenClaw cell."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button onClick={generate} disabled={rotate.isPending} data-testid="confirm-rotate">
              {rotate.isPending ? <Spinner /> : null}
              {s?.uiTokenCreatedAt ? "Rotate" : "Generate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={token !== null} onOpenChange={(o) => !o && setToken(null)}>
        <DialogContent data-testid="cell-token-dialog">
          <DialogHeader>
            <DialogTitle>Copy your cell token</DialogTitle>
            <DialogDescription>This is the only time it is shown.</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-3">
            <div className="flex gap-2">
              <Input
                readOnly
                value={token ?? ""}
                data-testid="cell-token"
                aria-label="Cell token"
                onFocus={(e) => e.currentTarget.select()}
                className="font-mono text-xs"
              />
              <Button
                variant="outline"
                onClick={() => token && copy(token).then(() => toast.success("Token copied"))}
                className="shrink-0"
              >
                {copied === token ? <Check className="text-success" /> : <Copy />}
                {copied === token ? "Copied" : "Copy"}
              </Button>
            </div>
            <div className="flex gap-2.5 rounded-lg border border-warning/30 bg-warning/8 p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <p>
                Set <code className="font-mono text-xs">OCW_CELL_TOKEN</code> on the{" "}
                <code className="font-mono text-xs">openclaw</code> service and restart it.
              </p>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setToken(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto grid w-full max-w-3xl gap-5 px-4 py-6 sm:px-6 sm:py-8">{children}</div>;
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="border-r px-5 py-3 last:border-r-0 max-sm:[&:nth-child(2)]:border-r-0 max-sm:[&:nth-child(-n+2)]:border-b">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={cn("font-semibold text-lg tabular-nums", value > 0 ? tone : "text-muted-foreground/60")}>
        {value}
      </dd>
    </div>
  );
}
