"use client";

import type { Agent, BrowserActivityItem, BrowserContextRow, BrowserTabView } from "@ocw/contracts";
import { Globe, LockKeyhole, LogIn, MonitorOff, MonitorPlay, RotateCcw, ShieldCheck } from "lucide-react";
import { useMemo } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { isApiError } from "@/lib/api";
import { useBrowserTab } from "@/lib/browser-queries";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { HostChip } from "./host-chip";
import { DOT, TONE } from "./live-header";
import type { LiveBot } from "./live-store";
import { useOptionalLiveView } from "./live-view-provider";

/** 44 px touch targets below `md` (UI-SPEC: every control at 390). */
const TOUCH = "max-md:h-11";
const DAY_MS = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** UI-SPEC § 3.6 times: `HH:mm` today, `yesterday`, `Oct 8` (with the year outside the current one). */
export function activityTime(iso: string, now: number = Date.now()): string {
  const t = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(t.getTime())) / DAY_MS);
  if (days <= 0) {
    return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  }
  if (days === 1) return "yesterday";
  const sameYear = t.getFullYear() === new Date(now).getFullYear();
  return t.toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** "Opened {host}", "You signed in to {host}", "{person} signed in to {host}", "Stopped on {host}". */
export function activityVerb(item: BrowserActivityItem, meId: string | null): string {
  if (item.kind === "opened") return "Opened";
  if (item.kind === "stopped") return "Stopped on";
  return item.actor && item.actor.id === meId
    ? "You signed in to"
    : `${item.actor?.displayName ?? "Someone"} signed in to`;
}

/** The private row's words (UI-SPEC § 3.6): a sign-in in progress, or a page carrying a member's saved sign-in. */
export function privateLabel(row: Pick<BrowserContextRow, "privateFor" | "privateReason">): string {
  return row.privateReason === "member_session" && row.privateFor
    ? `Private browsing for ${row.privateFor}`
    : "Private sign-in in progress";
}

const RUNTIME_LINE: Record<NonNullable<BrowserTabView["runtime"]>, string> = {
  gvisor: "Isolated with gVisor.",
  "hardened-runc": "Hardened container.",
};

/**
 * The bot page's Browser tab (07.8-27; D-06, BRW-02, UI-SPEC § 3.6): the pages the bot has open that the viewer may
 * watch (Open live view opens the live view on that page), private rows for someone else's sign-in without a button,
 * and the host-level activity in conversations the viewer reads, 20 at a time. Everything comes from the API's
 * resolver-filtered view: hosts and conversation names only, never a page's path or address.
 */
export function BrowserTab({ agent }: { agent: Agent }) {
  const q = useBrowserTab(agent.id);
  const me = useMe();
  const live = useOptionalLiveView();
  const bot: LiveBot = useMemo(
    () => ({ id: agent.id, name: agent.name, avatarUrl: agent.avatarUrl }),
    [agent.id, agent.name, agent.avatarUrl],
  );

  let body: React.ReactNode;
  if (q.isPending) {
    body = <BrowserTabSkeleton />;
  } else if (q.isError && !q.data) {
    body =
      isApiError(q.error) && !q.error.isNetwork ? (
        <div className="flex flex-col items-center gap-3 px-6 py-16 text-center text-sm" role="alert">
          <p>Couldn't load browser activity.</p>
          <Button variant="outline" size="sm" onClick={() => void q.refetch()} className={TOUCH}>
            <RotateCcw /> Try again
          </Button>
        </div>
      ) : (
        <ServerUnreachable onRetry={() => void q.refetch()} retrying={q.isFetching} />
      );
  } else {
    const pages = q.data?.pages ?? [];
    const first = pages[0];
    const open = first?.open ?? [];
    const activity = pages.flatMap((p) => p.activity);
    body =
      open.length === 0 && activity.length === 0 ? (
        <BrowserTabEmpty botName={agent.name} />
      ) : (
        <BrowserTabBody
          botName={agent.name}
          open={open}
          activity={activity}
          runtime={first?.runtime ?? null}
          meId={me.data?.user.id ?? null}
          hasMore={q.hasNextPage}
          loadingMore={q.isFetchingNextPage}
          onMore={() => void q.fetchNextPage()}
          onOpenLive={live ? (contextId, trigger) => live.open({ contextId, bot, trigger }) : undefined}
        />
      );
  }

  return (
    <div data-testid="browser-tab" className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
      {body}
    </div>
  );
}

/** The whole tab before the bot ever opened a page the viewer may know of (UI-SPEC § 3.6, States). */
export function BrowserTabEmpty({ botName }: { botName: string }) {
  return (
    <EmptyState
      icon={MonitorPlay}
      title="No browser activity yet"
      description={`When ${botName} opens a page, it shows up here and you can watch it live.`}
    />
  );
}

function BrowserTabSkeleton() {
  return (
    <div
      className="mx-auto grid w-full max-w-3xl gap-10 px-4 py-6 sm:px-6"
      aria-busy
      data-testid="browser-tab-loading"
    >
      {[0, 1].map((section) => (
        <div key={section} className="grid gap-3">
          <Skeleton className="h-4 w-32 motion-reduce:animate-none" />
          <div className="divide-y rounded-xl border bg-card shadow-xs">
            {[0, 1].map((i) => (
              <div key={i} className="flex h-16 items-center gap-3 px-4 sm:px-5">
                <Skeleton className="size-9 rounded-lg motion-reduce:animate-none" />
                <div className="grid flex-1 gap-2">
                  <Skeleton className="h-3.5 w-48 motion-reduce:animate-none" />
                  <Skeleton className="h-3 w-32 motion-reduce:animate-none" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function BrowserTabBody({
  botName,
  open,
  activity,
  runtime,
  meId,
  hasMore,
  loadingMore,
  onMore,
  onOpenLive,
  now,
}: {
  botName: string;
  open: BrowserContextRow[];
  activity: BrowserActivityItem[];
  runtime: BrowserTabView["runtime"];
  meId: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  onMore: () => void;
  onOpenLive?: (contextId: string, trigger: HTMLElement) => void;
  now?: number;
}) {
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-10 px-4 py-6 sm:px-6">
      <section className="grid gap-3" aria-labelledby="browser-open-heading">
        <div>
          <h2 id="browser-open-heading" className="font-semibold text-[15px] tracking-tight">
            Open now
          </h2>
          <p className="mt-0.5 text-muted-foreground text-sm">Pages {botName} has open that you can watch.</p>
        </div>
        {open.length === 0 ? (
          <p
            className="rounded-xl border border-dashed px-4 py-6 text-center text-muted-foreground text-sm"
            data-testid="browser-open-empty"
          >
            Nothing open right now.
          </p>
        ) : (
          <ul
            aria-label="Open now"
            className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs"
            data-testid="browser-open"
          >
            {open.map((row) => (
              <OpenRow key={row.contextId} row={row} now={now} onOpenLive={onOpenLive} />
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-3" aria-labelledby="browser-activity-heading">
        <div>
          <h2 id="browser-activity-heading" className="font-semibold text-[15px] tracking-tight">
            Recent activity
          </h2>
          <p className="mt-0.5 text-muted-foreground text-sm">
            Hosts {botName} opened in conversations you can read. Pages and addresses aren't kept.
          </p>
        </div>
        {activity.length === 0 ? (
          <p className="rounded-xl border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
            No browser activity yet.
          </p>
        ) : (
          <ul
            aria-label="Recent activity"
            className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs"
            data-testid="browser-activity"
          >
            {activity.map((item) => (
              <ActivityRow key={`${item.kind}:${item.at}:${item.host}`} item={item} meId={meId} now={now} />
            ))}
          </ul>
        )}
        {hasMore ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onMore}
            disabled={loadingMore}
            className={cn("w-full justify-self-center sm:w-auto", TOUCH)}
            data-testid="browser-activity-more"
          >
            {loadingMore ? <Spinner /> : null}
            Show more
          </Button>
        ) : null}
        <p className="flex items-start gap-1.5 text-muted-foreground text-xs" data-testid="browser-isolation">
          <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            Runs in its own container, separate from the sandbox.
            {runtime ? ` ${RUNTIME_LINE[runtime]}` : null}
          </span>
        </p>
      </section>
    </div>
  );
}

function RowChip({ row }: { row: BrowserContextRow }) {
  if (row.state === "private") {
    return (
      <span
        data-testid="browser-open-state"
        data-state="private"
        className={cn(
          "inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded-full px-1.5 font-semibold text-xs leading-none",
          TONE.private,
        )}
      >
        <LockKeyhole aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{privateLabel(row)}</span>
      </span>
    );
  }
  const state = row.state === "idle" || row.state === "paused" ? row.state : "live";
  const dot = DOT[state];
  return (
    <span
      data-testid="browser-open-state"
      data-state={state}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 font-semibold text-xs leading-none",
        TONE[state],
      )}
    >
      {dot ? <span aria-hidden className={cn("size-1.5 rounded-full", dot)} /> : null}
      {state === "live" ? "Live" : state === "idle" ? "Idle" : "Paused"}
    </span>
  );
}

export function OpenRow({
  row,
  now,
  onOpenLive,
}: {
  row: BrowserContextRow;
  now?: number;
  onOpenLive?: (contextId: string, trigger: HTMLElement) => void;
}) {
  const watchable = row.state !== "private" && row.viewerCan.watch;
  const hostId = `browser-open-host-${row.contextId}`;
  return (
    <li
      aria-labelledby={hostId}
      className="flex flex-wrap items-center gap-x-3 gap-y-3 px-4 py-3 sm:min-h-16 sm:flex-nowrap sm:px-5"
      data-testid={`browser-open-row-${row.contextId}`}
      data-state={row.state}
    >
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground"
      >
        <Globe className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span id={hostId} className="min-w-0 max-w-full">
            <HostChip host={row.host} secure={row.secure} className="text-sm" testId="browser-open-host" />
          </span>
          <RowChip row={row} />
        </div>
        <p className="mt-1 truncate text-muted-foreground text-xs" data-testid="browser-open-meta">
          {row.conversation.name} · open since {activityTime(row.openedAt, now)}
        </p>
      </div>
      {watchable ? (
        <Button
          variant="outline"
          size="sm"
          onClick={(e) => onOpenLive?.(row.contextId, e.currentTarget)}
          disabled={!onOpenLive}
          aria-label={`Open live view of ${row.host}`}
          className={cn("w-full shrink-0 sm:w-auto", TOUCH)}
          data-testid="browser-open-live"
        >
          <MonitorPlay /> Open live view
        </Button>
      ) : null}
    </li>
  );
}

const ACTIVITY_ICON = { opened: Globe, signed_in: LogIn, stopped: MonitorOff } as const;

export function ActivityRow({
  item,
  meId,
  now,
}: {
  item: BrowserActivityItem;
  meId: string | null;
  now?: number;
}) {
  const Icon = ACTIVITY_ICON[item.kind];
  return (
    <li
      className="flex min-h-12 items-center gap-3 px-4 py-2.5 text-sm sm:px-5"
      data-testid="browser-activity-row"
      data-kind={item.kind}
    >
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1">
        <span>{activityVerb(item, meId)} </span>
        <span className="break-all font-mono text-[13px]">{item.host}</span>
        {/* On phones the conversation takes its own line under the host. */}
        <span className="text-muted-foreground">
          <span className="max-sm:hidden"> · </span>
          <span className="max-sm:block max-sm:text-xs">{item.conversation.name}</span>
        </span>
      </p>
      <time dateTime={item.at} className="shrink-0 text-muted-foreground text-xs tabular-nums">
        {activityTime(item.at, now)}
      </time>
    </li>
  );
}
