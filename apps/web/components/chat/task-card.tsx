"use client";

import { type AgentCard, type AgentCardTaskLink, TASK_CARD_FIELD_LABELS } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, BellRing, Clock, Hourglass, Square } from "lucide-react";
import { useEffect, useState } from "react";
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

const MINUTE = 60_000;

/** "Elapsed 1 h 12 min" between `fromMs` and `toMs` (whole minutes, rounded down). */
export function taskElapsedText(fromMs: number, toMs: number): string {
  const minutes = Math.max(0, Math.floor((toMs - fromMs) / MINUTE));
  if (minutes < 1) return "Elapsed under a minute";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `Elapsed ${m} min`;
  return m === 0 ? `Elapsed ${h} h` : `Elapsed ${h} h ${m} min`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayTimeFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** What a waiting task waits for, in words; null while it works or between two turns (the pill says Waiting). */
export function taskWaitText(task: AgentCardTaskLink, nowMs: number = Date.now()): string | null {
  if (task.status !== "waiting") return null;
  switch (task.waiting) {
    case "process":
      return "Waiting for a background command";
    case "session":
      return "Waiting for a Work Zone session";
    case "timer": {
      const at = task.wakeAt ? new Date(task.wakeAt) : null;
      if (!at || Number.isNaN(at.getTime())) return "Waiting for a timer";
      const sameDay = at.toDateString() === new Date(nowMs).toDateString();
      return `Waiting until ${(sameDay ? timeFmt : dayTimeFmt).format(at)}`;
    }
    default:
      return null;
  }
}

/** The current time, re-read every 30 s while `live` (the Work Zone card's `useUpdatedText` rhythm). */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [live]);
  return live ? now : Date.now();
}

/** A card field's value by its label (the server's two fields: Progress and Next step). */
const fieldOf = (card: Pick<AgentCard, "fields">, label: string): string | null =>
  card.fields.find((f) => f.label === label)?.value?.trim() || null;

/** The turn meter: "Turn 7 of 40" over a bar, one progressbar with its ARIA values. */
function TurnMeter({ task }: { task: AgentCardTaskLink }) {
  const used = Math.min(Math.max(task.turnsUsed, 0), task.maxTurns);
  const text = `Turn ${used} of ${task.maxTurns}`;
  const percent = task.maxTurns > 0 ? Math.round((used / task.maxTurns) * 100) : 0;
  return (
    <div
      role="progressbar"
      data-testid="task-turns"
      aria-label="Turns used"
      aria-valuemin={0}
      aria-valuemax={task.maxTurns}
      aria-valuenow={used}
      aria-valuetext={text}
      className="grid min-w-0 flex-1 gap-1.5"
    >
      <span className="font-medium text-[13px] text-foreground tabular-nums leading-5">{text}</span>
      <span aria-hidden className="block h-1.5 w-full overflow-hidden rounded-full bg-muted dark:bg-white/10">
        <span
          className="block h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none dark:bg-blue-300"
          style={{ width: `${percent}%` }}
        />
      </span>
    </div>
  );
}

/** The task's state at a glance: the meter, the elapsed time, the wait, the last progress and the next step. */
function TaskBody({ card, task }: { card: AgentCard; task: AgentCardTaskLink }) {
  const active = isActiveTask(task);
  const now = useNow(active);
  const started = Date.parse(task.startedAt);
  const ended = task.finishedAt ? Date.parse(task.finishedAt) : Number.NaN;
  const elapsed = Number.isFinite(started)
    ? taskElapsedText(started, !active && Number.isFinite(ended) ? ended : now)
    : null;
  const wait = taskWaitText(task, now);
  const progress = fieldOf(card, TASK_CARD_FIELD_LABELS.progress);
  // An ended task (done, blocked, stopped, failed) has no next step: only its last progress note stays.
  const next = active ? fieldOf(card, TASK_CARD_FIELD_LABELS.next) : null;
  return (
    <div data-testid="task-body" className="grid min-w-0 gap-3 px-3.5 pb-3.5">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
        <TurnMeter task={task} />
        {elapsed ? (
          <p
            data-testid="task-elapsed"
            className="flex shrink-0 items-center gap-1.5 text-[13px] text-foreground tabular-nums leading-5"
          >
            <Clock aria-hidden className="size-3.5 shrink-0" />
            <span>{elapsed}</span>
          </p>
        ) : null}
      </div>
      {wait ? (
        <p
          data-testid="task-waiting"
          className="flex min-w-0 items-start gap-1.5 text-[13px] text-foreground leading-5"
        >
          <Hourglass aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{wait}</span>
        </p>
      ) : null}
      {progress || next ? (
        <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-2 @[26rem]:grid-cols-2">
          {progress ? (
            <div className="min-w-0">
              <dt className="font-medium text-[11.5px] text-foreground uppercase tracking-wider">
                {TASK_CARD_FIELD_LABELS.progress}
              </dt>
              <dd
                data-testid="task-progress"
                className="mt-0.5 whitespace-pre-wrap break-words text-[13.5px] text-foreground leading-5"
              >
                {progress}
              </dd>
            </div>
          ) : null}
          {next ? (
            <div className="min-w-0">
              <dt className="font-medium text-[11.5px] text-foreground uppercase tracking-wider">
                {TASK_CARD_FIELD_LABELS.next}
              </dt>
              <dd
                data-testid="task-next"
                className="mt-0.5 whitespace-pre-wrap break-words text-[13.5px] text-foreground leading-5"
              >
                {next}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
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
    <div data-task-id={task.taskId} data-task-status={task.status} className="min-w-0">
      <TaskBody card={card} task={task} />
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
