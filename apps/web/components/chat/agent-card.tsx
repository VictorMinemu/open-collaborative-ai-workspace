"use client";

import {
  type AgentCard,
  type AgentCardApprovalLink,
  type AgentCardKind,
  type AgentCardStatus,
  APPROVAL_NOTE_MAX,
  type ApprovalRequestStatus,
} from "@ocw/contracts";
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
  Hourglass,
  LayoutGrid,
  Package,
  Rocket,
  ShieldCheck,
  SquareTerminal,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { type ComponentType, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { openTargetOf } from "@/lib/agent-cards";
import { errorMessage, isApiError } from "@/lib/api";
import { decideCard, followCard, refreshCard, useAgentCard } from "@/lib/card-queries";
import { useMe } from "@/lib/queries";
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
        "flex min-w-0 items-start gap-1.5 font-medium text-[13px] leading-5",
        approved ? "text-emerald-800 dark:text-emerald-300" : "text-red-800 dark:text-red-300",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      {/* Wraps rather than truncates: at 390 a long name never hides who decided (06-16 review). */}
      <span className="min-w-0 break-words">
        {approved ? "Approved" : "Denied"} by {decision.by.displayName}{" "}
        <time dateTime={decision.at} className="whitespace-nowrap font-normal text-muted-foreground text-xs">
          · {decidedFmt.format(new Date(decision.at))}
        </time>
      </span>
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
      await decideCard(qc, messageId, { outcome: asking });
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

// ---------------------------------------------------------------- cards that mirror an approval (07.2-17)

/**
 * A card the server composed to mirror an approval (D-05, D-08, UI-SPEC R6): flagged `platformOwned` by the server and
 * linked to its request. Only these get the workspace badge, the visible preview, the warnings, the approval's status
 * and the decision with a note (T-07.2-17-01); every other card renders exactly as before.
 */
function approvalLinkOf(card: AgentCard): AgentCardApprovalLink | null {
  return card.platformOwned === true && card.approval ? card.approval : null;
}

/** Pill labels from the approval's status (UI-SPEC Status and notices); text at AA contrast in light and dark. */
const APPROVAL_STATUS: Record<
  ApprovalRequestStatus,
  { label: string; tone: string; icon: ComponentType<{ className?: string }> | null }
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

function ApprovalStatusPill({ status }: { status: ApprovalRequestStatus }) {
  const s = APPROVAL_STATUS[status] ?? APPROVAL_STATUS.pending;
  const Icon = s.icon;
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
      {Icon ? (
        <Icon className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <span aria-hidden className="inline-flex size-1.5 rounded-full bg-amber-500" />
      )}
      {s.label}
    </span>
  );
}

/** "Created by the workspace" (UI-SPEC Card mirror), described for screen readers. */
function WorkspaceBadge({ id }: { id: string }) {
  return (
    <>
      <Badge
        variant="outline"
        data-testid="agent-card-workspace"
        aria-describedby={id}
        className="normal-case tracking-normal"
      >
        <ShieldCheck aria-hidden />
        Created by the workspace
      </Badge>
      <span id={id} className="sr-only">
        This card was made by the workspace, not by the bot.
      </span>
    </>
  );
}

const PREVIEW_LINES = 6;

/**
 * The server's change excerpt (masked, ≤ 600 characters), shown as text because an owner may decide in the card. The
 * whole summary stays the card's description for screen readers, so the visual copy is hidden from them (never read
 * twice).
 */
function ChangePreview({ text }: { text: string }) {
  const lines = text.split("\n");
  const shown = lines.slice(0, PREVIEW_LINES);
  const more = lines.length - shown.length;
  return (
    <div
      data-testid="agent-card-preview"
      aria-hidden
      className="min-w-0 rounded-lg bg-muted/50 px-3 py-2 font-mono text-xs leading-5 dark:bg-white/[0.03]"
    >
      {shown.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: preview lines have no id and are replaced as a whole
        <div key={i} className="whitespace-pre-wrap break-words">
          {line.startsWith("+") ? (
            <>
              <span className="text-emerald-700 dark:text-emerald-400">+</span>
              {line.slice(1)}
            </>
          ) : (
            line
          )}
        </div>
      ))}
      {more > 0 ? (
        <p className="mt-1 font-sans text-muted-foreground">
          +{more} more {more === 1 ? "line" : "lines"}
        </p>
      ) : null}
    </div>
  );
}

/** A server-composed warning (taint, extended scan): amber, calm, one per line. */
function WarningLine({ text }: { text: string }) {
  return (
    <p
      data-testid="agent-card-warning"
      className="flex min-w-0 items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 text-xs leading-4 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200"
    >
      <TriangleAlert className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{text}</span>
    </p>
  );
}

/** Why an approved change was not applied, in words (UI-SPEC Copywriting › failed reasons); never an API code. */
function failedReason(code: string | null | undefined, bot: string): string {
  switch (code) {
    case "stale_base":
      return `The file changed since this proposal. Ask ${bot} to propose again.`;
    case "path_exists":
      return "A file with this name was created since this proposal.";
    case "scope_gone":
      return "This memory no longer exists.";
    case "secret_detected":
      return "Not applied: the text contains a secret.";
    case "scope_full":
      return "This memory is full (2,000 files).";
    case "too_large":
      return "The file would be over 256 KB.";
    case "bot_deleted":
      return `${bot.charAt(0).toUpperCase()}${bot.slice(1)} was deleted. Nothing was changed.`;
    case "bot_disabled":
      return `${bot.charAt(0).toUpperCase()}${bot.slice(1)} is turned off. Nothing was changed.`;
    default:
      return "Couldn't apply this change.";
  }
}

/** A field of the server's card by label (Memory, Readers…), or null. */
const fieldOf = (card: AgentCard, label: string) => card.fields.find((f) => f.label === label)?.value ?? null;

/**
 * The memory the change goes to, as the dialogs name it, from the server's Memory field ("{label} · {tag}"):
 * "You & Scout · Private" → "your private memory with Scout", "Scout notebook · Bot" → "Scout notebook",
 * "Ventas · Team" → "Ventas memory".
 */
function scopeText(card: AgentCard): string {
  const memory = fieldOf(card, "Memory");
  if (!memory) return "memory";
  const [label = memory, tag] = memory.split(" · ");
  if (tag === "Private" && label.startsWith("You & ")) return `your private memory with ${label.slice(6)}`;
  if (tag === "Bot") return label;
  return `${label} memory`;
}

/** The server's reader count ("Only you", "1 person", "12 people") as the UI-SPEC sentence, or null. */
function readerSentence(card: AgentCard): string | null {
  const readers = fieldOf(card, "Readers");
  if (!readers) return null;
  if (readers === "Only you") return "Only you will see this.";
  return `${readers} will see this.`;
}

/** The decision errors in words (UI-SPEC Copywriting › Decision errors); never an API code. */
function decisionError(err: unknown, requester: boolean): string {
  if (isApiError(err)) {
    switch (err.code) {
      case "approval_action_changed":
        return "This proposal changed while you were reviewing it.";
      case "approval_already_decided":
        return "Someone already decided this proposal.";
      case "approval_expired":
        return "This proposal expired.";
      case "not_approver":
        return requester ? "You can't approve your own proposal." : "You can't decide this proposal.";
    }
  }
  return errorMessage(err);
}

/**
 * Approve / Deny on a card that mirrors an approval: a confirmation that names the file, the memory and its readers,
 * with an optional note (≤ 280, counter from 200, Cancel focused first); the decision names the hash the card rendered
 * (T-07.2-17-02).
 */
function LinkedDecisionButtons({
  messageId,
  card,
  link,
  requester,
}: {
  messageId: string;
  card: AgentCard;
  link: AgentCardApprovalLink;
  requester: boolean;
}) {
  const qc = useQueryClient();
  const noteId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [asking, setAsking] = useState<"approved" | "denied" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const approving = asking === "approved";
  const ask = (outcome: "approved" | "denied") => {
    setNote("");
    setAsking(outcome);
  };
  const confirm = async () => {
    if (!asking) return;
    setBusy(true);
    try {
      await decideCard(qc, messageId, {
        outcome: asking,
        actionHash: link.actionHash,
        note: note.trim() || undefined,
      });
      setAsking(null);
    } catch (err) {
      toast.error(decisionError(err, requester));
      setAsking(null);
      // Changed, decided or expired meanwhile: show what the server holds now (a new hash, never auto-decided).
      if (isApiError(err, 409) || isApiError(err, 403)) void refreshCard(qc, messageId);
    } finally {
      setBusy(false);
    }
  };
  const readers = readerSentence(card);
  const counted = note.length >= 200;
  return (
    <>
      <Button
        size="sm"
        className="max-lg:h-11"
        data-testid="agent-card-approve"
        onClick={() => ask("approved")}
      >
        <Check />
        Approve
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="max-lg:h-11"
        data-testid="agent-card-deny"
        onClick={() => ask("denied")}
      >
        <X />
        Deny
      </Button>
      <Dialog open={asking !== null} onOpenChange={(o) => !busy && !o && setAsking(null)}>
        <DialogContent
          data-testid="agent-card-confirm"
          data-outcome={asking ?? undefined}
          initialFocus={cancelRef}
        >
          <DialogHeader>
            <DialogTitle>{approving ? "Approve and apply?" : "Deny this proposal?"}</DialogTitle>
            <DialogDescription>
              {approving
                ? `“${card.title}” is saved to ${scopeText(card)}.${readers ? ` ${readers}` : ""}`
                : `Nothing changes in ${scopeText(card)}. Everyone in this conversation sees that you denied it.`}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={noteId}>Note (optional)</Label>
            <Textarea
              id={noteId}
              data-testid="agent-card-note-input"
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
                data-testid="agent-card-note-count"
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
              onClick={() => setAsking(null)}
            >
              Cancel
            </Button>
            <Button
              variant={approving ? "default" : "destructive"}
              className="max-lg:h-11"
              disabled={busy}
              data-testid="agent-card-confirm-submit"
              onClick={() => void confirm()}
            >
              {busy ? <Spinner /> : approving ? <Check /> : <X />}
              {approving ? "Approve and apply" : "Deny"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The footer of a linked card: Review changes, then Approve / Deny, the waiting line or the decision with its note. */
function LinkedFooter({
  messageId,
  card,
  link,
  openTarget,
}: {
  messageId: string;
  card: AgentCard;
  link: AgentCardApprovalLink;
  openTarget: string | null;
}) {
  const me = useMe({ enabled: false }).data?.user.id ?? null;
  const known = card.viewerCan !== undefined;
  const mayDecide = (card.viewerCan ?? []).includes("decide");
  const pending = link.status === "pending" && !card.decision;
  const requester = me !== null && link.requestedForUserId === me;
  const decider = pending && mayDecide;
  // The review opens for whoever may decide, asked for it or decided it (everyone else gets not found there).
  const mayOpen = mayDecide || requester || (me !== null && card.decision?.by.id === me);
  const waiting = pending && known && !mayDecide;
  const showOpen = !!openTarget && mayOpen;
  if (!showOpen && !decider && !waiting && !card.decision) return null;
  return (
    <div
      data-testid="agent-card-actions"
      className="flex flex-wrap items-center gap-2 border-t bg-muted/35 px-3.5 py-2.5 dark:bg-white/[0.02]"
    >
      {showOpen && openTarget ? (
        <Link
          href={openTarget}
          data-testid="agent-card-open"
          className={cn(buttonVariants({ size: "sm", variant: "outline" }), "max-lg:h-11")}
        >
          {card.actions.find((a) => a.kind === "open")?.label ?? "Review changes"}
          <ArrowRight />
        </Link>
      ) : null}
      {decider ? (
        <span className="flex items-center gap-2 @[26rem]:ml-auto">
          <LinkedDecisionButtons messageId={messageId} card={card} link={link} requester={requester} />
        </span>
      ) : null}
      {waiting ? (
        <p
          data-testid="agent-card-waiting"
          className="min-w-0 basis-full text-muted-foreground text-xs leading-4 @[26rem]:ml-auto @[26rem]:basis-auto"
        >
          {requester
            ? "Waiting for a reviewer. You can't approve your own proposal."
            : "Waiting for a reviewer"}
        </p>
      ) : null}
      {card.decision ? (
        <span className="grid min-w-0 basis-full gap-1 @[26rem]:ml-auto @[26rem]:basis-auto">
          <DecisionLine decision={card.decision} />
          {card.decision.note ? (
            <p data-testid="agent-card-note" className="break-words text-muted-foreground text-xs leading-4">
              “{card.decision.note}”
            </p>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

export function AgentCardView({
  messageId,
  card: listed,
  summary,
  authorName,
}: {
  messageId: string;
  card: AgentCard;
  summary: string;
  /** The posting agent's name, for copy that names the bot (a failed proposal's reason). */
  authorName?: string | undefined;
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
  const link = approvalLinkOf(card);

  return (
    <article
      data-testid="agent-card"
      data-kind={card.kind}
      data-version={card.version}
      data-approval-status={link?.status}
      aria-labelledby={`${summaryId}-title`}
      aria-describedby={summaryId}
      className="@container mt-1 w-full max-w-[34rem] overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs"
    >
      <p id={summaryId} className="sr-only">
        {summary}
      </p>
      <div className="grid gap-2.5 px-3.5 pt-3 pb-3.5">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span
            className={cn(
              "flex min-w-0 items-center gap-1.5 font-medium text-[11.5px] text-muted-foreground uppercase tracking-wider",
              // A linked card's badge wraps under the kind on narrow cards instead of hiding it.
              link && "flex-wrap gap-y-1",
            )}
          >
            <KindIcon className="size-3.5 shrink-0" aria-hidden />
            <span className={cn("truncate", link && "shrink-0")} data-testid="agent-card-kind">
              {kind.label}
            </span>
            {link ? <WorkspaceBadge id={`${summaryId}-workspace`} /> : null}
          </span>
          {/* Keyed by status: a change re-mounts the pill only, which fades it in (nothing else moves). */}
          {link ? (
            <ApprovalStatusPill key={link.status} status={link.status} />
          ) : (
            <StatusPill key={card.status} status={card.status} />
          )}
        </div>
        <h3
          id={`${summaryId}-title`}
          data-testid="agent-card-title"
          className="break-words font-semibold text-[15px] leading-snug"
        >
          {card.title}
        </h3>
        {link?.status === "failed" ? (
          <p
            data-testid="agent-card-failed-reason"
            className="flex min-w-0 items-start gap-1.5 text-[13px] text-red-800 leading-5 dark:text-red-300"
          >
            <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">
              {failedReason(link.resultCode, authorName ?? "the bot")}
            </span>
          </p>
        ) : null}
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
        {link && summary.trim() && summary !== card.title ? <ChangePreview text={summary} /> : null}
        {link?.warnings.map((w) => (
          <WarningLine key={w} text={w} />
        ))}
      </div>
      {link ? (
        <LinkedFooter messageId={messageId} card={card} link={link} openTarget={openTarget} />
      ) : hasActions || card.decision ? (
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
