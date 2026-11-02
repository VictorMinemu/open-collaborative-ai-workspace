"use client";

import { type Automation, scheduleSummary } from "@ocw/contracts";
import {
  Bot,
  CalendarClock,
  CircleAlert,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Plus,
  SquareKanban,
  Webhook,
  Zap,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bots/bot-bits";
import { BotsSectionNav } from "@/components/bots/bots-section-nav";
import { EmptyState } from "@/components/common/empty-state";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { errorMessage } from "@/lib/api";
import {
  type AutomationScope,
  nextRelative,
  RESULT_TONE,
  resumedText,
  runResult,
  statusWord,
  targetName,
  triggerSummary,
  useAutomationLive,
  useAutomationOptions,
  useAutomations,
  usePauseAutomation,
  useResumeAutomation,
  useRunNow,
  useSendDigestNow,
} from "@/lib/automation-queries";
import { useAgents } from "@/lib/bots-queries";
import { useMe } from "@/lib/queries";
import { cn, relativeTime, shortAge } from "@/lib/utils";
import { AutomationEditorSheet, DeleteAutomationDialog } from "./automation-editor-sheet";

/**
 * Bots › Automations (07.6-15, AUTO-01, D-07, UI-SPEC Surface 1): the viewer's own automations, and everyone's for
 * holders of `automation.manage` (`?scope=all`). One bordered list; each row is a stretched open button (the editor
 * sheet, `?edit=<id>`) with a separate `⋯` menu whose items follow the server's `viewerCan` (a manager pauses and
 * deletes someone else's, never edits, runs or resumes it: P-04). Every value is plain text.
 */
export function AutomationsPage() {
  useAutomationLive();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const scope: AutomationScope = search.get("scope") === "all" ? "all" : "mine";
  const list = useAutomations(scope);
  const options = useAutomationOptions();
  const me = useMe({ enabled: false }).data?.user.id ?? null;
  const [fresh, setFresh] = useState<string | null>(null);

  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => setFresh(null), 2000);
    return () => clearTimeout(t);
  }, [fresh]);

  const editId = search.get("edit");
  const draftId = search.get("draft");
  const creating = search.get("new") === "1";
  const tab = search.get("tab") === "runs" || search.get("run") ? "runs" : "settings";
  const runId = search.get("run");

  /** Replaces the editor params, keeping `scope`. */
  const go = (params: Record<string, string>) => {
    const next = new URLSearchParams();
    if (scope === "all") next.set("scope", "all");
    for (const [k, v] of Object.entries(params)) next.set(k, v);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const canCreate = options.data?.canCreate ?? false;
  const usage = list.data?.usage ?? null;
  const atCap = !!usage && usage.max > 0 && usage.used >= usage.max;
  const canManage = list.data?.canManage ?? false;
  const rows = useMemo(() => sortRows(list.data?.automations ?? [], scope), [list.data, scope]);

  const newButton = (className?: string) =>
    canCreate ? (
      <Button
        size="sm"
        data-testid="new-automation"
        aria-disabled={atCap || undefined}
        aria-describedby={atCap ? "automations-usage" : undefined}
        className={cn("aria-disabled:cursor-not-allowed aria-disabled:opacity-50", className)}
        onClick={() => (atCap ? undefined : go({ new: "1" }))}
      >
        <Plus /> New automation
      </Button>
    ) : null;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <PageHeader
        title="Bots"
        description="Teammates with their own identity. Message them privately or mention them in any channel."
        icon={<Bot />}
        actions={newButton("max-sm:hidden")}
      />
      <BotsSectionNav active="automations" />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-5xl gap-4 px-4 py-4 sm:gap-6 sm:px-6 sm:py-6">
          {canCreate ? <div className="sm:hidden">{newButton("h-11 w-full")}</div> : null}
          {canManage || usage ? (
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              {canManage ? (
                <Tabs
                  value={scope}
                  onValueChange={(v) => {
                    const next = v === "all" ? "?scope=all" : "";
                    router.replace(`${pathname}${next}`, { scroll: false });
                  }}
                >
                  <TabsList aria-label="Whose automations">
                    <TabsTrigger value="mine" data-testid="automations-scope-mine">
                      Mine
                    </TabsTrigger>
                    <TabsTrigger value="all" data-testid="automations-scope-all">
                      Everyone
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              ) : (
                <span />
              )}
              {usage && usage.max > 0 ? (
                <p
                  id="automations-usage"
                  data-testid="automations-usage"
                  className={cn(
                    "text-xs",
                    atCap ? "text-amber-800 dark:text-amber-300" : "text-muted-foreground",
                  )}
                >
                  {atCap
                    ? `You've reached ${usage.max} automations. Delete one to add another.`
                    : `${usage.used} of ${usage.max} automations used`}
                </p>
              ) : null}
            </div>
          ) : null}

          {list.isPending ? (
            <ListSkeleton />
          ) : list.isError ? (
            <ServerUnreachable
              title="Couldn't load automations."
              onRetry={() => list.refetch()}
              retrying={list.isFetching}
            />
          ) : rows.length === 0 ? (
            scope === "all" ? (
              <EmptyState
                icon={Zap}
                title="No automations in this workspace yet."
                description="Automations people create appear here."
                className="py-12"
              />
            ) : (
              <EmptyState
                icon={Zap}
                title="No automations yet"
                description={
                  canCreate || options.isPending
                    ? "Give a bot a standing order: a weekly report, a daily check, or a reply to every new order or email."
                    : "Ask an admin if you need automations."
                }
                className="py-12"
              >
                {canCreate ? (
                  <Button
                    data-testid="new-automation-empty"
                    className="max-md:h-11"
                    onClick={() => go({ new: "1" })}
                  >
                    <Plus /> New automation
                  </Button>
                ) : null}
              </EmptyState>
            )
          ) : (
            <div
              data-testid="automations-list"
              className="overflow-hidden rounded-xl border bg-card shadow-xs"
            >
              <div
                aria-hidden
                className="hidden h-9 grid-cols-[minmax(0,1.8fr)_minmax(0,1.8fr)_minmax(0,1fr)_9rem_2rem] items-center gap-x-4 border-b px-4 font-semibold text-muted-foreground text-xs uppercase tracking-wider sm:px-5 md:grid"
              >
                <span>Automation</span>
                <span>When</span>
                <span>Last run</span>
                <span>Status</span>
                <span />
              </div>
              <ul aria-label="Automations" className="divide-y">
                {rows.map((a) => (
                  <AutomationRow
                    key={a.id}
                    automation={a}
                    me={me}
                    everyone={scope === "all"}
                    highlight={fresh === a.id}
                    onOpen={() =>
                      a.actionKind === "digest" ? router.push("/settings/digest") : go({ edit: a.id })
                    }
                    onRuns={() => go({ edit: a.id, tab: "runs" })}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <AutomationEditorSheet
        open={creating || !!editId || !!draftId}
        id={editId}
        draftId={creating ? null : draftId}
        tab={tab}
        runId={runId}
        onTab={(t) =>
          editId ? go(t === "runs" ? { edit: editId, tab: "runs" } : { edit: editId }) : undefined
        }
        onClose={() => go({})}
        onCreated={(a) => {
          go({});
          setFresh(a.id);
        }}
        onOpenRuns={(id) => go({ edit: id, tab: "runs" })}
      />
    </div>
  );
}

const STATUS_ORDER: Record<Automation["status"], number> = { needs_attention: 0, active: 1, paused: 2 };

/** Mine: as the API lists them. Everyone: needs attention first, then the person, then the name. */
function sortRows(rows: Automation[], scope: AutomationScope): Automation[] {
  if (scope !== "all") return rows;
  return [...rows].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      a.runAs.displayName.localeCompare(b.runAs.displayName) ||
      a.name.localeCompare(b.name),
  );
}

function ListSkeleton() {
  return (
    <div
      data-testid="automations-loading"
      aria-busy="true"
      role="status"
      aria-label="Loading automations"
      className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs"
    >
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex h-16 items-center gap-4 px-4 sm:px-5">
          <Skeleton className="h-4 w-[40%] motion-reduce:animate-none" />
          <Skeleton className="h-4 w-[30%] motion-reduce:animate-none" />
          <Skeleton className="h-4 w-[20%] motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  );
}

const TRIGGER_ICON = { schedule: CalendarClock, webhook: Webhook, mail: Mail } as const;
/** The channel's own `#` is its glyph; boards and DMs get theirs. */
const TARGET_ICON = { channel: null, thread: null, board: SquareKanban, dm: MessageSquare } as const;

export function AutomationRow({
  automation: a,
  me,
  everyone,
  highlight,
  onOpen,
  onRuns,
}: {
  automation: Automation;
  me: string | null;
  everyone: boolean;
  highlight: boolean;
  onOpen: () => void;
  onRuns: () => void;
}) {
  const avatars = useAgents().data?.agents;
  const openRef = useRef<HTMLButtonElement>(null);
  // A row just created takes the focus once, when it first renders (UI-SPEC Focus management): never later, so it
  // cannot pull focus out of a menu the person already opened.
  useEffect(() => {
    if (highlight) openRef.current?.focus({ preventScroll: false });
  }, [highlight]);
  const avatar = avatars?.find((x) => x.id === a.agent.id)?.avatarUrl ?? null;
  const digest = a.actionKind === "digest";
  const TriggerIcon = TRIGGER_ICON[a.trigger.kind];
  const TargetIcon = TARGET_ICON[a.target.kind];
  const summary = triggerSummary(a, scheduleSummary);
  const zone = a.trigger.schedule?.timeZone ?? null;
  const whenLine =
    a.trigger.kind === "schedule" && zone
      ? `${zone}${a.status === "active" && a.nextRunAt ? ` · next ${nextRelative(a.nextRunAt, zone)}` : ""}`
      : a.trigger.kind === "mail" && a.trigger.mailbox?.lastPolledAt
        ? `checked ${relativeTime(a.trigger.mailbox.lastPolledAt)}`
        : null;
  const result = a.lastRun ? runResult(a.lastRun.status, digest) : null;
  const status = statusWord(a.status);
  const name = `${a.name}, ${status}, ${summary}, ${
    result && a.lastRun ? `last run ${result.label} ${shortAge(a.lastRun.at)}` : "not run yet"
  }`;

  return (
    <li
      data-testid="automation-row"
      data-automation-id={a.id}
      data-status={a.status}
      className={cn(
        "relative grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3 sm:px-5",
        "[grid-template-areas:'name_menu'_'when_when'_'zone_zone'_'bot_bot'_'result_status'_'reason_reason']",
        "md:min-h-16 md:grid-cols-[minmax(0,1.8fr)_minmax(0,1.8fr)_minmax(0,1fr)_9rem_2rem] md:items-center md:gap-x-4 md:gap-y-0.5",
        "md:[grid-template-areas:'name_when_result_status_menu'_'bot_zone_result_status_menu'_'reason_reason_reason_reason_reason']",
        highlight && "ring-2 ring-primary/60 ring-inset motion-safe:transition-shadow",
      )}
    >
      <button
        type="button"
        id={`automation-open-${a.id}`}
        ref={openRef}
        data-testid="automation-open"
        aria-label={name}
        title={a.name}
        onClick={onOpen}
        className="absolute inset-0 outline-none transition-colors hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset dark:hover:bg-white/[0.03]"
      />
      <div className="pointer-events-none relative flex min-w-0 items-center gap-2 [grid-area:name]">
        <span className="truncate font-semibold text-sm" data-testid="automation-name">
          {a.name}
        </span>
        {digest ? (
          <Badge variant="outline" className="shrink-0">
            Digest
          </Badge>
        ) : null}
      </div>
      <p
        className="pointer-events-none relative flex min-w-0 items-center gap-1.5 text-sm [grid-area:when]"
        data-testid="automation-when"
      >
        <TriggerIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{summary}</span>
      </p>
      {whenLine ? (
        <p
          className="pointer-events-none relative truncate text-muted-foreground text-xs [grid-area:zone]"
          data-testid="automation-zone"
        >
          {whenLine}
        </p>
      ) : null}
      <p
        className="pointer-events-none relative flex min-w-0 items-center gap-1 text-muted-foreground text-xs [grid-area:bot]"
        data-testid="automation-target"
      >
        <BotAvatar
          name={a.agent.displayName}
          avatar={avatar}
          seed={a.agent.id}
          size="sm"
          className="size-4 rounded text-[8px]"
        />
        <span className="truncate">
          {a.agent.displayName} →{" "}
          {TargetIcon ? <TargetIcon className="-mt-0.5 mr-0.5 inline size-3 shrink-0" aria-hidden /> : null}
          {targetName(a, me)}
          {everyone ? ` · for ${a.runAs.displayName}` : ""}
        </span>
      </p>
      <p
        className="pointer-events-none relative flex min-w-0 items-center gap-1.5 text-xs [grid-area:result]"
        data-testid="automation-last-run"
      >
        {result && a.lastRun ? (
          <>
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", RESULT_TONE[result.tone].dot)}
            />
            <span className={cn("font-semibold", RESULT_TONE[result.tone].text)}>{result.label}</span>
            <span className="truncate text-muted-foreground">· {shortAge(a.lastRun.at)}</span>
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </p>
      <div className="pointer-events-none relative flex items-center justify-end [grid-area:status] md:justify-start">
        <StatusMark status={a.status} />
      </div>
      {a.status === "needs_attention" ? (
        <p
          className="pointer-events-none relative text-amber-800 text-xs dark:text-amber-300 [grid-area:reason]"
          data-testid="automation-reason"
        >
          Paused after 3 failed runs.
        </p>
      ) : null}
      <div className="relative z-10 flex items-center justify-end [grid-area:menu]">
        <RowMenu automation={a} me={me} onOpen={onOpen} onRuns={onRuns} />
      </div>
    </li>
  );
}

/** Active: a dot and the word (a column of green pills is noise). Paused: muted pill. Needs attention: amber pill. */
export function StatusMark({ status }: { status: Automation["status"] }) {
  if (status === "active") {
    return (
      <span
        data-testid="automation-status"
        className="inline-flex items-center gap-1.5 text-muted-foreground text-xs"
      >
        <span aria-hidden className="size-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
        Active
      </span>
    );
  }
  if (status === "paused") {
    return (
      <span
        data-testid="automation-status"
        className="inline-flex h-6 items-center rounded-full bg-muted px-2.5 font-medium text-muted-foreground text-xs"
      >
        Paused
      </span>
    );
  }
  return (
    <span
      data-testid="automation-status"
      className="inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full bg-amber-100 px-2.5 font-medium text-amber-800 text-xs dark:bg-amber-400/15 dark:text-amber-300"
    >
      <CircleAlert className="size-3.5" aria-hidden />
      Needs attention
    </span>
  );
}

/**
 * The row's `⋯` (UI-SPEC Surface 1): own `Edit… · Run now · Pause | Resume · Delete…`; a manager on someone else's
 * `Open · Pause · Delete…` (Resume is the owner's: P-04); a digest `Digest settings · Send now · Pause | Resume`.
 */
function RowMenu({
  automation: a,
  me,
  onOpen,
  onRuns,
}: {
  automation: Automation;
  me: string | null;
  onOpen: () => void;
  onRuns: () => void;
}) {
  const pause = usePauseAutomation();
  const resume = useResumeAutomation();
  const runNow = useRunNow();
  const sendDigest = useSendDigestNow();
  const [deleting, setDeleting] = useState(false);
  const own = me !== null && a.runAs.id === me;
  const can = (x: Automation["viewerCan"][number]) => a.viewerCan.includes(x);
  const digest = a.actionKind === "digest";
  const active = a.status === "active";

  const doPause = () =>
    pause.mutate(a.id, {
      onSuccess: () => toast(`Paused “${a.name}”.`),
      onError: (err) => toast.error(errorMessage(err)),
    });
  const doResume = () =>
    resume.mutate(a.id, {
      onSuccess: (r) => toast(resumedText(r)),
      onError: (err) => toast.error(errorMessage(err)),
    });
  const doRun = () =>
    runNow.mutate(a.id, {
      onSuccess: () => toast(`Running “${a.name}” now.`, { action: { label: "Open runs", onClick: onRuns } }),
      onError: (err) => toast.error(errorMessage(err)),
    });

  const items: ReactNode[] = [];
  if (digest) {
    items.push(
      <DropdownMenuItem key="settings" onClick={onOpen}>
        Digest settings
      </DropdownMenuItem>,
    );
    if (own) {
      items.push(
        <DropdownMenuItem
          key="send"
          onClick={() =>
            sendDigest.mutate(undefined, {
              onSuccess: () => toast(`Sent to your DM with ${a.agent.displayName}.`),
              onError: (err) => toast.error(errorMessage(err)),
            })
          }
        >
          Send now
        </DropdownMenuItem>,
      );
    }
  } else if (own) {
    items.push(
      <DropdownMenuItem key="edit" onClick={onOpen}>
        {can("edit") ? "Edit…" : "Open"}
      </DropdownMenuItem>,
    );
    if (can("run")) {
      items.push(
        <DropdownMenuItem key="run" onClick={doRun} data-testid="automation-menu-run">
          Run now
        </DropdownMenuItem>,
      );
    }
  } else {
    items.push(
      <DropdownMenuItem key="open" onClick={onOpen}>
        Open
      </DropdownMenuItem>,
    );
  }
  if (active && can("pause")) {
    items.push(
      <DropdownMenuItem key="pause" onClick={doPause} data-testid="automation-menu-pause">
        Pause
      </DropdownMenuItem>,
    );
  }
  if (!active && own) {
    items.push(
      <DropdownMenuItem key="resume" onClick={doResume} data-testid="automation-menu-resume">
        Resume
      </DropdownMenuItem>,
    );
  }
  if (can("delete") && !digest) {
    items.push(<DropdownMenuSeparator key="sep" />);
    items.push(
      <DropdownMenuItem
        key="delete"
        variant="destructive"
        onClick={() => setDeleting(true)}
        data-testid="automation-menu-delete"
      >
        Delete…
      </DropdownMenuItem>,
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`${a.name} actions`}
              data-testid="automation-menu"
              className="text-muted-foreground max-md:size-11"
            />
          }
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" data-testid="automation-menu-content">
          {items}
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteAutomationDialog automation={deleting ? a : null} onClose={() => setDeleting(false)} />
    </>
  );
}
