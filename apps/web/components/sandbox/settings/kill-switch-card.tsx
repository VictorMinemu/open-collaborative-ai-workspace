"use client";

import type { SandboxIsolationInfo, SandboxSettings } from "@ocw/contracts";
import { OctagonX, Play } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

/**
 * The kill switch (07.8-19; D-09, U-11, UI-SPEC §4.2): stops every sandbox and browser of the organization and blocks
 * new ones until an admin resumes. It asks first (focus on Cancel); Resume is immediate. While engaged, a red banner at
 * the top of the page says who stopped everything and when (T-07.8-19-03), and the card's button becomes Resume.
 */

type Killed = NonNullable<SandboxSettings["killed"]>;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function killDialogBody(running: SandboxIsolationInfo["running"]): string {
  return `${plural(running.sandboxes, "sandbox", "sandboxes")} and ${plural(running.browsers, "browser", "browsers")} stop now, including anyone signing in. Bots can't use them until you resume. Files and saved sign-ins are kept.`;
}

/** "Oct 14, 10:31" in the viewer's time zone. */
export function stoppedAt(iso: string): string {
  return new Date(iso).toLocaleString("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/** "Stopped by Ana Pérez · Oct 14, 10:31" (the person is null when their account is gone). */
export const stoppedLine = (killed: Killed) =>
  `${killed.by ? `Stopped by ${killed.by.displayName}` : "Stopped"} · ${stoppedAt(killed.at)}`;

const TOUCH = "max-md:h-11";

function ResumeButton({
  pending,
  onResume,
  testId,
  className,
}: {
  pending: boolean;
  onResume: () => void;
  testId: string;
  className?: string;
}) {
  return (
    <Button onClick={onResume} disabled={pending} className={className} data-testid={testId}>
      {pending ? <Spinner /> : <Play />}
      Resume
    </Button>
  );
}

export function KillSwitchBanner({
  killed,
  pending,
  onResume,
}: {
  killed: Killed;
  pending: boolean;
  onResume: () => void;
}) {
  return (
    <div
      role="status"
      data-testid="kill-switch-banner"
      className="flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-red-800 sm:flex-row sm:items-center dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-300"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <OctagonX aria-hidden className="mt-0.5 size-5 shrink-0" />
        <div className="min-w-0">
          <p className="font-semibold text-sm">All sandboxes and browsers are stopped</p>
          <p className="mt-0.5 text-xs" data-testid="kill-switch-by">
            {stoppedLine(killed)}
          </p>
        </div>
      </div>
      <ResumeButton
        pending={pending}
        onResume={onResume}
        testId="kill-switch-resume"
        className={`w-full shrink-0 sm:w-auto ${TOUCH}`}
      />
    </div>
  );
}

export function KillSwitchCard({
  killed,
  running,
  pending,
  onKill,
  onResume,
}: {
  killed: Killed | null;
  running: SandboxIsolationInfo["running"];
  pending: boolean;
  /** Stops everything; resolves true when the API accepted it. */
  onKill: () => Promise<boolean>;
  onResume: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <div
      data-testid="kill-switch"
      data-killed={killed ? "true" : "false"}
      className="flex flex-col gap-4 rounded-xl border border-destructive/30 bg-card p-4 shadow-xs sm:flex-row sm:items-center sm:p-5"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-red-100 text-red-800 dark:bg-red-400/15 dark:text-red-300"
        >
          <OctagonX className="size-[18px]" />
        </span>
        <p className="text-sm leading-5">
          Stops every sandbox and browser in the organization now and blocks new ones until you resume. Files
          and saved sign-ins are kept.
        </p>
      </div>
      {killed ? (
        <ResumeButton
          pending={pending}
          onResume={onResume}
          testId="kill-switch-card-resume"
          className={`w-full shrink-0 sm:w-auto ${TOUCH}`}
        />
      ) : (
        <Button
          variant="destructive"
          onClick={() => setConfirming(true)}
          disabled={pending}
          className={`w-full shrink-0 sm:w-auto ${TOUCH}`}
          data-testid="kill-switch-stop"
        >
          <OctagonX /> Stop all sandboxes and browsers
        </Button>
      )}

      <Dialog open={confirming} onOpenChange={(open) => !open && !pending && setConfirming(false)}>
        <DialogContent data-testid="kill-switch-dialog" initialFocus={cancelRef}>
          <DialogHeader>
            <span
              aria-hidden
              className="mb-1 flex size-10 items-center justify-center rounded-xl border border-destructive/25 bg-destructive/10 text-destructive shadow-xs"
            >
              <OctagonX className="size-5" />
            </span>
            <DialogTitle className="break-words">Stop all sandboxes and browsers?</DialogTitle>
            <DialogDescription>{killDialogBody(running)}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              ref={cancelRef}
              variant="outline"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className={TOUCH}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (await onKill()) setConfirming(false);
              }}
              disabled={pending}
              className={TOUCH}
              data-testid="kill-switch-confirm"
            >
              {pending ? <Spinner /> : null}
              Stop everything
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
