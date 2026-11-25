"use client";

import { WORK_BROWSER_LIMITS, type WorkApproval } from "@ocw/contracts";
import {
  CircleCheck,
  CircleSlash,
  Hourglass,
  LockKeyhole,
  LogIn,
  type LucideIcon,
  MonitorSmartphone,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { UntrustedText } from "@/components/approvals/untrusted-text";
import { signInExpiresIn } from "@/components/browser/sign-in-card-body";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * The agent's sign-in request in the session (07.13-21; D-21, D-29, D-32; 07.8 UI-SPEC Surface 2 "Sign in needed",
 * Work Zone words). `ocw_browser_signin` reaches the web as a browser approval of kind `signin`; this card takes the
 * approval banner's place for it, in the bots' card's visual language (its classes, not its component, which is bound
 * to message cards).
 *
 * - The asker (the in-flight turn's author): "{Runtime} needs you to sign in to {site}", the agent's reason quoted as
 *   plain text, the honest device lines, the countdown, "Open and sign in" (opens the Browser tab and takes control)
 *   and "Not now" (denies the request).
 * - Anyone else: "Waiting for {person} to sign in", no actions. The API decides who may answer (PD-10); the web only
 *   hides what it would refuse.
 * - Resolved: "Signed in" (the device saved it and approved the request), "Skipped" (denied) or "Expired".
 */

/** "github.com" from `https://github.com:443`; a non-default port stays ("127.0.0.1:5173"). */
export function signInSiteOf(origin: string): string {
  try {
    const u = new URL(origin);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return origin;
  }
}

const WAIT_MS = WORK_BROWSER_LIMITS.signinWaitMinutes * 60_000;
const FOOTER =
  "flex flex-wrap items-center gap-2 border-t bg-muted/35 px-3.5 py-2.5 dark:bg-foreground/[0.02]";

/** Re-renders each minute (each second under one) while the request waits. */
function useNow(active: boolean, fixed?: number): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (!active || fixed !== undefined) return;
    const t = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(t);
  }, [active, fixed]);
  return fixed ?? now;
}

/** One quiet line of the card (12/400 muted with its glyph), the bots' card's look. */
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

const PILL = {
  pending: {
    label: "Sign-in needed",
    tone: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
  },
  approved: {
    label: "Signed in",
    tone: "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300",
  },
  denied: { label: "Skipped", tone: "bg-muted text-muted-foreground" },
  expired: { label: "Expired", tone: "bg-muted text-muted-foreground" },
} as const;

export function WorkSignInCard({
  approval,
  agentLabel,
  askerName,
  viewerIsAsker,
  canDecline,
  deviceName,
  onOpen,
  onNotNow,
  opening = false,
  declining = false,
  now: fixedNow,
}: {
  approval: WorkApproval;
  /** The runtime's label ("Claude Code"). */
  agentLabel: string;
  /** The in-flight turn's author, the only person the request is for. */
  askerName: string | null;
  viewerIsAsker: boolean;
  /** The asker may also decline (the API's `work_session.approve`); without it only Open and sign in shows. */
  canDecline: boolean;
  deviceName: string;
  onOpen: () => void;
  onNotNow: () => void;
  opening?: boolean;
  declining?: boolean;
  /** Tests: a fixed clock. */
  now?: number;
}) {
  const status = approval.status;
  const waiting = status === "pending";
  const now = useNow(waiting, fixedNow);
  const origin = approval.request.browser?.origin ?? "";
  const site = signInSiteOf(origin);
  const reason = approval.request.browser?.reason ?? null;
  const person = askerName ?? "the person who asked";
  const expiresAt = new Date(Date.parse(approval.createdAt) + WAIT_MS).toISOString();
  const pill = PILL[status];

  return (
    <div
      data-testid="work-signin-card"
      data-status={status}
      className="@container overflow-hidden rounded-xl border bg-card shadow-lg shadow-black/5"
    >
      <div className="grid gap-2.5 px-3.5 pt-3 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="flex min-w-0 items-start gap-2 font-semibold text-[15px] leading-5">
            <LogIn aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 break-words">
              {viewerIsAsker ? (
                <>
                  {agentLabel} needs you to sign in to <span className="font-mono">{site}</span>
                </>
              ) : waiting ? (
                <>
                  Waiting for {person} to sign in to <span className="font-mono">{site}</span>
                </>
              ) : (
                <>
                  {agentLabel} asked {person} to sign in to <span className="font-mono">{site}</span>
                </>
              )}
            </span>
          </p>
          <span
            role="status"
            aria-label={`Status: ${pill.label}`}
            data-testid="work-signin-status"
            className={cn(
              "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 font-medium text-xs",
              pill.tone,
            )}
          >
            {status === "approved" ? (
              <CircleCheck aria-hidden className="size-3.5" />
            ) : status === "pending" ? (
              <span aria-hidden className="inline-flex size-1.5 rounded-full bg-amber-500" />
            ) : (
              <CircleSlash aria-hidden className="size-3.5" />
            )}
            {pill.label}
          </span>
        </div>
        {reason ? (
          <div className="grid min-w-0 gap-0.5 @[26rem]:grid-cols-[4.5rem_minmax(0,1fr)] @[26rem]:gap-x-3">
            <span className="text-[11.5px] text-muted-foreground @[26rem]:pt-0.5">Why</span>
            <UntrustedText
              text={`“${reason}”`}
              clampLines={3}
              className="text-[13.5px] leading-5"
              data-testid="work-signin-why"
            />
          </div>
        ) : null}
        {waiting && viewerIsAsker ? (
          <>
            <Line testId="work-signin-assurance" icon={LockKeyhole}>
              You type in the page yourself, on {deviceName}. {agentLabel} waits until you hand it back.
            </Line>
            <Line testId="work-signin-device" icon={MonitorSmartphone}>
              If you save it, the agent on {deviceName} uses it in your own turns only, in sessions only you
              (and the owner of {deviceName}) can see. The owner of {deviceName} controls that computer.
            </Line>
            <Line testId="work-signin-timer" icon={Hourglass}>
              <time dateTime={expiresAt}>{signInExpiresIn(expiresAt, now)}</time>
            </Line>
          </>
        ) : status === "approved" ? (
          <Line testId="work-signin-state" icon={CircleCheck}>
            {viewerIsAsker ? "You signed in." : `${person} signed in.`} {agentLabel} continues.
          </Line>
        ) : status === "denied" ? (
          <Line testId="work-signin-state" icon={CircleSlash}>
            {viewerIsAsker ? "You didn't sign in." : `${person} didn't sign in.`} {agentLabel} was told.
          </Line>
        ) : status === "expired" ? (
          <Line testId="work-signin-state" icon={Hourglass}>
            No one signed in within {WORK_BROWSER_LIMITS.signinWaitMinutes} minutes. Ask {agentLabel} again.
          </Line>
        ) : null}
      </div>
      {waiting && viewerIsAsker ? (
        <div
          data-testid="work-signin-actions"
          className={cn(FOOTER, "max-md:flex-col-reverse max-md:items-stretch")}
        >
          {canDecline ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid="work-signin-skip"
              disabled={opening || declining}
              onClick={onNotNow}
              className="max-md:h-11"
            >
              {declining ? <Spinner /> : null}
              Not now
            </Button>
          ) : null}
          <Button
            size="sm"
            data-testid="work-signin-open"
            disabled={opening || declining}
            onClick={onOpen}
            className="max-md:h-11 md:ml-auto"
          >
            {opening ? <Spinner /> : <LogIn aria-hidden />}
            {opening ? "Opening…" : "Open and sign in"}
          </Button>
        </div>
      ) : waiting ? (
        <div data-testid="work-signin-actions" className={FOOTER}>
          <p data-testid="work-signin-only" className="min-w-0 text-muted-foreground text-xs leading-4">
            Only {person} can sign in here.
          </p>
        </div>
      ) : null}
    </div>
  );
}
