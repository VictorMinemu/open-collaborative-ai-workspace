"use client";

import { Menu } from "@base-ui/react/menu";
import type { Permission, WorkSession } from "@ocw/contracts";
import {
  Archive,
  ArrowLeft,
  FileDiff,
  FolderGit2,
  GitBranch,
  ListOrdered,
  Lock,
  MoreHorizontal,
  SearchX,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/empty-state";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { PresenceStack, usePresentPeople } from "@/components/presence/presence-stack";
import { PageHeader } from "@/components/shell/page-header";
import { UserAvatar } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { errorMessage, isApiError } from "@/lib/api";
import { useMe, useMembers } from "@/lib/queries";
import { type LiveSession, useLiveSession } from "@/lib/use-live-session";
import { cn } from "@/lib/utils";
import { useArchiveSession, useDevices } from "@/lib/workzone-queries";
import { ApprovalBanner } from "./approval-banner";
import { ChangesPanel } from "./changes-panel";
import { Composer } from "./composer";
import { EventStream } from "./event-stream";
import { OnlineDot, PERMISSION_MODES, RUNTIMES, RuntimeLogo, StatusChip, StatusDot } from "./meta";
import { QueuePanel } from "./queue-panel";

type PanelTab = "queue" | "changes";

export function SessionView({ id }: { id: string }) {
  const { state, query, revoked, lostTitle } = useLiveSession(id);

  // RT-01: the server dropped the live stream because access was lost (role, rule or device change).
  if (revoked) {
    return (
      <div className="flex min-w-0 flex-1 flex-col" data-testid="session-access-lost">
        <PageHeader
          title={<span className="text-muted-foreground">{lostTitle ?? "Session"}</span>}
          icon={<Lock />}
        />
        <EmptyState
          icon={Lock}
          title="You no longer have access to this session"
          description="Your role or permissions changed. Ask an admin if you need it back."
        >
          <Link href="/work-zone" className={buttonVariants()}>
            <ArrowLeft /> Back to Work Zone
          </Link>
        </EmptyState>
      </div>
    );
  }

  if (query.isError) {
    if (isApiError(query.error, 404)) {
      return (
        <EmptyState
          icon={SearchX}
          title="Session not found"
          description="It may have been archived or you lost access."
        >
          <Link href="/work-zone" className={buttonVariants({ variant: "outline" })}>
            <ArrowLeft /> Back to Work Zone
          </Link>
        </EmptyState>
      );
    }
    return (
      <div className="flex flex-1 items-center justify-center">
        <ServerUnreachable onRetry={() => query.refetch()} retrying={query.isFetching} />
      </div>
    );
  }
  if (!state) return <SessionSkeleton />;
  return <LoadedSession state={state} viewerCan={query.data?.viewerCan ?? []} />;
}

function SessionSkeleton() {
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex h-16 items-center gap-3 border-b px-6">
        <Skeleton className="h-5 w-64" />
      </div>
      <div className="mx-auto grid w-full max-w-3xl gap-4 p-6">
        <Skeleton className="h-16" />
        <Skeleton className="h-24" />
        <Skeleton className="h-10" />
      </div>
    </div>
  );
}

function LoadedSession({ state, viewerCan }: { state: LiveSession; viewerCan: readonly Permission[] }) {
  const session = state.session;
  const devices = useDevices();
  const [tab, setTab] = useState<PanelTab>("queue");
  const [sheet, setSheet] = useState<PanelTab | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const pending = state.approvals.filter((a) => a.status === "pending");
  const queued = state.prompts.filter((p) => p.status === "queued").length;
  const changesCount = state.changes?.files.length ?? 0;

  const device = devices.data?.find((d) => d.id === session.deviceId);
  // Decided by the API resolver (creator, device owner or admin, minus Tool and Device layer denials).
  const canDecide = viewerCan.includes("work_session.approve");
  const deciderHint = `Waiting for ${session.createdByName ?? "the session owner"}${
    device?.ownerName && device.ownerUserId !== session.createdBy ? ` or ${device.ownerName}` : ""
  } to decide.`;

  // Follow the stream while the user is at the bottom.
  const contentSize = state.events.length + Object.values(state.streaming).join("").length + pending.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the content grows
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [contentSize]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="session-view" data-status={session.status}>
      <SessionHeader
        session={session}
        state={state}
        onPanel={(t) => setSheet(t)}
        queued={queued}
        changesCount={changesCount}
        canArchive={viewerCan.includes("work_session.archive")}
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget;
              pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
            className="scrollbar-thin min-h-0 flex-1 overflow-y-auto"
          >
            <EventStream state={state} session={session} />
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 border-t pt-3">
            {pending[0] ? (
              <ApprovalBanner
                sessionId={session.id}
                approval={pending[0]}
                pendingCount={pending.length}
                canDecide={canDecide}
                agentLabel={RUNTIMES[session.runtime].label}
                deciderHint={deciderHint}
              />
            ) : null}
            <Composer
              session={session}
              queued={queued}
              canConfigure={viewerCan.includes("work_session.configure")}
            />
          </div>
        </div>
        <aside className="hidden w-[380px] shrink-0 flex-col border-l bg-sidebar/30 xl:flex">
          <PanelTabs tab={tab} onTab={setTab} queued={queued} changesCount={changesCount} />
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
            {tab === "queue" ? (
              <QueuePanel sessionId={session.id} prompts={state.prompts} />
            ) : (
              <ChangesPanel sessionId={session.id} live={state.changes} deviceOnline={session.deviceOnline} />
            )}
          </div>
        </aside>
      </div>
      <Sheet open={sheet !== null} onOpenChange={(o) => !o && setSheet(null)}>
        <SheetContent side="right" className="w-[30rem] max-w-[100vw]">
          <SheetTitle className="sr-only">{sheet === "changes" ? "Changes" : "Queue"}</SheetTitle>
          <PanelTabs
            tab={sheet ?? "queue"}
            onTab={(t) => setSheet(t)}
            queued={queued}
            changesCount={changesCount}
            className="pr-12"
          />
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
            {sheet === "changes" ? (
              <ChangesPanel sessionId={session.id} live={state.changes} deviceOnline={session.deviceOnline} />
            ) : (
              <QueuePanel sessionId={session.id} prompts={state.prompts} />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function PanelTabs({
  tab,
  onTab,
  queued,
  changesCount,
  className,
}: {
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  queued: number;
  changesCount: number;
  className?: string;
}) {
  const item = (t: PanelTab, label: string, icon: ReactNode, count: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === t}
      data-testid={`tab-${t}`}
      onClick={() => onTab(t)}
      className={cn(
        "relative flex h-12 items-center gap-1.5 px-1 font-medium text-[13px] transition-colors [&_svg]:size-4",
        tab === t ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
      {count > 0 ? (
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums">{count}</span>
      ) : null}
      {tab === t ? <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-primary" /> : null}
    </button>
  );
  return (
    <div role="tablist" className={cn("flex shrink-0 gap-5 border-b px-4", className)}>
      {item("queue", "Queue", <ListOrdered />, queued)}
      {item("changes", "Changes", <FileDiff />, changesCount)}
    </div>
  );
}

function SessionHeader({
  session,
  state,
  onPanel,
  queued,
  changesCount,
  canArchive,
}: {
  session: WorkSession;
  state: LiveSession;
  onPanel: (t: PanelTab) => void;
  queued: number;
  changesCount: number;
  canArchive: boolean;
}) {
  const router = useRouter();
  const archive = useArchiveSession(session.id);
  const participants = useMemo(() => {
    const m = new Map<string, string>();
    m.set(session.createdBy, session.createdByName ?? "Owner");
    for (const p of state.prompts) m.set(p.authorUserId, p.authorName ?? "Member");
    return m;
  }, [session.createdBy, session.createdByName, state.prompts]);
  // Who is watching this session right now (RT-04, D-01, D-08; PRD §25). `use-live-session` subscribes to
  // `ws:<id>` with `presence: true`; names come from the participants, then the org directory.
  const me = useMe({ enabled: false }).data?.user.id;
  const directory = useMembers();
  const resolve = useCallback(
    (userId: string) => {
      const m = directory.data?.members.find((x) => x.userId === userId);
      const name = participants.get(userId) ?? m?.displayName;
      return name ? { name, avatarUrl: m?.avatarUrl ?? null } : undefined;
    },
    [participants, directory.data],
  );
  const viewers = usePresentPeople(`ws:${session.id}`, { excludeUserId: me, resolve });
  const absent = useMemo(() => {
    const here = new Set(viewers.map((v) => v.userId));
    return [...participants.entries()]
      .filter(([uid]) => uid !== me && !here.has(uid))
      .map(([uid, name]) => ({
        uid,
        name,
        avatarUrl: directory.data?.members.find((x) => x.userId === uid)?.avatarUrl ?? null,
      }));
  }, [participants, viewers, me, directory.data]);
  const mode = PERMISSION_MODES.find((m) => m.value === session.permissionMode);

  useEffect(() => {
    document.title = `${session.title} · Work Zone`;
  }, [session.title]);

  return (
    <header
      className="flex shrink-0 items-start gap-3 border-b px-4 py-3 sm:px-6"
      data-testid="session-header"
    >
      <RuntimeLogo runtime={session.runtime} className="mt-0.5 hidden size-9 rounded-xl sm:inline-flex" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot status={session.status} className="sm:hidden" />
          <h1
            className="line-clamp-2 font-semibold text-[15px] leading-snug tracking-tight sm:truncate"
            data-testid="session-title"
          >
            {session.title}
          </h1>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
          <span className="inline-flex items-center gap-1">
            <FolderGit2 className="size-3.5" /> {session.projectName}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <OnlineDot online={session.deviceOnline} className="size-1.5" /> {session.deviceName}
          </span>
          <span className="inline-flex items-center gap-1">
            <RuntimeLogo runtime={session.runtime} className="size-3.5 rounded-[4px] sm:hidden" />
            {RUNTIMES[session.runtime].label}
            {session.model ? ` · ${session.model}` : ""}
          </span>
          {session.branch ? (
            <span className="inline-flex max-w-48 items-center gap-1 font-mono">
              <GitBranch className="size-3.5 shrink-0" />
              <span className="truncate">{session.branch}</span>
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1">
            <ShieldCheck className="size-3.5" /> {mode?.label ?? session.permissionMode}
          </span>
        </div>
        {session.lastError && (session.status === "failed" || session.status === "idle") ? (
          <p className="mt-1.5 line-clamp-2 text-destructive text-xs">{session.lastError}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <div className="flex items-center" data-testid="session-viewers">
          <PresenceStack
            people={viewers}
            max={4}
            label={`${viewers.length} watching now`}
            className="-mx-1"
          />
          {absent.length > 0 ? (
            <div role="group" className="ml-1 hidden -space-x-1.5 md:flex" aria-label="Participants not here">
              {absent.slice(0, 3).map((p) => (
                <Tooltip key={p.uid} content={`${p.name} · not here`}>
                  <span data-testid="session-participant-absent" data-user-id={p.uid}>
                    <UserAvatar
                      name={p.name}
                      src={p.avatarUrl}
                      seed={p.uid}
                      className="size-6 opacity-50 ring-2 ring-background grayscale"
                    />
                  </span>
                </Tooltip>
              ))}
            </div>
          ) : null}
        </div>
        <StatusChip status={session.status} className="hidden sm:inline-flex" />
        <div className="flex items-center gap-1 xl:hidden">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onPanel("queue")}
            aria-label="Queue"
            data-testid="open-queue"
          >
            <ListOrdered />
            <span className="hidden sm:inline">Queue</span>
            {queued > 0 ? <span className="tabular-nums">{queued}</span> : null}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onPanel("changes")}
            aria-label="Changes"
            data-testid="open-changes"
          >
            <FileDiff />
            <span className="hidden sm:inline">Changes</span>
            {changesCount > 0 ? <span className="tabular-nums">{changesCount}</span> : null}
          </Button>
        </div>
        <Menu.Root>
          <Menu.Trigger render={<Button size="icon-sm" variant="ghost" aria-label="Session actions" />}>
            <MoreHorizontal />
          </Menu.Trigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={session.status === "archived" || !canArchive}
              onClick={() =>
                archive.mutate(undefined, {
                  onSuccess: () => {
                    toast.success("Session archived");
                    router.push("/work-zone");
                  },
                  onError: (err) => toast.error(errorMessage(err)),
                })
              }
            >
              <Archive /> Archive session
            </DropdownMenuItem>
          </DropdownMenuContent>
        </Menu.Root>
      </div>
    </header>
  );
}
