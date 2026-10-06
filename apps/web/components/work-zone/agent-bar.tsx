"use client";

import type { WorkSession } from "@ocw/contracts";
import { toast } from "sonner";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useInterrupt } from "@/lib/workzone-queries";

const WORKING: ReadonlyArray<WorkSession["status"]> = ["provisioning", "running", "waiting_approval"];

const barButton =
  "inline-flex h-7 items-center gap-1.5 rounded-md px-2 font-medium text-[13px] outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50";

/**
 * "1 agent working · View · Stop" (ref-4, D-17): floats above the composer while the runtime works. One agent per
 * session today (sub-agents are deferred in the inventory). Stop is the session's interrupt (moved here from the
 * composer: same mutation, same `interrupt` test id), shown only to members holding `work_session.interrupt`;
 * the server re-checks.
 */
export function AgentBar({
  session,
  canInterrupt,
  onView,
}: {
  session: WorkSession;
  canInterrupt: boolean;
  onView(): void;
}) {
  const interrupt = useInterrupt(session.id);
  if (!WORKING.includes(session.status)) return null;
  const waiting = session.status === "waiting_approval";
  const label = waiting
    ? "Waiting for approval"
    : session.status === "provisioning"
      ? "1 agent starting"
      : "1 agent working";
  const canStop = canInterrupt && session.status !== "provisioning";
  return (
    <div
      data-testid="agent-bar"
      data-status={session.status}
      className="mx-3 flex h-10 items-center gap-2.5 rounded-t-xl border border-b-0 bg-card pr-1.5 pl-3.5 text-[13px] sm:mx-5"
    >
      <span aria-hidden className="relative inline-flex size-2 shrink-0">
        <span
          className={cn(
            "absolute inset-0 animate-ping rounded-full opacity-60",
            waiting ? "bg-warning" : "bg-primary",
          )}
        />
        <span className={cn("relative size-2 rounded-full", waiting ? "bg-warning" : "bg-primary")} />
      </span>
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      <button type="button" onClick={onView} className={barButton}>
        View
      </button>
      {canStop ? (
        <button
          type="button"
          data-testid="interrupt"
          aria-label="Stop"
          disabled={interrupt.isPending}
          onClick={() => interrupt.mutate(undefined, { onError: (err) => toast.error(errorMessage(err)) })}
          className={barButton}
        >
          {interrupt.isPending ? <Spinner className="size-3.5" /> : null}
          Stop
        </button>
      ) : null}
    </div>
  );
}
