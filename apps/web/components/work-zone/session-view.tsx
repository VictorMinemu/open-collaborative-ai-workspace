"use client";

import { Menu } from "@base-ui/react/menu";
import {
  type Permission,
  WORK_PROMPT_MAX_IMAGES,
  type WorkSession,
  type WorkSessionChanges,
} from "@ocw/contracts";
import {
  Archive,
  ArrowLeft,
  FileDiff,
  Info,
  ListOrdered,
  Lock,
  MoreHorizontal,
  SearchX,
  SquareArrowOutUpRight,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { DropZone } from "@/components/chat/attachments/drop-zone";
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
import { useMediaQuery } from "@/hooks/use-media-query";
import { useToastClearance } from "@/hooks/use-toast-clearance";
import { errorMessage, isApiError } from "@/lib/api";
import { useAttachmentsConfig } from "@/lib/attachment-queries";
import { useMe, useMembers } from "@/lib/queries";
import { type LiveSession, useLiveSession } from "@/lib/use-live-session";
import { cn } from "@/lib/utils";
import { useArchiveSession, useDevices, useDiff, useWorkSessions } from "@/lib/workzone-queries";
import { AgentBar } from "./agent-bar";
import { ApprovalBanner } from "./approval-banner";
import { ChangesCard } from "./changes-card";
import { ChangesPanel } from "./changes-panel";
import { Composer, type ComposerApi } from "./composer";
import { EventStream } from "./event-stream";
import { FullAccessBadge } from "./full-access-badge";
import { RUNTIMES, StatusChip, StatusDot } from "./meta";
import { QueuePanel } from "./queue-panel";
import { SessionFooter } from "./session-footer";
import { projectInitials } from "./session-sidebar";
import { VisibilityChip } from "./visibility/visibility-chip";

type PanelTab = "queue" | "changes";

/**
 * The live view's words after access was lost: taken away by a change of who can see it (`visibility`, 07.9 R7), the
 * owner to ask; any other cause (role, rule, device, module) keeps the words it always had.
 */
export function accessLostCopy(
  cause: string | null,
  ownerName: string | null,
): { title: string; description: string } {
  if (cause === "visibility") {
    return {
      title: "You can no longer see this session",
      description: `Who can see it changed. Ask ${ownerName ?? "the owner"} if you need it back.`,
    };
  }
  return {
    title: "You no longer have access to this session",
    description: "Your role or permissions changed. Ask an admin if you need it back.",
  };
}

/** The composer's place for a creator who left the session's project (D-12). */
export function leftProjectLine(projectName: string): string {
  return `You left ${projectName}. You can still read and archive this session.`;
}

export function SessionView({ id }: { id: string }) {
  // A session given back after it was taken away (Undo of a narrowing) is opened again on a fresh live view.
  const [epoch, setEpoch] = useState(0);
  return <LiveSessionView key={epoch} id={id} onReopen={() => setEpoch((n) => n + 1)} />;
}

function LiveSessionView({ id, onReopen }: { id: string; onReopen: () => void }) {
  const { state, query, revoked, lostTitle, lostCause } = useLiveSession(id);
  // The owner's name outlives the cached detail, for "Ask {owner} if you need it back" (07.9-10, R7).
  const owner = useRef<string | null>(null);
  if (state) owner.current = state.session.createdByName;

  // RT-01: the server dropped the live stream because access was lost (role, rule, device or who can see it).
  if (revoked) {
    return (
      <AccessLost id={id} title={lostTitle} cause={lostCause} ownerName={owner.current} onReopen={onReopen} />
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
  return (
    <LoadedSession
      state={state}
      viewerCan={query.data?.viewerCan ?? []}
      leftProject={query.data?.viewerState === "left_project"}
    />
  );
}

/**
 * The live view after access was lost. Taken away by a change of who can see it (`visibility`): its own words and the
 * owner to ask (07.9, R7); any other cause keeps today's words. If the session comes back to the viewer's list (the
 * owner pressed Undo), it offers to open it again.
 */
function AccessLost({
  id,
  title,
  cause,
  ownerName,
  onReopen,
}: {
  id: string;
  title: string | null;
  cause: string | null;
  ownerName: string | null;
  onReopen: () => void;
}) {
  const copy = accessLostCopy(cause, ownerName);
  const sessions = useWorkSessions();
  const back = cause === "visibility" && (sessions.data?.some((s) => s.id === id) ?? false);
  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="session-access-lost" data-cause={cause ?? ""}>
      <PageHeader
        title={<span className="text-muted-foreground">{title ?? "Session"}</span>}
        icon={<Lock />}
      />
      <EmptyState icon={Lock} title={copy.title} description={copy.description}>
        <div className="flex flex-wrap justify-center gap-2">
          {back ? (
            <Button variant="outline" data-testid="session-reopen" onClick={onReopen} className="max-md:h-11">
              <SquareArrowOutUpRight /> Open session
            </Button>
          ) : null}
          <Link href="/work-zone" className={cn(buttonVariants(), "max-md:h-11")}>
            <ArrowLeft /> Back to Work Zone
          </Link>
        </div>
      </EmptyState>
    </div>
  );
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

const PANEL_KEY = "ocw.wz.panel";

function readPanel(): PanelTab | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(PANEL_KEY);
  return v === "queue" || v === "changes" ? v : null;
}

function LoadedSession({
  state,
  viewerCan,
  leftProject,
}: {
  state: LiveSession;
  viewerCan: readonly Permission[];
  /** The viewer created this session and left its team project since (D-12): read and archive only. */
  leftProject: boolean;
}) {
  const session = state.session;
  const devices = useDevices();
  // ref-4: the stream owns the width; Queue / Changes open as a side panel on wide screens (remembered), as a
  // sheet below xl.
  const wide = useMediaQuery("(min-width: 1280px)");
  const [panel, setPanelState] = useState<PanelTab | null>(readPanel);
  const [sheet, setSheet] = useState<PanelTab | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // Toasts stack above the whole bottom dock: never over the composer's send button (03.2 review note 3) nor over
  // the approval banner's decisions (a hovered toast never times out, so it kept "Allow for session" covered).
  const dock = useRef<HTMLDivElement>(null);
  useToastClearance(dock);
  // Images dropped on the session pane go to the composer's tray (06.1); off where the paperclip is hidden.
  const composer = useRef<ComposerApi | null>(null);
  const filesConfig = useAttachmentsConfig();
  const canPrompt = viewerCan.includes("work_session.prompt");
  const canDrop = filesConfig.data?.enabled === true && canPrompt && session.status !== "archived";

  const setPanel = useCallback((t: PanelTab | null) => {
    setPanelState(t);
    if (t) window.localStorage.setItem(PANEL_KEY, t);
    else window.localStorage.removeItem(PANEL_KEY);
  }, []);
  const openPanel = useCallback(
    (t: PanelTab) => {
      if (wide) setPanel(t);
      else setSheet(t);
    },
    [wide, setPanel],
  );

  const pending = state.approvals.filter((a) => a.status === "pending");
  const queued = state.prompts.filter((p) => p.status === "queued").length;
  const changesCount = state.changes?.files.length ?? session.diffStat?.files ?? 0;
  // After a reload the live `changes` event is gone: the card's folder rows come from the device's diff (same
  // query the Changes panel uses), fetched only when the session reports changes.
  const needDiff = !state.changes && (session.diffStat?.files ?? 0) > 0 && session.deviceOnline;
  const diff = useDiff(session.id, needDiff);
  const cardChanges: WorkSessionChanges | null =
    state.changes ??
    (diff.data
      ? {
          files: diff.data.files,
          branch: diff.data.branch,
          headSha: diff.data.headSha,
          truncated: diff.data.truncated,
          at: diff.data.generatedAt,
        }
      : null);

  const device = devices.data?.find((d) => d.id === session.deviceId);
  const agentBar = (
    <AgentBar
      session={session}
      canInterrupt={viewerCan.includes("work_session.interrupt")}
      onView={() => {
        const el = scroller.current;
        const running = el?.querySelector("[data-turn-running]");
        if (running) running.scrollIntoView({ block: "start", behavior: "smooth" });
        else el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        pinned.current = !running;
      }}
    />
  );
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
        panel={wide ? panel : null}
        wide={wide}
        onPanel={(t) => (wide ? setPanel(panel === t ? null : t) : setSheet(t))}
        queued={queued}
        changesCount={changesCount}
        canArchive={viewerCan.includes("work_session.archive")}
        canChangeVisibility={viewerCan.includes("work_session.visibility")}
      />
      <div className="flex min-h-0 flex-1">
        <DropZone
          conversationLabel={session.title}
          enabled={canDrop}
          hint={`Images only · up to ${WORK_PROMPT_MAX_IMAGES}`}
          onFiles={(files) => composer.current?.addFiles(files)}
          className="min-w-0"
        >
          <div
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget;
              pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
            // The stream fades under the borderless header (ref-4).
            className="scrollbar-thin min-h-0 flex-1 overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,black_20px)]"
          >
            <EventStream
              state={state}
              session={session}
              changesCard={
                <ChangesCard
                  changes={cardChanges}
                  diffStat={session.diffStat}
                  onOpenDiff={() => openPanel("changes")}
                />
              }
            />
          </div>
          <div ref={dock} className="grid grid-cols-[minmax(0,1fr)] gap-3 pt-1">
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
            {leftProject ? (
              // D-12: the creator who left keeps reading and archiving; prompts need project access. One line in
              // the composer's place (no disabled input, no Send); the agent bar and the footer stay.
              <div className="mx-auto w-full max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-4">
                {agentBar}
                <p
                  data-testid="composer-left-project"
                  className="flex min-h-11 items-center gap-2 rounded-lg border bg-muted/40 px-3 text-muted-foreground text-xs"
                >
                  <Info aria-hidden className="size-3.5 shrink-0" />
                  <span>{leftProjectLine(session.teamProject?.name ?? session.projectName)}</span>
                </p>
                <SessionFooter session={session} />
              </div>
            ) : (
              <Composer
                session={session}
                queued={queued}
                canConfigure={viewerCan.includes("work_session.configure")}
                canPrompt={canPrompt}
                apiRef={composer}
                above={agentBar}
                below={<SessionFooter session={session} />}
              />
            )}
          </div>
        </DropZone>
        {wide && panel ? (
          <aside
            className="flex w-[380px] shrink-0 flex-col border-l bg-sidebar/30"
            data-testid="session-panel"
          >
            <div className="flex h-12 shrink-0 items-center gap-2 border-b pr-2 pl-4">
              <h2 className="flex flex-1 items-center gap-1.5 font-medium text-[13px] [&_svg]:size-4">
                {panel === "queue" ? <ListOrdered /> : <FileDiff />}
                {panel === "queue" ? "Queue" : "Changes"}
              </h2>
              <Button size="icon-xs" variant="ghost" aria-label="Close panel" onClick={() => setPanel(null)}>
                <X />
              </Button>
            </div>
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
              {panel === "queue" ? (
                <QueuePanel sessionId={session.id} prompts={state.prompts} />
              ) : (
                <ChangesPanel
                  sessionId={session.id}
                  live={state.changes}
                  deviceOnline={session.deviceOnline}
                />
              )}
            </div>
          </aside>
        ) : null}
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
  panel,
  wide,
  onPanel,
  queued,
  changesCount,
  canArchive,
  canChangeVisibility,
}: {
  session: WorkSession;
  state: LiveSession;
  /** The open side panel on wide screens. */
  panel: PanelTab | null;
  wide: boolean;
  onPanel: (t: PanelTab) => void;
  queued: number;
  changesCount: number;
  canArchive: boolean;
  /** The API's `work_session.visibility` on this session (the chip says "Change" rather than "See"). */
  canChangeVisibility: boolean;
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
  // Below 768 (the 44 px touch rule) the header has two rows: the project and the controls, then the title on its
  // own line, so the 44 px controls never squeeze the title (07.9 polish).
  const md = useMediaQuery("(min-width: 768px)", true);

  useEffect(() => {
    document.title = `${session.title} · Work Zone`;
  }, [session.title]);

  // Queue / Changes: toggles of the side panel on wide screens (`tab-*`), sheet openers below (`open-*`).
  const panelButton = (t: PanelTab, label: string, icon: ReactNode, count: number) => (
    <Tooltip key={t} content={label}>
      <Button
        size="sm"
        variant="ghost"
        aria-label={label}
        aria-pressed={wide ? panel === t : undefined}
        data-testid={wide ? `tab-${t}` : `open-${t}`}
        onClick={() => onPanel(t)}
        className={cn(
          "gap-1 px-2 text-muted-foreground max-md:h-11 max-md:min-w-11",
          wide && panel === t && "bg-accent text-foreground",
        )}
      >
        {icon}
        {count > 0 ? <span className="text-[12px] tabular-nums">{count}</span> : null}
      </Button>
    </Tooltip>
  );

  const title = (
    <span className="flex min-w-0 items-center gap-2">
      <StatusDot status={session.status} className="md:hidden" />
      <h1
        className="truncate font-medium text-[15px] leading-snug tracking-tight md:text-[14.5px]"
        data-testid="session-title"
        title={session.title}
      >
        {session.title}
      </h1>
    </span>
  );

  return (
    <header className="shrink-0 px-3 pt-1 pb-2 sm:px-5 md:pt-3" data-testid="session-header">
      <div className="flex min-h-11 items-center gap-2 md:min-h-9">
        {/* ref-4 breadcrumb: project / session title; below 768 the title has its own line under it. */}
        <nav aria-label="Breadcrumb" className="flex min-w-24 flex-1 items-center md:min-w-0 md:gap-2.5">
          <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground md:max-w-[45%] md:text-[14px]">
            <ProjectMark name={session.teamProject?.name ?? session.projectName} />
            {session.teamProject ? (
              // A team project's segment opens its page (07.9, UI-SPEC IA "Breadcrumb link").
              <Link
                href={`/work-zone/projects/${session.teamProject.id}`}
                data-testid="session-project-link"
                title={`${session.projectName} on ${session.deviceName}`}
                className="truncate rounded-sm outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/40"
              >
                {session.teamProject.name}
              </Link>
            ) : (
              <Tooltip content={`${session.projectName} on ${session.deviceName}`}>
                <span className="truncate" data-testid="session-project">
                  {session.projectName}
                </span>
              </Tooltip>
            )}
            {!md && session.fullAccess ? <FullAccessBadge className="ml-1 h-5 px-1.5 text-[11px]" /> : null}
          </span>
          {md ? (
            <>
              <span aria-hidden className="text-muted-foreground/50">
                /
              </span>
              {title}
            </>
          ) : null}
        </nav>
        <div className="flex min-w-0 items-center gap-1.5 md:shrink-0">
          {md && session.fullAccess ? <FullAccessBadge /> : null}
          <VisibilityChip session={session} viewerId={me} canChange={canChangeVisibility} />
          <div className="flex items-center" data-testid="session-viewers">
            <PresenceStack
              people={viewers}
              max={4}
              label={`${viewers.length} watching now`}
              className="-mx-1"
            />
            {absent.length > 0 ? (
              <div
                role="group"
                className="ml-1 hidden -space-x-1.5 md:flex"
                aria-label="Participants not here"
              >
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
          <StatusChip status={session.status} className="hidden md:inline-flex" />
          <div className="flex items-center">
            {panelButton("queue", "Queue", <ListOrdered />, queued)}
            {panelButton("changes", "Changes", <FileDiff />, changesCount)}
          </div>
          <Menu.Root>
            <Menu.Trigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Session actions"
                  className="max-md:size-11"
                />
              }
            >
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
      </div>
      {md ? null : title}
      {session.lastError && (session.status === "failed" || session.status === "idle") ? (
        <p className="mt-1 line-clamp-2 text-destructive text-xs">{session.lastError}</p>
      ) : null}
    </header>
  );
}

/** The project's two-letter mark (ref-4 breadcrumb and sidebar). */
function ProjectMark({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-primary/12 font-bold text-[8px] text-primary leading-none tracking-tight"
    >
      {projectInitials(name)}
    </span>
  );
}
