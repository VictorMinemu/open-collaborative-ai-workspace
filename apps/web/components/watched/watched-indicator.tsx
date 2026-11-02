"use client";

import type { BoardCard, WatchedRecord } from "@ocw/contracts";
import { CircleAlert, Eye, EyeOff } from "lucide-react";
import { useCardWatch, watchDescription, watchState } from "@/lib/watched-queries";

/**
 * The watched indicator on a 07.1 board tile (07.6-17, UI-SPEC Surface 7b): only in the tile's footer, before the reply
 * count. Watching = `Eye` alone; Changed (24 h) = `Eye` + "Changed" in amber; Paused for a reconnect = `EyeOff`; last
 * check failed = `CircleAlert`. The icon is `aria-hidden`: the state is in the tile's description sentence
 * (`useWatchSentence`). Self-fetching through the board's one watched-records query; renders nothing for an unwatched
 * card (and outside a QueryClientProvider).
 */
export function WatchedIndicator({
  card,
  now,
}: {
  card: Pick<BoardCard, "messageId" | "conversationId">;
  now?: number;
}) {
  const watch = useCardWatch(card);
  return watch ? <WatchedIndicatorView watch={watch} now={now} /> : null;
}

export function WatchedIndicatorView({ watch, now }: { watch: WatchedRecord; now?: number }) {
  const state = watchState(watch, now ?? Date.now());
  const icon = "size-3.5 shrink-0";
  return (
    <span data-testid="watched-indicator" data-state={state} className="inline-flex items-center gap-1">
      {state === "paused" ? (
        <EyeOff aria-hidden className={icon} />
      ) : state === "failed" ? (
        <CircleAlert aria-hidden className={icon} />
      ) : (
        <Eye aria-hidden className={icon} />
      )}
      {state === "changed" ? (
        <span aria-hidden className="font-semibold text-amber-800 text-xs dark:text-amber-300">
          Changed
        </span>
      ) : null}
    </span>
  );
}

/** The sentence a watched tile adds to its accessible description, or null for an unwatched card. */
export function useWatchSentence(
  card: Pick<BoardCard, "messageId" | "conversationId">,
  now?: number,
): string | null {
  const watch = useCardWatch(card);
  return watch ? watchDescription(watch, now ?? Date.now()) : null;
}
