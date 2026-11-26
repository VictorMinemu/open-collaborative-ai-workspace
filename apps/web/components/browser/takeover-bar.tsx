"use client";

import { Keyboard, MousePointerClick } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type LiveView, leaseWarning } from "./live-store";
import { useOptionalLiveView } from "./live-view-provider";

/**
 * The bar under the large view's header while the person controls the page (07.8-22; UI-SPEC §1.3 `TakeoverBar`):
 * who is paused and where typing goes, or, in the lease's last minute without input, "Still there?" with Keep control.
 * Warning notice tones (amber, AA in both themes). On a phone (07.8-26, `phone`) the keyboard hint is left out: the sheet
 * says how to type there ("Tap to click. Pinch to zoom. Paste works.").
 */
export function TakeoverBar({
  view,
  frameFocused,
  hintId,
  phone = false,
}: {
  view: LiveView;
  frameFocused: boolean;
  hintId: string;
  phone?: boolean;
}) {
  const live = useOptionalLiveView();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (view.leaseDeadline === null) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [view.leaseDeadline]);
  const left = leaseWarning(view.leaseDeadline, now);
  const bot = view.bot.name;
  return (
    <div
      data-testid="takeover-bar"
      data-warning={left !== null ? "true" : undefined}
      className="flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b bg-amber-50 px-4 py-1.5 text-amber-900 dark:bg-amber-400/10 dark:text-amber-200"
    >
      {left !== null ? (
        <>
          <p className="flex min-w-0 items-center gap-2 font-semibold text-sm" role="status">
            <MousePointerClick aria-hidden className="size-3.5 shrink-0" />
            <span>
              Still there? Control goes back to {bot} in {left} s.
            </span>
          </p>
          <Button
            variant="outline"
            size="sm"
            data-testid="live-keep-control"
            onClick={() => live?.keep()}
            className="pointer-coarse:h-11 max-md:h-11"
          >
            Keep control
          </Button>
        </>
      ) : (
        <>
          <p className="flex min-w-0 items-center gap-2 font-semibold text-sm">
            <MousePointerClick aria-hidden className="size-3.5 shrink-0" />
            <span>You're in control. {bot} is paused.</span>
          </p>
          {phone ? null : (
            <p className="flex min-w-0 items-center gap-1.5 text-xs">
              <Keyboard aria-hidden className="size-3.5 shrink-0" />
              {/* Both hints share one cell, so the bar's height never depends on focus: a click on a hand back button
                  blurs the page, and a hint that changed lines then moved the button away before mouseup. */}
              <span className="grid min-w-0">
                <Hint id={hintId} shown={frameFocused}>
                  Typing goes to the page · Shift+Esc gives your keyboard back
                </Hint>
                <Hint id={hintId} shown={!frameFocused}>
                  Click the page to type
                </Hint>
              </span>
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** One keyboard hint in the shared cell: the shown one describes the page (`id`); the other keeps its space unseen. */
function Hint({ id, shown, children }: { id: string; shown: boolean; children: string }) {
  return (
    <span
      id={shown ? id : undefined}
      aria-hidden={shown ? undefined : true}
      className={cn("col-start-1 row-start-1", !shown && "invisible")}
    >
      {children}
    </span>
  );
}
