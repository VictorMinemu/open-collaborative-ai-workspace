"use client";

import { Hand, Keyboard, LogIn } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { activityWordsOf, type LiveUiState, type LiveView } from "./live-store";

/**
 * The line under the frame (07.8-22; UI-SPEC §1.1 "Activity line", §1.4): what the bot is doing, in the server's masked
 * phrase (never typed text; page text as plain text nodes), or what the view waits for. Screen readers hear it through a
 * separate polite region, throttled: only when the verb changes, at most once every 5 s (Accessibility Contract).
 */

const ANNOUNCE_EVERY_MS = 5_000;

/** The words that matter for an announcement: "Scout is clicking" from "Scout is clicking “Orders”". */
const verbOf = (text: string) => text.split(" ").slice(0, 3).join(" ");

function useThrottledAnnouncement(text: string | null): string {
  const [spoken, setSpoken] = useState("");
  const last = useRef<{ verb: string; at: number }>({ verb: "", at: 0 });
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!text) return;
    const verb = verbOf(text);
    if (verb === last.current.verb) return;
    const wait = Math.max(0, last.current.at + ANNOUNCE_EVERY_MS - Date.now());
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      pending.current = null;
      last.current = { verb, at: Date.now() };
      setSpoken(text);
    }, wait);
    return () => {
      if (pending.current) clearTimeout(pending.current);
      pending.current = null;
    };
  }, [text]);
  return spoken;
}

export function LiveActivityLine({
  view,
  state,
  large = false,
  frameFocused = false,
  hintId,
  className,
}: {
  view: LiveView;
  state: LiveUiState;
  large?: boolean;
  frameFocused?: boolean;
  /** The id screen readers use to describe the frame in control (the capture hint). */
  hintId?: string;
  className?: string;
}) {
  const words = activityWordsOf(view, state, frameFocused);
  const spoken = useThrottledAnnouncement(state === "controlling" ? null : (words?.text ?? null));
  const icon = large ? "size-3.5" : "size-3";
  return (
    <div
      data-testid="live-activity"
      data-state={state}
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-muted-foreground",
        large ? "text-sm" : "text-xs",
        className,
      )}
    >
      {words?.icon === "spinner" ? (
        <Spinner className={cn(icon, "shrink-0")} />
      ) : words?.icon === "hand" ? (
        <Hand aria-hidden className={cn(icon, "shrink-0 text-amber-700 dark:text-amber-300")} />
      ) : words?.icon === "signin" ? (
        <LogIn aria-hidden className={cn(icon, "shrink-0")} />
      ) : words?.icon === "keyboard" ? (
        <Keyboard aria-hidden className={cn(icon, "shrink-0")} />
      ) : null}
      <span id={hintId} className="min-w-0 truncate">
        {words?.text ?? ""}
      </span>
      {words?.review ? (
        <Link
          href={words.review}
          data-testid="live-review"
          className="shrink-0 rounded-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/40"
        >
          Review
        </Link>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {spoken}
      </span>
    </div>
  );
}
