"use client";

import type { BrowserSessionItem } from "@ocw/contracts";
import { Globe, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { useModule } from "@/components/shell/module-gate";
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
import { errorMessage, isApiError } from "@/lib/api";
import { useBrowserSessions, useRevokeBrowserSession } from "@/lib/browser-queries";
import { connectionDate } from "@/lib/connections-format";
import { cn, relativeTime } from "@/lib/utils";

/** 44 px touch targets below `md` (UI-SPEC: every control at 390). */
const TOUCH = "max-md:h-11";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Under this, the expiry reads "expires in {n} days" in amber with the warning glyph (UI-SPEC § 4.5). */
const SOON_MS = 3 * DAY_MS;

/** "Nov 13", or "Nov 13, 2027" outside the current year (an expiry is in the future, so never "today"). */
export function monthDay(iso: string, now: number = Date.now()): string {
  const t = new Date(iso);
  const sameYear = t.getFullYear() === new Date(now).getFullYear();
  return t.toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export interface SessionLines {
  /** "Signed in Oct 14 · last used 5 minutes ago" (or "never used"); null for an expired row. */
  used: string | null;
  /** "expires Nov 13" or, under 3 days, "expires in 2 days" (`soon`); null for an expired row. */
  expires: { text: string; soon: boolean } | null;
  /** "Sign in again when a bot asks." for an expired row. */
  expired: string | null;
}

/** The meta line of a saved sign-in (UI-SPEC § 4.5 Row, Expiring, Expired). Dates and the bot only, never a value. */
export function sessionLines(item: BrowserSessionItem, now: number = Date.now()): SessionLines {
  const left = Date.parse(item.expiresAt) - now;
  if (item.status === "expired" || left <= 0) {
    return { used: null, expires: null, expired: "Sign in again when a bot asks." };
  }
  const used = `Signed in ${connectionDate(item.createdAt, now)} · ${
    item.lastUsedAt ? `last used ${relativeTime(item.lastUsedAt, now)}` : "never used"
  }`;
  if (left >= SOON_MS)
    return {
      used,
      expires: { text: `expires ${monthDay(item.expiresAt, now)}`, soon: false },
      expired: null,
    };
  if (left < DAY_MS) {
    const hours = Math.max(1, Math.round(left / HOUR_MS));
    return {
      used,
      expires: { text: `expires in ${hours} ${hours === 1 ? "hour" : "hours"}`, soon: true },
      expired: null,
    };
  }
  const days = Math.max(1, Math.round(left / DAY_MS));
  return {
    used,
    expires: { text: `expires in ${days} ${days === 1 ? "day" : "days"}`, soon: true },
    expired: null,
  };
}

/**
 * Settings › Keychain › Browser sessions (07.8-27; D-08, BRW-04, R7, U-3, U-13, UI-SPEC § 4.5): the sites the member
 * signed in to through a bot's browser, from the owner-only list (nobody else's row ever reaches this page, admins
 * included). Each row names the site, the bot it was made with and its dates; never a username, an account name, a
 * cookie or anything sealed. Revoke asks first and says it does not sign the member out at the site; an expired row
 * offers Remove. Shown while the Browser module is on for the member, or while they still have sign-ins to manage.
 */
export function BrowserSessionsSection() {
  const browser = useModule("browser");
  const q = useBrowserSessions();
  const [toRevoke, setToRevoke] = useState<BrowserSessionItem | null>(null);
  const remove = useRevokeBrowserSession();
  const items = q.data?.items ?? [];
  if (browser === "off" && items.length === 0) return null;

  async function removeExpired(item: BrowserSessionItem) {
    try {
      await remove.mutateAsync(item.id);
      toast.success(`${item.site} sign-in removed`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  let body: React.ReactNode;
  if (q.isPending) {
    body = <SessionSkeleton />;
  } else if (q.isError) {
    body = (
      <div className="rounded-xl border bg-card">
        {isApiError(q.error) && !q.error.isNetwork ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center text-sm" role="alert">
            <p>Couldn't load your browser sessions.</p>
            <Button variant="outline" size="sm" onClick={() => q.refetch()} className={TOUCH}>
              Try again
            </Button>
          </div>
        ) : (
          <ServerUnreachable onRetry={() => q.refetch()} retrying={q.isFetching} />
        )}
      </div>
    );
  } else if (items.length === 0) {
    body = (
      <p
        className="rounded-xl border border-dashed px-4 py-6 text-center text-muted-foreground text-sm"
        data-testid="browser-sessions-empty"
      >
        No saved sign-ins. When a bot asks you to sign in to a site, the sign-in is kept here so you can
        revoke it.
      </p>
    );
  } else {
    body = (
      <ul
        aria-label="Browser sessions"
        className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs"
        data-testid="browser-sessions-list"
      >
        {items.map((item) => (
          <SessionRow
            key={item.id}
            item={item}
            removing={remove.isPending && remove.variables === item.id}
            onRevoke={() => setToRevoke(item)}
            onRemove={() => void removeExpired(item)}
          />
        ))}
      </ul>
    );
  }

  return (
    <section
      id="browser-sessions"
      className="grid scroll-mt-6 gap-3"
      aria-labelledby="browser-sessions-heading"
      data-testid="browser-sessions"
    >
      <div className="min-w-0">
        <h2 id="browser-sessions-heading" className="font-semibold text-[15px] tracking-tight">
          Browser sessions
        </h2>
        <p className="mt-0.5 text-muted-foreground text-sm">
          Sites you signed in to through a bot's browser. Only your private chats use them, and bots never see
          the passwords.
        </p>
      </div>
      {body}
      <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
        <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
        Saved sign-ins are encrypted on the server and used only for your turns. Revoking one doesn't sign you
        out at the site.
      </p>
      <RevokeDialog item={toRevoke} onDone={() => setToRevoke(null)} />
    </section>
  );
}

function SessionSkeleton() {
  return (
    <div
      className="divide-y rounded-xl border bg-card shadow-xs"
      aria-busy
      data-testid="browser-sessions-loading"
    >
      {[0, 1].map((i) => (
        <div key={i} className="flex h-16 items-center gap-3 px-4 sm:px-5">
          <Skeleton className="size-9 rounded-lg motion-reduce:animate-none" />
          <div className="grid flex-1 gap-2">
            <Skeleton className="h-3.5 w-44 motion-reduce:animate-none" />
            <Skeleton className="h-3 w-64 max-w-full motion-reduce:animate-none" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SessionRow({
  item,
  removing = false,
  now,
  onRevoke,
  onRemove,
}: {
  item: BrowserSessionItem;
  removing?: boolean;
  now?: number;
  onRevoke: () => void;
  onRemove: () => void;
}) {
  const lines = sessionLines(item, now);
  const expired = lines.expired !== null;
  const siteId = `browser-session-site-${item.id}`;
  return (
    <li
      aria-labelledby={siteId}
      className="flex flex-wrap items-start gap-x-3 gap-y-3 px-4 py-3 sm:flex-nowrap sm:items-center sm:px-5"
      data-testid={`browser-session-row-${item.id}`}
      data-status={expired ? "expired" : "active"}
    >
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground"
      >
        <Globe className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span id={siteId} className="min-w-0 truncate font-mono font-semibold text-sm" title={item.site}>
            {item.site}
          </span>
          <span className="text-muted-foreground text-xs" data-testid="browser-session-bot">
            with {item.agentName}
          </span>
          {expired ? <Badge variant="outline">Expired</Badge> : null}
        </div>
        {/* Inline text: when the line wraps, "· expires …" moves down whole (the separator never dangles). */}
        <p className="mt-1 text-muted-foreground text-xs leading-5" data-testid="browser-session-meta">
          {expired ? (
            lines.expired
          ) : (
            <>
              {lines.used}{" "}
              <span className="whitespace-nowrap">
                {"· "}
                <span
                  data-testid="browser-session-expiry"
                  data-soon={lines.expires?.soon ? "true" : undefined}
                  className={cn(lines.expires?.soon && "text-amber-700 dark:text-amber-300")}
                >
                  {lines.expires?.soon ? (
                    <TriangleAlert aria-hidden className="mr-1 inline size-3 align-[-2px]" />
                  ) : null}
                  {lines.expires?.text}
                </span>
              </span>
            </>
          )}
        </p>
      </div>
      {expired ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          disabled={removing}
          aria-label={`Remove your ${item.site} sign-in`}
          className={cn("w-full shrink-0 sm:w-auto", TOUCH)}
          data-testid="browser-session-remove"
        >
          {removing ? <Spinner /> : <Trash2 />}
          Remove
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={onRevoke}
          aria-label={`Revoke your ${item.site} sign-in`}
          className={cn("w-full shrink-0 sm:w-auto", TOUCH)}
          data-testid="browser-session-revoke"
        >
          Revoke
        </Button>
      )}
    </li>
  );
}

function RevokeDialog({ item, onDone }: { item: BrowserSessionItem | null; onDone: () => void }) {
  const revoke = useRevokeBrowserSession();
  const cancelRef = useRef<HTMLButtonElement>(null);
  async function confirm() {
    if (!item) return;
    try {
      await revoke.mutateAsync(item.id);
      toast.success(`${item.site} sign-in revoked`);
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }
  return (
    <Dialog open={item !== null} onOpenChange={(o) => !o && !revoke.isPending && onDone()}>
      <DialogContent data-testid="browser-session-revoke-dialog" initialFocus={cancelRef}>
        {item ? (
          <>
            <DialogHeader>
              <DialogTitle>Revoke your {item.site} sign-in?</DialogTitle>
              <DialogDescription>
                {item.agentName} can't use it any more. This doesn't sign you out at {item.site}: to end the
                session there, sign out on the site or change your password.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                ref={cancelRef}
                variant="outline"
                onClick={onDone}
                disabled={revoke.isPending}
                className={TOUCH}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => void confirm()}
                disabled={revoke.isPending}
                className={TOUCH}
                data-testid="browser-session-revoke-confirm"
              >
                {revoke.isPending ? <Spinner /> : null}
                Revoke
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
