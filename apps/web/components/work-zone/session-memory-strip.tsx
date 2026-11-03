"use client";

import { Menu } from "@base-ui/react/menu";
import type { SessionMemorySummary, WorkSession } from "@ocw/contracts";
import { ArrowRight, Check, MoreHorizontal, NotebookPen } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { toast } from "sonner";
import { APPROVAL_STATUS } from "@/components/memory/proposal-view";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, isApiError } from "@/lib/api";
import { useApproval } from "@/lib/approval-queries";
import { memoryHref } from "@/lib/memory-tree";
import { cn } from "@/lib/utils";
import {
  useMemoryPreferences,
  useProposeSessionMemory,
  useSessionMemory,
  useSetMemoryPreferences,
  useWorkMemoryLiveUpdates,
} from "@/lib/work-memory-queries";
import { type ProposeDialogMode, ProposeSummaryDialog } from "./propose-summary-dialog";

/**
 * The session memory strip (Phase 07.6-22, AUTO-06; D-06 as amended by D-10, D-07, D-11; UI-SPEC Surface 9a, R7), on a
 * finished session (Ended or Archived) between the event stream and the composer area.
 *
 * - State: only the per-viewer `GET /work-sessions/:id/memory`, refreshed by `work_session_memory.updated` and
 *   `approval_request.updated` on the viewer's own `user:` stream; never the `ws:` stream or the session DTO (D-11).
 *   People outside the session's audience get the 404 of a missing session, so they never see a strip.
 * - The owner (`canPropose`, the person who pays) proposes, through the confirmation only, and holds the `⋯` menu
 *   (automatic proposals, off by default, D-07). Everyone else in the audience reads the status lines only.
 * - Not mapped (D-10): `Link it →` goes to 07.9's Projects index (`/work-zone/projects`, where a team project's
 *   Settings tab holds `ProjectReposSection`) for people the API says may link (`canMap`, 07.9's rule); everyone else
 *   reads `Ask a lead to link it.` 07.6 builds no linking UI of its own.
 */

/** 07.9's Projects index: a team project's Settings tab links repositories there (D-10). */
export const LINK_REPOS_HREF = "/work-zone/projects";
export const MEMORY_PROPOSALS_HREF = "/memory/proposals?box=requested";

export const STRIP_COPY = {
  ready: (unit: string) => `Save what this session learned to ${unit} memory.`,
  propose: "Propose to memory",
  writing: "Writing a summary…",
  proposed: (unit: string) => `Proposed to ${unit} memory`,
  proposedAuto: (unit: string) => `Proposed automatically to ${unit} memory`,
  saved: (unit: string) => `Saved to ${unit} memory`,
  by: (person: string) => ` by ${person}`,
  denied: (person: string) => `Not saved: ${person} declined it.`,
  failed: "Couldn't write the summary. Nothing was saved.",
  retry: "Try again",
  nothingNew: "Already proposed. Nothing new since then.",
  notMapped: "This repository isn't linked to a project's memory.",
  link: "Link it",
  askLead: "Ask a lead to link it.",
  review: "Review",
  open: "Open",
  pendingPill: "Pending review",
  appliedPill: "Applied",
  menu: "Project memory options",
  autoItem: "Propose automatically for my sessions",
  proposalsItem: "Memory proposals",
  autoOn: "Automatic proposals are on.",
  autoOff: "Automatic proposals are off.",
  sent: (unit: string) => `Summary sent to ${unit} memory for review.`,
  /** A unit name the API did not send (it always does for these states). */
  unitFallback: "the project's",
  deciderFallback: "A reviewer",
} as const;

export type StripAction =
  | { kind: "propose" }
  | { kind: "propose-disabled" }
  | { kind: "retry" }
  | { kind: "link"; href: string }
  | { kind: "ask" }
  | { kind: "review"; href: string }
  | { kind: "open"; href: string };

export interface StripModel {
  status: SessionMemorySummary["status"];
  line: string;
  /** `error`: the failure line (red text). */
  tone: "default" | "error";
  pill: "pending" | "applied" | null;
  /** ` by {decider}` after the Applied pill. */
  by: string | null;
  /** The reviewer's note on a denial, quoted. */
  note: string | null;
  spinner: boolean;
  action: StripAction | null;
  /** The owner's `⋯` menu (automatic proposals, Memory proposals). */
  menu: boolean;
}

export const proposalHref = (id: string) => `/memory/proposals/${encodeURIComponent(id)}`;

/**
 * What the strip shows to this viewer (UI-SPEC Surface 9a state table), or null for no strip: a session the viewer
 * cannot propose (not the owner) with nothing proposed, or a failure (the owner's own attempt).
 */
export function stripModel(
  s: SessionMemorySummary,
  opts: { fileHref?: string | null } = {},
): StripModel | null {
  const owner = s.canPropose;
  const unit = s.unit?.name ?? STRIP_COPY.unitFallback;
  const base = {
    status: s.status,
    tone: "default",
    pill: null,
    by: null,
    note: null,
    spinner: false,
    menu: owner,
  } as const;
  switch (s.status) {
    case "unmapped":
      return {
        ...base,
        line: STRIP_COPY.notMapped,
        action: s.canMap ? { kind: "link", href: LINK_REPOS_HREF } : { kind: "ask" },
      };
    case "none":
      if (!owner) return null;
      return s.nothingNew
        ? { ...base, line: STRIP_COPY.nothingNew, action: { kind: "propose-disabled" } }
        : { ...base, line: STRIP_COPY.ready(unit), action: { kind: "propose" } };
    case "writing":
      return { ...base, line: STRIP_COPY.writing, spinner: true, action: null };
    case "pending":
      return {
        ...base,
        line: s.auto ? STRIP_COPY.proposedAuto(unit) : STRIP_COPY.proposed(unit),
        pill: "pending",
        action: owner && s.proposalId ? { kind: "review", href: proposalHref(s.proposalId) } : null,
      };
    case "applied":
      return {
        ...base,
        line: STRIP_COPY.saved(unit),
        pill: "applied",
        by: s.decidedBy ? STRIP_COPY.by(s.decidedBy.displayName) : null,
        action:
          owner && s.proposalId ? { kind: "open", href: opts.fileHref ?? proposalHref(s.proposalId) } : null,
      };
    case "denied":
      return {
        ...base,
        line: STRIP_COPY.denied(s.decidedBy?.displayName ?? STRIP_COPY.deciderFallback),
        note: s.decisionNote?.trim() ? s.decisionNote.trim() : null,
        action: null,
      };
    case "failed":
      if (!owner) return null;
      return { ...base, line: STRIP_COPY.failed, tone: "error", action: { kind: "retry" } };
  }
}

/** Ended (`completed`) or Archived: the only sessions a strip is shown on. */
export const isFinished = (status: WorkSession["status"]) => status === "completed" || status === "archived";

const pillTone = { pending: APPROVAL_STATUS.pending.tone, applied: APPROVAL_STATUS.applied.tone } as const;

function StatusPill({ kind }: { kind: "pending" | "applied" }) {
  return (
    <span
      data-testid="session-memory-pill"
      data-status={kind}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 font-medium text-[11px]",
        pillTone[kind],
      )}
    >
      {kind === "pending" ? (
        <span aria-hidden className="inline-flex size-1.5 rounded-full bg-amber-500" />
      ) : (
        <Check aria-hidden className="size-3 shrink-0" />
      )}
      {kind === "pending" ? STRIP_COPY.pendingPill : STRIP_COPY.appliedPill}
    </span>
  );
}

const actionClass = "max-md:h-11 max-sm:w-full";
const linkClass = cn(buttonVariants({ variant: "outline", size: "sm" }), actionClass, "gap-1");

/**
 * The strip as it renders for one model (static, no data hooks: the web unit tests render it to markup). The menu and
 * dialogs are the container's; `onPropose` opens the confirmation, never a request.
 */
export function SessionMemoryStripView({
  model,
  autoOn,
  onPropose,
  onAutoChange,
}: {
  model: StripModel;
  autoOn: boolean;
  onPropose: () => void;
  /** `true`: the person asked to turn it on (the container confirms first); `false`: off at once. */
  onAutoChange: (on: boolean) => void;
}) {
  const lineId = useId();
  const action = model.action;
  return (
    <section
      aria-label="Project memory"
      data-testid="session-memory-strip"
      data-status={model.status}
      className="border-t bg-muted/30 dark:bg-white/[0.02]"
    >
      <div className="mx-auto flex min-h-12 w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:px-6">
        <NotebookPen aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <div
          role="status"
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm"
          data-testid="session-memory-line"
        >
          <span
            id={lineId}
            className={cn("min-w-0 break-words", model.tone === "error" && "text-red-700 dark:text-red-400")}
          >
            {model.line}
          </span>
          {model.spinner ? <Spinner className="size-3.5 text-muted-foreground" /> : null}
          {/* Spaces between the flex items keep the line readable as text (screen readers, copy). */}
          {model.pill ? (
            <span className="inline-flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
              {" "}
              <span aria-hidden className="max-sm:hidden">
                ·
              </span>{" "}
              <StatusPill kind={model.pill} />
              {model.by ? <span data-testid="session-memory-decider"> {model.by.trim()}</span> : null}
            </span>
          ) : null}
          {model.note ? (
            <span
              data-testid="session-memory-note"
              className="basis-full break-words text-muted-foreground text-xs"
            >
              “{model.note}”
            </span>
          ) : null}
        </div>
        {action ? (
          <div className="order-last flex w-full sm:order-none sm:w-auto">
            <StripActionView action={action} lineId={lineId} onPropose={onPropose} />
          </div>
        ) : null}
        {model.menu ? <StripMenu autoOn={autoOn} onAutoChange={onAutoChange} /> : null}
      </div>
    </section>
  );
}

function StripActionView({
  action,
  lineId,
  onPropose,
}: {
  action: StripAction;
  lineId: string;
  onPropose: () => void;
}) {
  switch (action.kind) {
    case "propose":
      return (
        <Button
          size="sm"
          variant="outline"
          data-testid="session-memory-propose"
          className={actionClass}
          onClick={onPropose}
        >
          <NotebookPen aria-hidden />
          {STRIP_COPY.propose}
        </Button>
      );
    case "propose-disabled":
      return (
        <Button
          size="sm"
          variant="outline"
          data-testid="session-memory-propose"
          aria-disabled="true"
          aria-describedby={lineId}
          className={cn(actionClass, "cursor-not-allowed opacity-50")}
          onClick={(e) => e.preventDefault()}
        >
          <NotebookPen aria-hidden />
          {STRIP_COPY.propose}
        </Button>
      );
    case "retry":
      return (
        <Button
          size="sm"
          variant="outline"
          data-testid="session-memory-retry"
          className={actionClass}
          onClick={onPropose}
        >
          {STRIP_COPY.retry}
        </Button>
      );
    case "link":
      return (
        <Link href={action.href} data-testid="session-memory-link" className={linkClass}>
          {STRIP_COPY.link} <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      );
    case "ask":
      return (
        <span data-testid="session-memory-ask" className="text-muted-foreground text-sm">
          {STRIP_COPY.askLead}
        </span>
      );
    case "review":
      return (
        <Link href={action.href} data-testid="session-memory-review" className={linkClass}>
          {STRIP_COPY.review} <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      );
    case "open":
      return (
        <Link href={action.href} data-testid="session-memory-open" className={linkClass}>
          {STRIP_COPY.open} <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      );
  }
}

const itemClass =
  "relative flex min-h-9 cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground max-md:min-h-11";

function StripMenu({ autoOn, onAutoChange }: { autoOn: boolean; onAutoChange: (on: boolean) => void }) {
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={STRIP_COPY.menu}
            data-testid="session-memory-menu"
            className="max-md:size-11"
          />
        }
      >
        <MoreHorizontal />
      </Menu.Trigger>
      <DropdownMenuContent align="end" className="w-72">
        <Menu.CheckboxItem
          checked={autoOn}
          closeOnClick
          onCheckedChange={(on) => onAutoChange(on)}
          data-testid="session-memory-auto"
          className={cn(itemClass, "pr-8")}
        >
          {STRIP_COPY.autoItem}
          <span className="absolute right-2 flex size-4 items-center justify-center">
            <Menu.CheckboxItemIndicator>
              <Check aria-hidden className="size-4" />
            </Menu.CheckboxItemIndicator>
          </span>
        </Menu.CheckboxItem>
        <Menu.LinkItem
          render={<Link href={MEMORY_PROPOSALS_HREF} />}
          data-testid="session-memory-proposals"
          className={itemClass}
        >
          {STRIP_COPY.proposalsItem}
        </Menu.LinkItem>
      </DropdownMenuContent>
    </Menu.Root>
  );
}

/** Copy for a refused propose (`nothing_new`, `session_unmapped`, …): API codes never reach the screen. */
export function proposeErrorText(err: unknown): string {
  if (isApiError(err)) {
    if (err.code === "nothing_new") return STRIP_COPY.nothingNew;
    if (err.code === "session_unmapped") return STRIP_COPY.notMapped;
  }
  return errorMessage(err);
}

/** The strip with its data: mounted once by `SessionView`; renders nothing on a session that has not ended. */
export function SessionMemoryStrip({ session }: { session: WorkSession }) {
  const finished = isFinished(session.status);
  const memory = useSessionMemory(session.id, finished);
  useWorkMemoryLiveUpdates(finished);
  const summary = memory.data ?? null;
  const owner = summary?.canPropose === true;
  const prefs = useMemoryPreferences(finished && owner);
  const setPrefs = useSetMemoryPreferences();
  const propose = useProposeSessionMemory();
  // "Open →" goes to the applied file (07.2's review names its scope and path); the proposal until it loads.
  const applied = useApproval(owner && summary?.status === "applied" ? summary.proposalId : null);
  const view = applied.data?.view;
  const fileHref =
    view?.type === "memory_proposal" ? memoryHref(view.proposal.scope.id, view.proposal.path) : null;
  const [dialog, setDialog] = useState<ProposeDialogMode | null>(null);
  const [lastMode, setLastMode] = useState<ProposeDialogMode>("once");

  if (!finished || !summary) return null;
  const model = stripModel(summary, { fileHref });
  if (!model) return null;
  const unitName = summary.unit?.name ?? STRIP_COPY.unitFallback;
  const autoOn = prefs.data?.autoProposeSessionSummaries ?? false;

  const openDialog = (mode: ProposeDialogMode) => {
    setLastMode(mode);
    setDialog(mode);
  };
  const turnOn = (onDone?: () => void) =>
    setPrefs.mutate(true, {
      onSuccess: () => {
        toast.success(STRIP_COPY.autoOn);
        onDone?.();
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  const confirm = ({ auto }: { auto: boolean }) => {
    if (dialog === "auto") {
      turnOn(() => setDialog(null));
      return;
    }
    if (propose.isPending) return;
    propose.mutate(session.id, {
      onSuccess: () => {
        setDialog(null);
        toast.success(STRIP_COPY.sent(unitName));
        if (auto && !autoOn) turnOn();
      },
      onError: (err) => {
        setDialog(null);
        toast.error(proposeErrorText(err));
      },
    });
  };

  return (
    <>
      <SessionMemoryStripView
        model={model}
        autoOn={autoOn}
        onPropose={() => openDialog("once")}
        onAutoChange={(on) => {
          if (on) {
            openDialog("auto");
            return;
          }
          setPrefs.mutate(false, {
            onSuccess: () => toast.success(STRIP_COPY.autoOff),
            onError: (err) => toast.error(errorMessage(err)),
          });
        }}
      />
      {owner ? (
        <ProposeSummaryDialog
          open={dialog !== null}
          mode={dialog ?? lastMode}
          unitName={unitName}
          model={summary.model}
          pending={propose.isPending || setPrefs.isPending}
          onOpenChange={(o) => !o && setDialog(null)}
          onConfirm={confirm}
        />
      ) : null}
    </>
  );
}
