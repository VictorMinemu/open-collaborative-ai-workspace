"use client";

import type { ClientKind, SessionInfo } from "@ocw/contracts";
import { Globe, LogOut, type LucideIcon, Monitor, Smartphone } from "lucide-react";
import { useState } from "react";
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
import { useRevokeOtherSessions, useRevokeSession, useSessions } from "@/lib/account-queries";
import { errorMessage } from "@/lib/api";
import { cn, formatDate, relativeTime } from "@/lib/utils";

const KIND: Record<ClientKind, { label: string; icon: LucideIcon }> = {
  web: { label: "Web browser", icon: Globe },
  desktop: { label: "Desktop app", icon: Monitor },
  mobile: { label: "Mobile app", icon: Smartphone },
  agent: { label: "Agent", icon: Globe },
  system: { label: "System", icon: Globe },
};

const sessionName = (s: SessionInfo) => s.clientLabel ?? "Unknown device";

type Confirm = { kind: "one"; session: SessionInfo } | { kind: "others"; count: number } | null;

/** The caller's sessions (AUTH-05): this device first, then the most recently active. */
export function SessionsList() {
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();
  const [confirm, setConfirm] = useState<Confirm>(null);

  const list = [...(sessions.data ?? [])].sort(
    (a, b) => Number(b.current) - Number(a.current) || b.lastActiveAt.localeCompare(a.lastActiveAt),
  );
  const others = list.filter((s) => !s.current).length;

  async function onConfirm() {
    if (!confirm) return;
    try {
      if (confirm.kind === "one") {
        await revoke.mutateAsync(confirm.session.id);
        toast.success(`Signed out ${sessionName(confirm.session)}`);
      } else {
        await revokeOthers.mutateAsync();
        toast.success("Signed out everywhere else");
      }
      setConfirm(null);
    } catch (err) {
      toast.error("Could not sign out that session", { description: errorMessage(err) });
    }
  }

  const pending = revoke.isPending || revokeOthers.isPending;

  return (
    <section className="grid gap-3" data-testid="sessions">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-semibold text-[15px] tracking-tight">
            Active sessions
            {sessions.data ? (
              <span className="rounded-full bg-muted px-1.5 py-0.5 font-medium text-[11px] text-muted-foreground tabular-nums">
                {list.length}
              </span>
            ) : null}
          </h2>
          <p className="mt-0.5 text-muted-foreground text-sm">
            Browsers and apps signed in to your account. Sign out any you don't recognise.
          </p>
        </div>
        {others > 0 ? (
          <Button
            variant="outline"
            size="sm"
            data-testid="sign-out-others"
            onClick={() => setConfirm({ kind: "others", count: others })}
          >
            <LogOut /> Sign out everywhere else
          </Button>
        ) : null}
      </div>

      {sessions.isPending ? (
        <SessionsSkeleton />
      ) : sessions.isError ? (
        <div className="rounded-xl border bg-card">
          <ServerUnreachable
            onRetry={() => sessions.refetch()}
            retrying={sessions.isFetching}
            className="py-6"
          />
        </div>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
          {list.map((s) => (
            <SessionRow key={s.id} session={s} onRevoke={() => setConfirm({ kind: "one", session: s })} />
          ))}
        </ul>
      )}

      <Dialog open={confirm !== null} onOpenChange={(open) => (!open && !pending ? setConfirm(null) : null)}>
        <DialogContent data-testid="confirm-sign-out">
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === "others" ? "Sign out everywhere else?" : "Sign out this session?"}
            </DialogTitle>
            <DialogDescription>
              {confirm?.kind === "one"
                ? `${sessionName(confirm.session)} will be signed out right away and will need your password to come back.`
                : confirm?.kind === "others"
                  ? `${confirm.count} other ${confirm.count === 1 ? "session" : "sessions"} will be signed out right away. You stay signed in here.`
                  : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              data-testid="confirm-sign-out-submit"
              disabled={pending}
              onClick={onConfirm}
            >
              {pending ? <Spinner /> : <LogOut />}
              Sign out
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function SessionRow({ session, onRevoke }: { session: SessionInfo; onRevoke: () => void }) {
  const kind = KIND[session.clientKind];
  const Icon = kind.icon;
  const name = sessionName(session);
  // "Desktop app on macOS" already says what it is; "Chrome on macOS" gets "Web browser".
  const showKind = !name.startsWith(kind.label);
  const details = [
    showKind ? kind.label : null,
    session.ipAddress,
    session.current ? "Active now" : `Active ${relativeTime(session.lastActiveAt)}`,
  ].filter(Boolean);

  return (
    <li
      data-testid="session-row"
      data-kind={session.clientKind}
      data-current={session.current || undefined}
      className="flex items-center gap-3 px-4 py-3.5"
    >
      <span
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-lg border",
          session.current
            ? "border-primary/20 bg-primary/10 text-primary"
            : "bg-muted/60 text-muted-foreground",
        )}
        aria-hidden
      >
        <Icon className="size-[18px]" strokeWidth={1.8} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-medium text-sm">{name}</span>
          {session.current ? (
            <Badge variant="success" data-testid="session-current">
              This device
            </Badge>
          ) : null}
        </div>
        <div className="mt-0.5 text-muted-foreground text-xs">
          <span className="break-words">{details.join(" · ")}</span>
          <span className="hidden sm:inline"> · Signed in {formatDate(session.createdAt)}</span>
        </div>
      </div>
      {session.current ? null : (
        <Button
          variant="ghost"
          size="sm"
          data-testid="session-revoke"
          aria-label={`Sign out ${name}`}
          onClick={onRevoke}
          className="h-10 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:h-8"
        >
          Revoke
        </Button>
      )}
    </li>
  );
}

function SessionsSkeleton() {
  return (
    <div className="divide-y overflow-hidden rounded-xl border bg-card" aria-busy>
      {[0, 1].map((i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3.5">
          <Skeleton className="size-10 rounded-lg" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
