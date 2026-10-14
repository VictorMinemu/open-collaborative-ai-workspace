"use client";

import type { McpServer, McpServerList } from "@ocw/contracts";
import { KeyRound, Pencil, Plug, Plus, RefreshCw, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/api";
import {
  connectionsExistCount,
  useDeleteMcpServer,
  useMcpServers,
  useProbeMcpServer,
  useUpdateMcpServer,
} from "@/lib/mcp-queries";
import { useCan, usePermissions } from "@/lib/permissions";
import { cn, relativeTime } from "@/lib/utils";
import { McpServerDialog, TRANSPORTS } from "./mcp-server-dialog";
import { McpToolsEmpty, McpToolsList } from "./mcp-tools-list";

type Flag = "orgEnabled" | "personalAllowed" | "trustedChaining";

const FLAGS: Array<{ key: Flag; label: string; hint: string }> = [
  { key: "orgEnabled", label: "Bots can use it", hint: "Off removes its tools from every bot" },
  {
    key: "personalAllowed",
    label: "Allow for personal bots",
    hint: "Members may enable it in their own bot",
  },
  {
    key: "trustedChaining",
    label: "Trust for chained calls",
    hint: "Its output may lead to tools that change data in the same reply",
  },
];

const STATUS: Record<
  McpServer["status"],
  { label: string; variant: "success" | "warning" | "destructive" | "outline"; busy: boolean }
> = {
  pending: { label: "Waiting for the runtime", variant: "outline", busy: true },
  probing: { label: "Probing", variant: "warning", busy: true },
  ready: { label: "Ready", variant: "success", busy: false },
  error: { label: "Error", variant: "destructive", busy: false },
};

const EMPTY_SANDBOX: McpServerList["sandbox"] = { available: false, servers: [] };

/** A per-member connector the cell never probes: pending means no member has connected yet (UI-SPEC R6). */
const MEMBER_PENDING = { label: "Waiting for a member to connect", variant: "outline", busy: false } as const;

const MODE_BADGE: Record<McpServer["authMode"], string | null> = {
  org_secret: null,
  per_member_oauth: "Member sign-in",
  per_member_secret: "Member key",
};

/**
 * The Agent Card pill colours (AA in light and dark, UI-SPEC § Color): the Badge `warning` variant's amber text on its
 * own tint is under 4.5:1 in light mode, so these badges carry explicit amber / red classes.
 */
const AMBER = "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300";
const RED = "border-transparent bg-red-100 text-red-800 dark:bg-red-400/15 dark:text-red-300";
const OAUTH_BADGE: Partial<
  Record<NonNullable<McpServer["oauthStatus"]>, { label: string; className: string }>
> = {
  needs_client: { label: "Needs an OAuth client", className: AMBER },
  https_required: { label: "Needs HTTPS", className: AMBER },
  error: { label: "Sign-in error", className: RED },
};

export function memberCountLabel(n: number): string {
  if (n === 0) return "No members connected yet";
  return n === 1 ? "1 member connected" : `${n} members connected`;
}

/** The issuer's host for "Client: pre-registered (auth.acme.com)". */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 44 px touch targets below `md` (UI-SPEC: every control at 390). */
const TOUCH = "max-md:h-11";

/**
 * Settings › MCP servers (D-13, SC6, BOT-08): register remote MCP servers (or vetted sandboxed ones) with
 * write-only header credentials, see what the cell discovered and govern each server for the organization,
 * for personal bots and for chained calls. Organization Admins only (`mcp.manage`).
 */
export function McpServersSettings() {
  const permissions = usePermissions();
  const canManage = useCan("mcp.manage");
  const q = useMcpServers(canManage);
  const [editing, setEditing] = useState<McpServer | "new" | null>(null);

  if (!canManage) {
    return (
      <Shell>
        {permissions.isPending ? (
          <Skeleton className="h-40 rounded-2xl" />
        ) : (
          <div
            className="rounded-xl border border-dashed px-4 py-10 text-center text-muted-foreground text-sm"
            data-testid="mcp-admin-only"
          >
            Only workspace admins can connect MCP servers. Ask an admin if your bots need one.
          </div>
        )}
      </Shell>
    );
  }

  const servers = q.data?.servers ?? [];
  const sandbox = q.data?.sandbox ?? EMPTY_SANDBOX;

  return (
    <Shell>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-[15px] tracking-tight">Connected servers</h2>
          <p className="mt-0.5 max-w-xl text-muted-foreground text-sm">
            MCP servers give bots tools like search, tickets or docs. Each tool stays off until someone who
            manages a bot turns it on.
          </p>
        </div>
        {servers.length > 0 ? (
          <Button
            onClick={() => setEditing("new")}
            data-testid="mcp-add"
            className={cn("w-full sm:w-auto", TOUCH)}
          >
            <Plus /> Add server
          </Button>
        ) : null}
      </div>

      {q.isPending ? (
        <div className="grid gap-3">
          <Skeleton className="h-44 rounded-2xl" />
          <Skeleton className="h-44 rounded-2xl" />
        </div>
      ) : q.isError ? (
        <div className="rounded-xl border bg-card">
          <ServerUnreachable onRetry={() => q.refetch()} retrying={q.isFetching} />
        </div>
      ) : servers.length === 0 ? (
        <div
          className="flex flex-col items-center gap-3 rounded-2xl border border-dashed px-6 py-12 text-center"
          data-testid="mcp-empty"
        >
          <span className="flex size-11 items-center justify-center rounded-xl border bg-muted/50">
            <Plug className="size-5 text-muted-foreground" aria-hidden />
          </span>
          <div>
            <p className="font-medium text-sm">No MCP servers yet</p>
            <p className="mt-0.5 text-muted-foreground text-sm">Add one and your bots can use its tools.</p>
          </div>
          <Button onClick={() => setEditing("new")} data-testid="mcp-add" className={TOUCH}>
            <Plus /> Add server
          </Button>
        </div>
      ) : (
        <ul className="grid gap-3" aria-label="MCP servers" data-testid="mcp-server-list">
          {servers.map((s) => (
            <li key={s.id}>
              <ServerCard server={s} onEdit={() => setEditing(s)} />
            </li>
          ))}
        </ul>
      )}

      <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
        <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
        Header values are encrypted, only delivered to your own bots' runtime and never shown again. Every
        tool call is checked and audited.
      </p>

      <McpServerDialog
        open={editing !== null}
        server={editing === "new" ? null : editing}
        sandbox={sandbox}
        oauth={q.data?.oauth}
        onOpenChange={(o) => !o && setEditing(null)}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto grid w-full max-w-4xl gap-5 px-4 py-6 sm:px-6 sm:py-8">{children}</div>;
}

function ServerCard({ server, onEdit }: { server: McpServer; onEdit: () => void }) {
  const update = useUpdateMcpServer(server.id);
  const probe = useProbeMcpServer(server.id);
  const remove = useDeleteMcpServer(server.id);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Members a delete disconnects: the DTO's count, or the 409's when members connected since the list loaded. */
  const [deleteCount, setDeleteCount] = useState<number | null>(null);
  const members = deleteCount ?? server.memberConnections;
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const perMember = server.authMode !== "org_secret";
  const status = perMember && server.status === "pending" ? MEMBER_PENDING : STATUS[server.status];
  const transport = TRANSPORTS.find((t) => t.value === server.transport)?.label ?? server.transport;
  const modeBadge = MODE_BADGE[server.authMode];
  const oauthBadge = server.oauthStatus ? OAUTH_BADGE[server.oauthStatus] : undefined;
  const preRegistered = server.oauthClients.find((c) => c.method === "pre_registered");

  async function setFlag(key: Flag, value: boolean) {
    try {
      await update.mutateAsync({ [key]: value });
    } catch (err) {
      toast.error("Could not change the server", { description: errorMessage(err) });
    }
  }

  async function reprobe() {
    try {
      await probe.mutateAsync();
    } catch (err) {
      toast.error("Could not check the server", { description: errorMessage(err) });
    }
  }

  async function onDelete() {
    try {
      await remove.mutateAsync({ clearConnections: members > 0 });
      setConfirmDelete(false);
      toast.success(`${server.name} removed`, { description: "Its tools were taken off every bot." });
    } catch (err) {
      // Fallback (R4): the same dialog updates in place with the server's count; the next click confirms it.
      const count = connectionsExistCount(err);
      if (count !== null) setDeleteCount(count);
      else toast.error("Could not remove the server", { description: errorMessage(err) });
    }
  }

  return (
    <article
      className={cn(
        "overflow-hidden rounded-2xl border bg-card shadow-xs",
        server.status === "error" && "border-destructive/30",
        !server.orgEnabled && "opacity-90",
      )}
      data-testid="mcp-server"
      data-name={server.name}
      data-status={server.status}
    >
      <div className="flex flex-wrap items-start gap-3 p-4">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground"
        >
          <Plug className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="truncate font-semibold text-[15px] tracking-tight">{server.name}</h3>
            <Badge variant={status.variant} data-testid="mcp-status" data-status={server.status}>
              {status.busy ? <Spinner className="size-3" /> : null}
              {status.label}
            </Badge>
            {modeBadge ? (
              <Badge variant="outline" data-testid="mcp-auth-badge" data-mode={server.authMode}>
                {modeBadge}
              </Badge>
            ) : null}
            {oauthBadge ? (
              <Badge
                className={oauthBadge.className}
                data-testid="mcp-oauth-status"
                data-status={server.oauthStatus}
              >
                {oauthBadge.label}
              </Badge>
            ) : null}
            {!server.orgEnabled ? <Badge variant="outline">Off for bots</Badge> : null}
          </div>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
            <span className="shrink-0">{transport}</span>
            <span aria-hidden>·</span>
            <span className="truncate font-mono" title={server.url ?? server.sandboxServer ?? undefined}>
              {server.url ?? server.sandboxServer}
            </span>
          </p>
          {perMember ? (
            <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs">
              <span data-testid="mcp-member-count">{memberCountLabel(server.memberConnections)}</span>
              {preRegistered ? (
                // On a phone the client takes its own line (no separator); on wider screens it follows the count.
                <span className="truncate">
                  <span aria-hidden className="max-sm:hidden">
                    ·{" "}
                  </span>
                  Client: pre-registered ({hostOf(preRegistered.issuer)})
                </span>
              ) : null}
            </p>
          ) : null}
          {server.authMode === "per_member_secret" && server.memberHeaderName ? (
            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Member key header">
              <li
                className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-0.5 text-xs"
                data-testid="mcp-member-header-chip"
              >
                <KeyRound className="size-3 text-muted-foreground" aria-hidden />
                <span className="font-mono">{server.memberHeaderName}</span>
                <span className="text-muted-foreground">· each member's key</span>
              </li>
            </ul>
          ) : null}
          {!perMember && server.headers.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Headers">
              {server.headers.map((h) => (
                <li
                  key={h.name}
                  className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-0.5 text-xs"
                  data-testid="mcp-header"
                >
                  <KeyRound className="size-3 text-muted-foreground" aria-hidden />
                  <span className="font-mono">{h.name}</span>
                  <span className="text-muted-foreground">• set</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="flex w-full gap-1 sm:w-auto">
          {/* A per-member connector is probed with a member's account (07.4-13 wires its Re-probe), never by the cell. */}
          {!perMember ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={reprobe}
              disabled={probe.isPending || status.busy || !server.orgEnabled}
              data-testid="mcp-reprobe"
              className={cn("flex-1 sm:flex-none", TOUCH)}
              title={server.orgEnabled ? undefined : "Turn it on for bots first"}
            >
              <RefreshCw className={cn(probe.isPending && "animate-spin")} /> Re-probe
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={onEdit}
            data-testid="mcp-edit"
            className={cn("flex-1 sm:flex-none", TOUCH)}
          >
            <Pencil /> Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmDelete(true)}
            data-testid="mcp-delete"
            className={cn("flex-1 hover:bg-destructive/10 hover:text-destructive sm:flex-none", TOUCH)}
          >
            <Trash2 /> Delete
          </Button>
        </div>
      </div>

      {server.oauthStatus === "needs_client" ? (
        <p
          role="note"
          className="mx-4 -mt-1 mb-3 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-[13px] leading-snug"
          data-testid="mcp-needs-client-detail"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            {server.name} doesn't allow automatic registration. Register OCW at the provider with the redirect
            URI and enter its client ID in Edit.
          </span>
        </p>
      ) : null}

      {server.status === "error" && server.statusDetail ? (
        <p
          role="status"
          className="mx-4 -mt-1 mb-3 rounded-lg bg-destructive/8 px-3 py-2 text-[13px] leading-snug"
          data-testid="mcp-status-detail"
        >
          {server.statusDetail}
        </p>
      ) : null}

      <div className="grid gap-3 border-t bg-muted/20 px-4 py-3">
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-medium">
              {server.tools.length === 0
                ? "No tools found yet"
                : `${server.tools.length} ${server.tools.length === 1 ? "tool" : "tools"}`}
            </span>
            {server.probedAt ? (
              <span className="text-muted-foreground">Checked {relativeTime(server.probedAt)}</span>
            ) : null}
          </div>
          {server.tools.length > 0 ? (
            <McpToolsList tools={server.tools} />
          ) : perMember ? (
            <McpToolsEmpty>Tools appear after the first member connects.</McpToolsEmpty>
          ) : null}
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {FLAGS.map((f) => (
            // biome-ignore lint/a11y/noLabelWithoutControl: the Switch renders the control inside the label
            <label
              key={f.key}
              className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border bg-background px-3 py-2 max-md:min-h-11"
            >
              <span className="min-w-0">
                <span className="block font-medium text-[13px]">{f.label}</span>
                <span className="block text-[11.5px] text-muted-foreground leading-snug">{f.hint}</span>
              </span>
              <Switch
                checked={server[f.key]}
                onCheckedChange={(v) => void setFlag(f.key, v)}
                disabled={update.isPending}
                aria-label={`${f.label}: ${server.name}`}
                data-testid={`mcp-flag-${f.key}`}
              />
            </label>
          ))}
        </div>
      </div>

      <Dialog
        open={confirmDelete}
        onOpenChange={(o) => {
          setConfirmDelete(o);
          if (!o) setDeleteCount(null);
        }}
      >
        <DialogContent
          data-testid="mcp-delete-dialog"
          data-members={members}
          initialFocus={members > 0 ? cancelDeleteRef : undefined}
        >
          <DialogHeader>
            <DialogTitle>Delete {server.name}?</DialogTitle>
            <DialogDescription>
              Its tools are removed from every bot and its stored credentials are deleted.{" "}
              {members > 0
                ? `${members === 1 ? "1 member is" : `${members} members are`} connected; their sign-ins and keys are deleted too. `
                : ""}
              This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              ref={cancelDeleteRef}
              variant="outline"
              onClick={() => setConfirmDelete(false)}
              className={TOUCH}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={onDelete}
              disabled={remove.isPending}
              className={TOUCH}
              data-testid="mcp-delete-confirm"
            >
              {remove.isPending ? <Spinner /> : <Trash2 />}
              {members > 0 ? `Delete and disconnect ${members}` : "Delete server"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  );
}
