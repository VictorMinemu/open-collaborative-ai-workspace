"use client";

import {
  type BrowserEndReason,
  type LiveInputFrame,
  WORK_BROWSER_LIMITS,
  type WorkSession,
} from "@ocw/contracts";
import { Check, Keyboard, LockKeyhole, MonitorSmartphone, MousePointerClick, Undo2 } from "lucide-react";
import {
  type ClipboardEvent,
  type CompositionEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { HostChip } from "@/components/browser/host-chip";
import { FramePlaceholder, type Placeholder, placeholderOf } from "@/components/browser/live-frame";
import { StateChip } from "@/components/browser/live-header";
import {
  type Box,
  beforeInputFrames,
  compositionFrame,
  forwardSoftInput,
  isComposingKey,
  isModifierKey,
  isPasteChord,
  isReleaseChord,
  keyFrame,
  mouseFrame,
  moveGate,
  pasteFrame,
  SMALL_PAGE,
  softInputType,
  softKeyFrames,
  swipeFrame,
  tapFrames,
  wheelFrame,
} from "@/components/browser/live-input";
import {
  activityWordsOf,
  type LiveUiState,
  type LiveView,
  watchOnlyLine,
} from "@/components/browser/live-store";
import { type LiveActions, LiveContext } from "@/components/browser/live-view-provider";
import { TakeoverBar } from "@/components/browser/takeover-bar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  type FrameBus,
  useWorkLive,
  type WorkLiveActions,
  type WorkLiveView,
  workCanTake,
  workRefusalSentence,
  workShowsFrames,
  workUiStateOf,
} from "@/lib/use-work-live";
import { cn } from "@/lib/utils";
import { RUNTIMES } from "../meta";

/**
 * The session's browser, live (07.13-16; D-15, D-20, D-27, PD-13; 07.8 UI-SPEC Surface 1 live view): the Browser tab of
 * the session view, beside Queue and Changes. The session's audience watches the page its agent drives on the device.
 *
 * It reuses the bots' live pieces that read only their props (the state chip, the host chip, the frame placeholder and
 * its words) and never the bots' frame element, header or sheet: those read the app shell's one live-view context,
 * which belongs to a bot's browser, so mounting them here would draw that bot's frames. The frame element is this
 * file's small `WorkLiveFrame`, fed by the panel's own socket (`useWorkLive`).
 *
 * 07.13-21 (D-20, D-22, D-29, D-32; UI-SPEC "Take control and hand back"): the person the server lets take control
 * (`viewerCan.control`) gets Take control; in control, the bots' `TakeoverBar` (its Keep control reaches this panel's
 * socket through a `LiveContext` of its own, never the bots' one), "Done, save my sign-in" and "Done", and the honest
 * lines about the device. The frame maps pointer, wheel, keys, paste and IME text through the bots' `live-input`
 * mappers (taps, swipes and a hidden keyboard input on touch screens); nothing typed is kept, echoed or logged (P-10).
 */

/** The Work Zone's ended sentences: the bots' reasons, never naming a bot (UI-SPEC "Ended reasons"). */
export function workEndedSentence(reason: BrowserEndReason | undefined): string {
  switch (reason) {
    case "idle":
      return `The browser closed after ${WORK_BROWSER_LIMITS.idleMinutes} minutes without use.`;
    case "closed_by_bot":
      return "The agent closed the browser.";
    case "kill_switch":
      return "An admin turned the browser off.";
    case "module_off":
      return "The browser was turned off for you.";
    case "takeover_abandoned":
      return "Control ended without a hand back, so the browser closed. The agent can open it again.";
    default:
      return "The browser stopped unexpectedly. The agent can open it again.";
  }
}

/** What the frame area shows instead of the page, in the Work Zone's words, or null when it shows the page. */
export function workPlaceholderOf(
  v: Pick<LiveView, "server" | "bot">,
  state: LiveUiState,
): Placeholder | null {
  switch (state) {
    case "connecting":
      return { icon: "connecting", title: "Connecting…", body: null, strong: false };
    case "idle":
      return {
        icon: "ended",
        title: "Nothing to show yet: the agent has not opened a page",
        body: null,
        strong: false,
      };
    case "private":
      if (v.server?.privateReason === "member_session") {
        // D-27: a member's signed-in page is theirs alone; the others learn who, not where.
        const member = v.server.memberName ?? "a member";
        return {
          icon: "private",
          title: `Private browsing for ${member}`,
          body: `Only ${member} can watch while the agent uses their sign-in.`,
          strong: true,
        };
      }
      // D-20: during a takeover only the holder sees the page; the body (who signs in, or "on another device") is the
      // bots' own, which never names a bot.
      return {
        icon: "private",
        title: "Private sign-in in progress",
        body: placeholderOf(v, state)?.body ?? null,
        strong: true,
      };
    case "ended":
      return { icon: "ended", title: workEndedSentence(v.server?.endReason), body: null, strong: false };
    case "no_permission":
      return {
        icon: "no_permission",
        title: "You can't watch this browser",
        body: "Only people who can see this session can watch its browser.",
        strong: true,
      };
    case "error":
      return placeholderOf(v, state);
    default:
      return null;
  }
}

/** The line under the frame (UI-SPEC §1.4 "Activity line"), or null when the placeholder says it all. */
export function workActivityOf(
  v: Pick<LiveView, "server" | "bot" | "viewerCan">,
  state: LiveUiState,
  deviceName: string,
): string | null {
  switch (state) {
    case "live":
      return v.server?.activity
        ? `${v.bot.name} is ${v.server.activity}`
        : `${v.bot.name}'s browser on ${deviceName}`;
    case "reconnecting":
    case "paused":
    case "controlling":
      return activityWordsOf(v, state)?.text ?? null;
    default:
      return null;
  }
}

const NO_FRAMES: FrameBus = { latest: null, listeners: new Set() };
/** Static renders have no socket: input goes nowhere. */
const ignoreInput = (_frame: LiveInputFrame) => {};

export function WorkLivePanel({
  session,
  takeRequest = 0,
}: {
  session: Pick<WorkSession, "id" | "runtime" | "deviceName" | "browser">;
  /**
   * Bumped by the sign-in card's "Open and sign in" (07.13-21, D-21): take control as soon as the server allows it.
   * 0 = never asked.
   */
  takeRequest?: number;
}) {
  const agent = RUNTIMES[session.runtime].label;
  const { view, frames, retry, actions } = useWorkLive(session.id, agent, undefined, {
    notify: (text) => toast(text),
  });
  const coarse = useMediaQuery("(pointer: coarse)");
  // The page ended and the agent opened a new one (the session stream says so): watch the new page.
  // Only on the flag's false → true after the end, so a stale `live` never loops reconnects.
  const ended = view.server?.state === "ended" && view.server.endReason !== "access_lost";
  const pageOpen = session.browser?.live === true;
  const sawClosed = useRef(false);
  useEffect(() => {
    if (!ended) {
      sawClosed.current = false;
      return;
    }
    if (!pageOpen) sawClosed.current = true;
    else if (sawClosed.current) {
      sawClosed.current = false;
      retry();
    }
  }, [ended, pageOpen, retry]);
  useEffect(() => {
    if (takeRequest > 0) actions.take();
  }, [takeRequest, actions]);
  return (
    <WorkLiveBody
      view={view}
      frames={frames}
      onRetry={retry}
      deviceName={session.deviceName}
      actions={actions}
      coarse={coarse}
    />
  );
}

/** The two hand backs, the Shift+Esc landing (the primary) and, on touch screens, Show keyboard. */
function HandBackButtons({
  view,
  actions,
  primaryRef,
  coarse,
  onShowKeyboard,
}: {
  view: LiveView;
  actions: WorkLiveActions | undefined;
  primaryRef: RefObject<HTMLButtonElement | null>;
  coarse: boolean;
  onShowKeyboard: () => void;
}) {
  const releasing = view.pending === "release";
  return (
    <div className="flex flex-wrap items-center gap-2 max-md:grid max-md:grid-cols-1">
      {coarse ? (
        <Button
          variant="outline"
          size="sm"
          data-testid="work-live-show-keyboard"
          onClick={onShowKeyboard}
          className="max-md:h-11"
        >
          <Keyboard aria-hidden />
          Show keyboard
        </Button>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        data-testid="work-live-done"
        onClick={() => actions?.release(false)}
        disabled={releasing}
        className="max-md:h-11 md:ml-auto"
      >
        <Undo2 aria-hidden />
        Done
      </Button>
      <Button
        ref={primaryRef}
        size="sm"
        data-testid="work-live-save"
        onClick={() => actions?.release(true)}
        disabled={releasing}
        className="max-md:h-11"
      >
        {releasing ? <Spinner /> : <Check aria-hidden />}
        {releasing ? "Handing back…" : "Done, save my sign-in"}
      </Button>
    </div>
  );
}

/** D-29, D-32: where the sign-in is used and who controls that computer, in plain words. */
function DeviceLines({ deviceName }: { deviceName: string }) {
  return (
    <div
      data-testid="work-live-device-lines"
      className="grid gap-1.5 text-muted-foreground text-xs leading-4"
    >
      <p className="flex min-w-0 items-start gap-1.5">
        <MonitorSmartphone aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 break-words">
          Your sign-in will be used by the agent on {deviceName} in your own turns only. The owner of{" "}
          {deviceName} controls that computer.
        </span>
      </p>
      <p className="flex min-w-0 items-start gap-1.5">
        <LockKeyhole aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 break-words">
          Sign-ins work only in sessions only you (and the owner of {deviceName}) can see. “Done, save my
          sign-in” keeps this site's sign-in for those sessions; “Done” keeps nothing.
        </span>
      </p>
    </div>
  );
}

/** The panel's markup for one view (static-renderable: the tests render every state with it). */
export function WorkLiveBody({
  view,
  frames,
  onRetry,
  deviceName,
  actions,
  coarse = false,
}: {
  view: LiveView & Partial<Pick<WorkLiveView, "refused">>;
  frames: FrameBus | null;
  onRetry?: () => void;
  deviceName: string;
  actions?: WorkLiveActions;
  /** A touch screen: taps and swipes on the page, and a hidden keyboard input. */
  coarse?: boolean;
}) {
  const state = workUiStateOf(view);
  const host = view.server?.host ?? null;
  const controlling = state === "controlling";
  const activity = controlling ? null : workActivityOf(view, state, deviceName);
  const take = workCanTake(view, state) || view.pending === "take";
  const watchOnly = watchOnlyLine(view, state);
  const hintId = useId();
  const [frameFocused, setFrameFocused] = useState(false);
  const primary = useRef<HTMLButtonElement | null>(null);
  const softInput = useRef<HTMLInputElement | null>(null);
  // The bots' reused pieces (the takeover bar's Keep control, Shift+Esc's landing) reach THIS socket: a context of the
  // panel's own, so nothing here ever drives a bot's browser.
  const ctx = useMemo<LiveActions>(
    () => ({
      open() {},
      close() {},
      expand() {},
      minimize() {},
      announce() {},
      take: () => actions?.take(),
      release: () => actions?.release(false),
      keep: () => actions?.keep(),
      retry: () => onRetry?.(),
      input: (frame) => actions?.input(frame),
      frames: frames ?? NO_FRAMES,
      handBackRef: primary,
      windowRef: { current: null },
    }),
    [actions, frames, onRetry],
  );
  return (
    <LiveContext.Provider value={ctx}>
      <section
        data-testid="work-live-panel"
        data-state={state}
        aria-label="Session browser"
        className="grid gap-2"
      >
        <div data-testid="work-live-bar" className="flex min-h-7 min-w-0 items-center gap-2 max-md:min-h-11">
          {host ? (
            <HostChip
              host={host}
              secure={view.server?.secure ?? null}
              testId="work-live-host"
              className="min-w-0 flex-1 text-foreground"
            />
          ) : (
            <span
              data-testid="work-live-host"
              className="min-w-0 flex-1 truncate text-muted-foreground text-xs"
            >
              {deviceName}
            </span>
          )}
          <StateChip state={state} />
        </div>
        {controlling ? (
          <div className="overflow-hidden rounded-md border border-amber-300/70 dark:border-amber-400/30">
            <TakeoverBar view={view} frameFocused={frameFocused} hintId={hintId} phone={coarse} />
          </div>
        ) : null}
        <WorkLiveFrame
          view={view}
          state={state}
          frames={frames}
          onRetry={onRetry}
          input={actions?.input}
          handBack={primary}
          hintId={hintId}
          coarse={coarse}
          onFocusChange={setFrameFocused}
        />
        {activity ? (
          // The state chip is the polite region; this line changes with every action, so it is not announced.
          <p data-testid="work-live-activity" className="min-w-0 truncate text-muted-foreground text-xs">
            {activity}
          </p>
        ) : null}
        {controlling ? (
          <>
            <HandBackButtons
              view={view}
              actions={actions}
              primaryRef={primary}
              coarse={coarse}
              onShowKeyboard={() => softInput.current?.focus()}
            />
            {coarse ? (
              <WorkSoftKeyboard
                inputRef={softInput}
                sensitive={view.sensitive}
                host={host}
                input={actions?.input ?? ignoreInput}
              />
            ) : null}
            <DeviceLines deviceName={deviceName} />
          </>
        ) : take ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              data-testid="work-live-take"
              onClick={() => actions?.take()}
              disabled={view.pending === "take"}
              className="max-md:h-11 max-md:w-full"
            >
              {view.pending === "take" ? <Spinner /> : <MousePointerClick aria-hidden />}
              {view.pending === "take" ? "Taking control…" : "Take control"}
            </Button>
          </div>
        ) : watchOnly ? (
          <p data-testid="work-live-watch-only" className="text-muted-foreground text-xs">
            {watchOnly}
          </p>
        ) : null}
        <p
          data-testid="work-live-refused"
          role="status"
          className="text-amber-800 text-xs empty:hidden dark:text-amber-300"
        >
          {view.refused ? workRefusalSentence(view.refused) : ""}
        </p>
      </section>
    </LiveContext.Provider>
  );
}

/** Draws the bus's frames into `img`: latest wins, the previous blob URL revoked once the next one is drawn. */
function useFrames(img: RefObject<HTMLImageElement | null>, frames: FrameBus | null, active: boolean) {
  useEffect(() => {
    const el = img.current;
    if (!active || !frames || !el) return;
    let shown: string | null = null;
    let loading: string | null = null;
    const settled = () => {
      if (!loading || el.src !== loading) return;
      if (shown) URL.revokeObjectURL(shown);
      shown = loading;
      loading = null;
    };
    const show = (jpeg: Blob) => {
      const url = URL.createObjectURL(jpeg);
      // A frame that never got drawn is dropped (latest wins), so no backlog of URLs builds up.
      if (loading) URL.revokeObjectURL(loading);
      loading = url;
      el.src = url;
    };
    el.addEventListener("load", settled);
    el.addEventListener("error", settled);
    if (frames.latest) show(frames.latest);
    frames.listeners.add(show);
    return () => {
      frames.listeners.delete(show);
      el.removeEventListener("load", settled);
      el.removeEventListener("error", settled);
      if (loading) URL.revokeObjectURL(loading);
      if (shown) URL.revokeObjectURL(shown);
      el.removeAttribute("src");
    };
  }, [img, frames, active]);
}

/** Where the page is drawn on screen: the image when there is one, else the frame area. */
function boxOfFrame(img: HTMLImageElement | null, area: HTMLElement | null): Box | null {
  const r = img?.getBoundingClientRect() ?? area?.getBoundingClientRect();
  return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
}

function WorkLiveFrame({
  view,
  state,
  frames,
  onRetry,
  input,
  handBack,
  hintId,
  coarse,
  onFocusChange,
}: {
  view: LiveView;
  state: LiveUiState;
  frames: FrameBus | null;
  onRetry?: () => void;
  /** The holder's input, sent on the panel's socket (absent in static renders). */
  input?: (frame: LiveInputFrame) => void;
  handBack: RefObject<HTMLButtonElement | null>;
  hintId: string;
  coarse: boolean;
  onFocusChange: (focused: boolean) => void;
}) {
  const img = useRef<HTMLImageElement | null>(null);
  const area = useRef<HTMLElement | null>(null);
  const framed = workShowsFrames(state);
  const placeholder = framed ? null : workPlaceholderOf(view, state);
  const host = view.server?.host ?? null;
  const controlling = state === "controlling";
  useFrames(img, frames, framed);

  // Input only while this person controls the page (D-20); every listener goes away with the lease. Work Zone pages
  // are always 960×600 (no resize), so the frame scales to that page.
  const page = SMALL_PAGE;
  const boxOf = (): Box | null => boxOfFrame(img.current, area.current);
  const gate = useRef(moveGate());
  useEffect(() => {
    const el = area.current;
    if (!controlling || coarse || !el || !input) return;
    // A native listener: React's wheel listener is passive and could not keep the workspace from scrolling.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const box = boxOfFrame(img.current, el);
      const frame = box ? wheelFrame(e, box, page) : null;
      if (frame) input(frame);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [controlling, coarse, input]);

  const send = (frame: LiveInputFrame | null) => {
    if (frame && input) input(frame);
  };
  const pointer = (event: "move" | "down" | "up") => (e: MouseEvent<HTMLElement>) => {
    if (event === "move" && !gate.current(performance.now())) return;
    if (event === "down") {
      e.preventDefault();
      area.current?.focus();
    }
    const box = boxOf();
    send(box ? mouseFrame(event, e, box, page) : null);
  };

  // Modifiers held on the page (never characters) are released there when the keyboard leaves it.
  const held = useRef(new Map<string, string>());
  const releaseHeld = () => {
    for (const [key, code] of held.current) send({ type: "key", event: "up", key, code, modifiers: 0 });
    held.current.clear();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (isReleaseChord(e)) {
      e.preventDefault();
      e.stopPropagation();
      releaseHeld();
      handBack.current?.focus();
      return;
    }
    if (isPasteChord(e)) {
      // The browser raises `paste` with the clipboard's text; nothing else of the chord goes to the page.
      e.stopPropagation();
      return;
    }
    if (!isComposingKey(e)) e.preventDefault();
    e.stopPropagation();
    const frame = keyFrame(e, "down");
    if (frame?.type === "key" && isModifierKey(e.key)) held.current.set(e.key, frame.code);
    send(frame);
  };
  const onKeyUp = (e: KeyboardEvent<HTMLElement>) => {
    if (!isComposingKey(e)) e.preventDefault();
    e.stopPropagation();
    held.current.delete(e.key);
    send(keyFrame(e, "up"));
  };
  const onPaste = (e: ClipboardEvent<HTMLElement>) => {
    e.preventDefault();
    send(pasteFrame(e.clipboardData?.getData("text/plain")));
  };
  const onCompositionEnd = (e: CompositionEvent<HTMLElement>) => send(compositionFrame(e.data));
  const block = (e: { preventDefault(): void }) => e.preventDefault();

  // Touch screens: a tap is the page's touch, a swipe its scroll (UI-SPEC "Input (phone)").
  const finger = useRef<{ id: number; clientX: number; clientY: number } | null>(null);
  const onFingerDown = (e: PointerEvent<HTMLElement>) => {
    if (!e.isPrimary) return;
    finger.current = { id: e.pointerId, clientX: e.clientX, clientY: e.clientY };
  };
  const onFingerUp = (e: PointerEvent<HTMLElement>) => {
    const from = finger.current;
    finger.current = null;
    if (!from || from.id !== e.pointerId) return;
    const box = boxOf();
    if (!box) return;
    const swipe = swipeFrame(from, e, box, page);
    if (swipe) {
      send(swipe);
      return;
    }
    for (const frame of tapFrames(from, box, page) ?? []) send(frame);
  };

  const named = {
    role: "application",
    "aria-roledescription": "remote browser",
    "aria-label": `${host ?? "The page"}, controlled by you`,
    "aria-describedby": hintId,
    onContextMenu: block,
    onDrop: block,
    onDragOver: block,
  };
  const capture = !controlling
    ? { "aria-label": "Live view of the session's browser" }
    : coarse
      ? {
          ...named,
          tabIndex: -1,
          onPointerDown: onFingerDown,
          onPointerUp: onFingerUp,
          onPointerCancel: () => {
            finger.current = null;
          },
        }
      : {
          ...named,
          tabIndex: 0,
          onKeyDown,
          onKeyUp,
          onPaste,
          onCompositionEnd,
          onMouseDown: pointer("down"),
          onMouseUp: pointer("up"),
          onMouseMove: pointer("move"),
          onFocus: () => onFocusChange(true),
          onBlur: () => {
            releaseHeld();
            onFocusChange(false);
          },
        };

  return (
    <figure
      ref={area}
      data-testid="work-live-frame"
      data-controlling={controlling ? "true" : undefined}
      {...capture}
      className={cn(
        "relative m-0 aspect-[8/5] w-full overflow-hidden rounded-md border bg-muted outline-none dark:bg-black/40",
        controlling && "cursor-default focus-visible:ring-[3px] focus-visible:ring-ring/40",
        controlling && coarse && "touch-pinch-zoom select-none",
      )}
    >
      {framed ? (
        // biome-ignore lint/performance/noImgElement: frames are blob URLs drawn imperatively (no Next image)
        <img
          ref={img}
          alt={`${view.bot.name}'s browser on ${host ?? "a page"}`}
          draggable={false}
          className={cn(
            "pointer-events-none absolute inset-0 size-full select-none object-contain",
            !view.hasFrame && "invisible",
            state === "reconnecting" && "opacity-60",
          )}
        />
      ) : null}
      {controlling ? (
        // The amber ring sits above the page image (an inset ring on the area itself would be covered by it).
        <div
          aria-hidden
          data-testid="work-live-control-ring"
          className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-amber-500 ring-inset dark:ring-amber-400"
        />
      ) : null}
      {framed && !view.hasFrame ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner className="size-5 text-muted-foreground" />
        </div>
      ) : null}
      {placeholder ? <FramePlaceholder placeholder={placeholder} large={false} onRetry={onRetry} /> : null}
    </figure>
  );
}

/**
 * The touch screen's keyboard input (UI-SPEC "Input (phone)"): visually hidden but focusable, 16 px so iOS does not
 * zoom, every suggestion and correction off, `password` while the page's focused field is sensitive. Each character or
 * key goes to the page as it is typed and the input is emptied at once: nothing typed is kept, logged or echoed (P-10).
 */
function WorkSoftKeyboard({
  inputRef,
  sensitive,
  host,
  input,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  sensitive: boolean;
  host: string | null;
  input: (frame: LiveInputFrame) => void;
}) {
  const composing = useRef(false);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onBeforeInput = (e: InputEvent) => {
      if (composing.current || e.isComposing || e.inputType === "insertCompositionText") return;
      // Paste has its own event (with the clipboard's text).
      if (e.inputType === "insertFromPaste") return;
      e.preventDefault();
      forwardSoftInput(el, beforeInputFrames({ inputType: e.inputType, data: e.data }), input);
    };
    // Whatever a keyboard put in the input anyway (a non-cancelable insert) is dropped as soon as it lands.
    const onInput = () => {
      if (!composing.current) el.value = "";
    };
    const onCompositionStart = () => {
      composing.current = true;
    };
    const onCompositionEnd = (e: globalThis.CompositionEvent) => {
      composing.current = false;
      const frame = compositionFrame(e.data);
      forwardSoftInput(el, frame ? [frame] : null, input);
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
  }, [inputRef, input]);

  return (
    <input
      ref={inputRef}
      data-testid="work-live-soft-input"
      type={softInputType(sensitive)}
      aria-label={`Keyboard for ${host ?? "the page"}`}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      // Password managers: this is not a sign-in form of ours.
      data-1p-ignore="true"
      data-lpignore="true"
      data-form-type="other"
      onKeyDown={(e) => {
        const frames = softKeyFrames(e);
        if (!frames) return;
        e.preventDefault();
        forwardSoftInput(e.currentTarget, frames, input);
      }}
      onPaste={(e) => {
        e.preventDefault();
        const frame = pasteFrame(e.clipboardData?.getData("text/plain"));
        forwardSoftInput(e.currentTarget, frame ? [frame] : null, input);
      }}
      className="sr-only text-[16px]"
    />
  );
}
