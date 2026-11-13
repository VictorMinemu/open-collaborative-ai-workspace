"use client";

import type { AgentCard, AgentCardTaskLink } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, BellRing, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { followCard } from "@/lib/card-queries";
import { useStopTask } from "@/lib/task-queries";

/**
 * The live card of a bot's long task (07.17.1.1.2-10; D-05, PD-11, PD-12, PD-20). The server composes it from the
 * task row (platform-owned; the bot never edits it) and every reader sees the same `card.task`; Stop is offered per
 * reader through `viewerCan.stop` and decided again by the server (P3: the web never decides who may stop). The one
 * card renderer (`AgentCardView`) keeps the shell (kind row, workspace badge, the pill, the goal as the title,
 * notices) and puts this body and footer in it.
 */

/** The task runs or waits: the only states Stop applies to. */
export const isActiveTask = (task: Pick<AgentCardTaskLink, "status">): boolean =>
  task.status === "running" || task.status === "waiting";

/** Stop shows when the server offered it to this reader AND the task is still active (a cached offer never wins). */
export function taskCanStop(card: Pick<AgentCard, "viewerCan">, task: AgentCardTaskLink): boolean {
  return (card.viewerCan ?? []).includes("stop") && isActiveTask(task);
}

/** The Stop button (outline, 44 px on phones, named after the goal); `pending` while the server stops the task. */
export function TaskStopButton({
  goal,
  pending,
  onStop,
}: {
  goal: string;
  pending: boolean;
  onStop: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-testid="task-stop"
      aria-label={`Stop task: ${goal}`}
      aria-busy={pending || undefined}
      disabled={pending}
      onClick={onStop}
      className="max-lg:h-11 max-sm:w-full"
    >
      {pending ? <Spinner className="size-3.5" /> : <Square aria-hidden className="size-3.5" />}
      Stop
    </Button>
  );
}

/** Stop wired to the server: one POST per press, no optimistic update, the toast in the mutation's own options. */
function StopTask({ taskId, goal }: { taskId: string; goal: string }) {
  const stop = useStopTask(taskId);
  return <TaskStopButton goal={goal} pending={stop.isPending} onStop={() => stop.mutate()} />;
}

/** The task card's body and footer, under the shell's title and notices. */
export function TaskCard({
  messageId,
  card,
  task,
}: {
  messageId: string;
  card: AgentCard;
  task: AgentCardTaskLink;
}) {
  const qc = useQueryClient();
  const followAction = card.actions.find((a) => a.kind === "follow");
  const following = card.following === true;
  const showFollow = !!followAction && (card.viewerCan ?? []).includes("follow");
  const showStop = taskCanStop(card, task);
  const toggleFollow = () =>
    void followCard(qc, messageId, !following, card).catch((err) => toast.error(errorMessage(err)));

  return (
    <div data-task-id={task.taskId} data-task-status={task.status}>
      {showStop || showFollow ? (
        <div
          data-testid="agent-card-actions"
          className="flex flex-wrap items-center gap-2 border-t bg-muted/35 px-3.5 py-2.5 dark:bg-white/[0.02]"
        >
          {showStop ? <StopTask taskId={task.taskId} goal={card.title} /> : null}
          {showFollow ? (
            <Button
              size="sm"
              variant={following ? "secondary" : "ghost"}
              aria-pressed={following}
              data-testid="agent-card-follow"
              onClick={toggleFollow}
              className="max-lg:h-11 max-sm:w-full"
            >
              {following ? <BellRing /> : <Bell />}
              {following ? "Following" : followAction.label}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
