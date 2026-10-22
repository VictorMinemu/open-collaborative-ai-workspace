"use client";

import type { AgentCard, AgentCardBrowserSignInLink, BrowserSignInStatus } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  CircleCheck,
  CircleSlash,
  Hourglass,
  KeyRound,
  LockKeyhole,
  LogIn,
  type LucideIcon,
  MonitorOff,
} from "lucide-react";
import Link from "next/link";
import { type MouseEvent, type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { UntrustedText } from "@/components/approvals/untrusted-text";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, isApiError } from "@/lib/api";
import { decideCard, refreshCard } from "@/lib/card-queries";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { HostChip } from "./host-chip";
import { endedSentence, type LiveBot, useLiveStore } from "./live-store";
import { useOptionalLiveView } from "./live-view-provider";

/**
 * The body of the platform-owned "Sign in needed" card (07.8-26; D-07, D-08, R1, UI-SPEC Surface 2), rendered by
 * `AgentCardView` for kind `browser` under its kind row, workspace badge, pill and title (never a fork of the card).
 *
 * - The site is the page's host from the server's sign-in link (never the bot's words); the bot's reason is quoted
 *   plain text under "Why" (T-07.8-26-02).
 * - Waiting: the assurance line and the countdown (every minute, every second under one; announced at 5 and 1 min).
 *   Only the requester (`viewerCan.sign_in`) gets Open and sign in and Not now; anyone else reads "Only {person} can
 *   sign in here."
 * - Open and sign in / Return to sign-in open the live view on the card's page and take control in one step (large view
 *   on desktop, full sheet on phones). Not now is the card's denied decision. After the hand back the card reads Signed
 *   in, links to Keychain, and the toast says "Signed in to {host}. {bot} continues."
 */

const SIGNIN_TOAST = (host: string, bot: string) => `Signed in to ${host}. ${bot} continues.`;

/** The status the card shows now: a waiting sign-in past its expiry reads Expired before the sweep writes it. */
export function signInStatusOf(link: AgentCardBrowserSignInLink, now: number): BrowserSignInStatus {
  const waiting = link.status === "waiting" || link.status === "signing_in";
  return waiting && Date.parse(link.expiresAt) <= now ? "expired" : link.status;
}

/** "Expires in 14 min", "Expires in 42 s" under a minute (UI-SPEC Timer). */
export function signInExpiresIn(expiresAt: string, now: number): string {
  const left = Date.parse(expiresAt) - now;
  if (left <= 0) return "Expired";
  if (left < 60_000) return `Expires in ${Math.max(1, Math.ceil(left / 1000))} s`;
  return `Expires in ${Math.ceil(left / 60_000)} min`;
}

/** The minute marks screen readers hear (UI-SPEC Interaction "Sign-in card": announced only at 5 min and 1 min). */
export function signInAnnouncement(expiresAt: string, now: number): string | null {
  const left = Date.parse(expiresAt) - now;
  if (left <= 0) return null;
  const minutes = Math.ceil(left / 60_000);
  if (minutes === 5) return "This sign-in expires in 5 minutes.";
  if (minutes === 1) return "This sign-in expires in 1 minute.";
  return null;
}

/** The pill (UI-SPEC Surface 2 Card states: label overrides over the card's status tones). */
const PILL: Record<
  BrowserSignInStatus,
  { label: string; tone: string; icon: LucideIcon | "dot"; dot?: string }
> = {
  waiting: {
    label: "Sign-in needed",
    tone: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
    icon: "dot",
    dot: "bg-amber-500",
  },
  signing_in: {
    label: "Signing in…",
    tone: "bg-primary/10 text-primary dark:bg-primary/20 dark:text-blue-200",
    icon: "dot",
    dot: "bg-primary dark:bg-blue-300",
  },
  signed_in: {
    label: "Signed in",
    tone: "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300",
    icon: CircleCheck,
  },
  skipped: { label: "Skipped", tone: "bg-muted text-muted-foreground", icon: CircleSlash },
  expired: { label: "Expired", tone: "bg-muted text-muted-foreground", icon: Hourglass },
  stopped: { label: "Stopped", tone: "bg-muted text-muted-foreground", icon: MonitorOff },
};

export function SignInPill({ status }: { status: BrowserSignInStatus }) {
  const p = PILL[status];
  const Icon = p.icon === "dot" ? null : p.icon;
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
      ) : (
        <span aria-hidden className={cn("inline-flex size-1.5 rounded-full", p.dot)} />
      )}
      {p.label}
    </span>
  );
}

/** Re-renders on the countdown's steps while the card waits: each minute, each second under one. */
function useCountdown(expiresAt: string, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  // biome-ignore lint/correctness/useExhaustiveDependencies: `now` re-arms the timer after each step
  useEffect(() => {
    if (!active) return;
    const left = Date.parse(expiresAt) - Date.now();
    if (left <= -1_000) return;
    const wait = left > 60_000 ? ((left - 1) % 60_000) + 1 : Math.min(1_000, Math.max(0, left) + 50);
    const t = window.setTimeout(() => setNow(Date.now()), Math.max(50, wait));
    return () => window.clearTimeout(t);
  }, [expiresAt, active, now]);
  return now;
}

const dateFmt = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const decidedFmt = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** One quiet line of the card (12/400 muted with its glyph), the agent card's `CardLine` look. */
function Line({ testId, icon: Icon, children }: { testId: string; icon: LucideIcon; children: ReactNode }) {
  return (
    <p
      data-testid={testId}
      className="flex min-w-0 items-start gap-1.5 text-muted-foreground text-xs leading-4"
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

const FOOTER = "flex flex-wrap items-center gap-2 border-t bg-muted/35 px-3.5 py-2.5 dark:bg-white/[0.02]";

export function SignInCardBody({
  messageId,
  card,
  link,
  bot,
}: {
  messageId: string;
  card: AgentCard;
  link: AgentCardBrowserSignInLink;
  /** The posting bot (its id and avatar open the live view); its name is in every sentence. */
  bot: LiveBot;
}) {
  const qc = useQueryClient();
  const live = useOptionalLiveView();
  const me = useMe({ enabled: false }).data?.user.id ?? null;
  const waitingLike = link.status === "waiting" || link.status === "signing_in";
  const now = useCountdown(link.expiresAt, waitingLike);
  const status = signInStatusOf(link, now);
  const requester = me !== null && me === link.requesterId;
  const maySignIn =
    (card.viewerCan ?? []).includes("sign_in") && (status === "waiting" || status === "signing_in");
  const person = link.requesterName ?? "The person the bot asked";
  const why = card.fields.find((f) => f.label === "Why")?.value ?? null;
  const happened = card.fields.find((f) => f.label === "What happened")?.value ?? null;

  // "Opening…" from the press until the live view takes control (or is refused).
  const view = useLiveStore((s) => s.view);
  const [opening, setOpening] = useState(false);
  const openingNow =
    opening && view?.contextId === link.contextId && (view.wantControl || view.pending === "take");
  useEffect(() => {
    if (opening && !openingNow) setOpening(false);
  }, [opening, openingNow]);

  // The hand back from this card's view: the toast once the card says "Signed in".
  const handBack = useLiveStore((s) => s.signInHandBack);
  useEffect(() => {
    if (!handBack || handBack.messageId !== messageId || status !== "signed_in") return;
    useLiveStore.getState().setSignInHandBack(null);
    toast(SIGNIN_TOAST(handBack.host, handBack.bot));
  }, [handBack, messageId, status]);

  const openAndSignIn = (e: MouseEvent<HTMLButtonElement>) => {
    if (!live) return;
    setOpening(true);
    live.open({
      contextId: link.contextId,
      bot,
      takeControl: true,
      trigger: e.currentTarget,
      signIn: { messageId, host: link.host },
    });
  };

  const [skipping, setSkipping] = useState(false);
  const notNow = async () => {
    setSkipping(true);
    try {
      await decideCard(qc, messageId, { outcome: "denied" });
    } catch (err) {
      toast.error(errorMessage(err));
      if (isApiError(err, 409) || isApiError(err, 403)) void refreshCard(qc, messageId);
    } finally {
      setSkipping(false);
    }
  };

  const announcement = status === "waiting" ? signInAnnouncement(link.expiresAt, now) : null;
  const decidedAt = link.decidedAt ?? null;

  return (
    <>
      <div data-testid="signin-card" data-status={status} className="grid gap-2.5 px-3.5 pt-2.5 pb-3">
        <dl className="grid gap-y-2">
          <Field label="Site">
            <HostChip host={link.host} secure={link.secure} testId="signin-host" className="text-[13px]" />
          </Field>
          {why ? (
            <Field label="Why">
              <UntrustedText
                text={`“${why}”`}
                clampLines={3}
                className="text-[13.5px] leading-5"
                data-testid="signin-why"
              />
            </Field>
          ) : null}
          {happened ? (
            <Field label="What happened">
              <span className="text-[13.5px] leading-5">{happened}</span>
            </Field>
          ) : null}
        </dl>
        {status === "waiting" ? (
          <>
            <Line testId="signin-assurance" icon={LockKeyhole}>
              You type in the page yourself. {bot.name} never sees what you type, and password fields are
              hidden from it.
            </Line>
            <Line testId="signin-timer" icon={Hourglass}>
              <time dateTime={link.expiresAt}>{signInExpiresIn(link.expiresAt, now)}</time>
            </Line>
            <span className="sr-only" aria-live="polite">
              {announcement ?? ""}
            </span>
          </>
        ) : status === "signing_in" ? (
          <Line testId="signin-state-line" icon={LogIn}>
            {requester ? "You're signing in." : `${person} is signing in.`}
          </Line>
        ) : status === "signed_in" ? (
          requester ? (
            <p
              data-testid="signin-state-line"
              className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] leading-5"
            >
              <span>
                {link.sessionExpiresAt
                  ? `Signed in until ${dateFmt.format(new Date(link.sessionExpiresAt))}. `
                  : "Signed in. "}
                {bot.name} continues.
              </span>
              <Link
                href="/settings/keychain#browser-sessions"
                data-testid="signin-keychain"
                className="inline-flex items-center gap-1 rounded-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/40 max-md:min-h-11"
              >
                <KeyRound aria-hidden className="size-3.5" />
                Manage in Keychain
              </Link>
            </p>
          ) : (
            <p data-testid="signin-state-line" className="text-[13px] leading-5">
              {person} signed in. {bot.name} continues.
            </p>
          )
        ) : status === "skipped" ? (
          <Line testId="signin-state-line" icon={CircleSlash}>
            {person} didn't sign in. {bot.name} was told.
          </Line>
        ) : status === "expired" ? (
          <Line testId="signin-state-line" icon={Hourglass}>
            No one signed in within 15 minutes. Ask {bot.name} again.
          </Line>
        ) : (
          <Line testId="signin-state-line" icon={MonitorOff}>
            {endedSentence(link.stopReason ?? undefined, bot.name)}
          </Line>
        )}
      </div>
      {status === "waiting" && maySignIn ? (
        <div
          data-testid="agent-card-actions"
          className={cn(FOOTER, "@max-[26rem]:flex-col-reverse @max-[26rem]:items-stretch")}
        >
          <Button
            variant="ghost"
            size="sm"
            data-testid="signin-skip"
            disabled={skipping || openingNow}
            onClick={() => void notNow()}
            className="max-lg:h-11"
          >
            {skipping ? <Spinner /> : null}
            Not now
          </Button>
          <Button
            size="sm"
            data-testid="signin-open"
            disabled={openingNow || skipping}
            onClick={openAndSignIn}
            className="max-lg:h-11 @[26rem]:ml-auto"
          >
            {openingNow ? <Spinner /> : <LogIn aria-hidden />}
            {openingNow ? "Opening…" : "Open and sign in"}
          </Button>
        </div>
      ) : status === "waiting" ? (
        <div data-testid="agent-card-actions" className={FOOTER}>
          <p data-testid="signin-only" className="min-w-0 text-muted-foreground text-xs leading-4">
            Only {link.requesterName ?? "the person the bot asked"} can sign in here.
          </p>
        </div>
      ) : status === "signing_in" && maySignIn ? (
        <div data-testid="agent-card-actions" className={FOOTER}>
          <Button
            size="sm"
            variant="outline"
            data-testid="signin-return"
            disabled={openingNow}
            onClick={openAndSignIn}
            className="max-lg:h-11 @max-[26rem]:w-full"
          >
            {openingNow ? <Spinner /> : <LogIn aria-hidden />}
            {openingNow ? "Opening…" : "Return to sign-in"}
          </Button>
        </div>
      ) : status === "signed_in" && decidedAt ? (
        <div data-testid="agent-card-actions" className={FOOTER}>
          <p
            data-testid="agent-card-decision"
            data-outcome="approved"
            className="flex min-w-0 items-start gap-1.5 font-medium text-[13px] text-emerald-800 leading-5 dark:text-emerald-300"
          >
            <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">
              Signed in by {person}{" "}
              <time
                dateTime={decidedAt}
                className="whitespace-nowrap font-normal text-muted-foreground text-xs"
              >
                · {decidedFmt.format(new Date(decidedAt))}
              </time>
            </span>
          </p>
        </div>
      ) : null}
    </>
  );
}

/** One field: label over value below 26rem, label-left beside it from 26rem (UI-SPEC Surface 2, Card at 390). */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5 @[26rem]:grid-cols-[4.5rem_minmax(0,1fr)] @[26rem]:gap-x-3">
      <dt className="text-[11.5px] text-muted-foreground @[26rem]:pt-0.5">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
