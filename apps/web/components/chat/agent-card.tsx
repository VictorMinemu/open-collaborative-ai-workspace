"use client";

import type { AgentCard, AgentCardKind, AgentCardStatus } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Bell,
  BellRing,
  Check,
  CircleCheck,
  CircleX,
  FileText,
  GitPullRequest,
  Hand,
  LayoutGrid,
  Package,
  Rocket,
  SquareTerminal,
  X,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { type ComponentType, useId, useState } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { openTargetOf } from "@/lib/agent-cards";
import { errorMessage, isApiError } from "@/lib/api";
import { decideCard, followCard, refreshCard, useAgentCard } from "@/lib/card-queries";
import { cn } from "@/lib/utils";

/**
 * The one Agent Card renderer (06-15, AGENT-04, D-07, D-08, P-11, P-13), used in channels, threads, DMs, group DMs and
 * AI chats. A card is untrusted agent output: its title, fields and labels are plain text (never Markdown or HTML), and
 * Open is a link only to an internal app route (the client re-checks `AgentCardRoute`). Follow and Approve / Deny come
 * from the server (`viewerCan`, `decision`); a decision asks for confirmation first and shows only once the server took
 * it. The summary (the message body) is the card's description for screen readers, never rendered twice.
 */

const KIND: Record<AgentCardKind, { label: string; icon: ComponentType<{ className?: string }> }> = {
  work_zone: { label: "Work Zone", icon: SquareTerminal },
  approval: { label: "Approval", icon: Hand },
  report: { label: "Report", icon: FileText },
  artifact: { label: "Artifact", icon: Package },
  automation: { label: "Automation", icon: Zap },
  deployment: { label: "Deployment", icon: Rocket },
  pr: { label: "Pull request", icon: GitPullRequest },
  generic: { label: "Card", icon: LayoutGrid },
};

/** Status pill colours: text at AA contrast on its tint in light and dark. */
const STATUS: Record<AgentCardStatus, { label: string; tone: string; dot: string }> = {
  info: {
    label: "Info",
    tone: "bg-muted text-foreground/75",
    dot: "bg-muted-foreground/70",
  },
  pending: {
    label: "Pending",
    tone: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  running: {
    label: "Running",
    tone: "bg-primary/10 text-primary dark:bg-primary/20 dark:text-blue-200",
    dot: "bg-primary dark:bg-blue-300",
  },
  succeeded: {
    label: "Succeeded",
    tone: "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  failed: {
    label: "Failed",
    tone: "bg-red-100 text-red-800 dark:bg-red-400/15 dark:text-red-300",
    dot: "bg-red-500",
  },
  cancelled: {
    label: "Cancelled",
    tone: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/50",
  },
};

const decidedFmt = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function StatusPill({ status }: { status: AgentCardStatus }) {
  const s = STATUS[status] ?? STATUS.info;
  return (
    <span
      role="status"
      aria-label={`Status: ${s.label}`}
      data-testid="agent-card-status"
      data-status={status}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 font-medium text-xs",
        "fade-in-0 zoom-in-95 animate-in duration-300 motion-reduce:animate-none",
        s.tone,
      )}
    >
      <span aria-hidden className="relative inline-flex size-1.5">
        {status === "running" ? (
          <span
            className={cn(
              "absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:hidden",
              s.dot,
            )}
          />
        ) : null}
        <span className={cn("relative inline-flex size-1.5 rounded-full", s.dot)} />
      </span>
      {s.label}
    </span>
  );
}

function DecisionLine({ decision }: { decision: NonNullable<AgentCard["decision"]> }) {
  const approved = decision.outcome === "approved";
  const Icon = approved ? CircleCheck : CircleX;
  return (
    <p
      data-testid="agent-card-decision"
      data-outcome={decision.outcome}
      className={cn(
        "flex min-w-0 items-center gap-1.5 font-medium text-[13px]",
        approved ? "text-emerald-800 dark:text-emerald-300" : "text-red-800 dark:text-red-300",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">
        {approved ? "Approved" : "Denied"} by {decision.by.displayName}
      </span>
      <time dateTime={decision.at} className="shrink-0 font-normal text-muted-foreground text-xs">
        · {decidedFmt.format(new Date(decision.at))}
      </time>
    </p>
  );
}

/** Approve / Deny, after a confirmation that names the card (a bottom sheet on phones). */
function DecisionButtons({
  messageId,
  card,
  approveLabel,
  denyLabel,
}: {
  messageId: string;
  card: AgentCard;
  approveLabel: string;
  denyLabel: string;
}) {
  const qc = useQueryClient();
  const [asking, setAsking] = useState<"approved" | "denied" | null>(null);
  const [busy, setBusy] = useState(false);
  const approving = asking === "approved";
  const confirm = async () => {
    if (!asking) return;
    setBusy(true);
    try {
      await decideCard(qc, messageId, asking);
      setAsking(null);
    } catch (err) {
      toast.error(errorMessage(err));
      setAsking(null);
      // Someone else may have decided first: show what the server holds now.
      if (isApiError(err, 409) || isApiError(err, 403)) void refreshCard(qc, messageId);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" data-testid="agent-card-approve" onClick={() => setAsking("approved")}>
        <Check />
        {approveLabel}
      </Button>
      <Button size="sm" variant="outline" data-testid="agent-card-deny" onClick={() => setAsking("denied")}>
        <X />
        {denyLabel}
      </Button>
      <Dialog open={asking !== null} onOpenChange={(o) => !busy && !o && setAsking(null)}>
        <DialogContent data-testid="agent-card-confirm" data-outcome={asking ?? undefined}>
          <DialogHeader>
            <DialogTitle>
              {approving ? "Approve" : "Deny"} “{card.title}”?
            </DialogTitle>
            <DialogDescription>
              {approving
                ? "The agent goes ahead as soon as you confirm. Everyone in this conversation sees that you approved it."
                : "The agent is told not to go ahead. Everyone in this conversation sees that you denied it."}{" "}
              A card is decided once.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setAsking(null)}>
              Cancel
            </Button>
            <Button
              variant={approving ? "default" : "destructive"}
              disabled={busy}
              data-testid="agent-card-confirm-submit"
              onClick={() => void confirm()}
            >
              {busy ? <Spinner /> : approving ? <Check /> : <X />}
              {approving ? approveLabel : denyLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AgentCardView({
  messageId,
  card: listed,
  summary,
}: {
  messageId: string;
  card: AgentCard;
  summary: string;
}) {
  const qc = useQueryClient();
  const card = useAgentCard(messageId, listed);
  const summaryId = useId();
  const kind = KIND[card.kind] ?? KIND.generic;
  const KindIcon = kind.icon;
  const openTarget = openTargetOf(card);
  const openAction = card.actions.find((a) => a.kind === "open");
  const followAction = card.actions.find((a) => a.kind === "follow");
  const approveAction = card.actions.find((a) => a.kind === "approve");
  const can = card.viewerCan ?? [];
  const following = card.following === true;
  const showFollow = !!followAction && can.includes("follow");
  const showDecide = approveAction?.kind === "approve" && !card.decision && can.includes("decide");
  const toggleFollow = () =>
    void followCard(qc, messageId, !following, card).catch((err) => toast.error(errorMessage(err)));
  const hasActions = !!openTarget || showFollow || showDecide;

  return (
    <article
      data-testid="agent-card"
      data-kind={card.kind}
      data-version={card.version}
      aria-labelledby={`${summaryId}-title`}
      aria-describedby={summaryId}
      className="@container mt-1 w-full max-w-[34rem] overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs"
    >
      <p id={summaryId} className="sr-only">
        {summary}
      </p>
      <div className="grid gap-2.5 px-3.5 pt-3 pb-3.5">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 font-medium text-[11.5px] text-muted-foreground uppercase tracking-wider">
            <KindIcon className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate" data-testid="agent-card-kind">
              {kind.label}
            </span>
          </span>
          {/* Keyed by status: a change re-mounts the pill only, which fades it in (nothing else moves). */}
          <StatusPill key={card.status} status={card.status} />
        </div>
        <h3
          id={`${summaryId}-title`}
          data-testid="agent-card-title"
          className="break-words font-semibold text-[15px] leading-snug"
        >
          {card.title}
        </h3>
        {card.fields.length > 0 ? (
          <dl
            data-testid="agent-card-fields"
            className="grid grid-cols-1 gap-x-4 gap-y-2 @[26rem]:grid-cols-2"
          >
            {card.fields.map((f, i) => (
              // Labels may repeat: the position keeps the key unique (fields are replaced as a whole).
              // biome-ignore lint/suspicious/noArrayIndexKey: fields have no id and are replaced as a whole
              <div key={`${i}:${f.label}`} className="min-w-0">
                <dt className="truncate text-[11.5px] text-muted-foreground">{f.label}</dt>
                <dd className="whitespace-pre-wrap break-words text-[13.5px] leading-5">{f.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
      {hasActions || card.decision ? (
        <div
          data-testid="agent-card-actions"
          className="flex flex-wrap items-center gap-2 border-t bg-muted/35 px-3.5 py-2.5 dark:bg-white/[0.02]"
        >
          {openTarget ? (
            <Link
              href={openTarget}
              data-testid="agent-card-open"
              className={buttonVariants({ size: "sm", variant: "outline" })}
            >
              {openAction?.label ?? "Open"}
              <ArrowRight />
            </Link>
          ) : null}
          {showFollow ? (
            <Button
              size="sm"
              variant={following ? "secondary" : "ghost"}
              aria-pressed={following}
              data-testid="agent-card-follow"
              onClick={toggleFollow}
            >
              {following ? <BellRing /> : <Bell />}
              {following ? "Following" : followAction.label}
            </Button>
          ) : null}
          {showDecide && approveAction?.kind === "approve" ? (
            <span className="flex items-center gap-2 @[26rem]:ml-auto">
              <DecisionButtons
                messageId={messageId}
                card={card}
                approveLabel={approveAction.label}
                denyLabel={approveAction.denyLabel ?? "Deny"}
              />
            </span>
          ) : null}
          {/* The decision takes the place of Approve / Deny, so deciding never makes the card jump. */}
          {card.decision ? (
            <span className="min-w-0 basis-full @[26rem]:ml-auto @[26rem]:basis-auto">
              <DecisionLine decision={card.decision} />
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
