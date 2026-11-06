"use client";

import { ConnectorAuthFailure, ConnectorErrorCode, type McpServer } from "@ocw/contracts";
import { Building2, CircleAlert, CircleCheck, CircleDashed, TriangleAlert, Unplug } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, isApiError } from "@/lib/api";
import {
  disconnectCopy,
  failureBox,
  notConnectedLine,
  type OrgRowStatus,
  orgConnectionLine,
  orgConnectionStatus,
  reasonLine,
  stepLabel,
  stepOfFailure,
} from "@/lib/org-connection-format";
import { useDisconnectOrg, useStartOrgConnect } from "@/lib/org-connection-queries";
import { cn } from "@/lib/utils";

/** 44 px touch targets below `md` (UI-SPEC: every control at 390). */
const TOUCH = "max-md:h-11";

/** The 07.4 connection-state pills (UI-SPEC § Color › Connection state; AA in light and dark). */
const PILL: Record<OrgRowStatus, { label: string; icon: typeof CircleCheck; className: string }> = {
  not_connected: { label: "Not connected", icon: CircleDashed, className: "bg-muted text-muted-foreground" },
  connected: {
    label: "Connected",
    icon: CircleCheck,
    className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300",
  },
  needs_reconnect: {
    label: "Needs reconnect",
    icon: CircleAlert,
    className: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
  },
};

/** The toast of a refused Connect: the failing step for a D-10 code, else the API's fixed sentence for its code. */
function connectRefusal(err: unknown, server: string): { title: string; description?: string } {
  const code = isApiError(err) ? err.code : null;
  const failure = ConnectorAuthFailure.safeParse(code);
  if (failure.success)
    return { title: `Couldn't connect ${server}: ${stepLabel(stepOfFailure(failure.data))}.` };
  if (ConnectorErrorCode.safeParse(code).success) {
    return { title: `Couldn't connect ${server}`, description: errorMessage(err) };
  }
  return { title: `Couldn't connect ${server}`, description: "Try again." };
}

/**
 * The organization's connection on a server card (07.14 PD-12 › Row, D-08, D-11; COA-01, COA-04): who connected the
 * organization's account and when, or what is missing, with the one action that fixes it. Rendered by `ServerCard`
 * for organization sign-in and client-credentials servers only.
 */
export function OrgConnectionRow({
  server,
  oauthAvailable,
  onEdit,
}: {
  server: McpServer;
  oauthAvailable: boolean;
  onEdit: () => void;
}) {
  const connect = useStartOrgConnect(server.id);
  const disconnect = useDisconnectOrg(server.id);
  const [opening, setOpening] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const c = server.orgConnection;
  const status = orgConnectionStatus(c);
  const cc = server.authMode === "org_client_credentials";
  const pill = PILL[status];
  const PillIcon = pill.icon;
  const line =
    status === "connected" && c
      ? orgConnectionLine(c)
      : status === "needs_reconnect"
        ? reasonLine(c?.reconnectReason ?? null)
        : notConnectedLine(server.authMode, server.name);

  async function startConnect() {
    setOpening(true);
    try {
      await connect.mutateAsync();
      // The page is navigating to the provider: the button stays in its opening state.
    } catch (err) {
      setOpening(false);
      const t = connectRefusal(err, server.name);
      toast.error(t.title, t.description ? { description: t.description } : undefined);
    }
  }

  async function onDisconnect() {
    try {
      await disconnect.mutateAsync();
      setConfirmDisconnect(false);
      toast.success(`${server.name} disconnected`, {
        description: "Bots no longer use the organization's account.",
      });
    } catch (err) {
      toast.error(`Couldn't disconnect ${server.name}`, { description: errorMessage(err) });
    }
  }

  const signInBlocked = !cc && !oauthAvailable;
  let primary: ReactNode = null;
  if (status !== "connected") {
    if (cc) {
      primary = (
        <Button
          size="sm"
          onClick={onEdit}
          data-testid={
            status === "needs_reconnect" ? "mcp-org-update-credentials" : "mcp-org-add-credentials"
          }
          className={cn("max-sm:flex-1", TOUCH)}
        >
          {status === "needs_reconnect" ? "Update credentials" : "Add credentials"}
        </Button>
      );
    } else {
      primary = (
        <Button
          size="sm"
          onClick={() => void startConnect()}
          disabled={opening || signInBlocked}
          title={signInBlocked ? "Sign-in needs HTTPS on this workspace" : undefined}
          data-testid={status === "needs_reconnect" ? "mcp-org-reconnect" : "mcp-org-connect"}
          aria-label={`${status === "needs_reconnect" ? "Reconnect" : "Connect"} ${server.name} for the organization`}
          className={cn("max-sm:flex-1", TOUCH)}
        >
          {opening ? (
            <>
              <Spinner /> Opening {server.name}…
            </>
          ) : status === "needs_reconnect" ? (
            "Reconnect"
          ) : (
            "Connect"
          )}
        </Button>
      );
    }
  }

  const failure = server.authFailure ? failureBox(server.authFailure, server.name) : null;
  const copy = disconnectCopy(server.name);
  const actions =
    primary || status !== "not_connected" ? (
      <div className="flex shrink-0 gap-2 max-sm:w-full">
        {status !== "not_connected" ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmDisconnect(true)}
            data-testid="mcp-org-disconnect"
            aria-label={`Disconnect ${server.name} for the organization`}
            className={cn("max-sm:flex-1", TOUCH)}
          >
            <Unplug /> Disconnect
          </Button>
        ) : null}
        {primary}
      </div>
    ) : null;

  return (
    <>
      <section
        aria-label={`Organization account on ${server.name}`}
        className="mx-4 -mt-1 mb-3 flex flex-col gap-2.5 rounded-xl border bg-background px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3"
        data-testid="mcp-org-connection"
        data-status={status}
      >
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <Building2 className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="grid min-w-0 gap-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium text-[13px]">Organization account</span>
              <span
                className={cn(
                  "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 font-semibold text-[11px]",
                  pill.className,
                )}
                data-testid="mcp-org-status"
              >
                <PillIcon className="size-3" aria-hidden />
                {pill.label}
              </span>
            </div>
            <p className="min-w-0 break-words text-muted-foreground text-xs" data-testid="mcp-org-account">
              {line}
            </p>
          </div>
        </div>
        {actions}
      </section>

      {failure && server.authFailure ? (
        <div
          role="note"
          className="mx-4 -mt-1 mb-3 flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-[13px] leading-snug sm:flex-row sm:items-start sm:gap-3"
          data-testid="mcp-auth-failure"
          data-code={server.authFailure}
        >
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
            <div className="grid min-w-0 gap-0.5">
              <p className="font-medium">{failure.title}</p>
              <p className="text-muted-foreground">{failure.fix}</p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onEdit}
            data-testid="mcp-auth-failure-test"
            className={cn("shrink-0 bg-background max-sm:w-full", TOUCH)}
          >
            Test sign-in
          </Button>
        </div>
      ) : null}

      <Dialog open={confirmDisconnect} onOpenChange={(o) => !disconnect.isPending && setConfirmDisconnect(o)}>
        <DialogContent data-testid="mcp-org-disconnect-dialog" initialFocus={cancelRef}>
          <DialogHeader>
            <span className="mb-1 flex size-10 items-center justify-center rounded-xl border border-destructive/25 bg-destructive/10 text-destructive shadow-xs">
              <Unplug className="size-5" strokeWidth={1.75} aria-hidden />
            </span>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.body}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              ref={cancelRef}
              variant="outline"
              onClick={() => setConfirmDisconnect(false)}
              disabled={disconnect.isPending}
              className={TOUCH}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void onDisconnect()}
              disabled={disconnect.isPending}
              className={TOUCH}
              data-testid="mcp-org-disconnect-confirm"
            >
              {disconnect.isPending ? <Spinner /> : null}
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
