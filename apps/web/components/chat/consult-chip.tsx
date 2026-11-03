"use client";

import type { MessageConsult } from "@ocw/contracts";
import {
  CircleAlert,
  CircleCheck,
  CircleStop,
  CornerDownRight,
  Forward,
  Gauge,
  LoaderCircle,
  type LucideIcon,
  Square,
  TimerOff,
  Waypoints,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { stopErrorMessage, stopSuccessMessage, useCancelAgentChain } from "@/lib/consult-queries";
import { cn } from "@/lib/utils";
import { dirKey, type OrgDirectory, useOrgDirectory } from "./use-chat-directory";

/**
 * A consult hop in a thread (07.7-10; A2A-01, A2A-03, D-01, D-04, ADR-0027). The asking bot's question and the consulted
 * bot's answer are ordinary messages; `message.consult` (server side data, viewer-agnostic) adds this compact provenance
 * chip between the author line and the body: "Asked @bea for Víctor · Waiting…" on the question (its status follows the
 * server live through `message.updated`), "Answer to @archie" on the answer. Provenance never comes from message text.
 * The status is always a word, never a colour alone.
 */

export type ConsultTone = "muted" | "ok" | "warn";

export interface ConsultChipModel {
  icon: LucideIcon;
  text: string;
  /** The question's state; the answer carries none. */
  status?: { icon: LucideIcon; label: string; tone: ConsultTone; spin: boolean };
  /** Offer Stop: a waiting question, seen by the chain's human or a channel moderator (a hint; the API decides). */
  canStop: boolean;
}

/** Who is looking: the chain's human, and whether they may moderate the channel (`message.delete_any`). */
export interface ConsultViewer {
  isHuman: boolean;
  canModerate: boolean;
}

/** How the chip names the hop's parties: `@handle` for bots, the display name for the person; never an id. */
export interface ConsultNames {
  target: string;
  source: string;
  human: string;
}

const STATUS: Record<
  MessageConsult["status"],
  { icon: LucideIcon; label: string; handoff?: string; tone: ConsultTone }
> = {
  pending: { icon: LoaderCircle, label: "Waiting…", handoff: "Working…", tone: "muted" },
  answered: { icon: CircleCheck, label: "Answered", handoff: "Handed over", tone: "ok" },
  failed: { icon: CircleAlert, label: "Couldn't answer", tone: "warn" },
  timed_out: { icon: TimerOff, label: "No answer in time", tone: "warn" },
  cancelled: { icon: CircleStop, label: "Stopped", tone: "muted" },
  refused: { icon: Gauge, label: "Daily limit reached", tone: "warn" },
};

/** Status text and icon together; the label always carries the meaning (amber/emerald pairs of message-list.tsx). */
export const TONE_CLASS: Record<ConsultTone, string> = {
  muted: "",
  ok: "text-emerald-700 dark:text-emerald-400",
  warn: "text-amber-700 dark:text-amber-400",
};

/** The chip's names from the viewer's own directory, with neutral fallbacks for anyone it does not list. */
export function consultNames(consult: MessageConsult, dir: Pick<OrgDirectory, "byKey">): ConsultNames {
  const bot = (id: string) => {
    const handle = dir.byKey.get(dirKey("agent", id))?.handle;
    return handle ? `@${handle}` : "a bot";
  };
  return {
    target: bot(consult.targetAgentId),
    source: bot(consult.sourceAgentId),
    human: dir.byKey.get(dirKey("user", consult.onBehalfOfUserId))?.displayName ?? "a teammate",
  };
}

/** What the chip says for this hop (pure: the copy table of the 07.7-10 UI contract). */
export function consultChipModel(
  consult: MessageConsult,
  names: ConsultNames,
  viewer: ConsultViewer,
): ConsultChipModel {
  if (consult.role === "answer") {
    return { icon: CornerDownRight, text: `Answer to ${names.source}`, canStop: false };
  }
  const handoff = consult.mode === "handoff";
  const step = consult.depth >= 2 ? "Step 2 · " : "";
  const asked = handoff
    ? `Handed over to ${names.target} for ${names.human}`
    : `Asked ${names.target} for ${names.human}`;
  const s = STATUS[consult.status];
  return {
    icon: handoff ? Forward : Waypoints,
    text: `${step}${asked}`,
    status: {
      icon: s.icon,
      label: (handoff ? s.handoff : undefined) ?? s.label,
      tone: s.tone,
      spin: consult.status === "pending",
    },
    canStop: consult.status === "pending" && (viewer.isHuman || viewer.canModerate),
  };
}

/** Stop the chain this question belongs to; the chip turns Stopped when the server announces it. */
function StopButton({ consult, names }: { consult: MessageConsult; names: ConsultNames }) {
  const cancel = useCancelAgentChain();
  return (
    <Button
      type="button"
      variant="ghost"
      data-testid="consult-stop"
      aria-label={`Stop asking ${names.target}`}
      disabled={cancel.isPending}
      onClick={() =>
        cancel.mutate(consult.chainId, {
          onSuccess: () => toast.success(stopSuccessMessage(names.source)),
          onError: (err) => toast.error(stopErrorMessage(err)),
        })
      }
      className="h-6 gap-1 px-1.5 font-medium text-foreground text-xs max-md:h-11 max-md:px-3"
    >
      {cancel.isPending ? <Spinner className="size-3" /> : <Square aria-hidden className="size-3" />}
      Stop
    </Button>
  );
}

export function ConsultChip({
  consult,
  meId,
  canModerate,
}: {
  consult: MessageConsult;
  /** The signed-in person (empty while unknown: no Stop). */
  meId: string;
  /** The channel's `viewerCan` has `message.delete_any`. */
  canModerate: boolean;
}) {
  const dir = useOrgDirectory();
  const names = consultNames(consult, dir);
  const model = consultChipModel(consult, names, {
    isHuman: !!meId && meId === consult.onBehalfOfUserId,
    canModerate,
  });
  const Icon = model.icon;
  const status = model.status;
  const StatusIcon = status?.icon;
  return (
    <p
      data-testid="consult-chip"
      data-role={consult.role}
      data-status={consult.status}
      className="mb-1 flex w-fit max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-md border bg-muted/40 px-2 py-0.5 text-muted-foreground text-xs leading-5 dark:bg-white/[0.04]"
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{model.text}</span>
      {status && StatusIcon ? (
        <>
          <span aria-hidden>·</span>
          <span
            data-testid="consult-status"
            className={cn("inline-flex items-center gap-1 font-medium", TONE_CLASS[status.tone])}
          >
            <StatusIcon
              aria-hidden
              className={cn("size-3 shrink-0", status.spin && "animate-spin motion-reduce:animate-none")}
            />
            {status.label}
          </span>
        </>
      ) : null}
      {model.canStop ? <StopButton consult={consult} names={names} /> : null}
    </p>
  );
}
