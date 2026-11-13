import type { Locator, Page } from "@playwright/test";
import { BUILTIN_TOOLS } from "../../packages/contracts/src/bot-capabilities";
import type { SimulatedCall, TaskEventPayload, TaskTurnContext } from "./fake-cell-plugin";

/**
 * Long-task helpers for the browser spec (07.17.1.1.2-13; D-02, D-05, PD-20, PD-24): what the fake cell's simulated
 * persona does on each turn of a task, and the task card's selectors (apps/web/components/chat/task-card.tsx).
 *
 * The persona "reads a pack" of `of` parts: its start turn (the mention, `taskDirectives`) starts the task and continues
 * with "Read 1 of N"; each `agent.task.v1` turn n continues with "Read n of N" (`readPack`, the `taskCallsFor` hook)
 * until `finishAt`, where it finishes `done`. Without `finishAt` it keeps continuing, so the task's turn budget stops
 * it. Relative imports only, so the unit tests and the Playwright specs both load this file.
 */

export interface ReadPackOptions {
  /** How many parts the pack has (the "of N" in every note). */
  of: number;
  /** The turn that finishes the task (`done`); absent = never (the budget stops it). */
  finishAt?: number;
  /** The wait every continue asks for (a timer, `afterSeconds`); absent = the next turn right away. */
  afterSeconds?: number;
}

/** "Read n of N": the progress note of turn n. */
export const readNote = (n: number, of: number): string => `Read ${n} of ${of}`;

/** The continue of turn `n`: its progress, the next part as the next step, the optional wait. */
export function continueArgs(n: number, opts: ReadPackOptions): Record<string, unknown> {
  return {
    progress: readNote(n, opts.of),
    nextStep: readNote(n + 1, opts.of),
    ...(opts.afterSeconds !== undefined ? { afterSeconds: opts.afterSeconds } : {}),
  };
}

/** The `taskCallsFor` hook: continue on turn n with "Read n of N" until `finishAt`, then finish `done`. */
export function readPack(
  opts: ReadPackOptions,
): (event: TaskEventPayload, ctx: TaskTurnContext) => SimulatedCall[] {
  return (_event, ctx) =>
    opts.finishAt !== undefined && ctx.turn >= opts.finishAt
      ? [
          {
            tool: BUILTIN_TOOLS.taskFinish,
            args: { summary: `${readNote(ctx.turn, opts.of)}: done.`, outcome: "done" },
          },
        ]
      : [{ tool: BUILTIN_TOOLS.taskContinue, args: continueArgs(ctx.turn, opts) }];
}

/** `[[call …]]` directives of the start turn: `ocw_task_start` with the goal, then the continue of turn 1. */
export function taskDirectives(goal: string, opts: ReadPackOptions): string {
  const call = (tool: string, args: Record<string, unknown>) => `[[call ${tool} ${JSON.stringify(args)}]]`;
  return `${call(BUILTIN_TOOLS.taskStart, { goal })} ${call(BUILTIN_TOOLS.taskContinue, continueArgs(1, opts))}`;
}

/** The task card's test ids (PD-20): the turn meter, the elapsed time, the wait, the notes and Stop. */
export const TASK_CARD_IDS = {
  turns: "task-turns",
  elapsed: "task-elapsed",
  waiting: "task-waiting",
  progress: "task-progress",
  next: "task-next",
  stop: "task-stop",
} as const;

/** Every task card under `scope` (the one card renderer, `kind` task). */
export const TASK_CARD = '[data-testid="agent-card"][data-kind="task"]';

export function taskCards(scope: Page | Locator): Locator {
  return scope.locator(TASK_CARD);
}

/** The message row that holds the task card of `taskId` (its id stays the same while the card updates in place). */
export function taskCardRow(scope: Page | Locator, taskId: string): Locator {
  return scope.locator(`[data-testid="message"]:has([data-task-id="${taskId}"])`).first();
}
