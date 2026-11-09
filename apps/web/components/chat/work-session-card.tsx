"use client";

import {
  type AgentCard,
  type AgentCardStatus,
  WORK_SESSION_CARD_LABELS,
  workSessionCardOf,
} from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowRight, Bell, BellRing, Clock, Cpu, type LucideIcon, Server } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { FullAccessBadge } from "@/components/work-zone/full-access-badge";
import { RUNTIMES, RuntimeLogo } from "@/components/work-zone/meta";
import { errorMessage } from "@/lib/api";
import { followCard } from "@/lib/card-queries";
import { cn, relativeTime } from "@/lib/utils";

/**
 * The live Work Zone card of a bot-started session (07.16, D-12, PD-12, PD-20; ADR-0031). The server composes it
 * (platform-owned) and every reader of the conversation sees the same card, so it shows only the viewer-neutral facts
 * `workSessionCardOf` reads: runtime, the repository's name, device, model, mode, step and the last update. It never
 * shows a prompt, output or title, whatever the card carries (E13). The one card renderer (`AgentCardView`) keeps the
 * shell (kind row, workspace badge, status pill, notices) and puts these parts in it; a proposal card (with an
 * `approval`) is never live and keeps `WorkZoneProposalCard`.
 */

/** The live card's pill word: the server's label first, else the session's own word for the status. */
const STATUS_WORD: Record<AgentCardStatus, string> = {
  running: "Working",
  pending: "Waiting",
  info: "Idle",
  succeeded: "Ended",
  failed: "Failed",
  cancelled: "Stopped",
};

export function workSessionStatusWord(status: AgentCardStatus, label?: string | undefined): string {
  return label ?? STATUS_WORD[status] ?? "Working";
}

/** The card's Updated value as "2 minutes ago", re-read every 30 s; a value that is not a time is shown as it came. */
function useUpdatedText(value: string | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  const at = value ? Date.parse(value) : Number.NaN;
  const valid = Number.isFinite(at);
  useEffect(() => {
    if (!valid) return;
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [valid]);
  if (!value) return null;
  return valid ? relativeTime(new Date(at).toISOString(), now) : value;
}

/**
 * The live card's heading: the runtime's logo, the server's title ("Work Zone · billing-api"), and under it the runtime
 * and mode, with the Full access badge in place of the mode when the session runs without prompts.
 */
export function WorkSessionCardHeading({ card, titleId }: { card: AgentCard; titleId: string }) {
  const facts = workSessionCardOf(card);
  if (!facts) return null;
  const runtime = facts.runtime ? RUNTIMES[facts.runtime].label : null;
  const sub = [runtime, facts.fullAccess ? null : facts.mode].filter((v): v is string => !!v).join(" · ");
  return (
    <div className="flex min-w-0 items-center gap-3" data-testid="wz-live-heading">
      {facts.runtime ? (
        <RuntimeLogo runtime={facts.runtime} className="size-9 rounded-lg" />
      ) : (
        <span
          aria-hidden
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
        >
          <Activity className="size-4" />
        </span>
      )}
      <div className="grid min-w-0 flex-1 gap-0.5">
        <h3
          id={titleId}
          data-testid="agent-card-title"
          className="truncate font-semibold text-[15px] leading-snug"
          title={card.title}
        >
          {card.title}
        </h3>
        {sub || facts.fullAccess ? (
          <p
            data-testid="wz-live-sub"
            className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground leading-4"
          >
            {sub ? <span className="truncate">{sub}</span> : null}
            {/* In place of the mode: the session runs without prompts (D-04), under the title so it never squeezes it. */}
            {facts.fullAccess ? <FullAccessBadge className="h-5 px-1.5 text-[11px]" /> : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Fact({
  label,
  testId,
  icon: Icon,
  children,
}: {
  label: string;
  testId: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11.5px] text-muted-foreground">{label}</dt>
      <dd data-testid={testId} className="flex min-w-0 items-center gap-1.5 text-[13.5px] leading-5">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate">{children}</span>
      </dd>
    </div>
  );
}

/** The live card's facts and its actions (Open session, Follow), under the heading. */
export function WorkSessionCard({ messageId, card }: { messageId: string; card: AgentCard }) {
  const qc = useQueryClient();
  const facts = workSessionCardOf(card);
  const updated = useUpdatedText(facts?.updatedAt ?? null);
  if (!facts) return null;
  const open = card.actions.find((a) => a.kind === "open");
  const followAction = card.actions.find((a) => a.kind === "follow");
  const following = card.following === true;
  const showFollow = !!followAction && (card.viewerCan ?? []).includes("follow");
  const toggleFollow = () =>
    void followCard(qc, messageId, !following, card).catch((err) => toast.error(errorMessage(err)));
  const L = WORK_SESSION_CARD_LABELS;

  return (
    <>
      <div className="px-3.5 pb-3.5" data-live-session={facts.workSessionId}>
        <dl
          data-testid="wz-live-facts"
          className="grid grid-cols-1 gap-x-4 gap-y-2.5 rounded-lg bg-muted/40 px-3 py-2.5 md:grid-cols-2 dark:bg-white/[0.03]"
        >
          {facts.device ? (
            <Fact label={L.device} testId="wz-live-device" icon={Server}>
              {facts.device}
            </Fact>
          ) : null}
          {facts.model ? (
            <Fact label={L.model} testId="wz-live-model" icon={Cpu}>
              {facts.model}
            </Fact>
          ) : null}
          {facts.step ? (
            <Fact label={L.step} testId="wz-live-step" icon={Activity}>
              {facts.step}
            </Fact>
          ) : null}
          {updated ? (
            <Fact label={L.updated} testId="wz-live-updated" icon={Clock}>
              {facts.updatedAt && Number.isFinite(Date.parse(facts.updatedAt)) ? (
                <time dateTime={facts.updatedAt}>{updated}</time>
              ) : (
                updated
              )}
            </Fact>
          ) : null}
        </dl>
      </div>
      <div
        data-testid="agent-card-actions"
        className="flex flex-wrap items-center gap-2 border-t bg-muted/35 px-3.5 py-2.5 dark:bg-white/[0.02]"
      >
        <Link
          href={`/work-zone/${encodeURIComponent(facts.workSessionId)}`}
          data-testid="agent-card-open"
          className={cn(buttonVariants({ size: "sm" }), "max-md:h-11 max-md:w-full")}
        >
          {open?.label ?? "Open session"}
          <ArrowRight />
        </Link>
        {showFollow ? (
          <Button
            size="sm"
            variant={following ? "secondary" : "ghost"}
            aria-pressed={following}
            data-testid="agent-card-follow"
            onClick={toggleFollow}
            className="max-md:h-11 max-md:w-full"
          >
            {following ? <BellRing /> : <Bell />}
            {following ? "Following" : followAction.label}
          </Button>
        ) : null}
      </div>
    </>
  );
}
