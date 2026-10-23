"use client";

import {
  APPROVAL_NOTE_MAX,
  type ApprovalDetail,
  type ApprovalOrigin,
  type ApprovalRequestStatus,
  type ToolCallApprovalView,
  type WorkZoneProposalView as WorkZoneProposal,
} from "@ocw/contracts";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleCheck,
  CircleSlash,
  CircleX,
  Hand,
  Hash,
  Hourglass,
  type LucideIcon,
  MessageSquare,
  Play,
  RotateCcw,
  TriangleAlert,
  X,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { PrincipalAvatar } from "@/components/chat/principal-avatar";
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
import { isApiError } from "@/lib/api";
import {
  decisionDate,
  MEMORY_KINDS,
  proposalAge,
  useApproval,
  useDecideApproval,
} from "@/lib/approval-queries";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useDevices } from "@/lib/workzone-queries";
import { browserNotUsedText, shortToolName, ToolCallView, waitingFor } from "./tool-call-view";
import {
  deviceStateOf,
  failedStartText,
  liveStartBlock,
  startBlockedText,
  WorkZoneProposalView,
} from "./work-zone-proposal-view";

export { approvalWho } from "./tool-call-view";

/**
 * One request's review in `/approvals` (Phase 07.5, D-03, D-04, APPROVE-02, APPROVE-03, UI-SPEC Surface 2): the header
 * (title, status pill, "{bot} for {person}", origin, age, expiry), the kind's body, and a sticky footer with the
 * decision, the waiting line or the decision line. Dispatches on `view.type`: `work_zone_proposal` (07.5-12) and
 * `tool_call` (07.5-13, `ToolCallView`). Every decision asks first and sends the hash of the view on screen (T-07.5-12-02); buttons follow
 * the API's `viewerCan` and `startBlocked`, and the API decides again (T-07.5-12-03). A request the viewer may not
 * open is the shared not-found state (T-07.5-12-04).
 */

// ---------------------------------------------------------------- copy

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Expires in 23 h" (≥ 1 h), "Expires in 12 min" (< 1 h), "Expired" (UI-SPEC "Timer"). */
export function expiresIn(iso: string, now: number = Date.now()): string {
  const left = new Date(iso).getTime() - now;
  if (left <= 0) return "Expired";
  if (left < HOUR) return `Expires in ${Math.max(1, Math.ceil(left / MINUTE))} min`;
  return `Expires in ${Math.floor(left / HOUR)} h`;
}

/** Minutes left when a pending request has under one hour, else null (the row's amber "Expires in {n} min"). */
export function expiringMinutes(iso: string, now: number = Date.now()): number | null {
  const left = new Date(iso).getTime() - now;
  if (left <= 0 || left >= HOUR) return null;
  return Math.max(1, Math.ceil(left / MINUTE));
}

/** "just now", "5 minutes ago", "2 hours ago", "3 days ago": the age as a row's accessible name says it. */
export function ageWords(iso: string, now: number = Date.now()): string {
  const ms = Math.max(0, now - new Date(iso).getTime());
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return unit(Math.floor(ms / MINUTE), "minute");
  if (ms < DAY) return unit(Math.floor(ms / HOUR), "hour");
  return unit(Math.floor(ms / DAY), "day");
}

/** Where the bot asked, short (rows): "ops", "DM", "Group DM", "AI chat". */
export function originText(origin: ApprovalOrigin | null | undefined): string | null {
  if (!origin) return null;
  switch (origin.kind) {
    case "dm":
      return "DM";
    case "group":
      return "Group DM";
    case "ai_chat":
      return "AI chat";
    default:
      return origin.name ?? "a channel";
  }
}

export const originIcon = (origin: ApprovalOrigin | null | undefined): LucideIcon =>
  origin?.kind === "channel" || origin?.kind === "thread" ? Hash : MessageSquare;

/** "Scout for you" when the viewer asked, else the server's "{bot} for {person}". */
export function requesterText(
  item: Pick<ApprovalDetail, "requestedBy" | "headline">,
  meId: string | null,
): string {
  const bot = item.headline?.agent?.displayName;
  if (bot && meId && item.requestedBy.userId === meId) return `${bot} for you`;
  return item.headline?.requester || item.requestedBy.displayName;
}

/**
 * The line a viewer who cannot decide sees (UI-SPEC "Non-decider footer"). "You can't approve your own request." is
 * added only when the viewer asked and the API gives them no decision right: self-approval follows the decision right
 * (ADR-0023 §15 as amended, 07.5-07), so a requester who holds it simply decides.
 */
export function waitingLine(
  detail: Pick<ApprovalDetail, "requestedBy" | "viewerCan">,
  meId: string | null,
  waitingFor: string,
): string {
  const own = meId !== null && detail.requestedBy.userId === meId;
  const base = `Waiting for ${waitingFor}.`;
  return own && !detail.viewerCan.includes("decide") ? `${base} You can't approve your own request.` : base;
}

// ---------------------------------------------------------------- status pill

type Pill = { label: string; tone: string; icon: LucideIcon | "dot" | "spinner" };

const TONE = {
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
  running: "bg-primary/10 text-primary dark:bg-primary/20 dark:text-blue-200",
  done: "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-400/15 dark:text-red-300",
  closed: "bg-muted text-muted-foreground",
} as const;

/**
 * The pill of a request (UI-SPEC "States", R6): Work Zone proposals read Proposed · Starting… · Started · Dismissed ·
 * Failed · Expired; actions Pending · Approved · Used · Not used (an approved grant past its use window) · Denied ·
 * Expired; any other kind the 07.2 labels.
 */
export function pillOf(
  kind: string,
  status: ApprovalRequestStatus,
  useBy: string | null | undefined = null,
  now: number = Date.now(),
): Pill {
  const wz = kind === "work_zone.start";
  const action = kind === "tool.call";
  switch (status) {
    case "pending":
      return { label: wz ? "Proposed" : "Pending", tone: TONE.pending, icon: "dot" };
    case "approved":
      if (wz) return { label: "Starting…", tone: TONE.running, icon: "spinner" };
      if (action && useBy && new Date(useBy).getTime() < now)
        return { label: "Not used", tone: TONE.closed, icon: Hourglass };
      return {
        label: "Approved",
        tone: action ? TONE.running : TONE.done,
        icon: action ? "dot" : CircleCheck,
      };
    case "applied":
      return { label: wz ? "Started" : action ? "Used" : "Applied", tone: TONE.done, icon: CircleCheck };
    case "denied":
      return wz
        ? { label: "Dismissed", tone: TONE.closed, icon: CircleSlash }
        : { label: "Denied", tone: TONE.closed, icon: CircleX };
    case "failed":
      return { label: "Failed", tone: TONE.failed, icon: CircleX };
    case "expired":
      return { label: "Expired", tone: TONE.closed, icon: Hourglass };
  }
}

export function ApprovalPill({
  kind,
  status,
  useBy,
  className,
  announce = false,
}: {
  kind: string;
  status: ApprovalRequestStatus;
  useBy?: string | null;
  className?: string;
  /** The review header's pill is a status (`role="status"`); row pills are plain text. */
  announce?: boolean;
}) {
  const p = pillOf(kind, status, useBy);
  const Icon = p.icon === "dot" || p.icon === "spinner" ? null : p.icon;
  return (
    <span
      data-testid="approval-status"
      data-status={status}
      {...(announce ? { role: "status", "aria-label": `Status: ${p.label}` } : {})}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 font-medium text-xs",
        p.tone,
        className,
      )}
    >
      {Icon ? (
        <Icon aria-hidden className="size-3.5 shrink-0" />
      ) : p.icon === "spinner" ? (
        <Spinner className="size-3.5" />
      ) : (
        <span
          aria-hidden
          className={cn(
            "inline-flex size-1.5 shrink-0 rounded-full",
            status === "pending" ? "bg-amber-500" : "bg-primary",
          )}
        />
      )}
      {p.label}
    </span>
  );
}

// ---------------------------------------------------------------- page states

const REVIEW_COLUMN = "mx-auto grid w-full min-w-0 max-w-[880px] gap-6 px-6 py-6 max-md:px-4";

function ReviewSkeleton() {
  return (
    <div data-testid="approval-loading" aria-busy className={REVIEW_COLUMN}>
      <div className="grid gap-2">
        <Skeleton className="h-6 w-2/3 motion-reduce:animate-none" />
        <Skeleton className="h-3.5 w-1/2 motion-reduce:animate-none" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-20 motion-reduce:animate-none" />
        <Skeleton className="h-20 motion-reduce:animate-none" />
      </div>
      <div className="grid gap-2">
        {["w-1/3", "w-2/3", "w-1/2", "w-3/4", "w-2/5", "w-3/5"].map((w) => (
          <Skeleton key={w} className={cn("h-3.5 motion-reduce:animate-none", w)} />
        ))}
      </div>
      <div className="grid gap-1.5 rounded-lg border p-4">
        {["w-1/4", "w-1/2", "w-2/3", "w-1/2", "w-3/5", "w-2/5", "w-1/3", "w-1/5"].map((w, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder lines
          <Skeleton key={`${w}-${i}`} className={cn("h-3 motion-reduce:animate-none", w)} />
        ))}
      </div>
    </div>
  );
}

/** The phone review's top bar: a 44 px "Back to approvals" and the section name (UI-SPEC "Phone at 390"). */
function BackBar({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-1 border-b px-1">
      <Button variant="ghost" size="icon" className="size-11" aria-label="Back to approvals" onClick={onBack}>
        <ArrowLeft />
      </Button>
      <span className="truncate font-semibold text-[15px]">Approvals</span>
    </div>
  );
}

export interface ApprovalReviewProps {
  id: string;
  /** Below 1024: a full screen with "Back to approvals" and a bottom action bar. */
  stacked: boolean;
  onBack?: () => void;
  /** The inbox this review belongs to (the not-found state's "Back to approvals"). */
  inboxHref: string;
  /** Polite announcements (decisions made here or elsewhere). */
  announce: (text: string) => void;
}

export function ApprovalReview({ id, stacked, onBack, inboxHref, announce }: ApprovalReviewProps) {
  const q = useApproval(id);
  const router = useRouter();
  const back = stacked && onBack ? <BackBar onBack={onBack} /> : null;
  const memory = q.data?.kind === MEMORY_KINDS;
  // A memory proposal is reviewed in Memory (UI-SPEC R1): its own inbox, scope tree and diff.
  useEffect(() => {
    if (memory) router.replace(`/memory/proposals/${encodeURIComponent(id)}`);
  }, [memory, id, router]);

  if (q.isPending || memory) {
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
        data-testid="approval-review"
        data-state={missing ? "not-found" : "error"}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {back}
        {missing ? (
          <EmptyState
            icon={Hand}
            title="This approval doesn't exist or you can't open it"
            description="It may have been removed, or it was meant for someone else."
          >
            <Link href={inboxHref} className={cn(buttonVariants({ variant: "outline" }), "max-lg:h-11")}>
              Back to approvals
            </Link>
          </EmptyState>
        ) : (
          <EmptyState icon={Hand} title="Couldn't open this approval." description="Check your connection.">
            <Button variant="outline" className="max-lg:h-11" onClick={() => void q.refetch()}>
              <RotateCcw /> Try again
            </Button>
          </EmptyState>
        )}
      </div>
    );
  }
  const detail = q.data;
  const refetch = () => q.refetch();
  if (detail.view.type === "work_zone_proposal") {
    return (
      <WorkZoneReview
        key={detail.id}
        detail={detail}
        view={detail.view}
        stacked={stacked}
        back={back}
        refetch={refetch}
        announce={announce}
      />
    );
  }
  if (detail.view.type === "tool_call") {
    return (
      <ToolCallReview
        key={detail.id}
        detail={detail}
        view={detail.view}
        stacked={stacked}
        back={back}
        refetch={refetch}
        announce={announce}
      />
    );
  }
  // Any other kind: the title and the generic fields.
  return (
    <ReviewFrame
      detail={detail}
      title={
        detail.view.type === "memory_proposal"
          ? (detail.headline?.title ?? detail.view.proposal.path)
          : detail.view.title
      }
      back={back}
      testId="approval-review"
      meta={<MetaLine detail={detail} origin={detail.headline?.origin ?? null} />}
      footer={null}
    >
      {detail.view.type === "fields" && detail.view.fields.length > 0 ? (
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
          {detail.view.fields.map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-muted-foreground text-xs">{f.label}</dt>
              <dd className="break-words text-sm">{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </ReviewFrame>
  );
}

// ---------------------------------------------------------------- the shared frame

function MetaLine({
  detail,
  origin,
  bot,
  originLong,
}: {
  detail: ApprovalDetail;
  origin: ApprovalOrigin | null;
  bot?: string;
  /** The review names a DM with its bot: "DM with Scout". */
  originLong?: string | null;
}) {
  const me = useMe({ enabled: false }).data?.user.id ?? null;
  const OriginIcon = originIcon(origin);
  const where = originLong ?? originText(origin);
  const agent = bot ?? detail.headline?.agent?.displayName ?? null;
  const items: ReactNode[] = [
    <span key="who" className="inline-flex min-w-0 items-center gap-1.5">
      {agent ? <PrincipalAvatar kind="agent" name={agent} className="size-5" /> : null}
      <span data-testid="approval-requester" className="min-w-0 break-words">
        {requesterText(detail, me)}
      </span>
    </span>,
  ];
  if (where) {
    items.push(
      <span key="where" className="inline-flex items-center gap-1">
        <OriginIcon aria-hidden className="size-3.5 shrink-0" />
        <span>{where}</span>
      </span>,
    );
  }
  items.push(
    <time key="age" dateTime={detail.createdAt}>
      {proposalAge(detail.createdAt)}
    </time>,
  );
  if (detail.status === "pending") items.push(<span key="exp">{expiresIn(detail.expiresAt)}</span>);
  return (
    <p
      data-testid="approval-meta"
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground text-xs"
    >
      {/* Each item keeps its separator, so a wrapped line never starts with "·". */}
      {items.map((item, i) => (
        <span key={(item as { key: string }).key} className="inline-flex min-w-0 items-center gap-1.5">
          {item}
          {i < items.length - 1 ? <span aria-hidden>·</span> : null}
        </span>
      ))}
    </p>
  );
}

function ReviewFrame({
  detail,
  title,
  back,
  meta,
  notice,
  children,
  footer,
  testId,
  headingRef,
}: {
  detail: ApprovalDetail;
  title: string;
  back: ReactNode;
  meta: ReactNode;
  notice?: ReactNode;
  children: ReactNode;
  footer: ReactNode;
  testId: string;
  headingRef?: React.Ref<HTMLHeadingElement>;
}) {
  return (
    <div
      data-testid={testId}
      data-review="approval"
      data-status={detail.status}
      data-kind={detail.kind}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {back}
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="approval-scroll">
        <article className={REVIEW_COLUMN}>
          <header className="grid min-w-0 gap-2">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <h1
                ref={headingRef}
                tabIndex={-1}
                data-testid="approval-title"
                className="min-w-0 break-words rounded-sm font-semibold text-lg leading-7 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
              >
                {title}
              </h1>
              <ApprovalPill
                kind={detail.kind}
                status={detail.status}
                useBy={detail.headline?.useBy ?? null}
                className="mt-0.5"
                announce
              />
            </div>
            {meta}
          </header>
          {notice}
          {children}
        </article>
      </div>
      {footer}
    </div>
  );
}

/** Desktop: content lined up with the 880 column; phone: a bottom bar with safe-area padding (UI-SPEC). */
function FooterBar({ stacked, state, children }: { stacked: boolean; state: string; children: ReactNode }) {
  return (
    <div
      data-testid="approval-footer"
      data-state={state}
      className={cn(
        "shrink-0 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80",
        stacked && "px-4 pt-3 pb-[max(env(safe-area-inset-bottom),12px)]",
      )}
    >
      <div className={cn(!stacked && "mx-auto w-full max-w-[880px] px-6")}>{children}</div>
    </div>
  );
}

export type Notice = { kind: "changed" } | { kind: "error"; text: string };

export function NoticeBox({ notice, onReload }: { notice: Notice; onReload: () => void }) {
  return (
    <div
      role="alert"
      data-testid="approval-notice"
      data-kind={notice.kind}
      className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 text-sm dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200"
    >
      <TriangleAlert aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {notice.kind === "changed" ? "This request changed while you were reviewing it." : notice.text}
      </span>
      {notice.kind === "changed" ? (
        <Button size="sm" variant="outline" className="max-lg:h-11" onClick={onReload}>
          <RotateCcw /> Reload
        </Button>
      ) : null}
    </div>
  );
}

/** The decision errors in words (UI-SPEC "Decision errors"); never an API code. */
export function decisionError(err: unknown): string {
  if (isApiError(err)) {
    switch (err.code) {
      case "approval_already_decided":
        return "Someone already decided this.";
      case "approval_expired":
        return "This request expired.";
      case "not_approver":
        return "You can't decide this request.";
    }
  }
  return "Couldn't save the decision. Try again.";
}

/**
 * The notice a failed decision leaves on the review (UI-SPEC "Decision errors"): a changed request asks for Reload and
 * never decides by itself (07.2 R4); a request decided elsewhere, expired or no longer the viewer's says so; anything
 * else is a toast (null).
 */
export function decisionNoticeOf(err: unknown): Notice | null {
  if (isApiError(err, 409) && err.code === "approval_action_changed") return { kind: "changed" };
  if (isApiError(err, 409) || isApiError(err, 403)) return { kind: "error", text: decisionError(err) };
  return null;
}

// ---------------------------------------------------------------- Work Zone proposal

function WorkZoneReview({
  detail,
  view,
  stacked,
  back,
  refetch,
  announce,
}: {
  detail: ApprovalDetail;
  view: WorkZoneProposal;
  stacked: boolean;
  back: ReactNode;
  refetch: () => Promise<unknown>;
  announce: (text: string) => void;
}) {
  const me = useMe({ enabled: false }).data?.user.id ?? null;
  const devices = useDevices();
  const decide = useDecideApproval();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openRef = useRef<HTMLAnchorElement>(null);
  const [asking, setAsking] = useState<"approved" | "denied" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const decidedHere = useRef(false);
  const status = detail.status;
  const bot = view.agent.displayName;
  const canDecide = detail.viewerCan.includes("decide");

  const live = devices.data?.find((d) => d.id === view.device.id) ?? null;
  const device = deviceStateOf(view, live, devices.isSuccess);
  const blocked = status === "pending" ? liveStartBlock(view, device, canDecide) : null;

  // The device's presence changed (org stream → `useDevices`): read the view again so `startBlocked` is the API's.
  const liveStatus = live?.status ?? null;
  const lastLive = useRef(liveStatus);
  useEffect(() => {
    if (lastLive.current === liveStatus) return;
    lastLive.current = liveStatus;
    if (status === "pending") void refetch();
  }, [liveStatus, status, refetch]);

  // A decision made elsewhere (the card, another tab) arrives live: say so politely.
  const lastStatus = useRef(status);
  useEffect(() => {
    if (lastStatus.current === status) return;
    const was = lastStatus.current;
    lastStatus.current = status;
    if (decidedHere.current || was !== "pending") return;
    const by = detail.decidedBy ? (detail.decidedBy.id === me ? "you" : detail.decidedBy.displayName) : null;
    if (status === "applied" || status === "approved") announce(by ? `Started by ${by}.` : "Started.");
    else if (status === "denied") announce(by ? `Dismissed by ${by}.` : "Dismissed.");
    else if (status === "failed") announce(failedStartText(detail.resultCode, view));
    else if (status === "expired") announce("No one started it within 24 hours.");
  }, [status, detail.decidedBy, detail.resultCode, me, view, announce]);

  // A pending proposal turns Expired by the clock, not by an event.
  useEffect(() => {
    if (status !== "pending") return;
    const left = new Date(detail.expiresAt).getTime() - Date.now();
    if (left > DAY) return;
    const t = window.setTimeout(() => void refetch(), Math.max(0, left) + 1000);
    return () => window.clearTimeout(t);
  }, [status, detail.expiresAt, refetch]);

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
      let said: string;
      if (result.status === "applied" || result.status === "approved") {
        said = `Session started on ${view.device.name}`;
        toast.success(said);
      } else if (result.status === "denied") {
        said = "Proposal dismissed";
        toast(said);
      } else {
        said = failedStartText(result.resultCode, view);
        toast.error(said);
      }
      announce(`${said}.`);
      await refetch();
      // After Start the next step is the session: focus Open session; otherwise the heading.
      window.setTimeout(() => (openRef.current ?? headingRef.current)?.focus(), 0);
    } catch (err) {
      setAsking(null);
      decidedHere.current = false;
      if (isApiError(err, 409) && err.code === "approval_action_changed") {
        setNotice({ kind: "changed" });
      } else if (isApiError(err, 409) || isApiError(err, 403)) {
        setNotice({ kind: "error", text: decisionError(err) });
        void refetch();
      } else {
        toast.error(decisionError(err));
      }
    }
  };

  const noticeNode = (
    <>
      {status === "failed" ? (
        <p
          role="alert"
          data-testid="approval-failed-reason"
          className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800 text-sm dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-300"
        >
          <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">{failedStartText(detail.resultCode, view)}</span>
        </p>
      ) : null}
      {notice ? (
        <NoticeBox
          notice={notice}
          onReload={() => {
            setNotice(null);
            void refetch();
          }}
        />
      ) : null}
    </>
  );

  return (
    <>
      <ReviewFrame
        detail={detail}
        title={view.title}
        back={back}
        testId="work-zone-proposal-view"
        headingRef={headingRef}
        meta={
          <MetaLine
            detail={detail}
            origin={view.origin}
            bot={bot}
            originLong={view.origin?.kind === "dm" ? `DM with ${bot}` : null}
          />
        }
        notice={noticeNode}
        footer={
          <WorkZoneFooter
            detail={detail}
            view={view}
            stacked={stacked}
            canDecide={canDecide}
            blocked={blocked}
            meId={me}
            openRef={openRef}
            onAsk={setAsking}
          />
        }
      >
        <WorkZoneProposalView view={view} device={device} />
      </ReviewFrame>
      <ConfirmWorkZone
        outcome={asking}
        view={view}
        busy={decide.isPending}
        onCancel={() => setAsking(null)}
        onConfirm={(o, note) => void confirm(o, note)}
      />
    </>
  );
}

function WorkZoneFooter({
  detail,
  view,
  stacked,
  canDecide,
  blocked,
  meId,
  openRef,
  onAsk,
}: {
  detail: ApprovalDetail;
  view: WorkZoneProposal;
  stacked: boolean;
  canDecide: boolean;
  blocked: ReturnType<typeof liveStartBlock>;
  meId: string | null;
  openRef: React.Ref<HTMLAnchorElement>;
  onAsk: (o: "approved" | "denied") => void;
}) {
  const reasonId = useId();
  const status = detail.status;
  const bot = view.agent.displayName;

  if (status === "pending" && (canDecide || blocked === "not_allowed")) {
    const reason = blocked ? (
      <p
        id={reasonId}
        data-testid="work-zone-start-blocked"
        data-reason={blocked}
        className={cn("min-w-0 text-muted-foreground text-xs", !stacked && "flex-1")}
      >
        {startBlockedText(blocked, view)}
      </p>
    ) : null;
    const buttons = (
      <>
        <Button
          variant="outline"
          data-testid="work-zone-dismiss"
          className={cn("max-lg:h-11", stacked && "flex-1")}
          disabled={!canDecide}
          onClick={() => onAsk("denied")}
        >
          <X /> Dismiss…
        </Button>
        <Button
          data-testid="work-zone-start"
          // Focusable and described while unavailable (UI-SPEC), but it must look unavailable too.
          className={cn(
            "max-lg:h-11 aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
            stacked && "flex-1",
          )}
          aria-disabled={blocked ? true : undefined}
          aria-describedby={blocked ? reasonId : undefined}
          onClick={() => !blocked && onAsk("approved")}
        >
          <Play /> Start session…
        </Button>
      </>
    );
    return (
      <FooterBar stacked={stacked} state="decide">
        {stacked ? (
          <div className="grid gap-2">
            {reason}
            <div className="flex min-h-11 items-center gap-2">{buttons}</div>
          </div>
        ) : (
          <div className="flex h-16 items-center justify-end gap-2">
            {reason}
            {buttons}
          </div>
        )}
      </FooterBar>
    );
  }

  let body: ReactNode;
  if (status === "pending") {
    body = (
      <p data-testid="approval-waiting" className="text-muted-foreground text-sm">
        Only {view.requestedFor.displayName} can start this session.
      </p>
    );
  } else if (status === "approved") {
    body = (
      <p className="flex items-center gap-2 text-sm">
        <Spinner /> Starting…
      </p>
    );
  } else if (status === "applied") {
    const by = detail.decidedBy
      ? detail.decidedBy.id === meId
        ? "you"
        : detail.decidedBy.displayName
      : "you";
    body = (
      <div className={cn("flex min-w-0 flex-wrap items-center gap-3", !stacked && "w-full justify-between")}>
        <DecisionText icon={CircleCheck} tone="done" text={`Started by ${by}`} at={detail.decidedAt} />
        {view.workSessionId ? (
          <Link
            ref={openRef}
            href={`/work-zone/${view.workSessionId}`}
            data-testid="work-zone-open-session"
            className={cn(buttonVariants(), "max-lg:h-11", stacked && "w-full")}
          >
            Open session <ArrowRight />
          </Link>
        ) : null}
      </div>
    );
  } else if (status === "denied") {
    const by = detail.decidedBy
      ? detail.decidedBy.id === meId
        ? "you"
        : detail.decidedBy.displayName
      : "you";
    body = (
      <div className="grid min-w-0 gap-1">
        <DecisionText icon={CircleSlash} text={`Dismissed by ${by}`} at={detail.decidedAt} />
        {detail.decisionNote ? (
          <p data-testid="approval-decision-note" className="break-words text-muted-foreground text-xs">
            “{detail.decisionNote}”
          </p>
        ) : null}
      </div>
    );
  } else if (status === "failed") {
    body = (
      <p data-testid="approval-decision-line" data-status="failed" className="text-muted-foreground text-xs">
        Ask {bot} again when it's fixed.
      </p>
    );
  } else {
    body = (
      <p
        data-testid="approval-decision-line"
        data-status="expired"
        className="flex items-center gap-1.5 text-muted-foreground text-sm"
      >
        <Hourglass aria-hidden className="size-4 shrink-0" />
        No one started it within 24 hours.
      </p>
    );
  }
  return (
    <FooterBar stacked={stacked} state="decided">
      <div className={cn("flex min-h-16 items-center py-3", stacked && "min-h-11 py-0")}>{body}</div>
    </FooterBar>
  );
}

function DecisionText({
  icon: Icon,
  text,
  at,
  tone,
  after,
}: {
  icon: LucideIcon;
  text: string;
  at: string | null;
  tone?: "done";
  /** More of the same line ("Used at 10:33"), after the date. */
  after?: string | null;
}) {
  return (
    <p
      data-testid="approval-decision-line"
      tabIndex={-1}
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm outline-none"
    >
      <Icon
        aria-hidden
        className={cn(
          "size-4 shrink-0",
          tone === "done" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground",
        )}
      />
      <span className="font-medium">{text}</span>
      {at ? (
        <>
          <span aria-hidden className="text-muted-foreground">
            ·
          </span>
          <time dateTime={at} className="text-muted-foreground">
            {decisionDate(at)}
          </time>
        </>
      ) : null}
      {after ? (
        <>
          <span aria-hidden className="text-muted-foreground">
            ·
          </span>
          <span className="text-muted-foreground">{after}</span>
        </>
      ) : null}
    </p>
  );
}

function ConfirmWorkZone({
  outcome,
  view,
  busy,
  onCancel,
  onConfirm,
}: {
  outcome: "approved" | "denied" | null;
  view: WorkZoneProposal;
  busy: boolean;
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
  const starting = shown === "approved";
  const bot = view.agent.displayName;
  const counted = note.length >= 200;
  return (
    <Dialog open={outcome !== null} onOpenChange={(o) => !busy && !o && onCancel()}>
      <DialogContent data-testid="approval-confirm" data-outcome={shown} initialFocus={cancelRef}>
        <DialogHeader>
          <DialogTitle>{starting ? "Start this session?" : "Dismiss this proposal?"}</DialogTitle>
          <DialogDescription>
            {starting
              ? `${view.runtime.label} runs ${bot}'s prompt in ${view.project.name} on ${view.device.name}, as you. It starts in Supervised mode: it asks before edits and commands.`
              : `No session starts. ${bot} is told you dismissed it.`}
          </DialogDescription>
        </DialogHeader>
        {starting ? null : (
          <div className="grid gap-2">
            <Label htmlFor={noteId}>Note (optional)</Label>
            <Textarea
              id={noteId}
              data-testid="approval-note-input"
              value={note}
              maxLength={APPROVAL_NOTE_MAX}
              rows={3}
              className="min-h-20"
              placeholder="Tell them why"
              aria-describedby={counted ? `${noteId}-count` : undefined}
              disabled={busy}
              onChange={(e) => setNote(e.target.value)}
            />
            {counted ? (
              <p
                id={`${noteId}-count`}
                className="justify-self-end text-muted-foreground text-xs tabular-nums"
              >
                {note.length}/{APPROVAL_NOTE_MAX}
              </p>
            ) : null}
          </div>
        )}
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
            variant={starting ? "default" : "destructive"}
            className="max-lg:h-11"
            disabled={busy}
            data-testid="approval-confirm-submit"
            onClick={() => onConfirm(shown, note)}
          >
            {busy ? <Spinner /> : starting ? <Play /> : <X />}
            {starting ? "Start session" : "Dismiss"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- action (tool call)

const timeFmt = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" });
/** "10:33 AM". */
const timeOf = (iso: string) => timeFmt.format(new Date(iso));

/** "It runs with your account." and its variants: whose credential the call uses (UI-SPEC Decision dialogs). */
export function runsWithText(view: ToolCallApprovalView, meId: string | null): string {
  const mine = meId !== null && view.requestedFor.id === meId;
  const requester = view.requestedFor.displayName;
  switch (view.source.account) {
    case "requester":
      return mine ? "It runs with your account." : `It runs with ${requester}'s account.`;
    case "org":
      return "It runs with the organization's account.";
    default:
      return mine ? "It runs for you." : `It runs for ${requester}.`;
  }
}

function ToolCallReview({
  detail,
  view,
  stacked,
  back,
  refetch,
  announce,
}: {
  detail: ApprovalDetail;
  view: ToolCallApprovalView;
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
  const decidedHere = useRef(false);
  const status = detail.status;
  const bot = view.agent.displayName;
  const canDecide = detail.viewerCan.includes("decide");

  // A decision made elsewhere (the card, another tab, another approver) arrives live: say so politely.
  const lastStatus = useRef(status);
  useEffect(() => {
    if (lastStatus.current === status) return;
    const was = lastStatus.current;
    lastStatus.current = status;
    if (decidedHere.current || was !== "pending") return;
    const by = detail.decidedBy?.displayName ?? null;
    if (status === "approved" || status === "applied") announce(by ? `Approved by ${by}.` : "Approved.");
    else if (status === "denied") announce(by ? `Denied by ${by}.` : "Denied.");
    else if (status === "expired") announce("No one decided within 24 hours. Nothing was run.");
  }, [status, detail.decidedBy, announce]);

  // Pending turns Expired and Approved turns Not used by the clock, not by an event.
  const deadline = status === "pending" ? detail.expiresAt : status === "approved" ? view.useBy : null;
  useEffect(() => {
    if (!deadline) return;
    const left = new Date(deadline).getTime() - Date.now();
    if (left > DAY) return;
    const t = window.setTimeout(() => void refetch(), Math.max(0, left) + 1000);
    return () => window.clearTimeout(t);
  }, [deadline, refetch]);

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
      const said =
        result.status === "denied" ? `Denied. ${bot} won't run it.` : `Approved. ${bot} runs it once.`;
      if (result.status === "denied") toast(said);
      else toast.success(said);
      announce(said);
      await refetch();
      window.setTimeout(() => headingRef.current?.focus(), 0);
    } catch (err) {
      setAsking(null);
      decidedHere.current = false;
      const n = decisionNoticeOf(err);
      if (n) {
        setNotice(n);
        // Decided elsewhere, expired or no longer the viewer's: show the current state. A changed request waits
        // for Reload, so the person reads the new values before deciding again.
        if (n.kind === "error") void refetch();
      } else {
        toast.error(decisionError(err));
      }
    }
  };

  return (
    <>
      <ReviewFrame
        detail={detail}
        title={view.title}
        back={back}
        testId="tool-call-view"
        headingRef={headingRef}
        meta={
          <MetaLine
            detail={detail}
            origin={view.audience.origin}
            bot={bot}
            originLong={view.audience.origin.kind === "dm" ? `DM with ${bot}` : null}
          />
        }
        notice={
          notice ? (
            <NoticeBox
              notice={notice}
              onReload={() => {
                setNotice(null);
                void refetch();
              }}
            />
          ) : null
        }
        footer={
          <ToolCallFooter
            detail={detail}
            view={view}
            stacked={stacked}
            canDecide={canDecide}
            meId={me}
            onAsk={setAsking}
          />
        }
      >
        <ToolCallView
          view={view}
          meId={me}
          expiresAt={detail.status === "pending" ? detail.expiresAt : null}
        />
      </ReviewFrame>
      <ConfirmAction
        outcome={asking}
        view={view}
        meId={me}
        busy={decide.isPending}
        onCancel={() => setAsking(null)}
        onConfirm={(o, note) => void confirm(o, note)}
      />
    </>
  );
}

function ToolCallFooter({
  detail,
  view,
  stacked,
  canDecide,
  meId,
  onAsk,
}: {
  detail: ApprovalDetail;
  view: ToolCallApprovalView;
  stacked: boolean;
  canDecide: boolean;
  meId: string | null;
  onAsk: (o: "approved" | "denied") => void;
}) {
  const status = detail.status;
  const bot = view.agent.displayName;
  if (status === "pending" && canDecide) {
    return (
      <FooterBar stacked={stacked} state="decide">
        <div className={cn("flex items-center gap-2", stacked ? "min-h-11" : "h-16 justify-end")}>
          <Button
            variant="outline"
            data-testid="approval-deny"
            className={cn("max-lg:h-11", stacked && "flex-1")}
            onClick={() => onAsk("denied")}
          >
            <X /> Deny…
          </Button>
          <Button
            data-testid="approval-approve"
            className={cn("max-lg:h-11", stacked && "flex-1")}
            onClick={() => onAsk("approved")}
          >
            <Check /> Approve…
          </Button>
        </div>
      </FooterBar>
    );
  }

  const by = detail.decidedBy?.displayName ?? "an approver";
  const note = detail.decisionNote ? (
    <p data-testid="approval-decision-note" className="break-words text-muted-foreground text-xs">
      “{detail.decisionNote}”
    </p>
  ) : null;
  let body: ReactNode;
  if (status === "pending") {
    const who = waitingFor(view);
    body = (
      <p data-testid="approval-waiting" className="flex items-start gap-1.5 text-muted-foreground text-sm">
        <Hourglass aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0">{who ? waitingLine(detail, meId, who) : `${view.approverLabel}.`}</span>
      </p>
    );
  } else if (status === "approved") {
    const useBy = view.useBy ?? detail.headline?.useBy ?? null;
    const late = useBy !== null && new Date(useBy).getTime() < Date.now();
    body = (
      <div className="grid min-w-0 gap-1">
        <DecisionText icon={CircleCheck} text={`Approved by ${by}`} at={detail.decidedAt} />
        {useBy ? (
          <p data-testid="approval-use-by" className="text-muted-foreground text-xs">
            {late
              ? view.browser
                ? browserNotUsedText(bot)
                : `Approved, but ${bot} didn't run it before ${timeOf(useBy)}. Ask again if you still need it.`
              : `${bot} runs it once, before ${timeOf(useBy)}.`}
          </p>
        ) : null}
        {note}
      </div>
    );
  } else if (status === "applied") {
    body = (
      <div className="grid min-w-0 gap-1">
        <DecisionText
          icon={CircleCheck}
          tone="done"
          text={`Approved by ${by}`}
          at={detail.decidedAt}
          after={view.usedAt ? `Used at ${timeOf(view.usedAt)}` : "Used"}
        />
        {note}
      </div>
    );
  } else if (status === "denied") {
    body = (
      <div className="grid min-w-0 gap-1">
        <DecisionText icon={CircleX} text={`Denied by ${by}`} at={detail.decidedAt} />
        {note}
      </div>
    );
  } else if (status === "failed") {
    body = (
      <p data-testid="approval-decision-line" data-status="failed" className="text-muted-foreground text-sm">
        Approved, but it couldn't run. Ask {bot} again if you still need it.
      </p>
    );
  } else {
    body = (
      <p
        data-testid="approval-decision-line"
        data-status="expired"
        className="flex items-center gap-1.5 text-muted-foreground text-sm"
      >
        <Hourglass aria-hidden className="size-4 shrink-0" />
        No one decided within 24 hours. Nothing was run.
      </p>
    );
  }
  return (
    <FooterBar stacked={stacked} state={status === "pending" ? "waiting" : "decided"}>
      <div className={cn("flex min-h-16 items-center py-3", stacked && "min-h-11 py-0")}>{body}</div>
    </FooterBar>
  );
}

function ConfirmAction({
  outcome,
  view,
  meId,
  busy,
  onCancel,
  onConfirm,
}: {
  outcome: "approved" | "denied" | null;
  view: ToolCallApprovalView;
  meId: string | null;
  busy: boolean;
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
  const bot = view.agent.displayName;
  const tool = shortToolName(view.tool);
  const mine = meId !== null && view.requestedFor.id === meId;
  const counted = note.length >= 200;
  return (
    <Dialog open={outcome !== null} onOpenChange={(o) => !busy && !o && onCancel()}>
      <DialogContent data-testid="approval-confirm" data-outcome={shown} initialFocus={cancelRef}>
        <DialogHeader>
          <DialogTitle>{approving ? "Approve this action?" : "Deny this action?"}</DialogTitle>
          <DialogDescription>
            {approving
              ? `${bot} can run ${tool} once, with exactly these values, within 15 minutes. ${runsWithText(view, meId)}`
              : mine
                ? `${bot} won't run it.`
                : `${bot} won't run it. ${view.requestedFor.displayName} sees that you denied it.`}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor={noteId}>Note (optional)</Label>
          <Textarea
            id={noteId}
            data-testid="approval-note-input"
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
            <p id={`${noteId}-count`} className="justify-self-end text-muted-foreground text-xs tabular-nums">
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
            data-testid="approval-confirm-submit"
            onClick={() => onConfirm(shown, note)}
          >
            {busy ? <Spinner /> : approving ? <Check /> : <X />}
            {approving ? "Approve" : "Deny"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- the memory inbox's guard

/**
 * On `/memory/proposals/<id>` (07.2): a request that is not a memory proposal is reviewed in `/approvals` (UI-SPEC R1),
 * so the memory inbox never shows a tool call or a Work Zone proposal, even by its URL.
 */
export function MemoryKindRedirect() {
  const params = useParams<{ id?: string }>();
  const id = params.id ? decodeURIComponent(params.id) : null;
  const q = useApproval(id);
  const router = useRouter();
  const kind = q.data?.kind ?? null;
  useEffect(() => {
    if (id && kind && kind !== MEMORY_KINDS) router.replace(`/approvals/${encodeURIComponent(id)}`);
  }, [id, kind, router]);
  return null;
}
