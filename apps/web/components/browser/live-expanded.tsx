"use client";

import { ClipboardPaste } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { LiveActivityLine } from "./live-activity-line";
import { LiveFrame } from "./live-frame";
import { LargeHeader } from "./live-header";
import { type LiveView, uiStateOf } from "./live-store";
import { useOptionalLiveView } from "./live-view-provider";
import { TakeoverBar } from "./takeover-bar";

/**
 * The desktop large view (07.8-22; UI-SPEC §1.2 watching, §1.3 in control): the plain `Dialog` sized
 * `min(1280px, 100vw − 4rem)`, with no close button of its own (the header's Close is the only one). The frame keeps
 * 16:10 and fits the remaining height. In control: the takeover bar, the amber ring and the paste footer; Minimize is
 * hidden and Escape belongs to the page (Shift+Esc gives the keyboard back). Opening focuses the header's primary
 * button; entering control focuses the frame.
 */

/** Header 56 + footer 48; in control the takeover bar adds 40. */
const CHROME = 104;
const BAR = 40;

export function LiveExpanded({ view }: { view: LiveView }) {
  const live = useOptionalLiveView();
  const state = uiStateOf(view);
  const controlling = state === "controlling";
  const titleId = useId();
  const hintId = useId();
  const primary = useRef<HTMLButtonElement | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);
  const [frameFocused, setFrameFocused] = useState(false);

  // The Hand back button is where Shift+Esc lands.
  useEffect(() => {
    if (!live) return;
    live.handBackRef.current = controlling ? primary.current : null;
  }, [live, controlling]);

  // Entering control focuses the frame: keyboard capture on (UI-SPEC Focus management).
  useEffect(() => {
    if (controlling) frame.current?.focus();
  }, [controlling]);

  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(open, details) => {
        if (open) return;
        // Escape is the page's while in control; otherwise it goes back to the small window.
        if (controlling) return;
        if (details.reason === "escape-key") live?.minimize();
        else live?.close();
      }}
    >
      <DialogContent
        showClose={false}
        data-testid="live-expanded"
        aria-labelledby={titleId}
        initialFocus={primary}
        className="gap-0 overflow-hidden p-0 sm:max-h-[calc(100dvh-2rem)] sm:w-full sm:max-w-[min(1280px,calc(100vw-4rem))] sm:p-0"
      >
        <div
          data-testid="live-view"
          data-state={state}
          data-context={view.contextId}
          className="flex min-h-0 flex-col"
        >
          <LargeHeader view={view} state={state} titleId={titleId} primaryRef={primary} />
          {controlling ? <TakeoverBar view={view} frameFocused={frameFocused} hintId={hintId} /> : null}
          <div className="min-h-0 bg-muted/40 dark:bg-black/20">
            <LiveFrame
              view={view}
              state={state}
              large
              hintId={controlling ? hintId : undefined}
              onFocusChange={setFrameFocused}
              frameRef={frame}
              chrome={CHROME + (controlling ? BAR : 0)}
            />
          </div>
          <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t px-4 py-2 sm:py-0">
            {controlling ? (
              <>
                <p className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
                  <ClipboardPaste aria-hidden className="size-3.5 shrink-0" />
                  <span>Password managers can't fill this page. Copy your password and paste it here.</span>
                </p>
                <p className="text-muted-foreground text-xs">{view.bot.name} never sees what you type.</p>
              </>
            ) : (
              <>
                <LiveActivityLine view={view} state={state} large className="min-w-0 flex-1" />
                <p className="shrink-0 text-muted-foreground text-xs">Frames aren't recorded.</p>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
