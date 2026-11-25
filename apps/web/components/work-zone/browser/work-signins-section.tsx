"use client";

import type { WorkBrowserSignInItem } from "@ocw/contracts";
import { Globe, ShieldCheck } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { monthDay } from "@/components/browser/browser-sessions-section";
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
import { cn } from "@/lib/utils";
import { useRevokeWorkSignIn, useWorkSignIns } from "@/lib/work-browser-queries";

/**
 * Settings › Keychain › Work Zone (07.13-21; D-23; 07.8 UI-SPEC § 4.5 layout and tokens): the sites the member saved a
 * sign-in for in a Work Zone session's browser ("Done, save my sign-in"), from the owner-only list, beside the bots'
 * Browser sessions (a separate list: the two are never shared, D-30). Each row names the site, "Work Zone", when it was
 * saved, last used and expires, and its status; never a username, a cookie or anything sealed. Revoke asks first and
 * then DELETEs; a page using it on the device closes.
 */

/** 44 px touch targets below `md` (every control at 390). */
const TOUCH = "max-md:h-11";

export const WORK_SIGNINS_EMPTY =
  "No Work Zone sign-ins yet. When an agent asks you to sign in to a site in a Work Zone session, you can save it here.";

/** The row's three dates (UI-SPEC § 4.5 Row, in D-23's words). */
export function workSignInLines(
  item: WorkBrowserSignInItem,
  now: number = Date.now(),
): { saved: string; used: string; expires: string } {
  return {
    saved: `Saved ${monthDay(item.createdAt, now)}`,
    used: `Last used ${item.lastUsedAt ? monthDay(item.lastUsedAt, now) : "never"}`,
    expires: `Expires ${monthDay(item.expiresAt, now)}`,
  };
}

/** The revoke confirmation's words. */
export function revokeWorkSignInWords(site: string): { title: string; body: string } {
  return {
    title: `Revoke your sign-in to ${site}?`,
    body: `A page using it closes. This doesn't sign you out at ${site}: to end the session there, sign out on the site or change your password.`,
  };
}

export function WorkSignInRow({
  item,
  now,
  onRevoke,
}: {
  item: WorkBrowserSignInItem;
  now?: number;
  onRevoke: () => void;
}) {
  const lines = workSignInLines(item, now);
  const expired = item.status === "expired";
  const siteId = `work-signin-site-${item.id}`;
  return (
    <li
      aria-labelledby={siteId}
      className="flex flex-wrap items-start gap-x-3 gap-y-3 px-4 py-3 sm:flex-nowrap sm:items-center sm:px-5"
      data-testid={`work-signin-row-${item.id}`}
      data-status={item.status}
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
          <span className="text-muted-foreground text-xs" data-testid="work-signin-row-scope">
            Work Zone
          </span>
          <Badge
            variant={expired ? "outline" : "secondary"}
            data-testid="work-signin-row-status"
            className={cn(!expired && "text-emerald-800 dark:text-emerald-300")}
          >
            {expired ? "Expired" : "Active"}
          </Badge>
        </div>
        {/* Inline text: when the line wraps, a segment moves down whole (the separator never dangles). */}
        <p className="mt-1 text-muted-foreground text-xs leading-5" data-testid="work-signin-row-meta">
          {lines.saved}{" "}
          <span className="whitespace-nowrap">
            {"· "}
            {lines.used}
          </span>{" "}
          <span className="whitespace-nowrap">
            {"· "}
            {lines.expires}
          </span>
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onRevoke}
        aria-label={`Revoke your ${item.site} sign-in`}
        className={cn("w-full shrink-0 sm:w-auto", TOUCH)}
        data-testid="work-signin-revoke"
      >
        Revoke
      </Button>
    </li>
  );
}

/** The list, or its empty state (static-renderable). */
export function WorkSignInsList({
  items,
  now,
  onRevoke,
}: {
  items: readonly WorkBrowserSignInItem[];
  now?: number;
  onRevoke: (item: WorkBrowserSignInItem) => void;
}) {
  if (items.length === 0) {
    return (
      <p
        className="rounded-xl border border-dashed px-4 py-6 text-center text-muted-foreground text-sm"
        data-testid="work-signins-empty"
      >
        {WORK_SIGNINS_EMPTY}
      </p>
    );
  }
  return (
    <ul
      aria-label="Work Zone sign-ins"
      className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs"
      data-testid="work-signins-list"
    >
      {items.map((item) => (
        <WorkSignInRow key={item.id} item={item} now={now} onRevoke={() => onRevoke(item)} />
      ))}
    </ul>
  );
}

/** Shown while the Work Zone is on for the member, or while they still have sign-ins to revoke. */
export function WorkSignInsSection() {
  const workZone = useModule("work_zone");
  const q = useWorkSignIns();
  const [toRevoke, setToRevoke] = useState<WorkBrowserSignInItem | null>(null);
  const items = q.data?.items ?? [];
  if (workZone === "off" && items.length === 0) return null;

  let body: React.ReactNode;
  if (q.isPending) {
    body = (
      <div
        className="divide-y rounded-xl border bg-card shadow-xs"
        aria-busy
        data-testid="work-signins-loading"
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
  } else if (q.isError) {
    body = (
      <div className="rounded-xl border bg-card">
        {isApiError(q.error) && !q.error.isNetwork ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center text-sm" role="alert">
            <p>Couldn't load your Work Zone sign-ins.</p>
            <Button variant="outline" size="sm" onClick={() => q.refetch()} className={TOUCH}>
              Try again
            </Button>
          </div>
        ) : (
          <ServerUnreachable onRetry={() => q.refetch()} retrying={q.isFetching} />
        )}
      </div>
    );
  } else {
    body = <WorkSignInsList items={items} onRevoke={setToRevoke} />;
  }

  return (
    <section
      id="work-zone-signins"
      className="grid scroll-mt-6 gap-3"
      aria-labelledby="work-zone-signins-heading"
      data-testid="work-zone-signins"
    >
      <div className="min-w-0">
        <h2 id="work-zone-signins-heading" className="font-semibold text-[15px] tracking-tight">
          Work Zone
        </h2>
        <p className="mt-0.5 text-muted-foreground text-sm">
          Sites you signed in to in a Work Zone session's browser. The agent uses them on the device that runs
          the session, in your own turns only, and only in sessions only you (and that device's owner) can
          see.
        </p>
      </div>
      {body}
      <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
        <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
        Saved sign-ins are encrypted on the server and never shared with bots. Revoking one doesn't sign you
        out at the site.
      </p>
      <RevokeWorkSignInDialog item={toRevoke} onDone={() => setToRevoke(null)} />
    </section>
  );
}

function RevokeWorkSignInDialog({
  item,
  onDone,
}: {
  item: WorkBrowserSignInItem | null;
  onDone: () => void;
}) {
  const revoke = useRevokeWorkSignIn();
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
  const words = item ? revokeWorkSignInWords(item.site) : null;
  return (
    <Dialog open={item !== null} onOpenChange={(o) => !o && !revoke.isPending && onDone()}>
      <DialogContent data-testid="work-signin-revoke-dialog" initialFocus={cancelRef}>
        {words ? (
          <>
            <DialogHeader>
              <DialogTitle>{words.title}</DialogTitle>
              <DialogDescription>{words.body}</DialogDescription>
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
                data-testid="work-signin-revoke-confirm"
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
