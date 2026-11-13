"use client";

import {
  type AgentCard,
  type AgentCardApprovalLink,
  type AgentCardKind,
  AgentCardRoute,
  type AgentCardStatus,
  APPROVAL_NOTE_MAX,
  type ApprovalRequestStatus,
  taskCardStatus,
  taskStatusLabel,
  type WorkZoneProposalView,
  workSessionCardOf,
} from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Bell,
  BellRing,
  Check,
  CircleCheck,
  CircleX,
  Clock,
  FileText,
  FolderGit2,
  GitPullRequest,
  Hand,
  Hourglass,
  Info,
  KeyRound,
  Laptop,
  LayoutGrid,
  ListChecks,
  Lock,
  LockKeyhole,
  LogIn,
  type LucideIcon,
  Package,
  Play,
  Plug,
  Rocket,
  ShieldCheck,
  SquareTerminal,
  Timer,
  TriangleAlert,
  Users,
  X,
  Zap,
} from "lucide-react";
import Link from "next/link";
import {
  type ComponentType,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { pillOf, decisionError as reviewDecisionError } from "@/components/approvals/approval-review";
import { UntrustedText } from "@/components/approvals/untrusted-text";
import {
  DeviceState,
  deviceStateOf,
  failedStartText,
  liveStartBlock,
  PROPOSAL_MODE,
  startBlockedText,
} from "@/components/approvals/work-zone-proposal-view";
import { HostChip } from "@/components/browser/host-chip";
import type { LiveBot } from "@/components/browser/live-store";
import { SignInCardBody, SignInPill, signInStatusOf } from "@/components/browser/sign-in-card-body";
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
import { RUNTIMES } from "@/components/work-zone/meta";
import { openTargetOf } from "@/lib/agent-cards";
import { errorMessage, isApiError } from "@/lib/api";
import { decideCard, followCard, refreshCard, useAgentCard } from "@/lib/card-queries";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useDevices, useWorkZoneOrgSync } from "@/lib/workzone-queries";
import { TaskCard } from "./task-card";
import { WorkSessionCard, WorkSessionCardHeading, workSessionStatusWord } from "./work-session-card";

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
  // Phase 07.8 (UI-SPEC R1, Surface 2): the platform-owned sign-in card (body: `SignInCardBody`, 07.8-26).
  browser: { label: "Sign-in", icon: LogIn },
  // Phase 07.17.1.1.2 (D-05): the platform-owned task card (body: `TaskCard`, 07.17.1.1.2-10).
  task: { label: "Task", icon: ListChecks },
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

function StatusPill({ status, label }: { status: AgentCardStatus; label?: string | undefined }) {
  const s = STATUS[status] ?? STATUS.info;
  // 07.6 (R1): a platform-owned card's own word ("No reply", "Received"); the tone stays the status's.
  const word = label ?? s.label;
  return (
    <span
      role="status"
      aria-label={`Status: ${word}`}
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
      {word}
    </span>
  );
}

function DecisionLine({
  decision,
  verbs = { approved: "Approved", denied: "Denied" },
}: {
  decision: NonNullable<AgentCard["decision"]>;
  /** A Work Zone proposal reads "Started by" / "Dismissed by" (07.5-14, UI-SPEC Surface 3 States). */
  verbs?: { approved: string; denied: string };
}) {
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
        {approved ? verbs.approved : verbs.denied} by {decision.by.displayName}{" "}
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

/**
 * A platform-owned card's notice (07.6, R1, UI-SPEC 8d): amber for a warning (outside content), muted for a neutral
 * line (no reply, a run reason). Server text, rendered as text; a bot's card never gets one (T-07.6-15-03).
 */
function NoticeLine({ notice }: { notice: NonNullable<AgentCard["notices"]>[number] }) {
  const warning = notice.tone === "warning";
  const Icon = warning ? TriangleAlert : Info;
  return (
    <p
      role="note"
      data-testid="agent-card-notice"
      data-tone={notice.tone}
      className={cn(
        "flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-4",
        warning
          ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200"
          : "bg-muted/40 text-muted-foreground",
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{notice.text}</span>
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
function decisionError(err: unknown): string {
  if (isApiError(err)) {
    switch (err.code) {
      case "approval_action_changed":
        return "This proposal changed while you were reviewing it.";
      case "approval_already_decided":
        return "Someone already decided this proposal.";
      case "approval_expired":
        return "This proposal expired.";
      case "not_approver":
        return "You can't decide this proposal.";
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
}: {
  messageId: string;
  card: AgentCard;
  link: AgentCardApprovalLink;
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
      toast.error(decisionError(err));
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
          <LinkedDecisionButtons messageId={messageId} card={card} link={link} />
        </span>
      ) : null}
      {waiting ? (
        <p
          data-testid="agent-card-waiting"
          className="min-w-0 basis-full text-muted-foreground text-xs leading-4 @[26rem]:ml-auto @[26rem]:basis-auto"
        >
          Waiting for a reviewer
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

// ---------------------------------------------------------------- 07.5-14: action and Work Zone proposal cards

/**
 * The two 07.5 linked kinds (D-02, D-03, D-04, P-07, UI-SPEC Surfaces 1 and 3, R6, R8, R9): a bot's action that needs
 * approval (`tool.call`) and a Work Zone session a bot proposes (`work_zone.start`). The server composes every field,
 * label and the card's display (`exact` in the requester's own DM, `summary` everywhere else, `review_only` when a
 * value did not fit), so the browser never renders a value the server did not put in the card (T-07.5-14-01). Values
 * are model output: `UntrustedText`, text nodes only, revealed characters as chips (T-07.5-14-02). Buttons follow
 * `viewerCan`, the requester id and `display`, and the API decides again (T-07.5-14-03); a summary or review-only card
 * never offers Approve, because the server refuses it there (T-07.5-14-04). Other cards never reach this code.
 */

type LinkedKind = "tool" | "work_zone" | "automation";

function linkedKindOf(link: AgentCardApprovalLink | null): LinkedKind | null {
  if (link?.kind === "tool.call") return "tool";
  if (link?.kind === "work_zone.start") return "work_zone";
  if (link?.kind === "automation.create") return "automation";
  return null;
}

const clockFmt = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" });
const fullFmt = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
/** "10:33 AM". */
const clockOf = (iso: string) => clockFmt.format(new Date(iso));

/**
 * The card's timer (UI-SPEC "Timer"): "Expires in {n} h" rounded to the nearest hour (a card posted a moment ago reads
 * "24 h", as its request lasts 24 hours), "Expires in {n} min" under one hour, "Expired" after.
 */
export function cardExpiresIn(iso: string, now: number = Date.now()): string {
  const left = new Date(iso).getTime() - now;
  if (left <= 0) return "Expired";
  const minutes = Math.max(1, Math.ceil(left / 60_000));
  if (minutes < 60) return `Expires in ${minutes} min`;
  return `Expires in ${Math.max(1, Math.round(left / 3_600_000))} h`;
}

/** Re-renders once `deadline` passes, so "Approved" turns "Not used" and a timer moves on without a reload. */
function useNow(deadline: string | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    const left = new Date(deadline).getTime() - Date.now();
    if (left < 0 || left > 24 * 3_600_000 + 60_000) return;
    const t = window.setTimeout(() => setNow(Date.now()), left + 1000);
    return () => window.clearTimeout(t);
  }, [deadline]);
  return now;
}

/** The pill of a 07.5 card (UI-SPEC R6): Pending · Approved · Used · Not used · Denied · Expired, or the proposal's. */
function LinkedPill({
  kind,
  status,
  useBy,
  now,
}: {
  kind: string;
  status: ApprovalRequestStatus;
  useBy: string | null | undefined;
  now: number;
}) {
  return <PillView p={pillOf(kind, status, useBy, now)} status={status} />;
}

/**
 * The automation proposal's pill (07.6, UI-SPEC Surface 5 States): Proposed · Creating… · Created · Created with changes
 * (applied from the editor, R5) · Discarded · Expired · Failed, from the approval's status.
 */
export function automationPillOf(
  status: ApprovalRequestStatus,
  edited: boolean | undefined,
): ReturnType<typeof pillOf> {
  switch (status) {
    case "pending":
      return { label: "Proposed", tone: STATUS.pending.tone, icon: "dot" };
    case "approved":
      return { label: "Creating…", tone: STATUS.running.tone, icon: "spinner" };
    case "applied":
      return {
        label: edited ? "Created with changes" : "Created",
        tone: STATUS.succeeded.tone,
        icon: CircleCheck,
      };
    case "denied":
      return { label: "Discarded", tone: STATUS.cancelled.tone, icon: CircleX };
    case "expired":
      return { label: "Expired", tone: STATUS.cancelled.tone, icon: Hourglass };
    case "failed":
      return { label: "Failed", tone: STATUS.failed.tone, icon: CircleX };
  }
}

function PillView({ p, status }: { p: ReturnType<typeof pillOf>; status: ApprovalRequestStatus }) {
  const Icon = p.icon === "dot" || p.icon === "spinner" ? null : p.icon;
  return (
    <span
      role="status"
      aria-label={`Status: ${p.label}`}
      data-testid="agent-card-status"
      data-status={status}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 font-medium text-xs",
        "fade-in-0 zoom-in-95 animate-in duration-300 motion-reduce:animate-none",
        p.tone,
      )}
    >
      {Icon ? (
        <Icon className="size-3.5 shrink-0" aria-hidden />
      ) : p.icon === "spinner" ? (
        <Spinner className="size-3.5" />
      ) : (
        <span
          aria-hidden
          className={cn(
            "inline-flex size-1.5 rounded-full",
            status === "pending" ? "bg-amber-500" : "bg-primary dark:bg-blue-300",
          )}
        />
      )}
      {p.label}
    </span>
  );
}

/** A section label inside the card (ACTION, WHAT {BOT} WILL SEND): the kind row's style, a level-4 heading. */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p
      role="heading"
      aria-level={4}
      className="font-medium text-[11.5px] text-muted-foreground uppercase tracking-wider"
    >
      {children}
    </p>
  );
}

/** One quiet line under the fields (timer, waiting, privacy, state), 12/400 muted with its glyph. */
function CardLine({
  testId,
  icon: Icon,
  id,
  tone,
  children,
}: {
  testId: string;
  icon: LucideIcon;
  id?: string;
  tone?: "danger";
  children: ReactNode;
}) {
  return (
    <p
      id={id}
      data-testid={testId}
      className={cn(
        "flex min-w-0 items-start gap-1.5 text-xs leading-4",
        tone === "danger" ? "text-red-800 dark:text-red-300" : "text-muted-foreground",
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

/** A label's id-safe key: "Due date" → "due-date". */
const keyOf = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "field";

/** A value that reads as a block (UI-SPEC "Block values"): it has a newline or is longer than 160 characters. */
const isBlock = (value: string) => value.includes("\n") || value.length > 160;

/** A revealed invisible character as the server writes it (UI-SPEC "Untrusted text"). */
const HIDDEN_MARKER = /⟨U\+[0-9A-F]{4,6}⟩/;

/**
 * A field list of an action card: label-left from 26rem, label over value below; values 14/400 through
 * `UntrustedText`, block values clamped to 6 lines with Show more (display only: the full value is in the card).
 */
function ToolFieldList({
  fields,
  section,
  inline = false,
  browser = null,
}: {
  fields: AgentCard["fields"];
  section: "action" | "value";
  /** The summary card's two fields side by side from 26rem (UI-SPEC Surface 1 "Summary view"). */
  inline?: boolean;
  /** 07.8 (Surface 6): a browser action's page, so Page reads as the host chip and Session carries the lock. */
  browser?: NonNullable<AgentCardApprovalLink["browser"]> | null;
}) {
  return (
    <dl
      className={cn(
        "grid min-w-0 gap-y-2.5 @[26rem]:gap-y-1.5",
        inline && "@[26rem]:grid-cols-2 @[26rem]:gap-x-4",
      )}
    >
      {fields.map((f, i) => {
        const block = isBlock(f.value);
        const mono = section === "action" && (f.label === "Tool" || f.label === "Target");
        const page = !!browser && section === "action" && f.label === "Page";
        const session = !!browser && section === "action" && f.label === "Session" && browser.signedIn;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: fields have no id and are replaced as a whole
            key={`${i}:${f.label}`}
            className={cn(
              "grid min-w-0 gap-y-0.5 @[26rem]:gap-x-3",
              inline
                ? "@[26rem]:grid-cols-[auto_minmax(0,1fr)]"
                : "@[26rem]:grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)]",
            )}
          >
            <dt className="break-words pt-px text-muted-foreground text-xs leading-5">{f.label}</dt>
            <dd
              data-testid={`agent-card-${section}-field-${keyOf(f.label)}`}
              className={cn(
                "min-w-0 text-sm leading-5",
                mono && "break-all font-mono text-[13px]",
                ((section === "action" && f.label === "Source") || session) && "flex items-start gap-1.5",
              )}
            >
              {section === "action" && f.label === "Source" ? (
                <Plug className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              ) : null}
              {session ? (
                <LockKeyhole className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              ) : null}
              {page && browser ? (
                // The host from the server's stored call (never bot text), with its scheme: T-07.8-20-03.
                <HostChip host={browser.host} secure={browser.secure} className="text-[13px]" />
              ) : block ? (
                <div
                  data-testid="agent-card-block-value"
                  className="min-w-0 rounded-lg bg-muted/50 px-3 py-2 dark:bg-white/[0.03]"
                >
                  <UntrustedText text={f.value} clampLines={6} />
                </div>
              ) : (
                <UntrustedText text={f.value} mono={mono} />
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** The server's notices, sorted by what they are (UI-SPEC Surface 1): known copy is matched exactly, the rest warns. */
const TRUNCATED_NOTICE = "Some values are too long for the card. Review them in full before approving.";
const HIDDEN_NOTICE = "Contains hidden characters, shown as ⟨U+…⟩.";
const MASKED_NOTICE = "A value looks like a secret and is masked.";

/** The requester's name in a summary title the server composed ("{bot} wants to run {tool} for {person}"). */
function summaryRequester(card: AgentCard): string | null {
  // 07.8 (Surface 6): "{bot} wants to click on {host} for {requester}" (the server's browser summary title).
  if (approvalLinkOf(card)?.browser) {
    const at = card.title.lastIndexOf(" for ");
    return at >= 0 ? card.title.slice(at + 5).trim() || null : null;
  }
  const tool = fieldOf(card, "Tool");
  if (!tool) return null;
  const marker = ` wants to run ${tool} for `;
  const at = card.title.indexOf(marker);
  return at >= 0 ? card.title.slice(at + marker.length).trim() || null : null;
}

/** "It runs with the organization's account." from the exact card's Source (the viewer is the requester). */
function runsWith(card: AgentCard): string {
  const source = fieldOf(card, "Source") ?? "";
  if (source.endsWith(" · MCP server")) return "It runs with the organization's account.";
  if (source.endsWith(" · your account") || source.startsWith("Keychain key ")) {
    return "It runs with your account.";
  }
  return "It runs for you.";
}

/** A refused card decision in words; a changed action asks to open the review again (UI-SPEC Interaction › Card). */
function cardDecisionError(err: unknown, kind?: string): string {
  if (isApiError(err, 409) && err.code === "approval_action_changed") {
    return kind === "automation.create"
      ? "This proposal changed. Open it to review again."
      : "This request changed. Open it to review again.";
  }
  return reviewDecisionError(err);
}

type DialogCopy = {
  title: string;
  body: string;
  confirm: string;
  /** The optional note (07.2's Textarea, 280, counter from 200). */
  note: boolean;
  placeholder?: string;
};

/**
 * The two decision buttons of a 07.5 card and their confirmation (Cancel focused first; a bottom sheet below 640).
 * `approve` is null on a review-only card (Deny only). A disabled Start stays focusable (`aria-disabled`) and is
 * described by its visible reason; clicking it does nothing. The decision names the hash the card rendered.
 */
function CardDecision({
  messageId,
  link,
  approve,
  deny,
  copy,
  onDecided,
}: {
  messageId: string;
  link: AgentCardApprovalLink;
  approve: { label: string; icon: LucideIcon; testId: string; disabledBy?: string | null } | null;
  deny: { label: string; testId: string };
  copy: Record<"approved" | "denied", DialogCopy>;
  onDecided: (outcome: "approved" | "denied", decided: AgentCard) => void;
}) {
  const qc = useQueryClient();
  const noteId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [asking, setAsking] = useState<"approved" | "denied" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const c = asking ? copy[asking] : null;
  const ask = (outcome: "approved" | "denied") => {
    setNote("");
    setAsking(outcome);
  };
  const confirm = async () => {
    if (!asking) return;
    const outcome = asking;
    setBusy(true);
    try {
      const decided = await decideCard(qc, messageId, {
        outcome,
        actionHash: link.actionHash,
        note: copy[outcome].note ? note.trim() || undefined : undefined,
      });
      setAsking(null);
      onDecided(outcome, decided);
    } catch (err) {
      toast.error(cardDecisionError(err, link.kind));
      setAsking(null);
      // Changed, decided or expired meanwhile: show what the server holds now (never decided by itself).
      if (isApiError(err, 409) || isApiError(err, 403)) void refreshCard(qc, messageId);
    } finally {
      setBusy(false);
    }
  };
  const counted = note.length >= 200;
  const ApproveIcon = approve?.icon ?? Check;
  return (
    <>
      {approve ? (
        <Button
          size="sm"
          className="max-lg:h-11 max-sm:flex-1 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          data-testid={approve.testId}
          aria-disabled={approve.disabledBy ? true : undefined}
          aria-describedby={approve.disabledBy ?? undefined}
          onClick={() => (approve.disabledBy ? undefined : ask("approved"))}
        >
          <ApproveIcon />
          {approve.label}
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        className="max-lg:h-11 max-sm:flex-1"
        data-testid={deny.testId}
        onClick={() => ask("denied")}
      >
        <X />
        {deny.label}
      </Button>
      <Dialog open={asking !== null} onOpenChange={(o) => !busy && !o && setAsking(null)}>
        <DialogContent
          data-testid="agent-card-confirm"
          data-outcome={asking ?? undefined}
          initialFocus={cancelRef}
        >
          <DialogHeader>
            <DialogTitle>{c?.title}</DialogTitle>
            <DialogDescription>{c?.body}</DialogDescription>
          </DialogHeader>
          {c?.note ? (
            <div className="grid gap-2">
              <Label htmlFor={noteId}>Note (optional)</Label>
              <Textarea
                id={noteId}
                data-testid="agent-card-note-input"
                value={note}
                maxLength={APPROVAL_NOTE_MAX}
                rows={3}
                className="min-h-20"
                placeholder={c.placeholder}
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
          ) : null}
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
              variant={asking === "approved" ? "default" : "destructive"}
              className="max-lg:h-11"
              disabled={busy}
              data-testid="agent-card-confirm-submit"
              onClick={() => void confirm()}
            >
              {busy ? <Spinner /> : asking === "approved" ? <ApproveIcon /> : <X />}
              {c?.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The decided state of a 07.5 card's footer: the decision line (focus lands here after deciding) and the note. The note
 * shows only on a card that shows the exact action (W-1): a summary or review-only card's readers may not see the
 * values a note can quote, so the server leaves it out and the browser never renders one it got anyway.
 */
function DecidedBlock({
  decision,
  display,
  verbs,
  focusRef,
  children,
}: {
  decision: NonNullable<AgentCard["decision"]>;
  display: AgentCardApprovalLink["display"];
  verbs?: { approved: string; denied: string };
  focusRef: RefObject<HTMLDivElement | null>;
  children?: ReactNode;
}) {
  return (
    <div
      ref={focusRef}
      tabIndex={-1}
      data-testid="agent-card-decided"
      className="grid min-w-0 basis-full gap-1 outline-none @[26rem]:ml-auto @[26rem]:basis-auto"
    >
      <DecisionLine decision={decision} {...(verbs ? { verbs } : {})} />
      {decision.note && display === "exact" ? (
        <p data-testid="agent-card-note" className="break-words text-muted-foreground text-xs leading-4">
          “{decision.note}”
        </p>
      ) : null}
      {children}
    </div>
  );
}

const FOOTER = "flex flex-wrap items-center gap-2 border-t bg-muted/35 px-3.5 py-2.5 dark:bg-white/[0.02]";

/** Focus moves to the decided block once the server took a decision made in this card (UI-SPEC Focus management). */
function useFocusAfterDecision(decided: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (pending && decided) {
      ref.current?.focus();
      setPending(false);
    }
  }, [pending, decided]);
  return { ref, arm: () => setPending(true) };
}

/**
 * A bot's action that needs approval (Surface 1). Exact: ACTION, WHAT {BOT} WILL SEND and the timer, Approve / Deny for
 * a decider. Review-only: the truncation notice, Review (primary) and Deny. Summary: who wants what for whom, Tool and
 * Source, the waiting and privacy lines, Review only for the requester and the deciders.
 */
/** What did not happen when a browser approval expires ("Nothing was clicked."). */
const BROWSER_DONE: Record<NonNullable<AgentCardApprovalLink["browser"]>["action"], string> = {
  click: "clicked",
  type: "typed",
  select: "chosen",
  press: "pressed",
  scroll: "done",
  open: "opened",
};

function ToolCallCard({
  messageId,
  card,
  link,
  bot,
}: {
  messageId: string;
  card: AgentCard;
  link: AgentCardApprovalLink;
  bot: string;
}) {
  const me = useMe({ enabled: false }).data?.user.id ?? null;
  const now = useNow(link.status === "approved" ? link.useBy : link.expiresAt);
  const after = useFocusAfterDecision(!!card.decision);
  const display = link.display ?? "summary";
  const known = card.viewerCan !== undefined;
  const mayDecide = (card.viewerCan ?? []).includes("decide");
  const requester = me !== null && link.requestedForUserId === me;
  const pending = link.status === "pending" && !card.decision;
  const decider = pending && mayDecide && display !== "summary";
  const openTarget = openTargetOf(card);
  const showOpen = !!openTarget && (mayDecide || requester || (me !== null && card.decision?.by.id === me));
  const waitingFor = link.waitingFor ?? "Waiting for an approver";

  const notices = link.warnings.filter((w) => w !== TRUNCATED_NOTICE);
  const hidden = notices.includes(HIDDEN_NOTICE) || card.fields.some((f) => HIDDEN_MARKER.test(f.value));
  const warnings = notices.filter((w) => w !== HIDDEN_NOTICE && w !== MASKED_NOTICE);
  const masked = notices.includes(MASKED_NOTICE);

  // 07.8 (UI-SPEC Surface 6, R8): a browser action's card is Action, Element, Page and Session, then what it types.
  const browser = link.browser ?? null;
  const browserVerb = browser ? BROWSER_DONE[browser.action] : null;
  const actionCount =
    display === "summary" ? card.fields.length : Math.min(link.actionFields ?? 2, card.fields.length);
  const actionFields = browser
    ? display === "summary"
      ? card.fields
      : card.fields.filter((f) => f.label !== "Value")
    : card.fields.slice(0, actionCount);
  const valueFields = browser
    ? display === "summary"
      ? []
      : card.fields.filter((f) => f.label === "Value")
    : card.fields.slice(actionCount);
  const expires = link.expiresAt ? (
    <time dateTime={link.expiresAt} title={fullFmt.format(new Date(link.expiresAt))}>
      {cardExpiresIn(link.expiresAt, now)}
    </time>
  ) : null;
  const useByPassed = !!link.useBy && new Date(link.useBy).getTime() < now;
  const person = summaryRequester(card);
  const tool = fieldOf(card, "Tool") ?? "it";

  const stateLine = (() => {
    switch (link.status) {
      case "approved":
        if (!link.useBy) return null;
        return useByPassed ? (
          <CardLine testId="agent-card-state-line" icon={Hourglass}>
            {browser
              ? `The page closed or changed before ${bot} could do it. Ask again if you still need it.`
              : `Approved, but ${bot} didn't run it before ${clockOf(link.useBy)}. Ask again if you still need it.`}
          </CardLine>
        ) : (
          <CardLine testId="agent-card-state-line" icon={Clock}>
            {bot} runs it once, before {clockOf(link.useBy)}.
          </CardLine>
        );
      case "applied":
        return (
          <CardLine testId="agent-card-state-line" icon={CircleCheck}>
            {link.usedAt ? `Ran once at ${clockOf(link.usedAt)}.` : "Ran once."}
          </CardLine>
        );
      case "expired":
        return (
          <CardLine testId="agent-card-state-line" icon={Hourglass}>
            {browserVerb
              ? `No one decided within 15 minutes. Nothing was ${browserVerb}.`
              : "No one decided within 24 hours. Nothing was run."}
          </CardLine>
        );
      default:
        return null;
    }
  })();

  const onDecided = (outcome: "approved" | "denied") => {
    if (outcome === "approved") toast.success(`Approved. ${bot} runs it once.`);
    else toast(`Denied. ${bot} won't run it.`);
    after.arm();
  };

  return (
    <>
      <div className="grid gap-3 px-3.5 pb-3.5">
        {display === "summary" ? (
          <ToolFieldList fields={actionFields} section="action" inline />
        ) : (
          <>
            <div className="grid gap-2">
              <SectionLabel>Action</SectionLabel>
              <ToolFieldList fields={actionFields} section="action" browser={browser} />
            </div>
            {valueFields.length > 0 ? (
              <div className="grid gap-2 border-t pt-3">
                <SectionLabel>{browser ? `What ${bot} will type` : `What ${bot} will send`}</SectionLabel>
                <ToolFieldList fields={valueFields} section="value" />
              </div>
            ) : null}
          </>
        )}
        {warnings.map((w) => (
          <WarningLine key={w} text={w} />
        ))}
        {hidden ? <WarningLine text={HIDDEN_NOTICE} /> : null}
        {masked ? (
          <CardLine testId="agent-card-masked" icon={KeyRound}>
            {MASKED_NOTICE}
          </CardLine>
        ) : null}
        {browser?.signedIn && display !== "summary" ? (
          <CardLine testId="agent-card-browser-why" icon={LockKeyhole}>
            {bot} is signed in to {browser.host} with your account, so it asks before acting.
          </CardLine>
        ) : null}
        {pending && display !== "summary" && (mayDecide || !known) ? (
          <CardLine testId="agent-card-timer" icon={browser ? Timer : Clock}>
            {browser
              ? "Runs once, while the page is open"
              : display === "review_only"
                ? "Runs once"
                : "Runs once, with exactly these values"}
            {expires ? <> · {expires}</> : null}
          </CardLine>
        ) : null}
        {pending && known && !mayDecide && display !== "summary" ? (
          <CardLine testId="agent-card-waiting" icon={Hourglass}>
            {waitingFor}.{requester ? " You can't approve your own request." : ""}
          </CardLine>
        ) : null}
        {pending && display === "summary" ? (
          <CardLine testId="agent-card-waiting" icon={Hourglass}>
            {waitingFor}
            {expires ? <> · {expires}</> : null}
          </CardLine>
        ) : null}
        {display === "summary" ? (
          <CardLine testId="agent-card-privacy" icon={Users}>
            Only {person ?? "the person who asked"} and the approvers can see the details.
          </CardLine>
        ) : null}
        {stateLine}
        {display === "review_only" && pending ? (
          <CardLine testId="agent-card-truncated" icon={Info}>
            {TRUNCATED_NOTICE}
          </CardLine>
        ) : null}
      </div>
      {showOpen || decider || card.decision ? (
        <div data-testid="agent-card-actions" className={FOOTER}>
          {showOpen && openTarget ? (
            <Link
              href={openTarget}
              data-testid="agent-card-open"
              className={cn(
                buttonVariants({
                  size: "sm",
                  variant: decider && display === "review_only" ? "default" : "outline",
                }),
                "max-lg:h-11 max-sm:w-full",
              )}
            >
              {card.actions.find((a) => a.kind === "open")?.label ?? "Review"}
              <ArrowRight />
            </Link>
          ) : null}
          {decider ? (
            <span className="flex items-center gap-2 max-sm:w-full @[26rem]:ml-auto">
              <CardDecision
                messageId={messageId}
                link={link}
                approve={
                  display === "exact" ? { label: "Approve", icon: Check, testId: "agent-card-approve" } : null
                }
                deny={{ label: "Deny", testId: "agent-card-deny" }}
                copy={{
                  approved: {
                    title: "Approve this action?",
                    body: browser
                      ? `${bot} does it once, while the page is open${browser.signedIn ? `, signed in to ${browser.host} as you` : ""}.`
                      : `${bot} can run ${tool} once, with exactly these values, within 15 minutes. ${runsWith(card)}`,
                    confirm: "Approve",
                    note: true,
                  },
                  denied: {
                    title: "Deny this action?",
                    body: requester
                      ? `${bot} won't run it.`
                      : `${bot} won't run it. ${person ?? "The person who asked"} sees that you denied it.`,
                    confirm: "Deny",
                    note: true,
                    placeholder: "Tell them why",
                  },
                }}
                onDecided={onDecided}
              />
            </span>
          ) : null}
          {card.decision ? (
            <DecidedBlock decision={card.decision} display={display} focusRef={after.ref} />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** One field of a Work Zone card: the existing label-over-value cell, with the field's glyph. */
function WzField({
  label,
  testId,
  icon: Icon,
  wide,
  children,
}: {
  label: string;
  testId: string;
  icon: LucideIcon | null;
  wide: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0", wide && "@[26rem]:col-span-2")}>
      <dt className="truncate text-[11.5px] text-muted-foreground">{label}</dt>
      <dd
        data-testid={testId}
        className="flex min-w-0 items-center gap-1.5 break-words text-[13.5px] leading-5"
      >
        {Icon ? <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : null}
        {children}
      </dd>
    </div>
  );
}

/** The pill of a 07.5 card, re-rendered when its use window or expiry passes. */
function LinkedApprovalPillNow({ link }: { link: AgentCardApprovalLink }) {
  const now = useNow(link.status === "approved" ? link.useBy : link.expiresAt);
  if (link.kind === "automation.create") {
    return <PillView p={automationPillOf(link.status, link.edited)} status={link.status} />;
  }
  return <LinkedPill kind={link.kind ?? ""} status={link.status} useBy={link.useBy} now={now} />;
}

/** A server field's value with its trailing live state removed: "MacBook Pro · Online" → "MacBook Pro". */
const deviceNameOf = (value: string | null) =>
  (value ?? "").replace(/ · (Online|Offline)$/, "") || "the device";

/**
 * A Work Zone session a bot proposes (Surface 3). Same content for every reader; only the requester gets Review,
 * Start session and Dismiss, with Start disabled (and the reason visible) while the device, runtime or project is
 * unavailable. The Device value is live from `useDevices()` when the viewer knows the device (R9).
 */
function WorkZoneProposalCard({
  messageId,
  card,
  link,
  bot,
}: {
  messageId: string;
  card: AgentCard;
  link: AgentCardApprovalLink;
  bot: string;
}) {
  const me = useMe({ enabled: false }).data?.user.id ?? null;
  const now = useNow(link.expiresAt);
  const after = useFocusAfterDecision(!!card.decision);
  const reasonId = useId();
  const devices = useDevices().data;
  // Device presence on the org stream keeps the list live (R9: the card is never re-posted for it).
  useWorkZoneOrgSync();
  const known = card.viewerCan !== undefined;
  const mayDecide = (card.viewerCan ?? []).includes("decide");
  const requester = me !== null && link.requestedForUserId === me;
  const pending = link.status === "pending" && !card.decision;

  const project = fieldOf(card, "Project") ?? "";
  const deviceField = fieldOf(card, "Device");
  const deviceName = deviceNameOf(deviceField);
  const runtimeLabel = fieldOf(card, "Runtime") ?? "";
  const runtimeId =
    (Object.entries(RUNTIMES).find(([, r]) => r.label === runtimeLabel)?.[0] as keyof typeof RUNTIMES) ??
    "claude-code";
  const forValue = fieldOf(card, "For");
  const person = forValue?.split(" · proposed by ")[0]?.trim() || "the person it was proposed for";
  const prompt = fieldOf(card, "Prompt");
  // The proposal as the shared Work Zone helpers read it, from the server's card fields and link.
  const online = !/ · Offline$/.test(deviceField ?? "");
  const proposal: Pick<WorkZoneProposalView, "device" | "runtime" | "project" | "startBlocked"> = {
    device: {
      id: link.deviceId ?? "",
      name: deviceName,
      online,
      usable: link.blocked !== "device_not_shared",
    },
    runtime: {
      id: runtimeId,
      label: runtimeLabel || "The runtime",
      available: link.blocked !== "runtime_unavailable",
    },
    project: { id: "", name: project, removed: link.blocked === "project_not_found" },
    startBlocked: link.blocked ?? null,
  };

  // Live device state (R9): only for a device in the viewer's own list; anyone else reads the server's text.
  const live = link.deviceId ? devices?.find((d) => d.id === link.deviceId) : undefined;
  const deviceState = live ? deviceStateOf(proposal, live, true) : null;
  const block = pending
    ? deviceState
      ? liveStartBlock(proposal, deviceState, mayDecide)
      : !mayDecide && known
        ? "not_allowed"
        : (link.blocked ?? null)
    : null;

  const openTarget = openTargetOf(card);
  // The client re-checks the route like an Open target: only an internal app route is ever a link.
  const resultRoute =
    link.status === "applied" && link.resultRoute && AgentCardRoute.safeParse(link.resultRoute).success
      ? link.resultRoute
      : null;
  const showButtons = pending && requester && known;
  const readonly = pending && known && !requester;

  const onDecided = (outcome: "approved" | "denied", decided: AgentCard) => {
    const status = decided.approval?.status;
    if (outcome === "denied") toast("Proposal dismissed");
    else if (status === "applied" || status === "approved") toast.success(`Session started on ${deviceName}`);
    else toast.error(failedStartText(decided.approval?.resultCode, proposal));
    after.arm();
  };

  const field = (label: string, testId: string, icon: LucideIcon | null, value: ReactNode, wide = false) => (
    <WzField label={label} testId={testId} icon={icon} wide={wide}>
      {value}
    </WzField>
  );
  // 07.16 (D-18, PD-15): the server's notices (a proposal made after outside content says so), for every reader. Only a
  // platform-composed card carries them; a bot's own card never does (T-07.6-15-03).
  const notices = card.platformOwned === true ? (card.notices ?? []) : [];

  return (
    <>
      <div className="grid gap-3 px-3.5 pb-3.5">
        {notices.map((n, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: notices have no id and are replaced as a whole
          <NoticeLine key={i} notice={n} />
        ))}
        {link.status === "failed" ? (
          <p
            data-testid="agent-card-failed-reason"
            className="flex min-w-0 items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800 text-xs leading-4 dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-300"
          >
            <CircleX className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">{failedStartText(link.resultCode, proposal)}</span>
          </p>
        ) : null}
        <dl data-testid="agent-card-fields" className="grid grid-cols-1 gap-x-4 gap-y-2 @[26rem]:grid-cols-2">
          {field("Project", "agent-card-wz-project", FolderGit2, <span className="min-w-0">{project}</span>)}
          {field(
            "Device",
            "agent-card-wz-device",
            Laptop,
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
              <span className="min-w-0">{deviceName}</span>
              <span aria-hidden className="text-muted-foreground">
                ·
              </span>
              <DeviceState state={deviceState ?? (online ? "online" : "offline")} runtime={runtimeLabel} />
            </span>,
          )}
          {field("Runtime", "agent-card-wz-runtime", null, <span className="min-w-0">{runtimeLabel}</span>)}
          {field(
            "Mode",
            "agent-card-wz-mode",
            Lock,
            <span className="min-w-0">{PROPOSAL_MODE?.label ?? "Supervised"}</span>,
          )}
          {forValue ? field("For", "agent-card-wz-for", null, forValue, true) : null}
        </dl>
        {prompt ? (
          <div className="grid min-w-0 gap-1">
            <p className="text-[11.5px] text-muted-foreground">Prompt</p>
            <div
              data-testid="agent-card-wz-prompt"
              className="min-w-0 rounded-lg bg-muted/50 px-3 py-2 text-sm dark:bg-white/[0.03]"
            >
              <UntrustedText text={prompt} clampLines={4} />
            </div>
          </div>
        ) : null}
        {link.status === "pending" || link.status === "approved" ? (
          <p data-testid="agent-card-wz-mode-line" className="text-muted-foreground text-xs leading-4">
            Asks before edits and commands. Bots never choose Full access.
          </p>
        ) : null}
        {showButtons && block ? (
          <CardLine testId="agent-card-wz-blocked" id={reasonId} icon={Info}>
            {startBlockedText(block, proposal)}
          </CardLine>
        ) : null}
        {link.status === "expired" ? (
          <CardLine testId="agent-card-state-line" icon={Hourglass}>
            No one started it within 24 hours.
          </CardLine>
        ) : null}
        {pending && showButtons && link.expiresAt ? (
          <CardLine testId="agent-card-timer" icon={Clock}>
            <time dateTime={link.expiresAt} title={fullFmt.format(new Date(link.expiresAt))}>
              {cardExpiresIn(link.expiresAt, now)}
            </time>
          </CardLine>
        ) : null}
      </div>
      {showButtons || readonly || card.decision || link.status === "failed" ? (
        <div data-testid="agent-card-actions" className={FOOTER}>
          {showButtons && openTarget ? (
            <Link
              href={openTarget}
              data-testid="agent-card-open"
              className={cn(buttonVariants({ size: "sm", variant: "outline" }), "max-lg:h-11 max-sm:w-full")}
            >
              {card.actions.find((a) => a.kind === "open")?.label ?? "Review"}
              <ArrowRight />
            </Link>
          ) : null}
          {showButtons && mayDecide ? (
            <span className="flex items-center gap-2 max-sm:w-full @[26rem]:ml-auto">
              <CardDecision
                messageId={messageId}
                link={link}
                approve={{
                  label: "Start session",
                  icon: Play,
                  testId: "agent-card-start",
                  disabledBy: block ? reasonId : null,
                }}
                deny={{ label: "Dismiss", testId: "agent-card-dismiss" }}
                copy={{
                  approved: {
                    title: "Start this session?",
                    body: `${runtimeLabel || "The runtime"} runs ${bot}'s prompt in ${project} on ${deviceName}, as you. It starts in Supervised mode: it asks before edits and commands.`,
                    confirm: "Start session",
                    note: false,
                  },
                  denied: {
                    title: "Dismiss this proposal?",
                    body: `No session starts. ${bot} is told you dismissed it.`,
                    confirm: "Dismiss",
                    note: true,
                  },
                }}
                onDecided={onDecided}
              />
            </span>
          ) : null}
          {readonly ? (
            <p
              data-testid="agent-card-wz-readonly"
              className="min-w-0 text-muted-foreground text-xs leading-4"
            >
              Only {person} can start this session.
            </p>
          ) : null}
          {card.decision && link.status !== "failed" ? (
            <DecidedBlock
              decision={card.decision}
              display={link.display}
              verbs={{ approved: "Started", denied: "Dismissed" }}
              focusRef={after.ref}
            />
          ) : null}
          {link.status === "failed" ? (
            <p
              data-testid="agent-card-wz-followup"
              className="min-w-0 text-muted-foreground text-xs leading-4"
            >
              Ask {bot} again when it's fixed.
            </p>
          ) : null}
          {resultRoute ? (
            <Link
              href={resultRoute}
              data-testid="agent-card-open-session"
              className={cn(buttonVariants({ size: "sm" }), "max-lg:h-11 max-sm:w-full")}
            >
              Open session
              <ArrowRight />
            </Link>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** Why creating a proposed automation failed, in words (UI-SPEC § Copy › Natural-language card); never a code. */
export function automationFailedText(
  code: string | null | undefined,
  bot: string,
  conversation: string,
): string {
  switch (code) {
    case "target_not_postable":
    case "agent_not_member":
      return `${bot} can no longer post in ${conversation}.`;
    case "automation_cap":
      return "You've reached your limit of automations.";
    case "schedule_too_frequent":
      return "That schedule is too frequent for this workspace.";
    case "agent_unavailable":
    case "bot_not_readable":
      return `${bot} isn't available any more.`;
    case "runs_per_day":
      return "Its daily run limit is over this workspace's limit.";
    case "proposal_gone":
      return "This proposal is no longer there.";
    default:
      return "Couldn't create the automation.";
  }
}

/**
 * A bot's natural-language automation proposal (07.6-12/15, AUTO-03, D-07, UI-SPEC Surface 5): the same fields for
 * every reader; only the person it will run as gets Edit (the editor with the draft), Create automation and Discard,
 * everyone else reads who can confirm it. The pill and the decided lines follow the approval (Created, Created with
 * changes, Discarded, Expired, Failed); once created, Open automation goes to the server's result route.
 */
function AutomationProposalCard({
  messageId,
  card,
  link,
  bot,
}: {
  messageId: string;
  card: AgentCard;
  link: AgentCardApprovalLink;
  bot: string;
}) {
  const me = useMe({ enabled: false }).data?.user.id ?? null;
  const after = useFocusAfterDecision(!!card.decision);
  const known = card.viewerCan !== undefined;
  const mayDecide = (card.viewerCan ?? []).includes("decide");
  const requester = me !== null && link.requestedForUserId === me;
  const pending = link.status === "pending" && !card.decision;
  const botName = fieldOf(card, "Bot") ?? bot;
  const person = fieldOf(card, "Runs as") ?? "the person it runs as";
  const conversation = fieldOf(card, "Deliver to") ?? "this conversation";
  const firstRun = fieldOf(card, "First run");
  const name = /“(.+)”/.exec(card.title)?.[1] ?? card.title;
  const openTarget = openTargetOf(card);
  const resultRoute =
    link.status === "applied" && link.resultRoute && AgentCardRoute.safeParse(link.resultRoute).success
      ? link.resultRoute
      : null;
  const showButtons = pending && requester && mayDecide;
  const readonly = pending && known && !showButtons;
  // The standing order is always the full-width block (UI-SPEC Surface 5), however short.
  const asBlock = (f: AgentCard["fields"][number]) => f.label === "Instructions" || isBlock(f.value);
  const inline = card.fields.filter((f) => !asBlock(f));
  const blocks = card.fields.filter(asBlock);

  const onDecided = (outcome: "approved" | "denied", decided: AgentCard) => {
    const status = decided.approval?.status;
    if (outcome === "denied") toast("Discarded.");
    else if (status === "applied" || status === "approved") {
      toast.success(firstRun ? `Created “${name}”. First run ${firstRun}.` : `Created “${name}”.`);
    } else toast.error(automationFailedText(decided.approval?.resultCode, botName, conversation));
    after.arm();
  };

  return (
    <>
      <div className="grid gap-3 px-3.5 pb-3.5">
        {link.status === "failed" ? (
          <p
            data-testid="agent-card-failed-reason"
            className="flex min-w-0 items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800 text-xs leading-4 dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-300"
          >
            <CircleX className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">
              {automationFailedText(link.resultCode, botName, conversation)}
            </span>
          </p>
        ) : null}
        {inline.length > 0 ? (
          <dl
            data-testid="agent-card-fields"
            className="grid grid-cols-1 gap-x-4 gap-y-2 @[26rem]:grid-cols-2"
          >
            {inline.map((f, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fields have no id and are replaced as a whole
              <div key={`${i}:${f.label}`} className="min-w-0">
                <dt className="truncate text-[11.5px] text-muted-foreground">{f.label}</dt>
                <dd className="whitespace-pre-wrap break-words text-[13.5px] leading-5">{f.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {blocks.map((f, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fields have no id and are replaced as a whole
          <div key={`${i}:${f.label}`} className="grid min-w-0 gap-1">
            <p className="text-[11.5px] text-muted-foreground">{f.label}</p>
            <div
              data-testid="agent-card-block-value"
              className="min-w-0 rounded-lg bg-muted/50 px-3 py-2 text-[13.5px] leading-5 dark:bg-white/[0.03]"
            >
              <UntrustedText text={f.value} clampLines={6} />
            </div>
          </div>
        ))}
        {link.warnings.map((w) => (
          <WarningLine key={w} text={w} />
        ))}
        {pending ? (
          <p data-testid="agent-card-automation-line" className="text-muted-foreground text-xs leading-4">
            {botName} proposed this. Nothing runs until {person} confirms.
          </p>
        ) : null}
        {link.status === "expired" ? (
          <CardLine testId="agent-card-state-line" icon={Hourglass}>
            No one confirmed it within 24 hours.
          </CardLine>
        ) : null}
      </div>
      {showButtons || readonly || card.decision || link.status === "failed" || resultRoute ? (
        <div data-testid="agent-card-actions" className={FOOTER}>
          {showButtons && openTarget ? (
            <Link
              href={openTarget}
              data-testid="agent-card-open"
              className={cn(buttonVariants({ size: "sm", variant: "outline" }), "max-lg:h-11 max-sm:w-full")}
            >
              {card.actions.find((a) => a.kind === "open")?.label ?? "Edit"}
              <ArrowRight />
            </Link>
          ) : null}
          {showButtons ? (
            <span className="flex items-center gap-2 max-sm:w-full @[26rem]:ml-auto">
              <CardDecision
                messageId={messageId}
                link={link}
                approve={{ label: "Create automation", icon: Check, testId: "agent-card-create" }}
                deny={{ label: "Discard", testId: "agent-card-discard" }}
                copy={{
                  approved: {
                    title: `Create “${name}”?`,
                    body: `It runs as you${firstRun ? ` from ${firstRun}` : ""}, with your permissions. You can pause or delete it in Bots › Automations.`,
                    confirm: "Create automation",
                    note: false,
                  },
                  denied: {
                    title: `Discard “${name}”?`,
                    body: `Nothing is created. ${botName} is told you discarded it.`,
                    confirm: "Discard",
                    note: false,
                  },
                }}
                onDecided={onDecided}
              />
            </span>
          ) : null}
          {readonly ? (
            <p
              data-testid="agent-card-automation-readonly"
              className="min-w-0 text-muted-foreground text-xs leading-4"
            >
              Only {person} can confirm this automation.
            </p>
          ) : null}
          {card.decision && link.status !== "failed" ? (
            <DecidedBlock
              decision={card.decision}
              display={link.display}
              verbs={{ approved: "Created", denied: "Discarded" }}
              focusRef={after.ref}
            />
          ) : null}
          {link.status === "failed" ? (
            <p
              data-testid="agent-card-automation-followup"
              className="min-w-0 text-muted-foreground text-xs leading-4"
            >
              Ask {botName} again when it's fixed.
            </p>
          ) : null}
          {resultRoute ? (
            <Link
              href={resultRoute}
              data-testid="agent-card-open-automation"
              className={cn(buttonVariants({ size: "sm", variant: "outline" }), "max-lg:h-11 max-sm:w-full")}
            >
              Open automation
              <ArrowRight />
            </Link>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function AgentCardView({
  messageId,
  card: listed,
  summary,
  authorName,
  author,
}: {
  messageId: string;
  card: AgentCard;
  summary: string;
  /** The posting agent's name, for copy that names the bot (a failed proposal's reason). */
  authorName?: string | undefined;
  /** 07.8-26: the posting bot (id and avatar), so a sign-in card opens its live view. */
  author?: LiveBot | undefined;
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
  // 07.5 kinds (an action, a Work Zone proposal) render their own body and footer; every other card is unchanged.
  const linkedKind = linkedKindOf(link);
  const bot = authorName ?? "the bot";
  // 07.8-26 (UI-SPEC Surface 2): the platform's sign-in card renders its own body and footer under the kind row.
  const signIn = card.platformOwned === true && card.kind === "browser" ? (card.browserSignIn ?? null) : null;
  // 07.6 (R1, T-07.6-15-03): every card the server composed carries the badge, its own pill word and its notices; a
  // bot's card never does, whatever its data says.
  const platform = card.platformOwned === true;
  const badge = !!link || !!signIn || platform;
  // 07.16 (D-12, PD-20): the live card of a bot-started session (platform-owned, no approval, Open to the session)
  // renders as `WorkSessionCard` inside this shell; every other card, proposals included, is unchanged.
  const live = !link && !signIn && workSessionCardOf(card) !== null;
  // 07.17.1.1.2-10 (D-05, PD-20): a platform task card with its server-composed task renders as `TaskCard` inside this
  // shell, its pill from the task itself; a task card without `card.task` (an older API) stays a generic card (PD-21).
  const task = platform && card.kind === "task" && !link && !signIn && !live ? (card.task ?? null) : null;
  const pillStatus = task ? taskCardStatus(task.status) : card.status;
  const statusLabel = platform
    ? live
      ? workSessionStatusWord(card.status, card.statusLabel)
      : task
        ? taskStatusLabel(task.status, task.outcome)
        : card.statusLabel
    : undefined;
  const notices = platform && !linkedKind && !signIn ? (card.notices ?? []) : [];

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
      <div
        className={
          signIn
            ? "grid gap-2.5 px-3.5 pt-3"
            : linkedKind || live || task
              ? "grid gap-2.5 px-3.5 pt-3 pb-3"
              : "grid gap-2.5 px-3.5 pt-3 pb-3.5"
        }
      >
        <div
          className={cn(
            "flex min-w-0 items-center justify-between gap-2",
            // The sign-in pill is long ("Sign-in needed"), and so is a proposal's ("Created with changes"): on a narrow
            // card it drops under the kind and badge instead of covering the badge.
            (signIn || linkedKind === "automation") && "flex-wrap gap-y-1.5",
          )}
        >
          <span
            className={cn(
              "flex min-w-0 items-center gap-1.5 font-medium text-[11.5px] text-muted-foreground uppercase tracking-wider",
              // A linked card's badge wraps under the kind on narrow cards instead of hiding it.
              badge && "flex-wrap gap-y-1",
            )}
          >
            <KindIcon className="size-3.5 shrink-0" aria-hidden />
            <span className={cn("truncate", badge && "shrink-0")} data-testid="agent-card-kind">
              {kind.label}
            </span>
            {badge ? <WorkspaceBadge id={`${summaryId}-workspace`} /> : null}
          </span>
          {/* Keyed by status: a change re-mounts the pill only, which fades it in (nothing else moves). */}
          {signIn ? (
            <SignInPillNow key={signIn.status} link={signIn} />
          ) : link && linkedKind ? (
            <LinkedApprovalPillNow key={link.status} link={link} />
          ) : link ? (
            <ApprovalStatusPill key={link.status} status={link.status} />
          ) : (
            <StatusPill key={`${pillStatus}:${statusLabel ?? ""}`} status={pillStatus} label={statusLabel} />
          )}
        </div>
        {live ? (
          <WorkSessionCardHeading card={card} titleId={`${summaryId}-title`} />
        ) : (
          <h3
            id={`${summaryId}-title`}
            data-testid="agent-card-title"
            className="break-words font-semibold text-[15px] leading-snug"
          >
            {card.title}
          </h3>
        )}
        {notices.map((n, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: notices have no id and are replaced as a whole
          <NoticeLine key={i} notice={n} />
        ))}
        {link?.status === "failed" && !linkedKind ? (
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
        {card.fields.length > 0 && !linkedKind && !signIn && !live && !task ? (
          <dl
            data-testid="agent-card-fields"
            className="grid grid-cols-1 gap-x-4 gap-y-2 @[26rem]:grid-cols-2"
          >
            {card.fields.map((f, i) =>
              // 07.6 (UI-SPEC 8): a platform card's long value is a block value, clamped with Show more.
              platform && isBlock(f.value) ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: fields have no id and are replaced as a whole
                <div key={`${i}:${f.label}`} className="min-w-0 @[26rem]:col-span-2">
                  <dt className="truncate text-[11.5px] text-muted-foreground">{f.label}</dt>
                  <dd
                    data-testid="agent-card-block-value"
                    className="mt-1 min-w-0 rounded-lg bg-muted/50 px-3 py-2 text-[13.5px] leading-5 dark:bg-white/[0.03]"
                  >
                    <UntrustedText text={f.value} clampLines={6} />
                  </dd>
                </div>
              ) : (
                // Labels may repeat: the position keeps the key unique (fields are replaced as a whole).
                // biome-ignore lint/suspicious/noArrayIndexKey: fields have no id and are replaced as a whole
                <div key={`${i}:${f.label}`} className="min-w-0">
                  <dt className="truncate text-[11.5px] text-muted-foreground">{f.label}</dt>
                  <dd className="whitespace-pre-wrap break-words text-[13.5px] leading-5">{f.value}</dd>
                </div>
              ),
            )}
          </dl>
        ) : null}
        {link && !linkedKind && summary.trim() && summary !== card.title ? (
          <ChangePreview text={summary} />
        ) : null}
        {linkedKind ? null : link?.warnings.map((w) => <WarningLine key={w} text={w} />)}
      </div>
      {signIn ? (
        <SignInCardBody
          messageId={messageId}
          card={card}
          link={signIn}
          bot={author ?? { id: messageId, name: bot, avatarUrl: null }}
        />
      ) : link && linkedKind === "tool" ? (
        <ToolCallCard messageId={messageId} card={card} link={link} bot={bot} />
      ) : link && linkedKind === "work_zone" ? (
        <WorkZoneProposalCard messageId={messageId} card={card} link={link} bot={bot} />
      ) : link && linkedKind === "automation" ? (
        <AutomationProposalCard messageId={messageId} card={card} link={link} bot={bot} />
      ) : link ? (
        <LinkedFooter messageId={messageId} card={card} link={link} openTarget={openTarget} />
      ) : live ? (
        <WorkSessionCard messageId={messageId} card={card} />
      ) : task ? (
        <TaskCard messageId={messageId} card={card} task={task} />
      ) : hasActions || card.decision ? (
        <div
          data-testid="agent-card-actions"
          className="flex flex-wrap items-center gap-2 border-t bg-muted/35 px-3.5 py-2.5 dark:bg-white/[0.02]"
        >
          {openTarget ? (
            <Link
              href={openTarget}
              data-testid="agent-card-open"
              className={
                // A platform card's actions are 44 px, full width at 390 (UI-SPEC "Cards at 390"); any other card's
                // markup stays exactly as it was (no class merge).
                platform
                  ? cn(buttonVariants({ size: "sm", variant: "outline" }), "max-lg:h-11 max-sm:w-full")
                  : buttonVariants({ size: "sm", variant: "outline" })
              }
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
              className={platform ? "max-lg:h-11 max-sm:w-full" : undefined}
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

/** The sign-in card's pill, moving to Expired on its own when the countdown runs out (07.8-26). */
function SignInPillNow({ link }: { link: NonNullable<AgentCard["browserSignIn"]> }) {
  const [now, setNow] = useState(() => Date.now());
  const waiting = link.status === "waiting" || link.status === "signing_in";
  useEffect(() => {
    if (!waiting) return;
    const left = Date.parse(link.expiresAt) - Date.now();
    if (left < 0 || left > 24 * 3_600_000) return;
    const t = window.setTimeout(() => setNow(Date.now()), left + 250);
    return () => window.clearTimeout(t);
  }, [waiting, link.expiresAt]);
  return <SignInPill status={signInStatusOf(link, now)} />;
}
