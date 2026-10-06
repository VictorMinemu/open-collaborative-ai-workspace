"use client";

import type { WorkPrompt, WorkSession } from "@ocw/contracts";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";
import type { Item } from "./event-stream";

/**
 * One prompt's turn in the stream (ref-4, D-17): the prompt, the work in between (assistant notes, tools,
 * approvals) and its final assistant message. `promptId: null` is a run of loose items outside any turn
 * (session start, prompts not started yet).
 */
export interface Turn {
  promptId: string | null;
  /** The prompt bubble that opened the turn (null for loose items). */
  prompt: Item | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Everything between the prompt and the final message, in order. */
  items: Item[];
  /** The turn's last assistant message, kept visible below the summary once the turn is done. */
  finalMessage: Extract<Item, { kind: "assistant" }> | null;
  done: boolean;
  /** How the turn ended when not plainly finished, plus its token count. */
  outcome: { label: string | null; tone: "ok" | "warn" | "error"; tokens: string | null } | null;
}

/**
 * Pure: split the stream into turns. A turn runs from `prompt.started` to `prompt.completed` of the same prompt;
 * live assistant text joins the open turn; prompts not started yet stay loose. Duration comes from the prompt's
 * dispatch and completion, falling back to the first and last event times.
 */
export function groupTurns(items: Item[], prompts: WorkPrompt[]): Turn[] {
  const byId = new Map(prompts.map((p) => [p.id, p]));
  const turns: Turn[] = [];
  let open: Turn | null = null;
  const loose = (item: Item) => {
    const last = turns.at(-1);
    if (last && last.promptId === null) last.items.push(item);
    else
      turns.push({
        promptId: null,
        prompt: null,
        startedAt: null,
        endedAt: null,
        items: [item],
        finalMessage: null,
        done: true,
        outcome: null,
      });
  };

  for (const item of items) {
    if (item.kind === "prompt" && !item.pending && item.promptId) {
      const p = byId.get(item.promptId);
      open = {
        promptId: item.promptId,
        prompt: item,
        startedAt: p?.dispatchedAt ?? item.at ?? null,
        endedAt: null,
        items: [],
        finalMessage: null,
        done: false,
        outcome: null,
      };
      turns.push(open);
      continue;
    }
    if (item.kind === "prompt") {
      loose(item);
      continue;
    }
    if (item.kind === "turn") {
      if (open && open.promptId === item.promptId) {
        const p = byId.get(open.promptId);
        open.done = true;
        open.endedAt = p?.completedAt ?? item.at ?? open.items.at(-1)?.at ?? null;
        open.startedAt ??= open.items[0]?.at ?? null;
        open.outcome = {
          label: item.tone === "ok" ? null : item.label,
          tone: item.tone,
          tokens: item.tokens,
        };
        // The final message: the turn's last assistant text, unless work happened after it.
        for (let i = open.items.length - 1; i >= 0; i--) {
          const it = open.items[i];
          if (it?.kind === "error") continue;
          if (it?.kind === "assistant" && !it.streaming) {
            open.finalMessage = it;
            open.items.splice(i, 1);
          }
          break;
        }
        open = null;
      } else {
        loose(item);
      }
      continue;
    }
    if (item.kind === "assistant" && item.streaming) {
      const running = [...turns].reverse().find((t) => t.promptId !== null && !t.done);
      if (running) running.items.push(item);
      else loose(item);
      continue;
    }
    if (open) open.items.push(item);
    else loose(item);
  }
  return turns;
}

/** "12s", "7m 33s", "1h 4m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function turnDuration(turn: Pick<Turn, "startedAt" | "endedAt">): string | null {
  if (!turn.startedAt || !turn.endedAt) return null;
  return formatDuration(new Date(turn.endedAt).getTime() - new Date(turn.startedAt).getTime());
}

/**
 * "Worked for Xm Ys ›" (ref-4): a completed turn's work collapses behind it. The collapsed items stay in the DOM
 * (hidden), so live updates and existing selectors keep working.
 */
export function TurnSummary({
  turn,
  session: _session,
  children,
}: {
  turn: Turn;
  session: WorkSession;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const duration = turnDuration(turn);
  const label = turn.outcome?.label;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)]">
      <button
        type="button"
        data-testid="turn-summary"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-fit items-center gap-1 rounded-md py-0.5 text-[13.5px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        {duration ? `Worked for ${duration}` : "Worked"}
        {label ? (
          <span
            className={cn(
              turn.outcome?.tone === "warn" && "text-amber-700 dark:text-amber-400",
              turn.outcome?.tone === "error" && "text-destructive",
            )}
          >
            {` · ${label}`}
          </span>
        ) : null}
        <ChevronRight aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-90")} />
      </button>
      <div aria-hidden className="mt-2 h-px bg-border/70" />
      <div hidden={!open} className={cn("grid-cols-[minmax(0,1fr)] gap-3 pt-4", open ? "grid" : "hidden")}>
        {children}
        {turn.outcome?.tokens ? (
          <p className="text-[11.5px] text-muted-foreground">{turn.outcome.tokens} tokens</p>
        ) : null}
      </div>
    </div>
  );
}
