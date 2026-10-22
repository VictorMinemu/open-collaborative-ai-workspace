"use client";

import { ChevronDown, Keyboard, MousePointerClick, Undo2, X } from "lucide-react";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { PrincipalAvatar } from "@/components/chat/principal-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { LiveActivityLine } from "./live-activity-line";
import { LiveFrame } from "./live-frame";
import { IconButton, StateChip, Where } from "./live-header";
import {
  beforeInputFrames,
  compositionFrame,
  forwardSoftInput,
  pasteFrame,
  softInputType,
  softKeyFrames,
} from "./live-input";
import { canTake, type LiveView, uiStateOf, useLiveStore, watchOnlyLine } from "./live-store";
import { useOptionalLiveView } from "./live-view-provider";
import { TakeoverBar } from "./takeover-bar";

/**
 * The phone live view's full-screen sheet (07.8-26; D-06, D-07, UI-SPEC §1.5 Full, In control, Interaction "Input
 * (phone)", R10, U-4, U-7, Pitfall 12). Modal (focus stays inside). Watching: the frame fits the width, the activity
 * line, and Take control for the member the bot works for (or "Only {person} can take control here."). In control: the
 * takeover bar, the frame filling the sheet at the phone viewport the page now has (taps are the page's touches), the
 * hint line, Show keyboard and Hand back. Show keyboard focuses a visually hidden input that forwards what is typed
 * as `text` and key frames and is emptied after every forward; it turns `type="password"` while the page's focused field
 * is sensitive, so the phone keyboard never learns it (T-07.8-26-01). The system Back closes the sheet to the dock while
 * watching and, in control, asks "Hand back to {bot}?" (never a silent hand back, T-07.8-26-04).
 */

const HISTORY_MARK = "ocwLiveSheet";

export function LiveFullSheet({ view }: { view: LiveView }) {
  const live = useOptionalLiveView();
  const state = uiStateOf(view);
  const controlling = state === "controlling";
  const titleId = useId();
  const hintId = useId();
  const primary = useRef<HTMLButtonElement | null>(null);
  const area = useRef<HTMLDivElement | null>(null);
  const keyboard = useRef<HTMLInputElement | null>(null);
  const [askBack, setAskBack] = useState(false);
  const controllingRef = useRef(controlling);
  controllingRef.current = controlling;

  // The Hand back button is where focus returns after the keyboard (and Shift+Esc on a hardware keyboard).
  useEffect(() => {
    if (!live) return;
    live.handBackRef.current = controlling ? primary.current : null;
  }, [live, controlling]);

  // Leaving control closes the Back question.
  useEffect(() => {
    if (!controlling) setAskBack(false);
  }, [controlling]);

  // The system Back: one history entry while the sheet is open. Back pops it: watching → the dock; in control → the
  // entry comes back and the person is asked first.
  useEffect(() => {
    const marked = () => (window.history.state as Record<string, unknown> | null)?.[HISTORY_MARK] === true;
    if (!marked()) window.history.pushState({ [HISTORY_MARK]: true }, "");
    const onPop = () => {
      if (controllingRef.current) {
        window.history.pushState({ [HISTORY_MARK]: true }, "");
        setAskBack(true);
        return;
      }
      live?.minimize();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // Closed from the sheet itself (Back to small view, Close, Hand back then close): drop the entry it added.
      if (marked()) window.history.back();
    };
  }, [live]);

  // R10: the page gets the frame area's size while this person controls it (measured, in CSS px).
  useEffect(() => {
    const el = area.current;
    if (!controlling || !el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const next = { width: Math.round(r.width), height: Math.round(r.height) };
      const v = useLiveStore.getState().view;
      if (!v || v.contextId !== view.contextId) return;
      if (v.phoneArea?.width === next.width && v.phoneArea?.height === next.height) return;
      useLiveStore.getState().patch(view.contextId, { phoneArea: next });
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      useLiveStore.getState().patch(view.contextId, { phoneArea: null });
    };
  }, [controlling, view.contextId]);

  const take = canTake(view, state);
  const watchOnly = watchOnlyLine(view, state);

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (open) return;
        // Escape (a hardware keyboard): in control it asks first, as the system Back does.
        if (controllingRef.current) setAskBack(true);
        else live?.minimize();
      }}
    >
      <SheetContent
        side="bottom"
        showClose={false}
        data-testid="live-full"
        aria-labelledby={titleId}
        initialFocus={primary}
        className="h-dvh rounded-none border-t-0 pt-[env(safe-area-inset-top)]"
      >
        <div
          data-testid="live-view"
          data-state={state}
          data-context={view.contextId}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div data-testid="live-header" className="flex h-14 shrink-0 items-center gap-1.5 border-b px-1">
            {controlling ? (
              <span aria-hidden className="w-2" />
            ) : (
              <IconButton
                label="Back to small view"
                icon={ChevronDown}
                testId="live-minimize"
                onClick={() => live?.minimize()}
              />
            )}
            <PrincipalAvatar
              kind="agent"
              name={view.bot.name}
              avatarUrl={view.bot.avatarUrl}
              seed={view.bot.id}
              className="size-6 shrink-0 rounded-md text-xs"
            />
            <h2 id={titleId} className="sr-only">
              {view.bot.name}'s browser
            </h2>
            <Where view={view} />
            <StateChip state={state} />
            <IconButton label="Close" icon={X} testId="live-close" onClick={() => live?.close()} />
          </div>
          {controlling ? <TakeoverBar view={view} frameFocused={false} hintId={hintId} phone /> : null}
          <div
            ref={area}
            data-testid="live-full-area"
            className="flex min-h-0 flex-1 items-center justify-center bg-muted/40 dark:bg-black/20"
          >
            <LiveFrame
              view={view}
              state={state}
              large={false}
              phone
              hintId={controlling ? hintId : undefined}
            />
          </div>
          {controlling ? (
            <p id={hintId} className="shrink-0 px-4 pt-2 text-muted-foreground text-xs">
              Tap to click. Pinch to zoom. Paste works.
            </p>
          ) : (
            <LiveActivityLine view={view} state={state} className="h-10 shrink-0 border-t px-4" />
          )}
          <div className="flex min-h-16 shrink-0 items-center gap-2 px-4 pt-2.5 pb-[max(env(safe-area-inset-bottom),12px)]">
            {controlling ? (
              <>
                <Tooltip content="Show keyboard">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Show keyboard"
                    data-testid="live-keyboard"
                    className="size-11 shrink-0"
                    onClick={() => keyboard.current?.focus()}
                  >
                    <Keyboard aria-hidden />
                  </Button>
                </Tooltip>
                <Button
                  ref={primary}
                  data-testid="live-hand-back"
                  className="h-11 flex-1"
                  disabled={view.pending === "release"}
                  onClick={() => live?.release()}
                >
                  {view.pending === "release" ? <Spinner /> : <Undo2 aria-hidden />}
                  {view.pending === "release" ? "Handing back…" : "Hand back"}
                </Button>
                <SoftKeyboard view={view} inputRef={keyboard} />
              </>
            ) : take || view.pending === "take" ? (
              <Button
                ref={primary}
                data-testid="live-take-control"
                className="h-11 w-full"
                disabled={view.pending === "take"}
                onClick={() => live?.take()}
              >
                {view.pending === "take" ? <Spinner /> : <MousePointerClick aria-hidden />}
                {view.pending === "take" ? "Taking control…" : "Take control"}
              </Button>
            ) : watchOnly ? (
              <p data-testid="live-watch-only" className="text-muted-foreground text-xs">
                {watchOnly}
              </p>
            ) : null}
          </div>
        </div>
        <BackQuestion
          open={askBack}
          bot={view.bot.name}
          onKeep={() => setAskBack(false)}
          onHandBack={() => {
            setAskBack(false);
            live?.release();
          }}
        />
      </SheetContent>
    </Sheet>
  );
}

/**
 * The phone keyboard's input (UI-SPEC "Input (phone)"): visually hidden but focusable, 16 px so iOS does not zoom,
 * with every suggestion and correction off. Each character or key goes to the page as it is typed and the input is
 * emptied at once; nothing typed is kept, logged or echoed (P-10). An IME composition is sent whole when it ends.
 */
function SoftKeyboard({ view, inputRef }: { view: LiveView; inputRef: RefObject<HTMLInputElement | null> }) {
  const live = useOptionalLiveView();
  const composing = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el || !live) return;
    const send = live.input;
    const onBeforeInput = (e: InputEvent) => {
      if (composing.current || e.isComposing || e.inputType === "insertCompositionText") return;
      // Paste has its own event (with the clipboard's text).
      if (e.inputType === "insertFromPaste") return;
      e.preventDefault();
      forwardSoftInput(el, beforeInputFrames({ inputType: e.inputType, data: e.data }), send);
    };
    // Whatever a keyboard put in the input anyway (a non-cancelable insert) is dropped as soon as it lands.
    const onInput = () => {
      if (!composing.current) el.value = "";
    };
    const onCompositionStart = () => {
      composing.current = true;
    };
    const onCompositionEnd = (e: CompositionEvent) => {
      composing.current = false;
      const frame = compositionFrame(e.data);
      forwardSoftInput(el, frame ? [frame] : null, send);
    };
    el.addEventListener("beforeinput", onBeforeInput);
    el.addEventListener("input", onInput);
    el.addEventListener("compositionstart", onCompositionStart);
    el.addEventListener("compositionend", onCompositionEnd);
    return () => {
      el.removeEventListener("beforeinput", onBeforeInput);
      el.removeEventListener("input", onInput);
      el.removeEventListener("compositionstart", onCompositionStart);
      el.removeEventListener("compositionend", onCompositionEnd);
      el.value = "";
    };
  }, [inputRef, live]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!live) return;
    const frames = softKeyFrames(e);
    if (!frames) return;
    e.preventDefault();
    forwardSoftInput(e.currentTarget, frames, live.input);
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (!live) return;
    const frame = pasteFrame(e.clipboardData?.getData("text/plain"));
    forwardSoftInput(e.currentTarget, frame ? [frame] : null, live.input);
  };

  return (
    <input
      ref={inputRef}
      data-testid="live-soft-input"
      type={softInputType(view.sensitive)}
      aria-label={`Keyboard for ${view.server?.host ?? "the page"}`}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      // Password managers: this is not a sign-in form of ours.
      data-1p-ignore="true"
      data-lpignore="true"
      data-form-type="other"
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      className="sr-only text-[16px]"
    />
  );
}

/** "Hand back to {bot}?" (UI-SPEC Interaction "Phone dock": Back while in control never hands back silently). */
function BackQuestion({
  open,
  bot,
  onKeep,
  onHandBack,
}: {
  open: boolean;
  bot: string;
  onKeep: () => void;
  onHandBack: () => void;
}) {
  const keep = useRef<HTMLButtonElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onKeep()}>
      <DialogContent data-testid="live-back-question" initialFocus={keep} showClose={false}>
        <DialogHeader>
          <DialogTitle>Hand back to {bot}?</DialogTitle>
        </DialogHeader>
        <DialogFooter>
          <Button
            ref={keep}
            variant="outline"
            data-testid="live-back-keep"
            className="max-md:h-11"
            onClick={onKeep}
          >
            Keep control
          </Button>
          <Button data-testid="live-back-hand-back" className="max-md:h-11" onClick={onHandBack}>
            <Undo2 aria-hidden />
            Hand back
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
