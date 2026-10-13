"use client";

import {
  APPROVAL_NOTE_MAX,
  type ApprovalDetail,
  type ApprovalRequestStatus,
  type MemoryProposalView,
  type SensitiveFinding,
} from "@ocw/contracts";
import {
  ArrowLeft,
  ArrowUpRight,
  Bot,
  Building2,
  Check,
  CircleCheck,
  CircleX,
  FolderKanban,
  Globe,
  Hourglass,
  Inbox,
  Lock,
  type LucideIcon,
  Quote,
  RotateCcw,
  ScanSearch,
  TriangleAlert,
  Users,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/empty-state";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import { isApiError } from "@/lib/api";
import {
  decisionDate,
  decisionErrorText,
  expiresText,
  failedReason,
  isPrivateScope,
  nextVersion,
  proposalAge,
  readerSentence,
  scopeText,
  shortDate,
  useApproval,
  useDecideApproval,
} from "@/lib/approval-queries";
import { memoryHref } from "@/lib/memory-tree";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { FINDING_LABEL, FindingsList, listedFindings } from "./findings-list";
import { Counts } from "./memory-history";

/**
 * One approval's review (Phase 07.2, 07.2-13, MEM-05, MEM-06, D-08, UI-SPEC "Proposals inbox and review"): for a
 * memory proposal, the fact strip (how many people will see it, the findings, whether the bot read web content), the
 * bot's note as plain text, the findings with masked samples, and the diff with the sensitive spans highlighted; the
 * generic `fields` view for any later kind. Deciders get Deny… / Approve… in a sticky footer; each asks first, with an
 * optional note, and sends the hash of the view on screen (T-07.2-13-01). A changed proposal is explained with Reload,
 * never decided automatically. Everything shown comes from the API's answer for this viewer.
 */

const MemoryDiff = dynamic(() => import("./memory-diff"), {
  ssr: false,
  loading: () => <DiffSkeleton />,
});

function DiffSkeleton() {
  return (
    <div aria-busy className="grid gap-2 p-4">
      {["w-3/4", "w-1/2", "w-5/6", "w-2/3"].map((w) => (
        <Skeleton key={w} className={cn("h-3.5 motion-reduce:animate-none", w)} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- status

/** Pill tones (UI-SPEC "Status and notices"), text at AA contrast in light and dark. */
export const APPROVAL_STATUS: Record<
  ApprovalRequestStatus,
  { label: string; tone: string; icon: LucideIcon | null }
> = {
  pending: {
    label: "Pending",
    tone: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
    icon: null,
  },
  approved: {
    label: "Approved",
    tone: "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300",
    icon: CircleCheck,
  },
  applied: {
    label: "Applied",
    tone: "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300",
    icon: CircleCheck,
  },
  failed: {
    label: "Failed",
    tone: "bg-red-100 text-red-800 dark:bg-red-400/15 dark:text-red-300",
    icon: CircleX,
  },
  denied: { label: "Denied", tone: "bg-muted text-muted-foreground", icon: CircleX },
  expired: { label: "Expired", tone: "bg-muted text-muted-foreground", icon: Hourglass },
};

export function StatusPill({ status, className }: { status: ApprovalRequestStatus; className?: string }) {
  const s = APPROVAL_STATUS[status];
  const Icon = s.icon;
  return (
    <span
      data-testid="proposal-status"
      data-status={status}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 font-medium text-xs",
        s.tone,
        className,
      )}
    >
      {Icon ? (
        <Icon aria-hidden className="size-3.5 shrink-0" />
      ) : (
        <span aria-hidden className="inline-flex size-1.5 rounded-full bg-amber-500" />
      )}
      {s.label}
    </span>
  );
}

/** The scope icon of a headline context ("Ventas · Team" → Users), from its tag after " · ". */
export function contextIcon(context: string | null | undefined): LucideIcon {
  const tag = context?.split(" · ").at(-1);
  switch (tag) {
    case "Private":
      return Lock;
    case "Bot":
      return Bot;
    case "Everyone":
      return Globe;
    case "Department":
      return Building2;
    case "Project":
      return FolderKanban;
    default:
      return Users;
  }
}

// ---------------------------------------------------------------- the page states

const SECTION_TITLE = "font-semibold text-muted-foreground text-xs uppercase tracking-wider";

function ReviewSkeleton() {
  return (
    <div
      data-testid="proposal-loading"
      aria-busy
      className="mx-auto grid w-full max-w-[880px] gap-6 px-6 py-6"
    >
      <div className="grid gap-2">
        <Skeleton className="h-6 w-2/3 motion-reduce:animate-none" />
        <Skeleton className="h-3.5 w-1/2 motion-reduce:animate-none" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-20 motion-reduce:animate-none" />
        <Skeleton className="h-20 motion-reduce:animate-none" />
      </div>
      <Skeleton className="h-48 motion-reduce:animate-none" />
    </div>
  );
}

function BackBar({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-1 border-b px-1">
      <Button variant="ghost" size="icon" className="size-11" aria-label={label} onClick={onBack}>
        <ArrowLeft />
      </Button>
      <span className="truncate font-semibold text-[15px]">Proposal</span>
    </div>
  );
}

export interface ProposalReviewProps {
  id: string;
  /** Below 1024: a full screen with "Back to proposals" and a bottom action bar. */
  stacked: boolean;
  onBack?: () => void;
  /** The inbox link this review belongs to (Back to proposals target). */
  inboxHref: string;
  /** Polite announcements (decisions made here or elsewhere). */
  announce: (text: string) => void;
}

export function ProposalReview({ id, stacked, onBack, inboxHref, announce }: ProposalReviewProps) {
  const q = useApproval(id);
  const back = stacked && onBack ? <BackBar onBack={onBack} label="Back to proposals" /> : null;
  if (q.isPending) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {back}
        <ReviewSkeleton />
      </div>
    );
  }
  if (q.isError) {
    const missing = isApiError(q.error, 404) || isApiError(q.error, 400);
    return (
      <div
        data-testid="proposal-review"
        data-state={missing ? "not-found" : "error"}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {back}
        {missing ? (
          <EmptyState icon={Inbox} title="This proposal doesn't exist or you can't open it" description="">
            <Link href={inboxHref} className={cn(buttonVariants({ variant: "outline" }), "max-lg:h-11")}>
              Back to proposals
            </Link>
          </EmptyState>
        ) : (
          <EmptyState icon={Inbox} title="Couldn't open this proposal." description="">
            <Button variant="outline" className="max-lg:h-11" onClick={() => void q.refetch()}>
              <RotateCcw /> Try again
            </Button>
          </EmptyState>
        )}
      </div>
    );
  }
  const detail = q.data;
  return detail.view.type === "memory_proposal" ? (
    <MemoryProposalReview
      key={detail.id}
      detail={detail}
      view={detail.view.proposal}
      stacked={stacked}
      back={back}
      refetch={() => q.refetch()}
      announce={announce}
    />
  ) : (
    <FieldsReview detail={detail} title={detail.view.title} fields={detail.view.fields} back={back} />
  );
}

/** The generic view any later kind can use: a title and label/value rows. */
function FieldsReview({
  detail,
  title,
  fields,
  back,
}: {
  detail: ApprovalDetail;
  title: string;
  fields: readonly { label: string; value: string }[];
  back: ReactNode;
}) {
  return (
    <div
      data-testid="proposal-review"
      data-status={detail.status}
      data-view="fields"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {back}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <article className="mx-auto grid w-full max-w-[880px] gap-6 px-6 py-6 max-md:px-4">
          <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
            <h1 tabIndex={-1} className="min-w-0 break-words font-semibold text-lg outline-none">
              {title}
            </h1>
            <StatusPill status={detail.status} />
          </header>
          {fields.length > 0 ? (
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
              {fields.map((f) => (
                <div key={f.label} className="contents">
                  <dt className="text-muted-foreground text-xs">{f.label}</dt>
                  <dd className="break-words text-sm">{f.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </article>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the memory proposal review

/** Offsets of whole lines (1-based) in `text`, for findings without spans (Presidio, by line). */
export function lineRanges(text: string, lines: readonly number[]): { start: number; end: number }[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  const out: { start: number; end: number }[] = [];
  for (const n of lines) {
    const start = starts[n - 1];
    if (start === undefined) continue;
    const next = starts[n];
    const end = next === undefined ? text.length : next - 1;
    if (end > start) out.push({ start, end });
  }
  return out;
}

/**
 * What the diff highlights: the view's spans (offsets into `proposed`, UI-SPEC R5) plus, for any listed finding kind
 * that has no span (a Presidio entity is reported by line), its whole lines (the line-level fallback).
 */
export function highlightRanges(view: Pick<MemoryProposalView, "spans" | "findings" | "proposed">) {
  const spanKinds = new Set(view.spans.map((s) => s.kind));
  const fallback = listedFindings(view.findings)
    .filter((f) => !spanKinds.has(f.kind))
    .flatMap((f) => lineRanges(view.proposed, f.lines));
  return [...view.spans.map(({ start, end }) => ({ start, end })), ...fallback];
}

type Notice = { kind: "changed" } | { kind: "error"; text: string };

function FactCell({
  icon: Icon,
  value,
  label,
  tone,
  testId,
}: {
  icon: LucideIcon;
  value: ReactNode;
  label: ReactNode;
  tone?: "warning";
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "flex min-w-0 gap-3 rounded-lg border bg-card p-4 shadow-xs dark:shadow-none max-sm:min-h-14 max-sm:items-center max-sm:px-4 max-sm:py-2",
        tone === "warning" &&
          "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200",
      )}
    >
      <Icon
        aria-hidden
        className={cn("mt-1 size-4 shrink-0 max-sm:mt-0", tone ? "" : "text-muted-foreground")}
      />
      <p className="grid min-w-0 gap-0.5 max-sm:flex max-sm:flex-wrap max-sm:items-baseline max-sm:gap-x-1.5 sm:gap-1">
        <span className="font-semibold text-lg leading-7 max-sm:text-[15px] max-sm:leading-5">{value}</span>
        <span className={cn("text-xs", tone ? "" : "text-muted-foreground")}>{label}</span>
      </p>
    </div>
  );
}

function MemoryProposalReview({
  detail,
  view,
  stacked,
  back,
  refetch,
  announce,
}: {
  detail: ApprovalDetail;
  view: MemoryProposalView;
  stacked: boolean;
  back: ReactNode;
  refetch: () => Promise<unknown>;
  announce: (text: string) => void;
}) {
  const me = useMe({ enabled: false }).data?.user.id ?? null;
  const decide = useDecideApproval();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [asking, setAsking] = useState<"approved" | "denied" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [focus, setFocus] = useState<{
    line: number;
    ranges: { start: number; end: number }[];
    nonce: number;
  } | null>(null);
  const decidedHere = useRef(false);
  const status = detail.status;
  const bot = view.requestedBy.agent.displayName;
  const person = view.requestedBy.forUser.displayName;
  const title = detail.headline?.title ?? view.path;
  const context = detail.headline?.context ?? view.scope.label;
  const ContextIcon = contextIcon(detail.headline?.context);
  const requester = detail.headline?.requester ?? `${bot} for ${person}`;
  const privateScope = isPrivateScope(view.scope.kind);
  const isRequester = me !== null && detail.requestedBy.userId === me;
  const mayDecide = detail.viewerCan.includes("decide") && status === "pending";
  const blocked = view.findings.some((f) => f.severity === "block");
  const findings = listedFindings(view.findings);
  const highlights = useMemo(() => highlightRanges(view), [view]);

  // A decision made elsewhere (the chat card, another reviewer) arrives live: say so politely.
  const lastStatus = useRef(status);
  useEffect(() => {
    if (lastStatus.current === status) return;
    const was = lastStatus.current;
    lastStatus.current = status;
    if (decidedHere.current || was !== "pending" || !detail.decidedBy) return;
    const verb = status === "denied" ? "Denied" : "Approved";
    announce(`${verb} by ${detail.decidedBy.displayName}.`);
  }, [status, detail.decidedBy, announce]);

  // A pending proposal turns Expired by the clock, not by an event: read it again when it does.
  useEffect(() => {
    if (status !== "pending") return;
    const left = new Date(detail.expiresAt).getTime() - Date.now();
    if (left > 24 * 60 * 60 * 1000) return;
    const t = window.setTimeout(() => void refetch(), Math.max(0, left) + 1000);
    return () => window.clearTimeout(t);
  }, [status, detail.expiresAt, refetch]);

  const onFinding = (f: SensitiveFinding) => {
    const spans = view.spans.filter((s) => s.kind === f.kind).map(({ start, end }) => ({ start, end }));
    const ranges = spans.length > 0 ? spans : lineRanges(view.proposed, f.lines);
    setFocus((prev) => ({ line: f.lines[0] ?? 1, ranges, nonce: (prev?.nonce ?? 0) + 1 }));
  };

  const confirm = async (outcome: "approved" | "denied", note: string) => {
    decidedHere.current = true;
    try {
      const result = await decide.mutateAsync({
        id: detail.id,
        outcome,
        actionHash: detail.actionHash,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setAsking(null);
      setNotice(null);
      if (result.status === "applied") toast.success(`Applied to ${view.path}`);
      else if (result.status === "denied") toast("Proposal denied");
      else if (result.status === "failed") toast.error(failedReason(result.resultCode, bot));
      announce(
        result.status === "applied"
          ? `Applied to ${view.path}.`
          : result.status === "denied"
            ? "Proposal denied."
            : failedReason(result.resultCode, bot),
      );
      await refetch();
      headingRef.current?.focus();
    } catch (err) {
      setAsking(null);
      decidedHere.current = false;
      if (isApiError(err, 409) && err.code === "approval_action_changed") {
        setNotice({ kind: "changed" });
      } else if (isApiError(err, 409) || isApiError(err, 403)) {
        setNotice({ kind: "error", text: decisionErrorText(err, isRequester) });
        void refetch();
      } else {
        toast.error(decisionErrorText(err, isRequester));
      }
    }
  };

  const age = proposalAge(detail.createdAt);
  const diffBefore =
    view.op === "create"
      ? "New file"
      : `Version ${view.baseVersion ?? 1}${view.baseVersion === view.currentVersion ? " (current)" : ""}`;

  return (
    <div
      data-testid="proposal-review"
      data-status={status}
      data-view="memory_proposal"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {back}
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="proposal-scroll">
        <article className="mx-auto grid w-full min-w-0 max-w-[880px] gap-6 px-6 py-6 max-md:px-4">
          <header className="grid min-w-0 gap-2">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <h1
                ref={headingRef}
                tabIndex={-1}
                data-testid="proposal-title"
                className="min-w-0 break-words rounded-sm font-semibold text-lg leading-7 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
              >
                {title}
              </h1>
              <StatusPill status={status} className="mt-0.5" />
            </div>
            <p
              data-testid="proposal-meta"
              className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground text-xs"
            >
              {/* Each item keeps its separator, so a wrapped line never starts with "·". */}
              <span className="inline-flex items-center gap-1.5">
                <ContextIcon aria-hidden className="size-3.5 shrink-0" />
                <span>{context}</span>
                <span aria-hidden>·</span>
              </span>
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Bot aria-hidden className="size-3.5 shrink-0" />
                <span data-testid="proposal-requester">{requester}</span>
                <span aria-hidden>·</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <time dateTime={detail.createdAt}>{age}</time>
                {status === "pending" ? <span aria-hidden>·</span> : null}
              </span>
              {status === "pending" ? <span>{expiresText(detail.expiresAt)}</span> : null}
            </p>
          </header>

          {status === "failed" ? (
            <p
              data-testid="proposal-failed-reason"
              className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800 text-sm dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-300"
            >
              <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 break-words">{failedReason(detail.resultCode, bot)}</span>
            </p>
          ) : null}

          {notice ? (
            <div
              role="alert"
              data-testid="proposal-notice"
              data-kind={notice.kind}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 text-sm dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200"
            >
              <TriangleAlert aria-hidden className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                {notice.kind === "changed"
                  ? "This proposal changed while you were reviewing it."
                  : notice.text}
              </span>
              {notice.kind === "changed" ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="max-lg:h-11"
                  data-testid="proposal-reload"
                  onClick={() => {
                    setNotice(null);
                    void refetch();
                  }}
                >
                  <RotateCcw /> Reload
                </Button>
              ) : null}
            </div>
          ) : null}

          <section
            aria-label="Summary"
            data-testid="proposal-facts"
            className={cn("grid gap-3", view.tainted ? "sm:grid-cols-3" : "sm:grid-cols-2")}
          >
            <FactCell
              testId="proposal-readers"
              icon={privateScope ? Lock : Users}
              value={privateScope ? "Only you" : view.readerCount}
              label={
                privateScope
                  ? "will see this"
                  : view.readerCount === 1
                    ? "person will see this"
                    : "people will see this"
              }
            />
            <FactCell
              testId="proposal-found"
              icon={ScanSearch}
              value={
                findings.length === 0
                  ? "Nothing found"
                  : `${findings.length} ${findings.length === 1 ? "finding" : "findings"}`
              }
              label={
                findings.length === 0
                  ? "No sensitive data found"
                  : [...new Set(findings.map((f) => FINDING_LABEL[f.kind]))].join(" · ")
              }
            />
            {view.tainted ? (
              <FactCell
                testId="proposal-tainted"
                icon={Globe}
                tone="warning"
                value="Used web content"
                label={`${bot} read web or tool content in this turn. Check facts and links before approving.`}
              />
            ) : null}
          </section>

          {view.reason ? (
            <section aria-labelledby="proposal-note-title" className="grid gap-2">
              <h2
                id="proposal-note-title"
                className="flex items-center gap-1.5 font-semibold text-muted-foreground text-xs"
              >
                <Quote aria-hidden className="size-3.5" />
                Bot's note
              </h2>
              <p
                data-testid="proposal-reason"
                className="whitespace-pre-wrap break-words border-border border-l-2 pl-3 text-sm"
              >
                {view.reason}
              </p>
            </section>
          ) : null}

          <section aria-labelledby="proposal-findings-title" className="grid gap-2">
            <h2 id="proposal-findings-title" className={SECTION_TITLE}>
              Sensitive data
            </h2>
            <FindingsList findings={view.findings} onSelect={onFinding} />
          </section>

          <section aria-labelledby="proposal-changes-title" className="grid min-w-0 gap-2">
            <div className="flex items-center gap-3">
              <h2 id="proposal-changes-title" className={SECTION_TITLE}>
                Changes
              </h2>
              <Counts added={view.linesAdded} removed={view.linesRemoved} />
              {view.op === "create" ? <span className="text-muted-foreground text-xs">New file</span> : null}
            </div>
            <div className="overflow-hidden rounded-lg border">
              <MemoryDiff
                before={{ label: diffBefore, doc: view.base ?? "" }}
                after={{ label: "Proposed", doc: view.proposed }}
                label={
                  view.op === "create"
                    ? `New file ${view.path}`
                    : `Changes from version ${view.baseVersion ?? 1} to the proposed text`
                }
                summary={`${view.linesAdded} ${view.linesAdded === 1 ? "line" : "lines"} added, ${view.linesRemoved} removed`}
                highlights={highlights}
                focus={focus}
                layout={view.op === "create" ? "unified" : "auto"}
                className="max-h-[32rem]"
              />
            </div>
          </section>
        </article>
      </div>

      <ReviewFooter
        detail={detail}
        view={view}
        stacked={stacked}
        mayDecide={mayDecide}
        blocked={blocked}
        isRequester={isRequester}
        privateScope={privateScope}
        onAsk={setAsking}
      />

      <ConfirmDecision
        outcome={asking}
        view={view}
        title={title}
        busy={decide.isPending}
        decidingForSelf={view.requestedBy.forUser.id === me}
        onCancel={() => setAsking(null)}
        onConfirm={(o, note) => void confirm(o, note)}
      />
    </div>
  );
}

// ---------------------------------------------------------------- footer

function ReviewFooter({
  detail,
  view,
  stacked,
  mayDecide,
  blocked,
  isRequester,
  privateScope,
  onAsk,
}: {
  detail: ApprovalDetail;
  view: MemoryProposalView;
  stacked: boolean;
  mayDecide: boolean;
  blocked: boolean;
  isRequester: boolean;
  privateScope: boolean;
  onAsk: (o: "approved" | "denied") => void;
}) {
  const status = detail.status;
  const bar = cn(
    "shrink-0 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80",
    stacked ? "px-4 pt-3 pb-[max(env(safe-area-inset-bottom),12px)]" : "",
  );
  /** Desktop: the footer's content lines up with the review column (max 880, px-6). */
  const inner = stacked ? "" : "mx-auto w-full max-w-[880px] px-6";
  if (status === "pending" && mayDecide) {
    const approve = (
      <Button
        data-testid="proposal-approve"
        className={cn("max-lg:h-11", stacked && "flex-1")}
        aria-disabled={blocked || undefined}
        onClick={() => !blocked && onAsk("approved")}
      >
        <Check /> Approve…
      </Button>
    );
    return (
      <div data-testid="proposal-footer" data-state="decide" className={bar}>
        <div className={cn("flex items-center gap-2", stacked ? "min-h-11" : "h-16 justify-end", inner)}>
          <Button
            variant="outline"
            data-testid="proposal-deny"
            className={cn("max-lg:h-11", stacked && "flex-1")}
            onClick={() => onAsk("denied")}
          >
            <X /> Deny…
          </Button>
          {blocked ? (
            <Tooltip content="This change contains a secret and can't be applied.">{approve}</Tooltip>
          ) : (
            approve
          )}
        </div>
      </div>
    );
  }
  let body: ReactNode;
  if (status === "pending") {
    body = (
      <p data-testid="proposal-waiting" className="text-muted-foreground text-sm">
        {isRequester && !privateScope
          ? "Waiting for a reviewer. You can't approve your own proposal."
          : "Waiting for a reviewer"}
      </p>
    );
  } else if (status === "approved") {
    body = (
      <p className="flex items-center gap-2 text-sm">
        <Spinner /> Applying…
      </p>
    );
  } else if (status === "expired") {
    body = (
      <p data-testid="proposal-decision" className="flex items-center gap-1.5 text-muted-foreground text-sm">
        <Hourglass aria-hidden className="size-4 shrink-0" />
        Expired {shortDate(detail.expiresAt)}. Nothing was changed.
      </p>
    );
  } else {
    body = <DecisionLine detail={detail} view={view} />;
  }
  return (
    <div data-testid="proposal-footer" data-state="decided" className={bar}>
      <div className={cn("flex min-h-16 items-center py-3", stacked && "min-h-11 py-0", inner)}>{body}</div>
    </div>
  );
}

function DecisionLine({ detail, view }: { detail: ApprovalDetail; view: MemoryProposalView }) {
  const by = detail.decidedBy?.displayName ?? "a reviewer";
  const at = detail.decidedAt ? decisionDate(detail.decidedAt) : null;
  const approved = detail.status === "applied" || detail.status === "failed";
  const Icon = approved ? CircleCheck : CircleX;
  return (
    <div className="grid min-w-0 gap-1" data-testid="proposal-decision" data-status={detail.status}>
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm">
        <Icon
          aria-hidden
          className={cn(
            "size-4 shrink-0",
            approved ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground",
          )}
        />
        <span className="font-medium">
          {approved ? "Approved" : "Denied"} by {by}
        </span>
        {at ? (
          <>
            <span aria-hidden className="text-muted-foreground">
              ·
            </span>
            <time dateTime={detail.decidedAt ?? undefined} className="text-muted-foreground">
              {at}
            </time>
          </>
        ) : null}
        {detail.status === "applied" ? (
          <>
            <span aria-hidden className="text-muted-foreground">
              ·
            </span>
            <span className="text-muted-foreground">Applied as version {view.currentVersion ?? 1}</span>
            <span aria-hidden className="text-muted-foreground">
              ·
            </span>
            <Link
              href={memoryHref(view.scope.id, view.path)}
              data-testid="proposal-open-file"
              className="inline-flex items-center gap-0.5 rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/40"
            >
              Open file <ArrowUpRight aria-hidden className="size-3.5" />
            </Link>
          </>
        ) : null}
      </p>
      {detail.decisionNote ? (
        <p data-testid="proposal-decision-note" className="break-words text-muted-foreground text-xs">
          “{detail.decisionNote}”
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- confirmation

function ConfirmDecision({
  outcome,
  view,
  title,
  busy,
  decidingForSelf,
  onCancel,
  onConfirm,
}: {
  outcome: "approved" | "denied" | null;
  view: MemoryProposalView;
  title: string;
  busy: boolean;
  /** The decider is the person the bot acted for (their private memory): the deny copy names only the bot. */
  decidingForSelf: boolean;
  onCancel: () => void;
  onConfirm: (outcome: "approved" | "denied", note: string) => void;
}) {
  const noteId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [note, setNote] = useState("");
  const [shown, setShown] = useState<"approved" | "denied">("approved");
  useEffect(() => {
    if (outcome) {
      setShown(outcome);
      setNote("");
    }
  }, [outcome]);
  const approving = shown === "approved";
  const bot = view.requestedBy.agent.displayName;
  const person = view.requestedBy.forUser.displayName;
  const counted = note.length >= 200;
  const where = scopeText(view);
  return (
    <Dialog open={outcome !== null} onOpenChange={(o) => !busy && !o && onCancel()}>
      <DialogContent data-testid="proposal-confirm" data-outcome={shown} initialFocus={cancelRef}>
        <DialogHeader>
          <DialogTitle>{approving ? "Approve and apply?" : "Deny this proposal?"}</DialogTitle>
          <DialogDescription>
            {approving
              ? `“${title}” is saved to ${where} as version ${nextVersion(view)}. ${readerSentence(view)}.`
              : `Nothing changes in ${where}. ${decidingForSelf ? `${bot} sees` : `${bot} and ${person} see`} that you denied it.`}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor={noteId}>Note (optional)</Label>
          <Textarea
            id={noteId}
            data-testid="proposal-note-input"
            value={note}
            maxLength={APPROVAL_NOTE_MAX}
            rows={3}
            className="min-h-20"
            placeholder={approving ? undefined : "Tell them why"}
            aria-describedby={counted ? `${noteId}-count` : undefined}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
          />
          {counted ? (
            <p
              id={`${noteId}-count`}
              data-testid="proposal-note-count"
              className="justify-self-end text-muted-foreground text-xs tabular-nums"
            >
              {note.length}/{APPROVAL_NOTE_MAX}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            ref={cancelRef}
            variant="outline"
            className="max-lg:h-11"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            variant={approving ? "default" : "destructive"}
            className="max-lg:h-11"
            disabled={busy}
            data-testid="proposal-confirm-submit"
            onClick={() => onConfirm(shown, note)}
          >
            {busy ? <Spinner /> : approving ? <Check /> : <X />}
            {approving ? "Approve and apply" : "Deny"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
